import { readFile } from 'node:fs/promises';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';

import { decodeOutput, decodeStringRecord } from './protocol.ts';

/** Data supplied by the engine when a worker starts. */
interface NunjitsuWorkerData {
  memory: WebAssembly.Memory;
  wasmUrl: string;
}

/** Initial render command accepted by an idle worker. */
interface RenderCommand {
  type: 'render';
  id: number;
  requestOffset: number;
  cursor: number;
}

/** Loader result command accepted while the evaluator is suspended. */
interface ResumeLoadCommand {
  type: 'resumeLoad';
  id: number;
  sourceOffset: number;
  canonicalOffset: number;
  cursor: number;
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
}

/** Command accepted by the worker protocol. */
type WorkerCommand =
  | RenderCommand
  | ResumeLoadCommand
  | ResumeOutputCommand
  | ResumeCapabilityCommand;

/** Numeric exports in the Nunjitsu raw Wasm ABI. */
interface NunjitsuExports {
  abiVersion: () => number;
  arenaBase: () => number;
  arenaCursor: () => number;
  arenaReset: () => void;
  arenaSetCursor: (cursor: number) => number;
  controlOffset: () => number;
  render: (requestOffset: number) => number;
  resumeInclude: (sourceOffset: number, canonicalOffset: number) => number;
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
  const bytes = await readFile(new URL(data.wasmUrl));
  const instantiated = await WebAssembly.instantiate(bytes, {
    env: { memory: data.memory },
  });
  const exports = parseExports(instantiated.instance.exports);
  exports.arenaReset();
  const controlOffset = exports.controlOffset();

  port.postMessage({
    type: 'ready',
    abiVersion: exports.abiVersion(),
    arenaBase: exports.arenaBase(),
  });

  let activeRenderId: number | undefined;
  port.on('message', (value: unknown) => {
    const command = parseCommand(value);
    if (command.type === 'render') {
      if (activeRenderId !== undefined) {
        throw new Error('Nunjitsu worker received overlapping render commands');
      }
      activeRenderId = command.id;
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
        command.id,
        state,
      )
        ? command.id
        : undefined;
      return;
    }
    if (command.type === 'resumeCapability') {
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
        command.id,
        state,
      )
        ? command.id
        : undefined;
      return;
    }
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
      command.id,
      state,
    )
      ? command.id
      : undefined;
  });
}

function reportState(
  port: MessagePort,
  memory: WebAssembly.Memory,
  exports: NunjitsuExports,
  controlOffset: number,
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
  if (state === 3) {
    const nameOffset = control.getUint32(4, true);
    const nameLength = control.getUint32(8, true);
    port.postMessage({
      type: 'load',
      id,
      name: decodeStringRecord(memory, nameOffset, nameLength),
      cursor: exports.arenaCursor(),
    });
    return true;
  }
  if (state === 4) {
    const outputOffset = control.getUint32(4, true);
    const outputLength = control.getUint32(8, true);
    port.postMessage({
      type: 'chunk',
      id,
      chunk: decodeOutput(memory, outputOffset, outputLength),
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
  if (typeof candidate.wasmUrl !== 'string') {
    throw new Error('Nunjitsu worker requires a Wasm URL');
  }
  return { memory, wasmUrl: candidate.wasmUrl };
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
  if (
    candidate.type === 'resumeCapability' &&
    typeof candidate.valueOffset === 'number' &&
    typeof candidate.cursor === 'number'
  ) {
    return {
      type: 'resumeCapability',
      id: candidate.id,
      valueOffset: candidate.valueOffset,
      cursor: candidate.cursor,
    };
  }
  if (candidate.type === 'render' && typeof candidate.requestOffset === 'number') {
    if (typeof candidate.cursor !== 'number') {
      throw new Error('Nunjitsu worker received an invalid render cursor');
    }
    return {
      type: 'render',
      id: candidate.id,
      requestOffset: candidate.requestOffset,
      cursor: candidate.cursor,
    };
  }
  if (
    candidate.type === 'resumeLoad' &&
    typeof candidate.sourceOffset === 'number' &&
    typeof candidate.canonicalOffset === 'number' &&
    typeof candidate.cursor === 'number'
  ) {
    return {
      type: 'resumeLoad',
      id: candidate.id,
      sourceOffset: candidate.sourceOffset,
      canonicalOffset: candidate.canonicalOffset,
      cursor: candidate.cursor,
    };
  }
  throw new Error('Nunjitsu worker received an invalid command');
}

function parseExports(value: WebAssembly.Exports): NunjitsuExports {
  return {
    abiVersion: exportedFunction(value, 'nunjitsu_abi_version'),
    arenaBase: exportedFunction(value, 'nunjitsu_arena_base'),
    arenaCursor: exportedFunction(value, 'nunjitsu_arena_cursor'),
    arenaReset: exportedFunction(value, 'nunjitsu_arena_reset'),
    arenaSetCursor: exportedFunction(value, 'nunjitsu_arena_set_cursor'),
    controlOffset: exportedFunction(value, 'nunjitsu_control_offset'),
    render: exportedFunction(value, 'nunjitsu_render'),
    resumeInclude: exportedFunction(value, 'nunjitsu_resume_include'),
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
