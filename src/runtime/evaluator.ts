import type {
  AstBinaryNode,
  AstBlockNode,
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
  hasBuiltinFilter,
  lookupRuntimeConstantKey,
  lookupRuntimeValue,
  runtimeNumber,
} from './builtins.ts';
import { RuntimeScope } from './scope.ts';
import {
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

interface MacroDefinition {
  readonly node: AstCallableBodyNode;
  readonly scope: RuntimeScope;
}

interface BlockDefinition {
  readonly node: AstBlockNode;
}

interface BlockFrame {
  readonly chain: readonly BlockDefinition[];
  readonly index: number;
  readonly scope: RuntimeScope;
}

/** One allocation-bounded view over values accepted by a template loop. */
interface RuntimeIteration {
  readonly length: number;
  readonly values: IterableIterator<RuntimeValue>;
}

type BuiltinCallableDefinition =
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
    readonly separator: string;
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
  const evaluator = new Evaluator(options);
  const ast = evaluator.parse(source);
  return evaluator.render(ast, context);
}

class Evaluator {
  readonly #options: EvaluateOptions;
  readonly #macros = new Map<number, MacroDefinition>();
  readonly #builtinCallables = new Map<number, BuiltinCallableDefinition>();
  #activeBlocks = new Map<string, readonly BlockDefinition[]>();
  readonly #blockStack: BlockFrame[] = [];
  #nextCallableId = 1;
  #workUnits = 0;
  #outputCodeUnits = 0;
  #capabilityCalls = 0;
  #sourceCodeUnits = 0;

  constructor(options: EvaluateOptions) {
    this.#options = options;
  }

  parse(source: string): AstNode {
    this.#sourceCodeUnits += source.length;
    if (
      this.#options.limits.sourceCodeUnits !== Number.POSITIVE_INFINITY &&
      this.#sourceCodeUnits > this.#options.limits.sourceCodeUnits
    ) {
      throw new NunjitsuLimitError('sourceCodeUnits');
    }
    const ast = parseTemplate(source, {
      trimBlocks: this.#options.trimBlocks,
      lstripBlocks: this.#options.lstripBlocks,
      cookiecutterCompat: this.#options.cookiecutterCompat,
      astNodes: this.#options.limits.astNodes,
      nestingDepth: this.#options.limits.nestingDepth,
    });
    return ast;
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
    const output: OutputTarget = [];
    this.#renderTemplate(ast, scope, output, 0);
    return output.join('');
  }

  #renderTemplate(
    ast: AstNode,
    scope: RuntimeScope,
    output: OutputTarget,
    depth: number,
    inheritedBlocks: ReadonlyMap<string, readonly BlockDefinition[]> = new Map(),
  ): void {
    const previousBlocks = this.#activeBlocks;
    const activeBlocks = mergeBlocks(inheritedBlocks, collectBlocks(ast));
    this.#activeBlocks = activeBlocks;
    try {
      this.#evaluateNode(ast, scope, output, depth + 1);
    } finally {
      this.#activeBlocks = previousBlocks;
    }
  }

  #evaluateNode(
    node: AstNode,
    scope: RuntimeScope,
    output: OutputTarget,
    depth: number,
  ): void {
    this.#charge(depth);
    switch (node.type) {
      case 'Root':
      case 'NodeList':
        this.#evaluateSequence(node.children, scope, output, depth);
        return;
      case 'Output':
        for (const child of node.children) {
          if (child.type === 'TemplateData') {
            this.#append(output, literalString(child));
          } else {
            const value = this.#evaluateExpression(child, scope, depth + 1);
            this.#append(output, renderRuntimeValue(value));
          }
        }
        return;
      case 'If':
      {
        const condition = this.#evaluateExpression(node.cond, scope, depth + 1);
        if (runtimeTruthy(condition)) {
          this.#evaluateNode(node.body, scope, output, depth + 1);
        } else {
          const otherwise = node.else_;
          if (otherwise) {
            this.#evaluateNode(otherwise, scope, output, depth + 1);
          }
        }
        return;
      }
      case 'For':
        this.#evaluateFor(node, scope, output, depth + 1);
        return;
      case 'Set':
        this.#evaluateSet(node, scope, depth + 1);
        return;
      case 'Macro': {
        const name = symbolName(node.name);
        const id = this.#nextCallableId++;
        const definitionScope = this.#blockStack.at(-1)?.scope ?? scope;
        this.#macros.set(id, { node, scope: definitionScope });
        definitionScope.set(name, new RuntimeCallable('macro', id));
        return;
      }
      case 'Block':
        this.#evaluateBlock(node, scope, output, depth + 1);
        return;
      case 'Switch': {
        const value = this.#evaluateExpression(node.expr, scope, depth + 1);
        const cases = node.cases;
        let matched = false;
        for (const candidate of cases) {
          const condition = matched
            ? undefined
            : this.#evaluateExpression(candidate.cond, scope, depth + 1);
          if (matched || runtimeEqual(value, condition, false)) {
            matched = true;
            if (candidate.body.type === 'NodeList' && candidate.body.children.length === 0) {
              continue;
            }
            this.#evaluateNode(
              candidate.body,
              scope,
              output,
              depth + 1,
            );
            return;
          }
        }
        const fallback = node.default;
        if (fallback) {
          this.#evaluateNode(fallback, scope, output, depth + 1);
        }
        return;
      }
      default:
        throw new Error(`Unexpected statement node ${node.type}`);
    }
  }

  #evaluateBlock(
    node: AstNode,
    scope: RuntimeScope,
    output: OutputTarget,
    depth: number,
  ): void {
    if (node.type !== 'Block') {
      throw new Error('Invalid block node');
    }
    const name = symbolName(node.name);
    const chain: readonly BlockDefinition[] = this.#activeBlocks.get(name) ?? [
      { node },
    ];
    this.#renderBlock(chain, 0, scope, output, depth + 1);
  }

  #renderBlock(
    chain: readonly BlockDefinition[],
    index: number,
    scope: RuntimeScope,
    output: OutputTarget,
    depth: number,
  ): void {
    const definition = chain[index];
    if (!definition) {
      return;
    }
    this.#blockStack.push({ chain, index, scope });
    try {
      this.#evaluateNode(
        definition.node.body,
        scope.child(true),
        output,
        depth + 1,
      );
    } finally {
      this.#blockStack.pop();
    }
  }

  #evaluateSequence(
    nodes: readonly AstNode[],
    scope: RuntimeScope,
    output: OutputTarget,
    depth: number,
  ): void {
    for (const node of nodes) {
      this.#evaluateNode(node, scope, output, depth + 1);
    }
  }

  #evaluateFor(
    node: AstForNode,
    scope: RuntimeScope,
    output: OutputTarget,
    depth: number,
  ): void {
    const value = this.#evaluateExpression(node.arr, scope, depth + 1);
    const entries = iterableEntries(value);
    if (entries.length === 0) {
      const otherwise = node.else_;
      if (otherwise) {
        this.#evaluateNode(otherwise, scope.child(), output, depth + 1);
      }
      return;
    }
    const binding = node.name;
    const loopScope = scope.child();
    let index = 0;
    for (const entry of entries.values) {
      const iteration = loopScope;
      bindTarget(binding, entry, iteration);
      iteration.set('loop', new RuntimeRecord([
        ['index', index + 1],
        ['index0', index],
        ['revindex', entries.length - index],
        ['revindex0', entries.length - index - 1],
        ['first', index === 0],
        ['last', index === entries.length - 1],
        ['length', entries.length],
      ]));
      this.#evaluateNode(
        node.body,
        iteration,
        output,
        depth + 1,
      );
      index += 1;
    }
  }

  #evaluateSet(node: AstSetNode, scope: RuntimeScope, depth: number): void {
    const targets = node.targets;
    const valueNode = node.value;
    let value: RuntimeValue;
    if (valueNode) {
      value = this.#evaluateExpression(valueNode, scope, depth + 1);
    } else {
      const body = node.body;
      if (!body) {
        throw new Error('Invalid block assignment');
      }
      const capturedBody = body.type === 'Capture' ? body.body : body;
      value = this.#capture(capturedBody, scope, depth + 1, false);
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
          return new RuntimeCallable('capability', this.#registerGlobal(name));
        }
        return undefined;
      }
      case 'Array':
      case 'Group': {
        const values: RuntimeValue[] = [];
        for (const child of node.children) {
          values.push(this.#evaluateExpression(child, scope, depth + 1));
        }
        return node.type === 'Group' && values.length === 1
          ? values[0]
          : new RuntimeArray(values);
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
            : renderRuntimeValue(this.#evaluateExpression(keyNode, scope, depth + 1));
          if (isReservedName(name)) {
            throw new Error(`Template name ${name} is reserved`);
          }
          entries.push([
            name,
            this.#evaluateExpression(pair.value, scope, depth + 1),
          ]);
        }
        return new RuntimeRecord(entries);
      }
      case 'LookupVal': {
        const target = this.#evaluateExpression(node.target, scope, depth + 1);
        const valueNode = node.val;
        if (valueNode.type === 'Slice') {
          return this.#evaluateSlice(target, valueNode, scope, depth + 1);
        }
        if (valueNode.type === 'Array') {
          const children = valueNode.children;
          if (children.length === 1 && children[0]?.type === 'Slice') {
            return this.#evaluateSlice(target, children[0], scope, depth + 1);
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
          return lookupRuntimeConstantKey(target, constantKey.value);
        }
        const key = this.#evaluateExpression(valueNode, scope, depth + 1);
        if (target instanceof RuntimeCallable && target.callableKind === 'builtin') {
          return this.#lookupBuiltinCallable(target.id, renderRuntimeValue(key));
        }
        return lookupRuntimeValue(target, key);
      }
      case 'InlineIf': {
        const condition = this.#evaluateExpression(node.cond, scope, depth + 1);
        if (runtimeTruthy(condition)) {
          return this.#evaluateExpression(node.body, scope, depth + 1);
        }
        const otherwise = node.else_;
        return otherwise
          ? this.#evaluateExpression(otherwise, scope, depth + 1)
          : undefined;
      }
      case 'Or': {
        const left = this.#evaluateExpression(node.left, scope, depth + 1);
        return runtimeTruthy(left)
          ? left
          : this.#evaluateExpression(node.right, scope, depth + 1);
      }
      case 'And': {
        const left = this.#evaluateExpression(node.left, scope, depth + 1);
        return runtimeTruthy(left)
          ? this.#evaluateExpression(node.right, scope, depth + 1)
          : left;
      }
      case 'Not':
        return !runtimeTruthy(this.#evaluateExpression(node.target, scope, depth + 1));
      case 'Neg':
        return -runtimeNumber(this.#evaluateExpression(node.target, scope, depth + 1));
      case 'Pos':
        return runtimeNumber(this.#evaluateExpression(node.target, scope, depth + 1));
      case 'Add':
      case 'Concat':
      case 'Sub':
      case 'Mul':
      case 'Div':
      case 'FloorDiv':
      case 'Mod':
      case 'Pow':
        return this.#evaluateBinary(node, scope, depth + 1);
      case 'Compare':
        return this.#evaluateComparison(node, scope, depth + 1);
      case 'In': {
        const needle = this.#evaluateExpression(node.left, scope, depth + 1);
        const container = this.#evaluateExpression(node.right, scope, depth + 1);
        return runtimeContains(container, needle);
      }
      case 'Is':
        return this.#evaluateTest(node, scope, depth + 1);
      case 'Filter':
        return this.#evaluateFilter(node, scope, depth + 1);
      case 'FunCall':
        return this.#evaluateCall(node, scope, depth + 1);
      case 'Capture':
        return this.#capture(node.body, scope.child(), depth + 1, false);
      case 'Caller':
        return this.#registerCaller(node, scope);
      default:
        throw new Error(`Unexpected expression node ${node.type}`);
    }
  }

  #evaluateSlice(
    target: RuntimeValue,
    slice: AstSliceNode,
    scope: RuntimeScope,
    depth: number,
  ): RuntimeValue {
    const startValue = this.#evaluateExpression(slice.start, scope, depth + 1);
    const stopValue = this.#evaluateExpression(slice.stop, scope, depth + 1);
    const stepValue = this.#evaluateExpression(slice.step, scope, depth + 1);
    const values = target instanceof RuntimeArray
      ? [...target.values()]
      : typeof target === 'string' || target instanceof RuntimeSafeString
        ? [...renderRuntimeValue(target)]
        : [];
    const step = Math.trunc(runtimeNumber(stepValue));
    if (!Number.isFinite(step) || step === 0) {
      throw new Error('Slice step must be a non-zero finite integer');
    }
    let start = startValue === null
      ? (step < 0 ? values.length - 1 : 0)
      : Math.trunc(runtimeNumber(startValue));
    let stop = stopValue === null
      ? (step < 0 ? -1 : values.length)
      : Math.trunc(runtimeNumber(stopValue));
    if (start < 0) {
      start += values.length;
    }
    if (stopValue !== null && stop < 0) {
      stop += values.length;
    }
    const output: RuntimeValue[] = [];
    for (let index = start; ; index += step) {
      if (index < 0 || index >= values.length) {
        break;
      }
      if ((step > 0 && index >= stop) || (step < 0 && index <= stop)) {
        break;
      }
      output.push(values[index]);
      this.#charge(depth);
    }
    return new RuntimeArray(output);
  }

  #evaluateBinary(node: AstBinaryNode, scope: RuntimeScope, depth: number): RuntimeValue {
    const left = this.#evaluateExpression(node.left, scope, depth + 1);
    const right = this.#evaluateExpression(node.right, scope, depth + 1);
    if (
      node.type === 'Concat' ||
      (node.type === 'Add' && (isStringValue(left) || isStringValue(right)))
    ) {
      return renderRuntimeValue(left) + renderRuntimeValue(right);
    }
    const leftNumber = runtimeNumber(left);
    const rightNumber = runtimeNumber(right);
    switch (node.type) {
      case 'Add': return leftNumber + rightNumber;
      case 'Sub': return leftNumber - rightNumber;
      case 'Mul': return leftNumber * rightNumber;
      case 'Div': return leftNumber / rightNumber;
      case 'FloorDiv': return Math.floor(leftNumber / rightNumber);
      case 'Mod': return leftNumber % rightNumber;
      case 'Pow': return leftNumber ** rightNumber;
      default: throw new Error(`Invalid binary operator ${node.type}`);
    }
  }

  #evaluateComparison(
    node: AstCompareNode,
    scope: RuntimeScope,
    depth: number,
  ): boolean {
    let left = this.#evaluateExpression(node.expr, scope, depth + 1);
    for (const operation of node.ops) {
      const right = this.#evaluateExpression(operation.expr, scope, depth + 1);
      if (!runtimeCompare(left, operation.operator, right)) {
        return false;
      }
      left = right;
    }
    return true;
  }

  #evaluateFilter(node: AstCallNode, scope: RuntimeScope, depth: number): RuntimeValue {
    const name = symbolName(node.name);
    const arguments_ = this.#evaluateArguments(node.args, scope, depth + 1);
    const [input, ...positional] = arguments_.positional;
    this.#assertScratch([input, ...positional, ...arguments_.keyword.values()]);
    if (this.#options.host?.hasFilter?.(name)) {
      this.#chargeCapability();
      const hostResult = this.#options.host.filter?.(
        name,
        input,
        Object.freeze({ positional: Object.freeze(positional), keyword: arguments_.keyword }),
      );
      if (hostResult?.found) {
        return hostResult.value;
      }
    }
    const builtinName = this.#options.cookiecutterCompat && name === 'jsonify' ? 'dump' : name;
    const builtin = applyBuiltinFilter(builtinName, input, positional, arguments_.keyword);
    if (builtin === undefined && !hasBuiltinFilter(builtinName)) {
      throw new Error(`Unknown template filter ${name}`);
    }
    return builtin;
  }

  #evaluateTest(node: AstBinaryNode, scope: RuntimeScope, depth: number): boolean {
    const input = this.#evaluateExpression(node.left, scope, depth + 1);
    const test = node.right;
    let name: string;
    let arguments_: RuntimeArguments;
    if (test.type === 'FunCall') {
      name = symbolName(test.name);
      arguments_ = this.#evaluateArguments(test.args, scope, depth + 1);
    } else if (test.type === 'Symbol') {
      name = symbolName(test);
      arguments_ = Object.freeze({ positional: Object.freeze([]), keyword: new Map() });
    } else if (test.type === 'Literal') {
      const expected = this.#evaluateExpression(test, scope, depth + 1);
      return runtimeEqual(input, expected, true);
    } else {
      throw new Error(`Invalid template test ${test.type}`);
    }
    const builtin = applyBuiltinTest(name, input, arguments_.positional);
    if (builtin === undefined) {
      throw new Error(`Unknown template test ${name}`);
    }
    return builtin;
  }

  #evaluateCall(node: AstCallNode, scope: RuntimeScope, depth: number): RuntimeValue {
    const targetNode = node.name;
    const name = callablePath(targetNode);
    if (name === 'super' && this.#blockStack.length > 0) {
      const frame = this.#blockStack.at(-1)!;
      const chunks: string[] = [];
      this.#renderBlock(frame.chain, frame.index + 1, frame.scope, chunks, depth + 1);
      return new RuntimeSafeString(chunks.join(''));
    }
    const target = name && this.#options.host?.hasGlobal?.(name)
      ? new RuntimeCallable('capability', this.#registerGlobal(name))
      : this.#evaluateExpression(targetNode, scope, depth + 1);
    const arguments_ = this.#evaluateArguments(node.args, scope, depth + 1);
    if (target instanceof RuntimeCallable) {
      if (target.callableKind === 'macro' || target.callableKind === 'caller') {
        return this.#invokeMacro(target.id, arguments_, depth + 1);
      }
      if (target.callableKind === 'builtin') {
        return this.#invokeBuiltinCallable(target.id);
      }
      if (target.callableKind === 'capability' && name && this.#options.host?.global) {
        this.#chargeCapability();
        const result = this.#options.host.global(name, arguments_);
        if (result.found) {
          return result.value;
        }
      }
    }
    if (name) {
      const builtin = this.#invokeBuiltinGlobal(name, arguments_);
      if (builtin !== undefined) {
        return builtin;
      }
      if (this.#options.host?.hasGlobal?.(name)) {
        this.#chargeCapability();
        const result = this.#options.host.global?.(name, arguments_);
        if (result?.found) {
          return result.value;
        }
      }
    }
    throw new Error(`Unable to call template value${name ? ` ${name}` : ''}`);
  }

  #evaluateArguments(
    node: AstNode,
    scope: RuntimeScope,
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
            : renderRuntimeValue(this.#evaluateExpression(keyNode, scope, depth + 1));
          if (isReservedName(name)) {
            throw new Error(`Template name ${name} is reserved`);
          }
          keyword.set(
            name,
            this.#evaluateExpression(pair.value, scope, depth + 1),
          );
        }
      } else {
        positional.push(this.#evaluateExpression(child, scope, depth + 1));
      }
    }
    return Object.freeze({ positional: Object.freeze(positional), keyword });
  }

  #registerGlobal(name: string): number {
    let hash = 0;
    for (const character of name) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    return hash || 1;
  }

  #registerCaller(node: AstCallableBodyNode, scope: RuntimeScope): RuntimeCallable {
    const id = this.#nextCallableId++;
    this.#macros.set(id, { node, scope });
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
    const args = definition.node.args;
    if (args.type !== 'NodeList') {
      throw new Error('Invalid macro arguments');
    }
    const argumentNodes = args.children;
    let positionalIndex = 0;
    for (const argument of argumentNodes) {
      if (argument.type === 'KeywordArgs') {
        for (const pair of argument.children) {
          if (pair.type !== 'Pair') {
            throw new Error('Invalid macro default');
          }
          const name = symbolName(pair.key);
          const supplied = arguments_.keyword.get(name) ?? arguments_.positional[positionalIndex++];
          local.set(
            name,
            supplied === undefined
              ? this.#evaluateExpression(pair.value, local, depth + 1)
              : supplied,
          );
        }
      } else {
        const name = symbolName(argument);
        local.set(
          name,
          arguments_.keyword.get(name) ?? arguments_.positional[positionalIndex++],
        );
      }
    }
    for (const [name, value] of arguments_.keyword) {
      if (!local.has(name)) {
        local.set(name, value);
      }
    }
    return this.#capture(
      definition.node.body,
      local,
      depth + 1,
      true,
    );
  }

  #invokeBuiltinGlobal(name: string, arguments_: RuntimeArguments): RuntimeValue | undefined {
    if (name === 'range') {
      const values = arguments_.positional.map(runtimeNumber);
      const start = values.length > 1 ? values[0]! : 0;
      const stop = values.length > 1 ? values[1]! : values[0] ?? 0;
      const step = values[2] ?? 1;
      if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step) || step === 0) {
        return new RuntimeArray([]);
      }
      const output: number[] = [];
      if (step > 0) {
        for (let value = start; value < stop; value += step) {
          output.push(value);
          this.#charge(0);
        }
      } else {
        for (let value = start; value > stop; value += step) {
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
        values: Object.freeze([...arguments_.positional]),
        index: -1,
      });
      return new RuntimeCallable('builtin', id);
    }
    if (name === 'joiner') {
      const id = this.#nextCallableId++;
      this.#builtinCallables.set(id, {
        type: 'joiner',
        separator: renderRuntimeValue(arguments_.positional[0] ?? ','),
        used: false,
      });
      return new RuntimeCallable('builtin', id);
    }
    return undefined;
  }

  #lookupBuiltinCallable(id: number, key: string): RuntimeValue {
    const definition = this.#builtinCallables.get(id);
    if (!definition || definition.type !== 'cycler') {
      return undefined;
    }
    if (key === 'current') {
      return definition.index < 0 ? null : definition.values[definition.index];
    }
    if (key !== 'next' && key !== 'reset') {
      return undefined;
    }
    const methodId = this.#nextCallableId++;
    this.#builtinCallables.set(methodId, { type: 'cycler-method', owner: id, method: key });
    return new RuntimeCallable('builtin', methodId);
  }

  #invokeBuiltinCallable(id: number): RuntimeValue {
    const definition = this.#builtinCallables.get(id);
    if (!definition) {
      throw new Error('Unknown interpreter builtin callable');
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
        return null;
      }
      if (owner.values.length === 0) {
        return undefined;
      }
      owner.index = (owner.index + 1) % owner.values.length;
      return owner.values[owner.index];
    }
    throw new Error('Interpreter builtin object is not directly callable');
  }

  #capture(
    node: AstNode,
    scope: RuntimeScope,
    depth: number,
    safe: boolean,
  ): RuntimeValue {
    const chunks: string[] = [];
    this.#evaluateNode(node, scope, chunks, depth + 1);
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

  #assertScratch(values: Iterable<RuntimeValue>): void {
    if (this.#options.limits.scratchBytes === Number.POSITIVE_INFINITY) {
      return;
    }
    let bytes = 0;
    for (const value of values) {
      bytes += runtimeValueBytes(value);
      if (bytes > this.#options.limits.scratchBytes) {
        throw new NunjitsuLimitError('scratchBytes');
      }
    }
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

function callablePath(node: AstNode): string | undefined {
  if (node.type === 'Symbol') {
    return symbolName(node);
  }
  if (node.type !== 'LookupVal') {
    return undefined;
  }
  const parent = callablePath(node.target);
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

function bindTarget(target: AstNode, value: RuntimeValue, scope: RuntimeScope): void {
  if (target.type === 'Symbol') {
    scope.set(symbolName(target), value);
    return;
  }
  if (target.type === 'Array' || target.type === 'Group') {
    for (const [index, child] of target.children.entries()) {
      bindTarget(child, value instanceof RuntimeArray ? value.at(index) : undefined, scope);
    }
    return;
  }
  throw new Error(`Invalid loop target ${target.type}`);
}

function bindAssignment(target: AstNode, value: RuntimeValue, scope: RuntimeScope): void {
  if (target.type === 'Symbol') {
    scope.assign(symbolName(target), value);
    return;
  }
  bindTarget(target, value, scope);
}

function iterableEntries(value: RuntimeValue): RuntimeIteration {
  if (value instanceof RuntimeArray) {
    return { length: value.length, values: value.values() };
  }
  if (value instanceof RuntimeRecord) {
    return { length: value.size, values: recordIterationValues(value) };
  }
  if (typeof value === 'string' || value instanceof RuntimeSafeString) {
    const text = typeof value === 'string' ? value : value.value;
    return { length: codePointLength(text), values: text[Symbol.iterator]() };
  }
  return { length: 0, values: emptyRuntimeValues() };
}

function* recordIterationValues(value: RuntimeRecord): IterableIterator<RuntimeValue> {
  for (const [key, item] of value.entries()) {
    yield new RuntimeArray([key, item]);
  }
}

function* emptyRuntimeValues(): IterableIterator<RuntimeValue> {}

function codePointLength(value: string): number {
  let length = 0;
  for (const unused of value) {
    void unused;
    length += 1;
  }
  return length;
}

function runtimeEqual(left: RuntimeValue, right: RuntimeValue, strict: boolean): boolean {
  if (left === right) {
    return true;
  }
  if (!strict && ((left === undefined && right === null) || (left === null && right === undefined))) {
    return true;
  }
  if (isStringValue(left) && isStringValue(right)) {
    return renderRuntimeValue(left) === renderRuntimeValue(right);
  }
  if (!strict) {
    return runtimeNumber(left) === runtimeNumber(right);
  }
  return false;
}

function runtimeCompare(left: RuntimeValue, operator: string, right: RuntimeValue): boolean {
  switch (operator) {
    case '==': return runtimeEqual(left, right, false);
    case '===': return runtimeEqual(left, right, true);
    case '!=': return !runtimeEqual(left, right, false);
    case '!==': return !runtimeEqual(left, right, true);
    case '<': return runtimeOrder(left, right) < 0;
    case '<=': return runtimeOrder(left, right) <= 0;
    case '>': return runtimeOrder(left, right) > 0;
    case '>=': return runtimeOrder(left, right) >= 0;
    case 'in': return runtimeContains(right, left);
    case 'notin': return !runtimeContains(right, left);
    default: throw new Error(`Unsupported comparison operator ${operator}`);
  }
}

function runtimeOrder(left: RuntimeValue, right: RuntimeValue): number {
  if (isStringValue(left) && isStringValue(right)) {
    return renderRuntimeValue(left).localeCompare(renderRuntimeValue(right));
  }
  return runtimeNumber(left) - runtimeNumber(right);
}

function runtimeContains(container: RuntimeValue, needle: RuntimeValue): boolean {
  if (isStringValue(container)) {
    return renderRuntimeValue(container).includes(renderRuntimeValue(needle));
  }
  if (container instanceof RuntimeArray) {
    for (const value of container.values()) {
      if (runtimeEqual(value, needle, false)) {
        return true;
      }
    }
    return false;
  }
  if (container instanceof RuntimeRecord) {
    return container.get(renderRuntimeValue(needle)) !== undefined;
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

function collectBlocks(ast: AstNode): ReadonlyMap<string, readonly BlockDefinition[]> {
  const blocks = new Map<string, readonly BlockDefinition[]>();
  visitAst(ast, node => {
    if (node.type === 'Block') {
      const name = symbolName(node.name);
      if (blocks.has(name)) {
        throw new Error(`Template defines block ${name} more than once`);
      }
      blocks.set(name, Object.freeze([{ node }]));
    }
  });
  return blocks;
}

function mergeBlocks(
  inherited: ReadonlyMap<string, readonly BlockDefinition[]>,
  local: ReadonlyMap<string, readonly BlockDefinition[]>,
): Map<string, readonly BlockDefinition[]> {
  const merged = new Map<string, readonly BlockDefinition[]>(inherited);
  for (const [name, definitions] of local) {
    merged.set(name, Object.freeze([...(merged.get(name) ?? []), ...definitions]));
  }
  return merged;
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
    case 'Block':
      return [node.name, node.body];
    case 'Set': {
      const children = [...node.targets];
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
    case 'FloorDiv':
    case 'Mod':
    case 'Pow':
      return [node.left, node.right];
    case 'Not':
    case 'Neg':
    case 'Pos':
      return [node.target];
    case 'Compare':
      return [node.expr, ...node.ops];
    case 'CompareOperand':
      return [node.expr];
    case 'TemplateData':
    case 'Literal':
    case 'Symbol':
    case 'Super':
      return [];
  }
}
