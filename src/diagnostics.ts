const unsafeDiagnosticCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const diagnosticValueLength = 200;
const diagnosticMessageLength = 1_024;

/** Formats untrusted source text as one bounded quoted diagnostic value. */
export function formatDiagnosticValue(value: string): string {
  const truncated = value.length > diagnosticValueLength
    ? `${value.slice(0, diagnosticValueLength)}…`
    : value;
  const quoted = JSON.stringify(truncated);
  return escapeUnsafeDiagnosticCharacters(quoted);
}

/** Neutralizes and bounds one complete public diagnostic message. */
export function neutralizeDiagnosticMessage(message: string): string {
  const escaped = escapeUnsafeDiagnosticCharacters(message);
  return escaped.length > diagnosticMessageLength
    ? `${escaped.slice(0, diagnosticMessageLength)}…`
    : escaped;
}

/** Suggests one bounded close spelling from a trusted diagnostic name set. */
export function suggestDiagnosticName(
  value: string,
  candidates: Iterable<string>,
): string | undefined {
  if (value.length === 0 || value.length > 64) {
    return undefined;
  }
  const maximumDistance = value.length <= 4 ? 1 : value.length <= 10 ? 2 : 3;
  let closest: string | undefined;
  let closestDistance = maximumDistance + 1;
  let inspected = 0;
  for (const candidate of candidates) {
    inspected += 1;
    if (inspected > 256) {
      break;
    }
    if (
      candidate === value ||
      candidate.length === 0 ||
      candidate.length > 64 ||
      Math.abs(candidate.length - value.length) > maximumDistance
    ) {
      continue;
    }
    const distance = diagnosticEditDistance(value, candidate);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

function escapeUnsafeDiagnosticCharacters(value: string): string {
  return value.replace(
    unsafeDiagnosticCharacterPattern,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function diagnosticEditDistance(left: string, right: string): number {
  let beforePrevious: number[] | undefined;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]! + (
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      );
      let distance = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
      if (
        beforePrevious &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        distance = Math.min(distance, beforePrevious[rightIndex - 2]! + 1);
      }
      current.push(distance);
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length]!;
}
