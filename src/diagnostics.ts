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

function escapeUnsafeDiagnosticCharacters(value: string): string {
  return value.replace(
    unsafeDiagnosticCharacterPattern,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
