import {
  createEngine,
  NunjitsuLimitError,
  NunjitsuRenderError,
  type Engine,
  type EngineOptions,
  type NunjitsuRenderErrorCode,
  type NunjitsuRenderErrorDetails,
  type NunjitsuRenderErrorPhase,
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

void output;
void details;
void NunjitsuLimitError;
void NunjitsuRenderError;
