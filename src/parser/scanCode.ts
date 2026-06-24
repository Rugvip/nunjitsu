import { scanIdentifier } from './scanIdentifier.ts';
import { scanRegexLiteral } from './scanRegexLiteral.ts';
import { isCodeWhitespace, trimCodeWhitespace } from './whitespace.ts';

/** Finds one terminator outside parser-owned strings, identifiers, and regexes. */
export function findCodeTerminator(
  source: string,
  start: number,
  terminator: string,
): number {
  for (let index = start; index <= source.length - terminator.length;) {
    const skipped = skipCodeToken(source, index);
    if (skipped !== undefined) {
      index = skipped;
    } else if (source.startsWith(terminator, index)) {
      return index;
    } else {
      index += 1;
    }
  }
  return -1;
}

/** Finds the closer matching one opening code delimiter. */
export function findMatchingCodeDelimiter(source: string, start: number): number {
  const opening = source[start];
  if (opening !== '(' && opening !== '[' && opening !== '{') {
    return -1;
  }
  const stack = [opening];
  for (let index = start + 1; index < source.length;) {
    const skipped = skipCodeToken(source, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const character = source[index]!;
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character);
    } else if (character === ')' || character === ']' || character === '}') {
      const expected = closingDelimiter(stack.at(-1));
      if (character === expected) {
        stack.pop();
        if (stack.length === 0) {
          return index;
        }
      }
    }
    index += 1;
  }
  return -1;
}

/** Finds one character outside every balanced code delimiter. */
export function findTopLevelCodeCharacter(source: string, expected: string): number {
  let depth = 0;
  for (let index = 0; index < source.length;) {
    const skipped = skipCodeToken(source, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const character = source[index]!;
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
    } else if (depth === 0 && character === expected) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/** Splits around one standalone keyword outside every balanced delimiter. */
export function splitTopLevelCodeKeyword(
  source: string,
  keyword: string,
): { readonly left: string; readonly right: string } | undefined {
  let depth = 0;
  for (let index = 0; index < source.length;) {
    const identifier = scanIdentifier(source, index);
    if (identifier) {
      if (identifier.value === 'r' && source[identifier.end] === '/') {
        index = scanRegexLiteral(source, index).end;
        continue;
      }
      if (
        depth === 0 &&
        identifier.value === keyword &&
        isCodeWhitespace(source[index - 1] ?? ' ') &&
        isCodeWhitespace(source[identifier.end] ?? ' ')
      ) {
        return {
          left: trimCodeWhitespace(source.slice(0, index)),
          right: trimCodeWhitespace(source.slice(identifier.end)),
        };
      }
      index = identifier.end;
      continue;
    }
    const skipped = skipQuotedString(source, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }
    const character = source[index]!;
    if (character === '(' || character === '[' || character === '{') {
      depth += 1;
    } else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
    }
    index += 1;
  }
  return undefined;
}

function skipCodeToken(
  source: string,
  index: number,
): number | undefined {
  const stringEnd = skipQuotedString(source, index);
  if (stringEnd !== undefined) {
    return stringEnd;
  }
  const identifier = scanIdentifier(source, index);
  if (!identifier) {
    return undefined;
  }
  if (identifier.value === 'r' && source[identifier.end] === '/') {
    return scanRegexLiteral(source, index).end;
  }
  return identifier.end;
}

function skipQuotedString(source: string, start: number): number | undefined {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\') {
      index += 1;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return source.length;
}

function closingDelimiter(opening: string | undefined): string | undefined {
  if (opening === '(') {
    return ')';
  }
  if (opening === '[') {
    return ']';
  }
  if (opening === '{') {
    return '}';
  }
  return undefined;
}
