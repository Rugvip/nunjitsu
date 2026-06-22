/** Inert regular-expression data stored in literal AST nodes. */
export interface AstRegexLiteral {
  readonly type: 'regex-literal';
  readonly source: string;
  readonly flags: string;
}

/** Primitive data accepted by a literal syntax node. */
export type AstLiteralValue = undefined | null | boolean | number | string | AstRegexLiteral;

interface AstNodeBase {
  readonly type: string;
  readonly line: number;
  readonly column: number;
}

/** A template root or statement sequence. */
export interface AstSequenceNode extends AstNodeBase {
  readonly type: 'Root' | 'NodeList';
  readonly children: readonly AstNode[];
}

/** A sequence of literal and evaluated output values. */
export interface AstOutputNode extends AstNodeBase {
  readonly type: 'Output';
  readonly children: readonly AstNode[];
}

/** Literal template text. */
export interface AstTemplateDataNode extends AstNodeBase {
  readonly type: 'TemplateData';
  readonly value: string;
}

/** A primitive expression literal. */
export interface AstLiteralNode extends AstNodeBase {
  readonly type: 'Literal';
  readonly value: AstLiteralValue;
}

/** An identifier expression or binding target. */
export interface AstSymbolNode extends AstNodeBase {
  readonly type: 'Symbol';
  readonly value: string;
}

/** An ordered expression collection. */
export interface AstCollectionNode extends AstNodeBase {
  readonly type: 'Group' | 'Array' | 'Dict' | 'KeywordArgs';
  readonly children: readonly AstNode[];
}

/** One dictionary or keyword-argument entry. */
export interface AstPairNode extends AstNodeBase {
  readonly type: 'Pair';
  readonly key: AstNode;
  readonly value: AstNode;
}

/** Explicit lookup over a closed template value. */
export interface AstLookupNode extends AstNodeBase {
  readonly type: 'LookupVal';
  readonly target: AstNode;
  readonly val: AstNode;
}

/** A slice lookup with null literals representing omitted bounds. */
export interface AstSliceNode extends AstNodeBase {
  readonly type: 'Slice';
  readonly start: AstNode;
  readonly stop: AstNode;
  readonly step: AstNode;
}

/** Conditional statement or expression. */
export interface AstConditionalNode extends AstNodeBase {
  readonly type: 'If' | 'InlineIf';
  readonly cond: AstNode;
  readonly body: AstNode;
  readonly else_?: AstNode;
}

/** A synchronous template loop. */
export interface AstForNode extends AstNodeBase {
  readonly type: 'For';
  readonly arr: AstNode;
  readonly name: AstNode;
  readonly body: AstNode;
  readonly else_?: AstNode;
}

/** A macro or call-block body. */
export interface AstCallableBodyNode extends AstNodeBase {
  readonly type: 'Macro' | 'Caller';
  readonly name: AstNode;
  readonly args: AstNode;
  readonly body: AstNode;
}

/** A function call or filter invocation. */
export interface AstCallNode extends AstNodeBase {
  readonly type: 'FunCall' | 'Filter';
  readonly name: AstNode;
  readonly args: AstNode;
}

/** One standalone named block. */
export interface AstBlockNode extends AstNodeBase {
  readonly type: 'Block';
  readonly name: AstNode;
  readonly body: AstNode;
}

/** One assignment statement. */
export interface AstSetNode extends AstNodeBase {
  readonly type: 'Set';
  readonly targets: readonly AstNode[];
  readonly value?: AstNode;
  readonly body?: AstNode;
}

/** One switch statement. */
export interface AstSwitchNode extends AstNodeBase {
  readonly type: 'Switch';
  readonly expr: AstNode;
  readonly cases: readonly AstCaseNode[];
  readonly default?: AstNode;
}

/** One switch case. */
export interface AstCaseNode extends AstNodeBase {
  readonly type: 'Case';
  readonly cond: AstNode;
  readonly body: AstNode;
}

/** Captured output used as an expression value. */
export interface AstCaptureNode extends AstNodeBase {
  readonly type: 'Capture';
  readonly body: AstNode;
}

/** A binary expression. */
export interface AstBinaryNode extends AstNodeBase {
  readonly type:
    | 'In'
    | 'Is'
    | 'Or'
    | 'And'
    | 'Add'
    | 'Concat'
    | 'Sub'
    | 'Mul'
    | 'Div'
    | 'Mod'
    | 'Pow';
  readonly left: AstNode;
  readonly right: AstNode;
}

/** A unary expression. */
export interface AstUnaryNode extends AstNodeBase {
  readonly type: 'Not' | 'Neg' | 'Pos' | 'Floor';
  readonly target: AstNode;
}

/** One chained comparison expression. */
export interface AstCompareNode extends AstNodeBase {
  readonly type: 'Compare';
  readonly expr: AstNode;
  readonly ops: readonly AstCompareOperandNode[];
}

/** One operator and right operand in a chained comparison. */
export interface AstCompareOperandNode extends AstNodeBase {
  readonly type: 'CompareOperand';
  readonly expr: AstNode;
  readonly operator: string;
}

/** A legacy super marker retained for exhaustive evaluator handling. */
export interface AstSuperNode extends AstNodeBase {
  readonly type: 'Super';
  readonly blockName?: string;
  readonly symbol?: string;
}

/** Every immutable data-only syntax node emitted by the native parser. */
export type AstNode =
  | AstSequenceNode
  | AstOutputNode
  | AstTemplateDataNode
  | AstLiteralNode
  | AstSymbolNode
  | AstCollectionNode
  | AstPairNode
  | AstLookupNode
  | AstSliceNode
  | AstConditionalNode
  | AstForNode
  | AstCallableBodyNode
  | AstCallNode
  | AstBlockNode
  | AstSetNode
  | AstSwitchNode
  | AstCaseNode
  | AstCaptureNode
  | AstBinaryNode
  | AstUnaryNode
  | AstCompareNode
  | AstCompareOperandNode
  | AstSuperNode;

/** Data permitted inside the immutable AST. */
export type AstData = AstLiteralValue | AstNode | readonly AstData[];

/** Returns whether a private parser value is one of the closed node variants. */
export function isAstNode(value: unknown): value is AstNode {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { line?: unknown }).line === 'number' &&
    typeof (value as { column?: unknown }).column === 'number',
  );
}
