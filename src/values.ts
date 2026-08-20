/** Closed data value accepted at the untrusted template boundary. */
export type TemplateValue =
  | null
  | boolean
  | number
  | string
  | readonly TemplateValue[]
  | Readonly<{ [key: string]: TemplateValue }>
  | ReadonlyMap<TemplateValue, TemplateValue>
  | ReadonlySet<TemplateValue>;

/** Named closed data values available from the root template scope. */
export type TemplateContext = Readonly<Record<string, TemplateValue>>;
