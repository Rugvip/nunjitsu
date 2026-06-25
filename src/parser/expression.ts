import { formatDiagnosticValue } from '../diagnostics.ts';
import { TemplateLimitError } from '../limits.ts';
import { isReservedName } from '../runtime/value.ts';
import type { AstNode, AstRegexLiteral } from './ast.ts';
import { scanIdentifier } from './scanIdentifier.ts';
import { RegexLiteralSyntaxError, scanRegexLiteral } from './scanRegexLiteral.ts';
import { isCodeWhitespace } from './whitespace.ts';

interface Token {
  readonly kind: 'eof' | 'name' | 'number' | 'string' | 'regex' | 'operator';
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

type MultiplicativeOperator = 'Mul' | 'Div' | 'Mod';

interface MultiplicativeOperation {
  readonly type: MultiplicativeOperator;
  readonly right: AstNode;
}

interface MultiplicativeSequence {
  readonly first: AstNode;
  readonly operations: MultiplicativeOperation[];
}

const simpleStringEscapes: Readonly<Record<string, string>> = Object.freeze({
  n: '\n',
  r: '\r',
  t: '\t',
});
const decimalNumberPattern = /^\d+(?:\.\d*)?/;
const invalidNumericSuffixPattern = /^[A-Za-z_]$/;
const literalNames = new Set(['true', 'false', 'null', 'none']);

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
      const token = this.#expect('name');
      if (literalNames.has(token.value)) {
        this.#fail('Binding targets must be ordinary names', token);
      }
      targets.push(this.#symbol(token));
    } while (this.#consume(','));
    this.#expect('eof');
    return Object.freeze(targets);
  }

  parseSignature(): AstNode {
    const children = this.#parseArguments(')');
    this.#expect('eof');
    for (const child of children) {
      if (child.type === 'KeywordArgs') {
        for (const pair of child.children) {
          if (pair.type !== 'Pair' || pair.key.type !== 'Symbol') {
            this.#fail('Defaulted formal parameters must use names', pair);
          }
        }
      } else if (child.type !== 'Symbol') {
        this.#fail('Formal parameters must be names', child);
      }
    }
    return this.#make('NodeList', { children });
  }

  /** Parses one filter-block header around an already parsed capture node. */
  parseFilterInvocation(input: AstNode): AstNode {
    const filter = this.#parseFilterInvocation(input);
    this.#expect('eof');
    return filter;
  }

  #parseInlineIf(): AstNode {
    const body = this.#parseOr();
    if (!this.#consumeName('if')) {
      return body;
    }
    const cond = this.#parseOr();
    const otherwise = this.#consumeName('else')
      ? this.#nested(() => this.#parseOr())
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
    const position = this.#peek();
    if (this.#consumeName('not')) {
      const target = this.#nested(() => this.#parseNot());
      return this.#lowerObservableNot(target, position);
    }
    return this.#parseMembership();
  }

  #parseMembership(): AstNode {
    let left = this.#parseTest();
    for (;;) {
      let negate = false;
      if (this.#peek().value === 'not' && this.#peek(1).value === 'in') {
        this.#index += 2;
        negate = true;
      } else if (!this.#consumeName('in')) {
        return left;
      }
      const membership = this.#make('In', { left, right: this.#parseTest() }, left);
      left = negate ? this.#make('Not', { target: membership }, left) : membership;
    }
  }

  #parseTest(): AstNode {
    const left = this.#parseCompare();
    if (this.#consumeName('is')) {
      const negate = this.#consumeName('not');
      const right = this.#parseCompare();
      const test = this.#make('Is', { left, right }, right);
      return negate ? this.#make('Not', { target: test }, left) : test;
    }
    return left;
  }

  #parseCompare(): AstNode {
    return this.#parseEquality();
  }

  #parseEquality(): AstNode {
    const left = this.#parseRelational();
    const operations: AstNode[] = [];
    while (['==', '===', '!=', '!=='].includes(this.#peek().value)) {
      const token = this.#peek();
      this.#index += 1;
      const expr = this.#parseRelational();
      operations.push(this.#make('CompareOperand', { expr, operator: token.value }, expr));
    }
    return this.#makeComparison(left, operations);
  }

  #parseRelational(): AstNode {
    const left = this.#parseAdditive();
    const operations: AstNode[] = [];
    while (['<', '<=', '>', '>='].includes(this.#peek().value)) {
      const token = this.#peek();
      this.#index += 1;
      const expr = this.#parseAdditive();
      operations.push(this.#make('CompareOperand', { expr, operator: token.value }, expr));
    }
    return this.#makeComparison(left, operations);
  }

  #makeComparison(left: AstNode, operations: AstNode[]): AstNode {
    if (operations.length === 0) {
      return left;
    }
    return this.#make('Compare', {
      expr: left,
      ops: Object.freeze(operations) as never,
    }, left);
  }

  #lowerObservableNot(target: AstNode, position: Pick<Token, 'line' | 'column'>): AstNode {
    switch (target.type) {
      case 'Add':
      case 'Concat':
      case 'Sub':
      case 'Mul':
      case 'Div':
      case 'Mod':
        return this.#make(target.type, {
          left: this.#lowerObservableNot(target.left, position),
          right: target.right,
        }, position);
      case 'Compare':
        return this.#make('Compare', {
          expr: this.#lowerObservableNot(target.expr, position),
          ops: target.ops,
        }, position);
      default:
        return this.#make('Not', { target }, position);
    }
  }

  #parseAdditive(): AstNode {
    let left = this.#parseMultiply();
    for (;;) {
      if (this.#consume('+')) {
        left = this.#make('Add', { left, right: this.#parseMultiply() }, left);
      } else if (this.#consume('-')) {
        left = this.#make('Sub', { left, right: this.#parseMultiply() }, left);
      } else if (this.#consume('~')) {
        left = this.#make('Concat', { left, right: this.#parseMultiply() }, left);
      } else {
        return left;
      }
    }
  }

  #parseMultiply(): AstNode {
    return this.#materializeMultiplicative(this.#parseMultiplySequence());
  }

  #parseMultiplySequence(): MultiplicativeSequence {
    const sequence = this.#parseDivideSequence();
    while (this.#consume('*')) {
      this.#appendMultiplicative(sequence, 'Mul', this.#parseDivideSequence());
    }
    return sequence;
  }

  #parseDivideSequence(): MultiplicativeSequence {
    const sequence = this.#parseFloorDivideSequence();
    while (this.#consume('/')) {
      this.#appendMultiplicative(sequence, 'Div', this.#parseFloorDivideSequence());
    }
    return sequence;
  }

  #parseFloorDivideSequence(): MultiplicativeSequence {
    let sequence = this.#parseModuloSequence();
    while (this.#consume('//')) {
      this.#appendMultiplicative(sequence, 'Div', this.#parseModuloSequence());
      const target = this.#materializeMultiplicative(sequence);
      sequence = { first: this.#make('Floor', { target }, target), operations: [] };
    }
    return sequence;
  }

  #parseModuloSequence(): MultiplicativeSequence {
    const sequence: MultiplicativeSequence = {
      first: this.#parsePower(),
      operations: [],
    };
    while (this.#consume('%')) {
      sequence.operations.push({ type: 'Mod', right: this.#parsePower() });
    }
    return sequence;
  }

  #appendMultiplicative(
    sequence: MultiplicativeSequence,
    type: MultiplicativeOperator,
    right: MultiplicativeSequence,
  ): void {
    sequence.operations.push({ type, right: right.first }, ...right.operations);
  }

  #materializeMultiplicative(sequence: MultiplicativeSequence): AstNode {
    let left = sequence.first;
    for (const operation of sequence.operations) {
      left = this.#make(operation.type, { left, right: operation.right }, left);
    }
    return left;
  }

  #parsePower(): AstNode {
    let left = this.#parseFilter();
    while (this.#consume('**')) {
      left = this.#make('Pow', { left, right: this.#parseFilter() }, left);
    }
    return left;
  }

  #parseFilter(): AstNode {
    let expression = this.#parseUnary();
    while (this.#consume('|')) {
      expression = this.#parseFilterInvocation(expression);
    }
    return expression;
  }

  #parseFilterInvocation(input: AstNode): AstNode {
    const name = this.#parseFilterName();
    const supplied = this.#consume('(')
      ? this.#nested(() => this.#parseArguments(')'))
      : Object.freeze([]);
    return this.#make('Filter', {
      name,
      args: this.#make('NodeList', {
        children: Object.freeze([input, ...supplied]),
      }, input),
    }, name);
  }

  #parseFilterName(): AstNode {
    const first = this.#expect('name');
    const segments = [first.value];
    this.#assertAllowedName(first.value, first);
    while (this.#consume('.')) {
      const segment = this.#expect('name');
      this.#assertAllowedName(segment.value, segment);
      segments.push(segment.value);
    }
    return this.#make('Symbol', { value: segments.join('.') }, first);
  }

  #parseUnary(): AstNode {
    const operator = this.#peek();
    if (this.#consume('-')) {
      const target = this.#nested(() => this.#parseUnary());
      if (target.type === 'Neg') {
        this.#fail('Repeated unparenthesized unary - is not supported', target);
      }
      return this.#make('Neg', { target }, operator);
    }
    if (this.#consume('+')) {
      const target = this.#nested(() => this.#parseUnary());
      if (target.type === 'Pos') {
        this.#fail('Repeated unparenthesized unary + is not supported', target);
      }
      return this.#make('Pos', { target }, operator);
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
        }, key);
      } else if (this.#consume('[')) {
        const value = this.#nested(() => this.#parseSubscript());
        this.#expectValue(']');
        if (value.type === 'Literal' && typeof value.value === 'string') {
          this.#assertAllowedName(value.value, value);
        }
        expression = this.#make('LookupVal', { target: expression, val: value }, value);
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
      if (children.length === 0) {
        this.#fail('Parenthesized expression cannot be empty', token);
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
        if (keyToken.kind === 'name' && !literalNames.has(keyToken.value)) {
          this.#index += 1;
          key = this.#symbol(keyToken);
        } else if (keyToken.kind === 'string') {
          this.#index += 1;
          key = this.#literal(keyToken.value, keyToken);
        } else {
          this.#fail('Dictionary keys must be strings or names', keyToken);
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
        positional.push(this.#parseInlineIf());
      }
    } while (this.#consume(','));
    this.#expectValue(end);
    if (keywords.length > 0) {
      positional.push(this.#make('KeywordArgs', { children: Object.freeze(keywords) }));
    }
    return Object.freeze(positional);
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
      const token = this.#peek();
      throw new TemplateLimitError('nestingDepth', {
        phase: 'parse',
        line: token.line + 1,
        column: token.column + 1,
        configured: this.#maximumDepth,
        observed: this.#depth,
      });
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
    if (isCodeWhitespace(character)) {
      ({ line, column } = advanceSourcePosition(source, index, index + 1, line, column));
      index += 1;
      continue;
    }
    const tokenLine = line;
    const tokenColumn = column;
    const name = scanIdentifier(source, index);
    if (name) {
      if (name.value === 'r' && source[name.end] === '/') {
        let regex;
        try {
          regex = scanRegexLiteral(source, index);
        } catch (error) {
          if (error instanceof RegexLiteralSyntaxError) {
            throw new ExpressionSyntaxError(error.message, tokenLine, tokenColumn);
          }
          throw error;
        }
        emit('regex', `${regex.source}/${regex.flags}`, tokenLine, tokenColumn);
        const consumed = regex.end - index;
        index = regex.end;
        column += consumed;
      } else {
        emit('name', name.value, tokenLine, tokenColumn);
        const consumed = name.end - index;
        index = name.end;
        column += consumed;
      }
      continue;
    }
    if (character === '.' && isAsciiDigit(source[index + 1])) {
      throw new ExpressionSyntaxError('Invalid numeric literal', tokenLine, tokenColumn);
    }
    const number = decimalNumberPattern.exec(source.slice(index));
    if (number) {
      const suffix = source[index + number[0].length];
      if (suffix !== undefined && invalidNumericSuffixPattern.test(suffix)) {
        throw new ExpressionSyntaxError('Invalid numeric literal', tokenLine, tokenColumn);
      }
      emit('number', number[0], tokenLine, tokenColumn);
      index += number[0].length;
      column += number[0].length;
      continue;
    }
    if (character === '"' || character === "'") {
      const string = readString(source, index, character, tokenLine, tokenColumn);
      emit('string', string.value, tokenLine, tokenColumn);
      ({ line, column } = advanceSourcePosition(source, index, string.end, line, column));
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

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
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
    } else {
      value += escaped;
    }
  }
  throw new ExpressionSyntaxError('Unterminated string literal', line, column);
}

function advanceSourcePosition(
  source: string,
  start: number,
  end: number,
  initialLine: number,
  initialColumn: number,
): { readonly line: number; readonly column: number } {
  let line = initialLine;
  let column = initialColumn;
  for (let index = start; index < end; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
