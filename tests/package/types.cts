import {
  createTemplateRenderer,
  TemplateLimitError,
  TemplateRenderError,
  type TemplateRenderer,
  type TemplateRendererOptions,
  type PreparedTemplateContext,
  type TemplateRenderLimits,
  type TemplateRenderOptions,
  type TemplateValue,
  type TemplateRenderErrorCode,
  type TemplateRenderErrorDetails,
  type TemplateRenderErrorPhase,
  type TemplateLimitErrorDetails,
} from 'nunjitsu';

const options = { cookiecutterCompat: true } satisfies TemplateRendererOptions;
const engine: TemplateRenderer = createTemplateRenderer(options);
const output: string = engine.render('{{ value }}', { value: 'commonjs' });
const value: TemplateValue | undefined = engine.renderValue('{{ value }}', { value: 1 });
const context: PreparedTemplateContext = engine.prepareContext({ value: 'commonjs' });
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
const code: TemplateRenderErrorCode = 'evaluation_error';
const phase: TemplateRenderErrorPhase = 'evaluate';
const details: TemplateRenderErrorDetails = {
  code,
  phase,
  line: undefined,
  column: undefined,
};
const limitDetails: TemplateLimitErrorDetails = {
  phase: 'parse',
  configured: 10,
  observed: 11,
};

void output;
void value;
void context;
void renderOptions;
void details;
void limitDetails;
void TemplateLimitError;
void TemplateRenderError;
