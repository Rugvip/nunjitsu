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
  type NamedTemplate,
  type RenderOptions,
  type TemplateInput,
  type WorkerMemoryOptions,
  type WorkerPoolOptions,
} from './engine.ts';
export type {
  BodyTemplateTag,
  BodyTemplateTagInvocation,
  BodyTemplateTagRenderer,
  CapabilityCallContext,
  InlineTemplateTag,
  TemplateCapabilities,
  TemplateFilter,
  TemplateGlobal,
  TemplateTest,
  TemplateTagRenderer,
  TemplateTag,
} from './capabilities.ts';
export {
  fileSystemLoader,
  memoryLoader,
  TemplateLoaderError,
  TemplateNotFoundError,
  type FileSystemLoaderOptions,
  type LoadedTemplate,
  type TemplateLoader,
} from './loaders.ts';
export { NunjitsuLimitError, type RenderLimits } from './limits.ts';
export {
  markSafe,
  SafeString,
  type TemplateContext,
  type TemplatePrimitive,
  type TemplateValue,
} from './values.ts';

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
