import type {
  AstBinaryNode,
  AstBlockNode,
  AstCallBlockNode,
  AstCallNode,
  AstCallableBodyNode,
  AstCompareNode,
  AstData,
  AstForNode,
  AstNode,
  AstRegexLiteral,
  AstSetNode,
  AstSliceNode,
} from '../parser/ast.ts';
import { parseTemplate } from '../parser/index.ts';
import type { NormalizedRenderLimits } from '../limits.ts';
import { NunjitsuLimitError } from '../limits.ts';
import type { TemplateContext } from '../values.ts';
import {
  applyBuiltinFilter,
  applyBuiltinTest,
  builtinTestArity,
  hasBuiltinFilter,
  hasBuiltinTest,
  lowerBuiltinFilterArguments,
  lookupRuntimeConstantKey,
  lookupRuntimeValue,
} from './builtins.ts';
import {
  runtimeAdd,
  runtimeConcat,
  runtimeLooseEqual,
  runtimeOrder,
  runtimeStrictEqual,
  runtimeToNumber,
  runtimeToPropertyKey,
  runtimeToString,
} from './coercion.ts';
import { RuntimeEvaluationError } from './RuntimeEvaluationError.ts';
import { RuntimeScope } from './scope.ts';
import { stringCodeUnits } from './stringCodeUnits.ts';
import {
  assertRuntimeValueHasNoCallable,
  copyRuntimeContext,
  isReservedName,
  renderRuntimeValue,
  runtimeTruthy,
  RuntimeArray,
  RuntimeCallable,
  RuntimeRecord,
  RuntimeRegex,
  RuntimeSafeString,
  type RuntimeValue,
} from './value.ts';

/** Copied positional and keyword arguments for one closed call. */
export interface RuntimeArguments {
  readonly positional: readonly RuntimeValue[];
  readonly keyword: ReadonlyMap<string, RuntimeValue>;
}

/** Trusted operations available to the closed interpreter by explicit name. */
export interface RuntimeHost {
  /** Returns whether one exact callable global name is registered. */
  hasGlobal?(name: string): boolean;
  /** Returns whether one exact filter name is registered. */
  hasFilter?(name: string): boolean;
  /** Returns one configured non-callable global value. */
  globalValue?(name: string): { readonly found: boolean; readonly value?: RuntimeValue };
  /** Invokes a configured filter, returning `undefined` when no filter exists. */
  filter?(
    name: string,
    input: RuntimeValue,
    arguments_: RuntimeArguments,
  ): { readonly found: boolean; readonly value?: RuntimeValue };
  /** Invokes a configured global, returning `undefined` when none exists. */
  global?(
    name: string,
    arguments_: RuntimeArguments,
  ): { readonly found: boolean; readonly value?: RuntimeValue };
}

/** Options for one native template evaluation. */
export interface EvaluateOptions {
  readonly cookiecutterCompat: boolean;
  readonly trimBlocks: boolean;
  readonly lstripBlocks: boolean;
  readonly limits: NormalizedRenderLimits;
  readonly host?: RuntimeHost;
}

type OutputTarget = string[];
// Covers temporary and immutable reference slots produced by indexed filters.
const indexedValueScratchBytes = 32;

interface MacroDefinition {
  readonly node: AstCallableBodyNode;
  readonly scope: RuntimeScope;
  readonly invocationScope: RuntimeScope;
}

interface MacroBindingContext {
  readonly bindingScope: RuntimeScope;
  readonly invocationScope: RuntimeScope;
}

/** One non-materializing view over values accepted by a template loop. */
interface RuntimeIteration {
  readonly length: RuntimeValue;
  readonly values: IterableIterator<RuntimeValue>;
}

type BuiltinGlobalName = 'range' | 'cycler' | 'joiner';

type BuiltinCallableDefinition =
  | {
    readonly type: 'global';
    readonly name: BuiltinGlobalName;
  }
  | {
    readonly type: 'cycler';
    readonly values: readonly RuntimeValue[];
    index: number;
  }
  | {
    readonly type: 'cycler-method';
    readonly owner: number;
    readonly method: 'next' | 'reset';
  }
  | {
    readonly type: 'joiner';
    readonly separator: RuntimeValue;
    used: boolean;
  };

/** Parses and evaluates one inline source through the closed interpreter. */
export function evaluateTemplate(
  source: string,
  context: TemplateContext,
  options: EvaluateOptions,
): string {
  return evaluateRuntimeTemplate(source, copyRuntimeContext(context), options);
}

/** Parses and evaluates one inline source with an already copied context. */
export function evaluateRuntimeTemplate(
  source: string,
  context: RuntimeRecord,
  options: EvaluateOptions,
): string {
  if (
    options.limits.sourceCodeUnits !== Number.POSITIVE_INFINITY &&
    source.length > options.limits.sourceCodeUnits
  ) {
    throw new NunjitsuLimitError('sourceCodeUnits');
  }
  const ast = parseTemplate(source, {
    trimBlocks: options.trimBlocks,
    lstripBlocks: options.lstripBlocks,
    cookiecutterCompat: options.cookiecutterCompat,
    astNodes: options.limits.astNodes,
    nestingDepth: options.limits.nestingDepth,
  });
  return new Evaluator(options).render(ast, context);
}

class Evaluator {
  readonly #options: EvaluateOptions;
  readonly #macros = new Map<number, MacroDefinition>();
  readonly #builtinCallables = new Map<number, BuiltinCallableDefinition>();
  readonly #capabilityNames = new Map<number, string>();
  readonly #capabilityHandles = new Map<string, RuntimeCallable>();
  readonly #builtinGlobalHandles = new Map<BuiltinGlobalName, RuntimeCallable>();
  #nextCallableId = 1;
  #workUnits = 0;
  #outputCodeUnits = 0;
  #capabilityCalls = 0;

  constructor(options: EvaluateOptions) {
    this.#options = options;
  }

  render(
    ast: AstNode,
    context: RuntimeRecord,
  ): string {
    const contextScope = new RuntimeScope();
    for (const [name, value] of context.entries()) {
      contextScope.setReadonly(name, value);
    }
    const scope = contextScope.child(true);
    const macroContext = createMacroBindingContext(scope, scope);
    const output: OutputTarget = [];
    try {
      this.#renderTemplate(ast, scope, macroContext, output, 0);
      return output.join('');
    } catch (error) {
      if (error instanceof NunjitsuLimitError) {
        throw error;
      }
      throw RuntimeEvaluationError.from(error, ast.line, ast.column);
    }
  }

  #renderTemplate(
    ast: AstNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    output: OutputTarget,
    depth: number,
  ): void {
    validateUniqueBlocks(ast);
    this.#evaluateNode(ast, scope, macroContext, output, depth + 1);
  }

  #evaluateNode(
    node: AstNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    output: OutputTarget,
    depth: number,
  ): void {
    try {
      this.#evaluateNodeUnchecked(node, scope, macroContext, output, depth);
    } catch (error) {
      if (error instanceof NunjitsuLimitError) {
        throw error;
      }
      throw RuntimeEvaluationError.from(error, node.line, node.column);
    }
  }

  #evaluateNodeUnchecked(
    node: AstNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    output: OutputTarget,
    depth: number,
  ): void {
    this.#charge(depth);
    switch (node.type) {
      case 'Root':
      case 'NodeList':
        this.#evaluateSequence(node.children, scope, macroContext, output, depth);
        return;
      case 'Output':
        for (const child of node.children) {
          if (child.type === 'TemplateData') {
            this.#append(output, literalString(child));
          } else {
            const value = this.#evaluateExpression(child, scope, macroContext, depth + 1);
            this.#append(output, renderRuntimeValue(value));
          }
        }
        return;
      case 'If':
      {
        const condition = this.#evaluateExpression(node.cond, scope, macroContext, depth + 1);
        if (runtimeTruthy(condition)) {
          this.#evaluateNode(node.body, scope, macroContext, output, depth + 1);
        } else {
          const otherwise = node.else_;
          if (otherwise) {
            this.#evaluateNode(otherwise, scope, macroContext, output, depth + 1);
          }
        }
        return;
      }
      case 'For':
        this.#evaluateFor(node, scope, macroContext, output, depth + 1);
        return;
      case 'Set':
        this.#evaluateSet(node, scope, macroContext, depth + 1);
        return;
      case 'Macro': {
        const name = symbolName(node.name);
        const id = this.#nextCallableId++;
        this.#macros.set(id, {
          node,
          scope: macroContext.invocationScope,
          invocationScope: macroContext.invocationScope,
        });
        macroContext.bindingScope.set(name, new RuntimeCallable('macro', id));
        return;
      }
      case 'CallBlock':
        this.#evaluateCallBlock(node, scope, macroContext, output, depth + 1);
        return;
      case 'Block':
        this.#evaluateBlock(node, scope, macroContext, output, depth + 1);
        return;
      case 'Switch': {
        const value = this.#evaluateExpression(node.expr, scope, macroContext, depth + 1);
        const cases = node.cases;
        let matched = false;
        for (const candidate of cases) {
          const condition = matched
            ? undefined
            : this.#evaluateExpression(candidate.cond, scope, macroContext, depth + 1);
          if (matched || runtimeStrictEqual(value, condition)) {
            matched = true;
            if (candidate.body.type === 'NodeList' && candidate.body.children.length === 0) {
              continue;
            }
            this.#evaluateNode(
              candidate.body,
              scope,
              macroContext,
              output,
              depth + 1,
            );
            return;
          }
        }
        const fallback = node.default;
        if (fallback) {
          this.#evaluateNode(fallback, scope, macroContext, output, depth + 1);
        }
        return;
      }
      default:
        throw new Error(`Unexpected statement node ${node.type}`);
    }
  }

  #evaluateBlock(
    node: AstBlockNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    output: OutputTarget,
    depth: number,
  ): void {
    const blockMacroContext = createMacroBindingContext(
      macroContext.invocationScope,
      macroContext.invocationScope,
    );
    this.#evaluateNode(
      node.body,
      scope.child(true),
      blockMacroContext,
      output,
      depth + 1,
    );
  }

  #evaluateSequence(
    nodes: readonly AstNode[],
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    output: OutputTarget,
    depth: number,
  ): void {
    for (const node of nodes) {
      this.#evaluateNode(node, scope, macroContext, output, depth + 1);
    }
  }

  #evaluateFor(
    node: AstForNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    output: OutputTarget,
    depth: number,
  ): void {
    const value = this.#evaluateExpression(node.arr, scope, macroContext, depth + 1);
    const binding = node.name;
    let targets: readonly AstNode[];
    if (binding.type === 'Symbol') {
      targets = [binding];
    } else if (binding.type === 'Array') {
      targets = binding.children;
    } else {
      throw new Error(`Invalid loop target ${binding.type}`);
    }
    const entries = iterableEntries(value, targets.length);
    const loopScope = scope.child();
    const loopMacroContext = createMacroBindingContext(
      loopScope,
      macroContext.invocationScope,
    );
    let index = 0;
    for (const entry of entries.values) {
      const iteration = loopScope;
      bindLoopTargets(targets, entry, iteration);
      const numericLength = runtimeToNumber(entries.length);
      iteration.set('loop', new RuntimeRecord([
        ['index', index + 1],
        ['index0', index],
        ['revindex', numericLength - index],
        ['revindex0', numericLength - index - 1],
        ['first', index === 0],
        ['last', index === numericLength - 1],
        ['length', entries.length],
      ]));
      this.#evaluateNode(
        node.body,
        iteration,
        loopMacroContext,
        output,
        depth + 1,
      );
      index += 1;
    }
    const otherwise = node.else_;
    if (!runtimeTruthy(entries.length) && otherwise) {
      this.#evaluateNode(otherwise, loopScope, loopMacroContext, output, depth + 1);
    }
  }

  #evaluateSet(
    node: AstSetNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): void {
    const targets = node.targets;
    const valueNode = node.value;
    let value: RuntimeValue;
    if (valueNode) {
      value = this.#evaluateExpression(valueNode, scope, macroContext, depth + 1);
    } else {
      const body = node.body;
      if (!body) {
        throw new Error('Invalid block assignment');
      }
      const capturedBody = body.type === 'Capture' ? body.body : body;
      value = this.#capture(capturedBody, scope, macroContext, depth + 1, false);
    }
    if (targets.length === 1) {
      bindAssignment(targets[0]!, value, scope);
      return;
    }
    for (const target of targets) {
      bindAssignment(target, value, scope);
    }
  }

  #evaluateExpression(
    node: AstNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): RuntimeValue {
    try {
      return this.#evaluateExpressionUnchecked(node, scope, macroContext, depth);
    } catch (error) {
      if (error instanceof NunjitsuLimitError) {
        throw error;
      }
      throw RuntimeEvaluationError.from(error, node.line, node.column);
    }
  }

  #evaluateExpressionUnchecked(
    node: AstNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): RuntimeValue {
    this.#charge(depth);
    switch (node.type) {
      case 'Literal': {
        const value = node.value;
        if (isRegexLiteral(value)) {
          return new RuntimeRegex(value.source, value.flags);
        }
        if (
          value === undefined ||
          value === null ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          typeof value === 'number'
        ) {
          return value;
        }
        throw new Error('Invalid literal AST value');
      }
      case 'Symbol': {
        const name = symbolName(node);
        const value = scope.get(name);
        if (value !== undefined || scope.has(name)) {
          return value;
        }
        if (this.#options.cookiecutterCompat) {
          if (name === 'True') {
            return true;
          }
          if (name === 'False') {
            return false;
          }
          if (name === 'None') {
            return null;
          }
        }
        const globalValue = this.#options.host?.globalValue?.(name);
        if (globalValue?.found) {
          return globalValue.value;
        }
        if (this.#options.host?.hasGlobal?.(name)) {
          return this.#registerGlobal(name);
        }
        return this.#registerBuiltinGlobal(name);
      }
      case 'Array': {
        const values: RuntimeValue[] = [];
        for (const child of node.children) {
          values.push(this.#evaluateExpression(child, scope, macroContext, depth + 1));
        }
        return new RuntimeArray(values);
      }
      case 'Group': {
        if (node.children.length === 0) {
          throw new Error('Invalid empty expression group');
        }
        let result: RuntimeValue = undefined;
        for (const [index, child] of node.children.entries()) {
          const value = this.#evaluateExpression(child, scope, macroContext, depth + 1);
          if (index < node.children.length - 1) {
            assertRuntimeValueHasNoCallable(value);
          }
          result = value;
        }
        return result;
      }
      case 'Dict':
      case 'KeywordArgs': {
        const entries: Array<readonly [string, RuntimeValue]> = [];
        for (const pair of node.children) {
          if (pair.type !== 'Pair') {
            throw new Error('Invalid entry node');
          }
          const keyNode = pair.key;
          const name = keyNode.type === 'Symbol'
            ? symbolName(keyNode)
            : runtimeToPropertyKey(
              this.#evaluateExpression(keyNode, scope, macroContext, depth + 1),
            );
          if (isReservedName(name)) {
            throw new Error(`Template name ${name} is reserved`);
          }
          entries.push([
            name,
            this.#evaluateExpression(pair.value, scope, macroContext, depth + 1),
          ]);
        }
        return new RuntimeRecord(entries);
      }
      case 'LookupVal': {
        const target = this.#evaluateExpression(node.target, scope, macroContext, depth + 1);
        const valueNode = node.val;
        if (valueNode.type === 'Slice') {
          return this.#evaluateSlice(target, valueNode, scope, macroContext, depth + 1);
        }
        if (valueNode.type === 'Array') {
          const children = valueNode.children;
          if (children.length === 1 && children[0]?.type === 'Slice') {
            return this.#evaluateSlice(
              target,
              children[0],
              scope,
              macroContext,
              depth + 1,
            );
          }
        }
        const constantKey = constantLookupKey(valueNode);
        if (constantKey.found) {
          this.#charge(depth + 1);
          if (
            target instanceof RuntimeCallable &&
            target.callableKind === 'builtin' &&
            typeof constantKey.value === 'string'
          ) {
            return this.#lookupBuiltinCallable(target.id, constantKey.value);
          }
          return freshMemberCallable(lookupRuntimeConstantKey(target, constantKey.value));
        }
        const key = this.#evaluateExpression(valueNode, scope, macroContext, depth + 1);
        if (target instanceof RuntimeCallable && target.callableKind === 'builtin') {
          return this.#lookupBuiltinCallable(target.id, runtimeToPropertyKey(key));
        }
        return freshMemberCallable(lookupRuntimeValue(target, key));
      }
      case 'InlineIf': {
        const condition = this.#evaluateExpression(node.cond, scope, macroContext, depth + 1);
        if (runtimeTruthy(condition)) {
          return this.#evaluateExpression(node.body, scope, macroContext, depth + 1);
        }
        const otherwise = node.else_;
        return otherwise
          ? this.#evaluateExpression(otherwise, scope, macroContext, depth + 1)
          : undefined;
      }
      case 'Or': {
        const left = this.#evaluateExpression(node.left, scope, macroContext, depth + 1);
        return runtimeTruthy(left)
          ? left
          : this.#evaluateExpression(node.right, scope, macroContext, depth + 1);
      }
      case 'And': {
        const left = this.#evaluateExpression(node.left, scope, macroContext, depth + 1);
        return runtimeTruthy(left)
          ? this.#evaluateExpression(node.right, scope, macroContext, depth + 1)
          : left;
      }
      case 'Not':
        return !runtimeTruthy(
          this.#evaluateExpression(node.target, scope, macroContext, depth + 1),
        );
      case 'Neg':
        return -runtimeToNumber(
          this.#evaluateExpression(node.target, scope, macroContext, depth + 1),
        );
      case 'Pos':
        return runtimeToNumber(
          this.#evaluateExpression(node.target, scope, macroContext, depth + 1),
        );
      case 'Floor':
        return Math.floor(runtimeToNumber(
          this.#evaluateExpression(node.target, scope, macroContext, depth + 1),
        ));
      case 'Add':
      case 'Concat':
      case 'Sub':
      case 'Mul':
      case 'Div':
      case 'Mod':
      case 'Pow':
        return this.#evaluateBinary(node, scope, macroContext, depth + 1);
      case 'Compare':
        return this.#evaluateComparison(node, scope, macroContext, depth + 1);
      case 'In': {
        const needle = this.#evaluateExpression(node.left, scope, macroContext, depth + 1);
        const container = this.#evaluateExpression(node.right, scope, macroContext, depth + 1);
        return runtimeContains(container, needle);
      }
      case 'Is':
        return this.#evaluateTest(node, scope, macroContext, depth + 1);
      case 'Filter':
        return this.#evaluateFilter(node, scope, macroContext, depth + 1);
      case 'FunCall':
        return this.#evaluateCall(node, scope, macroContext, depth + 1);
      case 'Capture':
        return this.#capture(node.body, scope.child(), macroContext, depth + 1, false);
      case 'Caller':
        return this.#registerCaller(node, scope, macroContext.invocationScope);
      default:
        throw new Error(`Unexpected expression node ${node.type}`);
    }
  }

  #evaluateSlice(
    input: RuntimeValue,
    slice: AstSliceNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): RuntimeValue {
    if (input instanceof RuntimeCallable) {
      throw new TypeError('Callable values cannot be sliced');
    }
    const target = runtimeTruthy(input) ? input : new RuntimeArray([]);
    const length = lookupRuntimeConstantKey(target, 'length');
    let start = this.#evaluateExpression(slice.start, scope, macroContext, depth + 1);
    let stop = this.#evaluateExpression(slice.stop, scope, macroContext, depth + 1);
    const step = this.#evaluateExpression(slice.step, scope, macroContext, depth + 1);
    const numericStep = runtimeToNumber(step);
    if (!Number.isFinite(numericStep) || numericStep === 0) {
      throw new Error('Slice step must have finite non-zero numeric coercion');
    }
    const stepOrder = runtimeOrder(step, 0);
    if (start === null) {
      start = stepOrder < 0 ? runtimeToNumber(length) - 1 : 0;
    }
    if (stop === null) {
      stop = stepOrder < 0 ? -1 : length;
    } else if (runtimeOrder(stop, 0) < 0) {
      stop = runtimeAdd(stop, length);
    }
    if (runtimeOrder(start, 0) < 0) {
      start = runtimeAdd(start, length);
    }
    const output: RuntimeValue[] = [];
    let scratchBytes = 0;
    for (let index = start; ; index = runtimeAdd(index, step)) {
      if (runtimeOrder(index, 0) < 0 || runtimeOrder(index, length) > 0) {
        break;
      }
      if (
        (stepOrder > 0 && runtimeOrder(index, stop) >= 0) ||
        (stepOrder < 0 && runtimeOrder(index, stop) <= 0)
      ) {
        break;
      }
      this.#charge(depth);
      const value = lookupRuntimeValue(target, index);
      assertRuntimeValueHasNoCallable(value);
      if (this.#options.limits.scratchBytes !== Number.POSITIVE_INFINITY) {
        scratchBytes += indexedValueScratchBytes + runtimeValueBytes(value);
        if (scratchBytes > this.#options.limits.scratchBytes) {
          throw new NunjitsuLimitError('scratchBytes');
        }
      }
      output.push(value);
    }
    return new RuntimeArray(output);
  }

  #evaluateBinary(
    node: AstBinaryNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): RuntimeValue {
    const left = this.#evaluateExpression(node.left, scope, macroContext, depth + 1);
    const right = this.#evaluateExpression(node.right, scope, macroContext, depth + 1);
    if (node.type === 'Concat') {
      return runtimeConcat(left, right);
    }
    if (node.type === 'Add') {
      return runtimeAdd(left, right);
    }
    const leftNumber = runtimeToNumber(left);
    const rightNumber = runtimeToNumber(right);
    switch (node.type) {
      case 'Sub': return leftNumber - rightNumber;
      case 'Mul': return leftNumber * rightNumber;
      case 'Div': return leftNumber / rightNumber;
      case 'Mod': return leftNumber % rightNumber;
      case 'Pow': return leftNumber ** rightNumber;
      default: throw new Error(`Invalid binary operator ${node.type}`);
    }
  }

  #evaluateComparison(
    node: AstCompareNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): boolean {
    let left = this.#evaluateExpression(node.expr, scope, macroContext, depth + 1);
    let result = false;
    for (const operation of node.ops) {
      const right = this.#evaluateExpression(operation.expr, scope, macroContext, depth + 1);
      result = runtimeCompare(left, operation.operator, right);
      left = result;
    }
    return result;
  }

  #evaluateFilter(
    node: AstCallNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): RuntimeValue {
    const name = symbolName(node.name);
    const builtinName = this.#options.cookiecutterCompat && name === 'jsonify' ? 'dump' : name;
    const hasHostFilter = this.#options.host?.hasFilter?.(name) === true;
    if (!hasHostFilter && !hasBuiltinFilter(builtinName)) {
      throw new Error(`Unknown template filter ${name}`);
    }
    if (hasHostFilter) {
      assertPositionalOnlySyntax(node.args, `Registered filter ${name}`);
    }
    const arguments_ = this.#evaluateArguments(node.args, scope, macroContext, depth + 1);
    const [input, ...positional] = arguments_.positional;
    if (hasHostFilter) {
      assertRuntimeArgumentsHaveNoCallable(arguments_);
      this.#assertScratch([
        input,
        ...positional,
        ...arguments_.keyword.values(),
      ]);
      this.#chargeCapability();
      const hostResult = this.#options.host.filter?.(
        name,
        input,
        Object.freeze({ positional: Object.freeze(positional), keyword: arguments_.keyword }),
      );
      if (hostResult?.found) {
        return hostResult.value;
      }
      throw new Error(`Unknown configured template filter ${name}`);
    }
    const lowered = lowerBuiltinFilterArguments(
      builtinName,
      positional,
      arguments_.keyword,
    );
    const scratchBytes = this.#assertScratch([
      input,
      ...lowered.positional,
      ...lowered.keyword.values(),
    ]);
    return applyBuiltinFilter(
      builtinName,
      input,
      lowered.positional,
      lowered.keyword,
      count => this.#reserveIndexedValues(count, scratchBytes),
    );
  }

  #evaluateTest(
    node: AstBinaryNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): boolean {
    const test = node.right;
    let name: string;
    let argumentsNode: AstNode | undefined;
    if (test.type === 'FunCall') {
      name = symbolName(test.name);
      argumentsNode = test.args;
    } else if (test.type === 'Symbol') {
      name = symbolName(test);
    } else if (test.type === 'Literal') {
      const input = this.#evaluateExpression(node.left, scope, macroContext, depth + 1);
      const expected = this.#evaluateExpression(test, scope, macroContext, depth + 1);
      return runtimeStrictEqual(input, expected);
    } else {
      throw new Error(`Invalid template test ${test.type}`);
    }
    if (!hasBuiltinTest(name)) {
      throw new Error(`Unknown template test ${name}`);
    }
    const expectedArity = builtinTestArity(name);
    if (expectedArity === undefined) {
      throw new Error(`Unknown template test ${name}`);
    }
    if (argumentsNode) {
      assertExactPositionalSyntax(argumentsNode, `Template test ${name}`, expectedArity);
    } else if (expectedArity !== 0) {
      throw new TypeError(`Template test ${name} requires ${expectedArity} positional argument`);
    }
    const input = this.#evaluateExpression(node.left, scope, macroContext, depth + 1);
    const arguments_ = argumentsNode
      ? this.#evaluateArguments(argumentsNode, scope, macroContext, depth + 1)
      : Object.freeze({ positional: Object.freeze([]), keyword: new Map() });
    const builtin = applyBuiltinTest(name, input, arguments_.positional);
    if (builtin === undefined) {
      throw new Error(`Invalid template test ${name}`);
    }
    return builtin;
  }

  #evaluateCallBlock(
    node: AstCallBlockNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    output: OutputTarget,
    depth: number,
  ): void {
    const call = node.call;
    if (call.type !== 'FunCall') {
      throw new Error('Invalid call block');
    }
    const target = this.#evaluateExpression(call.name, scope, macroContext, depth + 1);
    if (!(target instanceof RuntimeCallable) || target.callableKind !== 'macro') {
      throw new Error('Call blocks can target only template macros');
    }
    const ordinaryArguments = this.#evaluateArguments(
      call.args,
      scope,
      macroContext,
      depth + 1,
    );
    const keyword = new Map(ordinaryArguments.keyword);
    keyword.set(
      'caller',
      this.#registerCaller(node.caller, scope, macroContext.invocationScope),
    );
    const arguments_ = Object.freeze({
      positional: ordinaryArguments.positional,
      keyword,
    });
    const value = this.#invokeMacro(target.id, arguments_, depth + 1);
    this.#append(output, renderRuntimeValue(value));
  }

  #evaluateCall(
    node: AstCallNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): RuntimeValue {
    const targetNode = node.name;
    const target = this.#evaluateExpression(targetNode, scope, macroContext, depth + 1);
    const name = diagnosticCallablePath(targetNode);
    if (target instanceof RuntimeCallable) {
      if (target.callableKind === 'macro' || target.callableKind === 'caller') {
        const arguments_ = this.#evaluateArguments(node.args, scope, macroContext, depth + 1);
        return this.#invokeMacro(target.id, arguments_, depth + 1);
      }
      if (target.callableKind === 'builtin') {
        this.#assertBuiltinArgumentSyntax(target.id, node.args);
        const arguments_ = this.#evaluateArguments(node.args, scope, macroContext, depth + 1);
        assertRuntimeArgumentsHaveNoCallable(arguments_);
        return this.#invokeBuiltinCallable(target.id, arguments_);
      }
      if (target.callableKind === 'capability') {
        const capabilityName = this.#capabilityNames.get(target.id);
        if (!capabilityName || !this.#options.host?.global) {
          throw new Error('Unknown template capability');
        }
        assertPositionalOnlySyntax(node.args, `Registered global ${capabilityName}`);
        const arguments_ = this.#evaluateArguments(node.args, scope, macroContext, depth + 1);
        assertRuntimeArgumentsHaveNoCallable(arguments_);
        this.#chargeCapability();
        const result = this.#options.host.global(capabilityName, arguments_);
        if (result.found) {
          return result.value;
        }
        throw new Error('Unknown template capability');
      }
    }
    throw new Error(`Unable to call template value${name ? ` ${name}` : ''}`);
  }

  #evaluateArguments(
    node: AstNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): RuntimeArguments {
    const positional: RuntimeValue[] = [];
    const keyword = new Map<string, RuntimeValue>();
    if (node.type !== 'NodeList') {
      throw new Error('Invalid argument list');
    }
    for (const child of node.children) {
      if (child.type === 'KeywordArgs') {
        for (const pair of child.children) {
          if (pair.type !== 'Pair') {
            throw new Error('Invalid keyword argument');
          }
          const keyNode = pair.key;
          const name = keyNode.type === 'Symbol'
            ? symbolName(keyNode)
            : runtimeToPropertyKey(
              this.#evaluateExpression(keyNode, scope, macroContext, depth + 1),
            );
          if (isReservedName(name)) {
            throw new Error(`Template name ${name} is reserved`);
          }
          keyword.set(
            name,
            this.#evaluateExpression(pair.value, scope, macroContext, depth + 1),
          );
        }
      } else {
        positional.push(this.#evaluateExpression(child, scope, macroContext, depth + 1));
      }
    }
    return Object.freeze({ positional: Object.freeze(positional), keyword });
  }

  #registerGlobal(name: string): RuntimeCallable {
    const existing = this.#capabilityHandles.get(name);
    if (existing) {
      return existing;
    }
    const id = this.#nextCallableId++;
    this.#capabilityNames.set(id, name);
    const handle = new RuntimeCallable('capability', id);
    this.#capabilityHandles.set(name, handle);
    return handle;
  }

  #registerBuiltinGlobal(name: string): RuntimeCallable | undefined {
    if (name !== 'range' && name !== 'cycler' && name !== 'joiner') {
      return undefined;
    }
    const existing = this.#builtinGlobalHandles.get(name);
    if (existing) {
      return existing;
    }
    const id = this.#nextCallableId++;
    this.#builtinCallables.set(id, { type: 'global', name });
    const handle = new RuntimeCallable('builtin', id);
    this.#builtinGlobalHandles.set(name, handle);
    return handle;
  }

  #registerCaller(
    node: AstCallableBodyNode,
    scope: RuntimeScope,
    invocationScope: RuntimeScope,
  ): RuntimeCallable {
    const id = this.#nextCallableId++;
    this.#macros.set(id, { node, scope, invocationScope });
    return new RuntimeCallable('caller', id);
  }

  #invokeMacro(
    id: number,
    arguments_: RuntimeArguments,
    depth: number,
  ): RuntimeValue {
    const definition = this.#macros.get(id);
    if (!definition) {
      throw new Error('Unknown template macro');
    }
    const local = definition.scope.child(true);
    const bodyMacroContext = definition.node.type === 'Caller'
      ? createMacroBindingContext(local, definition.invocationScope)
      : createMacroBindingContext(
        definition.invocationScope,
        definition.invocationScope,
      );
    const args = definition.node.args;
    if (args.type !== 'NodeList') {
      throw new Error('Invalid macro arguments');
    }
    const argumentNodes = args.children;
    let formalIndex = 0;
    let declaresCaller = false;
    const boundNames = new Set<string>();
    for (const argument of argumentNodes) {
      if (argument.type === 'KeywordArgs') {
        for (const pair of argument.children) {
          if (pair.type !== 'Pair') {
            throw new Error('Invalid macro default');
          }
          const name = symbolName(pair.key);
          declaresCaller ||= name === 'caller';
          let supplied: RuntimeValue = undefined;
          let hasSupplied = false;
          if (formalIndex < arguments_.positional.length) {
            supplied = arguments_.positional[formalIndex];
            hasSupplied = true;
          } else if (arguments_.keyword.has(name)) {
            supplied = arguments_.keyword.get(name);
            hasSupplied = true;
          }
          const value = hasSupplied
            ? supplied
            : this.#evaluateExpression(
              pair.value,
              local,
              bodyMacroContext,
              depth + 1,
            );
          if (!boundNames.has(name)) {
            local.set(name, value);
            boundNames.add(name);
          }
          formalIndex += 1;
        }
      } else {
        const name = symbolName(argument);
        declaresCaller ||= name === 'caller';
        let supplied: RuntimeValue = undefined;
        if (formalIndex < arguments_.positional.length) {
          supplied = arguments_.positional[formalIndex];
        } else if (arguments_.keyword.has(name)) {
          supplied = arguments_.keyword.get(name);
        }
        if (!boundNames.has(name)) {
          local.set(name, supplied);
          boundNames.add(name);
        }
        formalIndex += 1;
      }
    }
    if (!declaresCaller && arguments_.keyword.has('caller')) {
      local.set('caller', arguments_.keyword.get('caller'));
    }
    return this.#capture(
      definition.node.body,
      local,
      bodyMacroContext,
      depth + 1,
      true,
    );
  }

  #invokeBuiltinGlobal(name: BuiltinGlobalName, arguments_: RuntimeArguments): RuntimeValue {
    assertRuntimeArgumentsHaveNoCallable(arguments_);
    if (name === 'range') {
      let start = arguments_.positional[0];
      let stop = arguments_.positional[1];
      let step = arguments_.positional[2];
      if (stop === undefined) {
        stop = start;
        start = 0;
        step = 1;
      } else if (!runtimeTruthy(step)) {
        step = 1;
      }
      const output: RuntimeValue[] = [];
      if (runtimeOrder(step, 0) > 0) {
        for (let value = start; runtimeOrder(value, stop) < 0; value = runtimeAdd(value, step)) {
          output.push(value);
          this.#charge(0);
        }
      } else {
        for (let value = start; runtimeOrder(value, stop) > 0; value = runtimeAdd(value, step)) {
          output.push(value);
          this.#charge(0);
        }
      }
      return new RuntimeArray(output);
    }
    if (name === 'cycler') {
      const id = this.#nextCallableId++;
      this.#builtinCallables.set(id, {
        type: 'cycler',
        values: Object.freeze(Array.from(arguments_.positional)),
        index: -1,
      });
      return new RuntimeCallable('builtin', id);
    }
    const id = this.#nextCallableId++;
    const separatorValue = arguments_.positional[0];
    if (runtimeTruthy(separatorValue)) {
      assertRuntimeValueHasNoCallable(separatorValue);
    }
    this.#builtinCallables.set(id, {
      type: 'joiner',
      separator: runtimeTruthy(separatorValue) ? separatorValue : ',',
      used: false,
    });
    return new RuntimeCallable('builtin', id);
  }

  #lookupBuiltinCallable(id: number, key: string): RuntimeValue {
    const definition = this.#builtinCallables.get(id);
    if (!definition || definition.type !== 'cycler') {
      return undefined;
    }
    if (key === 'current') {
      return definition.index < 0
        ? null
        : freshMemberCallable(definition.values[definition.index]);
    }
    if (key !== 'next' && key !== 'reset') {
      return undefined;
    }
    const methodId = this.#nextCallableId++;
    this.#builtinCallables.set(methodId, { type: 'cycler-method', owner: id, method: key });
    return new RuntimeCallable('builtin', methodId);
  }

  #invokeBuiltinCallable(id: number, arguments_: RuntimeArguments): RuntimeValue {
    assertRuntimeArgumentsHaveNoCallable(arguments_);
    const definition = this.#builtinCallables.get(id);
    if (!definition) {
      throw new Error('Unknown interpreter builtin callable');
    }
    if (definition.type === 'global') {
      return this.#invokeBuiltinGlobal(definition.name, arguments_);
    }
    if (definition.type === 'joiner') {
      if (!definition.used) {
        definition.used = true;
        return '';
      }
      return definition.separator;
    }
    if (definition.type === 'cycler-method') {
      const owner = this.#builtinCallables.get(definition.owner);
      if (!owner || owner.type !== 'cycler') {
        throw new Error('Unknown interpreter cycler');
      }
      if (definition.method === 'reset') {
        owner.index = -1;
        return undefined;
      }
      if (owner.values.length === 0) {
        return undefined;
      }
      owner.index = (owner.index + 1) % owner.values.length;
      return owner.values[owner.index];
    }
    throw new Error('Interpreter builtin object is not directly callable');
  }

  #assertBuiltinArgumentSyntax(id: number, node: AstNode): void {
    const definition = this.#builtinCallables.get(id);
    if (!definition) {
      throw new Error('Unknown interpreter builtin callable');
    }
    if (definition.type === 'global') {
      assertPositionalOnlySyntax(node, `Built-in global ${definition.name}`);
      if (definition.name === 'range') {
        assertMaximumPositionalSyntax(node, 'Built-in global range', 3);
      } else if (definition.name === 'joiner') {
        assertMaximumPositionalSyntax(node, 'Built-in global joiner', 1);
      }
      return;
    }
    if (definition.type === 'joiner') {
      assertExactPositionalSyntax(node, 'Joiner instance', 0);
      return;
    }
    if (definition.type === 'cycler-method') {
      assertExactPositionalSyntax(node, `Cycler ${definition.method}`, 0);
      return;
    }
    throw new Error('Interpreter builtin object is not directly callable');
  }

  #capture(
    node: AstNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
    safe: boolean,
  ): RuntimeValue {
    const chunks: string[] = [];
    this.#evaluateNode(node, scope, macroContext, chunks, depth + 1);
    const value = chunks.join('');
    return safe ? new RuntimeSafeString(value) : value;
  }

  #append(output: OutputTarget, value: string): void {
    this.#outputCodeUnits += value.length;
    if (
      this.#options.limits.outputCodeUnits !== Number.POSITIVE_INFINITY &&
      this.#outputCodeUnits > this.#options.limits.outputCodeUnits
    ) {
      throw new NunjitsuLimitError('outputCodeUnits');
    }
    output.push(value);
  }

  #charge(depth: number): void {
    if (
      this.#options.limits.nestingDepth !== Number.POSITIVE_INFINITY &&
      depth > this.#options.limits.nestingDepth
    ) {
      throw new NunjitsuLimitError('nestingDepth');
    }
    this.#workUnits += 1;
    if (
      this.#options.limits.workUnits !== Number.POSITIVE_INFINITY &&
      this.#workUnits > this.#options.limits.workUnits
    ) {
      throw new NunjitsuLimitError('workUnits');
    }
  }

  #chargeCapability(): void {
    this.#capabilityCalls += 1;
    if (
      this.#options.limits.capabilityCalls !== Number.POSITIVE_INFINITY &&
      this.#capabilityCalls > this.#options.limits.capabilityCalls
    ) {
      throw new NunjitsuLimitError('capabilityCalls');
    }
  }

  #assertScratch(values: Iterable<RuntimeValue>): number {
    if (this.#options.limits.scratchBytes === Number.POSITIVE_INFINITY) {
      return 0;
    }
    let bytes = 0;
    for (const value of values) {
      bytes += runtimeValueBytes(value);
      if (bytes > this.#options.limits.scratchBytes) {
        throw new NunjitsuLimitError('scratchBytes');
      }
    }
    return bytes;
  }

  #reserveIndexedValues(count: number, existingScratchBytes: number): void {
    const workLimit = this.#options.limits.workUnits;
    if (
      workLimit !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(count) || count > workLimit - this.#workUnits)
    ) {
      throw new NunjitsuLimitError('workUnits');
    }
    const scratchLimit = this.#options.limits.scratchBytes;
    if (
      scratchLimit !== Number.POSITIVE_INFINITY &&
      (
        !Number.isSafeInteger(count) ||
        count > Math.floor(
          (scratchLimit - existingScratchBytes) / indexedValueScratchBytes,
        )
      )
    ) {
      throw new NunjitsuLimitError('scratchBytes');
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Array-like record length exceeds the supported range');
    }
    this.#workUnits += count;
  }
}

function symbolName(node: AstNode): string {
  if (node.type !== 'Symbol') {
    throw new Error(`Expected symbol, received ${node.type}`);
  }
  const name = node.value;
  if (typeof name !== 'string' || isReservedName(name)) {
    throw new Error('Invalid or reserved template symbol');
  }
  return name;
}

function diagnosticCallablePath(node: AstNode): string | undefined {
  if (node.type === 'Symbol') {
    return symbolName(node);
  }
  if (node.type !== 'LookupVal') {
    return undefined;
  }
  const parent = diagnosticCallablePath(node.target);
  const key = node.val;
  const value = key.type === 'Literal' || key.type === 'Symbol' ? key.value : undefined;
  if (!parent || typeof value !== 'string') {
    return undefined;
  }
  return `${parent}.${value}`;
}

function literalString(node: AstNode): string {
  if (node.type !== 'TemplateData') {
    throw new Error('Invalid template text node');
  }
  return node.value;
}

function isRegexLiteral(value: AstData): value is AstRegexLiteral {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'type' in value &&
    value.type === 'regex-literal',
  );
}

function constantLookupKey(node: AstNode): (
  | { readonly found: false }
  | {
    readonly found: true;
    readonly value: undefined | null | boolean | number | string;
  }
) {
  if (node.type !== 'Literal') {
    return { found: false };
  }
  const value = node.value;
  if (
    value === undefined ||
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return { found: true, value };
  }
  return { found: false };
}

function isStringValue(value: RuntimeValue): boolean {
  return typeof value === 'string' || value instanceof RuntimeSafeString;
}

function freshMemberCallable(value: RuntimeValue): RuntimeValue {
  return value instanceof RuntimeCallable
    ? new RuntimeCallable(value.callableKind, value.id)
    : value;
}

function bindLoopTargets(
  targets: readonly AstNode[],
  value: RuntimeValue,
  scope: RuntimeScope,
): void {
  if (targets.length === 1) {
    scope.set(symbolName(targets[0]!), value);
    return;
  }
  for (const [index, target] of targets.entries()) {
    scope.set(symbolName(target), destructureRuntimeValue(value, index));
  }
}

function bindAssignment(target: AstNode, value: RuntimeValue, scope: RuntimeScope): void {
  if (target.type !== 'Symbol') {
    throw new Error(`Invalid assignment target ${target.type}`);
  }
  scope.assign(symbolName(target), value);
}

function iterableEntries(value: RuntimeValue, targetCount: number): RuntimeIteration {
  if (targetCount === 1) {
    if (value instanceof RuntimeArray) {
      return { length: value.length, values: value.values() };
    }
    if (value instanceof RuntimeRecord) {
      const length = value.get('length');
      return { length, values: recordIndexValues(value, length) };
    }
    if (typeof value === 'string' || value instanceof RuntimeSafeString) {
      const text = typeof value === 'string' ? value : value.value;
      return { length: text.length, values: stringCodeUnits(text) };
    }
    return { length: undefined, values: emptyRuntimeValues() };
  }
  if (value instanceof RuntimeArray) {
    return { length: value.length, values: value.values() };
  }
  if (value instanceof RuntimeRecord) {
    return { length: value.size, values: recordIterationValues(value) };
  }
  if (typeof value === 'string') {
    return { length: value.length, values: indexedStringIterationValues(value) };
  }
  if (value instanceof RuntimeSafeString) {
    return { length: value.value.length, values: stringCodeUnits(value.value) };
  }
  return { length: 0, values: emptyRuntimeValues() };
}

function destructureRuntimeValue(value: RuntimeValue, index: number): RuntimeValue {
  if (value === undefined || value === null) {
    throw new TypeError('Cannot destructure a nullish loop value');
  }
  if (value instanceof RuntimeArray) {
    return value.at(index);
  }
  if (value instanceof RuntimeRecord) {
    return value.get(`${index}`);
  }
  if (typeof value === 'string') {
    return value[index];
  }
  return undefined;
}

function* recordIndexValues(
  value: RuntimeRecord,
  length: RuntimeValue,
): IterableIterator<RuntimeValue> {
  const numericLength = runtimeToNumber(length);
  for (let index = 0; index < numericLength; index += 1) {
    yield value.get(`${index}`);
  }
}

function* recordIterationValues(value: RuntimeRecord): IterableIterator<RuntimeValue> {
  for (const [key, item] of value.entries()) {
    yield new RuntimeArray([key, item]);
  }
}

function* indexedStringIterationValues(value: string): IterableIterator<RuntimeValue> {
  for (let index = 0; index < value.length; index += 1) {
    yield new RuntimeArray([`${index}`, value[index]]);
  }
}

function* emptyRuntimeValues(): IterableIterator<RuntimeValue> {}

function runtimeCompare(left: RuntimeValue, operator: string, right: RuntimeValue): boolean {
  switch (operator) {
    case '==': return runtimeLooseEqual(left, right);
    case '===': return runtimeStrictEqual(left, right);
    case '!=': return !runtimeLooseEqual(left, right);
    case '!==': return !runtimeStrictEqual(left, right);
    case '<': return runtimeOrder(left, right) < 0;
    case '<=': return runtimeOrder(left, right) <= 0;
    case '>': return runtimeOrder(left, right) > 0;
    case '>=': return runtimeOrder(left, right) >= 0;
    default: throw new Error(`Unsupported comparison operator ${operator}`);
  }
}

function assertRuntimeArgumentsHaveNoCallable(arguments_: RuntimeArguments): void {
  for (const value of arguments_.positional) {
    assertRuntimeValueHasNoCallable(value);
  }
  for (const value of arguments_.keyword.values()) {
    assertRuntimeValueHasNoCallable(value);
  }
}

function assertPositionalOnlySyntax(node: AstNode, operation: string): void {
  const syntax = argumentSyntax(node);
  if (syntax.keywordCount > 0) {
    throw new TypeError(`${operation} does not accept keyword arguments`);
  }
}

function assertExactPositionalSyntax(
  node: AstNode,
  operation: string,
  expected: number,
): void {
  assertPositionalOnlySyntax(node, operation);
  const actual = argumentSyntax(node).positionalCount;
  if (actual !== expected) {
    throw new TypeError(
      `${operation} requires ${expected} positional argument${expected === 1 ? '' : 's'}`,
    );
  }
}

function assertMaximumPositionalSyntax(
  node: AstNode,
  operation: string,
  maximum: number,
): void {
  const actual = argumentSyntax(node).positionalCount;
  if (actual > maximum) {
    throw new TypeError(
      `${operation} accepts at most ${maximum} positional argument${maximum === 1 ? '' : 's'}`,
    );
  }
}

function argumentSyntax(
  node: AstNode,
): { readonly positionalCount: number; readonly keywordCount: number } {
  if (node.type !== 'NodeList') {
    throw new Error('Invalid argument list');
  }
  let positionalCount = 0;
  let keywordCount = 0;
  for (const child of node.children) {
    if (child.type === 'KeywordArgs') {
      keywordCount += child.children.length;
    } else {
      positionalCount += 1;
    }
  }
  return { positionalCount, keywordCount };
}

function runtimeContains(container: RuntimeValue, needle: RuntimeValue): boolean {
  if (isStringValue(container)) {
    return renderRuntimeValue(container).includes(runtimeToString(needle));
  }
  if (container instanceof RuntimeArray) {
    for (const value of container.values()) {
      if (runtimeStrictEqual(value, needle)) {
        return true;
      }
    }
    return false;
  }
  if (container instanceof RuntimeRecord) {
    return container.has(runtimeToPropertyKey(needle));
  }
  throw new Error('Membership requires an array, record, or string');
}

function runtimeValueBytes(value: RuntimeValue): number {
  if (value instanceof RuntimeArray) {
    let bytes = 0;
    for (const item of value.values()) {
      bytes += runtimeValueBytes(item);
    }
    return bytes;
  }
  if (value instanceof RuntimeRecord) {
    let bytes = 0;
    for (const [key, item] of value.entries()) {
      bytes += Buffer.byteLength(key) + runtimeValueBytes(item);
    }
    return bytes;
  }
  return Buffer.byteLength(renderRuntimeValue(value));
}

function validateUniqueBlocks(ast: AstNode): void {
  const blocks = new Set<string>();
  visitAst(ast, node => {
    if (node.type === 'Block') {
      const name = symbolName(node.name);
      if (blocks.has(name)) {
        throw new Error(`Template defines block ${name} more than once`);
      }
      blocks.add(name);
    }
  });
}

function createMacroBindingContext(
  bindingScope: RuntimeScope,
  invocationScope: RuntimeScope,
): MacroBindingContext {
  return Object.freeze({ bindingScope, invocationScope });
}

function visitAst(node: AstNode, visitor: (node: AstNode) => void): void {
  visitor(node);
  for (const child of astChildren(node)) {
    visitAst(child, visitor);
  }
}

function astChildren(node: AstNode): readonly AstNode[] {
  switch (node.type) {
    case 'Root':
    case 'NodeList':
    case 'Output':
    case 'Group':
    case 'Array':
    case 'Dict':
    case 'KeywordArgs':
      return node.children;
    case 'Pair':
      return [node.key, node.value];
    case 'LookupVal':
      return [node.target, node.val];
    case 'Slice':
      return [node.start, node.stop, node.step];
    case 'If':
    case 'InlineIf':
      return node.else_ ? [node.cond, node.body, node.else_] : [node.cond, node.body];
    case 'For':
      return node.else_ ? [node.arr, node.name, node.body, node.else_] : [node.arr, node.name, node.body];
    case 'Macro':
    case 'Caller':
      return [node.name, node.args, node.body];
    case 'FunCall':
    case 'Filter':
      return [node.name, node.args];
    case 'CallBlock':
      return [node.call, node.caller];
    case 'Block':
      return [node.name, node.body];
    case 'Set': {
      const children = Array.from(node.targets);
      if (node.value) {
        children.push(node.value);
      }
      if (node.body) {
        children.push(node.body);
      }
      return children;
    }
    case 'Switch':
      return node.default ? [node.expr, ...node.cases, node.default] : [node.expr, ...node.cases];
    case 'Case':
      return [node.cond, node.body];
    case 'Capture':
      return [node.body];
    case 'In':
    case 'Is':
    case 'Or':
    case 'And':
    case 'Add':
    case 'Concat':
    case 'Sub':
    case 'Mul':
    case 'Div':
    case 'Mod':
    case 'Pow':
      return [node.left, node.right];
    case 'Not':
    case 'Neg':
    case 'Pos':
    case 'Floor':
      return [node.target];
    case 'Compare':
      return [node.expr, ...node.ops];
    case 'CompareOperand':
      return [node.expr];
    case 'TemplateData':
    case 'Literal':
    case 'Symbol':
      return [];
  }
}
