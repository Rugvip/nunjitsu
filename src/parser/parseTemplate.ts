import { NunjitsuLimitError } from '../limits.ts';
import type { AstCaseNode, AstNode } from './ast.ts';
import { ExpressionParser, ExpressionSyntaxError } from './expression.ts';

const macroSignaturePattern = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/;
const trailingWhitespacePattern = /[\t\n\r ]+$/;
const leadingWhitespacePattern = /^[\t\n\r ]+/;
const optionalLeadingWhitespacePattern = /^[\t\n\r ]*/;
const leadingNewlinePattern = /^(?:\r?\n)/;
const rawEndPattern = /{%-?\s*endraw\s*(-?)%}/g;
const verbatimEndPattern = /{%-?\s*endverbatim\s*(-?)%}/g;
const indentationPattern = /^[\t ]*$/;
const tagNamePattern = /^[A-Za-z_][A-Za-z0-9_]*/;
const whitespacePattern = /\s/;

/** Configuration for parsing one complete inline template. */
export interface ParseOptions {
  /** Removes one newline immediately following a block tag. */
  trimBlocks: boolean;
  /** Removes indentation before block tags on otherwise blank lines. */
  lstripBlocks: boolean;
  /** Uses Cookiecutter/Jinja variable syntax and compatibility behavior. */
  cookiecutterCompat?: boolean;
  /** Maximum number of syntax nodes created for this source. */
  astNodes?: number;
  /** Maximum nested template and expression syntax depth. */
  nestingDepth?: number;
}

/** Structured failure produced while parsing untrusted template syntax. */
export class NunjitsuParseError extends Error {
  readonly line: number | undefined;
  readonly column: number | undefined;

  constructor(message: string, line?: number, column?: number, cause?: unknown) {
    super(message, { cause });
    this.name = 'NunjitsuParseError';
    this.line = line;
    this.column = column;
  }
}

interface TemplateToken {
  readonly kind: 'text' | 'variable' | 'block';
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

type ScannedTokenKind = TemplateToken['kind'] | 'comment';

interface ParsedBody {
  readonly body: AstNode;
  readonly stop?: TemplateToken;
}

/** Parses one complete untrusted template into a native immutable object AST. */
export function parseTemplate(
  source: string,
  options: ParseOptions = { trimBlocks: false, lstripBlocks: false },
): AstNode {
  try {
    const parser = new TemplateParser(
      scanTemplate(source, options),
      options.astNodes,
      options.nestingDepth,
    );
    return parser.parse();
  } catch (error) {
    if (error instanceof NunjitsuParseError || error instanceof NunjitsuLimitError) {
      throw error;
    }
    if (error instanceof ExpressionSyntaxError) {
      throw new NunjitsuParseError(error.message, error.line, error.column, error);
    }
    throw new NunjitsuParseError('Invalid template syntax', undefined, undefined, error);
  }
}

class TemplateParser {
  readonly #tokens: readonly TemplateToken[];
  readonly #maximumNodes: number;
  readonly #maximumDepth: number;
  #index = 0;
  #nodeCount = 0;
  #bodyDepth = 0;

  constructor(
    tokens: readonly TemplateToken[],
    maximumNodes = Number.POSITIVE_INFINITY,
    maximumDepth = Number.POSITIVE_INFINITY,
  ) {
    this.#tokens = tokens;
    this.#maximumNodes = maximumNodes;
    this.#maximumDepth = maximumDepth;
  }

  parse(): AstNode {
    const parsed = this.#parseBody(new Set());
    if (parsed.stop) {
      this.#fail(`Unexpected ${tagName(parsed.stop.value)} tag`, parsed.stop);
    }
    const root = parsed.body.type === 'NodeList' ? parsed.body.children : [parsed.body];
    return this.#make('Root', { children: Object.freeze(Array.from(root)) }, this.#tokens[0]);
  }

  #parseBody(stops: ReadonlySet<string>): ParsedBody {
    this.#bodyDepth += 1;
    if (
      this.#maximumDepth !== Number.POSITIVE_INFINITY &&
      this.#bodyDepth > this.#maximumDepth
    ) {
      throw new NunjitsuLimitError('nestingDepth');
    }
    try {
      return this.#parseBodyContents(stops);
    } finally {
      this.#bodyDepth -= 1;
    }
  }

  #parseBodyContents(stops: ReadonlySet<string>): ParsedBody {
    const children: AstNode[] = [];
    while (this.#index < this.#tokens.length) {
      const token = this.#tokens[this.#index++]!;
      if (token.kind === 'text') {
        if (token.value.length > 0) {
          const text = this.#make('TemplateData', { value: token.value }, token);
          children.push(this.#make('Output', { children: Object.freeze([text]) }, token));
        }
        continue;
      }
      if (token.kind === 'variable') {
        const expression = this.#expression(token.value, token);
        children.push(this.#make('Output', { children: Object.freeze([expression]) }, token));
        continue;
      }
      const name = tagName(token.value);
      if (stops.has(name)) {
        return { body: this.#nodeList(children, token), stop: token };
      }
      children.push(this.#parseStatement(name, tagRemainder(token.value), token));
    }
    return { body: this.#nodeList(children) };
  }

  #parseStatement(name: string, remainder: string, token: TemplateToken): AstNode {
    switch (name) {
      case 'if':
        return this.#parseIf(remainder, token);
      case 'for':
        return this.#parseFor(remainder, token);
      case 'set':
        return this.#parseSet(remainder, token);
      case 'macro':
        return this.#parseMacro(remainder, token);
      case 'call':
        return this.#parseCall(remainder, token);
      case 'block':
        return this.#parseBlock(remainder, token);
      case 'switch':
        return this.#parseSwitch(remainder, token);
      case 'include':
      case 'import':
      case 'from':
      case 'extends':
        this.#fail(`Unsupported template-loading tag ${name}`, token);
      default:
        this.#fail(`Unknown template tag ${name}`, token);
    }
  }

  #parseIf(conditionSource: string, token: TemplateToken): AstNode {
    const condition = this.#expression(conditionSource, token);
    const parsed = this.#parseBody(new Set(['elif', 'else', 'endif']));
    if (!parsed.stop) {
      this.#fail('Missing endif tag', token);
    }
    const stopName = tagName(parsed.stop.value);
    let otherwise: AstNode | undefined;
    if (stopName === 'elif') {
      otherwise = this.#parseIf(tagRemainder(parsed.stop.value), parsed.stop);
    } else if (stopName === 'else') {
      const alternate = this.#parseBody(new Set(['endif']));
      if (!alternate.stop) {
        this.#fail('Missing endif tag', token);
      }
      otherwise = alternate.body;
    }
    return this.#make('If', { cond: condition, body: parsed.body, else_: otherwise }, token);
  }

  #parseFor(header: string, token: TemplateToken): AstNode {
    const split = splitKeyword(header, 'in');
    if (!split) {
      this.#fail('For tag requires an in expression', token);
    }
    const targets = this.#targets(split.left, token);
    const name = targets.length === 1
      ? targets[0]!
      : this.#make('Array', { children: targets }, token);
    const arr = this.#expression(split.right, token);
    const parsed = this.#parseBody(new Set(['else', 'endfor']));
    if (!parsed.stop) {
      this.#fail('Missing endfor tag', token);
    }
    let otherwise: AstNode | undefined;
    if (tagName(parsed.stop.value) === 'else') {
      const alternate = this.#parseBody(new Set(['endfor']));
      if (!alternate.stop) {
        this.#fail('Missing endfor tag', token);
      }
      otherwise = alternate.body;
    }
    return this.#make('For', { arr, name, body: parsed.body, else_: otherwise }, token);
  }

  #parseSet(header: string, token: TemplateToken): AstNode {
    const assignment = findTopLevelCharacter(header, '=');
    if (assignment >= 0) {
      const targets = this.#targets(header.slice(0, assignment), token);
      const value = this.#expression(header.slice(assignment + 1), token);
      return this.#make('Set', { targets, value }, token);
    }
    const targets = this.#targets(header, token);
    const parsed = this.#parseBody(new Set(['endset']));
    if (!parsed.stop) {
      this.#fail('Missing endset tag', token);
    }
    const capture = this.#make('Capture', { body: parsed.body }, token);
    return this.#make('Set', { targets, body: capture }, token);
  }

  #parseMacro(header: string, token: TemplateToken): AstNode {
    const signature = macroSignaturePattern.exec(header.trim());
    if (!signature) {
      this.#fail('Invalid macro signature', token);
    }
    const name = this.#expression(signature[1]!, token);
    const args = this.#signature(signature[2]!, token);
    const parsed = this.#parseBody(new Set(['endmacro']));
    if (!parsed.stop) {
      this.#fail('Missing endmacro tag', token);
    }
    return this.#make('Macro', { name, args, body: parsed.body }, token);
  }

  #parseCall(header: string, token: TemplateToken): AstNode {
    let callerArguments = '';
    let callSource = header.trim();
    if (callSource.startsWith('(')) {
      const closing = findMatchingParenthesis(callSource, 0);
      if (closing < 0) {
        this.#fail('Invalid call-block arguments', token);
      }
      callerArguments = callSource.slice(1, closing);
      callSource = callSource.slice(closing + 1).trim();
    }
    const call = this.#expression(callSource, token);
    if (call.type !== 'FunCall' || call.args.type !== 'NodeList') {
      this.#fail('Call block requires a function call', token);
    }
    const parsed = this.#parseBody(new Set(['endcall']));
    if (!parsed.stop) {
      this.#fail('Missing endcall tag', token);
    }
    const callerName = this.#expression('caller', token);
    const caller = this.#make('Caller', {
      name: callerName,
      args: this.#signature(callerArguments, token),
      body: parsed.body,
    }, token);
    const pair = this.#make('Pair', { key: callerName, value: caller }, token);
    const keyword = this.#make('KeywordArgs', { children: Object.freeze([pair]) }, token);
    const args = this.#make('NodeList', {
      children: Object.freeze([...call.args.children, keyword]),
    }, token);
    const invocation = this.#make('FunCall', { name: call.name, args }, token);
    return this.#make('Output', { children: Object.freeze([invocation]) }, token);
  }

  #parseBlock(header: string, token: TemplateToken): AstNode {
    const name = this.#expression(header.trim(), token);
    if (name.type !== 'Symbol') {
      this.#fail('Block name must be an identifier', token);
    }
    const parsed = this.#parseBody(new Set(['endblock']));
    if (!parsed.stop) {
      this.#fail('Missing endblock tag', token);
    }
    return this.#make('Block', { name, body: parsed.body }, token);
  }

  #parseSwitch(header: string, token: TemplateToken): AstNode {
    const expression = this.#expression(header, token);
    const cases: AstCaseNode[] = [];
    let fallback: AstNode | undefined;
    let next = this.#parseBody(new Set(['case', 'default', 'endswitch']));
    if (next.body.type === 'NodeList' && next.body.children.length > 0) {
      this.#fail('Switch content must begin with case or default', token);
    }
    while (next.stop && tagName(next.stop.value) === 'case') {
      const caseToken = next.stop;
      const cond = this.#expression(tagRemainder(caseToken.value), caseToken);
      next = this.#parseBody(new Set(['case', 'default', 'endswitch']));
      cases.push(this.#make('Case', { cond, body: next.body }, caseToken) as AstCaseNode);
    }
    if (next.stop && tagName(next.stop.value) === 'default') {
      const parsed = this.#parseBody(new Set(['endswitch']));
      fallback = parsed.body;
      next = parsed;
    }
    if (!next.stop || tagName(next.stop.value) !== 'endswitch') {
      this.#fail('Missing endswitch tag', token);
    }
    return this.#make('Switch', {
      expr: expression,
      cases: Object.freeze(cases),
      default: fallback,
    }, token);
  }

  #expression(source: string, token: TemplateToken): AstNode {
    return new ExpressionParser(
      source,
      token.line,
      token.column,
      node => this.#freezeNode(node),
      this.#maximumDepth,
    ).parse();
  }

  #targets(source: string, token: TemplateToken): readonly AstNode[] {
    return new ExpressionParser(
      source,
      token.line,
      token.column,
      node => this.#freezeNode(node),
      this.#maximumDepth,
    ).parseTargetList();
  }

  #signature(source: string, token: TemplateToken): AstNode {
    if (source.trim() === '') {
      return this.#make('NodeList', { children: Object.freeze([]) }, token);
    }
    return new ExpressionParser(
      `${source})`,
      token.line,
      token.column,
      node => this.#freezeNode(node),
      this.#maximumDepth,
    ).parseSignature();
  }

  #nodeList(children: readonly AstNode[], token?: TemplateToken): AstNode {
    return this.#make('NodeList', { children: Object.freeze(Array.from(children)) }, token);
  }

  #make(type: AstNode['type'], fields: Record<string, unknown>, token?: TemplateToken): AstNode {
    return this.#freezeNode({
      type,
      line: token?.line ?? 0,
      column: token?.column ?? 0,
      ...fields,
    } as AstNode);
  }

  #freezeNode(node: AstNode): AstNode {
    this.#nodeCount += 1;
    if (
      this.#maximumNodes !== Number.POSITIVE_INFINITY &&
      this.#nodeCount > this.#maximumNodes
    ) {
      throw new NunjitsuLimitError('astNodes');
    }
    return Object.freeze(node);
  }

  #fail(message: string, token: TemplateToken): never {
    throw new NunjitsuParseError(message, token.line, token.column);
  }
}

function scanTemplate(source: string, options: ParseOptions): readonly TemplateToken[] {
  const tokens: TemplateToken[] = [];
  const variableStart = options.cookiecutterCompat ? '{{' : '${{';
  let index = 0;
  let line = 0;
  let column = 0;
  let pendingText = '';
  let textLine = 0;
  let textColumn = 0;

  const advance = (value: string): void => {
    for (const character of value) {
      if (character === '\n') {
        line += 1;
        column = 0;
      } else {
        column += 1;
      }
    }
    index += value.length;
  };
  const appendText = (value: string): void => {
    if (pendingText.length === 0) {
      textLine = line;
      textColumn = column;
    }
    pendingText += value;
    advance(value);
  };
  const flushText = (): void => {
    if (pendingText.length > 0) {
      tokens.push(Object.freeze({
        kind: 'text', value: pendingText, line: textLine, column: textColumn,
      }));
      pendingText = '';
    }
  };

  while (index < source.length) {
    const opening = nextOpening(source, index, variableStart);
    if (!opening) {
      appendText(source.slice(index));
      break;
    }
    appendText(source.slice(index, opening.index));
    const startLine = line;
    const startColumn = column;
    if (opening.kind === 'block' && options.lstripBlocks) {
      pendingText = stripBlockIndent(pendingText);
    }
    const leftTrim = source.startsWith(`${opening.value}-`, opening.index);
    if (leftTrim) {
      pendingText = pendingText.replace(trailingWhitespacePattern, '');
    }
    flushText();
    advance(opening.value);
    if (leftTrim) {
      advance('-');
    }
    const close = opening.kind === 'block' ? '%}' : opening.kind === 'comment' ? '#}' : '}}';
    const end = findTagEnd(source, index, close);
    if (end < 0) {
      throw new NunjitsuParseError(`Unterminated ${opening.kind} tag`, startLine, startColumn);
    }
    const rightTrim = source[end - 1] === '-';
    const contentEnd = rightTrim ? end - 1 : end;
    const content = source.slice(index, contentEnd);
    advance(source.slice(index, end + close.length));

    if (opening.kind !== 'comment') {
      const token = Object.freeze({
        kind: opening.kind,
        value: content.trim(),
        line: startLine,
        column: startColumn,
      } as TemplateToken);
      const rawName = opening.kind === 'block' ? tagName(token.value) : '';
      if (rawName === 'raw' || rawName === 'verbatim') {
        const closing = findRawEnd(source, index, rawName);
        if (!closing) {
          throw new NunjitsuParseError(`Missing end${rawName} tag`, startLine, startColumn);
        }
        let raw = source.slice(index, closing.start);
        if (rightTrim) {
          raw = raw.replace(leadingWhitespacePattern, '');
        }
        appendText(raw);
        if (closing.leftTrim) {
          pendingText = pendingText.replace(trailingWhitespacePattern, '');
        }
        advance(source.slice(index, closing.end));
        if (closing.rightTrim) {
          const whitespace = optionalLeadingWhitespacePattern.exec(source.slice(index))![0];
          advance(whitespace);
        } else if (options.trimBlocks) {
          const newline = leadingNewlinePattern.exec(source.slice(index))?.[0];
          if (newline) {
            advance(newline);
          }
        }
        continue;
      }
      tokens.push(token);
    }

    if (rightTrim) {
      const whitespace = optionalLeadingWhitespacePattern.exec(source.slice(index))![0];
      advance(whitespace);
    } else if (opening.kind === 'block' && options.trimBlocks) {
      const newline = leadingNewlinePattern.exec(source.slice(index))?.[0];
      if (newline) {
        advance(newline);
      }
    }
  }
  flushText();
  return Object.freeze(tokens);
}

function nextOpening(
  source: string,
  start: number,
  variableStart: string,
): { readonly kind: ScannedTokenKind; readonly index: number; readonly value: string } | undefined {
  const candidates = [
    { kind: 'variable' as const, index: source.indexOf(variableStart, start), value: variableStart },
    { kind: 'block' as const, index: source.indexOf('{%', start), value: '{%' },
    { kind: 'comment' as const, index: source.indexOf('{#', start), value: '{#' },
  ].filter(candidate => candidate.index >= 0);
  candidates.sort((left, right) => left.index - right.index);
  return candidates[0];
}

function findTagEnd(source: string, start: number, close: string): number {
  let quote: string | undefined;
  let escaped = false;
  let regex = false;
  for (let index = start; index <= source.length - close.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if ((quote || regex) && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (regex) {
      if (character === '/') {
        regex = false;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === 'r' && source[index + 1] === '/') {
      regex = true;
      index += 1;
      continue;
    }
    if (source.startsWith(close, index)) {
      return index;
    }
  }
  return -1;
}

function findRawEnd(
  source: string,
  start: number,
  name: 'raw' | 'verbatim',
): { readonly start: number; readonly end: number; readonly leftTrim: boolean; readonly rightTrim: boolean } | undefined {
  const pattern = name === 'raw' ? rawEndPattern : verbatimEndPattern;
  pattern.lastIndex = start;
  const match = pattern.exec(source);
  if (!match) {
    return undefined;
  }
  return {
    start: match.index,
    end: pattern.lastIndex,
    leftTrim: source.startsWith('{%-', match.index),
    rightTrim: match[1] === '-',
  };
}

function stripBlockIndent(value: string): string {
  const newline = Math.max(value.lastIndexOf('\n'), value.lastIndexOf('\r'));
  const suffix = value.slice(newline + 1);
  return indentationPattern.test(suffix) ? value.slice(0, newline + 1) : value;
}

function tagName(value: string): string {
  return tagNamePattern.exec(value.trim())?.[0] ?? '';
}

function tagRemainder(value: string): string {
  return value.trim().slice(tagName(value).length).trim();
}

function splitKeyword(
  source: string,
  keyword: string,
): { readonly left: string; readonly right: string } | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    } else if (
      depth === 0 &&
      source.slice(index, index + keyword.length) === keyword &&
      whitespacePattern.test(source[index - 1] ?? ' ') &&
      whitespacePattern.test(source[index + keyword.length] ?? ' ')
    ) {
      return {
        left: source.slice(0, index).trim(),
        right: source.slice(index + keyword.length).trim(),
      };
    }
  }
  return undefined;
}

function findTopLevelCharacter(source: string, expected: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if ('([{'.includes(character)) {
      depth += 1;
    } else if (')]}'.includes(character)) {
      depth -= 1;
    } else if (depth === 0 && character === expected) {
      return index;
    }
  }
  return -1;
}

function findMatchingParenthesis(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')' && --depth === 0) {
      return index;
    }
  }
  return -1;
}
