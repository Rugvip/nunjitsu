import * as nunjucks from 'nunjucks';

import { isReservedName } from '../runtime/value.ts';
import type { AstData, AstNode, AstNodeType, AstRegexLiteral } from './ast.ts';

/** Parser configuration affecting standard Nunjucks whitespace handling. */
export interface ParseOptions {
  /** Removes one newline immediately following a block tag. */
  trimBlocks: boolean;
  /** Removes indentation before block tags on otherwise blank lines. */
  lstripBlocks: boolean;
  /** Trusted declarative custom-tag grammars accepted by this parse. */
  tags?: readonly ParseTagDescriptor[];
}

/** Data-only grammar descriptor for one trusted custom tag. */
export interface ParseTagDescriptor {
  readonly name: string;
  readonly type: 'inline' | 'body';
  readonly endTag?: string;
  readonly intermediateTags: readonly string[];
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
  parse(source: string, extensions: readonly unknown[], options: ParseOptions): unknown;
}

interface ForeignExtensionParser {
  nextToken(): { readonly value: string; readonly lineno: number; readonly colno: number };
  peekToken(): { readonly value: string; readonly type: string };
  parseSignature(tolerant?: boolean, noParens?: boolean): unknown;
  advanceAfterBlockEnd(name?: string): unknown;
  parseUntilBlocks(...names: string[]): unknown;
  skipSymbol(name: string): boolean;
}

interface ForeignNodes {
  CallExtension: new (extension: unknown, prop: string, args: unknown, content: unknown[]) => unknown;
}

const parser = (nunjucks as unknown as { default: { parser: ForeignParser } }).default.parser;
const foreignNodes = (nunjucks as unknown as { default: { nodes: ForeignNodes } }).default.nodes;

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
  If: ['cond', 'body', 'else_'],
  IfAsync: ['cond', 'body', 'else_'],
  InlineIf: ['cond', 'body', 'else_'],
  For: ['arr', 'name', 'body', 'else_'],
  AsyncEach: ['arr', 'name', 'body', 'else_'],
  AsyncAll: ['arr', 'name', 'body', 'else_'],
  Macro: ['name', 'args', 'body'],
  Caller: ['name', 'args', 'body'],
  Import: ['template', 'target', 'withContext'],
  FromImport: ['template', 'names', 'withContext'],
  FunCall: ['name', 'args'],
  Filter: ['name', 'args'],
  FilterAsync: ['name', 'args', 'symbol'],
  Block: ['name', 'body'],
  Super: ['blockName', 'symbol'],
  Extends: ['template'],
  Include: ['template', 'ignoreMissing'],
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
  CallExtension: ['extName', 'prop', 'args', 'contentArgs', 'autoescape'],
  CallExtensionAsync: ['extName', 'prop', 'args', 'contentArgs', 'autoescape'],
} as const satisfies Record<AstNodeType, readonly string[]>);

/** Parses and fully validates one untrusted template into a data-only AST. */
export function parseTemplate(
  source: string,
  options: ParseOptions = { trimBlocks: false, lstripBlocks: false },
): AstNode {
  try {
    return convertNode(parser.parse(source, createParserExtensions(options.tags ?? []), options));
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
  }
}

function createParserExtensions(tags: readonly ParseTagDescriptor[]): readonly unknown[] {
  return tags.map(tag => {
    const extension = {
      __name: tag.name,
      autoescape: true,
      tags: [tag.name],
      parse(parser_: ForeignExtensionParser) {
        const token = parser_.nextToken();
        const args = parser_.parseSignature(true) ?? parser_.parseSignature(false, true);
        parser_.advanceAfterBlockEnd(token.value);
        if (tag.type === 'inline') {
          return new foreignNodes.CallExtension(extension, 'render', args, []);
        }
        const endTag = tag.endTag ?? `end${tag.name}`;
        const breakTags = [...tag.intermediateTags, endTag];
        const content: unknown[] = [parser_.parseUntilBlocks(...breakTags)];
        const sections = new Map<string, unknown>();
        while (parser_.peekToken().value !== endTag) {
          const sectionName = parser_.peekToken().value;
          if (!tag.intermediateTags.includes(sectionName) || !parser_.skipSymbol(sectionName)) {
            throw new NunjitsuParseError(`Unexpected custom tag section ${sectionName}`);
          }
          parser_.advanceAfterBlockEnd(sectionName);
          sections.set(sectionName, parser_.parseUntilBlocks(...breakTags));
        }
        if (!parser_.skipSymbol(endTag)) {
          throw new NunjitsuParseError(`Expected custom tag end ${endTag}`);
        }
        parser_.advanceAfterBlockEnd(endTag);
        for (const sectionName of tag.intermediateTags) {
          content.push(sections.get(sectionName) ?? null);
        }
        return new foreignNodes.CallExtension(extension, 'render', args, content);
      },
    };
    return extension;
  });
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
  const fields = Object.create(null) as Record<string, AstData>;
  for (const name of nodeFields[nodeType]) {
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
