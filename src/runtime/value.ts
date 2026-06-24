import { types } from 'node:util';

import type { TemplateValue } from '../values.ts';

/** Names denied throughout the interpreter to eliminate prototype gadget paths. */
export const reservedNames = Object.freeze(new Set([
  'constructor',
  'prototype',
  '__proto__',
]));

/** Primitive values owned directly by the interpreter. */
export type RuntimePrimitive = undefined | null | boolean | number | string;

/** Closed value variants accepted by the interpreter. */
export type RuntimeValue =
  | RuntimePrimitive
  | RuntimeSafeString
  | RuntimeArray
  | RuntimeRecord
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

/** An immutable interpreter-owned array. */
export class RuntimeArray {
  readonly kind = 'array';
  readonly #items: readonly RuntimeValue[];
  readonly #present: ReadonlySet<number> | undefined;

  constructor(items: readonly RuntimeValue[]) {
    if (types.isProxy(items)) {
      throw new TypeError('Proxy objects cannot be used as runtime arrays');
    }
    if (!Array.isArray(items)) {
      throw new TypeError('Runtime arrays require an array');
    }
    const copied: RuntimeValue[] = [];
    copied.length = items.length;
    const present = new Set<number>();
    for (let index = 0; index < items.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(items, `${index}`);
      if (descriptor === undefined) {
        defineOwnArrayIndex(copied, index, undefined);
        continue;
      }
      if (!('value' in descriptor)) {
        throw new TypeError('Runtime arrays cannot contain accessors');
      }
      defineOwnArrayIndex(copied, index, descriptor.value as RuntimeValue);
      present.add(index);
    }
    this.#items = Object.freeze(copied);
    this.#present = present.size === copied.length ? undefined : present;
    Object.freeze(this);
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
}

/** An immutable interpreter-owned string-keyed record. */
export class RuntimeRecord {
  readonly kind = 'record';
  readonly #entries: ReadonlyMap<string, RuntimeValue>;

  constructor(entries: Iterable<readonly [string, RuntimeValue]>) {
    const indexedEntries = new Map<string, RuntimeValue>();
    const namedEntries = new Map<string, RuntimeValue>();
    for (const [name, value] of entries) {
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

  /** Returns a derived record with one allowed own entry replaced. */
  with(name: string, value: RuntimeValue): RuntimeRecord {
    if (isReservedName(name)) {
      throw new TypeError(`Template record key ${name} is reserved`);
    }
    const entries = new Map(this.#entries);
    entries.set(name, value);
    return new RuntimeRecord(entries);
  }
}

/** An inert regular-expression literal interpreted only by approved built-ins. */
export class RuntimeRegex {
  readonly kind = 'regex';
  readonly source: string;
  readonly flags: string;

  constructor(source: string, flags: string) {
    this.source = source;
    this.flags = flags;
    Object.freeze(this);
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
  return copyValue(value, new Set(), new Map());
}

/** Copies a root context record into interpreter-owned values. */
export function copyRuntimeContext(
  context: Readonly<Record<string, TemplateValue>>,
): RuntimeRecord {
  const copied = copyValue(context, new Set(), new Map());
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
  return toPublicValue(value, new Map());
}

/** Explicit string coercion over closed value variants. */
export function renderRuntimeValue(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): string {
  assertRuntimeValueHasNoCallable(value);
  return renderRuntimeValueUnchecked(value, chargeWork);
}

/** Rejects callable identities anywhere inside a closed value graph. */
export function assertRuntimeValueHasNoCallable(value: RuntimeValue): void {
  const pending = Object.setPrototypeOf([value], null) as RuntimeValue[];
  const visited = new Set<RuntimeArray | RuntimeRecord>();
  while (pending.length > 0) {
    const index = pending.length - 1;
    const current = pending[index]!;
    pending.length = index;
    if (current instanceof RuntimeCallable) {
      throw new TypeError('Callable values cannot be coerced');
    }
    if (current instanceof RuntimeArray) {
      if (!visited.has(current)) {
        visited.add(current);
        for (const item of current.presentValues()) {
          pending[pending.length] = item;
        }
      }
    } else if (current instanceof RuntimeRecord && !visited.has(current)) {
      visited.add(current);
      for (const [, item] of current.entries()) {
        pending[pending.length] = item;
      }
    }
  }
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
  if (value instanceof RuntimeRegex) {
    return runtimeRegexToString(value);
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

function copyValue(
  value: TemplateValue | undefined,
  ancestors: Set<object>,
  aliases: Map<object, RuntimeValue>,
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
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic template values are not supported');
  }
  const existing = aliases.get(value);
  if (existing !== undefined) {
    return existing;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Template arrays cannot use a custom prototype');
      }
      validateArrayKeys(value);
      const items: RuntimeValue[] = [];
      items.length = value.length;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor !== undefined) {
          defineOwnArrayIndex(
            items,
            index,
            copyDataDescriptor(descriptor, ancestors, aliases),
          );
        }
      }
      const copied = new RuntimeArray(items);
      aliases.set(value, copied);
      return copied;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain records can be used as template values');
    }
    const entries: Array<readonly [string, RuntimeValue]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError('Template records cannot contain symbol keys');
      }
      if (isReservedName(key)) {
        throw new TypeError(`Template record key ${key} is reserved`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable) {
        entries.push([key, copyDataDescriptor(descriptor, ancestors, aliases)]);
      }
    }
    const copied = new RuntimeRecord(entries);
    aliases.set(value, copied);
    return copied;
  } finally {
    ancestors.delete(value);
  }
}

function copyDataDescriptor(
  descriptor: PropertyDescriptor,
  ancestors: Set<object>,
  aliases: Map<object, RuntimeValue>,
): RuntimeValue {
  if (!('value' in descriptor)) {
    throw new TypeError('Template values cannot contain accessors');
  }
  return copyValue(descriptor.value as TemplateValue, ancestors, aliases);
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

function toPublicValue(
  value: RuntimeValue,
  aliases: Map<object, TemplateValue>,
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
  const existing = aliases.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (value instanceof RuntimeArray) {
    const output: TemplateValue[] = [];
    output.length = value.length;
    aliases.set(value, output);
    for (let index = 0; index < value.length; index += 1) {
      if (value.has(index)) {
        const publicItem = toPublicValue(value.at(index), aliases);
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
    const output = Object.create(null) as Record<string, TemplateValue>;
    aliases.set(value, output);
    for (const [key, item] of value.entries()) {
      if (isReservedName(key)) {
        throw new TypeError(`Template record key ${key} is reserved`);
      }
      const publicItem = toPublicValue(item, aliases);
      if (publicItem !== undefined) {
        output[key] = publicItem;
      }
    }
    return Object.freeze(output);
  }
  if (value instanceof RuntimeRegex) {
    return runtimeRegexToString(value);
  }
  throw new TypeError('Callable values cannot cross the capability boundary');
}
