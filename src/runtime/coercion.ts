import {
  assertRuntimeValueHasNoCallable,
  RuntimeArray,
  RuntimeCallable,
  RuntimeRecord,
  RuntimeRegex,
  RuntimeSafeString,
  type RuntimePrimitive,
  type RuntimeValue,
} from './value.ts';

/** Converts one closed value to a primitive without invoking host behavior. */
export function runtimeToPrimitive(value: RuntimeValue): RuntimePrimitive {
  assertRuntimeValueHasNoCallable(value);
  if (isRuntimePrimitive(value)) {
    return value;
  }
  if (value instanceof RuntimeSafeString) {
    return value.value;
  }
  if (value instanceof RuntimeArray) {
    const items: string[] = [];
    for (const item of value.values()) {
      items.push(item === undefined || item === null ? '' : runtimeToString(item));
    }
    return items.join(',');
  }
  if (value instanceof RuntimeRecord) {
    return '[object Object]';
  }
  if (value instanceof RuntimeRegex) {
    return `/${value.source}/${value.flags}`;
  }
  if (value instanceof RuntimeCallable) {
    throw new TypeError('Callable values cannot be coerced');
  }
  return assertNever(value);
}

/** Converts one closed value with JavaScript-compatible numeric semantics. */
export function runtimeToNumber(value: RuntimeValue): number {
  const primitive = runtimeToPrimitive(value);
  if (primitive === undefined) {
    return Number.NaN;
  }
  if (primitive === null) {
    return 0;
  }
  if (primitive === true) {
    return 1;
  }
  if (primitive === false) {
    return 0;
  }
  if (typeof primitive === 'number') {
    return primitive;
  }
  return primitive.trim() === '' ? 0 : Number(primitive);
}

/** Converts one closed value with JavaScript-compatible string semantics. */
export function runtimeToString(value: RuntimeValue): string {
  return primitiveToString(runtimeToPrimitive(value));
}

/** Converts one closed value to an allowed property-key string. */
export function runtimeToPropertyKey(value: RuntimeValue): string {
  return runtimeToString(value);
}

/** Resolves a canonical in-range array index from one property key. */
export function runtimeArrayIndexFromPropertyKey(
  key: string,
  length: number,
): number | undefined {
  const index = Number(key);
  return Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    `${index}` === key
    ? index
    : undefined;
}

/** Applies direct primitive or interpreter-object identity. */
export function runtimeStrictEqual(left: RuntimeValue, right: RuntimeValue): boolean {
  return left === right;
}

/** Applies supported JavaScript abstract equality over closed values. */
export function runtimeLooseEqual(left: RuntimeValue, right: RuntimeValue): boolean {
  if (left === right) {
    return true;
  }
  const leftPrimitive = isRuntimePrimitive(left);
  const rightPrimitive = isRuntimePrimitive(right);
  if (!leftPrimitive && !rightPrimitive) {
    return false;
  }
  return primitiveLooseEqual(
    leftPrimitive ? left : runtimeToPrimitive(left),
    rightPrimitive ? right : runtimeToPrimitive(right),
  );
}

/** Applies JavaScript-style addition after closed primitive conversion. */
export function runtimeAdd(left: RuntimeValue, right: RuntimeValue): RuntimeValue {
  const leftPrimitive = runtimeToPrimitive(left);
  const rightPrimitive = runtimeToPrimitive(right);
  if (typeof leftPrimitive === 'string' || typeof rightPrimitive === 'string') {
    return primitiveToString(leftPrimitive) + primitiveToString(rightPrimitive);
  }
  return runtimeToNumber(leftPrimitive) + runtimeToNumber(rightPrimitive);
}

/** Concatenates closed values using JavaScript-compatible string conversion. */
export function runtimeConcat(left: RuntimeValue, right: RuntimeValue): string {
  return runtimeToString(left) + runtimeToString(right);
}

/** Returns the ordering delta after closed relational primitive conversion. */
export function runtimeOrder(left: RuntimeValue, right: RuntimeValue): number {
  const leftPrimitive = runtimeToPrimitive(left);
  const rightPrimitive = runtimeToPrimitive(right);
  if (typeof leftPrimitive === 'string' && typeof rightPrimitive === 'string') {
    if (leftPrimitive < rightPrimitive) {
      return -1;
    }
    if (leftPrimitive > rightPrimitive) {
      return 1;
    }
    return 0;
  }
  const leftNumber = runtimeToNumber(leftPrimitive);
  const rightNumber = runtimeToNumber(rightPrimitive);
  if (leftNumber < rightNumber) {
    return -1;
  }
  if (leftNumber > rightNumber) {
    return 1;
  }
  if (leftNumber === rightNumber) {
    return 0;
  }
  return Number.NaN;
}

function primitiveLooseEqual(left: RuntimePrimitive, right: RuntimePrimitive): boolean {
  if (left === right) {
    return true;
  }
  if (
    left === undefined ||
    left === null ||
    right === undefined ||
    right === null
  ) {
    return (left === undefined || left === null) && (right === undefined || right === null);
  }
  if (typeof left === typeof right) {
    return false;
  }
  if (typeof left === 'boolean') {
    return primitiveLooseEqual(left ? 1 : 0, right);
  }
  if (typeof right === 'boolean') {
    return primitiveLooseEqual(left, right ? 1 : 0);
  }
  if (typeof left === 'number' && typeof right === 'string') {
    return left === runtimeToNumber(right);
  }
  if (typeof left === 'string' && typeof right === 'number') {
    return runtimeToNumber(left) === right;
  }
  return false;
}

function primitiveToString(value: RuntimePrimitive): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (value === true) {
    return 'true';
  }
  if (value === false) {
    return 'false';
  }
  if (typeof value === 'string') {
    return value;
  }
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

function isRuntimePrimitive(value: RuntimeValue): value is RuntimePrimitive {
  return value === undefined ||
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string';
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown runtime value ${typeof value}`);
}
