import type {
  TemplateCapabilities,
  TemplateFilter,
  TemplateGlobalFunction,
} from '../capabilities.ts';
import {
  copyPublicValue,
  copyRuntimeValue,
  isReservedName,
  type RuntimeValue,
} from './value.ts';
import type { RuntimeArguments, RuntimeHost } from './evaluator.ts';

/** An opaque fail-stop signal for one trusted capability exception. */
class RuntimeCapabilityError extends Error {
  constructor(cause: unknown) {
    super('Template capability failed', { cause });
    this.name = 'RuntimeCapabilityError';
  }
}

/** Creates an immutable synchronous host dispatcher for the interpreter. */
export function createRuntimeHost(capabilities: TemplateCapabilities): RuntimeHost {
  const filters = copyFunctions(capabilities.filters, 'filter');
  const globalFunctions = new Map<string, TemplateGlobalFunction>();
  const globalValues = new Map<string, RuntimeValue>();
  copyGlobals(capabilities.globals, globalFunctions, globalValues);

  return Object.freeze({
    hasFilter(name) {
      return filters.has(name);
    },
    hasGlobal(name) {
      return globalFunctions.has(name);
    },
    globalValue(name) {
      return globalValues.has(name)
        ? { found: true, value: globalValues.get(name) }
        : { found: false };
    },
    filter(name, input, arguments_) {
      const callback = filters.get(name);
      if (!callback) {
        return { found: false };
      }
      let value;
      try {
        value = callback(
          copyPublicValue(input),
          ...arguments_.positional.map(copyPublicValue),
        );
      } catch (cause) {
        throw new RuntimeCapabilityError(cause);
      }
      return { found: true, value: copyRuntimeValue(value) };
    },
    global(name, arguments_) {
      const callback = globalFunctions.get(name);
      if (!callback) {
        return { found: false };
      }
      let value;
      try {
        value = callback(...arguments_.positional.map(copyPublicValue));
      } catch (cause) {
        throw new RuntimeCapabilityError(cause);
      }
      return { found: true, value: copyRuntimeValue(value) };
    },
  } satisfies RuntimeHost);
}

function copyFunctions<T extends TemplateFilter | TemplateGlobalFunction>(
  callbacks: Readonly<Record<string, T>> | undefined,
  kind: string,
): ReadonlyMap<string, T> {
  const copied = new Map<string, T>();
  if (!callbacks) {
    return copied;
  }
  assertPlainRecord(callbacks, `${kind} registry`);
  for (const key of Reflect.ownKeys(callbacks)) {
    if (typeof key !== 'string') {
      throw new TypeError(`Template ${kind} registry cannot contain symbol keys`);
    }
    if (isReservedName(key)) {
      throw new TypeError(`Template ${kind} name ${key} is reserved`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(callbacks, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new TypeError(`Template ${kind} ${key} must be a function data property`);
    }
    copied.set(key, descriptor.value as T);
  }
  return copied;
}

function copyGlobals(
  globals: TemplateCapabilities['globals'],
  functions: Map<string, TemplateGlobalFunction>,
  values: Map<string, RuntimeValue>,
): void {
  if (!globals) {
    return;
  }
  assertPlainRecord(globals, 'global registry');
  for (const key of Reflect.ownKeys(globals)) {
    if (typeof key !== 'string') {
      throw new TypeError('Template global registry cannot contain symbol keys');
    }
    if (isReservedName(key)) {
      throw new TypeError(`Template global name ${key} is reserved`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(globals, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    if (!('value' in descriptor)) {
      throw new TypeError(`Template global ${key} must be a data property`);
    }
    if (typeof descriptor.value === 'function') {
      functions.set(key, descriptor.value as TemplateGlobalFunction);
    } else {
      values.set(key, copyRuntimeValue(descriptor.value));
    }
  }
}

function assertPlainRecord(value: object, description: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Template ${description} must be a plain record`);
  }
}
