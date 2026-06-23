const codeWhitespaceCharacters = new Set([' ', '\t', '\n', '\r', '\u00a0']);
const templateWhitespacePattern = /\s/;

/** Returns whether one code unit is whitespace in Nunjucks template syntax. */
export function isCodeWhitespace(value: string | undefined): boolean {
  return value !== undefined && codeWhitespaceCharacters.has(value);
}

/** Returns whether one code unit is whitespace in template data controls. */
export function isTemplateWhitespace(value: string | undefined): boolean {
  return value !== undefined && templateWhitespacePattern.test(value);
}

/** Removes only Nunjucks code whitespace from both ends of a string. */
export function trimCodeWhitespace(value: string): string {
  return trimCodeWhitespaceEnd(trimCodeWhitespaceStart(value));
}

/** Removes only leading Nunjucks code whitespace from a string. */
export function trimCodeWhitespaceStart(value: string): string {
  let index = 0;
  while (isCodeWhitespace(value[index])) {
    index += 1;
  }
  return value.slice(index);
}

function trimCodeWhitespaceEnd(value: string): string {
  let index = value.length;
  while (isCodeWhitespace(value[index - 1])) {
    index -= 1;
  }
  return value.slice(0, index);
}
