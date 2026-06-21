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

const nativeNunjucks = (nunjucks as unknown as { default: NunjucksModule }).default;
const parser = nativeNunjucks.parser;

const nodeFields = Object.freeze({
  Root: ['children'],
  NodeList: ['children'],
  Output: ['children'],
  TemplateData: ['value'],
  Literal: ['value'],
  Symbol: ['value'],
  Group: ['children'],
  Array: ['children'],
  Dict: ['children'],
  KeywordArgs: ['children'],
  Pair: ['key', 'value'],
  LookupVal: ['target', 'val'],
  Slice: ['start', 'stop', 'step'],
  If: ['cond', 'body', 'else_'],
  InlineIf: ['cond', 'body', 'else_'],
  For: ['arr', 'name', 'body', 'else_'],
  Macro: ['name', 'args', 'body'],
  Caller: ['name', 'args', 'body'],
  FunCall: ['name', 'args'],
  Filter: ['name', 'args'],
  Block: ['name', 'body'],
  Super: ['blockName', 'symbol'],
  Set: ['targets', 'value', 'body'],
  Switch: ['expr', 'cases', 'default'],
  Case: ['cond', 'body'],
  Capture: ['body'],
  In: ['left', 'right'],
  Is: ['left', 'right'],
  Or: ['left', 'right'],
  And: ['left', 'right'],
  Not: ['target'],
  Add: ['left', 'right'],
  Concat: ['left', 'right'],
  Sub: ['left', 'right'],
  Mul: ['left', 'right'],
  Div: ['left', 'right'],
  FloorDiv: ['left', 'right'],
  Mod: ['left', 'right'],
  Pow: ['left', 'right'],
  Neg: ['target'],
  Pos: ['target'],
  Compare: ['expr', 'ops'],
  CompareOperand: ['expr', 'type'],
} as const satisfies Partial<Record<AstNodeType, readonly string[]>>);

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
    return convertNode(parser.parse(
      normalizedSource,
      [],
      {
        trimBlocks: options.trimBlocks,
        lstripBlocks: options.lstripBlocks,
        tags: { variableStart, variableEnd: '}}' },
      },
    ));
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
  const nodeFieldNames = (nodeFields as Partial<Record<AstNodeType, readonly string[]>>)[nodeType];
  if (!nodeFieldNames) {
    throw new NunjitsuParseError(`Parser returned unsupported syntax node ${type}`);
  }
  const fields = Object.create(null) as Record<string, AstData>;
  for (const name of nodeFieldNames) {
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
