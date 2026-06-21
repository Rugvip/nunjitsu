import * as nunjucks from 'nunjucks';

import { isReservedName } from '../runtime/value.ts';
import type { AstData, AstNode, AstNodeType, AstRegexLiteral } from './ast.ts';

/** Parser configuration affecting standard Nunjucks whitespace handling. */
export interface ParseOptions {
  /** Removes one newline immediately following a block tag. */
  trimBlocks: boolean;
  /** Removes indentation before block tags on otherwise blank lines. */
  lstripBlocks: boolean;
  /** Uses Cookiecutter/Jinja variable syntax and compatibility behavior. */
  cookiecutterCompat?: boolean;
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

interface ForeignNode {
  readonly typename: unknown;
  readonly lineno?: unknown;
  readonly colno?: unknown;
  readonly [name: string]: unknown;
}

interface ForeignParser {
  parse(source: string, extensions: readonly unknown[], options: {
    trimBlocks: boolean;
    lstripBlocks: boolean;
    tags: { variableStart: string; variableEnd: string };
  }): unknown;
}

interface NunjucksModule {
  readonly parser: ForeignParser;
  installJinjaCompat(): () => void;
}

/** Closed field shapes validated before an AST can leave the parser. */
type AstFieldKind = 'data' | 'literal' | 'node' | 'nodes' | 'optional-node' | 'string';

const nativeNunjucks = (nunjucks as unknown as { default: NunjucksModule }).default;
const parser = nativeNunjucks.parser;

const nodeFields = Object.freeze({
  Root: { children: 'nodes' },
  NodeList: { children: 'nodes' },
  Output: { children: 'nodes' },
  TemplateData: { value: 'string' },
  Literal: { value: 'literal' },
  Symbol: { value: 'string' },
  Group: { children: 'nodes' },
  Array: { children: 'nodes' },
  Dict: { children: 'nodes' },
  KeywordArgs: { children: 'nodes' },
  Pair: { key: 'node', value: 'node' },
  LookupVal: { target: 'node', val: 'node' },
  Slice: { start: 'node', stop: 'node', step: 'node' },
  If: { cond: 'node', body: 'node', else_: 'optional-node' },
  InlineIf: { cond: 'node', body: 'node', else_: 'optional-node' },
  For: { arr: 'node', name: 'node', body: 'node', else_: 'optional-node' },
  Macro: { name: 'node', args: 'node', body: 'node' },
  Caller: { name: 'node', args: 'node', body: 'node' },
  FunCall: { name: 'node', args: 'node' },
  Filter: { name: 'node', args: 'node' },
  Block: { name: 'node', body: 'node' },
  Super: { blockName: 'data', symbol: 'data' },
  Set: { targets: 'nodes', value: 'optional-node', body: 'optional-node' },
  Switch: { expr: 'node', cases: 'nodes', default: 'optional-node' },
  Case: { cond: 'node', body: 'node' },
  Capture: { body: 'node' },
  In: { left: 'node', right: 'node' },
  Is: { left: 'node', right: 'node' },
  Or: { left: 'node', right: 'node' },
  And: { left: 'node', right: 'node' },
  Not: { target: 'node' },
  Add: { left: 'node', right: 'node' },
  Concat: { left: 'node', right: 'node' },
  Sub: { left: 'node', right: 'node' },
  Mul: { left: 'node', right: 'node' },
  Div: { left: 'node', right: 'node' },
  FloorDiv: { left: 'node', right: 'node' },
  Mod: { left: 'node', right: 'node' },
  Pow: { left: 'node', right: 'node' },
  Neg: { target: 'node' },
  Pos: { target: 'node' },
  Compare: { expr: 'node', ops: 'nodes' },
  CompareOperand: { expr: 'node', type: 'string' },
} as const satisfies Record<AstNodeType, Readonly<Record<string, AstFieldKind>>>);

/** Parses and fully validates one untrusted template into a data-only AST. */
export function parseTemplate(
  source: string,
  options: ParseOptions = { trimBlocks: false, lstripBlocks: false },
): AstNode {
  const variableStart = options.cookiecutterCompat ? '{{' : '${{';
  const normalizedSource = normalizeNumericLookups(
    normalizeRawWhitespace(source),
    variableStart,
  );
  validateRawBlocks(normalizedSource);
  const uninstallCompat = options.cookiecutterCompat
    ? nativeNunjucks.installJinjaCompat()
    : () => {};
  try {
    const ast = convertNode(parser.parse(
      normalizedSource,
      [],
      {
        trimBlocks: options.trimBlocks,
        lstripBlocks: options.lstripBlocks,
        tags: { variableStart, variableEnd: '}}' },
      },
    ));
    validateAst(ast);
    return ast;
  } catch (error) {
    if (error instanceof NunjitsuParseError) {
      throw error;
    }
    const foreign = error as { message?: unknown; lineno?: unknown; colno?: unknown };
    throw new NunjitsuParseError(
      typeof foreign.message === 'string' ? foreign.message : 'Invalid template syntax',
      typeof foreign.lineno === 'number' ? foreign.lineno : undefined,
      typeof foreign.colno === 'number' ? foreign.colno : undefined,
      error,
    );
  } finally {
    uninstallCompat();
  }
}

function normalizeNumericLookups(source: string, variableStart: string): string {
  let output = '';
  let cursor = 0;
  const opening = /{%-?\s*(raw|verbatim)\s*-?%}/g;
  for (;;) {
    const match = opening.exec(source);
    if (!match) {
      output += normalizeNumericTags(source.slice(cursor), variableStart);
      return output;
    }
    output += normalizeNumericTags(source.slice(cursor, match.index), variableStart);
    const name = match[1]!;
    const closing = new RegExp(`{%-?\\s*end${name}\\s*-?%}`, 'g');
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(source);
    if (!end) {
      return source;
    }
    output += source.slice(match.index, closing.lastIndex);
    cursor = closing.lastIndex;
    opening.lastIndex = cursor;
  }
}

function normalizeNumericTags(source: string, variableStart: string): string {
  const escapedStart = variableStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(
    new RegExp(`${escapedStart}[\\s\\S]*?}}|{%[\\s\\S]*?%}`, 'g'),
    normalizeNumericTag,
  );
}

function normalizeNumericTag(tag: string): string {
  let output = '';
  let quote: '"' | "'" | undefined;
  let regex = false;
  let escaped = false;
  for (let index = 0; index < tag.length; index += 1) {
    const character = tag[index]!;
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if ((quote || regex) && character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (regex) {
      output += character;
      if (character === '/') {
        regex = false;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (
      character === 'r' &&
      tag[index + 1] === '/' &&
      (index === 0 || /[\s(,=:[{]/.test(tag[index - 1]!))
    ) {
      regex = true;
      output += character;
      continue;
    }
    const numericLookup = character === '.' ? /^(\d+)\b/.exec(tag.slice(index + 1)) : null;
    if (numericLookup && /[A-Za-z_\])]/.test(tag[index - 1] ?? '')) {
      output += `[${numericLookup[1]}]`;
      index += numericLookup[1]!.length;
      continue;
    }
    output += character;
  }
  return output;
}

function normalizeRawWhitespace(source: string): string {
  return source
    .replace(/({%\s*(?:raw|verbatim)\s*)-%}[\t\n\r ]*/g, '$1%}')
    .replace(/[\t\n\r ]*{%-\s*(end(?:raw|verbatim))\s*%}/g, '{% $1 %}');
}

function validateRawBlocks(source: string): void {
  const opening = /{%-?\s*(raw|verbatim)\s*-?%}/g;
  for (;;) {
    const match = opening.exec(source);
    if (!match) {
      return;
    }
    const name = match[1]!;
    const closing = new RegExp(`{%-?\\s*end${name}\\s*-?%}`, 'g');
    closing.lastIndex = opening.lastIndex;
    const end = closing.exec(source);
    if (!end) {
      throw new NunjitsuParseError(`Missing end${name} tag`);
    }
    opening.lastIndex = closing.lastIndex;
  }
}

function convertNode(value: unknown): AstNode {
  if (!isForeignNode(value)) {
    throw new NunjitsuParseError('Parser returned an invalid syntax node');
  }
  const type = value.typename;
  if (typeof type !== 'string' || !Object.hasOwn(nodeFields, type)) {
    throw new NunjitsuParseError(`Parser returned unsupported syntax node ${String(type)}`);
  }
  const nodeType = type as AstNodeType;
  const nodeFieldShapes = (nodeFields as Partial<
    Record<AstNodeType, Readonly<Record<string, AstFieldKind>>>
  >)[nodeType];
  if (!nodeFieldShapes) {
    throw new NunjitsuParseError(`Parser returned unsupported syntax node ${type}`);
  }
  const fields = Object.create(null) as Record<string, AstData>;
  for (const name of Object.keys(nodeFieldShapes)) {
    fields[name] = convertData(value[name]);
  }
  if (nodeType === 'Symbol') {
    const name = fields.value;
    if (typeof name !== 'string') {
      throw new NunjitsuParseError('Parser returned an invalid symbol');
    }
    if (isReservedName(name)) {
      throw new NunjitsuParseError(`Template name ${name} is reserved`);
    }
  }
  const node = Object.freeze({
    type: nodeType,
    line: numericPosition(value.lineno),
    column: numericPosition(value.colno),
    fields: Object.freeze(fields),
  });
  validateReservedSyntax(node);
  return node;
}

function convertData(value: unknown): AstData {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (value instanceof RegExp) {
    return Object.freeze({
      type: 'regex-literal',
      source: value.source,
      flags: value.flags,
    } satisfies AstRegexLiteral);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(convertData));
  }
  if (isForeignNode(value)) {
    return convertNode(value);
  }
  throw new NunjitsuParseError('Parser returned executable or unsupported AST data');
}

function isForeignNode(value: unknown): value is ForeignNode {
  return Boolean(value && typeof value === 'object' && 'typename' in value);
}

function numericPosition(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validateReservedSyntax(node: AstNode): void {
  if (node.type !== 'LookupVal' && node.type !== 'Pair') {
    return;
  }
  const field = node.type === 'LookupVal' ? node.fields.val : node.fields.key;
  if (
    field &&
    !Array.isArray(field) &&
    typeof field === 'object' &&
    'type' in field &&
    (field.type === 'Literal' || field.type === 'Symbol')
  ) {
    const name = field.fields.value;
    if (typeof name === 'string' && isReservedName(name)) {
      throw new NunjitsuParseError(`Template name ${name} is reserved`);
    }
  }
}

function validateAst(node: AstNode): void {
  const shapes = nodeFields[node.type];
  for (const [name, shape] of Object.entries(shapes)) {
    validateAstField(node, name, shape);
  }
}

function validateAstField(node: AstNode, name: string, shape: AstFieldKind): void {
  const value = node.fields[name];
  if (shape === 'string') {
    if (typeof value !== 'string') {
      throw invalidAstField(node, name);
    }
    return;
  }
  if (shape === 'literal') {
    if (!isAstLiteral(value)) {
      throw invalidAstField(node, name);
    }
    return;
  }
  if (shape === 'optional-node' && (value === undefined || value === null)) {
    return;
  }
  if (shape === 'node' || shape === 'optional-node') {
    if (!isConvertedNode(value)) {
      throw invalidAstField(node, name);
    }
    validateAst(value);
    return;
  }
  if (shape === 'nodes') {
    if (!Array.isArray(value) || !value.every(isConvertedNode)) {
      throw invalidAstField(node, name);
    }
    for (const child of value) {
      validateAst(child);
    }
    return;
  }
  validateAstData(value);
}

function validateAstData(value: AstData): void {
  if (isConvertedNode(value)) {
    validateAst(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      validateAstData(child);
    }
  }
}

function isConvertedNode(value: AstData): value is AstNode {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'fields' in value);
}

function isAstLiteral(value: AstData): boolean {
  return value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'type' in value &&
      value.type === 'regex-literal',
    );
}

function invalidAstField(node: AstNode, name: string): NunjitsuParseError {
  return new NunjitsuParseError(`Parser returned invalid ${node.type}.${name} syntax data`);
}
