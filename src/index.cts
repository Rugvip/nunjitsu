import { pathToFileURL } from 'node:url';

import {
  createEngineWithRuntime,
  type Engine,
  type EngineOptions,
} from './engine.ts';

export {
  NunjitsuRenderError,
  type Engine,
  type EngineOptions,
  type InlineTemplate,
  type RenderOptions,
  type WorkerPoolOptions,
} from './engine.ts';
export type { TemplateContext, TemplatePrimitive, TemplateValue } from './values.ts';

/** Creates a CommonJS Node.js Nunjitsu engine backed by Rust/Wasm workers. */
export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  const entryUrl = pathToFileURL(__filename);
  return await createEngineWithRuntime(
    {
      workerUrl: new URL('./worker.cjs', entryUrl),
      wasmUrl: new URL('../wasm/nunjitsu_engine.wasm', entryUrl),
    },
    options,
  );
}
