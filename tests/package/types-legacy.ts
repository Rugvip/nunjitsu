import {
  createEngine,
  NunjitsuLimitError,
  NunjitsuRenderError,
  type Engine,
  type EngineOptions,
  type NunjitsuRenderErrorDetails,
} from 'nunjitsu';

const options = { cookiecutterCompat: true } satisfies EngineOptions;
const engine: Engine = createEngine(options);
const output: string = engine.render('${{ value }}', { value: 'legacy' });
const details: NunjitsuRenderErrorDetails = {
  code: 'capability_error',
  phase: 'evaluate',
  line: 1,
  column: 1,
};

void output;
void details;
void NunjitsuLimitError;
void NunjitsuRenderError;
