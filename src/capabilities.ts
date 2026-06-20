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

/** Declarative grammar and renderer for a custom inline block tag. */
export interface InlineTemplateTag {
  /** Selects the parenthesized argument grammar with no template body. */
  type: 'inline';
  /** Renders the copied arguments after Rust validates the complete tag syntax. */
  render: TemplateTagRenderer;
}

/** Immutable capability names and callbacks configured for an engine. */
export interface TemplateCapabilities {
  /** Filters addressable through `value | name(...)`. */
  filters?: Readonly<Record<string, TemplateFilter>>;
  /** Predicates addressable through `value is name(...)`. */
  tests?: Readonly<Record<string, TemplateTest>>;
  /** Functions addressable through `name(...)`. */
  globals?: Readonly<Record<string, TemplateGlobal>>;
  /** Inline tags addressable through `{% name(...) %}`. */
  tags?: Readonly<Record<string, InlineTemplateTag>>;
}

/** Numeric capability category used by the internal raw ABI. */
export const capabilityKind = Object.freeze({
  filter: 1,
  test: 2,
  global: 3,
  tag: 4,
} as const);

/** Numeric capability category used by the internal raw ABI. */
export type CapabilityKind = typeof capabilityKind[keyof typeof capabilityKind];

/** Stable name-to-ID pair encoded into each render arena. */
export interface CapabilityDescriptor {
  /** Engine-lifetime numeric identity. */
  id: number;
  /** Template-visible identifier. */
  name: string;
}

/** Immutable descriptors encoded for Rust expression resolution. */
export interface CapabilityDescriptors {
  /** Registered filter identities. */
  filters: readonly CapabilityDescriptor[];
  /** Registered test identities. */
  tests: readonly CapabilityDescriptor[];
  /** Registered callable-global identities. */
  globals: readonly CapabilityDescriptor[];
  /** Registered declarative custom-tag identities. */
  tags: readonly CapabilityDescriptor[];
}

/** Engine-owned immutable registry used to dispatch yielded numeric calls. */
export interface CapabilityRegistry {
  /** Descriptors copied into render-local shared memory. */
  descriptors: CapabilityDescriptors;
  /** Invokes one validated numeric capability with copied values. */
  invoke(
    kind: CapabilityKind,
    id: number,
    arguments_: readonly TemplateValue[],
    signal: AbortSignal,
  ): Promise<TemplateValue>;
}

/** Validates and owns an immutable copy of engine capability configuration. */
export function createCapabilityRegistry(
  capabilities: TemplateCapabilities,
): CapabilityRegistry {
  let nextId = 1;
  const filters = copyEntries(capabilities.filters, capabilityKind.filter, () => nextId++);
  const tests = copyEntries(capabilities.tests, capabilityKind.test, () => nextId++);
  const globals = copyEntries(capabilities.globals, capabilityKind.global, () => nextId++);
  const tags = copyTagEntries(capabilities.tags, () => nextId++);
  const callbacks = new Map<number, RegisteredCapability>([
    ...filters.registered,
    ...tests.registered,
    ...globals.registered,
    ...tags.registered,
  ].map(entry => [entry.descriptor.id, entry]));
  const descriptors = Object.freeze({
    filters: Object.freeze(filters.registered.map(entry => entry.descriptor)),
    tests: Object.freeze(tests.registered.map(entry => entry.descriptor)),
    globals: Object.freeze(globals.registered.map(entry => entry.descriptor)),
    tags: Object.freeze(tags.registered.map(entry => entry.descriptor)),
  });

  return Object.freeze({
    descriptors,
    async invoke(
      kind: CapabilityKind,
      id: number,
      arguments_: readonly TemplateValue[],
      signal: AbortSignal,
    ) {
      if (signal.aborted) {
        throw abortError();
      }
      const registered = callbacks.get(id);
      if (!registered || registered.kind !== kind) {
        throw new Error('Wasm requested an unknown host capability');
      }
      const context = Object.freeze({ signal });
      if (kind === capabilityKind.filter) {
        const [input, ...rest] = arguments_;
        return await (registered.callback as TemplateFilter)(input, rest, context);
      }
      if (kind === capabilityKind.test) {
        const [input, ...rest] = arguments_;
        const result = await (registered.callback as TemplateTest)(input, rest, context);
        if (typeof result !== 'boolean') {
          throw new TypeError(`Template test ${registered.descriptor.name} must return a boolean`);
        }
        return result;
      }
      if (kind === capabilityKind.tag) {
        return await (registered.callback as TemplateTagRenderer)(arguments_, context);
      }
      return await (registered.callback as TemplateGlobal)(arguments_, context);
    },
  });
}

/** One callback paired with its engine-lifetime identity. */
interface RegisteredCapability {
  kind: CapabilityKind;
  descriptor: CapabilityDescriptor;
  callback: TemplateFilter | TemplateTest | TemplateGlobal | TemplateTagRenderer;
}

function copyTagEntries(
  values: Readonly<Record<string, InlineTemplateTag>> | undefined,
  nextId: () => number,
): { registered: RegisteredCapability[] } {
  const registered: RegisteredCapability[] = [];
  for (const [name, schema] of Object.entries(values ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`Capability name is not a template identifier: ${name}`);
    }
    if (!schema || schema.type !== 'inline' || typeof schema.render !== 'function') {
      throw new TypeError(`Tag ${name} must use the supported inline schema`);
    }
    registered.push({
      kind: capabilityKind.tag,
      descriptor: Object.freeze({ id: nextId(), name }),
      callback: schema.render,
    });
  }
  return { registered };
}

function copyEntries(
  values: Readonly<Record<string, TemplateFilter | TemplateTest | TemplateGlobal>> | undefined,
  kind: CapabilityKind,
  nextId: () => number,
): { registered: RegisteredCapability[] } {
  const registered: RegisteredCapability[] = [];
  for (const [name, callback] of Object.entries(values ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`Capability name is not a template identifier: ${name}`);
    }
    if (typeof callback !== 'function') {
      throw new TypeError(`Capability ${name} must be a function`);
    }
    registered.push({
      kind,
      descriptor: Object.freeze({ id: nextId(), name }),
      callback,
    });
  }
  return { registered };
}

function abortError(): Error {
  const error = new Error('The Nunjitsu capability call was aborted');
  error.name = 'AbortError';
  return error;
}
