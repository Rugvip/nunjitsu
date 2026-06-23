/** Result of scanning one ordinary ASCII template identifier. */
export interface ScannedIdentifier {
  readonly value: string;
  readonly end: number;
}

/** Scans the identifier grammar shared by tag and expression tokenization. */
export function scanIdentifier(source: string, start: number): ScannedIdentifier | undefined {
  const first = source.charCodeAt(start);
  if (!isIdentifierStart(first)) {
    return undefined;
  }

  let end = start + 1;
  while (end < source.length && isIdentifierContinuation(source.charCodeAt(end))) {
    end += 1;
  }
  return { value: source.slice(start, end), end };
}

function isIdentifierStart(value: number): boolean {
  return value === 0x5f || isAsciiLetter(value);
}

function isIdentifierContinuation(value: number): boolean {
  return isIdentifierStart(value) || (value >= 0x30 && value <= 0x39);
}

function isAsciiLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
}
