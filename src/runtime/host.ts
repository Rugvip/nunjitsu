import type {
  CapabilityCallContext,
  TemplateCapabilities,
  TemplateFilter,
  TemplateGlobal,
  TemplateTest,
} from '../capabilities.ts';
import {
  copyPublicValue,
  copyRuntimeValue,
  isReservedName,
  type RuntimeValue,
} from './value.ts';
import type { RuntimeArguments, RuntimeHost } from './evaluator.ts';

/** Creates an immutable trusted-host dispatcher for the native interpreter. */
export function createRuntimeHost(capabilities: TemplateCapabilities): RuntimeHost {
  const filters = copyCallbacks(capabilities.filters, 'filter');
  const tests = copyCallbacks(capabilities.tests, 'test');
  const globals = copyCallbacks(capabilities.globals, 'global');

  return Object.freeze({
    async filter(name, input, arguments_, signal) {
      const callback = filters.get(name) as TemplateFilter | undefined;
      if (!callback) {
        return { found: false };
      }
      throwIfAborted(signal);
      const value = await callback(
        copyPublicValue(input),
        arguments_.positional.map(copyPublicValue),
        capabilityContext(signal),
      );
      return { found: true, value: copyRuntimeValue(value) };
    },
    async test(name, input, arguments_, signal) {
      const callback = tests.get(name) as TemplateTest | undefined;
      if (!callback) {
        return undefined;
      }
      throwIfAborted(signal);
      const value = await callback(
        copyPublicValue(input),
        arguments_.positional.map(copyPublicValue),
        capabilityContext(signal),
      );
      if (typeof value !== 'boolean') {
        throw new TypeError(`Template test ${name} must return a boolean`);
      }
      return value;
    },
    async global(name, arguments_, signal) {
      const callback = globals.get(name) as TemplateGlobal | undefined;
      if (!callback) {
        return { found: false };
      }
      throwIfAborted(signal);
      const value = await callback(
        arguments_.positional.map(copyPublicValue),
        capabilityContext(signal),
      );
      return { found: true, value: copyRuntimeValue(value) };
    },
  } satisfies RuntimeHost);
}

function copyCallbacks<T extends TemplateFilter | TemplateTest | TemplateGlobal>(
  callbacks: Readonly<Record<string, T>> | undefined,
  kind: string,
): ReadonlyMap<string, T> {
  const copied = new Map<string, T>();
  if (!callbacks) {
    return copied;
  }
  const prototype = Object.getPrototypeOf(callbacks);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Template ${kind} registry must be a plain record`);
  }
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

function capabilityContext(signal: AbortSignal): CapabilityCallContext {
  return Object.freeze({ signal });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
}
