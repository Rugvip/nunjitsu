import { createNativeEngine, type Engine, type EngineOptions } from './native-engine.ts';

export {
  NunjitsuRenderError,
  type Engine,
  type EngineOptions,
  type RenderOptions,
} from './native-engine.ts';
export type {
  TemplateCapabilities,
  TemplateFilter,
  TemplateGlobal,
  TemplateGlobalFunction,
} from './capabilities.ts';
export { NunjitsuLimitError, type RenderLimits } from './limits.ts';
export {
  type TemplateContext,
  type TemplateValue,
} from './values.ts';

/** Creates an immutable native TypeScript Nunjitsu engine synchronously. */
export function createEngine(options: EngineOptions = {}): Engine {
  return createNativeEngine(options);
}
