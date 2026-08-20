import { types } from 'node:util';

import type { TemplateValue } from '../values.ts';

/** Names denied throughout the interpreter to eliminate prototype gadget paths. */
export const reservedNames = Object.freeze(new Set([
  'constructor',
  'prototype',
  '__proto__',
]));

/** Hard ceiling for structured entries traversed by one safe-value copy. */
export const maximumSafeValueEntries = 100_000;

/** Hard ceiling for nested array and record levels in closed values. */
export const maximumSafeValueDepth = 256;

/** Hard ceiling for one prepared-context update path. */
export const maximumPreparedContextPathSegments = maximumSafeValueDepth;

/** Primitive values owned directly by the interpreter. */
export type RuntimePrimitive = undefined | null | boolean | number | string;

/** Closed value variants accepted by the interpreter. */
export type RuntimeValue =
  | RuntimePrimitive
  | RuntimeSafeString
  | RuntimeArray
  | RuntimeRecord
  | RuntimeMap
  | RuntimeSet
  | RuntimeRegex
  | RuntimeCallable;

/** Charges one logical recursive expansion of an interpreter-owned value. */
export type RuntimeWorkCharge = () => void;

/** An interpreter string carrying Nunjucks safe-filter semantics. */
export class RuntimeSafeString {
  readonly kind = 'safe-string';

  /** Trusted string content. */
  readonly value: string;

  constructor(value: string) {
    this.value = value;
    Object.freeze(this);
  }
}

abstract class RuntimeContainerValue {
  #parents: Map<RuntimeContainerValue, number> | undefined;

  abstract refreshMetadata(): void;

  abstract containsMutable(): boolean;

  addRuntimeParent(parent: RuntimeContainerValue): void {
    this.#parents ??= new Map();
    this.#parents.set(parent, (this.#parents.get(parent) ?? 0) + 1);
  }

  removeRuntimeParent(parent: RuntimeContainerValue): void {
    const count = this.#parents?.get(parent);
    if (count === undefined) {
      return;
    }
    if (count === 1) {
      this.#parents?.delete(parent);
    } else {
      this.#parents?.set(parent, count - 1);
    }
  }

  runtimeParents(): Iterable<RuntimeContainerValue> {
    return this.#parents?.keys() ?? emptyRuntimeContainerParents;
  }
}

const emptyRuntimeContainerParents: readonly RuntimeContainerValue[] = Object.freeze([]);

/** A renderer-owned array whose mutations remain confined to one evaluation. */
export class RuntimeArray extends RuntimeContainerValue {
  readonly kind = 'array';
  #items: readonly RuntimeValue[] = [];
  #present: Set<number> | undefined;
  #containsCallable = false;
  #nestingDepth = 1;

  constructor(items: readonly RuntimeValue[]) {
    super();
    this.#replace(items, false);
    Object.freeze(this);
  }

  /** Replaces the sparse contents after validating closed-container invariants. */
  replace(items: readonly RuntimeValue[]): void {
    this.#replace(items, true);
  }

  #replace(items: readonly RuntimeValue[], validateContainment: boolean): void {
    if (types.isProxy(items)) {
      throw new TypeError('Proxy objects cannot be used as runtime arrays');
    }
    if (!Array.isArray(items)) {
      throw new TypeError('Runtime arrays require an array');
    }
    assertRuntimeContainerSize(items.length);
    const copied: RuntimeValue[] = [];
    copied.length = items.length;
    const present = new Set<number>();
    let containsCallable = false;
    let nestingDepth = 1;
    for (let index = 0; index < items.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(items, `${index}`);
      if (descriptor === undefined) {
        defineOwnArrayIndex(copied, index, undefined);
        continue;
      }
      if (!('value' in descriptor)) {
        throw new TypeError('Runtime arrays cannot contain accessors');
      }
      const value = descriptor.value as RuntimeValue;
      if (validateContainment) {
        assertRuntimeValueCanBeContained(this, value);
      }
      defineOwnArrayIndex(copied, index, value);
      present.add(index);
      containsCallable ||= runtimeValueContainsCallable(value);
      nestingDepth = Math.max(nestingDepth, runtimeValueNestingDepth(value) + 1);
    }
    assertRuntimeValueDepth(nestingDepth + maximumRuntimeParentDepth(this));
    for (const value of this.presentValues()) {
      unregisterRuntimeContainerParent(this, value);
    }
    this.#items = Object.freeze(copied);
    this.#present = present.size === copied.length ? undefined : present;
    this.#containsCallable = containsCallable;
    this.#nestingDepth = nestingDepth;
    for (const value of this.presentValues()) {
      registerRuntimeContainerParent(this, value);
    }
    refreshRuntimeContainerParents(this);
  }

  /** Number of contained values. */
  get length(): number {
    return this.#items.length;
  }

  /** Returns one contained value without invoking host behavior. */
  at(index: number): RuntimeValue | undefined {
    return this.#items[index];
  }

  /** Returns whether one numeric position is an own present element. */
  has(index: number): boolean {
    return Number.isInteger(index) &&
      index >= 0 &&
      index < this.#items.length &&
      (this.#present === undefined || this.#present.has(index));
  }

  /** Iterates every numeric position, exposing holes as `undefined`. */
  *values(): IterableIterator<RuntimeValue> {
    for (let index = 0; index < this.#items.length; index += 1) {
      yield this.#items[index];
    }
  }

  /** Iterates only present elements, skipping sparse holes. */
  *presentValues(): IterableIterator<RuntimeValue> {
    for (let index = 0; index < this.#items.length; index += 1) {
      if (this.has(index)) {
        yield this.#items[index];
      }
    }
  }

  /** Returns whether any present element transitively contains callable authority. */
  containsCallable(): boolean {
    return this.#containsCallable;
  }

  containsMutable(): boolean {
    return true;
  }

  /** Returns the deepest closed container level including this array. */
  nestingDepth(): number {
    return this.#nestingDepth;
  }

  /** Returns a mutable sparse copy without exposing interpreter storage. */
  copySparse(): RuntimeValue[] {
    const output: RuntimeValue[] = [];
    output.length = this.#items.length;
    for (let index = 0; index < this.#items.length; index += 1) {
      if (this.has(index)) {
        defineOwnArrayIndex(output, index, this.#items[index]);
      }
    }
    return output;
  }

  /** Refreshes metadata after a nested mutable container changes. */
  refreshMetadata(): void {
    let containsCallable = false;
    let nestingDepth = 1;
    for (const value of this.presentValues()) {
      containsCallable ||= runtimeValueContainsCallable(value);
      nestingDepth = Math.max(nestingDepth, runtimeValueNestingDepth(value) + 1);
    }
    this.#containsCallable = containsCallable;
    this.#nestingDepth = nestingDepth;
  }
}

/** A renderer-owned Map snapshot with closed keys and values. */
export class RuntimeMap extends RuntimeContainerValue {
  readonly kind = 'map';
  readonly #entries = new Map<RuntimeValue, RuntimeValue>();
  #containsCallable = false;
  #nestingDepth = 1;

  constructor(entries: Iterable<readonly [RuntimeValue, RuntimeValue]>) {
    super();
    for (const [key, value] of entries) {
      assertAllowedRuntimeMapKey(key);
      this.#entries.set(key, value);
      assertRuntimeContainerSize(this.#entries.size);
    }
    for (const [key, value] of this.#entries) {
      this.#containsCallable ||= runtimeValueContainsCallable(key) ||
        runtimeValueContainsCallable(value);
      this.#nestingDepth = Math.max(
        this.#nestingDepth,
        runtimeValueNestingDepth(key) + 1,
        runtimeValueNestingDepth(value) + 1,
      );
      registerRuntimeContainerParent(this, key);
      registerRuntimeContainerParent(this, value);
    }
    assertRuntimeValueDepth(this.#nestingDepth);
    Object.freeze(this);
  }

  /** Number of contained entries. */
  get size(): number {
    return this.#entries.size;
  }

  /** Returns one value using SameValueZero key identity. */
  get(key: RuntimeValue): RuntimeValue | undefined {
    return this.#entries.get(key);
  }

  /** Returns whether one key exists using SameValueZero identity. */
  has(key: RuntimeValue): boolean {
    return this.#entries.has(key);
  }

  /** Adds or replaces one closed entry. */
  set(key: RuntimeValue, value: RuntimeValue): this {
    assertAllowedRuntimeMapKey(key);
    const replacing = this.#entries.has(key);
    if (!replacing) {
      assertRuntimeContainerSize(this.#entries.size + 1);
    }
    assertRuntimeValueCanBeContained(this, key);
    assertRuntimeValueCanBeContained(this, value);
    let containsCallable = this.#containsCallable;
    let nestingDepth = this.#nestingDepth;
    if (replacing) {
      ({ containsCallable, nestingDepth } = this.#metadataWith(key, value));
    } else {
      containsCallable ||= runtimeValueContainsCallable(key) ||
        runtimeValueContainsCallable(value);
      nestingDepth = Math.max(
        nestingDepth,
        runtimeValueNestingDepth(key) + 1,
        runtimeValueNestingDepth(value) + 1,
      );
    }
    assertRuntimeValueDepth(nestingDepth + maximumRuntimeParentDepth(this));
    if (replacing) {
      unregisterRuntimeContainerParent(this, this.#entries.get(key));
    } else {
      registerRuntimeContainerParent(this, key);
    }
    this.#entries.set(key, value);
    registerRuntimeContainerParent(this, value);
    this.#containsCallable = containsCallable;
    this.#nestingDepth = nestingDepth;
    refreshRuntimeContainerParents(this);
    return this;
  }

  /** Removes one entry. */
  delete(key: RuntimeValue): boolean {
    if (!this.#entries.has(key)) {
      return false;
    }
    const value = this.#entries.get(key);
    const deleted = this.#entries.delete(key);
    if (deleted) {
      unregisterRuntimeContainerParent(this, key);
      unregisterRuntimeContainerParent(this, value);
      this.refreshMetadata();
      refreshRuntimeContainerParents(this);
    }
    return deleted;
  }

  /** Removes every entry. */
  clear(): void {
    for (const [key, value] of this.#entries) {
      unregisterRuntimeContainerParent(this, key);
      unregisterRuntimeContainerParent(this, value);
    }
    this.#entries.clear();
    this.#containsCallable = false;
    this.#nestingDepth = 1;
    refreshRuntimeContainerParents(this);
  }

  /** Iterates entries in insertion order. */
  entries(): IterableIterator<[RuntimeValue, RuntimeValue]> {
    return this.#entries.entries();
  }

  /** Iterates keys in insertion order. */
  keys(): IterableIterator<RuntimeValue> {
    return this.#entries.keys();
  }

  /** Iterates values in insertion order. */
  values(): IterableIterator<RuntimeValue> {
    return this.#entries.values();
  }

  /** Returns whether any key or value transitively contains callable authority. */
  containsCallable(): boolean {
    return this.#containsCallable;
  }

  containsMutable(): boolean {
    return true;
  }

  /** Returns the deepest closed container level including this Map. */
  nestingDepth(): number {
    return this.#nestingDepth;
  }

  /** Refreshes metadata after a nested mutable container changes. */
  refreshMetadata(): void {
    let containsCallable = false;
    let nestingDepth = 1;
    for (const [key, value] of this.#entries) {
      containsCallable ||= runtimeValueContainsCallable(key) ||
        runtimeValueContainsCallable(value);
      nestingDepth = Math.max(
        nestingDepth,
        runtimeValueNestingDepth(key) + 1,
        runtimeValueNestingDepth(value) + 1,
      );
    }
    this.#containsCallable = containsCallable;
    this.#nestingDepth = nestingDepth;
  }

  #metadataWith(
    key: RuntimeValue,
    replacement: RuntimeValue,
  ): { readonly containsCallable: boolean; readonly nestingDepth: number } {
    let containsCallable = false;
    let nestingDepth = 1;
    for (const [entryKey, entryValue] of this.#entries) {
      const value = sameRuntimeMapKey(entryKey, key) ? replacement : entryValue;
      containsCallable ||= runtimeValueContainsCallable(entryKey) ||
        runtimeValueContainsCallable(value);
      nestingDepth = Math.max(
        nestingDepth,
        runtimeValueNestingDepth(entryKey) + 1,
        runtimeValueNestingDepth(value) + 1,
      );
    }
    return { containsCallable, nestingDepth };
  }
}

/** A renderer-owned Set snapshot with closed values. */
export class RuntimeSet extends RuntimeContainerValue {
  readonly kind = 'set';
  readonly #values = new Set<RuntimeValue>();
  #containsCallable = false;
  #nestingDepth = 1;

  constructor(values: Iterable<RuntimeValue>) {
    super();
    for (const value of values) {
      this.#values.add(value);
      assertRuntimeContainerSize(this.#values.size);
    }
    for (const value of this.#values) {
      this.#containsCallable ||= runtimeValueContainsCallable(value);
      this.#nestingDepth = Math.max(
        this.#nestingDepth,
        runtimeValueNestingDepth(value) + 1,
      );
      registerRuntimeContainerParent(this, value);
    }
    assertRuntimeValueDepth(this.#nestingDepth);
    Object.freeze(this);
  }

  /** Number of contained values. */
  get size(): number {
    return this.#values.size;
  }

  /** Returns whether one value exists using SameValueZero identity. */
  has(value: RuntimeValue): boolean {
    return this.#values.has(value);
  }

  /** Adds one closed value. */
  add(value: RuntimeValue): this {
    if (this.#values.has(value)) {
      return this;
    }
    assertRuntimeContainerSize(this.#values.size + 1);
    assertRuntimeValueCanBeContained(this, value);
    const nestingDepth = Math.max(
      this.#nestingDepth,
      runtimeValueNestingDepth(value) + 1,
    );
    assertRuntimeValueDepth(nestingDepth + maximumRuntimeParentDepth(this));
    this.#values.add(value);
    registerRuntimeContainerParent(this, value);
    this.#containsCallable ||= runtimeValueContainsCallable(value);
    this.#nestingDepth = nestingDepth;
    refreshRuntimeContainerParents(this);
    return this;
  }

  /** Removes one value. */
  delete(value: RuntimeValue): boolean {
    const deleted = this.#values.delete(value);
    if (deleted) {
      unregisterRuntimeContainerParent(this, value);
      this.refreshMetadata();
      refreshRuntimeContainerParents(this);
    }
    return deleted;
  }

  /** Removes every value. */
  clear(): void {
    for (const value of this.#values) {
      unregisterRuntimeContainerParent(this, value);
    }
    this.#values.clear();
    this.#containsCallable = false;
    this.#nestingDepth = 1;
    refreshRuntimeContainerParents(this);
  }

  /** Iterates values in insertion order. */
  values(): IterableIterator<RuntimeValue> {
    return this.#values.values();
  }

  /** Returns whether any value transitively contains callable authority. */
  containsCallable(): boolean {
    return this.#containsCallable;
  }

  containsMutable(): boolean {
    return true;
  }

  /** Returns the deepest closed container level including this Set. */
  nestingDepth(): number {
    return this.#nestingDepth;
  }

  /** Refreshes metadata after a nested mutable container changes. */
  refreshMetadata(): void {
    let containsCallable = false;
    let nestingDepth = 1;
    for (const value of this.#values) {
      containsCallable ||= runtimeValueContainsCallable(value);
      nestingDepth = Math.max(nestingDepth, runtimeValueNestingDepth(value) + 1);
    }
    this.#containsCallable = containsCallable;
    this.#nestingDepth = nestingDepth;
  }
}

/** An immutable interpreter-owned string-keyed record. */
export class RuntimeRecord extends RuntimeContainerValue {
  readonly kind = 'record';
  readonly #entries: ReadonlyMap<string, RuntimeValue>;
  #containsCallable: boolean;
  readonly #containsMutable: boolean;
  #nestingDepth: number;

  constructor(entries: Iterable<readonly [string, RuntimeValue]>) {
    super();
    const indexedEntries = new Map<string, RuntimeValue>();
    const namedEntries = new Map<string, RuntimeValue>();
    let entryCount = 0;
    for (const [name, value] of entries) {
      entryCount += 1;
      assertRuntimeContainerSize(entryCount);
      if (isReservedName(name)) {
        throw new TypeError(`Template record key ${name} is reserved`);
      }
      const target = isCanonicalArrayIndex(name) ? indexedEntries : namedEntries;
      target.set(name, value);
    }
    if (indexedEntries.size === 0) {
      this.#entries = namedEntries;
    } else {
      const orderedEntries = Array.from(indexedEntries.entries());
      orderedEntries.sort(([left], [right]) => Number(left) - Number(right));
      for (const entry of namedEntries) {
        orderedEntries.push(entry);
      }
      this.#entries = new Map(orderedEntries);
    }
    let containsCallable = false;
    let containsMutable = false;
    let nestingDepth = 1;
    for (const value of this.#entries.values()) {
      containsCallable ||= runtimeValueContainsCallable(value);
      containsMutable ||= runtimeValueContainsMutable(value);
      nestingDepth = Math.max(nestingDepth, runtimeValueNestingDepth(value) + 1);
    }
    assertRuntimeValueDepth(nestingDepth);
    this.#containsCallable = containsCallable;
    this.#containsMutable = containsMutable;
    this.#nestingDepth = nestingDepth;
    for (const value of this.#entries.values()) {
      registerRuntimeContainerParent(this, value);
    }
    Object.freeze(this);
  }

  /** Number of contained entries. */
  get size(): number {
    return this.#entries.size;
  }

  /** Returns one own entry; reserved names always fail closed. */
  get(name: string): RuntimeValue | undefined {
    if (isReservedName(name)) {
      return undefined;
    }
    return this.#entries.get(name);
  }

  /** Returns whether one allowed own entry exists. */
  has(name: string): boolean {
    return !isReservedName(name) && this.#entries.has(name);
  }

  /** Iterates array indices numerically, then named entries by first insertion. */
  entries(): IterableIterator<[string, RuntimeValue]> {
    return this.#entries.entries();
  }

  /** Returns whether any own entry transitively contains callable authority. */
  containsCallable(): boolean {
    return this.#containsCallable;
  }

  containsMutable(): boolean {
    return this.#containsMutable;
  }

  /** Returns the deepest closed container level including this record. */
  nestingDepth(): number {
    return this.#nestingDepth;
  }

  /** Returns a derived record with one allowed own entry replaced. */
  with(name: string, value: RuntimeValue): RuntimeRecord {
    if (isReservedName(name)) {
      throw new TypeError(`Template record key ${name} is reserved`);
    }
    const entries = new Map(this.#entries);
    entries.set(name, value);
    return new RuntimeRecord(entries);
  }

  /** Refreshes metadata after a nested mutable container changes. */
  refreshMetadata(): void {
    let containsCallable = false;
    let nestingDepth = 1;
    for (const value of this.#entries.values()) {
      containsCallable ||= runtimeValueContainsCallable(value);
      nestingDepth = Math.max(nestingDepth, runtimeValueNestingDepth(value) + 1);
    }
    this.#containsCallable = containsCallable;
    this.#nestingDepth = nestingDepth;
  }
}

/** An inert regular-expression literal interpreted only by approved built-ins. */
export class RuntimeRegex {
  readonly kind = 'regex';
  readonly source: string;
  readonly flags: string;
  #lastIndex = 0;

  constructor(source: string, flags: string) {
    this.source = source;
    this.flags = flags;
    Object.freeze(this);
  }

  /** Current closed state for global or sticky regex execution. */
  get lastIndex(): number {
    return this.#lastIndex;
  }

  /** Updates closed regex state after an approved native execution. */
  setLastIndex(lastIndex: number): void {
    this.#lastIndex = lastIndex;
  }
}

const canonicalRegexFlags = 'gimy';

/** Returns the canonical inert spelling of one regex without invoking host regex behavior. */
export function runtimeRegexToString(value: RuntimeRegex): string {
  let source = '';
  if (value.source === '') {
    source = '(?:)';
  } else {
    for (let index = 0; index < value.source.length; index += 1) {
      const character = value.source[index]!;
      if (character === '\n') {
        source += '\\n';
      } else if (character === '\r') {
        source += '\\r';
      } else if (character === '\u2028') {
        source += '\\u2028';
      } else if (character === '\u2029') {
        source += '\\u2029';
      } else {
        source += character;
      }
    }
  }

  let flags = '';
  for (let flagIndex = 0; flagIndex < canonicalRegexFlags.length; flagIndex += 1) {
    const expected = canonicalRegexFlags[flagIndex]!;
    for (let index = 0; index < value.flags.length; index += 1) {
      if (value.flags[index] === expected) {
        flags += expected;
        break;
      }
    }
  }
  return `/${source}/${flags}`;
}

/** Closed categories of behavior the interpreter may invoke. */
export type RuntimeCallableKind = 'macro' | 'caller' | 'builtin' | 'capability';

/** An unforgeable interpreter-owned callable identity containing no function. */
export class RuntimeCallable {
  readonly kind = 'callable';
  readonly callableKind: RuntimeCallableKind;
  readonly id: number;

  constructor(callableKind: RuntimeCallableKind, id: number) {
    this.callableKind = callableKind;
    this.id = id;
    Object.freeze(this);
  }
}

type RuntimeContainer = RuntimeContainerValue;

function runtimeContainer(value: RuntimeValue): RuntimeContainer | undefined {
  return value instanceof RuntimeContainerValue ? value : undefined;
}

function registerRuntimeContainerParent(
  parent: RuntimeContainer,
  value: RuntimeValue,
): void {
  const child = runtimeContainer(value);
  if (!child?.containsMutable()) {
    return;
  }
  child.addRuntimeParent(parent);
}

function unregisterRuntimeContainerParent(
  parent: RuntimeContainer,
  value: RuntimeValue,
): void {
  const child = runtimeContainer(value);
  if (!child?.containsMutable()) {
    return;
  }
  child.removeRuntimeParent(parent);
}

function maximumRuntimeParentDepth(value: RuntimeContainer): number {
  let maximum = 0;
  const pending: Array<readonly [RuntimeContainer, number]> = [[value, 0]];
  const depths = new Map<RuntimeContainer, number>();
  while (pending.length > 0) {
    const [child, depth] = pending.pop()!;
    for (const parent of child.runtimeParents()) {
      const parentDepth = depth + 1;
      if (parentDepth <= (depths.get(parent) ?? -1)) {
        continue;
      }
      depths.set(parent, parentDepth);
      maximum = Math.max(maximum, parentDepth);
      pending.push([parent, parentDepth]);
    }
  }
  return maximum;
}

function refreshRuntimeContainerParents(value: RuntimeContainer): void {
  const depths = new Map<RuntimeContainer, number>();
  const pending: Array<readonly [RuntimeContainer, number]> = [[value, 0]];
  while (pending.length > 0) {
    const [child, depth] = pending.pop()!;
    for (const parent of child.runtimeParents()) {
      const parentDepth = depth + 1;
      if (parentDepth <= (depths.get(parent) ?? -1)) {
        continue;
      }
      depths.set(parent, parentDepth);
      pending.push([parent, parentDepth]);
    }
  }
  const ancestors = Array.from(depths.entries());
  ancestors.sort(([, left], [, right]) => left - right);
  for (const [ancestor] of ancestors) {
    ancestor.refreshMetadata();
  }
}

function sameRuntimeMapKey(left: RuntimeValue, right: RuntimeValue): boolean {
  return left === right || (
    typeof left === 'number' &&
    typeof right === 'number' &&
    Number.isNaN(left) &&
    Number.isNaN(right)
  );
}

/** Returns whether a name is forbidden at every template boundary. */
export function isReservedName(name: string): boolean {
  return reservedNames.has(name);
}

/** Returns whether a key is a canonical JavaScript array index. */
export function isCanonicalArrayIndex(name: string): boolean {
  const index = Number(name);
  return Number.isInteger(index) &&
    index >= 0 &&
    index < 0xffff_ffff &&
    `${index}` === name;
}

/** Defines one enumerable own array index without invoking an inherited setter. */
export function defineOwnArrayIndex<T>(target: T[], index: number, value: T): void {
  Object.defineProperty(target, index, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Copies one public safe value graph into interpreter-owned values. */
export function copyRuntimeValue(value: TemplateValue | undefined): RuntimeValue {
  return copyValue(value, createSafeValueCopyState(), 0);
}

/** Clones one already closed value graph for isolated render-local mutation. */
export function cloneRuntimeValue(value: RuntimeValue): RuntimeValue {
  return cloneValue(value, new Map());
}

/** Clones one already closed context for isolated render-local mutation. */
export function cloneRuntimeContext(context: RuntimeRecord): RuntimeRecord {
  const cloned = cloneRuntimeValue(context);
  if (!(cloned instanceof RuntimeRecord)) {
    throw new TypeError('Runtime context must be a record');
  }
  return cloned;
}

/** Copies a root context record into interpreter-owned values. */
export function copyRuntimeContext(
  context: Readonly<Record<string, TemplateValue>>,
): RuntimeRecord {
  if (types.isProxy(context)) {
    throw new TypeError('Proxy objects cannot be used as template values');
  }
  const rootEntries = Reflect.ownKeys(context).length;
  assertRuntimeContainerSize(rootEntries);
  const state = createSafeValueCopyState();
  // The bounded root namespace is accounted separately from its nested value graph.
  state.remainingEntries += rootEntries;
  const copied = copyValue(context, state, 0);
  if (!(copied instanceof RuntimeRecord)) {
    throw new TypeError('Template context must be a plain record');
  }
  return copied;
}

/** Derives a context by replacing one nested path with an already copied value. */
export function withRuntimeContextPath(
  context: RuntimeRecord,
  path: readonly string[],
  value: RuntimeValue,
): RuntimeRecord {
  if (!Array.isArray(path) || path.length === 0) {
    throw new TypeError('Prepared context update path must be a non-empty array');
  }
  if (path.length > maximumPreparedContextPathSegments) {
    throw new RangeError(
      `Prepared context update paths cannot exceed ${maximumPreparedContextPathSegments} segments`,
    );
  }
  const names = path.map(name => {
    if (typeof name !== 'string') {
      throw new TypeError('Prepared context update path must contain only strings');
    }
    if (isReservedName(name)) {
      throw new TypeError(`Template record key ${name} is reserved`);
    }
    return name;
  });
  return replaceRuntimeContextPath(context, names, 0, value);
}

/** Copies an internal value for a trusted host callback without leaking internals. */
export function copyPublicValue(value: RuntimeValue): TemplateValue | undefined {
  return toPublicValue(value, createPublicValueCopyState(), 0);
}

/** Copies an internal value while charging every traversed structured slot. */
export function copyPublicValueWithWork(
  value: RuntimeValue,
  chargeWork: RuntimeWorkCharge,
): TemplateValue | undefined {
  return toPublicValue(value, createPublicValueCopyState(), 0, chargeWork);
}

/** Explicit string coercion over closed value variants. */
export function renderRuntimeValue(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): string {
  assertRuntimeValueHasNoCallable(value);
  return renderRuntimeValueUnchecked(value, chargeWork);
}

/** Measures closed string rendering without allocating the rendered value. */
export function renderedRuntimeValueCodeUnits(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): number {
  assertRuntimeValueHasNoCallable(value);
  return renderedRuntimeValueCodeUnitsUnchecked(value, chargeWork);
}

/** Rejects callable identities anywhere inside a closed value graph. */
export function assertRuntimeValueHasNoCallable(value: RuntimeValue): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (value instanceof RuntimeCallable) {
    throw new TypeError('Callable values cannot be coerced');
  }
  if (
    (
      value instanceof RuntimeArray ||
      value instanceof RuntimeRecord ||
      value instanceof RuntimeMap ||
      value instanceof RuntimeSet
    ) &&
    value.containsCallable()
  ) {
    throw new TypeError('Callable values cannot be coerced');
  }
}

function runtimeValueContainsCallable(value: RuntimeValue): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (value instanceof RuntimeCallable) {
    return true;
  }
  if (
    value instanceof RuntimeArray ||
    value instanceof RuntimeRecord ||
    value instanceof RuntimeMap ||
    value instanceof RuntimeSet
  ) {
    return value.containsCallable();
  }
  return false;
}

function runtimeValueContainsMutable(value: RuntimeValue): boolean {
  return runtimeContainer(value)?.containsMutable() ?? false;
}

function runtimeValueNestingDepth(value: RuntimeValue): number {
  if (
    value instanceof RuntimeArray ||
    value instanceof RuntimeRecord ||
    value instanceof RuntimeMap ||
    value instanceof RuntimeSet
  ) {
    return value.nestingDepth();
  }
  return 0;
}

function renderRuntimeValueUnchecked(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'NaN';
    }
    if (value === Number.POSITIVE_INFINITY) {
      return 'Infinity';
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return '-Infinity';
    }
    return `${value}`;
  }
  if (value instanceof RuntimeSafeString) {
    return value.value;
  }
  if (value instanceof RuntimeArray) {
    const output: string[] = [];
    for (const item of value.values()) {
      chargeWork?.();
      output.push(renderRuntimeValueUnchecked(item, chargeWork));
    }
    return output.join(',');
  }
  if (value instanceof RuntimeRecord) {
    return '[object Object]';
  }
  if (value instanceof RuntimeMap) {
    return '[object Map]';
  }
  if (value instanceof RuntimeSet) {
    return '[object Set]';
  }
  if (value instanceof RuntimeRegex) {
    return runtimeRegexToString(value);
  }
  throw new TypeError('Callable values cannot be rendered');
}

function renderedRuntimeValueCodeUnitsUnchecked(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value === 'string') {
    return value.length;
  }
  if (typeof value === 'boolean') {
    return value ? 4 : 5;
  }
  if (typeof value === 'number') {
    return renderRuntimeValueUnchecked(value).length;
  }
  if (value instanceof RuntimeSafeString) {
    return value.value.length;
  }
  if (value instanceof RuntimeArray) {
    let codeUnits = Math.max(0, value.length - 1);
    for (const item of value.values()) {
      chargeWork?.();
      codeUnits += renderedRuntimeValueCodeUnitsUnchecked(item, chargeWork);
    }
    return codeUnits;
  }
  if (value instanceof RuntimeRecord) {
    return 15;
  }
  if (value instanceof RuntimeMap) {
    return 12;
  }
  if (value instanceof RuntimeSet) {
    return 12;
  }
  if (value instanceof RuntimeRegex) {
    return runtimeRegexToString(value).length;
  }
  throw new TypeError('Callable values cannot be rendered');
}

/** Explicit truthiness over closed value variants. */
export function runtimeTruthy(value: RuntimeValue): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === 'number') {
    return value !== 0 && !Number.isNaN(value);
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (value instanceof RuntimeSafeString) {
    return true;
  }
  return true;
}

interface SafeValueCopyState {
  readonly ancestors: Set<object>;
  readonly aliases: Map<object, RuntimeValue>;
  remainingEntries: number;
}

function createSafeValueCopyState(): SafeValueCopyState {
  return {
    ancestors: new Set(),
    aliases: new Map(),
    remainingEntries: maximumSafeValueEntries,
  };
}

function copyValue(
  value: TemplateValue | undefined,
  state: SafeValueCopyState,
  parentDepth: number,
): RuntimeValue {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported template value of type ${typeof value}`);
  }
  if (types.isProxy(value)) {
    throw new TypeError('Proxy objects cannot be used as template values');
  }
  assertRuntimeValueDepth(parentDepth + 1);
  if (state.ancestors.has(value)) {
    throw new TypeError('Cyclic template values are not supported');
  }
  const existing = state.aliases.get(value);
  if (existing !== undefined) {
    return existing;
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Template arrays cannot use a custom prototype');
      }
      assertRuntimeContainerSize(value.length);
      reserveSafeValueEntries(state, value.length);
      validateArrayKeys(value);
      const items: RuntimeValue[] = [];
      items.length = value.length;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor !== undefined) {
          defineOwnArrayIndex(
            items,
            index,
            copyDataDescriptor(descriptor, state, parentDepth + 1),
          );
        }
      }
      const copied = new RuntimeArray(items);
      state.aliases.set(value, copied);
      return copied;
    }

    if (types.isMap(value)) {
      const map = value as Map<unknown, unknown>;
      if (Object.getPrototypeOf(value) !== Map.prototype) {
        throw new TypeError('Template Maps cannot use a custom prototype');
      }
      if (Reflect.ownKeys(value).length !== 0) {
        throw new TypeError('Template Maps cannot have custom properties');
      }
      const size = mapSize(map);
      assertRuntimeContainerSize(size);
      reserveSafeValueEntries(state, size);
      const entries: Array<readonly [RuntimeValue, RuntimeValue]> = [];
      mapForEach(map, (entryValue, entryKey) => {
        const key = copyValue(
          entryKey as TemplateValue,
          state,
          parentDepth + 1,
        );
        if (typeof key === 'string' && isReservedName(key)) {
          throw new TypeError(`Template Map key ${key} is reserved`);
        }
        entries.push([
          key,
          copyValue(entryValue as TemplateValue, state, parentDepth + 1),
        ]);
      });
      const copied = new RuntimeMap(entries);
      state.aliases.set(value, copied);
      return copied;
    }

    if (types.isSet(value)) {
      const set = value as Set<unknown>;
      if (Object.getPrototypeOf(value) !== Set.prototype) {
        throw new TypeError('Template Sets cannot use a custom prototype');
      }
      if (Reflect.ownKeys(value).length !== 0) {
        throw new TypeError('Template Sets cannot have custom properties');
      }
      const size = setSize(set);
      assertRuntimeContainerSize(size);
      reserveSafeValueEntries(state, size);
      const values: RuntimeValue[] = [];
      setForEach(set, entryValue => {
        values.push(copyValue(
          entryValue as TemplateValue,
          state,
          parentDepth + 1,
        ));
      });
      const copied = new RuntimeSet(values);
      state.aliases.set(value, copied);
      return copied;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain records can be used as template values');
    }
    const keys = Reflect.ownKeys(value);
    assertRuntimeContainerSize(keys.length);
    reserveSafeValueEntries(state, keys.length);
    const entries: Array<readonly [string, RuntimeValue]> = [];
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new TypeError('Template records cannot contain symbol keys');
      }
      if (isReservedName(key)) {
        throw new TypeError(`Template record key ${key} is reserved`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable) {
        entries.push([
          key,
          copyDataDescriptor(descriptor, state, parentDepth + 1),
        ]);
      }
    }
    const copied = new RuntimeRecord(entries);
    state.aliases.set(value, copied);
    return copied;
  } finally {
    state.ancestors.delete(value);
  }
}

function copyDataDescriptor(
  descriptor: PropertyDescriptor,
  state: SafeValueCopyState,
  parentDepth: number,
): RuntimeValue {
  if (!('value' in descriptor)) {
    throw new TypeError('Template values cannot contain accessors');
  }
  return copyValue(descriptor.value as TemplateValue, state, parentDepth);
}

function validateArrayKeys(value: readonly TemplateValue[]): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') {
      continue;
    }
    if (typeof key !== 'string' || !isArrayIndex(key, value.length)) {
      throw new TypeError('Template arrays cannot have custom properties');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) {
      throw new TypeError('Template values cannot contain accessors');
    }
  }
}

function replaceRuntimeContextPath(
  context: RuntimeRecord,
  path: readonly string[],
  index: number,
  value: RuntimeValue,
): RuntimeRecord {
  const name = path[index];
  if (name === undefined) {
    throw new TypeError('Prepared context update path cannot contain undefined');
  }
  if (index === path.length - 1) {
    return context.with(name, value);
  }
  let child: RuntimeRecord;
  if (!context.has(name)) {
    child = new RuntimeRecord([]);
  } else {
    const existing = context.get(name);
    if (!(existing instanceof RuntimeRecord)) {
      throw new TypeError(`Prepared context path ${path.slice(0, index + 1).join('.')} is not a record`);
    }
    child = existing;
  }
  return context.with(
    name,
    replaceRuntimeContextPath(child, path, index + 1, value),
  );
}

function isArrayIndex(value: string, length: number): boolean {
  return isCanonicalArrayIndex(value) && Number(value) < length;
}

interface PublicValueCopyState {
  readonly aliases: Map<object, TemplateValue>;
  remainingEntries: number;
}

function createPublicValueCopyState(): PublicValueCopyState {
  return {
    aliases: new Map(),
    remainingEntries: maximumSafeValueEntries,
  };
}

function toPublicValue(
  value: RuntimeValue,
  state: PublicValueCopyState,
  parentDepth: number,
  chargeWork?: RuntimeWorkCharge,
): TemplateValue | undefined {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (value instanceof RuntimeSafeString) {
    return value.value;
  }
  const existing = state.aliases.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (value instanceof RuntimeArray) {
    assertRuntimeValueDepth(parentDepth + 1);
    reserveSafeValueEntries(state, value.length);
    const output: TemplateValue[] = [];
    output.length = value.length;
    state.aliases.set(value, output);
    for (let index = 0; index < value.length; index += 1) {
      chargeWork?.();
      if (value.has(index)) {
        const publicItem = toPublicValue(
          value.at(index),
          state,
          parentDepth + 1,
          chargeWork,
        );
        defineOwnArrayIndex(
          output,
          index,
          publicItem === undefined ? null : publicItem,
        );
      }
    }
    return Object.freeze(output);
  }
  if (value instanceof RuntimeRecord) {
    assertRuntimeValueDepth(parentDepth + 1);
    reserveSafeValueEntries(state, value.size);
    const output = Object.create(null) as Record<string, TemplateValue>;
    state.aliases.set(value, output);
    for (const [key, item] of value.entries()) {
      chargeWork?.();
      if (isReservedName(key)) {
        throw new TypeError(`Template record key ${key} is reserved`);
      }
      const publicItem = toPublicValue(
        item,
        state,
        parentDepth + 1,
        chargeWork,
      );
      if (publicItem !== undefined) {
        output[key] = publicItem;
      }
    }
    return Object.freeze(output);
  }
  if (value instanceof RuntimeMap) {
    assertRuntimeValueDepth(parentDepth + 1);
    reserveSafeValueEntries(state, value.size);
    const output = new Map<TemplateValue | undefined, TemplateValue | undefined>();
    state.aliases.set(value, output as TemplateValue);
    for (const [key, item] of value.entries()) {
      chargeWork?.();
      const publicKey = toPublicValue(
        key,
        state,
        parentDepth + 1,
        chargeWork,
      );
      if (typeof publicKey === 'string' && isReservedName(publicKey)) {
        throw new TypeError(`Template Map key ${publicKey} is reserved`);
      }
      output.set(
        publicKey,
        toPublicValue(item, state, parentDepth + 1, chargeWork),
      );
    }
    return output as TemplateValue;
  }
  if (value instanceof RuntimeSet) {
    assertRuntimeValueDepth(parentDepth + 1);
    reserveSafeValueEntries(state, value.size);
    const output = new Set<TemplateValue | undefined>();
    state.aliases.set(value, output as TemplateValue);
    for (const item of value.values()) {
      chargeWork?.();
      output.add(toPublicValue(item, state, parentDepth + 1, chargeWork));
    }
    return output as TemplateValue;
  }
  if (value instanceof RuntimeRegex) {
    return runtimeRegexToString(value);
  }
  throw new TypeError('Callable values cannot cross the capability boundary');
}

function assertRuntimeContainerSize(entries: number): void {
  if (entries > maximumSafeValueEntries) {
    throw new RangeError(
      `Template value containers cannot exceed ${maximumSafeValueEntries} entries`,
    );
  }
}

function assertRuntimeValueDepth(depth: number): void {
  if (depth > maximumSafeValueDepth) {
    throw new RangeError(
      `Template value nesting cannot exceed ${maximumSafeValueDepth} levels`,
    );
  }
}

function reserveSafeValueEntries(
  state: { remainingEntries: number },
  entries: number,
): void {
  if (entries > state.remainingEntries) {
    throw new RangeError(
      `Template value copies cannot exceed ${maximumSafeValueEntries} structured entries`,
    );
  }
  state.remainingEntries -= entries;
}

function cloneValue(
  value: RuntimeValue,
  aliases: Map<object, RuntimeValue>,
): RuntimeValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (
    value instanceof RuntimeSafeString ||
    value instanceof RuntimeRegex ||
    value instanceof RuntimeCallable
  ) {
    return value;
  }
  const existing = aliases.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (value instanceof RuntimeArray) {
    const items = value.copySparse();
    for (let index = 0; index < items.length; index += 1) {
      if (value.has(index)) {
        defineOwnArrayIndex(items, index, cloneValue(value.at(index), aliases));
      }
    }
    const cloned = new RuntimeArray(items);
    aliases.set(value, cloned);
    return cloned;
  }
  if (value instanceof RuntimeRecord) {
    const entries: Array<readonly [string, RuntimeValue]> = [];
    for (const [key, item] of value.entries()) {
      entries.push([key, cloneValue(item, aliases)]);
    }
    const cloned = new RuntimeRecord(entries);
    aliases.set(value, cloned);
    return cloned;
  }
  if (value instanceof RuntimeMap) {
    const entries: Array<readonly [RuntimeValue, RuntimeValue]> = [];
    for (const [key, item] of value.entries()) {
      entries.push([cloneValue(key, aliases), cloneValue(item, aliases)]);
    }
    const cloned = new RuntimeMap(entries);
    aliases.set(value, cloned);
    return cloned;
  }
  if (value instanceof RuntimeSet) {
    const values: RuntimeValue[] = [];
    for (const item of value.values()) {
      values.push(cloneValue(item, aliases));
    }
    const cloned = new RuntimeSet(values);
    aliases.set(value, cloned);
    return cloned;
  }
  return assertNeverRuntimeValue(value);
}

function assertRuntimeValueCanBeContained(owner: object, value: RuntimeValue): void {
  const pending: RuntimeValue[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === undefined || candidate === null || typeof candidate !== 'object') {
      continue;
    }
    if (candidate === owner) {
      throw new TypeError('Cyclic template values are not supported');
    }
    if (visited.has(candidate)) {
      continue;
    }
    visited.add(candidate);
    if (candidate instanceof RuntimeArray) {
      pending.push(...candidate.presentValues());
    } else if (candidate instanceof RuntimeRecord) {
      for (const [, item] of candidate.entries()) {
        pending.push(item);
      }
    } else if (candidate instanceof RuntimeMap) {
      for (const [key, item] of candidate.entries()) {
        pending.push(key, item);
      }
    } else if (candidate instanceof RuntimeSet) {
      pending.push(...candidate.values());
    }
  }
}

function assertAllowedRuntimeMapKey(key: RuntimeValue): void {
  const stringKey = key instanceof RuntimeSafeString ? key.value : key;
  if (typeof stringKey === 'string' && isReservedName(stringKey)) {
    throw new TypeError(`Template Map key ${stringKey} is reserved`);
  }
}

function assertNeverRuntimeValue(value: never): never {
  throw new TypeError(`Unknown runtime value ${typeof value}`);
}

const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get;
const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get;
const mapForEachIntrinsic = Map.prototype.forEach;
const setForEachIntrinsic = Set.prototype.forEach;

function mapSize(value: Map<unknown, unknown>): number {
  if (!mapSizeGetter) {
    throw new TypeError('Map size intrinsic is unavailable');
  }
  return mapSizeGetter.call(value) as number;
}

function setSize(value: Set<unknown>): number {
  if (!setSizeGetter) {
    throw new TypeError('Set size intrinsic is unavailable');
  }
  return setSizeGetter.call(value) as number;
}

function mapForEach(
  value: Map<unknown, unknown>,
  callback: (entryValue: unknown, entryKey: unknown) => void,
): void {
  mapForEachIntrinsic.call(value, callback);
}

function setForEach(
  value: Set<unknown>,
  callback: (entryValue: unknown) => void,
): void {
  setForEachIntrinsic.call(value, callback);
}
