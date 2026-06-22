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
const output: string = engine.render('{{ value }}', { value: 'commonjs' });
const code: NunjitsuRenderErrorCode = 'evaluation_error';
const phase: NunjitsuRenderErrorPhase = 'evaluate';
const details: NunjitsuRenderErrorDetails = {
  code,
  phase,
  line: undefined,
  column: undefined,
};

void output;
void details;
void NunjitsuLimitError;
void NunjitsuRenderError;
