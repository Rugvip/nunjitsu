import { SafeString, type TemplateContext, type TemplateValue } from './values.ts';
import {
  capabilityKind,
  type CapabilityDescriptors,
  type CapabilityKind,
  type TagCapabilityDescriptor,
} from './capabilities.ts';
import {
  encodeRenderLimit,
  NunjitsuLimitError,
  type NormalizedRenderLimits,
} from './limits.ts';

const recordHeaderLength = 8;
const recordAlignment = 8;
const fixedSlotLength = 72;
const memberLength = 4;

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
  capabilityRegistry: 16,
  capabilityRequest: 17,
  tagRegistry: 26,
  regex: 31,
  loadRequest: 34,
} as const;

/** The offsets and cursor for one encoded render request. */
export interface EncodedRenderRequest {
  /** Offset of the request record in the worker arena. */
  requestOffset: number;
  /** First unallocated byte after the encoded request. */
  cursor: number;
  /** Frozen fixed-pool cursors submitted with the request. */
  fixedCursors: FixedMemoryCursors;
}

/** Offsets for one loader result appended while an evaluator is suspended. */
export interface EncodedLoadedTemplate {
  /** Offset of the loaded source record. */
  sourceOffset: number;
  /** Offset of the loader-provided canonical identity. */
  canonicalOffset: number;
  /** First unallocated byte after the loader result. */
  cursor: number;
  /** Frozen fixed-pool cursors submitted with the loader result. */
  fixedCursors: FixedMemoryCursors;
}

/** Offset and cursor for one host capability result appended to a suspended render. */
export interface EncodedCapabilityResult {
  /** Offset of the copied safe result value. */
  valueOffset: number;
  /** First unallocated byte after the result. */
  cursor: number;
  /** Frozen fixed-pool cursors submitted with the capability result. */
  fixedCursors: FixedMemoryCursors;
}

/** Fixed pool offsets and capacities reported by the configured Wasm instance. */
export interface FixedMemoryLayout {
  slotOffset: number;
  slotCapacity: number;
  sourceOffset: number;
  sourceCapacity: number;
  valueOffset: number;
  valueCapacity: number;
  memberOffset: number;
  memberCapacity: number;
}

/** Logical allocation cursors transferred between the host and Wasm owner. */
export interface FixedMemoryCursors {
  slots: number;
  sources: number;
  values: number;
  members: number;
}

/** One validated host capability request decoded from shared memory. */
export interface DecodedCapabilityRequest {
  /** Numeric callback category. */
  kind: CapabilityKind;
  /** Engine-lifetime callback identity. */
  capabilityId: number;
  /** Copied callback arguments in call order. */
  arguments: readonly TemplateValue[];
}

/** One validated dependency request yielded by the Rust evaluator. */
export interface DecodedLoadRequest {
  /** Template name as evaluated from the include, import, or extends expression. */
  name: string;
  /** Canonical identity of the requesting template, absent for anonymous inline source. */
  from?: string;
}

/** Writes render-local records into one worker's shared arena. */
export class ArenaWriter {
  readonly #memory: WebAssembly.Memory;
  #view: DataView;
  #cursor: number;
  readonly #layout: FixedMemoryLayout;
  readonly #fixedCursors: FixedMemoryCursors;

  /** Creates a writer beginning at an aligned free arena cursor. */
  constructor(
    memory: WebAssembly.Memory,
    arenaBase: number,
    layout: FixedMemoryLayout,
    fixedCursors: FixedMemoryCursors,
  ) {
    this.#memory = memory;
    this.#view = new DataView(memory.buffer);
    this.#cursor = align(arenaBase, recordAlignment);
    this.#layout = layout;
    this.#fixedCursors = { ...fixedCursors };
  }

  /** Encodes an inline template, safe context, and render flags into the arena. */
  encodeRender(
    source: string,
    context: TemplateContext,
    options: {
      autoescape: boolean;
      streaming: boolean;
      trimBlocks: boolean;
      lstripBlocks: boolean;
      canonicalName?: string;
      capabilities: CapabilityDescriptors;
      limits: NormalizedRenderLimits;
    },
  ): EncodedRenderRequest {
    const sourceOffset = this.#writeTextRecord(recordTag.source, source);
    const contextOffset = this.#writeValue(context, new Set(), new Map());

    const canonicalOffset = options.canonicalName
      ? this.#writeTextRecord(recordTag.string, options.canonicalName)
      : 0;
    const filtersOffset = this.#writeCapabilityRegistry(options.capabilities.filters);
    const testsOffset = this.#writeCapabilityRegistry(options.capabilities.tests);
    const globalsOffset = this.#writeCapabilityRegistry(options.capabilities.globals);
    const tagsOffset = this.#writeTagRegistry(options.capabilities.tags);
    const requestPayload = new ArrayBuffer(56);
    const requestView = new DataView(requestPayload);
    requestView.setUint32(0, sourceOffset, true);
    requestView.setUint32(4, contextOffset, true);
    requestView.setUint32(
      8,
      (options.autoescape ? 1 : 0) |
        (options.streaming ? 2 : 0) |
        (options.trimBlocks ? 4 : 0) |
        (options.lstripBlocks ? 8 : 0),
      true,
    );
    requestView.setUint32(12, canonicalOffset, true);
    requestView.setUint32(16, encodeRenderLimit(options.limits.workUnits), true);
    requestView.setUint32(20, encodeRenderLimit(options.limits.includeDepth), true);
    requestView.setUint32(24, encodeRenderLimit(options.limits.outputBytes), true);
    requestView.setUint32(28, encodeRenderLimit(options.limits.arenaBytes), true);
    requestView.setUint32(32, encodeRenderLimit(options.limits.loaderCalls), true);
    requestView.setUint32(36, filtersOffset, true);
    requestView.setUint32(40, testsOffset, true);
    requestView.setUint32(44, globalsOffset, true);
    requestView.setUint32(48, encodeRenderLimit(options.limits.capabilityCalls), true);
    requestView.setUint32(52, tagsOffset, true);
    const requestOffset = this.#writeRecord(recordTag.request, new Uint8Array(requestPayload));

    return {
      requestOffset,
      cursor: this.#cursor,
      fixedCursors: this.#snapshotFixedCursors(),
    };
  }

  /** Appends one trusted loader response for a suspended include request. */
  encodeLoadedTemplate(source: string, canonicalName: string): EncodedLoadedTemplate {
    if (!canonicalName) {
      throw new TypeError('Loaded templates require a canonical identity');
    }
    const sourceOffset = this.#writeTextRecord(recordTag.source, source);
    const canonicalOffset = this.#writeTextRecord(recordTag.string, canonicalName);
    return {
      sourceOffset,
      canonicalOffset,
      cursor: this.#cursor,
      fixedCursors: this.#snapshotFixedCursors(),
    };
  }

  /** Appends one copied safe value returned by a trusted host capability. */
  encodeCapabilityResult(value: TemplateValue): EncodedCapabilityResult {
    const valueOffset = this.#writeValue(value, new Set(), new Map());
    return {
      valueOffset,
      cursor: this.#cursor,
      fixedCursors: this.#snapshotFixedCursors(),
    };
  }

  #writeCapabilityRegistry(
    descriptors: readonly { id: number; name: string }[],
  ): number {
    const entries = descriptors.map(descriptor => ({
      id: descriptor.id,
      nameOffset: this.#writeTextRecord(recordTag.string, descriptor.name),
    }));
    const payload = new ArrayBuffer(4 + entries.length * 8);
    const view = new DataView(payload);
    view.setUint32(0, entries.length, true);
    for (const [index, entry] of entries.entries()) {
      view.setUint32(4 + index * 8, entry.id, true);
      view.setUint32(8 + index * 8, entry.nameOffset, true);
    }
    return this.#writeRecord(recordTag.capabilityRegistry, new Uint8Array(payload));
  }

  #writeTagRegistry(descriptors: readonly TagCapabilityDescriptor[]): number {
    const entries = descriptors.map(descriptor => ({
      id: descriptor.id,
      nameOffset: this.#writeTextRecord(recordTag.string, descriptor.name),
      type: descriptor.type === 'inline' ? 0 : 1,
      endTagOffset: descriptor.endTag === undefined
        ? 0
        : this.#writeTextRecord(recordTag.string, descriptor.endTag),
      intermediateOffset: this.#writeStringArray(descriptor.intermediateTags),
    }));
    const payload = new ArrayBuffer(4 + entries.length * 20);
    const view = new DataView(payload);
    view.setUint32(0, entries.length, true);
    for (const [index, entry] of entries.entries()) {
      const offset = 4 + index * 20;
      view.setUint32(offset, entry.id, true);
      view.setUint32(offset + 4, entry.nameOffset, true);
      view.setUint32(offset + 8, entry.type, true);
      view.setUint32(offset + 12, entry.endTagOffset, true);
      view.setUint32(offset + 16, entry.intermediateOffset, true);
    }
    return this.#writeRecord(recordTag.tagRegistry, new Uint8Array(payload));
  }

  #writeStringArray(values: readonly string[]): number {
    const offsets = values.map(value => this.#writeTextRecord(recordTag.string, value));
    const payload = new ArrayBuffer(4 + offsets.length * 4);
    const view = new DataView(payload);
    view.setUint32(0, offsets.length, true);
    for (const [index, offset] of offsets.entries()) {
      view.setUint32(4 + index * 4, offset, true);
    }
    return this.#writeRecord(recordTag.array, new Uint8Array(payload));
  }

  #writeTextRecord(tag: number, value: string): number {
    if (tag === recordTag.source) {
      return this.#writeSourceSlot(value);
    }
    return this.#writeRecord(tag, new TextEncoder().encode(value));
  }

  #writeSourceSlot(value: string): number {
    const start = this.#fixedCursors.sources;
    const end = start + value.length;
    if (end > this.#layout.sourceCapacity) {
      throw new NunjitsuLimitError('arenaBytes');
    }
    const index = this.#reserveSlot();
    const slotOffset = this.#layout.slotOffset + index * fixedSlotLength;
    const slot = new Uint8Array(this.#memory.buffer, slotOffset, fixedSlotLength);
    slot.fill(0);
    this.#view.setUint32(slotOffset, recordTag.source | (16 << 8), true);
    this.#view.setUint32(slotOffset + 4, start, true);
    this.#view.setUint32(slotOffset + 8, value.length, true);
    const codeUnitOffset = this.#layout.sourceOffset + start * 2;
    for (let cursor = 0; cursor < value.length; cursor += 1) {
      this.#view.setUint16(codeUnitOffset + cursor * 2, value.charCodeAt(cursor), true);
    }
    this.#fixedCursors.sources = end;
    return index;
  }

  #writeValue(
    value: TemplateValue,
    ancestors: Set<object>,
    aliases: Map<object, number>,
  ): number {
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
      const payload = new Uint8Array(8);
      new DataView(payload.buffer).setFloat64(0, value, true);
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
    const existing = aliases.get(value);
    if (existing !== undefined) {
      return existing;
    }

    ancestors.add(value);
    let offset: number;
    try {
      offset = Array.isArray(value)
        ? this.#writeArray(value, ancestors, aliases)
        : this.#writeObject(value, ancestors, aliases);
    } finally {
      ancestors.delete(value);
    }
    aliases.set(value, offset);
    return offset;
  }

  #writeArray(
    value: readonly TemplateValue[],
    ancestors: Set<object>,
    aliases: Map<object, number>,
  ): number {
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
      return this.#writeValue(
        descriptor ? descriptor.value as TemplateValue : undefined,
        ancestors,
        aliases,
      );
    });
    const payload = new ArrayBuffer(4 + offsets.length * 4);
    const view = new DataView(payload);
    view.setUint32(0, offsets.length, true);
    for (const [index, offset] of offsets.entries()) {
      view.setUint32(4 + index * 4, offset, true);
    }
    return this.#writeRecord(recordTag.array, new Uint8Array(payload));
  }

  #writeObject(
    value: object,
    ancestors: Set<object>,
    aliases: Map<object, number>,
  ): number {
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
        valueOffset: this.#writeValue(descriptor.value as TemplateValue, ancestors, aliases),
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
    if (
      tag === recordTag.undefined ||
      tag === recordTag.null ||
      tag === recordTag.boolean ||
      tag === recordTag.number
    ) {
      return this.#writeFixedSlot(tag, payload);
    }
    if (tag === recordTag.array || tag === recordTag.record) {
      return this.#writeMemberSlot(tag, payload);
    }
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

  #writeFixedSlot(tag: number, payload: Uint8Array): number {
    const expectedLength = tag === recordTag.boolean ? 1 : tag === recordTag.number ? 8 : 0;
    if (payload.byteLength !== expectedLength) {
      throw new Error('Invalid fixed value slot payload');
    }
    const index = this.#reserveSlot();
    const offset = this.#layout.slotOffset + index * fixedSlotLength;
    const bytes = new Uint8Array(this.#memory.buffer, offset, fixedSlotLength);
    bytes.fill(0);
    this.#view.setUint32(offset, tag | (1 << 8), true);
    bytes.set(payload, 4);
    return index;
  }

  #writeMemberSlot(tag: number, payload: Uint8Array): number {
    if (payload.byteLength % memberLength !== 0) {
      throw new Error('Invalid member-backed slot payload');
    }
    const index = this.#reserveSlot();
    const memberCount = payload.byteLength / memberLength;
    const memberStart = this.#fixedCursors.members;
    const memberEnd = memberStart + memberCount;
    if (memberEnd > this.#layout.memberCapacity) {
      throw new NunjitsuLimitError('arenaBytes');
    }
    const slotOffset = this.#layout.slotOffset + index * fixedSlotLength;
    const slot = new Uint8Array(this.#memory.buffer, slotOffset, fixedSlotLength);
    slot.fill(0);
    this.#view.setUint32(slotOffset, tag | (1 << 8), true);
    this.#view.setUint32(slotOffset + 4, memberStart, true);
    this.#view.setUint32(slotOffset + 8, payload.byteLength, true);
    new Uint8Array(
      this.#memory.buffer,
      this.#layout.memberOffset + memberStart * memberLength,
      payload.byteLength,
    ).set(payload);
    this.#fixedCursors.members = memberEnd;
    return index;
  }

  #reserveSlot(): number {
    const index = this.#fixedCursors.slots;
    if (index < 1 || index > this.#layout.slotCapacity) {
      throw new NunjitsuLimitError('arenaBytes');
    }
    this.#fixedCursors.slots = index + 1;
    return index;
  }

  #snapshotFixedCursors(): FixedMemoryCursors {
    return Object.freeze({ ...this.#fixedCursors });
  }

  #ensureCapacity(requiredLength: number): void {
    if (!Number.isSafeInteger(requiredLength) || requiredLength > 0xffff_ffff) {
      throw new RangeError('The render request exceeds the Wasm32 address space');
    }
    const currentLength = this.#memory.buffer.byteLength;
    if (requiredLength > currentLength) {
      throw new NunjitsuLimitError('arenaBytes');
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

/** Decodes a dependency request and its optional canonical parent identity. */
export function decodeLoadRequest(
  memory: WebAssembly.Memory,
  offset: number,
  length: number,
): DecodedLoadRequest {
  const payload = readRecord(memory, offset, recordTag.loadRequest, length);
  if (payload.byteLength !== 8) {
    throw new Error('Wasm returned an invalid loader request');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const name = decodeNestedString(memory, view.getUint32(0, true), 'loader name');
  const fromOffset = view.getUint32(4, true);
  const from = fromOffset === 0
    ? undefined
    : decodeNestedString(memory, fromOffset, 'loader parent identity');
  return Object.freeze({ name, ...(from === undefined ? {} : { from }) });
}

/** Decodes a yielded capability request and recursively copies its safe arguments. */
export function decodeCapabilityRequest(
  memory: WebAssembly.Memory,
  offset: number,
  length: number,
  layout: FixedMemoryLayout,
  fixedCursors: FixedMemoryCursors,
): DecodedCapabilityRequest {
  const payload = readRecord(memory, offset, recordTag.capabilityRequest, length);
  if (payload.byteLength < 12 || (payload.byteLength - 12) % 4 !== 0) {
    throw new Error('Wasm returned an invalid capability request');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const kind = view.getUint32(0, true);
  if (
    kind !== capabilityKind.filter &&
    kind !== capabilityKind.test &&
    kind !== capabilityKind.global &&
    kind !== capabilityKind.tag
  ) {
    throw new Error('Wasm returned an unknown capability category');
  }
  const count = view.getUint32(8, true);
  if (payload.byteLength !== 12 + count * 4) {
    throw new Error('Wasm returned an inconsistent capability argument count');
  }
  const arguments_: TemplateValue[] = [];
  for (let index = 0; index < count; index += 1) {
    arguments_.push(decodeValue(
      memory,
      view.getUint32(12 + index * 4, true),
      layout,
      fixedCursors,
      new Set(),
    ));
  }
  return Object.freeze({
    kind,
    capabilityId: view.getUint32(4, true),
    arguments: Object.freeze(arguments_),
  });
}

function decodeValue(
  memory: WebAssembly.Memory,
  offset: number,
  layout: FixedMemoryLayout,
  fixedCursors: FixedMemoryCursors,
  ancestors: Set<number>,
): TemplateValue {
  if (ancestors.has(offset)) {
    throw new Error('Wasm returned a cyclic capability value');
  }
  const { tag, payload } = readAnyValue(memory, offset, layout, fixedCursors);
  if (tag === recordTag.undefined && payload.byteLength === 0) {
    return undefined;
  }
  if (tag === recordTag.null && payload.byteLength === 0) {
    return null;
  }
  if (tag === recordTag.boolean && payload.byteLength === 1) {
    if (payload[0] === 0) {
      return false;
    }
    if (payload[0] === 1) {
      return true;
    }
  }
  if (tag === recordTag.number && payload.byteLength >= 8) {
    return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat64(0, true);
  }
  if (tag === recordTag.string || tag === recordTag.safeString || tag === recordTag.regex) {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    return tag === recordTag.safeString ? new SafeString(value) : value;
  }
  if (tag !== recordTag.array && tag !== recordTag.record) {
    throw new Error('Wasm returned an unsupported capability value');
  }

  ancestors.add(offset);
  try {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (payload.byteLength < 4) {
      throw new Error('Wasm returned a truncated capability collection');
    }
    const count = view.getUint32(0, true);
    if (tag === recordTag.array) {
      if (payload.byteLength !== 4 + count * 4) {
        throw new Error('Wasm returned an inconsistent capability array');
      }
      return Object.freeze(Array.from(
        { length: count },
        (_, index) => decodeValue(
          memory,
          view.getUint32(4 + index * 4, true),
          layout,
          fixedCursors,
          ancestors,
        ),
      ));
    }
    if (payload.byteLength !== 4 + count * 8) {
      throw new Error('Wasm returned an inconsistent capability record');
    }
    const result: Record<string, TemplateValue> = Object.create(null) as Record<string, TemplateValue>;
    for (let index = 0; index < count; index += 1) {
      const entry = 4 + index * 8;
      const keyRecord = readAnyRecord(memory, view.getUint32(entry, true));
      if (keyRecord.tag !== recordTag.string) {
        throw new Error('Wasm returned a non-string capability record key');
      }
      const key = new TextDecoder('utf-8', { fatal: true }).decode(keyRecord.payload);
      result[key] = decodeValue(
        memory,
        view.getUint32(entry + 4, true),
        layout,
        fixedCursors,
        ancestors,
      );
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(offset);
  }
}

function readAnyValue(
  memory: WebAssembly.Memory,
  offset: number,
  layout: FixedMemoryLayout,
  fixedCursors: FixedMemoryCursors,
): { tag: number; payload: Uint8Array } {
  if (offset > 0 && offset < fixedCursors.slots) {
    const slotOffset = layout.slotOffset + offset * fixedSlotLength;
    if (offset > layout.slotCapacity || slotOffset + fixedSlotLength > memory.buffer.byteLength) {
      throw new Error('Wasm returned an out-of-bounds value slot');
    }
    const view = new DataView(memory.buffer, slotOffset, fixedSlotLength);
    const header = view.getUint32(0, true);
    const tag = header & 0xff;
    const masks = header >>> 8;
    if ((masks & 1) === 0) {
      throw new Error('Wasm returned a non-value slot as a capability argument');
    }
    if (tag === recordTag.undefined || tag === recordTag.null) {
      return { tag, payload: new Uint8Array(memory.buffer, slotOffset + 4, 0) };
    }
    if (tag === recordTag.boolean) {
      return { tag, payload: new Uint8Array(memory.buffer, slotOffset + 4, 1) };
    }
    if (tag === recordTag.number) {
      return { tag, payload: new Uint8Array(memory.buffer, slotOffset + 4, 8) };
    }
    if (tag === recordTag.array || tag === recordTag.record) {
      const memberStart = view.getUint32(4, true);
      const byteLength = view.getUint32(8, true);
      if (byteLength % memberLength !== 0) {
        throw new Error('Wasm returned a misaligned member range');
      }
      const memberCount = byteLength / memberLength;
      if (
        memberStart + memberCount > fixedCursors.members ||
        memberStart + memberCount > layout.memberCapacity
      ) {
        throw new Error('Wasm returned an out-of-bounds member range');
      }
      return {
        tag,
        payload: new Uint8Array(
          memory.buffer,
          layout.memberOffset + memberStart * memberLength,
          byteLength,
        ),
      };
    }
    throw new Error('Wasm returned an unsupported value slot');
  }
  return readAnyRecord(memory, offset);
}

function readRecord(
  memory: WebAssembly.Memory,
  offset: number,
  expectedTag: number,
  expectedLength: number,
): Uint8Array {
  const record = readAnyRecord(memory, offset);
  if (record.tag !== expectedTag || record.payload.byteLength !== expectedLength) {
    throw new Error('Wasm returned an inconsistent record envelope');
  }
  return record.payload;
}

function readAnyRecord(
  memory: WebAssembly.Memory,
  offset: number,
): { tag: number; payload: Uint8Array } {
  const buffer = memory.buffer;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + recordHeaderLength > buffer.byteLength) {
    throw new Error('Wasm returned an out-of-bounds record');
  }
  const view = new DataView(buffer);
  const length = view.getUint32(offset + 4, true);
  const end = offset + recordHeaderLength + length;
  if (end > buffer.byteLength) {
    throw new Error('Wasm returned an out-of-bounds record payload');
  }
  return {
    tag: view.getUint32(offset, true),
    payload: new Uint8Array(buffer, offset + recordHeaderLength, length),
  };
}

function decodeNestedString(memory: WebAssembly.Memory, offset: number, label: string): string {
  const record = readAnyRecord(memory, offset);
  if (record.tag !== recordTag.string) {
    throw new Error(`Wasm returned a non-string ${label}`);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(record.payload);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function isArrayIndex(value: string, length: number): boolean {
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}
