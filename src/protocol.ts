import { SafeString, type TemplateContext, type TemplateValue } from './values.ts';

const recordHeaderLength = 8;
const recordAlignment = 8;
const wasmPageSize = 65_536;

const recordTag = {
  source: 1,
  string: 2,
  context: 3,
  request: 4,
  output: 5,
  undefined: 6,
  null: 7,
  boolean: 8,
  number: 9,
  array: 10,
  record: 11,
  safeString: 12,
} as const;

/** The offsets and cursor for one encoded render request. */
export interface EncodedRenderRequest {
  /** Offset of the request record in the worker arena. */
  requestOffset: number;
  /** First unallocated byte after the encoded request. */
  cursor: number;
}

/** Offsets for one loader result appended while an evaluator is suspended. */
export interface EncodedLoadedTemplate {
  /** Offset of the loaded source record. */
  sourceOffset: number;
  /** Offset of the loader-provided canonical identity. */
  canonicalOffset: number;
  /** First unallocated byte after the loader result. */
  cursor: number;
}
/** Writes render-local records into one worker's shared arena. */
export class ArenaWriter {
  readonly #memory: WebAssembly.Memory;
  #view: DataView;
  #cursor: number;

  /** Creates a writer beginning at an aligned free arena cursor. */
  constructor(memory: WebAssembly.Memory, arenaBase: number) {
    this.#memory = memory;
    this.#view = new DataView(memory.buffer);
    this.#cursor = align(arenaBase, recordAlignment);
  }

  /** Encodes an inline template, safe context, and render flags into the arena. */
  encodeRender(
    source: string,
    context: TemplateContext,
    options: { autoescape: boolean; canonicalName?: string },
  ): EncodedRenderRequest {
    const sourceOffset = this.#writeTextRecord(recordTag.source, source);
    const contextOffset = this.#writeValue(context, new Set());

    const canonicalOffset = options.canonicalName
      ? this.#writeTextRecord(recordTag.string, options.canonicalName)
      : 0;
    const requestPayload = new ArrayBuffer(16);
    const requestView = new DataView(requestPayload);
    requestView.setUint32(0, sourceOffset, true);
    requestView.setUint32(4, contextOffset, true);
    requestView.setUint32(8, options.autoescape ? 1 : 0, true);
    requestView.setUint32(12, canonicalOffset, true);
    const requestOffset = this.#writeRecord(recordTag.request, new Uint8Array(requestPayload));

    return { requestOffset, cursor: this.#cursor };
  }

  /** Appends one trusted loader response for a suspended include request. */
  encodeLoadedTemplate(source: string, canonicalName: string): EncodedLoadedTemplate {
    if (!canonicalName) {
      throw new TypeError('Loaded templates require a canonical identity');
    }
    const sourceOffset = this.#writeTextRecord(recordTag.source, source);
    const canonicalOffset = this.#writeTextRecord(recordTag.string, canonicalName);
    return { sourceOffset, canonicalOffset, cursor: this.#cursor };
  }

  #writeTextRecord(tag: number, value: string): number {
    return this.#writeRecord(tag, new TextEncoder().encode(value));
  }

  #writeValue(value: TemplateValue, ancestors: Set<object>): number {
    if (value === undefined) {
      return this.#writeRecord(recordTag.undefined, new Uint8Array());
    }
    if (value === null) {
      return this.#writeRecord(recordTag.null, new Uint8Array());
    }
    if (typeof value === 'string') {
      return this.#writeTextRecord(recordTag.string, value);
    }
    if (typeof value === 'boolean') {
      return this.#writeRecord(recordTag.boolean, Uint8Array.of(value ? 1 : 0));
    }
    if (typeof value === 'number') {
      const rendered = new TextEncoder().encode(String(value));
      const payload = new Uint8Array(8 + rendered.byteLength);
      new DataView(payload.buffer).setFloat64(0, value, true);
      payload.set(rendered, 8);
      return this.#writeRecord(recordTag.number, payload);
    }
    if (value instanceof SafeString) {
      return this.#writeTextRecord(recordTag.safeString, value.value);
    }
    if (typeof value !== 'object') {
      throw new TypeError(`Unsupported template value of type ${typeof value}`);
    }
    if (ancestors.has(value)) {
      throw new TypeError('Cyclic template values are not supported');
    }

    ancestors.add(value);
    try {
      return Array.isArray(value)
        ? this.#writeArray(value, ancestors)
        : this.#writeObject(value, ancestors);
    } finally {
      ancestors.delete(value);
    }
  }

  #writeArray(value: readonly TemplateValue[], ancestors: Set<object>): number {
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') {
        continue;
      }
      if (typeof key !== 'string' || !isArrayIndex(key, value.length)) {
        throw new TypeError('Template arrays cannot have custom properties');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.get || descriptor?.set) {
        throw new TypeError('Template values cannot contain accessors');
      }
    }

    const offsets = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return this.#writeValue(descriptor ? descriptor.value as TemplateValue : undefined, ancestors);
    });
    const payload = new ArrayBuffer(4 + offsets.length * 4);
    const view = new DataView(payload);
    view.setUint32(0, offsets.length, true);
    for (const [index, offset] of offsets.entries()) {
      view.setUint32(4 + index * 4, offset, true);
    }
    return this.#writeRecord(recordTag.array, new Uint8Array(payload));
  }

  #writeObject(value: object, ancestors: Set<object>): number {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain records can be used as template values');
    }

    const entries: Array<{ keyOffset: number; valueOffset: number }> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError('Template records cannot contain symbol keys');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }
      if (descriptor.get || descriptor.set) {
        throw new TypeError('Template values cannot contain accessors');
      }
      if (!descriptor.enumerable) {
        continue;
      }
      entries.push({
        keyOffset: this.#writeTextRecord(recordTag.string, key),
        valueOffset: this.#writeValue(descriptor.value as TemplateValue, ancestors),
      });
    }

    const payload = new ArrayBuffer(4 + entries.length * 8);
    const view = new DataView(payload);
    view.setUint32(0, entries.length, true);
    for (const [index, entry] of entries.entries()) {
      const offset = 4 + index * 8;
      view.setUint32(offset, entry.keyOffset, true);
      view.setUint32(offset + 4, entry.valueOffset, true);
    }
    return this.#writeRecord(recordTag.record, new Uint8Array(payload));
  }

  #writeRecord(tag: number, payload: Uint8Array): number {
    const offset = align(this.#cursor, recordAlignment);
    const end = offset + recordHeaderLength + payload.byteLength;
    const nextCursor = align(end, recordAlignment);
    this.#ensureCapacity(nextCursor);

    this.#view.setUint32(offset, tag, true);
    this.#view.setUint32(offset + 4, payload.byteLength, true);
    new Uint8Array(this.#memory.buffer, offset + recordHeaderLength, payload.byteLength).set(payload);
    this.#cursor = nextCursor;
    return offset;
  }

  #ensureCapacity(requiredLength: number): void {
    if (!Number.isSafeInteger(requiredLength) || requiredLength > 0xffff_ffff) {
      throw new RangeError('The render request exceeds the Wasm32 address space');
    }
    const currentLength = this.#memory.buffer.byteLength;
    if (requiredLength > currentLength) {
      const pages = Math.ceil((requiredLength - currentLength) / wasmPageSize);
      this.#memory.grow(pages);
      this.#view = new DataView(this.#memory.buffer);
    }
  }
}

/** Decodes and validates an output record produced by Wasm. */
export function decodeOutput(memory: WebAssembly.Memory, offset: number, length: number): string {
  const buffer = memory.buffer;
  const recordEnd = offset + recordHeaderLength + length;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    recordEnd > buffer.byteLength
  ) {
    throw new Error('Wasm returned an out-of-bounds output record');
  }

  const view = new DataView(buffer);
  if (view.getUint32(offset, true) !== recordTag.output) {
    throw new Error('Wasm returned an unexpected output record type');
  }
  if (view.getUint32(offset + 4, true) !== length) {
    throw new Error('Wasm returned an inconsistent output record length');
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(
    new Uint8Array(buffer, offset + recordHeaderLength, length),
  );
}

/** Decodes a string record after validating its tag, length, and bounds. */
export function decodeStringRecord(
  memory: WebAssembly.Memory,
  offset: number,
  length: number,
): string {
  const buffer = memory.buffer;
  const recordEnd = offset + recordHeaderLength + length;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    recordEnd > buffer.byteLength
  ) {
    throw new Error('Wasm returned an out-of-bounds string record');
  }
  const view = new DataView(buffer);
  if (
    view.getUint32(offset, true) !== recordTag.string ||
    view.getUint32(offset + 4, true) !== length
  ) {
    throw new Error('Wasm returned an invalid string record');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(
    new Uint8Array(buffer, offset + recordHeaderLength, length),
  );
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function isArrayIndex(value: string, length: number): boolean {
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}
