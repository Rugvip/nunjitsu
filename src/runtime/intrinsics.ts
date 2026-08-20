import {
  runtimeStrictEqual,
  runtimeToNumber,
  runtimeToString,
} from './coercion.ts';
import {
  assertRuntimeValueHasNoCallable,
  defineOwnArrayIndex,
  isReservedName,
  RuntimeArray,
  RuntimeMap,
  RuntimeRecord,
  RuntimeRegex,
  RuntimeSafeString,
  RuntimeSet,
  type RuntimeValue,
  type RuntimeWorkCharge,
} from './value.ts';

/** One statically approved method exposed by a closed runtime value. */
export interface RuntimeIntrinsicMethod {
  readonly name: string;
  readonly receiver: RuntimeValue;
}

/** Positional syntax accepted by one statically approved intrinsic method. */
export interface RuntimeIntrinsicArity {
  readonly minimum: number;
  readonly maximum: number;
}

/** Options that affect the deliberately small intrinsic surface. */
export interface RuntimeIntrinsicOptions {
  readonly allowRegexExecution: boolean;
  readonly cookiecutterCompat: boolean;
  readonly chargeWork?: RuntimeWorkCharge;
}

const stringMethods = new Set([
  'charAt',
  'charCodeAt',
  'concat',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'replace',
  'slice',
  'split',
  'startsWith',
  'substring',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimEnd',
  'trimStart',
]);

const numberMethods = new Set([
  'toExponential',
  'toFixed',
  'toPrecision',
  'toString',
]);

const arrayMethods = new Set([
  'at',
  'concat',
  'copyWithin',
  'fill',
  'flat',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'pop',
  'push',
  'reverse',
  'shift',
  'slice',
  'sort',
  'splice',
  'unshift',
]);

const jinjaArrayMethods = new Set([
  'append',
  'count',
  'find',
  'index',
  'insert',
  'remove',
]);

const jinjaRecordMethods = new Set([
  'get',
  'has_key',
  'items',
  'keys',
  'values',
]);

const mapMethods = new Set([
  'clear',
  'delete',
  'entries',
  'get',
  'has',
  'keys',
  'set',
  'values',
]);

const setMethods = new Set([
  'add',
  'clear',
  'delete',
  'entries',
  'has',
  'values',
]);

const mutatingMethodNames = new Set([
  'add',
  'append',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'insert',
  'pop',
  'push',
  'remove',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

/** Returns whether an approved method name can mutate its closed receiver. */
export function isMutatingRuntimeIntrinsicName(name: string): boolean {
  return mutatingMethodNames.has(name);
}

/** Resolves only explicitly approved closed methods, never host properties. */
export function resolveRuntimeIntrinsic(
  receiver: RuntimeValue,
  name: string,
  cookiecutterCompat: boolean,
): RuntimeIntrinsicMethod | undefined {
  if (
    isReservedName(name) ||
    receiver === undefined ||
    receiver === null ||
    typeof receiver === 'boolean' ||
    (receiver instanceof RuntimeRecord && !cookiecutterCompat)
  ) {
    return undefined;
  }
  let found = false;
  if (typeof receiver === 'string' || receiver instanceof RuntimeSafeString) {
    found = stringMethods.has(name);
  } else if (typeof receiver === 'number') {
    found = numberMethods.has(name);
  } else if (receiver instanceof RuntimeArray) {
    found = arrayMethods.has(name) || (cookiecutterCompat && jinjaArrayMethods.has(name));
  } else if (receiver instanceof RuntimeRecord) {
    found = cookiecutterCompat && !receiver.has(name) && jinjaRecordMethods.has(name);
  } else if (receiver instanceof RuntimeMap) {
    found = mapMethods.has(name);
  } else if (receiver instanceof RuntimeSet) {
    found = setMethods.has(name);
  } else if (receiver instanceof RuntimeRegex) {
    found = name === 'test';
  }
  return found ? Object.freeze({ receiver, name }) : undefined;
}

/** Returns positional bounds so invalid calls fail before argument evaluation. */
export function runtimeIntrinsicArity(
  method: RuntimeIntrinsicMethod,
  cookiecutterCompat: boolean,
): RuntimeIntrinsicArity {
  const { name, receiver } = method;
  if (typeof receiver === 'string' || receiver instanceof RuntimeSafeString) {
    if (name === 'replace') return { minimum: 2, maximum: 2 };
    if (name === 'split' || name === 'includes' || name === 'startsWith' || name === 'endsWith' || name === 'indexOf' || name === 'lastIndexOf') {
      return { minimum: name === 'split' ? 0 : 1, maximum: 2 };
    }
    if (name === 'slice' || name === 'substring') return { minimum: 0, maximum: 2 };
    if (name === 'charAt' || name === 'charCodeAt') return { minimum: 0, maximum: 1 };
    if (name === 'concat') return { minimum: 0, maximum: Number.POSITIVE_INFINITY };
    return { minimum: 0, maximum: 0 };
  }
  if (typeof receiver === 'number') {
    return { minimum: 0, maximum: 1 };
  }
  if (receiver instanceof RuntimeArray) {
    if (name === 'at' || name === 'count' || name === 'index' || name === 'find' || name === 'remove') {
      return { minimum: 1, maximum: 1 };
    }
    if (name === 'append') return { minimum: 1, maximum: 1 };
    if (name === 'insert') return { minimum: 2, maximum: 2 };
    if (name === 'includes' || name === 'indexOf' || name === 'lastIndexOf') {
      return { minimum: 1, maximum: 2 };
    }
    if (name === 'copyWithin' || name === 'fill') {
      return { minimum: 1, maximum: 3 };
    }
    if (name === 'flat' || name === 'join') return { minimum: 0, maximum: 1 };
    if (name === 'slice') return { minimum: 0, maximum: 2 };
    if (name === 'pop') return { minimum: 0, maximum: cookiecutterCompat ? 1 : 0 };
    if (name === 'shift' || name === 'sort' || name === 'reverse') {
      return { minimum: 0, maximum: 0 };
    }
    return { minimum: 0, maximum: Number.POSITIVE_INFINITY };
  }
  if (receiver instanceof RuntimeRecord) {
    return name === 'get'
      ? { minimum: 1, maximum: 2 }
      : name === 'has_key'
        ? { minimum: 1, maximum: 1 }
        : { minimum: 0, maximum: 0 };
  }
  if (receiver instanceof RuntimeMap) {
    if (name === 'set') return { minimum: 2, maximum: 2 };
    if (name === 'get' || name === 'has' || name === 'delete') {
      return { minimum: 1, maximum: 1 };
    }
    return { minimum: 0, maximum: 0 };
  }
  if (receiver instanceof RuntimeSet) {
    if (name === 'add' || name === 'has' || name === 'delete') {
      return { minimum: 1, maximum: 1 };
    }
    return { minimum: 0, maximum: 0 };
  }
  return { minimum: 1, maximum: 1 };
}

/** Invokes one sealed method using only closed receiver-specific behavior. */
export function invokeRuntimeIntrinsic(
  method: RuntimeIntrinsicMethod,
  positional: readonly RuntimeValue[],
  options: RuntimeIntrinsicOptions,
): RuntimeValue {
  assertRuntimeValueHasNoCallable(method.receiver);
  for (const value of positional) {
    assertRuntimeValueHasNoCallable(value);
  }
  const { receiver, name } = method;
  if (typeof receiver === 'string' || receiver instanceof RuntimeSafeString) {
    return invokeStringIntrinsic(
      receiver instanceof RuntimeSafeString ? receiver.value : receiver,
      name,
      positional,
      options,
    );
  }
  if (typeof receiver === 'number') {
    return invokeNumberIntrinsic(receiver, name, positional);
  }
  if (receiver instanceof RuntimeArray) {
    return invokeArrayIntrinsic(receiver, name, positional, options);
  }
  if (receiver instanceof RuntimeRecord) {
    return invokeRecordIntrinsic(receiver, name, positional);
  }
  if (receiver instanceof RuntimeMap) {
    return invokeMapIntrinsic(receiver, name, positional);
  }
  if (receiver instanceof RuntimeSet) {
    return invokeSetIntrinsic(receiver, name, positional);
  }
  if (receiver instanceof RuntimeRegex && name === 'test') {
    assertRegexExecution(options);
    const regex = createNativeRegex(receiver);
    const result = regex.test(runtimeToString(positional[0], options.chargeWork));
    receiver.setLastIndex(regex.lastIndex);
    return result;
  }
  throw new TypeError(`Unsupported template intrinsic ${name}`);
}

function invokeStringIntrinsic(
  text: string,
  name: string,
  positional: readonly RuntimeValue[],
  options: RuntimeIntrinsicOptions,
): RuntimeValue {
  const first = positional[0];
  const second = positional[1];
  switch (name) {
    case 'replace': {
      const replacement = runtimeToString(second, options.chargeWork);
      if (first instanceof RuntimeRegex) {
        assertRegexExecution(options);
        const regex = createNativeRegex(first);
        const output = text.replace(regex, replacement);
        first.setLastIndex(regex.lastIndex);
        return output;
      }
      return text.replace(runtimeToString(first, options.chargeWork), replacement);
    }
    case 'split': {
      const limit = second === undefined ? undefined : toUint32(second, options.chargeWork);
      if (first instanceof RuntimeRegex) {
        assertRegexExecution(options);
        return new RuntimeArray(text.split(createNativeRegex(first), limit));
      }
      const separator = first === undefined
        ? undefined
        : runtimeToString(first, options.chargeWork);
      return new RuntimeArray(
        separator === undefined
          ? limit === 0 ? [] : [text]
          : limit === undefined
            ? text.split(separator)
            : text.split(separator, limit),
      );
    }
    case 'includes': return text.includes(runtimeToString(first, options.chargeWork), optionalInteger(second, options.chargeWork));
    case 'startsWith': return text.startsWith(runtimeToString(first, options.chargeWork), optionalInteger(second, options.chargeWork));
    case 'endsWith': return text.endsWith(runtimeToString(first, options.chargeWork), optionalInteger(second, options.chargeWork));
    case 'indexOf': return text.indexOf(runtimeToString(first, options.chargeWork), optionalInteger(second, options.chargeWork));
    case 'lastIndexOf': return text.lastIndexOf(runtimeToString(first, options.chargeWork), optionalNumber(second, options.chargeWork));
    case 'slice': return text.slice(optionalInteger(first, options.chargeWork), optionalInteger(second, options.chargeWork));
    case 'substring': return text.substring(
      optionalInteger(first, options.chargeWork) ?? 0,
      optionalInteger(second, options.chargeWork),
    );
    case 'trim': return text.trim();
    case 'trimStart': return text.trimStart();
    case 'trimEnd': return text.trimEnd();
    case 'toLowerCase': return text.toLowerCase();
    case 'toUpperCase': return text.toUpperCase();
    case 'charAt': return text.charAt(optionalInteger(first, options.chargeWork) ?? 0);
    case 'charCodeAt': return text.charCodeAt(optionalInteger(first, options.chargeWork) ?? 0);
    case 'concat': return text.concat(...positional.map(value => runtimeToString(value, options.chargeWork)));
    default: throw new TypeError(`Unsupported string intrinsic ${name}`);
  }
}

function invokeNumberIntrinsic(
  value: number,
  name: string,
  positional: readonly RuntimeValue[],
): string {
  const argument = positional[0] === undefined
    ? undefined
    : runtimeToNumber(positional[0]);
  switch (name) {
    case 'toFixed': return argument === undefined ? value.toFixed() : value.toFixed(argument);
    case 'toExponential': return argument === undefined ? value.toExponential() : value.toExponential(argument);
    case 'toPrecision': return argument === undefined ? value.toPrecision() : value.toPrecision(argument);
    case 'toString': return argument === undefined ? value.toString() : value.toString(argument);
    default: throw new TypeError(`Unsupported number intrinsic ${name}`);
  }
}

function invokeArrayIntrinsic(
  receiver: RuntimeArray,
  name: string,
  positional: readonly RuntimeValue[],
  options: RuntimeIntrinsicOptions,
): RuntimeValue {
  const items = receiver.copySparse();
  const first = positional[0];
  const second = positional[1];
  const third = positional[2];
  switch (name) {
    case 'at': return items.at(toInteger(first, options.chargeWork));
    case 'concat': return concatRuntimeArrays(receiver, positional);
    case 'flat': return flatRuntimeArray(receiver, optionalDepth(first, options.chargeWork), options.chargeWork);
    case 'includes': return items.includes(first, optionalInteger(second, options.chargeWork));
    case 'indexOf': return items.indexOf(first, optionalInteger(second, options.chargeWork));
    case 'lastIndexOf': return second === undefined
      ? items.lastIndexOf(first)
      : items.lastIndexOf(first, toInteger(second, options.chargeWork));
    case 'join': return joinRuntimeArray(receiver, first, options.chargeWork);
    case 'slice': return new RuntimeArray(items.slice(
      optionalInteger(first, options.chargeWork),
      optionalInteger(second, options.chargeWork),
    ));
    case 'push':
    case 'append': {
      const length = items.push(...positional);
      receiver.replace(items);
      return length;
    }
    case 'pop': {
      if (options.cookiecutterCompat && first !== undefined) {
        const index = normalizeExistingIndex(toInteger(first, options.chargeWork), items.length);
        if (index === undefined) return undefined;
        const removed = items.splice(index, 1);
        receiver.replace(items);
        return removed[0];
      }
      const value = items.pop();
      receiver.replace(items);
      return value;
    }
    case 'shift': {
      const value = items.shift();
      receiver.replace(items);
      return value;
    }
    case 'unshift': {
      const length = items.unshift(...positional);
      receiver.replace(items);
      return length;
    }
    case 'splice': {
      const start = first === undefined ? 0 : toInteger(first, options.chargeWork);
      const removed = first === undefined
        ? []
        : second === undefined
          ? items.splice(start)
          : items.splice(start, Math.max(0, toInteger(second, options.chargeWork)), ...positional.slice(2));
      receiver.replace(items);
      return new RuntimeArray(removed);
    }
    case 'sort': {
      items.sort(compareRuntimeArrayItems);
      receiver.replace(items);
      return receiver;
    }
    case 'reverse':
      items.reverse();
      receiver.replace(items);
      return receiver;
    case 'fill':
      items.fill(
        first,
        optionalInteger(second, options.chargeWork) ?? 0,
        optionalInteger(third, options.chargeWork) ?? items.length,
      );
      receiver.replace(items);
      return receiver;
    case 'copyWithin':
      items.copyWithin(
        toInteger(first, options.chargeWork),
        optionalInteger(second, options.chargeWork) ?? 0,
        optionalInteger(third, options.chargeWork) ?? items.length,
      );
      receiver.replace(items);
      return receiver;
    case 'insert': {
      const removed = items.splice(toInteger(first, options.chargeWork), 0, second);
      receiver.replace(items);
      return new RuntimeArray(removed);
    }
    case 'remove': {
      const index = items.indexOf(first);
      const removed = index < 0 ? [] : items.splice(index, 1);
      receiver.replace(items);
      return new RuntimeArray(removed);
    }
    case 'count': {
      let count = 0;
      for (const item of receiver.presentValues()) {
        options.chargeWork?.();
        if (runtimeStrictEqual(item, first)) count += 1;
      }
      return count;
    }
    case 'index':
    case 'find': return items.indexOf(first);
    default: throw new TypeError(`Unsupported array intrinsic ${name}`);
  }
}

function invokeRecordIntrinsic(
  receiver: RuntimeRecord,
  name: string,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (name === 'get') {
    const key = runtimeToString(positional[0]);
    return receiver.has(key) ? receiver.get(key) : positional[1];
  }
  if (name === 'has_key') {
    return receiver.has(runtimeToString(positional[0]));
  }
  if (name === 'keys') {
    return new RuntimeArray(Array.from(receiver.entries(), ([key]) => key));
  }
  if (name === 'values') {
    return new RuntimeArray(Array.from(receiver.entries(), ([, value]) => value));
  }
  if (name === 'items') {
    return new RuntimeArray(Array.from(
      receiver.entries(),
      ([key, value]) => new RuntimeArray([key, value]),
    ));
  }
  throw new TypeError(`Unsupported record intrinsic ${name}`);
}

function invokeMapIntrinsic(
  receiver: RuntimeMap,
  name: string,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (name === 'get') return receiver.get(positional[0]);
  if (name === 'has') return receiver.has(positional[0]);
  if (name === 'set') return receiver.set(positional[0], positional[1]);
  if (name === 'delete') return receiver.delete(positional[0]);
  if (name === 'clear') {
    receiver.clear();
    return undefined;
  }
  if (name === 'keys') return new RuntimeArray(Array.from(receiver.keys()));
  if (name === 'values') return new RuntimeArray(Array.from(receiver.values()));
  if (name === 'entries') {
    return new RuntimeArray(Array.from(
      receiver.entries(),
      ([key, value]) => new RuntimeArray([key, value]),
    ));
  }
  throw new TypeError(`Unsupported Map intrinsic ${name}`);
}

function invokeSetIntrinsic(
  receiver: RuntimeSet,
  name: string,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (name === 'has') return receiver.has(positional[0]);
  if (name === 'add') return receiver.add(positional[0]);
  if (name === 'delete') return receiver.delete(positional[0]);
  if (name === 'clear') {
    receiver.clear();
    return undefined;
  }
  if (name === 'values') return new RuntimeArray(Array.from(receiver.values()));
  if (name === 'entries') {
    return new RuntimeArray(Array.from(
      receiver.values(),
      value => new RuntimeArray([value, value]),
    ));
  }
  throw new TypeError(`Unsupported Set intrinsic ${name}`);
}

function concatRuntimeArrays(
  receiver: RuntimeArray,
  positional: readonly RuntimeValue[],
): RuntimeArray {
  const output = receiver.copySparse();
  for (const value of positional) {
    if (value instanceof RuntimeArray) {
      const start = output.length;
      output.length += value.length;
      for (let index = 0; index < value.length; index += 1) {
        if (value.has(index)) {
          defineOwnArrayIndex(output, start + index, value.at(index));
        }
      }
    } else {
      output.push(value);
    }
  }
  return new RuntimeArray(output);
}

function flatRuntimeArray(
  receiver: RuntimeArray,
  depth: number,
  chargeWork?: RuntimeWorkCharge,
): RuntimeArray {
  const output: RuntimeValue[] = [];
  appendFlattenedValues(output, receiver, depth, chargeWork);
  return new RuntimeArray(output);
}

function appendFlattenedValues(
  output: RuntimeValue[],
  value: RuntimeArray,
  depth: number,
  chargeWork?: RuntimeWorkCharge,
): void {
  for (let index = 0; index < value.length; index += 1) {
    chargeWork?.();
    if (!value.has(index)) continue;
    const item = value.at(index);
    if (depth > 0 && item instanceof RuntimeArray) {
      appendFlattenedValues(output, item, depth - 1, chargeWork);
    } else {
      output.push(item);
    }
  }
}

function joinRuntimeArray(
  receiver: RuntimeArray,
  separatorValue: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): string {
  const separator = separatorValue === undefined
    ? ','
    : runtimeToString(separatorValue, chargeWork);
  const output: string[] = [];
  output.length = receiver.length;
  for (let index = 0; index < receiver.length; index += 1) {
    chargeWork?.();
    const value = receiver.at(index);
    output[index] = !receiver.has(index) || value === undefined || value === null
      ? ''
      : runtimeToString(value, chargeWork);
  }
  return output.join(separator);
}

function compareRuntimeArrayItems(left: RuntimeValue, right: RuntimeValue): number {
  const leftText = runtimeToString(left);
  const rightText = runtimeToString(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function normalizeExistingIndex(index: number, length: number): number | undefined {
  const normalized = index < 0 ? length + index : index;
  return normalized >= 0 && normalized < length ? normalized : undefined;
}

function optionalDepth(value: RuntimeValue, chargeWork?: RuntimeWorkCharge): number {
  if (value === undefined) return 1;
  const depth = toInteger(value, chargeWork);
  return Math.max(0, depth);
}

function optionalInteger(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): number | undefined {
  return value === undefined ? undefined : toInteger(value, chargeWork);
}

function optionalNumber(
  value: RuntimeValue,
  chargeWork?: RuntimeWorkCharge,
): number | undefined {
  return value === undefined ? undefined : runtimeToNumber(value, chargeWork);
}

function toInteger(value: RuntimeValue, chargeWork?: RuntimeWorkCharge): number {
  const number = runtimeToNumber(value, chargeWork);
  if (Number.isNaN(number) || number === 0) return 0;
  if (!Number.isFinite(number)) return number;
  return Math.trunc(number);
}

function toUint32(value: RuntimeValue, chargeWork?: RuntimeWorkCharge): number {
  return runtimeToNumber(value, chargeWork) >>> 0;
}

function assertRegexExecution(options: RuntimeIntrinsicOptions): void {
  if (!options.allowRegexExecution) {
    throw new TypeError('Template regular-expression execution is disabled');
  }
}

function createNativeRegex(value: RuntimeRegex): RegExp {
  const regex = new RegExp(value.source, value.flags);
  regex.lastIndex = value.lastIndex;
  return regex;
}
