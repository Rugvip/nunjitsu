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
  /** Renders the copied arguments after Rust validates the complete tag syntax. */
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
  /** Renders copied arguments and body strings after Rust validates the syntax. */
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

/** Numeric capability category used by the internal raw ABI. */
export const capabilityKind = Object.freeze({
  filter: 1,
  test: 2,
  global: 3,
  tag: 4,
} as const);

/** Numeric capability category used by the internal raw ABI. */
export type CapabilityKind = typeof capabilityKind[keyof typeof capabilityKind];

/** Stable name-to-ID pair encoded into each render's fixed memory. */
export interface CapabilityDescriptor {
  /** Engine-lifetime numeric identity. */
  id: number;
  /** Template-visible identifier. */
  name: string;
}

/** Immutable custom-tag descriptor copied into each render's fixed memory. */
export interface TagCapabilityDescriptor extends CapabilityDescriptor {
  /** Declarative grammar variant. */
  type: 'inline' | 'body';
  /** Closing name for a body tag. */
  endTag?: string;
  /** Ordered intermediate names for a body tag. */
  intermediateTags: readonly string[];
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
  tags: readonly TagCapabilityDescriptor[];
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
        const descriptor = registered.descriptor as TagCapabilityDescriptor;
        if (descriptor.type === 'inline') {
          return await (registered.callback as TemplateTagRenderer)(arguments_, context);
        }
        const bodyCount = descriptor.intermediateTags.length + 1;
        const keywordIndex = arguments_.length - bodyCount - 1;
        if (keywordIndex < 0) {
          throw new Error('Wasm returned an invalid body-tag invocation');
        }
        const keywordArguments = arguments_[keywordIndex];
        const body = arguments_[keywordIndex + 1];
        if (!isTemplateRecord(keywordArguments) || typeof body !== 'string') {
          throw new Error('Wasm returned an invalid body-tag invocation');
        }
        const sections: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [index, name] of descriptor.intermediateTags.entries()) {
          const section = arguments_[keywordIndex + index + 2];
          if (section !== undefined && typeof section !== 'string') {
            throw new Error('Wasm returned an invalid body-tag section');
          }
          if (section !== undefined) {
            sections[name] = section;
          }
        }
        const invocation = Object.freeze({
          arguments: Object.freeze(arguments_.slice(0, keywordIndex)),
          keywordArguments,
          body,
          sections: Object.freeze(sections),
        });
        return await (registered.callback as BodyTemplateTagRenderer)(invocation, context);
      }
      return await (registered.callback as TemplateGlobal)(arguments_, context);
    },
  });
}

/** One callback paired with its engine-lifetime identity. */
interface RegisteredCapability {
  kind: CapabilityKind;
  descriptor: CapabilityDescriptor | TagCapabilityDescriptor;
  callback:
    | TemplateFilter
    | TemplateTest
    | TemplateGlobal
    | TemplateTagRenderer
    | BodyTemplateTagRenderer;
}

interface RegisteredTagCapability extends RegisteredCapability {
  descriptor: TagCapabilityDescriptor;
  callback: TemplateTagRenderer | BodyTemplateTagRenderer;
}

function copyTagEntries(
  values: Readonly<Record<string, TemplateTag>> | undefined,
  nextId: () => number,
): { registered: RegisteredTagCapability[] } {
  const registered: RegisteredTagCapability[] = [];
  for (const [name, schema] of Object.entries(values ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`Capability name is not a template identifier: ${name}`);
    }
    if (!schema || !['inline', 'body'].includes(schema.type) || typeof schema.render !== 'function') {
      throw new TypeError(`Tag ${name} must use a supported declarative schema`);
    }
    const intermediateTags = schema.type === 'body'
      ? copyTagNames(name, schema.intermediateTags ?? [])
      : Object.freeze([]);
    const endTag = schema.type === 'body' ? schema.endTag ?? `end${name}` : undefined;
    if (endTag !== undefined) {
      assertTagName(name, endTag);
      if (endTag === name || intermediateTags.includes(endTag)) {
        throw new TypeError(`Tag ${name} has conflicting grammar names`);
      }
    }
    registered.push({
      kind: capabilityKind.tag,
      descriptor: Object.freeze({
        id: nextId(),
        name,
        type: schema.type,
        ...(endTag === undefined ? {} : { endTag }),
        intermediateTags,
      }),
      callback: schema.render,
    });
  }
  return { registered };
}

function copyTagNames(owner: string, values: readonly string[]): readonly string[] {
  const names = values.map(name => {
    assertTagName(owner, name);
    return name;
  });
  if (new Set(names).size !== names.length || names.includes(owner)) {
    throw new TypeError(`Tag ${owner} has conflicting grammar names`);
  }
  return Object.freeze(names);
}

function assertTagName(owner: string, name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`Tag ${owner} contains an invalid grammar name: ${name}`);
  }
}

function isTemplateRecord(value: TemplateValue): value is Readonly<Record<string, TemplateValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyEntries(
  values: Readonly<Record<string, TemplateFilter | TemplateTest | TemplateGlobal>> | undefined,
  kind: CapabilityKind,
  nextId: () => number,
): { registered: RegisteredCapability[] } {
  const registered: RegisteredCapability[] = [];
  for (const [name, callback] of Object.entries(values ?? {})) {
    const validName = kind === capabilityKind.global
      ? /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)
      : /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    if (!validName) {
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
