/** Iterates a validated primitive string as UTF-16 code units without host iteration hooks. */
export function* stringCodeUnits(value: string): IterableIterator<string> {
  for (let index = 0; index < value.length; index += 1) {
    yield value[index]!;
  }
}
