import {
  createTemplateRenderer,
  TemplateLimitError,
  TemplateRenderError,
  type TemplateRenderer,
  type TemplateRendererOptions,
  type PreparedTemplateContext,
  type TemplateRenderLimits,
  type TemplateRenderOptions,
  type TemplateRenderErrorDetails,
  type TemplateLimitErrorDetails,
} from 'nunjitsu';

const options = { cookiecutterCompat: true } satisfies TemplateRendererOptions;
const engine: TemplateRenderer = createTemplateRenderer(options);
const output: string = engine.render('${{ value }}', { value: 'legacy' });
const context: PreparedTemplateContext = engine.prepareContext({ value: 'legacy' });
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
const details: TemplateRenderErrorDetails = {
  code: 'capability_error',
  phase: 'evaluate',
  line: 1,
  column: 1,
};
const limitDetails: TemplateLimitErrorDetails = {
  phase: 'evaluate',
  line: 1,
  column: 1,
};

void output;
void context;
void renderOptions;
void details;
void limitDetails;
void TemplateLimitError;
void TemplateRenderError;
