import * as nunjucks from 'nunjucks';

import {
  copyRuntimeValue,
  renderRuntimeValue,
  runtimeTruthy,
  RuntimeArray,
  RuntimeCallable,
  RuntimeRecord,
  RuntimeRegex,
  RuntimeSafeString,
  type RuntimeValue,
} from './value.ts';

interface NunjucksRuntime {
  SafeString: new (value: string) => { readonly val: string };
  makeKeywordArgs(value: Record<string, unknown>): unknown;
}

interface NunjucksEnvironment {
  getFilter(name: string): ((...arguments_: unknown[]) => unknown) | undefined;
  getTest(name: string): ((...arguments_: unknown[]) => unknown) | undefined;
}

interface NunjucksModule {
  Environment: new (loader: null, options: object) => NunjucksEnvironment;
  runtime: NunjucksRuntime;
}

const nativeNunjucks = (nunjucks as unknown as { default: NunjucksModule }).default;
const environment = new nativeNunjucks.Environment(null, { autoescape: false });

/** Returns whether the pinned standard library exposes one filter name. */
export function hasBuiltinFilter(name: string): boolean {
  return environment.getFilter(name) !== undefined;
}

/** Applies one trusted built-in filter to copied public values. */
export function applyBuiltinFilter(
  name: string,
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  keyword: ReadonlyMap<string, RuntimeValue>,
): RuntimeValue | undefined {
  if (name === 'reverse') {
    if (typeof input === 'string' || input instanceof RuntimeSafeString) {
      const reversed = [...renderRuntimeValue(input)].reverse().join('');
      return input instanceof RuntimeSafeString ? new RuntimeSafeString(reversed) : reversed;
    }
    if (input instanceof RuntimeArray) {
      return new RuntimeArray([...input.values()].reverse());
    }
  }
  if (name === 'groupby') {
    return groupRuntimeValues(input, positional[0]);
  }
  const filter = environment.getFilter(name);
  if (!filter) {
    return undefined;
  }
  const arguments_: unknown[] = [
    toBuiltinValue(input),
    ...positional.map(toBuiltinValue),
  ];
  if (keyword.size > 0) {
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of keyword) {
      values[key] = toBuiltinValue(value);
    }
    arguments_.push(nativeNunjucks.runtime.makeKeywordArgs(values));
  }
  const result = filter.apply(Object.freeze({ env: environment }), arguments_);
  return fromBuiltinValue(result);
}

function groupRuntimeValues(input: RuntimeValue, attribute: RuntimeValue): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return new RuntimeRecord([]);
  }
  const path = typeof attribute === 'string' || attribute instanceof RuntimeSafeString
    ? renderRuntimeValue(attribute).split('.')
    : [];
  const grouped = new Map<string, RuntimeValue[]>();
  for (const value of input.values()) {
    let key: RuntimeValue = value;
    for (const segment of path) {
      key = key instanceof RuntimeRecord ? key.get(segment) : undefined;
    }
    if (path.length === 0) {
      key = undefined;
    }
    const renderedKey = key === undefined ? 'undefined' : renderRuntimeValue(key);
    const values = grouped.get(renderedKey) ?? [];
    values.push(value);
    grouped.set(renderedKey, values);
  }
  const entries = [...grouped].map(([key, values]) => [key, new RuntimeArray(values)] as const);
  const numeric = entries
    .filter(([key]) => isArrayIndex(key))
    .sort(([left], [right]) => Number(left) - Number(right));
  const named = entries.filter(([key]) => !isArrayIndex(key));
  return new RuntimeRecord([...numeric, ...named]);
}

function isArrayIndex(value: string): boolean {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number < 0xffff_ffff && `${number}` === value;
}

/** Applies one closed built-in test. */
export function applyBuiltinTest(
  name: string,
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): boolean | undefined {
  if (name === 'callable') {
    return input instanceof RuntimeCallable;
  }
  if (name === 'escaped') {
    return input instanceof RuntimeSafeString;
  }
  if (name === 'sameas') {
    return positional.length === 1 && input === positional[0];
  }
  if (name === 'defined') {
    return input !== undefined;
  }
  if (name === 'undefined') {
    return input === undefined;
  }
  if (name === 'truthy') {
    return runtimeTruthy(input);
  }
  if (name === 'falsy') {
    return !runtimeTruthy(input);
  }
  const test = environment.getTest(name);
  if (!test) {
    return undefined;
  }
  return Boolean(test(toBuiltinValue(input), ...positional.map(toBuiltinValue)));
}

/** Explicit numeric coercion matching template arithmetic. */
export function runtimeNumber(value: RuntimeValue): number {
  if (value === null) {
    return 0;
  }
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' || value instanceof RuntimeSafeString) {
    const text = typeof value === 'string' ? value : value.value;
    return text.trim() === '' ? 0 : Number(text);
  }
  return Number.NaN;
}

/** Resolves one explicit own lookup over a closed value. */
export function lookupRuntimeValue(
  target: RuntimeValue,
  key: RuntimeValue,
): RuntimeValue | undefined {
  if (target instanceof RuntimeRecord) {
    return target.get(renderRuntimeValue(key));
  }
  if (target instanceof RuntimeArray) {
    const index = runtimeNumber(key);
    if (Number.isSafeInteger(index) && index >= 0) {
      return target.at(index);
    }
    return undefined;
  }
  if (typeof target === 'string' || target instanceof RuntimeSafeString) {
    const text = typeof target === 'string' ? target : target.value;
    const index = runtimeNumber(key);
    if (Number.isSafeInteger(index) && index >= 0) {
      return text[index];
    }
    if (key === 'length') {
      return [...text].length;
    }
  }
  return undefined;
}

/** Escapes one rendered string for Nunjucks-compatible HTML output. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'\\]/g, character => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      case '\\': return '&#92;';
      default: return character;
    }
  });
}

function toBuiltinValue(value: RuntimeValue): unknown {
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
    return new nativeNunjucks.runtime.SafeString(value.value);
  }
  if (value instanceof RuntimeArray) {
    return [...value.values()].map(toBuiltinValue);
  }
  if (value instanceof RuntimeRecord) {
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of value.entries()) {
      output[key] = toBuiltinValue(item);
    }
    return output;
  }
  if (value instanceof RuntimeRegex) {
    return new RegExp(value.source, value.flags);
  }
  return undefined;
}

function fromBuiltinValue(value: unknown): RuntimeValue {
  if (value instanceof nativeNunjucks.runtime.SafeString) {
    return new RuntimeSafeString(value.val);
  }
  if (value instanceof RegExp) {
    return new RuntimeRegex(value.source, value.flags);
  }
  return copyRuntimeValue(value as never);
}
