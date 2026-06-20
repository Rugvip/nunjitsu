import { readFile } from 'node:fs/promises';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';

/** Data supplied by the engine when a worker starts. */
interface NunjitsuWorkerData {
  memory: WebAssembly.Memory;
  wasmUrl: string;
}

/** Render command accepted by the worker. */
interface RenderCommand {
  type: 'render';
  id: number;
  requestOffset: number;
  cursor: number;
}

/** Numeric exports in the Nunjitsu raw Wasm ABI. */
interface NunjitsuExports {
  abiVersion: () => number;
  arenaBase: () => number;
  arenaReset: () => void;
  arenaSetCursor: (cursor: number) => number;
  controlOffset: () => number;
  render: (requestOffset: number) => number;
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

  port.on('message', (value: unknown) => {
    const command = parseRenderCommand(value);
    if (exports.arenaSetCursor(command.cursor) !== 1) {
      port.postMessage({
        type: 'result',
        id: command.id,
        state: 2,
        errorCode: 1,
      });
      exports.arenaReset();
      return;
    }

    const state = exports.render(command.requestOffset);
    const control = new DataView(data.memory.buffer, controlOffset, 16);
    const controlState = control.getUint32(0, true);
    if (state !== controlState) {
      throw new Error('Nunjitsu Wasm returned an inconsistent control state');
    }
    if (state === 1) {
      port.postMessage({
        type: 'result',
        id: command.id,
        state,
        outputOffset: control.getUint32(4, true),
        outputLength: control.getUint32(8, true),
      });
    } else {
      port.postMessage({
        type: 'result',
        id: command.id,
        state: 2,
        errorCode: control.getUint32(12, true),
      });
    }
    exports.arenaReset();
  });
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

function parseRenderCommand(value: unknown): RenderCommand {
  if (!value || typeof value !== 'object') {
    throw new Error('Nunjitsu worker received an invalid command');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== 'render' ||
    typeof candidate.id !== 'number' ||
    typeof candidate.requestOffset !== 'number' ||
    typeof candidate.cursor !== 'number'
  ) {
    throw new Error('Nunjitsu worker received an invalid render command');
  }
  return {
    type: 'render',
    id: candidate.id,
    requestOffset: candidate.requestOffset,
    cursor: candidate.cursor,
  };
}

function parseExports(value: WebAssembly.Exports): NunjitsuExports {
  return {
    abiVersion: exportedFunction(value, 'nunjitsu_abi_version'),
    arenaBase: exportedFunction(value, 'nunjitsu_arena_base'),
    arenaReset: exportedFunction(value, 'nunjitsu_arena_reset'),
    arenaSetCursor: exportedFunction(value, 'nunjitsu_arena_set_cursor'),
    controlOffset: exportedFunction(value, 'nunjitsu_control_offset'),
    render: exportedFunction(value, 'nunjitsu_render'),
  };
}

function exportedFunction(value: WebAssembly.Exports, name: string): (...args: number[]) => number {
  const exported = value[name];
  if (typeof exported !== 'function') {
    throw new Error(`Nunjitsu Wasm is missing the ${name} export`);
  }
  return exported as (...args: number[]) => number;
}
