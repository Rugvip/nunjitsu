import { isReservedName, type RuntimeValue } from './value.ts';

/** One interpreter-owned lexical scope containing no host object prototype. */
export class RuntimeScope {
  readonly #parent: RuntimeScope | undefined;
  readonly #isolateWrites: boolean;
  readonly #values = new Map<string, RuntimeValue>();
  readonly #writable = new Set<string>();

  constructor(parent?: RuntimeScope, isolateWrites = false) {
    this.#parent = parent;
    this.#isolateWrites = isolateWrites;
  }

  /** Creates a child lexical scope. */
  child(isolateWrites = false): RuntimeScope {
    return new RuntimeScope(this, isolateWrites);
  }

  /** Defines or replaces one value in this exact scope. */
  set(name: string, value: RuntimeValue): void {
    assertAllowedName(name);
    this.#values.set(name, value);
    this.#writable.add(name);
  }

  /** Defines one read-only context binding. */
  setReadonly(name: string, value: RuntimeValue): void {
    assertAllowedName(name);
    this.#values.set(name, value);
    this.#writable.delete(name);
  }

  /** Resolves a value through explicit scope parents only. */
  get(name: string): RuntimeValue | undefined {
    if (isReservedName(name)) {
      return undefined;
    }
    if (this.#values.has(name)) {
      return this.#values.get(name);
    }
    return this.#parent?.get(name);
  }

  /** Replaces the nearest existing binding or defines it locally. */
  assign(name: string, value: RuntimeValue): void {
    assertAllowedName(name);
    if (this.#isolateWrites) {
      this.#values.set(name, value);
      this.#writable.add(name);
      return;
    }
    if (this.#values.has(name) && this.#writable.has(name)) {
      this.#values.set(name, value);
      return;
    }
    if (this.#parent?.canAssign(name)) {
      this.#parent.assign(name, value);
      return;
    }
    this.#values.set(name, value);
    this.#writable.add(name);
  }

  /** Returns whether a binding exists through explicit parents. */
  has(name: string): boolean {
    if (isReservedName(name)) {
      return false;
    }
    return this.#values.has(name) || (this.#parent?.has(name) ?? false);
  }

  /** Returns bindings defined in this exact scope. */
  ownEntries(): IterableIterator<readonly [string, RuntimeValue]> {
    return this.#values.entries();
  }

  private canAssign(name: string): boolean {
    if (this.#values.has(name)) {
      return this.#writable.has(name);
    }
    if (this.#isolateWrites) {
      return false;
    }
    return this.#parent?.canAssign(name) ?? false;
  }
}

function assertAllowedName(name: string): void {
  if (isReservedName(name)) {
    throw new TypeError(`Template name ${name} is reserved`);
  }
}
