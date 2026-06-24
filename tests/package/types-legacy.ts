import {
  createEngine,
  NunjitsuLimitError,
  NunjitsuRenderError,
  type Engine,
  type EngineOptions,
  type NunjitsuRenderErrorDetails,
  type NunjitsuLimitErrorDetails,
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
const limitDetails: NunjitsuLimitErrorDetails = {
  phase: 'evaluate',
  line: 1,
  column: 1,
};

void output;
void details;
void limitDetails;
void NunjitsuLimitError;
void NunjitsuRenderError;
