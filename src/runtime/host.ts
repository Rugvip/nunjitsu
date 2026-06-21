import type {
  BodyTemplateTagRenderer,
  CapabilityCallContext,
  TemplateCapabilities,
  TemplateFilter,
  TemplateGlobal,
  TemplateTag,
  TemplateTagRenderer,
  TemplateTest,
} from '../capabilities.ts';
import type { ParseTagDescriptor } from '../parser/index.ts';
import {
  copyPublicValue,
  copyRuntimeValue,
  isReservedName,
  type RuntimeValue,
} from './value.ts';
import type { RuntimeArguments, RuntimeHost } from './evaluator.ts';

/** Creates an immutable trusted-host dispatcher for the native interpreter. */
export function createRuntimeHost(capabilities: TemplateCapabilities): RuntimeHost {
  const filters = copyCallbacks(capabilities.filters, 'filter');
  const tests = copyCallbacks(capabilities.tests, 'test');
  const globals = copyCallbacks(capabilities.globals, 'global');
  const tags = copyTags(capabilities.tags);

  return Object.freeze({
    tags: Object.freeze([...tags.values()].map(tag => tag.descriptor)),
    hasFilter(name) {
      return filters.has(name);
    },
    hasTest(name) {
      return tests.has(name);
    },
    hasGlobal(name) {
      return globals.has(name);
    },
    hasTag(name) {
      return tags.has(name);
    },
    async filter(name, input, arguments_, signal) {
      const callback = filters.get(name) as TemplateFilter | undefined;
      if (!callback) {
        return { found: false };
      }
      throwIfAborted(signal);
      const value = await callback(
        copyPublicValue(input),
        arguments_.positional.map(copyPublicValue),
        capabilityContext(signal),
      );
      return { found: true, value: copyRuntimeValue(value) };
    },
    async test(name, input, arguments_, signal) {
      const callback = tests.get(name) as TemplateTest | undefined;
      if (!callback) {
        return undefined;
      }
      throwIfAborted(signal);
      const value = await callback(
        copyPublicValue(input),
        arguments_.positional.map(copyPublicValue),
        capabilityContext(signal),
      );
      if (typeof value !== 'boolean') {
        throw new TypeError(`Template test ${name} must return a boolean`);
      }
      return value;
    },
    async global(name, arguments_, signal) {
      const callback = globals.get(name) as TemplateGlobal | undefined;
      if (!callback) {
        return { found: false };
      }
      throwIfAborted(signal);
      const value = await callback(
        arguments_.positional.map(copyPublicValue),
        capabilityContext(signal),
      );
      return { found: true, value: copyRuntimeValue(value) };
    },
    async tag(name, arguments_, content, signal) {
      const tag = tags.get(name);
      if (!tag) {
        return { found: false };
      }
      throwIfAborted(signal);
      let value;
      if (tag.descriptor.type === 'inline') {
        value = await (tag.render as TemplateTagRenderer)(
          Object.freeze(arguments_.positional.map(copyPublicValue)),
          capabilityContext(signal),
        );
      } else {
        const keywordArguments = Object.create(null) as Record<string, ReturnType<typeof copyPublicValue>>;
        for (const [key, entry] of arguments_.keyword) {
          keywordArguments[key] = copyPublicValue(entry);
        }
        const sections = Object.create(null) as Record<string, string>;
        for (const [index, sectionName] of tag.descriptor.intermediateTags.entries()) {
          const section = content[index + 1];
          if (section !== undefined) {
            sections[sectionName] = section;
          }
        }
        value = await (tag.render as BodyTemplateTagRenderer)(Object.freeze({
          arguments: Object.freeze(arguments_.positional.map(copyPublicValue)),
          keywordArguments: Object.freeze(keywordArguments),
          body: content[0] ?? '',
          sections: Object.freeze(sections),
        }), capabilityContext(signal));
      }
      return { found: true, value: copyRuntimeValue(value) };
    },
  } satisfies RuntimeHost);
}

interface RegisteredTag {
  readonly descriptor: ParseTagDescriptor;
  readonly render: TemplateTagRenderer | BodyTemplateTagRenderer;
}

function copyTags(
  values: Readonly<Record<string, TemplateTag>> | undefined,
): ReadonlyMap<string, RegisteredTag> {
  const copied = new Map<string, RegisteredTag>();
  if (!values) {
    return copied;
  }
  assertPlainRecord(values, 'tag registry');
  for (const key of Reflect.ownKeys(values)) {
    if (typeof key !== 'string') {
      throw new TypeError('Template tag registry cannot contain symbol keys');
    }
    if (isReservedName(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError(`Template tag name ${key} is invalid or reserved`);
    }
    const property = Object.getOwnPropertyDescriptor(values, key);
    if (!property?.enumerable) {
      continue;
    }
    if (!('value' in property) || !property.value || typeof property.value !== 'object') {
      throw new TypeError(`Template tag ${key} must be a data property`);
    }
    const schema = property.value as TemplateTag;
    assertPlainRecord(schema, `tag ${key}`);
    const type = dataProperty(schema, 'type');
    const render = dataProperty(schema, 'render');
    if ((type !== 'inline' && type !== 'body') || typeof render !== 'function') {
      throw new TypeError(`Template tag ${key} must use a supported declarative schema`);
    }
    const intermediateTags = type === 'body'
      ? copyTagNames(key, dataProperty(schema, 'intermediateTags'))
      : [];
    const endTagValue = type === 'body' ? dataProperty(schema, 'endTag') : undefined;
    if (endTagValue !== undefined && !isTagName(endTagValue)) {
      throw new TypeError(`Template tag ${key} has an invalid end tag`);
    }
    const descriptor = Object.freeze({
      name: key,
      type,
      ...(endTagValue === undefined ? {} : { endTag: endTagValue }),
      intermediateTags: Object.freeze(intermediateTags),
    }) satisfies ParseTagDescriptor;
    copied.set(key, Object.freeze({
      descriptor,
      render: render as TemplateTagRenderer | BodyTemplateTagRenderer,
    }));
  }
  return copied;
}

function copyCallbacks<T extends TemplateFilter | TemplateTest | TemplateGlobal>(
  callbacks: Readonly<Record<string, T>> | undefined,
  kind: string,
): ReadonlyMap<string, T> {
  const copied = new Map<string, T>();
  if (!callbacks) {
    return copied;
  }
  assertPlainRecord(callbacks, `${kind} registry`);
  for (const key of Reflect.ownKeys(callbacks)) {
    if (typeof key !== 'string') {
      throw new TypeError(`Template ${kind} registry cannot contain symbol keys`);
    }
    if (isReservedName(key)) {
      throw new TypeError(`Template ${kind} name ${key} is reserved`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(callbacks, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
      throw new TypeError(`Template ${kind} ${key} must be a function data property`);
    }
    copied.set(key, descriptor.value as T);
  }
  return copied;
}

function copyTagNames(tagName: string, value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`Template tag ${tagName} intermediate tags must be an array`);
  }
  const names = value.map(entry => {
    if (!isTagName(entry)) {
      throw new TypeError(`Template tag ${tagName} has an invalid intermediate tag`);
    }
    return entry;
  });
  if (new Set(names).size !== names.length) {
    throw new TypeError(`Template tag ${tagName} has duplicate intermediate tags`);
  }
  return names;
}

function isTagName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !isReservedName(value);
}

function assertPlainRecord(value: object, description: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`Template ${description} must be a plain record`);
  }
}

function dataProperty(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor)) {
    return undefined;
  }
  return descriptor.value;
}

function capabilityContext(signal: AbortSignal): CapabilityCallContext {
  return Object.freeze({ signal });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
}
