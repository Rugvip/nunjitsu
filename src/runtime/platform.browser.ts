import type * as NodePlatform from './platform.ts';

const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const errorIsError = (Error as ErrorConstructor & {
  isError?: (value: unknown) => boolean;
}).isError;

/** Browser value checks; proxies cannot be detected by standard JavaScript. */
export const hostTypes: NodePlatform.HostTypes = {
  isProxy(_value: unknown): boolean {
    return false;
  },
  isMap(value: unknown): value is Map<unknown, unknown> {
    try {
      mapSize.call(value);
      return true;
    } catch {
      return false;
    }
  },
  isSet(value: unknown): value is Set<unknown> {
    try {
      setSize.call(value);
      return true;
    } catch {
      return false;
    }
  },
  isNativeError(value: unknown): value is Error {
    // Older browsers omit host exception details rather than inspecting an unbranded value.
    return errorIsError?.(value) ?? false;
  },
};

/** Selects an unbiased cryptographically random integer below the exclusive maximum. */
export function randomInteger(maximum: number): number {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum >= 2 ** 48) {
    throw new RangeError('Random integer maximum must be a positive integer below 2 ** 48');
  }
  const range = 2 ** 48;
  const ceiling = range - range % maximum;
  const words = new Uint32Array(2);
  let sample: number;
  do {
    globalThis.crypto.getRandomValues(words);
    sample = words[0]! * 0x1_0000 + (words[1]! >>> 16);
  } while (sample >= ceiling);
  return sample % maximum;
}

/** Bounds UTF-8 size in constant time using at most three bytes per UTF-16 code unit. */
export function estimateStringBytes(value: string): number {
  return value.length * 3;
}

/** Recognizes failures from the trusted native JSON parser. */
export function isJsonSyntaxError(error: unknown): boolean {
  return errorIsError
    ? errorIsError(error) && (error as Error).name === 'SyntaxError'
    : error instanceof SyntaxError;
}
