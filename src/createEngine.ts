import { createNativeEngine, type Engine, type EngineOptions } from './native-engine.ts';

/** Creates an immutable native TypeScript Nunjitsu engine synchronously. */
export function createEngine(options: EngineOptions = {}): Engine {
  return createNativeEngine(options);
}
