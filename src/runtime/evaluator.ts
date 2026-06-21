import type { AstData, AstNode, AstRegexLiteral } from '../parser/ast.ts';
import { astField, astNode, astNodes, optionalAstNode } from '../parser/ast.ts';
import { parseTemplate } from '../parser/index.ts';
import type { NormalizedRenderLimits } from '../limits.ts';
import { NunjitsuLimitError } from '../limits.ts';
import type { TemplateContext } from '../values.ts';
import {
  applyBuiltinFilter,
  applyBuiltinTest,
  escapeHtml,
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
  /** Resolves one named template through explicitly configured trusted loaders. */
  load?(
    name: string,
    from: string | undefined,
    ignoreMissing: boolean,
    signal: AbortSignal,
  ): Promise<{
    readonly source: string;
    readonly canonicalName: string;
  } | undefined>;
  /** Invokes a configured filter, returning `undefined` when no filter exists. */
  filter?(
    name: string,
    input: RuntimeValue,
    arguments_: RuntimeArguments,
    signal: AbortSignal,
  ): Promise<{ readonly found: boolean; readonly value?: RuntimeValue }>;
  /** Invokes a configured test, returning `undefined` when no test exists. */
  test?(
    name: string,
    input: RuntimeValue,
    arguments_: RuntimeArguments,
    signal: AbortSignal,
  ): Promise<boolean | undefined>;
  /** Invokes a configured global, returning `undefined` when none exists. */
  global?(
    name: string,
    arguments_: RuntimeArguments,
    signal: AbortSignal,
  ): Promise<{ readonly found: boolean; readonly value?: RuntimeValue }>;
}

/** Options for one native template evaluation. */
export interface EvaluateOptions {
  readonly autoescape: boolean;
  readonly trimBlocks: boolean;
  readonly lstripBlocks: boolean;
  readonly limits: NormalizedRenderLimits;
  readonly signal: AbortSignal;
  readonly host?: RuntimeHost;
  readonly canonicalName?: string;
}

interface MacroDefinition {
  readonly node: AstNode;
  readonly scope: RuntimeScope;
}

/** Parses and evaluates one inline source through the closed interpreter. */
export async function evaluateTemplate(
  source: string,
  context: TemplateContext,
  options: EvaluateOptions,
): Promise<string> {
  const ast = parseTemplate(source, {
    trimBlocks: options.trimBlocks,
    lstripBlocks: options.lstripBlocks,
  });
  const evaluator = new Evaluator(options);
  return await evaluator.render(ast, copyRuntimeContext(context), options.canonicalName);
}

class Evaluator {
  readonly #options: EvaluateOptions;
  readonly #macros = new Map<number, MacroDefinition>();
  readonly #templates = new Map<string, AstNode>();
  #nextCallableId = 1;
  #workUnits = 0;
  #outputBytes = 0;
  #loaderCalls = 0;

  constructor(options: EvaluateOptions) {
    this.#options = options;
  }

  async render(
    ast: AstNode,
    context: RuntimeRecord,
    canonicalName?: string,
  ): Promise<string> {
    const scope = new RuntimeScope();
    for (const [name, value] of context.entries()) {
      scope.set(name, value);
    }
    const output: string[] = [];
    await this.#evaluateNode(ast, scope, output, 0, canonicalName);
    return output.join('');
  }

  async #evaluateNode(
    node: AstNode,
    scope: RuntimeScope,
    output: string[],
    depth: number,
    canonicalName?: string,
  ): Promise<void> {
    this.#charge(depth);
    switch (node.type) {
      case 'Root':
      case 'NodeList':
        await this.#evaluateSequence(astNodes(node, 'children'), scope, output, depth, canonicalName);
        return;
      case 'Output':
        for (const child of astNodes(node, 'children')) {
          if (child.type === 'TemplateData') {
            this.#append(output, literalString(child));
          } else {
            const value = await this.#evaluateExpression(child, scope, depth + 1);
            const rendered = renderRuntimeValue(value);
            this.#append(
              output,
              this.#options.autoescape && !(value instanceof RuntimeSafeString)
                ? escapeHtml(rendered)
                : rendered,
            );
          }
        }
        return;
      case 'If':
      case 'IfAsync': {
        const condition = await this.#evaluateExpression(astNode(node, 'cond'), scope, depth + 1);
        if (runtimeTruthy(condition)) {
          await this.#evaluateNode(
            astNode(node, 'body'),
            scope.child(),
            output,
            depth + 1,
            canonicalName,
          );
        } else {
          const otherwise = optionalAstNode(node, 'else_');
          if (otherwise) {
            await this.#evaluateNode(otherwise, scope.child(), output, depth + 1, canonicalName);
          }
        }
        return;
      }
      case 'For':
      case 'AsyncEach':
      case 'AsyncAll':
        await this.#evaluateFor(node, scope, output, depth + 1, canonicalName);
        return;
      case 'Set':
        await this.#evaluateSet(node, scope, depth + 1);
        return;
      case 'Macro': {
        const name = symbolName(astNode(node, 'name'));
        const id = this.#nextCallableId++;
        this.#macros.set(id, { node, scope });
        scope.set(name, new RuntimeCallable('macro', id));
        return;
      }
      case 'Block':
        await this.#evaluateNode(
          astNode(node, 'body'),
          scope.child(),
          output,
          depth + 1,
          canonicalName,
        );
        return;
      case 'Switch': {
        const value = await this.#evaluateExpression(astNode(node, 'expr'), scope, depth + 1);
        const cases = astField(node, 'cases');
        if (!Array.isArray(cases)) {
          throw new Error('Invalid switch case list');
        }
        for (const candidate of cases) {
          if (!isNode(candidate) || candidate.type !== 'Case') {
            throw new Error('Invalid switch case');
          }
          const condition = await this.#evaluateExpression(
            astNode(candidate, 'cond'),
            scope,
            depth + 1,
          );
          if (runtimeEqual(value, condition, false)) {
            await this.#evaluateNode(
              astNode(candidate, 'body'),
              scope.child(),
              output,
              depth + 1,
              canonicalName,
            );
            return;
          }
        }
        const fallback = optionalAstNode(node, 'default');
        if (fallback) {
          await this.#evaluateNode(fallback, scope.child(), output, depth + 1, canonicalName);
        }
        return;
      }
      case 'Include':
        await this.#evaluateInclude(node, scope, output, depth + 1, canonicalName);
        return;
      case 'Import':
      case 'FromImport':
      case 'Extends':
      case 'CallExtension':
      case 'CallExtensionAsync':
        throw new Error(`${node.type} is not implemented by the native evaluator yet`);
      default:
        throw new Error(`Unexpected statement node ${node.type}`);
    }
  }

  async #evaluateSequence(
    nodes: readonly AstNode[],
    scope: RuntimeScope,
    output: string[],
    depth: number,
    canonicalName?: string,
  ): Promise<void> {
    for (const node of nodes) {
      await this.#evaluateNode(node, scope, output, depth + 1, canonicalName);
    }
  }

  async #evaluateFor(
    node: AstNode,
    scope: RuntimeScope,
    output: string[],
    depth: number,
    canonicalName?: string,
  ): Promise<void> {
    const value = await this.#evaluateExpression(astNode(node, 'arr'), scope, depth + 1);
    const entries = iterableEntries(value);
    if (entries.length === 0) {
      const otherwise = optionalAstNode(node, 'else_');
      if (otherwise) {
        await this.#evaluateNode(otherwise, scope.child(), output, depth + 1, canonicalName);
      }
      return;
    }
    const binding = astNode(node, 'name');
    for (const [index, entry] of entries.entries()) {
      const iteration = scope.child();
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
      await this.#evaluateNode(
        astNode(node, 'body'),
        iteration,
        output,
        depth + 1,
        canonicalName,
      );
    }
  }

  async #evaluateSet(node: AstNode, scope: RuntimeScope, depth: number): Promise<void> {
    const targets = astField(node, 'targets');
    if (!Array.isArray(targets) || !targets.every(isNode)) {
      throw new Error('Invalid assignment target list');
    }
    const valueNode = optionalAstNode(node, 'value');
    let value: RuntimeValue;
    if (valueNode) {
      value = await this.#evaluateExpression(valueNode, scope, depth + 1);
    } else {
      const body = optionalAstNode(node, 'body');
      if (!body) {
        throw new Error('Invalid block assignment');
      }
      value = await this.#capture(body, scope.child(), depth + 1, false);
    }
    if (targets.length === 1) {
      bindAssignment(targets[0]!, value, scope);
      return;
    }
    const values = value instanceof RuntimeArray ? [...value.values()] : [];
    for (const [index, target] of targets.entries()) {
      bindAssignment(target, values[index], scope);
    }
  }

  async #evaluateExpression(
    node: AstNode,
    scope: RuntimeScope,
    depth: number,
  ): Promise<RuntimeValue> {
    this.#charge(depth);
    switch (node.type) {
      case 'Literal': {
        const value = astField(node, 'value');
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
        if (this.#options.host?.global) {
          return new RuntimeCallable('capability', this.#registerGlobal(name));
        }
        return undefined;
      }
      case 'Array':
      case 'Group': {
        const values: RuntimeValue[] = [];
        for (const child of astNodes(node, 'children')) {
          values.push(await this.#evaluateExpression(child, scope, depth + 1));
        }
        return node.type === 'Group' && values.length === 1
          ? values[0]
          : new RuntimeArray(values);
      }
      case 'Dict':
      case 'KeywordArgs': {
        const entries: Array<readonly [string, RuntimeValue]> = [];
        for (const pair of astNodes(node, 'children')) {
          const keyNode = astNode(pair, 'key');
          const name = keyNode.type === 'Symbol'
            ? symbolName(keyNode)
            : renderRuntimeValue(await this.#evaluateExpression(keyNode, scope, depth + 1));
          if (isReservedName(name)) {
            throw new Error(`Template name ${name} is reserved`);
          }
          entries.push([
            name,
            await this.#evaluateExpression(astNode(pair, 'value'), scope, depth + 1),
          ]);
        }
        return new RuntimeRecord(entries);
      }
      case 'LookupVal': {
        const target = await this.#evaluateExpression(astNode(node, 'target'), scope, depth + 1);
        const key = await this.#evaluateExpression(astNode(node, 'val'), scope, depth + 1);
        return lookupRuntimeValue(target, key);
      }
      case 'InlineIf': {
        const condition = await this.#evaluateExpression(astNode(node, 'cond'), scope, depth + 1);
        if (runtimeTruthy(condition)) {
          return await this.#evaluateExpression(astNode(node, 'body'), scope, depth + 1);
        }
        const otherwise = optionalAstNode(node, 'else_');
        return otherwise
          ? await this.#evaluateExpression(otherwise, scope, depth + 1)
          : undefined;
      }
      case 'Or': {
        const left = await this.#evaluateExpression(astNode(node, 'left'), scope, depth + 1);
        return runtimeTruthy(left)
          ? left
          : await this.#evaluateExpression(astNode(node, 'right'), scope, depth + 1);
      }
      case 'And': {
        const left = await this.#evaluateExpression(astNode(node, 'left'), scope, depth + 1);
        return runtimeTruthy(left)
          ? await this.#evaluateExpression(astNode(node, 'right'), scope, depth + 1)
          : left;
      }
      case 'Not':
        return !runtimeTruthy(await this.#evaluateExpression(astNode(node, 'target'), scope, depth + 1));
      case 'Neg':
        return -runtimeNumber(await this.#evaluateExpression(astNode(node, 'target'), scope, depth + 1));
      case 'Pos':
        return runtimeNumber(await this.#evaluateExpression(astNode(node, 'target'), scope, depth + 1));
      case 'Add':
      case 'Concat':
      case 'Sub':
      case 'Mul':
      case 'Div':
      case 'FloorDiv':
      case 'Mod':
      case 'Pow':
        return await this.#evaluateBinary(node, scope, depth + 1);
      case 'Compare':
        return await this.#evaluateComparison(node, scope, depth + 1);
      case 'In': {
        const needle = await this.#evaluateExpression(astNode(node, 'left'), scope, depth + 1);
        const container = await this.#evaluateExpression(astNode(node, 'right'), scope, depth + 1);
        return runtimeContains(container, needle);
      }
      case 'Is':
        return await this.#evaluateTest(node, scope, depth + 1);
      case 'Filter':
      case 'FilterAsync':
        return await this.#evaluateFilter(node, scope, depth + 1);
      case 'FunCall':
        return await this.#evaluateCall(node, scope, depth + 1);
      case 'Capture':
        return await this.#capture(astNode(node, 'body'), scope.child(), depth + 1, false);
      case 'Caller':
        return this.#registerCaller(node, scope);
      default:
        throw new Error(`Unexpected expression node ${node.type}`);
    }
  }

  async #evaluateBinary(node: AstNode, scope: RuntimeScope, depth: number): Promise<RuntimeValue> {
    const left = await this.#evaluateExpression(astNode(node, 'left'), scope, depth + 1);
    const right = await this.#evaluateExpression(astNode(node, 'right'), scope, depth + 1);
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

  async #evaluateComparison(
    node: AstNode,
    scope: RuntimeScope,
    depth: number,
  ): Promise<boolean> {
    let left = await this.#evaluateExpression(astNode(node, 'expr'), scope, depth + 1);
    for (const operation of astNodes(node, 'ops')) {
      const right = await this.#evaluateExpression(astNode(operation, 'expr'), scope, depth + 1);
      const type = astField(operation, 'type');
      if (typeof type !== 'string' || !runtimeCompare(left, type, right)) {
        return false;
      }
      left = right;
    }
    return true;
  }

  async #evaluateFilter(node: AstNode, scope: RuntimeScope, depth: number): Promise<RuntimeValue> {
    const name = symbolName(astNode(node, 'name'));
    const arguments_ = await this.#evaluateArguments(astNode(node, 'args'), scope, depth + 1);
    const [input, ...positional] = arguments_.positional;
    const hostResult = await this.#options.host?.filter?.(
      name,
      input,
      Object.freeze({ positional: Object.freeze(positional), keyword: arguments_.keyword }),
      this.#options.signal,
    );
    if (hostResult?.found) {
      return hostResult.value;
    }
    const builtin = applyBuiltinFilter(name, input, positional, arguments_.keyword);
    if (builtin === undefined) {
      throw new Error(`Unknown template filter ${name}`);
    }
    return builtin;
  }

  async #evaluateInclude(
    node: AstNode,
    scope: RuntimeScope,
    output: string[],
    depth: number,
    canonicalName: string | undefined,
  ): Promise<void> {
    const name = renderRuntimeValue(
      await this.#evaluateExpression(astNode(node, 'template'), scope, depth + 1),
    );
    const ignoreMissing = astField(node, 'ignoreMissing') === true;
    if (!this.#options.host?.load) {
      if (ignoreMissing) {
        return;
      }
      throw new Error(`No template loader is configured for ${name}`);
    }
    this.#loaderCalls += 1;
    if (
      this.#options.limits.loaderCalls !== Number.POSITIVE_INFINITY &&
      this.#loaderCalls > this.#options.limits.loaderCalls
    ) {
      throw new NunjitsuLimitError('loaderCalls');
    }
    const loaded = await this.#options.host.load(
      name,
      canonicalName,
      ignoreMissing,
      this.#options.signal,
    );
    if (!loaded) {
      return;
    }
    let ast = this.#templates.get(loaded.canonicalName);
    if (!ast) {
      ast = parseTemplate(loaded.source, {
        trimBlocks: this.#options.trimBlocks,
        lstripBlocks: this.#options.lstripBlocks,
      });
      this.#templates.set(loaded.canonicalName, ast);
    }
    await this.#evaluateNode(ast, scope.child(), output, depth + 1, loaded.canonicalName);
  }

  async #evaluateTest(node: AstNode, scope: RuntimeScope, depth: number): Promise<boolean> {
    const input = await this.#evaluateExpression(astNode(node, 'left'), scope, depth + 1);
    const test = astNode(node, 'right');
    let name: string;
    let arguments_: RuntimeArguments;
    if (test.type === 'FunCall') {
      name = symbolName(astNode(test, 'name'));
      arguments_ = await this.#evaluateArguments(astNode(test, 'args'), scope, depth + 1);
    } else {
      name = symbolName(test);
      arguments_ = Object.freeze({ positional: Object.freeze([]), keyword: new Map() });
    }
    const host = await this.#options.host?.test?.(
      name,
      input,
      arguments_,
      this.#options.signal,
    );
    if (host !== undefined) {
      return host;
    }
    const builtin = applyBuiltinTest(name, input, arguments_.positional);
    if (builtin === undefined) {
      throw new Error(`Unknown template test ${name}`);
    }
    return builtin;
  }

  async #evaluateCall(node: AstNode, scope: RuntimeScope, depth: number): Promise<RuntimeValue> {
    const targetNode = astNode(node, 'name');
    const name = targetNode.type === 'Symbol' ? symbolName(targetNode) : undefined;
    const target = await this.#evaluateExpression(targetNode, scope, depth + 1);
    const arguments_ = await this.#evaluateArguments(astNode(node, 'args'), scope, depth + 1);
    if (target instanceof RuntimeCallable) {
      if (target.callableKind === 'macro' || target.callableKind === 'caller') {
        return await this.#invokeMacro(target.id, arguments_, depth + 1);
      }
      if (target.callableKind === 'capability' && name && this.#options.host?.global) {
        const result = await this.#options.host.global(name, arguments_, this.#options.signal);
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
      const result = await this.#options.host?.global?.(name, arguments_, this.#options.signal);
      if (result?.found) {
        return result.value;
      }
    }
    throw new Error(`Unable to call ${name ?? 'template value'}`);
  }

  async #evaluateArguments(
    node: AstNode,
    scope: RuntimeScope,
    depth: number,
  ): Promise<RuntimeArguments> {
    const positional: RuntimeValue[] = [];
    const keyword = new Map<string, RuntimeValue>();
    for (const child of astNodes(node, 'children')) {
      if (child.type === 'KeywordArgs') {
        for (const pair of astNodes(child, 'children')) {
          const keyNode = astNode(pair, 'key');
          const name = keyNode.type === 'Symbol'
            ? symbolName(keyNode)
            : renderRuntimeValue(await this.#evaluateExpression(keyNode, scope, depth + 1));
          if (isReservedName(name)) {
            throw new Error(`Template name ${name} is reserved`);
          }
          keyword.set(
            name,
            await this.#evaluateExpression(astNode(pair, 'value'), scope, depth + 1),
          );
        }
      } else {
        positional.push(await this.#evaluateExpression(child, scope, depth + 1));
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

  #registerCaller(node: AstNode, scope: RuntimeScope): RuntimeCallable {
    const id = this.#nextCallableId++;
    this.#macros.set(id, { node, scope });
    return new RuntimeCallable('caller', id);
  }

  async #invokeMacro(
    id: number,
    arguments_: RuntimeArguments,
    depth: number,
  ): Promise<RuntimeValue> {
    const definition = this.#macros.get(id);
    if (!definition) {
      throw new Error('Unknown template macro');
    }
    const local = definition.scope.child();
    const argumentNodes = astNodes(astNode(definition.node, 'args'), 'children');
    let positionalIndex = 0;
    for (const argument of argumentNodes) {
      if (argument.type === 'KeywordArgs') {
        for (const pair of astNodes(argument, 'children')) {
          const name = symbolName(astNode(pair, 'key'));
          const supplied = arguments_.keyword.get(name);
          local.set(
            name,
            supplied === undefined
              ? await this.#evaluateExpression(astNode(pair, 'value'), local, depth + 1)
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
    return await this.#capture(astNode(definition.node, 'body'), local, depth + 1, true);
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
    return undefined;
  }

  async #capture(
    node: AstNode,
    scope: RuntimeScope,
    depth: number,
    safe: boolean,
  ): Promise<RuntimeValue> {
    const chunks: string[] = [];
    await this.#evaluateNode(node, scope, chunks, depth + 1);
    const value = chunks.join('');
    return safe ? new RuntimeSafeString(value) : value;
  }

  #append(output: string[], value: string): void {
    this.#outputBytes += Buffer.byteLength(value);
    if (
      this.#options.limits.outputBytes !== Number.POSITIVE_INFINITY &&
      this.#outputBytes > this.#options.limits.outputBytes
    ) {
      throw new NunjitsuLimitError('outputBytes');
    }
    output.push(value);
  }

  #charge(depth: number): void {
    if (this.#options.signal.aborted) {
      throw this.#options.signal.reason instanceof Error
        ? this.#options.signal.reason
        : new DOMException('The operation was aborted', 'AbortError');
    }
    if (depth > this.#options.limits.includeDepth) {
      throw new NunjitsuLimitError('includeDepth');
    }
    this.#workUnits += 1;
    if (
      this.#options.limits.workUnits !== Number.POSITIVE_INFINITY &&
      this.#workUnits > this.#options.limits.workUnits
    ) {
      throw new NunjitsuLimitError('workUnits');
    }
  }
}

function symbolName(node: AstNode): string {
  if (node.type !== 'Symbol') {
    throw new Error(`Expected symbol, received ${node.type}`);
  }
  const name = astField(node, 'value');
  if (typeof name !== 'string' || isReservedName(name)) {
    throw new Error('Invalid or reserved template symbol');
  }
  return name;
}

function literalString(node: AstNode): string {
  const value = astField(node, 'value');
  if (typeof value !== 'string') {
    throw new Error('Invalid template text node');
  }
  return value;
}

function isNode(value: AstData): value is AstNode {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'fields' in value);
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

function isStringValue(value: RuntimeValue): boolean {
  return typeof value === 'string' || value instanceof RuntimeSafeString;
}

function bindTarget(target: AstNode, value: RuntimeValue, scope: RuntimeScope): void {
  if (target.type === 'Symbol') {
    scope.set(symbolName(target), value);
    return;
  }
  if (target.type === 'Array' || target.type === 'Group') {
    const values = value instanceof RuntimeArray ? [...value.values()] : [];
    for (const [index, child] of astNodes(target, 'children').entries()) {
      bindTarget(child, values[index], scope);
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

function iterableEntries(value: RuntimeValue): RuntimeValue[] {
  if (value instanceof RuntimeArray) {
    return [...value.values()];
  }
  if (value instanceof RuntimeRecord) {
    return [...value.entries()].map(([key, item]) => new RuntimeArray([key, item]));
  }
  if (typeof value === 'string' || value instanceof RuntimeSafeString) {
    return [...(typeof value === 'string' ? value : value.value)];
  }
  return [];
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
    return [...container.values()].some(value => runtimeEqual(value, needle, false));
  }
  if (container instanceof RuntimeRecord) {
    return container.get(renderRuntimeValue(needle)) !== undefined;
  }
  return false;
}
