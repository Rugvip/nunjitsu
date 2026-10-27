import { randomInt } from 'node:crypto';
import { types } from 'node:util';

/** Platform checks used at the host value boundary. */
export interface HostTypes {
  /** Detects proxies when the host provides a trap-free native check. */
  isProxy(value: unknown): boolean;
  /** Checks the native Map brand. */
  isMap(value: unknown): boolean;
  /** Checks the native Set brand. */
  isSet(value: unknown): boolean;
  /** Checks the native Error brand without inspecting arbitrary objects. */
  isNativeError(value: unknown): value is Error;
}

/** Host value checks that do not invoke user-defined object behavior. */
export const hostTypes: HostTypes = types;

/** Selects a cryptographically random integer below the exclusive maximum. */
export function randomInteger(maximum: number): number {
  return randomInt(maximum);
}

/** Estimates string scratch usage using its exact UTF-8 byte length. */
export function estimateStringBytes(value: string): number {
  return Buffer.byteLength(value);
}

/** Recognizes JSON syntax failures, including errors from another realm. */
export function isJsonSyntaxError(error: unknown): boolean {
  return types.isNativeError(error) && error.name === 'SyntaxError';
}
