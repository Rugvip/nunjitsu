import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { types } from 'node:util';
import { createContext, runInContext, SourceTextModule } from 'node:vm';

const bundle = await readFile(new URL('../../dist/browser/index.js', import.meta.url), 'utf8');
const corpus = JSON.parse(await readFile(new URL('../compat/cases.json', import.meta.url), 'utf8'));
const intrinsicCases = JSON.parse(await readFile(
  new URL('../compat/intrinsic-method-cases.json', import.meta.url), 'utf8',
));
const checks = await readFile(new URL('./browser-checks.js', import.meta.url), 'utf8');

for (const nativeErrorBranding of [true, false]) {
  const context = createContext({
    assert,
    nativeErrorCheck: nativeErrorBranding ? types.isNativeError : undefined,
    crypto: webcrypto,
    corpusJson: JSON.stringify(corpus.cases),
    intrinsicJson: JSON.stringify(intrinsicCases.cases),
  }, { codeGeneration: { strings: false, wasm: false } });
  runInContext('Error.isError = nativeErrorCheck; delete globalThis.nativeErrorCheck;', context);
  const runtime = new SourceTextModule(bundle, { context });
  await runtime.link(() => { throw new Error('Browser bundle must have no imports'); });
  await runtime.evaluate();
  const testModule = new SourceTextModule(
    checks,
    { context },
  );
  await testModule.link(specifier => {
    assert.equal(specifier, 'nunjitsu');
    return runtime;
  });
  await testModule.evaluate();
}
