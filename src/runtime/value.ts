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

  constructor(items: readonly RuntimeValue[]) {
    this.#items = Object.freeze([...items]);
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

  /** Iterates immutable contained values. */
  values(): IterableIterator<RuntimeValue> {
    return this.#items.values();
  }
}

/** An immutable interpreter-owned string-keyed record. */
export class RuntimeRecord {
  readonly kind = 'record';
  readonly #entries: ReadonlyMap<string, RuntimeValue>;

  constructor(entries: Iterable<readonly [string, RuntimeValue]>) {
    this.#entries = new Map(entries);
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

  /** Iterates immutable own entries in insertion order. */
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

/** Closed categories of behavior the interpreter may invoke. */
export type RuntimeCallableKind = 'macro' | 'caller' | 'builtin' | 'capability' | 'super';

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
export function renderRuntimeValue(value: RuntimeValue): string {
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
    return [...value.values()].map(renderRuntimeValue).join(',');
  }
  if (value instanceof RuntimeRecord) {
    return '[object Object]';
  }
  if (value instanceof RuntimeRegex) {
    return `/${value.source}/${value.flags}`;
  }
  return '';
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
    return value.value.length > 0;
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
      const copied = new RuntimeArray(Array.from(
        { length: value.length },
        (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          return descriptor === undefined
            ? undefined
            : copyDataDescriptor(descriptor, ancestors, aliases);
        },
      ));
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
  const existing = context.get(name);
  if (existing !== undefined && !(existing instanceof RuntimeRecord)) {
    throw new TypeError(`Prepared context path ${path.slice(0, index + 1).join('.')} is not a record`);
  }
  const child = existing instanceof RuntimeRecord
    ? existing
    : new RuntimeRecord([]);
  return context.with(
    name,
    replaceRuntimeContextPath(child, path, index + 1, value),
  );
}

function isArrayIndex(value: string, length: number): boolean {
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
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
    aliases.set(value, output);
    for (const item of value.values()) {
      const publicItem = toPublicValue(item, aliases);
      output.push(publicItem === undefined ? null : publicItem);
    }
    return Object.freeze(output);
  }
  if (value instanceof RuntimeRecord) {
    const output = Object.create(null) as Record<string, TemplateValue>;
    aliases.set(value, output);
    for (const [key, item] of value.entries()) {
      const publicItem = toPublicValue(item, aliases);
      if (publicItem !== undefined) {
        output[key] = publicItem;
      }
    }
    return Object.freeze(output);
  }
  if (value instanceof RuntimeRegex) {
    return `/${value.source}/${value.flags}`;
  }
  throw new TypeError('Callable values cannot cross the capability boundary');
}
