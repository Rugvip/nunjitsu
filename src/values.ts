/** Primitive values that can be copied into an untrusted template render. */
export type TemplatePrimitive = undefined | null | boolean | number | string;

/**
 * A recursively owned value accepted by the Nunjitsu sandbox boundary.
 *
 * Arrays and records are copied into Wasm. Functions, accessors, symbols,
 * prototypes other than `Object.prototype` or `null`, exotic objects, and
 * cyclic graphs are rejected at runtime.
 */
export type TemplateValue =
  | TemplatePrimitive
  | readonly TemplateValue[]
  | Readonly<{ [key: string]: TemplateValue }>;

/** Named values available from the root template scope for one render. */
export type TemplateContext = Readonly<Record<string, TemplateValue>>;
