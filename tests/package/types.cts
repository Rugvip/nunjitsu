import {
  createEngine,
  NunjitsuLimitError,
  NunjitsuRenderError,
  type Engine,
  type EngineOptions,
  type NunjitsuRenderErrorCode,
  type NunjitsuRenderErrorDetails,
  type NunjitsuRenderErrorPhase,
  type NunjitsuLimitErrorDetails,
} from 'nunjitsu';

const options = { cookiecutterCompat: true } satisfies EngineOptions;
const engine: Engine = createEngine(options);
const output: string = engine.render('{{ value }}', { value: 'commonjs' });
const code: NunjitsuRenderErrorCode = 'evaluation_error';
const phase: NunjitsuRenderErrorPhase = 'evaluate';
const details: NunjitsuRenderErrorDetails = {
  code,
  phase,
  line: undefined,
  column: undefined,
};
const limitDetails: NunjitsuLimitErrorDetails = {
  phase: 'parse',
  configured: 10,
  observed: 11,
};

void output;
void details;
void limitDetails;
void NunjitsuLimitError;
void NunjitsuRenderError;
