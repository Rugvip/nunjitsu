import { isReservedName, type RuntimeValue } from './value.ts';

/** One interpreter-owned lexical scope containing no host object prototype. */
export class RuntimeScope {
  readonly #parent: RuntimeScope | undefined;
  readonly #values = new Map<string, RuntimeValue>();

  constructor(parent?: RuntimeScope) {
    this.#parent = parent;
  }

  /** Creates a child lexical scope. */
  child(): RuntimeScope {
    return new RuntimeScope(this);
  }

  /** Defines or replaces one value in this exact scope. */
  set(name: string, value: RuntimeValue): void {
    assertAllowedName(name);
    this.#values.set(name, value);
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
    if (this.#values.has(name) || !this.#parent) {
      this.#values.set(name, value);
      return;
    }
    if (this.#parent.has(name)) {
      this.#parent.assign(name, value);
      return;
    }
    this.#values.set(name, value);
  }

  /** Returns whether a binding exists through explicit parents. */
  has(name: string): boolean {
    if (isReservedName(name)) {
      return false;
    }
    return this.#values.has(name) || (this.#parent?.has(name) ?? false);
  }
}

function assertAllowedName(name: string): void {
  if (isReservedName(name)) {
    throw new TypeError(`Template name ${name} is reserved`);
  }
}
