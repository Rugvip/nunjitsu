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
  type WorkerPoolOptions,
} from './engine.ts';
export {
  fileSystemLoader,
  memoryLoader,
  TemplateLoaderError,
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

/** Creates a Node.js Nunjitsu engine backed by Rust/Wasm worker threads. */
export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  const sourceExecution = import.meta.url.endsWith('.ts');
  return await createEngineWithRuntime(
    {
      workerUrl: new URL(sourceExecution ? './worker.ts' : './worker.js', import.meta.url),
      wasmUrl: new URL(
        sourceExecution
          ? '../rust/target/wasm32-unknown-unknown/release/nunjitsu_engine.wasm'
          : '../wasm/nunjitsu_engine.wasm',
        import.meta.url,
      ),
    },
    options,
  );
}
