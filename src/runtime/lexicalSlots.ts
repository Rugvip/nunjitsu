import type { AstCallableBodyNode, AstNode } from '../parser/ast.ts';
import type { RuntimeValue } from './value.ts';

/** Mutable slot inventory used only while building one frame plan. */
interface MutableLexicalFramePlan {
  readonly slots: number[];
}

/** One static traversal state with the slots visible at its current position. */
interface LexicalFrameState {
  readonly plan: MutableLexicalFramePlan;
  readonly bindings: Map<string, number>;
}

/** Static compiler-slot assignments for one complete immutable AST. */
export class LexicalSlotPlan {
  readonly #rootSlots: readonly number[];
  readonly #frameSlots: WeakMap<AstNode, readonly number[]>;
  readonly #nodeSlots: WeakMap<AstNode, number>;

  constructor(
    rootSlots: readonly number[],
    frameSlots: WeakMap<AstNode, readonly number[]>,
    nodeSlots: WeakMap<AstNode, number>,
  ) {
    this.#rootSlots = rootSlots;
    this.#frameSlots = frameSlots;
    this.#nodeSlots = nodeSlots;
  }

  /** Returns the slots owned by the root compiled frame. */
  rootSlots(): readonly number[] {
    return this.#rootSlots;
  }

  /** Returns the slots owned by one nested compiled frame. */
  frameSlots(node: AstNode): readonly number[] {
    const slots = this.#frameSlots.get(node);
    if (!slots) {
      throw new Error(`Missing lexical frame plan for ${node.type}`);
    }
    return slots;
  }

  /** Returns the direct slot selected for one reference or binding node. */
  slot(node: AstNode): number | undefined {
    return this.#nodeSlots.get(node);
  }
}

/** One invocation-local set of statically allocated compiler slots. */
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

  /** Replaces one exact slot in the frame that owns it. */
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
export function planLexicalSlots(ast: AstNode): LexicalSlotPlan {
  const frameSlots = new WeakMap<AstNode, readonly number[]>();
  const nodeSlots = new WeakMap<AstNode, number>();
  const frames: Array<readonly [AstNode, MutableLexicalFramePlan]> = [];
  let nextSlot = 0;

  const createFrame = (
    owner: AstNode,
    inherited?: ReadonlyMap<string, number>,
  ): LexicalFrameState => {
    const plan: MutableLexicalFramePlan = { slots: [] };
    frames.push([owner, plan]);
    return {
      plan,
      bindings: new Map(inherited),
    };
  };

  const createSlot = (
    state: LexicalFrameState,
    name: string,
    node: AstNode,
  ): number => {
    const slot = nextSlot;
    nextSlot += 1;
    state.plan.slots.push(slot);
    state.bindings.set(name, slot);
    nodeSlots.set(node, slot);
    return slot;
  };

  const useSlot = (state: LexicalFrameState, node: AstNode): void => {
    if (node.type !== 'Symbol') {
      throw new Error(`Expected symbol, received ${node.type}`);
    }
    const slot = state.bindings.get(node.value);
    if (slot !== undefined) {
      nodeSlots.set(node, slot);
    }
  };

  const planCallable = (
    node: AstCallableBodyNode,
    inherited?: ReadonlyMap<string, number>,
  ): void => {
    const state = createFrame(node, inherited);
    if (node.args.type !== 'NodeList') {
      throw new Error('Invalid callable argument list');
    }
    const boundNames = new Set<string>();
    for (const argument of node.args.children) {
      if (argument.type === 'KeywordArgs') {
        for (const pair of argument.children) {
          if (pair.type !== 'Pair' || pair.key.type !== 'Symbol') {
            throw new Error('Invalid callable default');
          }
          visit(pair.value, state);
          const name = pair.key.value;
          if (!boundNames.has(name)) {
            state.bindings.delete(name);
            boundNames.add(name);
          }
        }
      } else {
        if (argument.type !== 'Symbol') {
          throw new Error('Invalid callable formal');
        }
        const name = argument.value;
        if (!boundNames.has(name)) {
          createSlot(state, name, argument);
          boundNames.add(name);
        }
      }
    }
    visit(node.body, state);
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

  function visit(node: AstNode, state: LexicalFrameState): void {
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
        const loopState = createFrame(node, state.bindings);
        const targets = node.name.type === 'Array' ? node.name.children : [node.name];
        for (const target of targets) {
          if (target.type !== 'Symbol') {
            throw new Error(`Invalid loop target ${target.type}`);
          }
          createSlot(loopState, target.value, target);
        }
        visit(node.body, loopState);
        if (node.else_) {
          visit(node.else_, loopState);
        }
        return;
      }
      case 'Macro': {
        if (node.name.type !== 'Symbol') {
          throw new Error('Invalid macro name');
        }
        const slot = createSlot(state, node.name.value, node);
        nodeSlots.set(node.name, slot);
        planCallable(node);
        return;
      }
      case 'Caller':
        planCallable(node, state.bindings);
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
        planCallable(node.caller, state.bindings);
        return;
      case 'Block': {
        const blockState = createFrame(node);
        visit(node.body, blockState);
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

  const rootState = createFrame(ast);
  visit(ast, rootState);
  for (const [owner, frame] of frames) {
    frameSlots.set(owner, Object.freeze(Array.from(frame.slots)));
  }
  const rootSlots = frameSlots.get(ast);
  if (!rootSlots) {
    throw new Error('Missing root lexical frame plan');
  }
  return new LexicalSlotPlan(rootSlots, frameSlots, nodeSlots);
}
