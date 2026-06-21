/** Closed node kinds emitted by the Nunjitsu parser. */
export type AstNodeType =
  | 'Root'
  | 'NodeList'
  | 'Output'
  | 'TemplateData'
  | 'Literal'
  | 'Symbol'
  | 'Group'
  | 'Array'
  | 'Dict'
  | 'KeywordArgs'
  | 'Pair'
  | 'LookupVal'
  | 'If'
  | 'IfAsync'
  | 'InlineIf'
  | 'For'
  | 'AsyncEach'
  | 'AsyncAll'
  | 'Macro'
  | 'Caller'
  | 'Import'
  | 'FromImport'
  | 'FunCall'
  | 'Filter'
  | 'FilterAsync'
  | 'Block'
  | 'Super'
  | 'Extends'
  | 'Include'
  | 'Set'
  | 'Switch'
  | 'Case'
  | 'Capture'
  | 'In'
  | 'Is'
  | 'Or'
  | 'And'
  | 'Not'
  | 'Add'
  | 'Concat'
  | 'Sub'
  | 'Mul'
  | 'Div'
  | 'FloorDiv'
  | 'Mod'
  | 'Pow'
  | 'Neg'
  | 'Pos'
  | 'Compare'
  | 'CompareOperand'
  | 'CallExtension'
  | 'CallExtensionAsync';

/** Inert regular-expression data stored in literal AST nodes. */
export interface AstRegexLiteral {
  readonly type: 'regex-literal';
  readonly source: string;
  readonly flags: string;
}

/** Data permitted inside AST fields. */
export type AstData =
  | undefined
  | null
  | boolean
  | number
  | string
  | AstRegexLiteral
  | AstNode
  | readonly AstData[];

/** One immutable data-only syntax node. */
export interface AstNode {
  readonly type: AstNodeType;
  readonly line: number;
  readonly column: number;
  readonly fields: Readonly<Record<string, AstData>>;
}

/** Returns one statically named AST field. */
export function astField(node: AstNode, name: string): AstData {
  return node.fields[name];
}

/** Narrows one AST field to a node. */
export function astNode(node: AstNode, name: string): AstNode {
  const value = astField(node, name);
  if (!isAstNode(value)) {
    throw new Error(`Invalid ${node.type}.${name} AST field`);
  }
  return value;
}

/** Narrows one AST field to an optional node. */
export function optionalAstNode(node: AstNode, name: string): AstNode | undefined {
  const value = astField(node, name);
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isAstNode(value)) {
    throw new Error(`Invalid ${node.type}.${name} AST field`);
  }
  return value;
}

/** Narrows one AST field to a node array. */
export function astNodes(node: AstNode, name: string): readonly AstNode[] {
  const value = astField(node, name);
  if (!Array.isArray(value) || !value.every(isAstNode)) {
    throw new Error(`Invalid ${node.type}.${name} AST field`);
  }
  return value;
}

/** Returns whether a value is one of the parser's immutable nodes. */
export function isAstNode(value: unknown): value is AstNode {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { line?: unknown }).line === 'number' &&
    typeof (value as { column?: unknown }).column === 'number' &&
    (value as { fields?: unknown }).fields &&
    typeof (value as { fields?: unknown }).fields === 'object',
  );
}
