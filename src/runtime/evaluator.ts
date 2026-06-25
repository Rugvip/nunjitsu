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
import {
  formatDiagnosticValue,
  suggestDiagnosticName,
} from '../diagnostics.ts';
import { parseTemplate } from '../parser/index.ts';
import type { NormalizedTemplateRenderLimits } from '../limits.ts';
import {
  TemplateLimitError,
  withTemplateLimitErrorContext,
} from '../limits.ts';
import type { TemplateContext } from '../values.ts';
import { normalizeMacroArguments } from './arguments.ts';
import {
  applyBuiltinFilter,
  applyBuiltinTest,
  builtinTestArity,
  hasBuiltinFilter,
  hasBuiltinTest,
  listBuiltinFilterNames,
  listBuiltinTestNames,
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
import {
  CompiledFramePlan,
  LexicalScopePlan,
  LexicalSlotPlan,
  planLexicalSlots,
  RuntimeLexicalFrame,
} from './lexicalSlots.ts';
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
  type RuntimeWorkCharge,
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
  /** Returns configured filter spellings for bounded typo diagnostics. */
  filterNames?(): readonly string[];
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
  readonly limits: NormalizedTemplateRenderLimits;
  readonly host?: RuntimeHost;
}

type OutputTarget = string[];
// Covers temporary and immutable reference slots produced by indexed filters.
const indexedValueScratchBytes = 32;

interface MacroDefinition {
  readonly node: AstCallableBodyNode;
  readonly framePlan: CompiledFramePlan;
  readonly scope: RuntimeScope;
  readonly lexicalFrame?: RuntimeLexicalFrame;
  readonly invocationScope: RuntimeScope;
}

interface MacroBindingContext {
  readonly lexicalFrame: RuntimeLexicalFrame;
  readonly lexicalPlan: LexicalScopePlan;
  readonly invocationScope: RuntimeScope;
  readonly exportsMacros: boolean;
  readonly exportsAssignments: boolean;
}

/** One non-materializing view over values accepted by a template loop. */
interface RuntimeIteration {
  readonly compilerBranch: 'array' | 'record';
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
    throw new TemplateLimitError('sourceCodeUnits', {
      phase: 'parse',
      configured: options.limits.sourceCodeUnits,
      observed: source.length,
    });
  }
  const ast = parseTemplate(source, {
    trimBlocks: options.trimBlocks,
    lstripBlocks: options.lstripBlocks,
    cookiecutterCompat: options.cookiecutterCompat,
    astNodes: options.limits.astNodes,
    nestingDepth: options.limits.nestingDepth,
  });
  let lexicalSlots: LexicalSlotPlan;
  try {
    lexicalSlots = planLexicalSlots(ast, options.limits.workUnits);
  } catch (error) {
    if (error instanceof TemplateLimitError) {
      throw withTemplateLimitErrorContext(
        error,
        'evaluate',
        ast.line + 1,
        ast.column + 1,
      );
    }
    throw error;
  }
  return new Evaluator(options, lexicalSlots).render(ast, context);
}

class Evaluator {
  readonly #options: EvaluateOptions;
  readonly #lexicalSlots: LexicalSlotPlan;
  readonly #macros = new Map<number, MacroDefinition>();
  readonly #builtinCallables = new Map<number, BuiltinCallableDefinition>();
  readonly #capabilityNames = new Map<number, string>();
  readonly #capabilityHandles = new Map<string, RuntimeCallable>();
  readonly #builtinGlobalHandles = new Map<BuiltinGlobalName, RuntimeCallable>();
  readonly #chargeExpansionWork: RuntimeWorkCharge = () => {
    this.#charge(0);
  };
  #nextCallableId = 1;
  #workUnits = 0;
  #outputCodeUnits = 0;
  #capabilityCalls = 0;

  constructor(options: EvaluateOptions, lexicalSlots: LexicalSlotPlan) {
    this.#options = options;
    this.#lexicalSlots = lexicalSlots;
  }

  render(
    ast: AstNode,
    context: RuntimeRecord,
  ): string {
    const contextScope = new RuntimeScope();
    for (const [name, value] of context.entries()) {
      contextScope.setReadonly(name, value);
    }
    const exportScope = contextScope.child(true);
    const scope = exportScope.child(true);
    const rootFrame = this.#lexicalSlots.rootFrame();
    const macroContext = createMacroBindingContext(
      new RuntimeLexicalFrame(rootFrame.slots),
      rootFrame.scope,
      exportScope,
      true,
      true,
    );
    const output: OutputTarget = [];
    try {
      this.#renderTemplate(ast, scope, macroContext, output, 0);
      return output.join('');
    } catch (error) {
      if (error instanceof TemplateLimitError) {
        throw withTemplateLimitErrorContext(
          error,
          'evaluate',
          ast.line + 1,
          ast.column + 1,
        );
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
      if (error instanceof TemplateLimitError) {
        throw withTemplateLimitErrorContext(
          error,
          'evaluate',
          node.line + 1,
          node.column + 1,
        );
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
            this.#append(output, renderRuntimeValue(value, this.#chargeExpansionWork));
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
          framePlan: macroContext.lexicalPlan.callableFrame(node),
          scope: macroContext.invocationScope,
          invocationScope: macroContext.invocationScope,
        });
        const handle = new RuntimeCallable('macro', id);
        const slot = macroContext.lexicalPlan.slot(node);
        if (slot === undefined) {
          throw new Error(`Missing lexical slot for macro ${name}`);
        }
        macroContext.lexicalFrame.set(slot, handle);
        if (macroContext.exportsMacros) {
          macroContext.invocationScope.set(name, handle);
        }
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
    const blockScope = scope.child(true);
    const blockFrame = macroContext.lexicalPlan.blockFrame(node);
    const blockMacroContext = createMacroBindingContext(
      new RuntimeLexicalFrame(blockFrame.slots),
      blockFrame.scope,
      macroContext.invocationScope,
      true,
      false,
    );
    this.#evaluateNode(
      node.body,
      blockScope,
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
    const entries = iterableEntries(value, targets.length, this.#chargeExpansionWork);
    const loopScope = scope.child();
    const loopPlan = macroContext.lexicalPlan.loop(node);
    const bodyPlan = loopPlan.body(
      targets.length,
      entries.compilerBranch === 'array',
    );
    const loopMacroContext = createMacroBindingContext(
      macroContext.lexicalFrame,
      bodyPlan,
      macroContext.invocationScope,
      false,
      false,
    );
    let loopLength = macroContext.lexicalFrame.get(loopPlan.lengthSlot);
    if (runtimeTruthy(value)) {
      loopLength = entries.length;
      macroContext.lexicalFrame.set(loopPlan.lengthSlot, loopLength);
    }
    let index = 0;
    for (const entry of entries.values) {
      const iteration = loopScope;
      bindLoopTargets(
        targets,
        entry,
        entries.compilerBranch,
        iteration,
        loopMacroContext.lexicalFrame,
        loopMacroContext.lexicalPlan,
      );
      const numericLength = runtimeToNumber(loopLength, this.#chargeExpansionWork);
      bindRuntimeFrameLocal('loop', new RuntimeRecord([
        ['index', index + 1],
        ['index0', index],
        ['revindex', numericLength - index],
        ['revindex0', numericLength - index - 1],
        ['first', index === 0],
        ['last', index === numericLength - 1],
        ['length', loopLength],
      ]), iteration);
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
    if (!runtimeTruthy(loopLength) && otherwise) {
      const otherwiseMacroContext = createMacroBindingContext(
        macroContext.lexicalFrame,
        loopPlan.otherwise(targets.length),
        macroContext.invocationScope,
        false,
        false,
      );
      this.#evaluateNode(
        otherwise,
        loopScope,
        otherwiseMacroContext,
        output,
        depth + 1,
      );
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
      bindLexicalAssignment(
        targets[0]!,
        value,
        macroContext.lexicalFrame,
        macroContext.lexicalPlan,
      );
      this.#exportAssignment(targets[0]!, value, macroContext);
      return;
    }
    for (const target of targets) {
      bindAssignment(target, value, scope);
      bindLexicalAssignment(
        target,
        value,
        macroContext.lexicalFrame,
        macroContext.lexicalPlan,
      );
      this.#exportAssignment(target, value, macroContext);
    }
  }

  #exportAssignment(
    target: AstNode,
    value: RuntimeValue,
    macroContext: MacroBindingContext,
  ): void {
    if (macroContext.exportsAssignments) {
      macroContext.invocationScope.set(symbolName(target), value);
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
      if (error instanceof TemplateLimitError) {
        throw withTemplateLimitErrorContext(
          error,
          'evaluate',
          node.line + 1,
          node.column + 1,
        );
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
        const slot = macroContext.lexicalPlan.slot(node);
        if (slot !== undefined) {
          return macroContext.lexicalFrame.get(slot);
        }
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
              this.#chargeExpansionWork,
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
          return this.#lookupBuiltinCallable(
            target.id,
            runtimeToPropertyKey(key, this.#chargeExpansionWork),
          );
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
          this.#chargeExpansionWork,
        );
      case 'Pos':
        return runtimeToNumber(
          this.#evaluateExpression(node.target, scope, macroContext, depth + 1),
          this.#chargeExpansionWork,
        );
      case 'Floor':
        return Math.floor(runtimeToNumber(
          this.#evaluateExpression(node.target, scope, macroContext, depth + 1),
          this.#chargeExpansionWork,
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
        return runtimeContains(container, needle, this.#chargeExpansionWork);
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
        return this.#registerCaller(
          node,
          macroContext.lexicalPlan.callableFrame(node),
          scope,
          macroContext.lexicalFrame,
          macroContext.invocationScope,
        );
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
    const numericStep = runtimeToNumber(step, this.#chargeExpansionWork);
    if (!Number.isFinite(numericStep) || numericStep === 0) {
      throw new Error('Slice step must have finite non-zero numeric coercion');
    }
    const stepOrder = runtimeOrder(step, 0, this.#chargeExpansionWork);
    if (start === null) {
      start = stepOrder < 0
        ? runtimeToNumber(length, this.#chargeExpansionWork) - 1
        : 0;
    }
    if (stop === null) {
      stop = stepOrder < 0 ? -1 : length;
    } else if (runtimeOrder(stop, 0, this.#chargeExpansionWork) < 0) {
      stop = runtimeAdd(stop, length, this.#chargeExpansionWork);
    }
    if (runtimeOrder(start, 0, this.#chargeExpansionWork) < 0) {
      start = runtimeAdd(start, length, this.#chargeExpansionWork);
    }
    const output: RuntimeValue[] = [];
    let scratchBytes = 0;
    for (let index = start; ; index = runtimeAdd(index, step, this.#chargeExpansionWork)) {
      if (
        runtimeOrder(index, 0, this.#chargeExpansionWork) < 0 ||
        runtimeOrder(index, length, this.#chargeExpansionWork) > 0
      ) {
        break;
      }
      if (
        (stepOrder > 0 && runtimeOrder(index, stop, this.#chargeExpansionWork) >= 0) ||
        (stepOrder < 0 && runtimeOrder(index, stop, this.#chargeExpansionWork) <= 0)
      ) {
        break;
      }
      this.#charge(depth);
      const value = lookupRuntimeValue(target, index);
      assertRuntimeValueHasNoCallable(value);
      if (this.#options.limits.scratchBytes !== Number.POSITIVE_INFINITY) {
        scratchBytes += indexedValueScratchBytes + runtimeValueBytes(
          value,
          this.#chargeExpansionWork,
        );
        if (scratchBytes > this.#options.limits.scratchBytes) {
          throw new TemplateLimitError('scratchBytes', {
            phase: 'evaluate',
            configured: this.#options.limits.scratchBytes,
            observed: scratchBytes,
          });
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
      return runtimeConcat(left, right, this.#chargeExpansionWork);
    }
    if (node.type === 'Add') {
      return runtimeAdd(left, right, this.#chargeExpansionWork);
    }
    const leftNumber = runtimeToNumber(left, this.#chargeExpansionWork);
    const rightNumber = runtimeToNumber(right, this.#chargeExpansionWork);
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
      result = runtimeCompare(
        left,
        operation.operator,
        right,
        this.#chargeExpansionWork,
      );
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
      const configuredNames = this.#options.host?.filterNames?.() ?? [];
      const candidates = diagnosticFilterNames(
        this.#options.cookiecutterCompat,
        configuredNames,
      );
      throw new Error(unknownRuntimeName('template filter', name, candidates));
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
      ...lowered.scratch,
    ]);
    try {
      return applyBuiltinFilter(
        builtinName,
        input,
        lowered.positional,
        lowered.keyword,
        count => this.#reserveIndexedValues(count, scratchBytes),
      );
    } catch (error) {
      throw contextualizeRuntimeFailure(
        error,
        `Filter ${formatDiagnosticValue(builtinName)} failed for ` +
          `${runtimeValueKind(input)} input`,
        node.name.line,
        node.name.column,
      );
    }
  }

  #evaluateTest(
    node: AstBinaryNode,
    scope: RuntimeScope,
    macroContext: MacroBindingContext,
    depth: number,
  ): boolean {
    const { name, argumentsNode } = staticTestInvocation(node.right);
    if (isReservedName(name)) {
      throw new Error(`Template test ${name} is reserved`);
    }
    if (!hasBuiltinTest(name)) {
      throw new Error(unknownRuntimeName('template test', name, listBuiltinTestNames()));
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
    this.#chargeExpandedValues([input, ...arguments_.positional]);
    let builtin: boolean | undefined;
    try {
      builtin = applyBuiltinTest(name, input, arguments_.positional);
    } catch (error) {
      throw contextualizeRuntimeFailure(
        error,
        `Test ${formatDiagnosticValue(name)} failed for ${runtimeValueKind(input)} input`,
        node.right.line,
        node.right.column,
      );
    }
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
      this.#registerCaller(
        node.caller,
        macroContext.lexicalPlan.callableFrame(node.caller),
        scope,
        macroContext.lexicalFrame,
        macroContext.invocationScope,
      ),
    );
    const arguments_ = Object.freeze({
      positional: ordinaryArguments.positional,
      keyword,
    });
    const value = this.#invokeMacro(target.id, arguments_, depth + 1);
    this.#append(output, renderRuntimeValue(value, this.#chargeExpansionWork));
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
    if (name) {
      throw new Error(
        `Template value ${formatDiagnosticValue(name)} resolved to ` +
          `${runtimeValueKind(target)} and cannot be called`,
      );
    }
    throw new Error(
      `Template expression resolved to ${runtimeValueKind(target)} and cannot be called`,
    );
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
              this.#chargeExpansionWork,
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
    framePlan: CompiledFramePlan,
    scope: RuntimeScope,
    lexicalFrame: RuntimeLexicalFrame,
    invocationScope: RuntimeScope,
  ): RuntimeCallable {
    const id = this.#nextCallableId++;
    this.#macros.set(id, {
      node,
      framePlan,
      scope,
      lexicalFrame,
      invocationScope,
    });
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
      ? createMacroBindingContext(
        new RuntimeLexicalFrame(
          definition.framePlan.slots,
          definition.lexicalFrame,
        ),
        definition.framePlan.scope,
        definition.invocationScope,
        false,
        false,
      )
      : createMacroBindingContext(
        new RuntimeLexicalFrame(definition.framePlan.slots),
        definition.framePlan.scope,
        definition.invocationScope,
        true,
        false,
      );
    const args = definition.node.args;
    if (args.type !== 'NodeList') {
      throw new Error('Invalid macro arguments');
    }
    const argumentNodes = args.children;
    const positionalNames: string[] = [];
    const defaultNames: string[] = [];
    let declaresCaller = false;
    for (const argument of argumentNodes) {
      if (argument.type === 'KeywordArgs') {
        for (const pair of argument.children) {
          if (pair.type !== 'Pair') {
            throw new Error('Invalid macro default');
          }
          const name = symbolName(pair.key);
          defaultNames.push(name);
          declaresCaller ||= name === 'caller';
        }
      } else {
        const name = symbolName(argument);
        positionalNames.push(name);
        declaresCaller ||= name === 'caller';
      }
    }
    const normalized = normalizeMacroArguments(
      positionalNames,
      defaultNames,
      arguments_,
    );
    let positionalIndex = 0;
    for (const argument of argumentNodes) {
      if (argument.type === 'KeywordArgs') {
        for (const pair of argument.children) {
          if (pair.type !== 'Pair') {
            throw new Error('Invalid macro default');
          }
          const name = symbolName(pair.key);
          const value = normalized.keyword.has(name)
            ? normalized.keyword.get(name)
            : this.#evaluateExpression(
              pair.value,
              local,
              bodyMacroContext,
              depth + 1,
            );
          bindRuntimeLocal(
            pair.key,
            name,
            value,
            local,
            bodyMacroContext.lexicalFrame,
            bodyMacroContext.lexicalPlan,
          );
        }
      } else {
        bindRuntimeLocal(
          argument,
          symbolName(argument),
          normalized.positional[positionalIndex],
          local,
          bodyMacroContext.lexicalFrame,
          bodyMacroContext.lexicalPlan,
        );
        positionalIndex += 1;
      }
    }
    if (!declaresCaller && normalized.keyword.has('caller')) {
      bindRuntimeFrameLocal(
        'caller',
        normalized.keyword.get('caller'),
        local,
      );
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
      this.#chargeExpandedValues(arguments_.positional);
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
      if (runtimeOrder(step, 0, this.#chargeExpansionWork) > 0) {
        for (
          let value = start;
          runtimeOrder(value, stop, this.#chargeExpansionWork) < 0;
          value = runtimeAdd(value, step, this.#chargeExpansionWork)
        ) {
          output.push(value);
          this.#charge(0);
        }
      } else {
        for (
          let value = start;
          runtimeOrder(value, stop, this.#chargeExpansionWork) > 0;
          value = runtimeAdd(value, step, this.#chargeExpansionWork)
        ) {
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
        owner.index = 0;
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
      throw new TemplateLimitError('outputCodeUnits', {
        phase: 'evaluate',
        configured: this.#options.limits.outputCodeUnits,
        observed: this.#outputCodeUnits,
      });
    }
    output.push(value);
  }

  #charge(depth: number): void {
    if (
      this.#options.limits.nestingDepth !== Number.POSITIVE_INFINITY &&
      depth > this.#options.limits.nestingDepth
    ) {
      throw new TemplateLimitError('nestingDepth', {
        phase: 'evaluate',
        configured: this.#options.limits.nestingDepth,
        observed: depth,
      });
    }
    this.#workUnits += 1;
    if (
      this.#options.limits.workUnits !== Number.POSITIVE_INFINITY &&
      this.#workUnits > this.#options.limits.workUnits
    ) {
      throw new TemplateLimitError('workUnits', {
        phase: 'evaluate',
        configured: this.#options.limits.workUnits,
        observed: this.#workUnits,
      });
    }
  }

  #chargeCapability(): void {
    this.#capabilityCalls += 1;
    if (
      this.#options.limits.capabilityCalls !== Number.POSITIVE_INFINITY &&
      this.#capabilityCalls > this.#options.limits.capabilityCalls
    ) {
      throw new TemplateLimitError('capabilityCalls', {
        phase: 'evaluate',
        configured: this.#options.limits.capabilityCalls,
        observed: this.#capabilityCalls,
      });
    }
  }

  #assertScratch(values: Iterable<RuntimeValue>): number {
    const bounded = this.#options.limits.scratchBytes !== Number.POSITIVE_INFINITY;
    let bytes = 0;
    for (const value of values) {
      bytes += runtimeValueBytes(value, this.#chargeExpansionWork);
      if (bounded && bytes > this.#options.limits.scratchBytes) {
        throw new TemplateLimitError('scratchBytes', {
          phase: 'evaluate',
          configured: this.#options.limits.scratchBytes,
          observed: bytes,
        });
      }
    }
    return bounded ? bytes : 0;
  }

  #chargeExpandedValues(values: Iterable<RuntimeValue>): void {
    for (const value of values) {
      chargeRuntimeValueExpansion(value, this.#chargeExpansionWork);
    }
  }

  #reserveIndexedValues(count: number, existingScratchBytes: number): void {
    const workLimit = this.#options.limits.workUnits;
    if (
      workLimit !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(count) || count > workLimit - this.#workUnits)
    ) {
      throw new TemplateLimitError('workUnits', {
        phase: 'evaluate',
        configured: workLimit,
        observed: this.#workUnits + count,
      });
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
      throw new TemplateLimitError('scratchBytes', {
        phase: 'evaluate',
        configured: scratchLimit,
        observed: existingScratchBytes + count * indexedValueScratchBytes,
      });
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

interface StaticTestInvocation {
  readonly name: string;
  readonly argumentsNode?: AstNode;
}

function staticTestInvocation(node: AstNode): StaticTestInvocation {
  if (node.type === 'FunCall' || node.type === 'Filter') {
    return {
      name: directStaticTestName(node.name),
      argumentsNode: node.args,
    };
  }
  return { name: directStaticTestName(node) };
}

function directStaticTestName(node: AstNode): string {
  switch (node.type) {
    case 'Literal': {
      const value = node.value;
      return isRegexLiteral(value)
        ? runtimeToString(new RuntimeRegex(value.source, value.flags))
        : runtimeToString(value);
    }
    case 'Symbol':
      return symbolName(node);
    case 'Root':
    case 'NodeList':
    case 'Output':
    case 'TemplateData':
    case 'Group':
    case 'Array':
    case 'Dict':
    case 'KeywordArgs':
    case 'Pair':
    case 'LookupVal':
    case 'Slice':
    case 'If':
    case 'InlineIf':
    case 'For':
    case 'Macro':
    case 'Caller':
    case 'FunCall':
    case 'Filter':
    case 'CallBlock':
    case 'Block':
    case 'Set':
    case 'Switch':
    case 'Case':
    case 'Capture':
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
    case 'Not':
    case 'Neg':
    case 'Pos':
    case 'Floor':
    case 'Compare':
    case 'CompareOperand':
      return 'undefined';
    default:
      return assertNeverStaticTestNode(node);
  }
}

function assertNeverStaticTestNode(node: never): never {
  throw new Error('Unexpected static test node');
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

function freshMemberCallable(value: RuntimeValue): RuntimeValue {
  return value instanceof RuntimeCallable
    ? new RuntimeCallable(value.callableKind, value.id)
    : value;
}

function bindLoopTargets(
  targets: readonly AstNode[],
  value: RuntimeValue,
  compilerBranch: RuntimeIteration['compilerBranch'],
  scope: RuntimeScope,
  lexicalFrame: RuntimeLexicalFrame,
  lexicalPlan: LexicalScopePlan,
): void {
  if (targets.length === 1) {
    const target = targets[0]!;
    bindRuntimeLocal(
      target,
      symbolName(target),
      value,
      scope,
      lexicalFrame,
      lexicalPlan,
    );
    return;
  }
  if (compilerBranch === 'array') {
    for (const [index, target] of targets.entries()) {
      bindLexicalAssignment(
        target,
        destructureRuntimeValue(value, index),
        lexicalFrame,
        lexicalPlan,
      );
    }
    return;
  }
  for (let index = 0; index < targets.length && index < 2; index += 1) {
    const target = targets[index]!;
    bindRuntimeLocal(
      target,
      symbolName(target),
      destructureRuntimeValue(value, index),
      scope,
      lexicalFrame,
      lexicalPlan,
    );
  }
}

function bindRuntimeLocal(
  target: AstNode,
  name: string,
  value: RuntimeValue,
  scope: RuntimeScope,
  lexicalFrame: RuntimeLexicalFrame,
  lexicalPlan: LexicalScopePlan,
): void {
  scope.set(name, value);
  const slot = lexicalPlan.slot(target);
  if (slot !== undefined) {
    lexicalFrame.set(slot, value);
  }
}

function bindRuntimeFrameLocal(
  name: string,
  value: RuntimeValue,
  scope: RuntimeScope,
): void {
  scope.set(name, value);
}

function bindLexicalAssignment(
  target: AstNode,
  value: RuntimeValue,
  lexicalFrame: RuntimeLexicalFrame,
  lexicalPlan: LexicalScopePlan,
): void {
  const slot = lexicalPlan.slot(target);
  if (slot !== undefined) {
    lexicalFrame.set(slot, value);
  }
}

function bindAssignment(target: AstNode, value: RuntimeValue, scope: RuntimeScope): void {
  if (target.type !== 'Symbol') {
    throw new Error(`Invalid assignment target ${target.type}`);
  }
  scope.assign(symbolName(target), value);
}

function iterableEntries(
  value: RuntimeValue,
  targetCount: number,
  chargeWork?: RuntimeWorkCharge,
): RuntimeIteration {
  const compilerBranch =
    value instanceof RuntimeArray || value instanceof RuntimeSafeString
      ? 'array'
      : 'record';
  if (targetCount === 1) {
    if (value instanceof RuntimeArray) {
      return { compilerBranch, length: value.length, values: value.values() };
    }
    if (value instanceof RuntimeRecord) {
      const length = value.get('length');
      return {
        compilerBranch,
        length,
        values: recordIndexValues(value, length, chargeWork),
      };
    }
    if (typeof value === 'string' || value instanceof RuntimeSafeString) {
      const text = typeof value === 'string' ? value : value.value;
      return { compilerBranch, length: text.length, values: stringCodeUnits(text) };
    }
    return { compilerBranch, length: undefined, values: emptyRuntimeValues() };
  }
  if (value instanceof RuntimeArray) {
    return { compilerBranch, length: value.length, values: value.values() };
  }
  if (value instanceof RuntimeRecord) {
    return { compilerBranch, length: value.size, values: recordIterationValues(value) };
  }
  if (typeof value === 'string') {
    return {
      compilerBranch,
      length: value.length,
      values: indexedStringIterationValues(value),
    };
  }
  if (value instanceof RuntimeSafeString) {
    return {
      compilerBranch,
      length: value.value.length,
      values: stringCodeUnits(value.value),
    };
  }
  return { compilerBranch, length: 0, values: emptyRuntimeValues() };
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
  chargeWork?: RuntimeWorkCharge,
): IterableIterator<RuntimeValue> {
  const numericLength = runtimeToNumber(length, chargeWork);
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

function runtimeCompare(
  left: RuntimeValue,
  operator: string,
  right: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): boolean {
  switch (operator) {
    case '==': return runtimeLooseEqual(left, right, chargeWork);
    case '===': return runtimeStrictEqual(left, right);
    case '!=': return !runtimeLooseEqual(left, right, chargeWork);
    case '!==': return !runtimeStrictEqual(left, right);
    case '<': return runtimeOrder(left, right, chargeWork) < 0;
    case '<=': return runtimeOrder(left, right, chargeWork) <= 0;
    case '>': return runtimeOrder(left, right, chargeWork) > 0;
    case '>=': return runtimeOrder(left, right, chargeWork) >= 0;
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

function runtimeContains(
  container: RuntimeValue,
  needle: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): boolean {
  if (typeof container === 'string') {
    return container.includes(runtimeToString(needle, chargeWork));
  }
  if (container instanceof RuntimeSafeString) {
    const propertyKey = runtimeToPropertyKey(needle, chargeWork);
    return propertyKey === 'length' || propertyKey === 'val';
  }
  if (container instanceof RuntimeArray) {
    for (const value of container.presentValues()) {
      if (runtimeStrictEqual(value, needle)) {
        return true;
      }
    }
    return false;
  }
  if (container instanceof RuntimeRecord) {
    return container.has(runtimeToPropertyKey(needle, chargeWork));
  }
  throw new Error('Membership requires an array, record, or string');
}

function runtimeValueBytes(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): number {
  if (value instanceof RuntimeArray) {
    let bytes = 0;
    for (const item of value.values()) {
      chargeWork?.();
      bytes += runtimeValueBytes(item, chargeWork);
    }
    return bytes;
  }
  if (value instanceof RuntimeRecord) {
    let bytes = 0;
    for (const [key, item] of value.entries()) {
      chargeWork?.();
      bytes += Buffer.byteLength(key) + runtimeValueBytes(item, chargeWork);
    }
    return bytes;
  }
  return Buffer.byteLength(renderRuntimeValue(value, chargeWork));
}

function chargeRuntimeValueExpansion(
  value: RuntimeValue,
  chargeWork: RuntimeWorkCharge,
): void {
  if (value instanceof RuntimeArray) {
    for (const item of value.values()) {
      chargeWork();
      chargeRuntimeValueExpansion(item, chargeWork);
    }
  } else if (value instanceof RuntimeRecord) {
    for (const [, item] of value.entries()) {
      chargeWork();
      chargeRuntimeValueExpansion(item, chargeWork);
    }
  }
}

function unknownRuntimeName(
  description: string,
  name: string,
  candidates: Iterable<string>,
): string {
  const suggestion = suggestDiagnosticName(name, candidates);
  return `Unknown ${description} ${formatDiagnosticValue(name)}` + (
    suggestion ? `; did you mean ${formatDiagnosticValue(suggestion)}?` : ''
  );
}

function* diagnosticFilterNames(
  cookiecutterCompat: boolean,
  configuredNames: readonly string[],
): IterableIterator<string> {
  yield* listBuiltinFilterNames();
  if (cookiecutterCompat) {
    yield 'jsonify';
  }
  yield* configuredNames;
}

function contextualizeRuntimeFailure(
  error: unknown,
  context: string,
  line: number,
  column: number,
): RuntimeEvaluationError {
  if (error instanceof TemplateLimitError) {
    throw error;
  }
  const failure = RuntimeEvaluationError.from(error, line, column);
  return new RuntimeEvaluationError(
    failure.code,
    `${context}: ${failure.message}`,
    failure.line,
    failure.column,
  );
}

function runtimeValueKind(value: RuntimeValue): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return typeof value;
  }
  if (value instanceof RuntimeArray) {
    return 'array';
  }
  if (value instanceof RuntimeRecord) {
    return 'record';
  }
  if (value instanceof RuntimeSafeString) {
    return 'safe string';
  }
  if (value instanceof RuntimeRegex) {
    return 'regular expression';
  }
  if (value instanceof RuntimeCallable) {
    return 'callable';
  }
  return 'unknown value';
}

function createMacroBindingContext(
  lexicalFrame: RuntimeLexicalFrame,
  lexicalPlan: LexicalScopePlan,
  invocationScope: RuntimeScope,
  exportsMacros: boolean,
  exportsAssignments: boolean,
): MacroBindingContext {
  return Object.freeze({
    lexicalFrame,
    lexicalPlan,
    invocationScope,
    exportsMacros,
    exportsAssignments,
  });
}
