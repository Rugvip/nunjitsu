/** Result of scanning one ASCII template identifier. */
export interface ScannedIdentifier {
  readonly value: string;
  readonly end: number;
}

/** Scans ordinary names, optionally including digit-leading property names. */
export function scanIdentifier(
  source: string,
  start: number,
  allowLeadingDigit = false,
): ScannedIdentifier | undefined {
  let nameStart = start;
  if (allowLeadingDigit) {
    while (nameStart < source.length && isAsciiDigit(source.charCodeAt(nameStart))) {
      nameStart += 1;
    }
  }
  if (!isIdentifierStart(source.charCodeAt(nameStart))) {
    return undefined;
  }

  let end = nameStart + 1;
  while (end < source.length && isIdentifierContinuation(source.charCodeAt(end))) {
    end += 1;
  }
  return { value: source.slice(start, end), end };
}

function isIdentifierStart(value: number): boolean {
  return value === 0x5f || isAsciiLetter(value);
}

function isIdentifierContinuation(value: number): boolean {
  return isIdentifierStart(value) || isAsciiDigit(value);
}

function isAsciiLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
}

function isAsciiDigit(value: number): boolean {
  return value >= 0x30 && value <= 0x39;
}
