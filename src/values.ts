/** Primitive values that can be copied into an untrusted template render. */
export type TemplatePrimitive = undefined | null | boolean | number | string;

/** A string explicitly authorized to bypass template autoescaping. */
export class SafeString {
  /** Trusted string content copied into the render arena. */
  readonly value: string;

  /** Creates an explicitly trusted string. Prefer the descriptive `markSafe` helper. */
  constructor(value: string) {
    this.value = value;
    Object.freeze(this);
  }
}

/** Explicitly marks a trusted string as safe for unescaped template output. */
export function markSafe(value: string): SafeString {
  return new SafeString(value);
}

/**
 * A recursively owned value accepted by the Nunjitsu sandbox boundary.
 *
 * Arrays and records are copied into Wasm. Functions, accessors, symbols,
 * prototypes other than `Object.prototype` or `null`, exotic objects, and
 * cyclic graphs are rejected at runtime.
 */
export type TemplateValue =
  | TemplatePrimitive
  | SafeString
  | readonly TemplateValue[]
  | Readonly<{ [key: string]: TemplateValue }>;

/** Named values available from the root template scope for one render. */
export type TemplateContext = Readonly<Record<string, TemplateValue>>;
