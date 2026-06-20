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
