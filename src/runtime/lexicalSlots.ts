import type {
  AstBlockNode,
  AstCallableBodyNode,
  AstForNode,
  AstNode,
} from '../parser/ast.ts';
import { NunjitsuLimitError } from '../limits.ts';
import type { RuntimeValue } from './value.ts';

/** Mutable slot inventory used only while building one compiled frame plan. */
interface MutableCompiledFramePlan {
  readonly slots: number[];
}

/** One static traversal state with the slots visible at its current position. */
interface LexicalFrameState {
  readonly frame: MutableCompiledFramePlan;
  readonly scope: LexicalScopePlan;
  readonly bindings: Map<string, number>;
}

/** Static bindings and nested execution plans for one compiled source region. */
export class LexicalScopePlan {
  readonly #nodeSlots = new WeakMap<AstNode, number>();
  readonly #callableFrames = new WeakMap<AstCallableBodyNode, CompiledFramePlan>();
  readonly #blockFrames = new WeakMap<AstBlockNode, CompiledFramePlan>();
  readonly #loops = new WeakMap<AstForNode, LexicalLoopPlan>();

  /** Returns the direct slot selected for one reference or binding node. */
  slot(node: AstNode): number | undefined {
    return this.#nodeSlots.get(node);
  }

  /** Returns the compiled frame created for one macro or synthetic caller. */
  callableFrame(node: AstCallableBodyNode): CompiledFramePlan {
    const frame = this.#callableFrames.get(node);
    if (!frame) {
      throw new Error(`Missing callable frame plan for ${node.type}`);
    }
    return frame;
  }

  /** Returns the compiled frame created for one standalone block. */
  blockFrame(node: AstBlockNode): CompiledFramePlan {
    const frame = this.#blockFrames.get(node);
    if (!frame) {
      throw new Error('Missing block frame plan');
    }
    return frame;
  }

  /** Returns the branch-specific plan and control slot for one loop. */
  loop(node: AstForNode): LexicalLoopPlan {
    const loop = this.#loops.get(node);
    if (!loop) {
      throw new Error('Missing loop plan');
    }
    return loop;
  }

  /** Records one direct slot during static planning. */
  bindSlot(node: AstNode, slot: number): void {
    this.#nodeSlots.set(node, slot);
  }

  /** Records one callable frame during static planning. */
  bindCallableFrame(node: AstCallableBodyNode, frame: CompiledFramePlan): void {
    this.#callableFrames.set(node, frame);
  }

  /** Records one block frame during static planning. */
  bindBlockFrame(node: AstBlockNode, frame: CompiledFramePlan): void {
    this.#blockFrames.set(node, frame);
  }

  /** Records one loop plan during static planning. */
  bindLoop(node: AstForNode, loop: LexicalLoopPlan): void {
    this.#loops.set(node, loop);
  }
}

/** Slots and root visibility plan owned by one compiled-function invocation. */
export class CompiledFramePlan {
  readonly slots: readonly number[];
  readonly scope: LexicalScopePlan;

  constructor(slots: readonly number[], scope: LexicalScopePlan) {
    this.slots = slots;
    this.scope = scope;
  }
}

/** Branch-specific visibility and persistent length state for one loop node. */
export class LexicalLoopPlan {
  readonly lengthSlot: number;
  readonly #single: LexicalScopePlan | undefined;
  readonly #array: LexicalScopePlan | undefined;
  readonly #record: LexicalScopePlan | undefined;

  constructor(
    lengthSlot: number,
    single: LexicalScopePlan | undefined,
    array: LexicalScopePlan | undefined,
    record: LexicalScopePlan | undefined,
  ) {
    this.lengthSlot = lengthSlot;
    this.#single = single;
    this.#array = array;
    this.#record = record;
  }

  /** Selects the body plan emitted for the runtime container branch. */
  body(targetCount: number, arrayInput: boolean): LexicalScopePlan {
    const scope = targetCount === 1
      ? this.#single
      : arrayInput
        ? this.#array
        : this.#record;
    if (!scope) {
      throw new Error('Missing loop body plan');
    }
    return scope;
  }

  /** Selects the final compiler mapping used by a loop else body. */
  otherwise(targetCount: number): LexicalScopePlan {
    const scope = targetCount === 1 ? this.#single : this.#record;
    if (!scope) {
      throw new Error('Missing loop else plan');
    }
    return scope;
  }
}

/** Static compiler-slot assignments for one complete immutable AST. */
export class LexicalSlotPlan {
  readonly #root: CompiledFramePlan;

  constructor(root: CompiledFramePlan) {
    this.#root = root;
  }

  /** Returns the compiled frame that owns root render storage. */
  rootFrame(): CompiledFramePlan {
    return this.#root;
  }
}

/** One invocation-local storage chain for statically allocated compiler slots. */
export class RuntimeLexicalFrame {
  readonly #parent: RuntimeLexicalFrame | undefined;
  readonly #values = new Map<number, RuntimeValue>();

  constructor(slots: readonly number[], parent?: RuntimeLexicalFrame) {
    this.#parent = parent;
    for (const slot of slots) {
      this.#values.set(slot, undefined);
    }
  }

  /** Reads one exact slot without falling through to runtime name lookup. */
  get(slot: number): RuntimeValue {
    if (this.#values.has(slot)) {
      return this.#values.get(slot);
    }
    if (this.#parent) {
      return this.#parent.get(slot);
    }
    throw new Error(`Unknown lexical slot ${slot}`);
  }

  /** Replaces one exact slot in the compiled frame that owns it. */
  set(slot: number, value: RuntimeValue): void {
    if (this.#values.has(slot)) {
      this.#values.set(slot, value);
      return;
    }
    if (this.#parent) {
      this.#parent.set(slot, value);
      return;
    }
    throw new Error(`Unknown lexical slot ${slot}`);
  }
}

/** Assigns stable direct slots according to Nunjucks compiler traversal order. */
export function planLexicalSlots(
  ast: AstNode,
  maximumExpansionWork = Number.POSITIVE_INFINITY,
): LexicalSlotPlan {
  const frames: MutableCompiledFramePlan[] = [];
  const visitedNodes = new WeakSet<AstNode>();
  let nextSlot = 0;
  let expansionWork = 0;

  const createCompiledFrame = (
    inherited?: ReadonlyMap<string, number>,
  ): { readonly plan: CompiledFramePlan; readonly state: LexicalFrameState } => {
    const mutable: MutableCompiledFramePlan = { slots: [] };
    const scope = new LexicalScopePlan();
    const plan = new CompiledFramePlan(mutable.slots, scope);
    frames.push(mutable);
    return {
      plan,
      state: {
        frame: mutable,
        scope,
        bindings: new Map(inherited),
      },
    };
  };

  const createRegion = (state: LexicalFrameState): LexicalFrameState => ({
    frame: state.frame,
    scope: new LexicalScopePlan(),
    bindings: new Map(state.bindings),
  });

  const createAnonymousSlot = (state: LexicalFrameState): number => {
    const slot = nextSlot;
    nextSlot += 1;
    state.frame.slots.push(slot);
    return slot;
  };

  const createSlot = (
    state: LexicalFrameState,
    name: string,
    node: AstNode,
  ): number => {
    const slot = createAnonymousSlot(state);
    state.bindings.set(name, slot);
    state.scope.bindSlot(node, slot);
    return slot;
  };

  const useSlot = (state: LexicalFrameState, node: AstNode): void => {
    if (node.type !== 'Symbol') {
      throw new Error(`Expected symbol, received ${node.type}`);
    }
    const slot = state.bindings.get(node.value);
    if (slot !== undefined) {
      state.scope.bindSlot(node, slot);
    }
  };

  const planCallable = (
    node: AstCallableBodyNode,
    inherited?: ReadonlyMap<string, number>,
  ): CompiledFramePlan => {
    const callable = createCompiledFrame(inherited);
    const state = callable.state;
    if (node.args.type !== 'NodeList') {
      throw new Error('Invalid callable argument list');
    }
    const positionalSlots = new Map<string, number>();
    for (const argument of node.args.children) {
      if (argument.type === 'KeywordArgs') {
        for (const pair of argument.children) {
          if (pair.type !== 'Pair' || pair.key.type !== 'Symbol') {
            throw new Error('Invalid callable default');
          }
          visit(pair.value, state);
        }
      } else {
        if (argument.type !== 'Symbol') {
          throw new Error('Invalid callable formal');
        }
        const name = argument.value;
        const existing = positionalSlots.get(name);
        if (existing === undefined) {
          positionalSlots.set(name, createSlot(state, name, argument));
        } else {
          state.scope.bindSlot(argument, existing);
        }
      }
    }
    visit(node.body, state);
    return callable.plan;
  };

  const visitPairValue = (node: AstNode, state: LexicalFrameState): void => {
    if (node.type !== 'Pair') {
      throw new Error(`Expected pair, received ${node.type}`);
    }
    if (node.key.type !== 'Symbol' && node.key.type !== 'Literal') {
      visit(node.key, state);
    }
    visit(node.value, state);
  };

  const planLoopTargets = (
    targets: readonly AstNode[],
    state: LexicalFrameState,
  ): void => {
    for (const target of targets) {
      if (target.type !== 'Symbol') {
        throw new Error(`Invalid loop target ${target.type}`);
      }
      createSlot(state, target.value, target);
    }
  };

  function visit(node: AstNode, state: LexicalFrameState): void {
    if (visitedNodes.has(node)) {
      expansionWork += 1;
      if (
        maximumExpansionWork !== Number.POSITIVE_INFINITY &&
        expansionWork > maximumExpansionWork
      ) {
        throw new NunjitsuLimitError('workUnits', {
          phase: 'evaluate',
          configured: maximumExpansionWork,
          observed: expansionWork,
        });
      }
    } else {
      visitedNodes.add(node);
    }
    switch (node.type) {
      case 'Root':
      case 'NodeList':
      case 'Output':
      case 'Group':
      case 'Array':
        for (const child of node.children) {
          visit(child, state);
        }
        return;
      case 'Dict':
      case 'KeywordArgs':
        for (const child of node.children) {
          visitPairValue(child, state);
        }
        return;
      case 'Pair':
        visitPairValue(node, state);
        return;
      case 'Symbol':
        useSlot(state, node);
        return;
      case 'LookupVal':
        visit(node.target, state);
        visit(node.val, state);
        return;
      case 'Slice':
        visit(node.start, state);
        visit(node.stop, state);
        visit(node.step, state);
        return;
      case 'If':
      case 'InlineIf':
        visit(node.cond, state);
        visit(node.body, state);
        if (node.else_) {
          visit(node.else_, state);
        }
        return;
      case 'For': {
        visit(node.arr, state);
        const lengthSlot = createAnonymousSlot(state);
        const targets = node.name.type === 'Array' ? node.name.children : [node.name];
        if (targets.length === 1) {
          const bodyState = createRegion(state);
          planLoopTargets(targets, bodyState);
          visit(node.body, bodyState);
          if (node.else_) {
            visit(node.else_, bodyState);
          }
          state.scope.bindLoop(
            node,
            new LexicalLoopPlan(lengthSlot, bodyState.scope, undefined, undefined),
          );
          return;
        }
        const arrayState = createRegion(state);
        planLoopTargets(targets, arrayState);
        visit(node.body, arrayState);
        const recordState = createRegion(arrayState);
        planLoopTargets(targets.slice(0, 2), recordState);
        visit(node.body, recordState);
        if (node.else_) {
          visit(node.else_, recordState);
        }
        state.scope.bindLoop(
          node,
          new LexicalLoopPlan(
            lengthSlot,
            undefined,
            arrayState.scope,
            recordState.scope,
          ),
        );
        return;
      }
      case 'Macro': {
        if (node.name.type !== 'Symbol') {
          throw new Error('Invalid macro name');
        }
        const slot = createSlot(state, node.name.value, node);
        state.scope.bindSlot(node.name, slot);
        state.scope.bindCallableFrame(node, planCallable(node));
        return;
      }
      case 'Caller':
        state.scope.bindCallableFrame(node, planCallable(node, state.bindings));
        return;
      case 'FunCall':
        visit(node.name, state);
        visit(node.args, state);
        return;
      case 'Filter':
        visit(node.args, state);
        return;
      case 'CallBlock':
        visit(node.call, state);
        state.scope.bindCallableFrame(
          node.caller,
          planCallable(node.caller, state.bindings),
        );
        return;
      case 'Block': {
        const block = createCompiledFrame();
        visit(node.body, block.state);
        state.scope.bindBlockFrame(node, block.plan);
        return;
      }
      case 'Set':
        if (node.value) {
          visit(node.value, state);
        }
        if (node.body) {
          visit(node.body, state);
        }
        for (const target of node.targets) {
          useSlot(state, target);
        }
        return;
      case 'Switch':
        visit(node.expr, state);
        for (const candidate of node.cases) {
          visit(candidate, state);
        }
        if (node.default) {
          visit(node.default, state);
        }
        return;
      case 'Case':
        visit(node.cond, state);
        visit(node.body, state);
        return;
      case 'Capture':
        visit(node.body, state);
        return;
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
        visit(node.left, state);
        visit(node.right, state);
        return;
      case 'Not':
      case 'Neg':
      case 'Pos':
      case 'Floor':
        visit(node.target, state);
        return;
      case 'Compare':
        visit(node.expr, state);
        for (const operation of node.ops) {
          visit(operation, state);
        }
        return;
      case 'CompareOperand':
        visit(node.expr, state);
        return;
      case 'TemplateData':
      case 'Literal':
        return;
    }
  }

  const root = createCompiledFrame();
  visit(ast, root.state);
  for (const frame of frames) {
    Object.freeze(frame.slots);
  }
  return new LexicalSlotPlan(root.plan);
}
