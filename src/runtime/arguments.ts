import type { RuntimeValue } from './value.ts';

/** Evaluated positional and keyword values for one closed runtime call. */
export interface RuntimeArgumentValues {
  readonly positional: readonly RuntimeValue[];
  readonly keyword: ReadonlyMap<string, RuntimeValue>;
}

/** Arguments normalized through the pinned Nunjucks macro calling convention. */
export interface NormalizedMacroArguments {
  readonly positional: readonly RuntimeValue[];
  readonly keyword: ReadonlyMap<string, RuntimeValue>;
}

/** Normalizes evaluated arguments without invoking or retaining host behavior. */
export function normalizeMacroArguments(
  positionalNames: readonly string[],
  defaultNames: readonly string[],
  arguments_: RuntimeArgumentValues,
): NormalizedMacroArguments {
  const suppliedCount = arguments_.positional.length;
  const positionalCount = positionalNames.length;
  const keyword = new Map(arguments_.keyword);
  if (suppliedCount > positionalCount) {
    const positional = arguments_.positional.slice(0, positionalCount);
    const surplus = arguments_.positional.slice(positionalCount);
    for (let index = 0; index < surplus.length && index < defaultNames.length; index += 1) {
      keyword.set(defaultNames[index]!, surplus[index]);
    }
    return { positional, keyword };
  }
  if (suppliedCount < positionalCount) {
    const positional = arguments_.positional.slice();
    for (let index = suppliedCount; index < positionalCount; index += 1) {
      const name = positionalNames[index]!;
      positional.push(keyword.get(name));
      keyword.delete(name);
    }
    return { positional, keyword };
  }
  return { positional: arguments_.positional, keyword };
}
