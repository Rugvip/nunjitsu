import { formatDiagnosticValue } from '../diagnostics.ts';
import { NunjitsuLimitError } from '../limits.ts';
import { isReservedName } from '../runtime/value.ts';
import type { AstNode, AstRegexLiteral } from './ast.ts';

interface Token {
  readonly kind: 'eof' | 'name' | 'number' | 'string' | 'regex' | 'operator';
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

const simpleStringEscapes: Readonly<Record<string, string>> = Object.freeze({
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
});
const whitespacePattern = /\s/;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*/;
const numberPattern = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
const shortHexEscapePattern = /^[0-9a-fA-F]{2}$/;
const unicodeEscapePattern = /^[0-9a-fA-F]{4}$/;
const regularExpressionFlagsPattern = /^[A-Za-z]*/;

/** Creates and freezes one parser-owned AST node. */
export type AstNodeFactory = (node: AstNode) => AstNode;

/** Parses the closed Nunjucks expression subset used by inline templates. */
export class ExpressionParser {
  readonly #tokens: readonly Token[];
  readonly #node: AstNodeFactory;
  readonly #maximumDepth: number;
  #index = 0;
  #depth = 0;

  constructor(
    source: string,
    line: number,
    column: number,
    node: AstNodeFactory,
    maximumDepth = Number.POSITIVE_INFINITY,
  ) {
    this.#tokens = tokenize(source, line, column);
    this.#node = node;
    this.#maximumDepth = maximumDepth;
  }

  parse(): AstNode {
    const expression = this.#parseInlineIf();
    this.#expect('eof');
    return expression;
  }

  parseTargetList(): readonly AstNode[] {
    const targets: AstNode[] = [];
    do {
      targets.push(this.#parseTarget());
    } while (this.#consume(','));
    this.#expect('eof');
    return Object.freeze(targets);
  }

  parseSignature(): AstNode {
    const children = this.#parseArguments(')');
    this.#expect('eof');
    return this.#make('NodeList', { children });
  }

  #parseInlineIf(): AstNode {
    const body = this.#parseOr();
    if (!this.#consumeName('if')) {
      return body;
    }
    const cond = this.#parseOr();
    const otherwise = this.#consumeName('else')
      ? this.#nested(() => this.#parseInlineIf())
      : undefined;
    return this.#make('InlineIf', { cond, body, else_: otherwise }, body);
  }

  #parseOr(): AstNode {
    let left = this.#parseAnd();
    while (this.#consumeName('or')) {
      left = this.#make('Or', { left, right: this.#parseAnd() }, left);
    }
    return left;
  }

  #parseAnd(): AstNode {
    let left = this.#parseNot();
    while (this.#consumeName('and')) {
      left = this.#make('And', { left, right: this.#parseNot() }, left);
    }
    return left;
  }

  #parseNot(): AstNode {
    if (this.#consumeName('not')) {
      return this.#make('Not', { target: this.#nested(() => this.#parseNot()) });
    }
    return this.#parseCompare();
  }

  #parseCompare(): AstNode {
    const left = this.#parseConcat();
    if (this.#consumeName('is')) {
      const negate = this.#consumeName('not');
      const testName = this.#expect('name');
      if (testName.value === 'none') {
        const test = this.#make('Is', { left, right: this.#literal(null, testName) }, left);
        return negate ? this.#make('Not', { target: test }, left) : test;
      }
      const symbol = this.#symbol(testName);
      const right = this.#consume('(')
        ? this.#make('FunCall', { name: symbol, args: this.#argumentList() }, symbol)
        : symbol;
      const test = this.#make('Is', { left, right }, left);
      return negate ? this.#make('Not', { target: test }, left) : test;
    }

    const operations: AstNode[] = [];
    for (;;) {
      let operator: string | undefined;
      const token = this.#peek();
      if (['==', '===', '!=', '!==', '<', '<=', '>', '>='].includes(token.value)) {
        operator = token.value;
        this.#index += 1;
      } else if (this.#consumeName('in')) {
        operator = 'in';
      } else if (this.#peek().value === 'not' && this.#peek(1).value === 'in') {
        this.#index += 2;
        operator = 'notin';
      }
      if (!operator) {
        break;
      }
      const expr = this.#parseConcat();
      operations.push(this.#make('CompareOperand', { expr, operator }, expr));
    }
    if (operations.length === 0) {
      return left;
    }
    return this.#make('Compare', {
      expr: left,
      ops: Object.freeze(operations) as never,
    }, left);
  }

  #parseConcat(): AstNode {
    let left = this.#parseAdd();
    while (this.#consume('~')) {
      left = this.#make('Concat', { left, right: this.#parseAdd() }, left);
    }
    return left;
  }

  #parseAdd(): AstNode {
    let left = this.#parseMultiply();
    for (;;) {
      if (this.#consume('+')) {
        left = this.#make('Add', { left, right: this.#parseMultiply() }, left);
      } else if (this.#consume('-')) {
        left = this.#make('Sub', { left, right: this.#parseMultiply() }, left);
      } else {
        return left;
      }
    }
  }

  #parseMultiply(): AstNode {
    let left = this.#parsePower();
    for (;;) {
      if (this.#consume('*')) {
        left = this.#make('Mul', { left, right: this.#parsePower() }, left);
      } else if (this.#consume('/')) {
        left = this.#make('Div', { left, right: this.#parsePower() }, left);
      } else if (this.#consume('//')) {
        left = this.#make('FloorDiv', { left, right: this.#parsePower() }, left);
      } else if (this.#consume('%')) {
        left = this.#make('Mod', { left, right: this.#parsePower() }, left);
      } else {
        return left;
      }
    }
  }

  #parsePower(): AstNode {
    let left = this.#parseFilter();
    if (this.#consume('**')) {
      left = this.#make('Pow', { left, right: this.#nested(() => this.#parsePower()) }, left);
    }
    return left;
  }

  #parseFilter(): AstNode {
    let expression = this.#parseUnary();
    while (this.#consume('|')) {
      const name = this.#symbol(this.#expect('name'));
      const supplied = this.#consume('(')
        ? this.#nested(() => this.#parseArguments(')'))
        : Object.freeze([]);
      expression = this.#make('Filter', {
        name,
        args: this.#make('NodeList', {
          children: Object.freeze([expression, ...supplied]),
        }, expression),
      }, expression);
    }
    return expression;
  }

  #parseUnary(): AstNode {
    if (this.#consume('-')) {
      return this.#make('Neg', { target: this.#nested(() => this.#parseUnary()) });
    }
    if (this.#consume('+')) {
      return this.#make('Pos', { target: this.#nested(() => this.#parseUnary()) });
    }
    return this.#parsePostfix();
  }

  #parsePostfix(): AstNode {
    let expression = this.#parsePrimary();
    for (;;) {
      if (this.#consume('.')) {
        const key = this.#expect('name');
        this.#assertAllowedName(key.value, key);
        expression = this.#make('LookupVal', {
          target: expression,
          val: this.#literal(key.value, key),
        }, expression);
      } else if (this.#consume('[')) {
        const value = this.#nested(() => this.#parseSubscript());
        this.#expectValue(']');
        if (value.type === 'Literal' && typeof value.value === 'string') {
          this.#assertAllowedName(value.value, value);
        }
        expression = this.#make('LookupVal', { target: expression, val: value }, expression);
      } else if (this.#consume('(')) {
        expression = this.#make('FunCall', {
          name: expression,
          args: this.#nested(() => this.#argumentList()),
        }, expression);
      } else {
        return expression;
      }
    }
  }

  #parseSubscript(): AstNode {
    const position = this.#peek();
    let start: AstNode | undefined;
    if (this.#peek().value !== ':' && this.#peek().value !== ']') {
      start = this.#parseInlineIf();
    }
    if (!this.#consume(':')) {
      if (!start) {
        this.#fail('Expected subscript expression');
      }
      return start;
    }
    let stop: AstNode | undefined;
    let step: AstNode | undefined;
    if (this.#peek().value !== ':' && this.#peek().value !== ']') {
      stop = this.#parseInlineIf();
    }
    if (this.#consume(':') && this.#peek().value !== ']') {
      step = this.#parseInlineIf();
    }
    return this.#make('Slice', {
      start: start ?? this.#literal(null, position),
      stop: stop ?? this.#literal(null, position),
      step: step ?? this.#literal(1, position),
    }, position);
  }

  #parsePrimary(): AstNode {
    const token = this.#peek();
    if (token.kind === 'number') {
      this.#index += 1;
      return this.#literal(Number(token.value), token);
    }
    if (token.kind === 'string') {
      this.#index += 1;
      return this.#literal(token.value, token);
    }
    if (token.kind === 'regex') {
      this.#index += 1;
      const separator = token.value.lastIndexOf('/');
      const regex = Object.freeze({
        type: 'regex-literal',
        source: token.value.slice(0, separator),
        flags: token.value.slice(separator + 1),
      } satisfies AstRegexLiteral);
      return this.#literal(regex, token);
    }
    if (token.kind === 'name') {
      this.#index += 1;
      if (token.value === 'true') {
        return this.#literal(true, token);
      }
      if (token.value === 'false') {
        return this.#literal(false, token);
      }
      if (token.value === 'none' || token.value === 'null') {
        return this.#literal(null, token);
      }
      return this.#symbol(token);
    }
    if (this.#consume('(')) {
      const children = this.#nested(() => this.#parseDelimited(')'));
      if (children.length === 1) {
        return this.#make('Group', { children }, token);
      }
      return this.#make('Group', { children }, token);
    }
    if (this.#consume('[')) {
      return this.#make('Array', {
        children: this.#nested(() => this.#parseDelimited(']')),
      }, token);
    }
    if (this.#consume('{')) {
      const pairs = this.#nested(() => this.#parseDictionary());
      return this.#make('Dict', { children: Object.freeze(pairs) }, token);
    }
    this.#fail(token.value === ''
      ? 'Unexpected expression token at end of input'
      : `Unexpected expression token ${formatDiagnosticValue(token.value)}`);
  }

  #parseDictionary(): AstNode[] {
    const pairs: AstNode[] = [];
    if (!this.#consume('}')) {
      do {
        const keyToken = this.#peek();
        let key: AstNode;
        if (keyToken.kind === 'name') {
          this.#index += 1;
          key = this.#symbol(keyToken);
        } else if (keyToken.kind === 'string' || keyToken.kind === 'number') {
          this.#index += 1;
          key = this.#literal(
            keyToken.kind === 'number' ? Number(keyToken.value) : keyToken.value,
            keyToken,
          );
        } else {
          this.#fail('Expected dictionary key');
        }
        if (
          (key.type === 'Symbol' || key.type === 'Literal') &&
          typeof key.value === 'string'
        ) {
          this.#assertAllowedName(key.value, key);
        }
        this.#expectValue(':');
        pairs.push(this.#make('Pair', { key, value: this.#parseInlineIf() }, keyToken));
      } while (this.#consume(','));
      this.#expectValue('}');
    }
    return pairs;
  }

  #parseDelimited(end: string): readonly AstNode[] {
    const children: AstNode[] = [];
    if (this.#consume(end)) {
      return Object.freeze(children);
    }
    do {
      children.push(this.#parseInlineIf());
    } while (this.#consume(','));
    this.#expectValue(end);
    return Object.freeze(children);
  }

  #argumentList(): AstNode {
    return this.#make('NodeList', { children: this.#parseArguments(')') });
  }

  #parseArguments(end: string): readonly AstNode[] {
    const positional: AstNode[] = [];
    const keywords: AstNode[] = [];
    if (this.#consume(end)) {
      return Object.freeze(positional);
    }
    do {
      if (this.#peek().kind === 'name' && this.#peek(1).value === '=') {
        const key = this.#symbol(this.#expect('name'));
        this.#expectValue('=');
        keywords.push(this.#make('Pair', { key, value: this.#parseInlineIf() }, key));
      } else {
        if (keywords.length > 0) {
          this.#fail('Positional arguments cannot follow keyword arguments');
        }
        positional.push(this.#parseInlineIf());
      }
    } while (this.#consume(','));
    this.#expectValue(end);
    if (keywords.length > 0) {
      positional.push(this.#make('KeywordArgs', { children: Object.freeze(keywords) }));
    }
    return Object.freeze(positional);
  }

  #parseTarget(): AstNode {
    if (this.#consume('[')) {
      const children: AstNode[] = [];
      do {
        children.push(this.#parseTarget());
      } while (this.#consume(','));
      this.#expectValue(']');
      return this.#make('Array', { children: Object.freeze(children) });
    }
    return this.#symbol(this.#expect('name'));
  }

  #symbol(token: Token): AstNode {
    this.#assertAllowedName(token.value, token);
    return this.#make('Symbol', { value: token.value }, token);
  }

  #assertAllowedName(
    value: string,
    position: Pick<Token, 'line' | 'column'>,
  ): void {
    if (isReservedName(value)) {
      this.#fail(`Template name ${formatDiagnosticValue(value)} is reserved`, position);
    }
  }

  #literal(value: unknown, position: Pick<Token, 'line' | 'column'>): AstNode {
    return this.#make('Literal', { value: value as never }, position);
  }

  #make(
    type: AstNode['type'],
    fields: Record<string, unknown>,
    position: Pick<Token, 'line' | 'column'> = this.#peek(),
  ): AstNode {
    return this.#node({ type, line: position.line, column: position.column, ...fields } as AstNode);
  }

  #peek(offset = 0): Token {
    return this.#tokens[Math.min(this.#index + offset, this.#tokens.length - 1)]!;
  }

  #consume(value: string): boolean {
    if (this.#peek().kind !== 'operator' || this.#peek().value !== value) {
      return false;
    }
    this.#index += 1;
    return true;
  }

  #consumeName(value: string): boolean {
    if (this.#peek().kind !== 'name' || this.#peek().value !== value) {
      return false;
    }
    this.#index += 1;
    return true;
  }

  #expect(kind: Token['kind']): Token {
    const token = this.#peek();
    if (token.kind !== kind) {
      this.#fail(token.value === ''
        ? `Expected ${kind}, received end of input`
        : `Expected ${kind}, received ${formatDiagnosticValue(token.value)}`, token);
    }
    this.#index += 1;
    return token;
  }

  #expectValue(value: string): void {
    if (!this.#consume(value)) {
      this.#fail(`Expected ${value}`);
    }
  }

  #nested<T>(parse: () => T): T {
    this.#depth += 1;
    if (this.#maximumDepth !== Number.POSITIVE_INFINITY && this.#depth > this.#maximumDepth) {
      throw new NunjitsuLimitError('nestingDepth');
    }
    try {
      return parse();
    } finally {
      this.#depth -= 1;
    }
  }

  #fail(
    message: string,
    token: Pick<Token, 'line' | 'column'> = this.#peek(),
  ): never {
    throw new ExpressionSyntaxError(message, token.line, token.column);
  }
}

/** Internal expression failure carrying source coordinates. */
export class ExpressionSyntaxError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.line = line;
    this.column = column;
  }
}

function tokenize(source: string, initialLine: number, initialColumn: number): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = initialLine;
  let column = initialColumn;
  const emit = (kind: Token['kind'], value: string, tokenLine: number, tokenColumn: number): void => {
    tokens.push(Object.freeze({ kind, value, line: tokenLine, column: tokenColumn }));
  };
  while (index < source.length) {
    const character = source[index]!;
    if (whitespacePattern.test(character)) {
      if (character === '\n') {
        line += 1;
        column = 0;
      } else {
        column += 1;
      }
      index += 1;
      continue;
    }
    const tokenLine = line;
    const tokenColumn = column;
    const name = namePattern.exec(source.slice(index));
    if (name) {
      if (name[0] === 'r' && source[index + 1] === '/') {
        const regex = readRegex(source, index + 2, tokenLine, tokenColumn);
        emit('regex', `${regex.source}/${regex.flags}`, tokenLine, tokenColumn);
        const consumed = regex.end - index;
        index = regex.end;
        column += consumed;
      } else {
        emit('name', name[0], tokenLine, tokenColumn);
        index += name[0].length;
        column += name[0].length;
      }
      continue;
    }
    const number = numberPattern.exec(source.slice(index));
    if (number) {
      emit('number', number[0], tokenLine, tokenColumn);
      index += number[0].length;
      column += number[0].length;
      continue;
    }
    if (character === '"' || character === "'") {
      const string = readString(source, index, character, tokenLine, tokenColumn);
      emit('string', string.value, tokenLine, tokenColumn);
      column += string.end - index;
      index = string.end;
      continue;
    }
    const operator = ['===', '!==', '**', '//', '==', '!=', '<=', '>='].find(candidate => (
      source.startsWith(candidate, index)
    ));
    const value = operator ?? character;
    if (!operator && !'()[]{}.,:|~+-*/%<>=.'.includes(character)) {
      throw new ExpressionSyntaxError(
        `Unexpected character ${formatDiagnosticValue(character)}`,
        tokenLine,
        tokenColumn,
      );
    }
    emit('operator', value, tokenLine, tokenColumn);
    index += value.length;
    column += value.length;
  }
  emit('eof', '', line, column);
  return Object.freeze(tokens);
}

function readString(
  source: string,
  start: number,
  quote: string,
  line: number,
  column: number,
): { readonly value: string; readonly end: number } {
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === quote) {
      return { value, end: index + 1 };
    }
    if (character !== '\\') {
      value += character;
      continue;
    }
    index += 1;
    if (index >= source.length) {
      break;
    }
    const escaped = source[index]!;
    if (Object.hasOwn(simpleStringEscapes, escaped)) {
      value += simpleStringEscapes[escaped];
    } else if (escaped === 'u' || escaped === 'x') {
      const length = escaped === 'u' ? 4 : 2;
      const digits = source.slice(index + 1, index + 1 + length);
      const pattern = escaped === 'u' ? unicodeEscapePattern : shortHexEscapePattern;
      if (!pattern.test(digits)) {
        throw new ExpressionSyntaxError('Invalid string escape', line, column);
      }
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      index += length;
    } else {
      value += escaped;
    }
  }
  throw new ExpressionSyntaxError('Unterminated string literal', line, column);
}

function readRegex(
  source: string,
  start: number,
  line: number,
  column: number,
): { readonly source: string; readonly flags: string; readonly end: number } {
  let pattern = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (!escaped && character === '/') {
      const flags = regularExpressionFlagsPattern.exec(source.slice(index + 1))![0];
      try {
        void new RegExp(pattern, flags);
      } catch {
        throw new ExpressionSyntaxError('Invalid regular expression', line, column);
      }
      return { source: pattern, flags, end: index + 1 + flags.length };
    }
    pattern += character;
    escaped = !escaped && character === '\\';
    if (character !== '\\') {
      escaped = false;
    }
  }
  throw new ExpressionSyntaxError('Unterminated regular expression', line, column);
}
