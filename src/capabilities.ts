import type { TemplateValue } from './values.ts';

/**
 * Trusted synchronous filter invoked with a copied input and positional arguments.
 *
 * Template keyword syntax and internal callable identities are rejected before
 * this callback can execute.
 */
export type TemplateFilter = (
  input: TemplateValue | undefined,
  ...arguments_: readonly (TemplateValue | undefined)[]
) => TemplateValue | undefined;

/**
 * Trusted synchronous global function invoked with copied positional arguments.
 *
 * Template keyword syntax and internal callable identities are rejected before
 * this callback can execute.
 */
export type TemplateGlobalFunction = (
  ...arguments_: readonly (TemplateValue | undefined)[]
) => TemplateValue | undefined;

/** JSON value or trusted synchronous function exposed as a template global. */
export type TemplateGlobal = TemplateValue | TemplateGlobalFunction;

/** Immutable filters and globals configured for an engine. */
export interface TemplateCapabilities {
  /** Filters addressed by one or more dot-separated valid identifier segments. */
  filters?: Readonly<Record<string, TemplateFilter>>;
  /** Values and functions addressable by one valid template identifier. */
  globals?: Readonly<Record<string, TemplateGlobal>>;
}
