/** JSON-compatible value accepted at the untrusted template boundary. */
export type TemplateValue =
  | null
  | boolean
  | number
  | string
  | readonly TemplateValue[]
  | Readonly<{ [key: string]: TemplateValue }>;

/** Named JSON-compatible values available from the root template scope. */
export type TemplateContext = Readonly<Record<string, TemplateValue>>;
