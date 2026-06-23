import { types } from 'node:util';

import type {
  TemplateCapabilities,
  TemplateFilter,
  TemplateGlobalFunction,
} from '../capabilities.ts';
import { neutralizeDiagnosticMessage } from '../diagnostics.ts';
import { clearLegacyRegExpState } from './clearLegacyRegExpState.ts';
import { RuntimeEvaluationError } from './RuntimeEvaluationError.ts';
import {
  copyPublicValue,
  copyRuntimeValue,
  isReservedName,
  type RuntimeValue,
} from './value.ts';
import type { RuntimeArguments, RuntimeHost } from './evaluator.ts';

const templateIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
      return invokeCapability(() => {
        const value = callback(
          copyPublicValue(input),
          ...arguments_.positional.map(copyPublicValue),
        );
        return { found: true, value: copyRuntimeValue(value) };
      });
    },
    global(name, arguments_) {
      const callback = globalFunctions.get(name);
      if (!callback) {
        return { found: false };
      }
      return invokeCapability(() => {
        const value = callback(...arguments_.positional.map(copyPublicValue));
        return { found: true, value: copyRuntimeValue(value) };
      });
    },
  } satisfies RuntimeHost);
}

function invokeCapability<T>(operation: () => T): T {
  clearLegacyRegExpState();
  try {
    try {
      return operation();
    } catch (thrown) {
      const detail = extractCapabilityMessage(thrown);
      throw new RuntimeEvaluationError(
        'capability_error',
        detail ? `Template capability failed: ${detail}` : 'Template capability failed',
      );
    }
  } finally {
    clearLegacyRegExpState();
  }
}

function extractCapabilityMessage(thrown: unknown): string | undefined {
  if (typeof thrown === 'string') {
    return neutralizeDiagnosticMessage(thrown);
  }
  if (!types.isNativeError(thrown)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(thrown as object, 'message');
  if (
    !descriptor ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'string'
  ) {
    return undefined;
  }
  return neutralizeDiagnosticMessage(descriptor.value);
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
    if (kind === 'filter') {
      assertValidFilterName(key);
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

function assertValidFilterName(name: string): void {
  const segments = name.split('.');
  for (const segment of segments) {
    if (isReservedName(segment)) {
      throw new TypeError(`Template filter name segment ${segment} is reserved`);
    }
    if (!templateIdentifierPattern.test(segment)) {
      throw new TypeError('Template filter name must contain valid identifier segments');
    }
  }
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
    if (!templateIdentifierPattern.test(key)) {
      throw new TypeError('Template global name must be a valid template identifier');
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
  if (types.isProxy(value)) {
    throw new TypeError(`Template ${description} cannot be a Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Template ${description} must be a plain record`);
  }
}
