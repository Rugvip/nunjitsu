import type { TemplateValue } from './values.ts';

/** Context supplied to a trusted host capability for one render-local invocation. */
export interface CapabilityCallContext {
  /** Aborts when the render or its output stream is cancelled. */
  signal: AbortSignal;
}

/** Trusted host filter invoked with a copied input and copied arguments. */
export type TemplateFilter = (
  input: TemplateValue,
  arguments_: readonly TemplateValue[],
  context: CapabilityCallContext,
) => TemplateValue | Promise<TemplateValue>;

/** Trusted host predicate invoked by an `is` expression. */
export type TemplateTest = (
  input: TemplateValue,
  arguments_: readonly TemplateValue[],
  context: CapabilityCallContext,
) => boolean | Promise<boolean>;

/** Trusted host function exposed as a callable template global. */
export type TemplateGlobal = (
  arguments_: readonly TemplateValue[],
  context: CapabilityCallContext,
) => TemplateValue | Promise<TemplateValue>;

/** Trusted renderer for one declaratively parsed custom tag invocation. */
export type TemplateTagRenderer = (
  arguments_: readonly TemplateValue[],
  context: CapabilityCallContext,
) => TemplateValue | Promise<TemplateValue>;

/** Copied arguments and rendered sections supplied to a body-tag renderer. */
export interface BodyTemplateTagInvocation {
  /** Positional arguments in template order. */
  arguments: readonly TemplateValue[];
  /** Named arguments copied into an immutable null-prototype record. */
  keywordArguments: Readonly<Record<string, TemplateValue>>;
  /** Rendered content before the first intermediate tag. */
  body: string;
  /** Rendered content following each intermediate tag that appeared. */
  sections: Readonly<Record<string, string>>;
}

/** Trusted renderer for one declaratively parsed body-tag invocation. */
export type BodyTemplateTagRenderer = (
  invocation: BodyTemplateTagInvocation,
  context: CapabilityCallContext,
) => TemplateValue | Promise<TemplateValue>;

/** Declarative grammar and renderer for a custom inline block tag. */
export interface InlineTemplateTag {
  /** Selects the parenthesized argument grammar with no template body. */
  type: 'inline';
  /** Renders the copied arguments after the closed parser validates the complete tag syntax. */
  render: TemplateTagRenderer;
}

/** Declarative grammar and renderer for a custom tag with rendered bodies. */
export interface BodyTemplateTag {
  /** Selects a body grammar terminated by an explicit or derived end tag. */
  type: 'body';
  /** Closing tag name. Defaults to `end${name}`. */
  endTag?: string;
  /** Optional ordered section tags accepted between the opening and closing tags. */
  intermediateTags?: readonly string[];
  /** Renders copied arguments and body strings after the closed parser validates the syntax. */
  render: BodyTemplateTagRenderer;
}

/** Supported declarative custom-tag schemas. */
export type TemplateTag = InlineTemplateTag | BodyTemplateTag;

/** Immutable capability names and callbacks configured for an engine. */
export interface TemplateCapabilities {
  /** Filters addressable through `value | name(...)`. */
  filters?: Readonly<Record<string, TemplateFilter>>;
  /** Predicates addressable through `value is name(...)`. */
  tests?: Readonly<Record<string, TemplateTest>>;
  /** Functions addressable through `name(...)`. */
  globals?: Readonly<Record<string, TemplateGlobal>>;
  /** Declarative tags addressable through `{% name(...) %}`. */
  tags?: Readonly<Record<string, TemplateTag>>;
}
