import { parentPort, workerData, type MessagePort } from 'node:worker_threads';

import {
  decodeLoadRequest,
  type FixedMemoryCursors,
  type FixedMemoryLayout,
} from './protocol.ts';

const poolSlots = 1;
const poolSources = 2;
const poolValues = 3;
const poolMembers = 4;
const poolStringOperations = 5;
const poolOutputRanges = 7;
const poolScratch = 8;

/** Data supplied by the engine when a worker starts. */
interface NunjitsuWorkerData {
  memory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
  memoryLayout: NunjitsuWorkerMemoryLayout;
}

/** Fixed capacities used to configure the Wasm singleton prefix and storage pools. */
interface NunjitsuWorkerMemoryLayout {
  slots: number;
  sourceCodeUnits: number;
  valueCodeUnits: number;
  members: number;
  stringOperations: number;
  stringQueries: number;
  outputRanges: number;
  scratchBytes: number;
}

/** Initial render command accepted by an idle worker. */
interface RenderCommand {
  type: 'render';
  id: number;
  requestOffset: number;
  cursor: number;
  fixedCursors: FixedMemoryCursors;
}

/** Loader result command accepted while the evaluator is suspended. */
interface ResumeLoadCommand {
  type: 'resumeLoad';
  id: number;
  sourceOffset: number;
  canonicalOffset: number;
  cursor: number;
  fixedCursors: FixedMemoryCursors;
}

/** Recoverable absence result accepted for an optional include. */
interface ResumeLoadMissingCommand {
  type: 'resumeLoadMissing';
  id: number;
}

/** Pull command accepted while streaming output is suspended. */
interface ResumeOutputCommand {
  type: 'resumeOutput';
  id: number;
}

/** Host capability result accepted while expression evaluation is suspended. */
interface ResumeCapabilityCommand {
  type: 'resumeCapability';
  id: number;
  valueOffset: number;
  cursor: number;
  fixedCursors: FixedMemoryCursors;
}

/** Command accepted by the worker protocol. */
type WorkerCommand =
  | RenderCommand
  | ResumeLoadCommand
  | ResumeLoadMissingCommand
  | ResumeOutputCommand
  | ResumeCapabilityCommand;

/** Numeric exports in the Nunjitsu raw Wasm ABI. */
interface NunjitsuExports {
  abiVersion: () => number;
  layoutVersion: () => number;
  memoryPrefixOffset: () => number;
  slotSize: () => number;
  configureLayout: (
    slots: number,
    sourceCodeUnits: number,
    valueCodeUnits: number,
    members: number,
    stringOperations: number,
    stringQueries: number,
    outputRanges: number,
    scratchBytes: number,
  ) => number;
  poolOffset: (kind: number) => number;
  poolCapacity: (kind: number) => number;
  poolCursor: (kind: number) => number;
  acceptHostCursors: (
    slots: number,
    sources: number,
    values: number,
    members: number,
    strings: number,
  ) => number;
  hostStringCount: () => number;
  arenaBase: () => number;
  arenaCursor: () => number;
  arenaReset: () => void;
  arenaSetCursor: (cursor: number) => number;
  controlOffset: () => number;
  render: (requestOffset: number) => number;
  resumeInclude: (sourceOffset: number, canonicalOffset: number) => number;
  resumeIncludeMissing: () => number;
  resumeOutput: () => number;
  resumeCapability: (valueOffset: number) => number;
}

if (!parentPort) {
  throw new Error('Nunjitsu workers require a parent message port');
}

void start(parentPort).catch(error => {
  setImmediate(() => {
    throw error;
  });
});

async function start(port: MessagePort): Promise<void> {
  const data = parseWorkerData(workerData);
  const instance = await WebAssembly.instantiate(data.wasmModule, {
    env: {
      memory: data.memory,
      nunjitsu_random_index: randomIndex,
      nunjitsu_regex_replace: (
        inputOffset: number,
        inputLength: number,
        regexOffset: number,
        regexLength: number,
        replacementOffset: number,
        replacementLength: number,
        outputOffset: number,
        outputCapacity: number,
      ) => regexReplace(
        data.memory,
        inputOffset,
        inputLength,
        regexOffset,
        regexLength,
        replacementOffset,
        replacementLength,
        outputOffset,
        outputCapacity,
      ),
    },
  });
  const exports = parseExports(instance.exports);
  const layout = data.memoryLayout;
  if (
    exports.configureLayout(
      layout.slots,
      layout.sourceCodeUnits,
      layout.valueCodeUnits,
      layout.members,
      layout.stringOperations,
      layout.stringQueries,
      layout.outputRanges,
      layout.scratchBytes,
    ) !== 1
  ) {
    throw new Error('Nunjitsu worker memory capacities do not fit the Wasm memory');
  }
  exports.arenaReset();
  const controlOffset = exports.controlOffset();
  const memoryLayout = readFixedMemoryLayout(exports);

  port.postMessage({
    type: 'ready',
    abiVersion: exports.abiVersion(),
    arenaBase: exports.arenaBase(),
    layoutVersion: exports.layoutVersion(),
    prefixOffset: exports.memoryPrefixOffset(),
    slotSize: exports.slotSize(),
    memoryLayout,
  });

  let activeRenderId: number | undefined;
  port.on('message', (value: unknown) => {
    const command = parseCommand(value);
    if (command.type === 'render') {
      if (activeRenderId !== undefined) {
        throw new Error('Nunjitsu worker received overlapping render commands');
      }
      activeRenderId = command.id;
      acceptHostCursors(exports, command.fixedCursors);
      const cursorState = exports.arenaSetCursor(command.cursor);
      if (cursorState !== 1) {
        finishWithError(port, command.id, cursorState === 2 ? 7 : 1, exports);
        activeRenderId = undefined;
        return;
      }
      const state = exports.render(command.requestOffset);
      activeRenderId = reportState(
        port,
        data.memory,
        exports,
        controlOffset,
        memoryLayout,
        command.id,
        state,
      )
        ? command.id
        : undefined;
      return;
    }

    if (activeRenderId !== command.id) {
      throw new Error('Nunjitsu worker received a stale resume command');
    }
    if (command.type === 'resumeOutput') {
      const state = exports.resumeOutput();
      activeRenderId = reportState(
        port,
        data.memory,
        exports,
        controlOffset,
        memoryLayout,
        command.id,
        state,
      )
        ? command.id
        : undefined;
      return;
    }
    if (command.type === 'resumeCapability') {
      acceptHostCursors(exports, command.fixedCursors);
      const cursorState = exports.arenaSetCursor(command.cursor);
      if (cursorState !== 1) {
        finishWithError(port, command.id, cursorState === 2 ? 7 : 1, exports);
        activeRenderId = undefined;
        return;
      }
      const state = exports.resumeCapability(command.valueOffset);
      activeRenderId = reportState(
        port,
        data.memory,
        exports,
        controlOffset,
        memoryLayout,
        command.id,
        state,
      )
        ? command.id
        : undefined;
      return;
    }
    if (command.type === 'resumeLoadMissing') {
      const state = exports.resumeIncludeMissing();
      activeRenderId = reportState(
        port,
        data.memory,
        exports,
        controlOffset,
        memoryLayout,
        command.id,
        state,
      )
        ? command.id
        : undefined;
      return;
    }
    acceptHostCursors(exports, command.fixedCursors);
    const cursorState = exports.arenaSetCursor(command.cursor);
    if (cursorState !== 1) {
      finishWithError(port, command.id, cursorState === 2 ? 7 : 1, exports);
      activeRenderId = undefined;
      return;
    }
    const state = exports.resumeInclude(command.sourceOffset, command.canonicalOffset);
    activeRenderId = reportState(
      port,
      data.memory,
      exports,
      controlOffset,
      memoryLayout,
      command.id,
      state,
    )
      ? command.id
      : undefined;
  });
}

function randomIndex(upperBound: number): number {
  const normalized = upperBound >>> 0;
  if (normalized === 0) {
    return 0;
  }
  return Math.floor(Math.random() * normalized);
}

function regexReplace(
  memory: WebAssembly.Memory,
  inputOffset: number,
  inputLength: number,
  regexOffset: number,
  regexLength: number,
  replacementOffset: number,
  replacementLength: number,
  outputOffset: number,
  outputCapacity: number,
): number {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const input = decoder.decode(memoryBytes(memory, inputOffset, inputLength));
    const literal = decoder.decode(memoryBytes(memory, regexOffset, regexLength));
    const replacement = decoder.decode(
      memoryBytes(memory, replacementOffset, replacementLength),
    );
    const delimiter = literal.lastIndexOf('/');
    if (!literal.startsWith('/') || delimiter === 0) {
      return 0xffff_ffff;
    }
    const expression = new RegExp(literal.slice(1, delimiter), literal.slice(delimiter + 1));
    const encoded = new TextEncoder().encode(input.replace(expression, replacement));
    if (outputCapacity === 0) {
      return encoded.byteLength;
    }
    const output = memoryBytes(memory, outputOffset, outputCapacity);
    if (encoded.byteLength > output.byteLength) {
      return 0xffff_fffe;
    }
    output.set(encoded);
    return encoded.byteLength;
  } catch {
    return 0xffff_ffff;
  }
}

function memoryBytes(
  memory: WebAssembly.Memory,
  offset: number,
  length: number,
): Uint8Array {
  const normalizedOffset = offset >>> 0;
  const normalizedLength = length >>> 0;
  const end = normalizedOffset + normalizedLength;
  if (end > memory.buffer.byteLength) {
    throw new RangeError('Wasm requested memory outside the worker arena');
  }
  return new Uint8Array(memory.buffer, normalizedOffset, normalizedLength);
}

function reportState(
  port: MessagePort,
  memory: WebAssembly.Memory,
  exports: NunjitsuExports,
  controlOffset: number,
  memoryLayout: FixedMemoryLayout,
  id: number,
  state: number,
): boolean {
  const control = new DataView(memory.buffer, controlOffset, 16);
  const controlState = control.getUint32(0, true);
  if (state !== controlState) {
    throw new Error('Nunjitsu Wasm returned an inconsistent control state');
  }
  if (state === 1) {
    port.postMessage({
      type: 'result',
      id,
      state,
      outputOffset: control.getUint32(4, true),
      outputLength: control.getUint32(8, true),
    });
    exports.arenaReset();
    return false;
  }
  if (state === 3 || state === 6) {
    const fixedCursors = readFixedMemoryCursors(exports);
    const request = decodeLoadRequest(
      memory,
      control.getUint32(4, true),
      control.getUint32(8, true),
      memoryLayout,
      fixedCursors,
    );
    port.postMessage({
      type: 'load',
      id,
      name: request.name,
      ...(request.from === undefined ? {} : { from: request.from }),
      cursor: exports.arenaCursor(),
      fixedCursors,
      ignoreMissing: state === 6,
    });
    return true;
  }
  if (state === 4) {
    port.postMessage({
      type: 'chunk',
      id,
      outputOffset: control.getUint32(4, true),
      outputLength: control.getUint32(8, true),
    });
    return true;
  }
  if (state === 5) {
    port.postMessage({
      type: 'capability',
      id,
      requestOffset: control.getUint32(4, true),
      requestLength: control.getUint32(8, true),
      cursor: exports.arenaCursor(),
      fixedCursors: readFixedMemoryCursors(exports),
    });
    return true;
  }
  finishWithError(port, id, control.getUint32(12, true), exports);
  return false;
}

function finishWithError(
  port: MessagePort,
  id: number,
  errorCode: number,
  exports: NunjitsuExports,
): void {
  port.postMessage({
    type: 'result',
    id,
    state: 2,
    errorCode,
  });
  exports.arenaReset();
}

function parseWorkerData(value: unknown): NunjitsuWorkerData {
  if (!value || typeof value !== 'object') {
    throw new Error('Nunjitsu worker data is missing');
  }
  const candidate = value as Record<string, unknown>;
  const memory = candidate.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('Nunjitsu worker requires a shared WebAssembly.Memory');
  }
  if (!(memory.buffer instanceof SharedArrayBuffer)) {
    throw new Error('Nunjitsu worker memory must be shared');
  }
  const wasmModule = candidate.wasmModule;
  if (!(wasmModule instanceof WebAssembly.Module)) {
    throw new Error('Nunjitsu worker requires a compiled Wasm module');
  }
  const memoryLayout = parseMemoryLayout(candidate.memoryLayout);
  return { memory, wasmModule, memoryLayout };
}

function parseMemoryLayout(value: unknown): NunjitsuWorkerMemoryLayout {
  if (!value || typeof value !== 'object') {
    throw new Error('Nunjitsu worker requires fixed memory capacities');
  }
  const candidate = value as Record<string, unknown>;
  const names = [
    'slots',
    'sourceCodeUnits',
    'valueCodeUnits',
    'members',
    'stringOperations',
    'stringQueries',
    'outputRanges',
    'scratchBytes',
  ] as const;
  for (const name of names) {
    const capacity = candidate[name];
    if (!Number.isSafeInteger(capacity) || (capacity as number) < 1) {
      throw new Error(`Nunjitsu worker received an invalid ${name} capacity`);
    }
  }
  return candidate as unknown as NunjitsuWorkerMemoryLayout;
}

function readFixedMemoryLayout(exports: NunjitsuExports): FixedMemoryLayout {
  return Object.freeze({
    slotOffset: exports.poolOffset(poolSlots),
    slotCapacity: exports.poolCapacity(poolSlots),
    sourceOffset: exports.poolOffset(poolSources),
    sourceCapacity: exports.poolCapacity(poolSources),
    valueOffset: exports.poolOffset(poolValues),
    valueCapacity: exports.poolCapacity(poolValues),
    memberOffset: exports.poolOffset(poolMembers),
    memberCapacity: exports.poolCapacity(poolMembers),
    stringOperationOffset: exports.poolOffset(poolStringOperations),
    stringOperationCapacity: exports.poolCapacity(poolStringOperations),
    outputRangeOffset: exports.poolOffset(poolOutputRanges),
    outputRangeCapacity: exports.poolCapacity(poolOutputRanges),
    scratchOffset: exports.poolOffset(poolScratch),
    scratchCapacity: exports.poolCapacity(poolScratch),
  });
}

function readFixedMemoryCursors(exports: NunjitsuExports): FixedMemoryCursors {
  return Object.freeze({
    slots: exports.poolCursor(poolSlots),
    sources: exports.poolCursor(poolSources),
    values: exports.poolCursor(poolValues),
    members: exports.poolCursor(poolMembers),
    strings: exports.hostStringCount(),
  });
}

function acceptHostCursors(
  exports: NunjitsuExports,
  cursors: FixedMemoryCursors,
): void {
  if (
    exports.acceptHostCursors(
      cursors.slots,
      cursors.sources,
      cursors.values,
      cursors.members,
      cursors.strings,
    ) !== 1
  ) {
    throw new Error('Nunjitsu worker rejected host-owned memory cursors');
  }
}

function isFixedMemoryCursors(value: unknown): value is FixedMemoryCursors {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const cursors = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(cursors.slots) &&
    Number.isSafeInteger(cursors.sources) &&
    Number.isSafeInteger(cursors.values) &&
    Number.isSafeInteger(cursors.members) &&
    Number.isSafeInteger(cursors.strings)
  );
}

function parseCommand(value: unknown): WorkerCommand {
  if (!value || typeof value !== 'object') {
    throw new Error('Nunjitsu worker received an invalid command');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'number') {
    throw new Error('Nunjitsu worker received an invalid command envelope');
  }
  if (candidate.type === 'resumeOutput') {
    return { type: 'resumeOutput', id: candidate.id };
  }
  if (candidate.type === 'resumeLoadMissing') {
    return { type: 'resumeLoadMissing', id: candidate.id };
  }
  if (
    candidate.type === 'resumeCapability' &&
    typeof candidate.valueOffset === 'number' &&
    typeof candidate.cursor === 'number' &&
    isFixedMemoryCursors(candidate.fixedCursors)
  ) {
    return {
      type: 'resumeCapability',
      id: candidate.id,
      valueOffset: candidate.valueOffset,
      cursor: candidate.cursor,
      fixedCursors: candidate.fixedCursors,
    };
  }
  if (candidate.type === 'render' && typeof candidate.requestOffset === 'number') {
    if (
      typeof candidate.cursor !== 'number' ||
      !isFixedMemoryCursors(candidate.fixedCursors)
    ) {
      throw new Error('Nunjitsu worker received an invalid render cursor');
    }
    return {
      type: 'render',
      id: candidate.id,
      requestOffset: candidate.requestOffset,
      cursor: candidate.cursor,
      fixedCursors: candidate.fixedCursors,
    };
  }
  if (
    candidate.type === 'resumeLoad' &&
    typeof candidate.sourceOffset === 'number' &&
    typeof candidate.canonicalOffset === 'number' &&
    typeof candidate.cursor === 'number' &&
    isFixedMemoryCursors(candidate.fixedCursors)
  ) {
    return {
      type: 'resumeLoad',
      id: candidate.id,
      sourceOffset: candidate.sourceOffset,
      canonicalOffset: candidate.canonicalOffset,
      cursor: candidate.cursor,
      fixedCursors: candidate.fixedCursors,
    };
  }
  throw new Error('Nunjitsu worker received an invalid command');
}

function parseExports(value: WebAssembly.Exports): NunjitsuExports {
  return {
    abiVersion: exportedFunction(value, 'nunjitsu_abi_version'),
    layoutVersion: exportedFunction(value, 'nunjitsu_layout_version'),
    memoryPrefixOffset: exportedFunction(value, 'nunjitsu_memory_prefix_offset'),
    slotSize: exportedFunction(value, 'nunjitsu_slot_size'),
    configureLayout: exportedFunction(value, 'nunjitsu_configure_layout'),
    poolOffset: exportedFunction(value, 'nunjitsu_pool_offset'),
    poolCapacity: exportedFunction(value, 'nunjitsu_pool_capacity'),
    poolCursor: exportedFunction(value, 'nunjitsu_pool_cursor'),
    acceptHostCursors: exportedFunction(value, 'nunjitsu_accept_host_cursors'),
    hostStringCount: exportedFunction(value, 'nunjitsu_host_string_count'),
    arenaBase: exportedFunction(value, 'nunjitsu_arena_base'),
    arenaCursor: exportedFunction(value, 'nunjitsu_arena_cursor'),
    arenaReset: exportedFunction(value, 'nunjitsu_arena_reset'),
    arenaSetCursor: exportedFunction(value, 'nunjitsu_arena_set_cursor'),
    controlOffset: exportedFunction(value, 'nunjitsu_control_offset'),
    render: exportedFunction(value, 'nunjitsu_render'),
    resumeInclude: exportedFunction(value, 'nunjitsu_resume_include'),
    resumeIncludeMissing: exportedFunction(value, 'nunjitsu_resume_include_missing'),
    resumeOutput: exportedFunction(value, 'nunjitsu_resume_output'),
    resumeCapability: exportedFunction(value, 'nunjitsu_resume_capability'),
  };
}

function exportedFunction(value: WebAssembly.Exports, name: string): (...args: number[]) => number {
  const exported = value[name];
  if (typeof exported !== 'function') {
    throw new Error(`Nunjitsu Wasm is missing the ${name} export`);
  }
  return exported as (...args: number[]) => number;
}
