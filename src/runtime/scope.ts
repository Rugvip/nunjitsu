import { isReservedName, type RuntimeValue } from './value.ts';

/** One mutable binding stored entirely inside a runtime value frame. */
interface ScopeEntry {
  value: RuntimeValue;
  writable: boolean;
}

/** One interpreter-owned runtime value frame containing no host prototype. */
export class RuntimeScope {
  readonly #parent: RuntimeScope | undefined;
  readonly #isolateWrites: boolean;
  readonly #entries = new Map<string, ScopeEntry>();

  constructor(parent?: RuntimeScope, isolateWrites = false) {
    this.#parent = parent;
    this.#isolateWrites = isolateWrites;
  }

  /** Creates a child runtime value frame. */
  child(isolateWrites = false): RuntimeScope {
    return new RuntimeScope(this, isolateWrites);
  }

  /** Defines or replaces one value in this exact scope. */
  set(name: string, value: RuntimeValue): void {
    assertAllowedName(name);
    this.#entries.set(name, { value, writable: true });
  }

  /** Defines one read-only context binding. */
  setReadonly(name: string, value: RuntimeValue): void {
    assertAllowedName(name);
    this.#entries.set(name, { value, writable: false });
  }

  /** Resolves a value through explicit scope parents only. */
  get(name: string): RuntimeValue | undefined {
    if (isReservedName(name)) {
      return undefined;
    }
    const entry = this.#entries.get(name);
    if (entry) {
      return entry.value;
    }
    return this.#parent?.get(name);
  }

  /** Replaces the nearest existing binding or defines it locally. */
  assign(name: string, value: RuntimeValue): void {
    assertAllowedName(name);
    if (this.#isolateWrites) {
      this.#setLocal(name, value);
      return;
    }
    const entry = this.#entries.get(name);
    if (entry?.writable) {
      entry.value = value;
      return;
    }
    if (this.#parent?.canAssign(name)) {
      this.#parent.assign(name, value);
      return;
    }
    this.#setLocal(name, value);
  }

  /** Returns whether a binding exists through explicit parents. */
  has(name: string): boolean {
    if (isReservedName(name)) {
      return false;
    }
    return this.#entries.has(name) || (this.#parent?.has(name) ?? false);
  }

  /** Returns bindings defined in this exact scope. */
  *ownEntries(): IterableIterator<readonly [string, RuntimeValue]> {
    for (const [name, entry] of this.#entries) {
      yield [name, entry.value];
    }
  }

  private canAssign(name: string): boolean {
    const entry = this.#entries.get(name);
    if (entry) {
      return entry.writable;
    }
    if (this.#isolateWrites) {
      return false;
    }
    return this.#parent?.canAssign(name) ?? false;
  }

  #setLocal(name: string, value: RuntimeValue): void {
    const entry = this.#entries.get(name);
    if (entry) {
      entry.value = value;
      entry.writable = true;
    } else {
      this.#entries.set(name, { value, writable: true });
    }
  }
}

function assertAllowedName(name: string): void {
  if (isReservedName(name)) {
    throw new TypeError(`Template name ${name} is reserved`);
  }
}
