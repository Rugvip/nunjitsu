import type { TemplateValue } from './values.ts';

/** Trusted synchronous filter invoked with a copied input and arguments. */
export type TemplateFilter = (
  input: TemplateValue | undefined,
  ...arguments_: readonly (TemplateValue | undefined)[]
) => TemplateValue | undefined;

/** Trusted synchronous global function invoked with copied arguments. */
export type TemplateGlobalFunction = (
  ...arguments_: readonly (TemplateValue | undefined)[]
) => TemplateValue | undefined;

/** JSON value or trusted synchronous function exposed as a template global. */
export type TemplateGlobal = TemplateValue | TemplateGlobalFunction;

/** Immutable filters and globals configured for an engine. */
export interface TemplateCapabilities {
  /** Filters addressable through `value | name(...)`. */
  filters?: Readonly<Record<string, TemplateFilter>>;
  /** Values and functions addressable by exact global name. */
  globals?: Readonly<Record<string, TemplateGlobal>>;
}
