import { formatDiagnosticValue } from '../diagnostics.ts';
import { NunjitsuLimitError } from '../limits.ts';
import { isAstNode, type AstCaseNode, type AstNode } from './ast.ts';
import { ExpressionParser, ExpressionSyntaxError } from './expression.ts';
import {
  findCodeTerminator,
  findMatchingCodeDelimiter,
  findTopLevelCodeCharacter,
  splitTopLevelCodeKeyword,
} from './scanCode.ts';
import { RegexLiteralSyntaxError } from './scanRegexLiteral.ts';
import {
  isCodeWhitespace,
  isTemplateWhitespace,
  trimCodeWhitespace,
  trimCodeWhitespaceStart,
} from './whitespace.ts';

const macroSignaturePattern = /^([A-Za-z_][A-Za-z0-9_]*)[ \t\n\r\u00a0]*\(([^]*)\)$/;
const trailingWhitespacePattern = /\s+$/;
const optionalLeadingWhitespacePattern = /^\s*/;
const leadingNewlinePattern = /^(?:\r?\n)/;
const indentationPattern = /^\s*$/;
const tagNamePattern = /^[A-Za-z_][A-Za-z0-9_]*/;
const emptyStructuralTags = new Set([
  'else',
  'endif',
  'endfor',
  'endmacro',
  'endcall',
  'endfilter',
  'endset',
  'default',
  'endswitch',
]);

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

  constructor(message: string, line?: number, column?: number) {
    super(message);
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
      throw new NunjitsuParseError(error.message, error.line, error.column);
    }
    if (error instanceof RegexLiteralSyntaxError) {
      const position = sourcePosition(source, error.offset);
      throw new NunjitsuParseError(error.message, position.line, position.column);
    }
    throw new NunjitsuParseError('Invalid template syntax');
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
      this.#fail(
        `Unexpected ${formatDiagnosticValue(tagName(parsed.stop.value))} tag`,
        parsed.stop,
      );
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
        this.#validateStructuralStop(name, token);
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
      case 'filter':
        return this.#parseFilterBlock(remainder, token);
      case 'block':
        return this.#parseBlock(remainder, token);
      case 'switch':
        return this.#parseSwitch(remainder, token);
      case 'include':
      case 'import':
      case 'from':
      case 'extends':
        this.#fail(`Unsupported template-loading tag ${formatDiagnosticValue(name)}`, token);
      default:
        this.#fail(`Unknown template tag ${formatDiagnosticValue(name)}`, token);
    }
  }

  #parseIf(conditionSource: string, token: TemplateToken): AstNode {
    const condition = this.#expression(conditionSource, token);
    const parsed = this.#parseBody(new Set(['elif', 'elseif', 'else', 'endif']));
    if (!parsed.stop) {
      this.#fail('Missing endif tag', token);
    }
    const stopName = tagName(parsed.stop.value);
    let otherwise: AstNode | undefined;
    if (stopName === 'elif' || stopName === 'elseif') {
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
    const split = splitTopLevelCodeKeyword(header, 'in');
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
    const assignment = findTopLevelCodeCharacter(header, '=');
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
    if (containsMacroDeclaration(parsed.body)) {
      this.#fail('Macro declarations are not supported inside set captures', token);
    }
    const capture = this.#make('Capture', { body: parsed.body }, token);
    return this.#make('Set', { targets, body: capture }, token);
  }

  #parseMacro(header: string, token: TemplateToken): AstNode {
    const signature = macroSignaturePattern.exec(trimCodeWhitespace(header));
    if (!signature) {
      this.#fail('Invalid macro signature', token);
    }
    const name = this.#expression(signature[1]!, token);
    if (name.type !== 'Symbol') {
      this.#fail('Macro name must be an identifier', token);
    }
    const args = this.#signature(signature[2]!, token);
    const parsed = this.#parseBody(new Set(['endmacro']));
    if (!parsed.stop) {
      this.#fail('Missing endmacro tag', token);
    }
    return this.#make('Macro', { name, args, body: parsed.body }, token);
  }

  #parseCall(header: string, token: TemplateToken): AstNode {
    let callerArguments = '';
    let callSource = trimCodeWhitespace(header);
    if (callSource.startsWith('(')) {
      const closing = findMatchingCodeDelimiter(callSource, 0);
      if (closing < 0) {
        this.#fail('Invalid call-block arguments', token);
      }
      callerArguments = callSource.slice(1, closing);
      callSource = trimCodeWhitespace(callSource.slice(closing + 1));
    }
    const call = this.#expression(callSource, token);
    if (call.type !== 'FunCall' || call.args.type !== 'NodeList') {
      this.#fail('Call block requires a function call', token);
    }
    if (!isStaticCallBlockTarget(call.name)) {
      this.#fail('Call block target must be a static macro reference', token);
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
    return this.#make('CallBlock', { call, caller }, token);
  }

  #parseFilterBlock(header: string, token: TemplateToken): AstNode {
    const parsed = this.#parseBody(new Set(['endfilter']));
    if (!parsed.stop) {
      this.#fail('Missing endfilter tag', token);
    }
    if (containsMacroDeclaration(parsed.body)) {
      this.#fail('Macro declarations are not supported inside filter captures', token);
    }
    const capture = this.#make('Capture', { body: parsed.body }, token);
    const filter = new ExpressionParser(
      header,
      token.line,
      token.column,
      node => this.#freezeNode(node),
      this.#maximumDepth,
    ).parseFilterInvocation(capture);
    return this.#make('Output', { children: Object.freeze([filter]) }, token);
  }

  #parseBlock(header: string, token: TemplateToken): AstNode {
    const name = this.#expression(trimCodeWhitespace(header), token);
    if (name.type !== 'Symbol') {
      this.#fail('Block name must be an identifier', token);
    }
    const parsed = this.#parseBody(new Set(['endblock']));
    if (!parsed.stop) {
      this.#fail('Missing endblock tag', token);
    }
    const closingName = tagRemainder(parsed.stop.value);
    if (closingName !== '' && closingName !== name.value) {
      this.#fail('Endblock name must match its opening block', parsed.stop);
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
    if (cases.length === 0 && fallback === undefined) {
      this.#fail('Switch requires at least one case or default', token);
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
    if (trimCodeWhitespace(source) === '') {
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

  #validateStructuralStop(name: string, token: TemplateToken): void {
    if (emptyStructuralTags.has(name) && tagRemainder(token.value) !== '') {
      this.#fail(`${name} tag does not accept trailing content`, token);
    }
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

function isStaticCallBlockTarget(node: AstNode): boolean {
  if (node.type === 'Symbol') {
    return true;
  }
  if (node.type !== 'LookupVal' || !isStaticCallBlockTarget(node.target)) {
    return false;
  }
  const key = node.val;
  return key.type === 'Literal' && (
    key.value === undefined ||
    key.value === null ||
    typeof key.value !== 'object'
  );
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
    for (let offset = 0; offset < value.length; offset += 1) {
      const character = value[offset]!;
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
    const end = findTagEnd(source, index, close, opening.kind !== 'comment');
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
        value: opening.kind === 'variable'
          ? trimCodeWhitespaceStart(content)
          : trimCodeWhitespace(content),
        line: startLine,
        column: startColumn,
      } as TemplateToken);
      const rawName = opening.kind === 'block' ? tagName(token.value) : '';
      if (rawName === 'raw' || rawName === 'verbatim') {
        if (tagRemainder(token.value) !== '') {
          throw new NunjitsuParseError(
            `${rawName} tag does not accept trailing content`,
            startLine,
            startColumn,
          );
        }
        const closing = findRawEnd(source, index, rawName);
        if (!closing) {
          throw new NunjitsuParseError(
            `Missing ${formatDiagnosticValue(`end${rawName}`)} tag`,
            startLine,
            startColumn,
          );
        }
        if (closing.terminalLineBreak) {
          const position = sourcePosition(source, closing.start);
          throw new NunjitsuParseError(
            `${rawName} closing tag cannot contain a line break`,
            position.line,
            position.column,
          );
        }
        appendText(source.slice(index, closing.start));
        advance(source.slice(index, closing.end));
        if (options.trimBlocks) {
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

function findTagEnd(
  source: string,
  start: number,
  close: string,
  scanRegex: boolean,
): number {
  return findCodeTerminator(source, start, close, scanRegex);
}

function sourcePosition(
  source: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  let line = 0;
  let column = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function findRawEnd(
  source: string,
  start: number,
  name: 'raw' | 'verbatim',
): {
  readonly start: number;
  readonly end: number;
  readonly terminalLineBreak: boolean;
} | undefined {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const markerStart = source.indexOf('{%', index);
    if (markerStart < 0) {
      return undefined;
    }
    const marker = scanRawMarker(source, markerStart, name);
    if (!marker) {
      index = markerStart + 2;
      continue;
    }
    if (marker.kind === 'open') {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        return {
          start: markerStart,
          end: marker.end,
          terminalLineBreak: marker.hasLineBreak,
        };
      }
    }
    index = marker.end;
  }
  return undefined;
}

function scanRawMarker(
  source: string,
  start: number,
  name: 'raw' | 'verbatim',
): {
  readonly kind: 'open' | 'close';
  readonly end: number;
  readonly hasLineBreak: boolean;
} | undefined {
  let index = start + 2;
  if (source[index] === '-') {
    return undefined;
  }
  while (isTemplateWhitespace(source[index])) {
    index += 1;
  }
  const closingName = `end${name}`;
  let kind: 'open' | 'close';
  if (source.startsWith(closingName, index)) {
    kind = 'close';
    index += closingName.length;
  } else if (source.startsWith(name, index)) {
    kind = 'open';
    index += name.length;
  } else {
    return undefined;
  }
  while (isTemplateWhitespace(source[index])) {
    index += 1;
  }
  if (source.startsWith('%}', index)) {
    const end = index + 2;
    const marker = source.slice(start, end);
    return {
      kind,
      end,
      hasLineBreak: marker.includes('\n'),
    };
  }
  return undefined;
}

function stripBlockIndent(value: string): string {
  const newline = Math.max(value.lastIndexOf('\n'), value.lastIndexOf('\r'));
  const suffix = value.slice(newline + 1);
  return indentationPattern.test(suffix) ? value.slice(0, newline + 1) : value;
}

function tagName(value: string): string {
  return tagNamePattern.exec(trimCodeWhitespace(value))?.[0] ?? '';
}

function tagRemainder(value: string): string {
  return trimCodeWhitespace(trimCodeWhitespace(value).slice(tagName(value).length));
}

function containsMacroDeclaration(node: AstNode): boolean {
  if (node.type === 'Macro') {
    return true;
  }
  for (const value of Object.values(node)) {
    if (isAstNode(value) && containsMacroDeclaration(value)) {
      return true;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child) && containsMacroDeclaration(child)) {
          return true;
        }
      }
    }
  }
  return false;
}
