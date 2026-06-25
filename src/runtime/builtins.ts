import { randomInt } from 'node:crypto';

import { normalizeMacroArguments } from './arguments.ts';
import {
  runtimeAdd,
  runtimeArrayIndexFromPropertyKey,
  runtimeOrder,
  runtimeStrictEqual,
  runtimeToNumber,
  runtimeToPropertyKey,
  runtimeToString,
} from './coercion.ts';
import {
  assertRuntimeValueHasNoCallable,
  defineOwnArrayIndex,
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
const maximumRepeatedSpaces = 16 * 1024 * 1024;
const maximumStripTagsPasses = 8;
const randomFractionResolution = 0x1_0000_0000;
const htmlEscapeReplacements: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '\\': '&#92;',
});

const builtinFilterNames = Object.freeze([
  'abs', 'batch', 'capitalize', 'center', 'd', 'default', 'dictsort', 'dump', 'e',
  'escape', 'first', 'float', 'forceescape', 'groupby', 'indent', 'int', 'join',
  'last', 'length', 'list', 'lower', 'nl2br', 'random', 'reject', 'rejectattr',
  'replace', 'reverse', 'round', 'safe', 'select', 'selectattr', 'slice', 'sort',
  'string', 'striptags', 'sum', 'title', 'trim', 'truncate', 'upper', 'urlencode',
  'urlize', 'wordcount',
]);
const builtinFilters = new Set(builtinFilterNames);

const builtinTestArities = new Map<string, number>([
  ['callable', 0],
  ['defined', 0],
  ['divisibleby', 1],
  ['escaped', 0],
  ['eq', 1],
  ['equalto', 1],
  ['even', 0],
  ['falsy', 0],
  ['ge', 1],
  ['greaterthan', 1],
  ['gt', 1],
  ['iterable', 0],
  ['le', 1],
  ['lessthan', 1],
  ['lower', 0],
  ['lt', 1],
  ['mapping', 0],
  ['ne', 1],
  ['null', 0],
  ['number', 0],
  ['odd', 0],
  ['sameas', 1],
  ['string', 0],
  ['truthy', 0],
  ['undefined', 0],
  ['upper', 0],
]);
const builtinTestNames = Object.freeze(Array.from(builtinTestArities.keys()));

const macroFilterPositionalNames = new Map<string, readonly string[]>([
  ['int', Object.freeze(['default', 'base'])],
  ['sort', Object.freeze(['reverse', 'case_sensitive', 'attribute'])],
]);

/** Returns whether the pinned standard library exposes one filter name. */
export function hasBuiltinFilter(name: string): boolean {
  return builtinFilters.has(name);
}

/** Returns the fixed built-in filter spellings for bounded diagnostics. */
export function listBuiltinFilterNames(): readonly string[] {
  return builtinFilterNames;
}

/** Returns whether the pinned standard library exposes one test name. */
export function hasBuiltinTest(name: string): boolean {
  return builtinTestArities.has(name);
}

/** Returns the fixed built-in test spellings for bounded diagnostics. */
export function listBuiltinTestNames(): readonly string[] {
  return builtinTestNames;
}

/** Returns the exact positional arity for one closed built-in test. */
export function builtinTestArity(name: string): number | undefined {
  return builtinTestArities.get(name);
}

/** Lowers filter keywords according to the pinned Nunjucks calling convention. */
export function lowerBuiltinFilterArguments(
  name: string,
  positional: readonly RuntimeValue[],
  keyword: ReadonlyMap<string, RuntimeValue>,
): {
  readonly positional: readonly RuntimeValue[];
  readonly keyword: ReadonlyMap<string, RuntimeValue>;
  readonly scratch: readonly RuntimeValue[];
} {
  for (const value of positional) {
    assertRuntimeValueHasNoCallable(value);
  }
  for (const value of keyword.values()) {
    assertRuntimeValueHasNoCallable(value);
  }
  const positionalNames = macroFilterPositionalNames.get(name);
  if (positionalNames) {
    const normalized = normalizeMacroArguments(
      positionalNames,
      [],
      { positional, keyword },
    );
    return {
      positional: normalized.positional,
      keyword: new Map(),
      scratch: Object.freeze([...positional, ...keyword.values()]),
    };
  }
  if (keyword.size === 0) {
    return { positional, keyword, scratch: positional };
  }
  const entries = Array.from(keyword.entries());
  entries.push(['__keywords', true]);
  const loweredPositional = Object.freeze([
    ...positional,
    new RuntimeRecord(entries),
  ]);
  return { positional: loweredPositional, keyword: new Map(), scratch: loweredPositional };
}

/** Applies one built-in and reserves projected indexed intermediates before allocation. */
export function applyBuiltinFilter(
  name: string,
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  keyword: ReadonlyMap<string, RuntimeValue>,
  reserveIndexedValues: (count: number) => void,
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
    return batchRuntimeValues(input, positional, reserveIndexedValues);
  }
  if (name === 'capitalize') {
    const text = normalizedRuntimeText(input).toLowerCase();
    return copySafeness(input, text.charAt(0).toUpperCase() + text.slice(1));
  }
  if (name === 'center') {
    const normalized = normalizeRuntimeTextInput(input);
    const widthValue = runtimeTruthy(positional[0]) ? positional[0] : 80;
    const length = runtimeDirectLength(normalized);
    if (runtimeOrder(length, widthValue) >= 0) {
      return normalized;
    }
    const spaces = runtimeToNumber(widthValue) - runtimeToNumber(length);
    const text = runtimeToString(normalized);
    return copySafeness(
      normalized,
      repeatSpaces(spaces / 2 - spaces % 2) + text + repeatSpaces(spaces / 2),
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
    const spacing = jsonIndentation(positional[0]);
    return JSON.stringify(toJsonValue(input, new Map()), null, spacing);
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
      return new RuntimeArray(input.copySparse().reverse());
    }
    if (input instanceof RuntimeRecord) {
      return new RuntimeArray(
        mapRuntimeRecordValues(input, reserveIndexedValues).reverse(),
      );
    }
    return new RuntimeArray([]);
  }
  if (name === 'groupby') {
    return groupRuntimeValues(input, positional[0], reserveIndexedValues);
  }
  if (name === 'join') {
    return joinRuntimeValues(input, positional, reserveIndexedValues);
  }
  if (name === 'sum') {
    return sumRuntimeValues(input, positional, reserveIndexedValues);
  }
  if (name === 'sort') {
    return sortRuntimeValues(input, positional, keyword, reserveIndexedValues);
  }
  if (name === 'selectattr' || name === 'rejectattr') {
    return selectRuntimeAttributes(input, positional, name === 'selectattr');
  }
  if (name === 'select' || name === 'reject') {
    return selectRuntimeValues(
      input,
      positional,
      name === 'select',
      reserveIndexedValues,
    );
  }
  if (name === 'indent') {
    const normalized = normalizeRuntimeTextInput(input);
    const text = runtimeText(normalized);
    if (typeof normalized === 'string' && normalized === '') {
      return '';
    }
    const widthValue = runtimeTruthy(positional[0]) ? positional[0] : 4;
    const indentFirst = runtimeTruthy(positional[1]);
    const lines = text.split('\n');
    const indentation = repeatSpaces(runtimeToNumber(widthValue));
    for (let index = indentFirst ? 0 : 1; index < lines.length; index += 1) {
      lines[index] = `${indentation}${lines[index]}`;
    }
    return copySafeness(normalized, lines.join('\n'));
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
    const precisionValue = runtimeTruthy(positional[0]) ? positional[0] : 0;
    const precision = runtimeToNumber(precisionValue);
    const factor = 10 ** precision;
    const method = positional[1];
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
    if (input instanceof RuntimeSafeString) {
      return input;
    }
    return copySafeness(input, renderRuntimeValue(input));
  }
  if (name === 'striptags') {
    const stripped = stripHtmlTags(normalizedRuntimeText(input)).trim();
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
    const normalized = normalizeRuntimeTextInput(input);
    if (!runtimeTruthy(normalized)) {
      return null;
    }
    return runtimeText(normalized).match(wordPattern)?.length ?? null;
  }
  return undefined;
}

function stripHtmlTags(value: string): string {
  let stripped = value;
  for (let pass = 0; pass < maximumStripTagsPasses; pass += 1) {
    const next = stripped.replace(htmlTagPattern, '');
    if (next === stripped) {
      return stripped;
    }
    stripped = next;
  }
  if (stripped.replace(htmlTagPattern, '') !== stripped) {
    throw new TypeError('striptags input contains excessively nested markup');
  }
  return stripped;
}

function batchRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  reserveIndexedValues: (count: number) => void,
): RuntimeValue {
  if (input === undefined || input === null) {
    throw new TypeError('batch requires a sequence');
  }
  const width = Math.trunc(runtimeToNumber(positional[0]));
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new TypeError('Batch size must be a positive integer');
  }
  const values = input instanceof RuntimeRecord
    ? indexedRuntimeRecordValues(input, reserveIndexedValues)
    : runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeArray([]);
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
  const byValue = positional[1];
  if (byValue !== undefined && byValue !== 'key' && byValue !== 'value') {
    throw new TypeError('dictsort can only sort by key or value');
  }
  const by = byValue ?? 'key';
  const values = Array.from(input.entries());
  values.sort((left, right) => compareRuntimeDictsortValues(
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
  if (input instanceof RuntimeRecord) {
    if (!last) {
      return input.get('0');
    }
    const index = runtimeToNumber(input.get('length')) - 1;
    return input.get(runtimeToPropertyKey(index));
  }
  return undefined;
}

function randomRuntimeValue(input: RuntimeValue): RuntimeValue {
  if (input === undefined || input === null) {
    throw new TypeError('random requires a sequence');
  }
  if (input instanceof RuntimeRecord) {
    const length = runtimeToNumber(input.get('length'));
    const index = Number.isSafeInteger(length) && length > 0
      ? randomInt(length)
      : Math.floor(randomInt(randomFractionResolution) / randomFractionResolution * length);
    return input.get(runtimeToPropertyKey(index));
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
  reserveIndexedValues: (count: number) => void,
): RuntimeValue {
  const testName = positional[0] === undefined ? 'truthy' : runtimeToString(positional[0]);
  if (!hasBuiltinTest(testName)) {
    throw new Error(`Unknown template test ${testName}`);
  }
  if (input === undefined || input === null) {
    throw new TypeError(`${select ? 'select' : 'reject'} requires a sequence`);
  }
  const values = input instanceof RuntimeRecord
    ? sliceRuntimeRecordValues(input, reserveIndexedValues)
    : input instanceof RuntimeArray
      ? Array.from(input.presentValues())
      : runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeArray([]);
  }
  const testArguments = positional.slice(1);
  assertBuiltinTestArity(testName, testArguments.length);
  const output: RuntimeValue[] = [];
  for (const value of values) {
    const result = applyBuiltinTest(testName, value, testArguments);
    if (result === undefined) {
      throw new Error(`Invalid template test ${testName}`);
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
  const replacement = positional[1];
  const maximumValue = positional[2] === undefined ? -1 : positional[2];
  if (search instanceof RuntimeRegex) {
    if (typeof input !== 'string' && !(input instanceof RuntimeSafeString)) {
      throw new TypeError('Regular-expression replacement requires a string');
    }
    return runtimeText(input).replace(
      new RegExp(search.source, search.flags),
      runtimeToString(replacement),
    );
  }
  if (typeof search !== 'string' && typeof search !== 'number') {
    return input;
  }

  let coercedInput: RuntimeValue = input;
  if (typeof coercedInput === 'number') {
    coercedInput = runtimeToString(coercedInput);
  }
  if (typeof coercedInput !== 'string' && !(coercedInput instanceof RuntimeSafeString)) {
    return coercedInput;
  }

  const text = runtimeText(coercedInput);
  const needle = runtimeToString(search);
  if (needle === '') {
    const replacementText = runtimeToString(replacement);
    const separator = replacement === undefined ? ',' : replacementText;
    const output = replacementText + text.split('').join(separator) + replacementText;
    return copySafeness(coercedInput, output);
  }

  const nextIndex = text.indexOf(needle);
  if (maximumValue === 0 || nextIndex < 0) {
    return coercedInput;
  }

  const replacementText = runtimeToString(replacement);
  if (maximumValue === -1) {
    return copySafeness(input, text.split(needle).join(replacementText));
  }

  const maximum = runtimeToNumber(maximumValue);
  let remaining = text;
  const chunks: string[] = [];
  for (let count = 0; count < maximum; count += 1) {
    const index = remaining.indexOf(needle);
    if (index < 0) {
      break;
    }
    chunks.push(remaining.slice(0, index), replacementText);
    remaining = remaining.slice(index + needle.length);
  }
  chunks.push(remaining);
  return copySafeness(input, chunks.join(''));
}

function sliceRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): RuntimeValue {
  const values = input instanceof RuntimeArray
    ? input.copySparse()
    : runtimeSequenceValues(input);
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
  const normalized = normalizeRuntimeTextInput(input);
  const lengthValue = runtimeTruthy(positional[0]) ? positional[0] : 255;
  const inputLength = runtimeDirectLength(normalized);
  if (runtimeOrder(inputLength, lengthValue) <= 0) {
    return normalized;
  }
  const text = runtimeText(normalized);
  const length = runtimeToNumber(lengthValue);
  let truncated: string;
  if (runtimeTruthy(positional[1])) {
    truncated = text.substring(0, length);
  } else {
    const index = text.lastIndexOf(' ', length);
    truncated = text.substring(0, index < 0 ? length : index);
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
    output.length = input.length;
    for (let index = 0; index < input.length; index += 1) {
      if (input.has(index)) {
        const [key, item] = urlencodeRuntimeEntry(input.at(index));
        defineOwnArrayIndex(output, index, urlencodeRuntimePair(key, item));
      }
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
  const length = substrLength(positional[0]);
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
  return runtimeText(normalizeRuntimeTextInput(input));
}

function normalizeRuntimeTextInput(input: RuntimeValue): RuntimeValue {
  return input === undefined || input === null || input === false ? '' : input;
}

function runtimeDirectLength(input: RuntimeValue): RuntimeValue {
  if (typeof input === 'string' || input instanceof RuntimeSafeString) {
    return runtimeText(input).length;
  }
  if (input instanceof RuntimeArray) {
    return input.length;
  }
  if (input instanceof RuntimeRecord) {
    return input.get('length');
  }
  return undefined;
}

function repeatSpaces(bound: number): string {
  if (Number.isNaN(bound) || bound <= 0) {
    return '';
  }
  if (!Number.isFinite(bound) || bound > maximumRepeatedSpaces) {
    throw new RangeError('Filter spacing exceeds the supported bound');
  }
  return ' '.repeat(Math.ceil(bound));
}

function substrLength(value: RuntimeValue): number {
  if (value === undefined || (typeof value === 'number' && Number.isNaN(value))) {
    return Number.POSITIVE_INFINITY;
  }
  const number = runtimeToNumber(value);
  if (Number.isNaN(number) || number <= 0) {
    return 0;
  }
  return Number.isFinite(number) ? Math.trunc(number) : number;
}

function jsonIndentation(value: RuntimeValue): number | string | undefined {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  if (typeof value !== 'number') {
    return undefined;
  }
  if (Number.isNaN(value) || value <= 0) {
    return undefined;
  }
  return Math.min(10, Math.trunc(value));
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

function toJsonValue(
  value: RuntimeValue,
  aliases: Map<RuntimeArray | RuntimeRecord, unknown>,
): unknown {
  if (value instanceof RuntimeSafeString) {
    return value.value;
  }
  if (value instanceof RuntimeArray) {
    const existing = aliases.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const output = Object.setPrototypeOf([], null) as unknown[];
    aliases.set(value, output);
    output.length = value.length;
    for (let index = 0; index < value.length; index += 1) {
      if (value.has(index)) {
        defineOwnArrayIndex(output, index, toJsonValue(value.at(index), aliases));
      }
    }
    return output;
  }
  if (value instanceof RuntimeRecord) {
    const existing = aliases.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const output = Object.create(null) as Record<string, unknown>;
    aliases.set(value, output);
    for (const [key, item] of value.entries()) {
      output[key] = toJsonValue(item, aliases);
    }
    return output;
  }
  if (value instanceof RuntimeCallable) {
    throw new TypeError('Callable values cannot be serialized');
  }
  if (value instanceof RuntimeRegex) {
    return Object.create(null);
  }
  return value;
}

function joinRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  reserveIndexedValues: (count: number) => void,
): RuntimeValue {
  const separatorValue = positional[0];
  const separator = runtimeTruthy(separatorValue) ? runtimeToString(separatorValue) : '';
  const attribute = optionalDirectAttributeKey(positional[1]);
  const output: string[] = [];
  if (attribute === undefined) {
    const values = requireRuntimeArray(input, 'join');
    output.length = values.length;
    for (let index = 0; index < values.length; index += 1) {
      if (!values.has(index)) {
        continue;
      }
      const item = values.at(index);
      defineOwnArrayIndex(
        output,
        index,
        item === undefined || item === null ? '' : runtimeToString(item),
      );
    }
  } else {
    const projection = projectRuntimeAttributeValues(
      input,
      attribute,
      reserveIndexedValues,
    );
    output.length = projection.length;
    for (let offset = 0; offset < projection.values.length; offset += 1) {
      const item = projection.values[offset];
      defineOwnArrayIndex(
        output,
        projection.indices?.[offset] ?? offset,
        item === undefined || item === null ? '' : runtimeToString(item),
      );
    }
  }
  return output.join(separator);
}

function sumRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  reserveIndexedValues: (count: number) => void,
): RuntimeValue {
  const attribute = optionalDirectAttributeKey(positional[0]);
  let reduced: RuntimeValue = 0;
  if (attribute === undefined) {
    const values = requireRuntimeArray(input, 'sum');
    for (const value of values.presentValues()) {
      reduced = runtimeAdd(reduced, value);
    }
  } else {
    const projection = projectRuntimeAttributeValues(
      input,
      attribute,
      reserveIndexedValues,
    );
    for (let index = 0; index < projection.values.length; index += 1) {
      reduced = runtimeAdd(reduced, projection.values[index]);
    }
  }
  return runtimeAdd(positional[1] === undefined ? 0 : positional[1], reduced);
}

function requireRuntimeArray(input: RuntimeValue, operation: string): RuntimeArray {
  if (!(input instanceof RuntimeArray)) {
    throw new TypeError(`${operation} requires an array`);
  }
  return input;
}

/** One complete attribute projection retained only for the current built-in call. */
interface RuntimeAttributeProjection {
  readonly length: number;
  readonly indices?: readonly number[];
  readonly values: readonly RuntimeValue[];
}

/** Creates transient indexed storage that cannot observe inherited setters. */
function createTransientArray<T>(): T[] {
  return Object.setPrototypeOf([], null) as T[];
}

function projectRuntimeAttributeValues(
  input: RuntimeValue,
  attribute: string,
  reserveIndexedValues: (count: number) => void,
): RuntimeAttributeProjection {
  if (input instanceof RuntimeArray) {
    const indices = createTransientArray<number>();
    const values = createTransientArray<RuntimeValue>();
    let offset = 0;
    for (let index = 0; index < input.length; index += 1) {
      if (input.has(index)) {
        indices[offset] = index;
        values[offset] = lookupRuntimeAttribute(input.at(index), attribute);
        offset += 1;
      }
    }
    return { indices, length: input.length, values };
  }
  if (typeof input === 'string') {
    const values = createTransientArray<RuntimeValue>();
    values.length = input.length;
    for (let index = 0; index < input.length; index += 1) {
      values[index] = lookupRuntimeAttribute(input[index], attribute);
    }
    return { length: input.length, values };
  }
  if (input instanceof RuntimeRecord) {
    const values = mapRuntimeRecordValues(input, reserveIndexedValues);
    for (let index = 0; index < values.length; index += 1) {
      defineOwnArrayIndex(
        values,
        index,
        lookupRuntimeAttribute(values[index], attribute),
      );
    }
    return { length: values.length, values };
  }
  if (input instanceof RuntimeSafeString && input.value.length > 0) {
    lookupRuntimeAttribute(undefined, attribute);
  }
  return { length: 0, values: [] };
}

function sortRuntimeValues(
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
  keyword: ReadonlyMap<string, RuntimeValue>,
  reserveIndexedValues: (count: number) => void,
): RuntimeValue {
  const values = input instanceof RuntimeRecord
    ? mapRuntimeRecordValues(input, reserveIndexedValues)
    : input instanceof RuntimeArray
      ? input.copySparse()
      : runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeArray([]);
  }
  const reverse = runtimeTruthy(keywordArgument(keyword, 'reverse', positional, 0));
  const caseSensitive = runtimeTruthy(keywordArgument(keyword, 'case_sensitive', positional, 1));
  const attribute = getterAttributePath(
    keywordArgument(keyword, 'attribute', positional, 2),
  );
  values.sort((left, right) => {
    const leftValue = lookupRuntimeAttributePath(left, attribute);
    const rightValue = lookupRuntimeAttributePath(right, attribute);
    return compareRuntimeSortValues(leftValue, rightValue, caseSensitive, reverse);
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
  const attribute = directAttributeKey(positional[0]);
  const output: RuntimeValue[] = [];
  for (const value of input.presentValues()) {
    const matches = runtimeTruthy(lookupRuntimeAttribute(value, attribute));
    if (matches === select) {
      output.push(value);
    }
  }
  return new RuntimeArray(output);
}

function optionalDirectAttributeKey(value: RuntimeValue): string | undefined {
  if (!runtimeTruthy(value)) {
    return undefined;
  }
  return directAttributeKey(value);
}

function directAttributeKey(value: RuntimeValue): string {
  const key = runtimeToPropertyKey(value);
  assertAllowedAttributeKey(key);
  return key;
}

function getterAttributePath(value: RuntimeValue): readonly string[] {
  if (!runtimeTruthy(value)) {
    return [];
  }
  const path = typeof value === 'string'
    ? value.split('.')
    : [runtimeToPropertyKey(value)];
  for (const segment of path) {
    assertAllowedAttributeKey(segment);
  }
  return path;
}

function assertAllowedAttributeKey(key: string): void {
  if (isReservedName(key)) {
    throw new TypeError(`Template attribute ${key} is reserved`);
  }
}

function lookupRuntimeAttribute(value: RuntimeValue, key: string): RuntimeValue {
  if (value === undefined || value === null) {
    throw new TypeError('Cannot read a template attribute from a nullish value');
  }
  return readRuntimeOwnValue(value, key);
}

function lookupRuntimeAttributePath(
  value: RuntimeValue,
  path: readonly string[],
): RuntimeValue {
  let current = value;
  for (const segment of path) {
    if (current === undefined || current === null) {
      throw new TypeError('Cannot read a template attribute from a nullish value');
    }
    if (!hasRuntimeOwnValue(current, segment)) {
      return undefined;
    }
    current = readRuntimeOwnValue(current, segment);
  }
  return current;
}

function compareRuntimeSortValues(
  left: RuntimeValue,
  right: RuntimeValue,
  caseSensitive: boolean,
  reverse: boolean,
): number {
  let normalizedLeft = left;
  let normalizedRight = right;
  if (!caseSensitive && isRuntimeString(left) && isRuntimeString(right)) {
    normalizedLeft = runtimeText(left).toLowerCase();
    normalizedRight = runtimeText(right).toLowerCase();
  }
  const order = runtimeOrder(normalizedLeft, normalizedRight);
  if (order < 0) {
    return reverse ? 1 : -1;
  }
  if (order > 0) {
    return reverse ? -1 : 1;
  }
  return 0;
}

function compareRuntimeDictsortValues(
  left: RuntimeValue,
  right: RuntimeValue,
  caseSensitive: boolean,
): number {
  const normalizedLeft = !caseSensitive && isRuntimeString(left)
    ? runtimeText(left).toUpperCase()
    : left;
  const normalizedRight = !caseSensitive && isRuntimeString(right)
    ? runtimeText(right).toUpperCase()
    : right;
  if (runtimeOrder(normalizedLeft, normalizedRight) > 0) {
    return 1;
  }
  return runtimeStrictEqual(normalizedLeft, normalizedRight) ? 0 : -1;
}

function isRuntimeString(value: RuntimeValue): value is string | RuntimeSafeString {
  return typeof value === 'string' || value instanceof RuntimeSafeString;
}

function groupRuntimeValues(
  input: RuntimeValue,
  attribute: RuntimeValue,
  reserveIndexedValues: (count: number) => void,
): RuntimeValue {
  if (input === undefined || input === null) {
    throw new TypeError('groupby requires a sequence');
  }
  const values = input instanceof RuntimeRecord
    ? indexedRuntimeRecordValues(input, reserveIndexedValues)
    : runtimeSequenceValues(input);
  if (!values) {
    return new RuntimeRecord([]);
  }
  const path = getterAttributePath(attribute);
  const grouped = new Map<string, RuntimeValue[]>();
  for (const value of values) {
    const key = lookupRuntimeAttributePath(value, path);
    const renderedKey = runtimeToPropertyKey(key);
    if (isReservedName(renderedKey)) {
      throw new TypeError(`Template record key ${renderedKey} is reserved`);
    }
    const values = grouped.get(renderedKey) ?? [];
    values.push(value);
    grouped.set(renderedKey, values);
  }
  const entries: Array<readonly [string, RuntimeValue]> = [];
  for (const [key, values] of grouped) {
    entries.push([key, new RuntimeArray(values)]);
  }
  return new RuntimeRecord(entries);
}

function indexedRuntimeRecordValues(
  input: RuntimeRecord,
  reserveIndexedValues: (count: number) => void,
): RuntimeValue[] {
  const count = indexedComparisonCount(input.get('length'));
  reserveIndexedValues(count);
  const values: RuntimeValue[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(input.get(`${index}`));
  }
  return values;
}

function mapRuntimeRecordValues(
  input: RuntimeRecord,
  reserveIndexedValues: (count: number) => void,
): RuntimeValue[] {
  const length = input.get('length');
  if (typeof length === 'number' && !Number.isNaN(length)) {
    if (!Number.isInteger(length) || length < 0 || length > 0xffff_ffff) {
      throw new RangeError('Invalid array-like record length');
    }
  }
  return indexedRuntimeRecordValues(input, reserveIndexedValues);
}

function sliceRuntimeRecordValues(
  input: RuntimeRecord,
  reserveIndexedValues: (count: number) => void,
): RuntimeValue[] {
  const count = arrayLikeToLength(input.get('length'));
  reserveIndexedValues(count);
  const values: RuntimeValue[] = [];
  for (let index = 0; index < count; index += 1) {
    const key = `${index}`;
    if (input.has(key)) {
      values.push(input.get(key));
    }
  }
  return values;
}

function indexedComparisonCount(value: RuntimeValue): number {
  const length = runtimeToNumber(value);
  if (Number.isNaN(length) || length <= 0) {
    return 0;
  }
  return Number.isFinite(length) ? Math.ceil(length) : length;
}

function arrayLikeToLength(value: RuntimeValue): number {
  const length = runtimeToNumber(value);
  if (Number.isNaN(length) || length <= 0) {
    return 0;
  }
  if (!Number.isFinite(length)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.min(Math.floor(length), Number.MAX_SAFE_INTEGER);
}

/** Applies one closed built-in test. */
export function applyBuiltinTest(
  name: string,
  input: RuntimeValue,
  positional: readonly RuntimeValue[],
): boolean | undefined {
  if (!hasBuiltinTest(name)) {
    return undefined;
  }
  assertBuiltinTestArity(name, positional.length);
  if (
    name !== 'callable' &&
    name !== 'eq' &&
    name !== 'equalto' &&
    name !== 'sameas' &&
    name !== 'ne'
  ) {
    assertRuntimeValueHasNoCallable(input);
    for (const value of positional) {
      assertRuntimeValueHasNoCallable(value);
    }
  }
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

function assertBuiltinTestArity(name: string, actual: number): void {
  const expected = builtinTestArity(name);
  if (expected === undefined) {
    throw new Error(`Unknown template test ${name}`);
  }
  if (actual !== expected) {
    throw new TypeError(
      `Template test ${name} requires ${expected} positional argument${expected === 1 ? '' : 's'}`,
    );
  }
}

/** Resolves one explicit own lookup over a closed value. */
export function lookupRuntimeValue(
  target: RuntimeValue,
  key: RuntimeValue,
): RuntimeValue | undefined {
  const propertyKey = runtimeToPropertyKey(key);
  return readRuntimeOwnValue(target, propertyKey);
}

function hasRuntimeOwnValue(target: RuntimeValue, propertyKey: string): boolean {
  if (target instanceof RuntimeRecord) {
    return target.has(propertyKey);
  }
  if (target instanceof RuntimeArray) {
    return propertyKey === 'length' ||
      runtimeArrayIndexFromPropertyKey(propertyKey, target.length) !== undefined;
  }
  if (typeof target === 'string') {
    const text = target;
    return propertyKey === 'length' ||
      runtimeArrayIndexFromPropertyKey(propertyKey, text.length) !== undefined;
  }
  if (target instanceof RuntimeSafeString) {
    return propertyKey === 'val' ||
      propertyKey === 'length' ||
      runtimeArrayIndexFromPropertyKey(propertyKey, target.value.length) !== undefined;
  }
  return false;
}

function readRuntimeOwnValue(
  target: RuntimeValue,
  propertyKey: string,
): RuntimeValue {
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
  if (typeof target === 'string') {
    const text = target;
    if (propertyKey === 'length') {
      return text.length;
    }
    const index = runtimeArrayIndexFromPropertyKey(propertyKey, text.length);
    return index === undefined ? undefined : text[index];
  }
  if (target instanceof RuntimeSafeString) {
    if (propertyKey === 'val') {
      return target.value;
    }
    if (propertyKey === 'length') {
      return target.value.length;
    }
    const index = runtimeArrayIndexFromPropertyKey(propertyKey, target.value.length);
    return index === undefined ? undefined : target.value[index];
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
