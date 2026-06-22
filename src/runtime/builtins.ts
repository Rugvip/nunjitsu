import {
  isReservedName,
  renderRuntimeValue,
  runtimeTruthy,
  RuntimeArray,
  RuntimeCallable,
  RuntimeRecord,
  RuntimeRegex,
  RuntimeSafeString,
  type RuntimeValue,
} from './value.ts';

const lineBreakPattern = /\r\n|\n/g;
const htmlTagPattern = /<\/?([a-z][a-z0-9]*)\b[^>]*>|<!--[\s\S]*?-->/gi;
const lineEdgeSpacesPattern = /^ +| +$/gm;
const repeatedSpacesPattern = / +/g;
const windowsLineBreakPattern = /\r\n/g;
const excessBlankLinesPattern = /\n\n\n+/g;
const repeatedWhitespacePattern = /\s+/g;
const wordPattern = /\w+/g;
const urlizeSeparatorPattern = /(\s+)/;
const urlizePunctuationPattern = /^(?:\(|<|&lt;)?(.*?)(?:\.|,|\)|\n|&gt;)?$/;
const httpUrlPattern = /^https?:\/\//;
const wwwUrlPattern = /^www\./;
const emailAddressPattern = /^[\w.!#$%&'*+\-/=?^`{|}~]+@[a-z\d-]+(?:\.[a-z\d-]+)+$/i;
const commonDomainPattern = /\.(?:org|net|com)(?::|\/|$)/;
const htmlEscapeCharacterPattern = /[&"'<>\\]/g;
const htmlEscapeReplacements: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '\\': '&#92;',
});

const builtinFilters = new Set([
  'abs', 'batch', 'capitalize', 'center', 'd', 'default', 'dictsort', 'dump', 'e',
  'escape', 'first', 'float', 'forceescape', 'groupby', 'indent', 'int', 'join',
  'last', 'length', 'list', 'lower', 'nl2br', 'random', 'reject', 'rejectattr',
  'replace', 'reverse', 'round', 'safe', 'select', 'selectattr', 'slice', 'sort',
  'string', 'striptags', 'sum', 'title', 'trim', 'truncate', 'upper', 'urlencode',
  'urlize', 'wordcount',
]);

/** Returns whether the pinned standard library exposes one filter name. */
export function hasBuiltinFilter(name: string): boolean {
  return builtinFilters.has(name);
}

/** Applies one trusted built-in filter to copied public values. */
export function applyBuiltinFilter(
  name: string,
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  keyword: ReadonlyMap<string, RuntimeValue>,
): RuntimeValue | undefined {
  if (!builtinFilters.has(name)) {
    return undefined;
  }
  if (name === 'abs') {
    return Math.abs(runtimeNumber(input));
  }
  if (name === 'batch') {
    return batchRuntimeValues(input, positional);
  }
  if (name === 'capitalize') {
    const text = renderRuntimeValue(input).toLowerCase();
    return copySafeness(input, text.charAt(0).toUpperCase() + text.slice(1));
  }
  if (name === 'center') {
    const text = renderRuntimeValue(input);
    const width = runtimeNumber(positional[0] ?? 80) || 80;
    if (text.length >= width) {
      return input;
    }
    const spaces = width - text.length;
    return copySafeness(
      input,
      ' '.repeat(Math.floor(spaces / 2 - spaces % 2)) + text + ' '.repeat(Math.floor(spaces / 2)),
    );
  }
  if (name === 'default' || name === 'd') {
    return runtimeTruthy(positional[1])
      ? (runtimeTruthy(input) ? input : positional[0])
      : (input === undefined ? positional[0] : input);
  }
  if (name === 'dictsort') {
    return dictsortRuntimeValues(input, positional);
  }
  if (name === 'dump') {
    const spacing = positional[0] === undefined ? undefined : runtimeNumber(positional[0]);
    return JSON.stringify(toJsonValue(input), null, spacing);
  }
  if (name === 'escape' || name === 'e') {
    return input instanceof RuntimeSafeString
      ? input
      : new RuntimeSafeString(escapeHtml(renderRuntimeValue(input)));
  }
  if (name === 'forceescape') {
    return new RuntimeSafeString(escapeHtml(renderRuntimeValue(input)));
  }
  if (name === 'safe') {
    return input instanceof RuntimeSafeString ? input : new RuntimeSafeString(renderRuntimeValue(input));
  }
  if (name === 'first' || name === 'last') {
    return edgeRuntimeValue(input, name === 'last');
  }
  if (name === 'float') {
    const parsed = Number.parseFloat(renderRuntimeValue(input));
    return Number.isNaN(parsed) ? positional[0] : parsed;
  }
  if (name === 'int') {
    const base = Math.trunc(runtimeNumber(positional[1] ?? 10));
    const parsed = Number.parseInt(renderRuntimeValue(input), base);
    return Number.isNaN(parsed) ? positional[0] : parsed;
  }
  if (name === 'reverse') {
    if (typeof input === 'string' || input instanceof RuntimeSafeString) {
      const reversed = renderRuntimeValue(input).split('').reverse().join('');
      return input instanceof RuntimeSafeString ? new RuntimeSafeString(reversed) : reversed;
    }
    if (input instanceof RuntimeArray) {
      return new RuntimeArray(Array.from(input.values()).reverse());
    }
  }
  if (name === 'groupby') {
    return groupRuntimeValues(input, positional[0]);
  }
  if (name === 'join') {
    return joinRuntimeValues(input, positional);
  }
  if (name === 'sum') {
    return sumRuntimeValues(input, positional);
  }
  if (name === 'sort') {
    return sortRuntimeValues(input, positional, keyword);
  }
  if (name === 'selectattr' || name === 'rejectattr') {
    return selectRuntimeAttributes(input, positional, name === 'selectattr');
  }
  if (name === 'select' || name === 'reject') {
    return selectRuntimeValues(input, positional, name === 'select');
  }
  if (name === 'indent') {
    const text = renderRuntimeValue(input);
    if (text === '') {
      return '';
    }
    const width = Math.max(0, Math.trunc(runtimeNumber(positional[0] ?? 4) || 4));
    const indentFirst = runtimeTruthy(positional[1]);
    const lines = text.split('\n');
    const indentation = ' '.repeat(width);
    for (let index = indentFirst ? 0 : 1; index < lines.length; index += 1) {
      lines[index] = `${indentation}${lines[index]}`;
    }
    return copySafeness(input, lines.join('\n'));
  }
  if (name === 'length') {
    return runtimeLength(input);
  }
  if (name === 'list') {
    return listRuntimeValue(input);
  }
  if (name === 'lower' || name === 'upper') {
    const text = renderRuntimeValue(input);
    return name === 'lower' ? text.toLowerCase() : text.toUpperCase();
  }
  if (name === 'nl2br') {
    return copySafeness(input, renderRuntimeValue(input).replace(lineBreakPattern, '<br />\n'));
  }
  if (name === 'random') {
    if (!(input instanceof RuntimeArray) || input.length === 0) {
      return undefined;
    }
    return input.at(Math.floor(Math.random() * input.length));
  }
  if (name === 'replace') {
    return replaceRuntimeValue(input, positional);
  }
  if (name === 'round') {
    const precision = Math.trunc(runtimeNumber(positional[0] ?? 0));
    const factor = 10 ** precision;
    const method = renderRuntimeValue(positional[1]);
    const rounder = method === 'ceil' ? Math.ceil : method === 'floor' ? Math.floor : Math.round;
    return rounder(runtimeNumber(input) * factor) / factor;
  }
  if (name === 'slice') {
    return sliceRuntimeValues(input, positional);
  }
  if (name === 'string') {
    return copySafeness(input, renderRuntimeValue(input));
  }
  if (name === 'striptags') {
    const stripped = renderRuntimeValue(input)
      .replace(htmlTagPattern, '')
      .trim();
    const text = runtimeTruthy(positional[0])
      ? stripped
        .replace(lineEdgeSpacesPattern, '')
        .replace(repeatedSpacesPattern, ' ')
        .replace(windowsLineBreakPattern, '\n')
        .replace(excessBlankLinesPattern, '\n\n')
      : stripped.replace(repeatedWhitespacePattern, ' ');
    return copySafeness(input, text);
  }
  if (name === 'title') {
    const words = renderRuntimeValue(input).split(' ');
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      const lower = word.toLowerCase();
      words[index] = lower.charAt(0).toUpperCase() + lower.slice(1);
    }
    return copySafeness(input, words.join(' '));
  }
  if (name === 'trim') {
    return copySafeness(input, renderRuntimeValue(input).trim());
  }
  if (name === 'truncate') {
    return truncateRuntimeValue(input, positional);
  }
  if (name === 'urlencode') {
    return urlencodeRuntimeValue(input);
  }
  if (name === 'urlize') {
    return urlizeRuntimeValue(input, positional);
  }
  if (name === 'wordcount') {
    return renderRuntimeValue(input).match(wordPattern)?.length ?? null;
  }
  return undefined;
}

function batchRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return new RuntimeArray([]);
  }
  const width = Math.trunc(runtimeNumber(positional[0]));
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new TypeError('Batch size must be a positive integer');
  }
  const fill = positional[1];
  const output: RuntimeValue[] = [];
  let row: RuntimeValue[] = [];
  for (const value of input.values()) {
    row.push(value);
    if (row.length === width) {
      output.push(new RuntimeArray(row));
      row = [];
    }
  }
  if (row.length > 0) {
    if (runtimeTruthy(fill)) {
      while (row.length < width) {
        row.push(fill);
      }
    }
    output.push(new RuntimeArray(row));
  }
  return new RuntimeArray(output);
}

function dictsortRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (!(input instanceof RuntimeRecord)) {
    throw new TypeError('dictsort requires a record');
  }
  const caseSensitive = runtimeTruthy(positional[0]);
  const by = renderRuntimeValue(positional[1] ?? 'key');
  if (by !== 'key' && by !== 'value') {
    throw new TypeError('dictsort can only sort by key or value');
  }
  const values = Array.from(input.entries());
  values.sort((left, right) => compareRuntimeFilterValues(
    by === 'key' ? left[0] : left[1],
    by === 'key' ? right[0] : right[1],
    caseSensitive,
  ));
  return new RuntimeArray(values.map(entry => new RuntimeArray(entry)));
}

function edgeRuntimeValue(input: RuntimeValue, last: boolean): RuntimeValue {
  if (input instanceof RuntimeArray) {
    return input.at(last ? input.length - 1 : 0);
  }
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    const text = renderRuntimeValue(input);
    return text[last ? text.length - 1 : 0];
  }
  return undefined;
}

function runtimeLength(input: RuntimeValue): number {
  if (input instanceof RuntimeArray) {
    return input.length;
  }
  if (input instanceof RuntimeRecord) {
    return input.size;
  }
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    return renderRuntimeValue(input).length;
  }
  return 0;
}

function listRuntimeValue(input: RuntimeValue): RuntimeValue {
  if (input instanceof RuntimeArray) {
    return input;
  }
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    return new RuntimeArray(renderRuntimeValue(input).split(''));
  }
  if (input instanceof RuntimeRecord) {
    const output: RuntimeValue[] = [];
    for (const [key, value] of input.entries()) {
      output.push(new RuntimeRecord([
        ['key', key],
        ['value', value],
      ]));
    }
    return new RuntimeArray(output);
  }
  throw new TypeError('list requires an iterable value');
}

function selectRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  select: boolean,
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return new RuntimeArray([]);
  }
  const testName = positional[0] === undefined ? 'truthy' : renderRuntimeValue(positional[0]);
  const testArguments = positional.slice(1);
  const output: RuntimeValue[] = [];
  for (const value of input.values()) {
    const result = applyBuiltinTest(testName, value, testArguments);
    if (result === undefined) {
      throw new Error(`Unknown template test ${testName}`);
    }
    if (result === select) {
      output.push(value);
    }
  }
  return new RuntimeArray(output);
}

function replaceRuntimeValue(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  const text = renderRuntimeValue(input);
  const replacement = renderRuntimeValue(positional[1]);
  const maximum = positional[2] === undefined ? -1 : Math.trunc(runtimeNumber(positional[2]));
  const search = positional[0];
  let output: string;
  if (search instanceof RuntimeRegex) {
    output = text.replace(new RegExp(search.source, search.flags), replacement);
  } else if (
    typeof search !== 'string' &&
    typeof search !== 'number' &&
    !(search instanceof RuntimeSafeString)
  ) {
    return input;
  } else {
    const needle = renderRuntimeValue(search);
    if (maximum === 0) {
      return input;
    }
    if (needle === '') {
      output = `${replacement}${text.split('').join(replacement)}${replacement}`;
    } else if (maximum < 0) {
      output = text.split(needle).join(replacement);
    } else {
      let remaining = text;
      const chunks: string[] = [];
      for (let count = 0; count < maximum; count += 1) {
        const index = remaining.indexOf(needle);
        if (index < 0) {
          break;
        }
        chunks.push(remaining.slice(0, index), replacement);
        remaining = remaining.slice(index + needle.length);
      }
      chunks.push(remaining);
      output = chunks.join('');
    }
  }
  return copySafeness(input, output);
}

function sliceRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return new RuntimeArray([]);
  }
  const count = Math.trunc(runtimeNumber(positional[0]));
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new TypeError('Slice count must be a positive integer');
  }
  const values = Array.from(input.values());
  const base = Math.floor(values.length / count);
  const extra = values.length % count;
  const fill = positional[1];
  const output: RuntimeValue[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const length = base + (index < extra ? 1 : 0);
    const part = values.slice(offset, offset + length);
    offset += length;
    if (runtimeTruthy(fill) && index >= extra) {
      part.push(fill);
    }
    output.push(new RuntimeArray(part));
  }
  return new RuntimeArray(output);
}

function truncateRuntimeValue(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  const text = renderRuntimeValue(input);
  const length = Math.trunc(runtimeNumber(positional[0] ?? 255)) || 255;
  if (text.length <= length) {
    return input;
  }
  let truncated: string;
  if (runtimeTruthy(positional[1])) {
    truncated = text.slice(0, length);
  } else {
    const index = text.lastIndexOf(' ', length);
    truncated = text.slice(0, index < 0 ? length : index);
  }
  return copySafeness(input, truncated + renderRuntimeValue(positional[2] ?? '...'));
}

function urlencodeRuntimeValue(input: RuntimeValue): string {
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    return encodeURIComponent(renderRuntimeValue(input));
  }
  const output: string[] = [];
  if (input instanceof RuntimeRecord) {
    for (const [key, value] of input.entries()) {
      output.push(urlencodeRuntimePair(key, value));
    }
  } else if (input instanceof RuntimeArray) {
    for (const value of input.values()) {
      if (value instanceof RuntimeArray && value.length >= 2) {
        output.push(urlencodeRuntimePair(value.at(0), value.at(1)));
      }
    }
  }
  return output.join('&');
}

function urlencodeRuntimePair(key: RuntimeValue, value: RuntimeValue): string {
  return `${encodeURIComponent(renderRuntimeValue(key))}=${encodeURIComponent(renderRuntimeValue(value))}`;
}

function urlizeRuntimeValue(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): string {
  const lengthValue = runtimeNumber(positional[0]);
  const length = Number.isNaN(lengthValue) ? Number.POSITIVE_INFINITY : lengthValue;
  const nofollow = positional[1] === true ? ' rel="nofollow"' : '';
  const output: string[] = [];
  for (const word of renderRuntimeValue(input).split(urlizeSeparatorPattern)) {
    if (word.length === 0) {
      continue;
    }
    const match = urlizePunctuationPattern.exec(word);
    const possible = match?.[1] ?? word;
    const short = possible.slice(0, length);
    if (httpUrlPattern.test(possible)) {
      output.push(`<a href="${possible}"${nofollow}>${short}</a>`);
    } else if (wwwUrlPattern.test(possible)) {
      output.push(`<a href="http://${possible}"${nofollow}>${short}</a>`);
    } else if (emailAddressPattern.test(possible)) {
      output.push(`<a href="mailto:${possible}">${possible}</a>`);
    } else if (commonDomainPattern.test(possible)) {
      output.push(`<a href="http://${possible}"${nofollow}>${short}</a>`);
    } else {
      output.push(word);
    }
  }
  return output.join('');
}

function copySafeness(input: RuntimeValue, output: string): RuntimeValue {
  return input instanceof RuntimeSafeString ? new RuntimeSafeString(output) : output;
}

function escapeHtml(value: string): string {
  return value.replace(
    htmlEscapeCharacterPattern,
    character => htmlEscapeReplacements[character]!,
  );
}

function toJsonValue(value: RuntimeValue): unknown {
  if (value instanceof RuntimeSafeString) {
    return value.value;
  }
  if (value instanceof RuntimeArray) {
    const output = Object.setPrototypeOf([], null) as unknown[];
    for (const item of value.values()) {
      output[output.length] = toJsonValue(item);
    }
    return output;
  }
  if (value instanceof RuntimeRecord) {
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of value.entries()) {
      output[key] = toJsonValue(item);
    }
    return output;
  }
  if (value instanceof RuntimeRegex || value instanceof RuntimeCallable) {
    return undefined;
  }
  return value;
}

function joinRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return '';
  }
  const separator = renderRuntimeValue(positional[0] ?? '');
  const attribute = optionalAttributePath(positional[1]);
  const output: string[] = [];
  for (const value of input.values()) {
    output.push(renderRuntimeValue(attribute ? lookupRuntimePath(value, attribute) : value));
  }
  return output.join(separator);
}

function sumRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return runtimeNumber(positional[1] ?? 0);
  }
  const attribute = optionalAttributePath(positional[0]);
  let total = runtimeNumber(positional[1] ?? 0);
  for (const value of input.values()) {
    total += runtimeNumber(attribute ? lookupRuntimePath(value, attribute) : value);
  }
  return total;
}

function sortRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  keyword: ReadonlyMap<string, RuntimeValue>,
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return new RuntimeArray([]);
  }
  const reverse = runtimeTruthy(keyword.get('reverse') ?? positional[0]);
  const caseSensitive = runtimeTruthy(keyword.get('case_sensitive') ?? positional[1]);
  const attribute = optionalAttributePath(keyword.get('attribute') ?? positional[2]);
  const values = Array.from(input.values());
  values.sort((left, right) => {
    const leftValue = attribute ? lookupRuntimePath(left, attribute) : left;
    const rightValue = attribute ? lookupRuntimePath(right, attribute) : right;
    const result = compareRuntimeFilterValues(leftValue, rightValue, caseSensitive);
    return reverse ? -result : result;
  });
  return new RuntimeArray(values);
}

function selectRuntimeAttributes(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  select: boolean,
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return new RuntimeArray([]);
  }
  const attribute = optionalAttributePath(positional[0]);
  if (!attribute) {
    throw new TypeError('Attribute selection requires a string attribute path');
  }
  const testName = positional[1] === undefined ? 'truthy' : renderRuntimeValue(positional[1]);
  const testArguments = positional.slice(2);
  const output: RuntimeValue[] = [];
  for (const value of input.values()) {
    const result = applyBuiltinTest(testName, lookupRuntimePath(value, attribute), testArguments);
    if (result === undefined) {
      throw new Error(`Unknown template test ${testName}`);
    }
    if (result === select) {
      output.push(value);
    }
  }
  return new RuntimeArray(output);
}

function optionalAttributePath(value: RuntimeValue): readonly string[] | undefined {
  if (value === undefined || value === null || value === false) {
    return undefined;
  }
  if (typeof value !== 'string' && !(value instanceof RuntimeSafeString)) {
    return undefined;
  }
  const path = renderRuntimeValue(value).split('.');
  for (const segment of path) {
    if (isReservedName(segment)) {
      throw new TypeError(`Template attribute ${segment} is reserved`);
    }
  }
  return path;
}

function lookupRuntimePath(value: RuntimeValue, path: readonly string[]): RuntimeValue {
  let current = value;
  for (const segment of path) {
    current = current instanceof RuntimeRecord ? current.get(segment) : undefined;
  }
  return current;
}

function compareRuntimeFilterValues(
  left: RuntimeValue,
  right: RuntimeValue,
  caseSensitive: boolean,
): number {
  if (
    typeof left === 'number' &&
    typeof right === 'number'
  ) {
    return left - right;
  }
  const leftText = renderRuntimeValue(left);
  const rightText = renderRuntimeValue(right);
  const normalizedLeft = caseSensitive ? leftText : leftText.toLowerCase();
  const normalizedRight = caseSensitive ? rightText : rightText.toLowerCase();
  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  return 0;
}

function groupRuntimeValues(input: RuntimeValue, attribute: RuntimeValue): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    return new RuntimeRecord([]);
  }
  const path = optionalAttributePath(attribute) ?? [];
  const grouped = new Map<string, RuntimeValue[]>();
  for (const value of input.values()) {
    let key: RuntimeValue = value;
    for (const segment of path) {
      key = key instanceof RuntimeRecord ? key.get(segment) : undefined;
    }
    if (path.length === 0) {
      key = undefined;
    }
    const renderedKey = key === undefined ? 'undefined' : renderRuntimeValue(key);
    if (isReservedName(renderedKey)) {
      throw new TypeError(`Template record key ${renderedKey} is reserved`);
    }
    const values = grouped.get(renderedKey) ?? [];
    values.push(value);
    grouped.set(renderedKey, values);
  }
  const numeric: Array<readonly [string, RuntimeValue]> = [];
  const named: Array<readonly [string, RuntimeValue]> = [];
  for (const [key, values] of grouped) {
    const entry = [key, new RuntimeArray(values)] as const;
    if (isArrayIndex(key)) {
      numeric.push(entry);
    } else {
      named.push(entry);
    }
  }
  numeric.sort(([left], [right]) => Number(left) - Number(right));
  for (const entry of named) {
    numeric.push(entry);
  }
  return new RuntimeRecord(numeric);
}

function isArrayIndex(value: string): boolean {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number < 0xffff_ffff && `${number}` === value;
}

/** Applies one closed built-in test. */
export function applyBuiltinTest(
  name: string,
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): boolean | undefined {
  switch (name) {
    case 'callable':
      return input instanceof RuntimeCallable;
    case 'defined':
      return input !== undefined;
    case 'divisibleby':
      return runtimeNumber(input) % runtimeNumber(positional[0]) === 0;
    case 'escaped':
      return input instanceof RuntimeSafeString;
    case 'eq':
    case 'equalto':
    case 'sameas':
      return positional.length === 1 && input === positional[0];
    case 'even':
      return runtimeNumber(input) % 2 === 0;
    case 'falsy':
      return !runtimeTruthy(input);
    case 'ge':
      return runtimeNumber(input) >= runtimeNumber(positional[0]);
    case 'greaterthan':
    case 'gt':
      return runtimeNumber(input) > runtimeNumber(positional[0]);
    case 'iterable':
      return typeof input === 'string' || input instanceof RuntimeSafeString || input instanceof RuntimeArray;
    case 'le':
      return runtimeNumber(input) <= runtimeNumber(positional[0]);
    case 'lessthan':
    case 'lt':
      return runtimeNumber(input) < runtimeNumber(positional[0]);
    case 'lower': {
      const text = renderRuntimeValue(input);
      return text.toLowerCase() === text;
    }
    case 'mapping':
      return input instanceof RuntimeRecord;
    case 'ne':
      return positional.length !== 1 || input !== positional[0];
    case 'null':
      return input === null;
    case 'number':
      return typeof input === 'number';
    case 'odd':
      return runtimeNumber(input) % 2 === 1;
    case 'string':
      return typeof input === 'string';
    case 'truthy':
      return runtimeTruthy(input);
    case 'undefined':
      return input === undefined;
    case 'upper': {
      const text = renderRuntimeValue(input);
      return text.toUpperCase() === text;
    }
    default:
      return undefined;
  }
}

/** Explicit numeric coercion matching template arithmetic. */
export function runtimeNumber(value: RuntimeValue): number {
  if (value === null) {
    return 0;
  }
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' || value instanceof RuntimeSafeString) {
    const text = typeof value === 'string' ? value : value.value;
    return text.trim() === '' ? 0 : Number(text);
  }
  return Number.NaN;
}

/** Resolves one explicit own lookup over a closed value. */
export function lookupRuntimeValue(
  target: RuntimeValue,
  key: RuntimeValue,
): RuntimeValue | undefined {
  if (target instanceof RuntimeRecord) {
    return target.get(renderRuntimeValue(key));
  }
  if (target instanceof RuntimeArray) {
    const index = runtimeNumber(key);
    if (Number.isSafeInteger(index) && index >= 0) {
      return target.at(index);
    }
    return undefined;
  }
  if (typeof target === 'string' || target instanceof RuntimeSafeString) {
    const text = typeof target === 'string' ? target : target.value;
    const index = runtimeNumber(key);
    if (Number.isSafeInteger(index) && index >= 0) {
      return text[index];
    }
    if (key === 'length') {
      return text.length;
    }
  }
  return undefined;
}

/** Resolves one parser-validated primitive lookup without generic coercion. */
export function lookupRuntimeConstantKey(
  target: RuntimeValue,
  key: undefined | null | boolean | number | string,
): RuntimeValue | undefined {
  if (target instanceof RuntimeRecord) {
    return target.get(renderRuntimeValue(key));
  }
  const index = constantKeyIndex(key);
  if (target instanceof RuntimeArray) {
    return index === undefined ? undefined : target.at(index);
  }
  if (typeof target === 'string' || target instanceof RuntimeSafeString) {
    const text = typeof target === 'string' ? target : target.value;
    if (index !== undefined) {
      return text[index];
    }
    if (key === 'length') {
      return text.length;
    }
  }
  return undefined;
}

function constantKeyIndex(
  key: undefined | null | boolean | number | string,
): number | undefined {
  let index: number;
  if (key === undefined) {
    return undefined;
  }
  if (key === null || key === false) {
    index = 0;
  } else if (key === true) {
    index = 1;
  } else if (typeof key === 'number') {
    index = key;
  } else {
    index = key.trim() === '' ? 0 : Number(key);
  }
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}
