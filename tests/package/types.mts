import {
  createTemplateRenderer,
  TemplateLimitError,
  TemplateRenderError,
  type TemplateRenderer,
  type TemplateRendererOptions,
  type PreparedTemplateContext,
  type TemplateRenderLimits,
  type TemplateRenderOptions,
  type TemplateRenderErrorCode,
  type TemplateRenderErrorDetails,
  type TemplateRenderErrorPhase,
  type TemplateLimitErrorDetails,
} from 'nunjitsu';

const options = { cookiecutterCompat: true } satisfies TemplateRendererOptions;
const engine: TemplateRenderer = createTemplateRenderer(options);
const output: string = engine.render('{{ value }}', { value: 'esm' });
const context: PreparedTemplateContext = engine.prepareContext({ value: 'esm' });
const limits: TemplateRenderLimits = {
  sourceCodeUnits: 1,
  astNodes: 1,
  workUnits: 1,
  nestingDepth: 1,
  outputCodeUnits: 1,
  scratchBytes: 1,
  capabilityCalls: 1,
};
const renderOptions: TemplateRenderOptions = { limits };
const code: TemplateRenderErrorCode = 'syntax_error';
const phase: TemplateRenderErrorPhase = 'parse';
const details: TemplateRenderErrorDetails = {
  code,
  phase,
  line: 1,
  column: 1,
};
const limitDetails: TemplateLimitErrorDetails = {
  phase: 'evaluate',
  line: 1,
  column: 1,
  configured: 10,
  observed: 11,
};

void output;
void context;
void renderOptions;
void details;
void limitDetails;
void TemplateLimitError;
void TemplateRenderError;
