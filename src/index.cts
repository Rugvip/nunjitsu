import { createNativeEngine, type Engine, type EngineOptions } from './native-engine.ts';

export {
  NunjitsuRenderError,
  type Engine,
  type EngineOptions,
  type InlineTemplate,
  type NamedTemplate,
  type RenderOptions,
  type TemplateInput,
} from './native-engine.ts';
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

/** Creates a CommonJS native TypeScript Nunjitsu engine synchronously. */
export function createEngine(options: EngineOptions = {}): Engine {
  return createNativeEngine(options);
}
