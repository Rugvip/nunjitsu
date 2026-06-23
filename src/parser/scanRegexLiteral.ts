const allowedRegularExpressionFlags = Object.freeze(['g', 'i', 'm', 'y'] as const);
const asciiLetterPattern = /^[A-Za-z]$/;

/** Result of scanning one closed regular-expression literal. */
interface ScannedRegexLiteral {
  readonly source: string;
  readonly flags: string;
  readonly end: number;
}

/** Internal bounded syntax failure produced while scanning a regex literal. */
export class RegexLiteralSyntaxError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

/** Scans and validates one `r/.../gimy` literal without exposing native regex objects. */
export function scanRegexLiteral(source: string, start: number): ScannedRegexLiteral {
  let pattern = '';
  let backslashRun = 0;

  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\') {
      pattern += character;
      backslashRun += 1;
      continue;
    }
    if (character === '/') {
      if (backslashRun > 0) {
        if (backslashRun % 2 === 0) {
          throw new RegexLiteralSyntaxError(
            'Ambiguous regular-expression delimiter escape',
            start,
          );
        }
        pattern += character;
        backslashRun = 0;
        continue;
      }
      return finishRegexLiteral(source, start, index, pattern);
    }
    pattern += character;
    backslashRun = 0;
  }

  throw new RegexLiteralSyntaxError('Unterminated regular-expression literal', start);
}

function finishRegexLiteral(
  source: string,
  start: number,
  delimiter: number,
  pattern: string,
): ScannedRegexLiteral {
  let end = delimiter + 1;
  let flags = '';
  for (; end < source.length; end += 1) {
    const character = source[end]!;
    if (!isAllowedRegularExpressionFlag(character)) {
      break;
    }
    if (flags.includes(character)) {
      throw new RegexLiteralSyntaxError('Duplicate regular-expression flag', start);
    }
    flags += character;
  }
  if (end < source.length && asciiLetterPattern.test(source[end]!)) {
    throw new RegexLiteralSyntaxError('Unsupported regular-expression flag', start);
  }

  try {
    void new RegExp(pattern, flags);
  } catch {
    throw new RegexLiteralSyntaxError('Invalid regular-expression literal', start);
  }

  return Object.freeze({ source: pattern, flags, end });
}

function isAllowedRegularExpressionFlag(
  value: string,
): value is (typeof allowedRegularExpressionFlags)[number] {
  return allowedRegularExpressionFlags.some(flag => flag === value);
}
