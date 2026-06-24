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
const output: string = engine.render('{{ value }}', { value: 'esm' });
const code: NunjitsuRenderErrorCode = 'syntax_error';
const phase: NunjitsuRenderErrorPhase = 'parse';
const details: NunjitsuRenderErrorDetails = {
  code,
  phase,
  line: 1,
  column: 1,
};
const limitDetails: NunjitsuLimitErrorDetails = {
  phase: 'evaluate',
  line: 1,
  column: 1,
  configured: 10,
  observed: 11,
};

void output;
void details;
void limitDetails;
void NunjitsuLimitError;
void NunjitsuRenderError;
