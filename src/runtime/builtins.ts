import { randomInt } from 'node:crypto';

import {
  runtimeAdd,
  runtimeArrayIndexFromPropertyKey,
  runtimeOrder,
  runtimeToNumber,
  runtimeToPropertyKey,
  runtimeToString,
} from './coercion.ts';
import {
  assertRuntimeValueHasNoCallable,
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
  assertRuntimeValueHasNoCallable(input);
  for (const value of positional) {
    assertRuntimeValueHasNoCallable(value);
  }
  for (const value of keyword.values()) {
    assertRuntimeValueHasNoCallable(value);
  }
  if (name === 'abs') {
    return Math.abs(runtimeToNumber(input));
  }
  if (name === 'batch') {
    return batchRuntimeValues(input, positional);
  }
  if (name === 'capitalize') {
    const text = normalizedRuntimeText(input).toLowerCase();
    return copySafeness(input, text.charAt(0).toUpperCase() + text.slice(1));
  }
  if (name === 'center') {
    const text = normalizedRuntimeText(input);
    const width = runtimeToNumber(positional[0] ?? 80) || 80;
    if (text.length >= width) {
      return copySafeness(input, text);
    }
    const spaces = width - text.length;
    return copySafeness(
      input,
      ' '.repeat(Math.floor(spaces / 2)) + text + ' '.repeat(Math.ceil(spaces / 2)),
    );
  }
  if (name === 'default' || name === 'd') {
    const boolean = keywordArgument(keyword, 'boolean', positional, 1);
    return runtimeTruthy(boolean)
      ? (runtimeTruthy(input) ? input : positional[0])
      : (input === undefined ? positional[0] : input);
  }
  if (name === 'dictsort') {
    return dictsortRuntimeValues(input, positional);
  }
  if (name === 'dump') {
    const spacing = positional[0] === undefined ? undefined : runtimeToNumber(positional[0]);
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
    const parsed = Number.parseFloat(runtimeToString(input));
    return Number.isNaN(parsed) ? positional[0] : parsed;
  }
  if (name === 'int') {
    const fallback = keywordArgument(keyword, 'default', positional, 0);
    const baseValue = keywordArgument(keyword, 'base', positional, 1);
    const base = baseValue === undefined ? 10 : Math.trunc(runtimeToNumber(baseValue));
    const parsed = Number.parseInt(runtimeToString(input), base);
    return Number.isNaN(parsed) ? fallback : parsed;
  }
  if (name === 'reverse') {
    if (typeof input === 'string' || input instanceof RuntimeSafeString) {
      const reversed = runtimeText(input).split('').reverse().join('');
      return input instanceof RuntimeSafeString ? new RuntimeSafeString(reversed) : reversed;
    }
    if (input instanceof RuntimeArray) {
      return new RuntimeArray(Array.from(input.values()).reverse());
    }
    return new RuntimeArray([]);
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
    const text = normalizedRuntimeText(input);
    if (text === '') {
      return '';
    }
    const width = Math.max(0, Math.trunc(runtimeToNumber(positional[0] ?? 4) || 4));
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
    const text = normalizedRuntimeText(input);
    return name === 'lower' ? text.toLowerCase() : text.toUpperCase();
  }
  if (name === 'nl2br') {
    const text = input === undefined || input === null ? '' : runtimeText(input);
    return copySafeness(input, text.replace(lineBreakPattern, '<br />\n'));
  }
  if (name === 'random') {
    return randomRuntimeValue(input);
  }
  if (name === 'replace') {
    return replaceRuntimeValue(input, positional);
  }
  if (name === 'round') {
    const precision = Math.trunc(runtimeToNumber(positional[0] ?? 0));
    const factor = 10 ** precision;
    const method = runtimeToString(positional[1]);
    const rounder = method === 'ceil' ? Math.ceil : method === 'floor' ? Math.floor : Math.round;
    return rounder(runtimeToNumber(input) * factor) / factor;
  }
  if (name === 'slice') {
    return sliceRuntimeValues(input, positional);
  }
  if (name === 'string') {
    if (input === undefined || input === null) {
      throw new TypeError('string requires a value');
    }
    return copySafeness(input, renderRuntimeValue(input));
  }
  if (name === 'striptags') {
    const stripped = normalizedRuntimeText(input)
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
    const words = normalizedRuntimeText(input).split(' ');
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      const lower = word.toLowerCase();
      words[index] = lower.charAt(0).toUpperCase() + lower.slice(1);
    }
    return copySafeness(input, words.join(' '));
  }
  if (name === 'trim') {
    return copySafeness(input, runtimeText(input).trim());
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
    return normalizedRuntimeText(input).match(wordPattern)?.length ?? null;
  }
  return undefined;
}

function batchRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (input === undefined || input === null) {
    throw new TypeError('batch requires a sequence');
  }
  const values = runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeArray([]);
  }
  const width = Math.trunc(runtimeToNumber(positional[0]));
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new TypeError('Batch size must be a positive integer');
  }
  const fill = positional[1];
  const output: RuntimeValue[] = [];
  let row: RuntimeValue[] = [];
  for (const value of values) {
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
  const by = runtimeToString(positional[1] ?? 'key');
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
  if (input === undefined || input === null) {
    throw new TypeError(`${last ? 'last' : 'first'} requires a sequence`);
  }
  if (input instanceof RuntimeArray) {
    return input.at(last ? input.length - 1 : 0);
  }
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    const text = runtimeText(input);
    return text[last ? text.length - 1 : 0];
  }
  return undefined;
}

function randomRuntimeValue(input: RuntimeValue): RuntimeValue {
  if (input === undefined || input === null) {
    throw new TypeError('random requires a sequence');
  }
  const values = runtimeSequenceValues(input);
  if (!values || values.length === 0) {
    return undefined;
  }
  return values[randomInt(values.length)];
}

function runtimeLength(input: RuntimeValue): RuntimeValue {
  if (input instanceof RuntimeArray) {
    return input.length;
  }
  if (input instanceof RuntimeRecord) {
    return input.size;
  }
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    return renderRuntimeValue(input).length;
  }
  return input === undefined || input === null || input === false ? 0 : undefined;
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
  if (input === undefined || input === null) {
    throw new TypeError(`${select ? 'select' : 'reject'} requires a sequence`);
  }
  const values = runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeArray([]);
  }
  const testName = positional[0] === undefined ? 'truthy' : runtimeToString(positional[0]);
  const testArguments = positional.slice(1);
  const output: RuntimeValue[] = [];
  for (const value of values) {
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
  const search = positional[0];
  const replacement = runtimeToString(positional[1]);
  const maximum = positional[2] === undefined ? -1 : Math.trunc(runtimeToNumber(positional[2]));
  let text: string;
  if (typeof input === 'number') {
    text = runtimeToString(input);
  } else if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    text = runtimeText(input);
  } else {
    if (!(search instanceof RuntimeRegex)) {
      return input;
    }
    throw new TypeError('Regular-expression replacement requires a string');
  }
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
    const needle = runtimeToString(search);
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
  const values = runtimeSequenceValues(input);
  if (!values) {
    throw new TypeError('slice requires a sequence');
  }
  const count = Math.trunc(runtimeToNumber(positional[0]));
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new TypeError('Slice count must be a positive integer');
  }
  const base = Math.floor(values.length / count);
  const extra = values.length % count;
  const fill = positional[1];
  const output: RuntimeValue[] = [];
  let offset = 0;
  const text = typeof input === 'string' || input instanceof RuntimeSafeString
    ? runtimeText(input)
    : undefined;
  for (let index = 0; index < count; index += 1) {
    const length = base + (index < extra ? 1 : 0);
    const part = text === undefined
      ? values.slice(offset, offset + length)
      : text.slice(offset, offset + length);
    offset += length;
    if (!Array.isArray(part) && runtimeTruthy(fill) && index >= extra) {
      throw new TypeError('slice cannot append a fill value to a string');
    }
    if (Array.isArray(part) && runtimeTruthy(fill) && index >= extra) {
      part.push(fill);
    }
    output.push(Array.isArray(part) ? new RuntimeArray(part) : part);
  }
  return new RuntimeArray(output);
}

function truncateRuntimeValue(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  const text = normalizedRuntimeText(input);
  const length = Math.trunc(runtimeToNumber(positional[0] ?? 255)) || 255;
  if (text.length <= length) {
    return copySafeness(input, text);
  }
  let truncated: string;
  if (runtimeTruthy(positional[1])) {
    truncated = text.slice(0, length);
  } else {
    const index = text.lastIndexOf(' ', length);
    truncated = text.slice(0, index < 0 ? length : index);
  }
  const end = positional[2] === undefined || positional[2] === null
    ? '...'
    : runtimeToString(positional[2]);
  return copySafeness(input, truncated + end);
}

function urlencodeRuntimeValue(input: RuntimeValue): string {
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    return encodeURIComponent(runtimeText(input));
  }
  const output: string[] = [];
  if (input instanceof RuntimeRecord) {
    for (const [key, value] of input.entries()) {
      output.push(urlencodeRuntimePair(key, value));
    }
  } else if (input instanceof RuntimeArray) {
    for (const value of input.values()) {
      const [key, item] = urlencodeRuntimeEntry(value);
      output.push(urlencodeRuntimePair(key, item));
    }
  }
  return output.join('&');
}

function urlencodeRuntimeEntry(value: RuntimeValue): readonly [RuntimeValue, RuntimeValue] {
  if (value === undefined || value === null) {
    throw new TypeError('urlencode sequence entries cannot be nullish');
  }
  if (value instanceof RuntimeArray) {
    return [value.at(0), value.at(1)];
  }
  if (value instanceof RuntimeRecord) {
    return [value.get('0'), value.get('1')];
  }
  if (typeof value === 'string' || value instanceof RuntimeSafeString) {
    const text = runtimeText(value);
    return [text[0], text[1]];
  }
  return [undefined, undefined];
}

function urlencodeRuntimePair(key: RuntimeValue, value: RuntimeValue): string {
  return `${encodeURIComponent(runtimeToString(key))}=${encodeURIComponent(runtimeToString(value))}`;
}

function urlizeRuntimeValue(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): string {
  const lengthValue = runtimeToNumber(positional[0]);
  const length = Number.isNaN(lengthValue) ? Number.POSITIVE_INFINITY : lengthValue;
  const nofollow = positional[1] === true ? ' rel="nofollow"' : '';
  const output: string[] = [];
  for (const word of runtimeText(input).split(urlizeSeparatorPattern)) {
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

function runtimeText(input: RuntimeValue): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof RuntimeSafeString) {
    return input.value;
  }
  throw new TypeError('Filter input must be a string');
}

function normalizedRuntimeText(input: RuntimeValue): string {
  if (input === undefined || input === null || input === false) {
    return '';
  }
  return runtimeText(input);
}

function runtimeSequenceValues(input: RuntimeValue): RuntimeValue[] | undefined {
  if (input instanceof RuntimeArray) {
    return Array.from(input.values());
  }
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    return runtimeText(input).split('');
  }
  return undefined;
}

function keywordArgument(
  keyword: ReadonlyMap<string, RuntimeValue>,
  name: string,
  positional: readonly RuntimeValue[],
  index: number,
): RuntimeValue {
  return keyword.has(name) ? keyword.get(name) : positional[index];
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
  if (value instanceof RuntimeCallable) {
    throw new TypeError('Callable values cannot be serialized');
  }
  if (value instanceof RuntimeRegex) {
    return undefined;
  }
  return value;
}

function joinRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    throw new TypeError('join requires an array');
  }
  const separatorValue = positional[0];
  const separator = runtimeTruthy(separatorValue) ? runtimeToString(separatorValue) : '';
  const attribute = optionalAttributePath(positional[1]);
  const output: string[] = [];
  for (const value of input.values()) {
    const item = attribute ? lookupRuntimePath(value, attribute) : value;
    output.push(item === undefined || item === null ? '' : runtimeToString(item));
  }
  return output.join(separator);
}

function sumRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  if (!(input instanceof RuntimeArray)) {
    throw new TypeError('sum requires an array');
  }
  const attribute = optionalAttributePath(positional[0]);
  let reduced: RuntimeValue = 0;
  for (const value of input.values()) {
    reduced = runtimeAdd(
      reduced,
      attribute ? lookupRuntimePath(value, attribute) : value,
    );
  }
  return runtimeAdd(positional[1] === undefined ? 0 : positional[1], reduced);
}

function sortRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  keyword: ReadonlyMap<string, RuntimeValue>,
): RuntimeValue {
  const values = runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeArray([]);
  }
  const reverse = runtimeTruthy(keywordArgument(keyword, 'reverse', positional, 0));
  const caseSensitive = runtimeTruthy(keywordArgument(keyword, 'case_sensitive', positional, 1));
  const attribute = optionalAttributePath(keywordArgument(keyword, 'attribute', positional, 2));
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
    throw new TypeError(`${select ? 'selectattr' : 'rejectattr'} requires an array`);
  }
  const attribute = optionalAttributePath(positional[0]);
  if (!attribute) {
    throw new TypeError('Attribute selection requires a string attribute path');
  }
  const testName = positional[1] === undefined ? 'truthy' : runtimeToString(positional[1]);
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
  const path = runtimeToString(value).split('.');
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
  const leftText = runtimeToString(left);
  const rightText = runtimeToString(right);
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
  if (input === undefined || input === null) {
    throw new TypeError('groupby requires a sequence');
  }
  const values = runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeRecord([]);
  }
  const path = optionalAttributePath(attribute) ?? [];
  const grouped = new Map<string, RuntimeValue[]>();
  for (const value of values) {
    let key: RuntimeValue = value;
    for (const segment of path) {
      key = key instanceof RuntimeRecord ? key.get(segment) : undefined;
    }
    if (path.length === 0) {
      key = undefined;
    }
    const renderedKey = runtimeToPropertyKey(key);
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
      return runtimeToNumber(input) % runtimeToNumber(positional[0]) === 0;
    case 'escaped':
      return input instanceof RuntimeSafeString;
    case 'eq':
    case 'equalto':
    case 'sameas':
      return positional.length === 1 && input === positional[0];
    case 'even':
      return runtimeToNumber(input) % 2 === 0;
    case 'falsy':
      return !runtimeTruthy(input);
    case 'ge':
      return runtimeOrder(input, positional[0]) >= 0;
    case 'greaterthan':
    case 'gt':
      return runtimeOrder(input, positional[0]) > 0;
    case 'iterable':
      if (input === undefined || input === null) {
        throw new TypeError('iterable test requires a value');
      }
      return typeof input === 'string' || input instanceof RuntimeSafeString || input instanceof RuntimeArray;
    case 'le':
      return runtimeOrder(input, positional[0]) <= 0;
    case 'lessthan':
    case 'lt':
      return runtimeOrder(input, positional[0]) < 0;
    case 'lower': {
      if (input instanceof RuntimeSafeString) {
        return false;
      }
      const text = runtimeText(input);
      return text.toLowerCase() === text;
    }
    case 'mapping':
      return input instanceof RuntimeRecord ||
        input instanceof RuntimeSafeString ||
        input instanceof RuntimeRegex;
    case 'ne':
      return positional.length !== 1 || input !== positional[0];
    case 'null':
      return input === null;
    case 'number':
      return typeof input === 'number';
    case 'odd':
      return runtimeToNumber(input) % 2 === 1;
    case 'string':
      return typeof input === 'string';
    case 'truthy':
      return runtimeTruthy(input);
    case 'undefined':
      return input === undefined;
    case 'upper': {
      if (input instanceof RuntimeSafeString) {
        return false;
      }
      const text = runtimeText(input);
      return text.toUpperCase() === text;
    }
    default:
      return undefined;
  }
}

/** Resolves one explicit own lookup over a closed value. */
export function lookupRuntimeValue(
  target: RuntimeValue,
  key: RuntimeValue,
): RuntimeValue | undefined {
  const propertyKey = runtimeToPropertyKey(key);
  if (target instanceof RuntimeRecord) {
    return target.get(propertyKey);
  }
  if (target instanceof RuntimeArray) {
    if (propertyKey === 'length') {
      return target.length;
    }
    const index = runtimeArrayIndexFromPropertyKey(propertyKey, target.length);
    return index === undefined ? undefined : target.at(index);
  }
  if (typeof target === 'string' || target instanceof RuntimeSafeString) {
    const text = typeof target === 'string' ? target : target.value;
    if (propertyKey === 'length') {
      return text.length;
    }
    const index = runtimeArrayIndexFromPropertyKey(propertyKey, text.length);
    return index === undefined ? undefined : text[index];
  }
  return undefined;
}

/** Resolves one parser-validated primitive lookup without generic coercion. */
export function lookupRuntimeConstantKey(
  target: RuntimeValue,
  key: undefined | null | boolean | number | string,
): RuntimeValue | undefined {
  return lookupRuntimeValue(target, key);
}
