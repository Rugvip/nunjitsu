const recordHeaderLength = 8;
const recordAlignment = 8;
const wasmPageSize = 65_536;

const recordTag = {
  source: 1,
  string: 2,
  context: 3,
  request: 4,
  output: 5,
} as const;

/** The offsets and cursor for one encoded render request. */
export interface EncodedRenderRequest {
  /** Offset of the request record in the worker arena. */
  requestOffset: number;
  /** First unallocated byte after the encoded request. */
  cursor: number;
}
/** Writes render-local records into one worker's shared arena. */
export class ArenaWriter {
  readonly #memory: WebAssembly.Memory;
  #view: DataView;
  #cursor: number;

  /** Creates a writer beginning at the Wasm-provided arena base. */
  constructor(memory: WebAssembly.Memory, arenaBase: number) {
    this.#memory = memory;
    this.#view = new DataView(memory.buffer);
    this.#cursor = align(arenaBase, recordAlignment);
  }

  /** Encodes an inline template and string context into the arena. */
  encodeRender(source: string, context: Readonly<Record<string, string>>): EncodedRenderRequest {
    const sourceOffset = this.#writeTextRecord(recordTag.source, source);
    const entries = Object.entries(context);
    const encodedEntries = entries.map(([key, value]) => ({
      keyOffset: this.#writeTextRecord(recordTag.string, key),
      valueOffset: this.#writeTextRecord(recordTag.string, value),
    }));

    const contextPayload = new ArrayBuffer(4 + encodedEntries.length * 8);
    const contextView = new DataView(contextPayload);
    contextView.setUint32(0, encodedEntries.length, true);
    for (const [index, entry] of encodedEntries.entries()) {
      const offset = 4 + index * 8;
      contextView.setUint32(offset, entry.keyOffset, true);
      contextView.setUint32(offset + 4, entry.valueOffset, true);
    }
    const contextOffset = this.#writeRecord(recordTag.context, new Uint8Array(contextPayload));

    const requestPayload = new ArrayBuffer(8);
    const requestView = new DataView(requestPayload);
    requestView.setUint32(0, sourceOffset, true);
    requestView.setUint32(4, contextOffset, true);
    const requestOffset = this.#writeRecord(recordTag.request, new Uint8Array(requestPayload));

    return { requestOffset, cursor: this.#cursor };
  }

  #writeTextRecord(tag: number, value: string): number {
    return this.#writeRecord(tag, new TextEncoder().encode(value));
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

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
