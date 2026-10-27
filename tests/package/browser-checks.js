import { createTemplateRenderer, TemplateLimitError, TemplateRenderError } from 'nunjitsu';

assert.equal(typeof process, 'undefined');
assert.equal(typeof Buffer, 'undefined');
assert.equal(typeof require, 'undefined');
Math.random = () => { throw new Error('must use cryptographic randomness'); };

const engine = createTemplateRenderer({ cookiecutterCompat: true, allowRegexExecution: true });
for (const entry of JSON.parse(corpusJson)) {
  assert.equal(engine.render(entry.template, entry.context), entry.expected, entry.id);
}
for (const cookiecutterCompat of [false, true]) {
  const renderer = createTemplateRenderer({ cookiecutterCompat, allowRegexExecution: true });
  for (const entry of JSON.parse(intrinsicJson)) {
    if (!(entry.modes?.includes(cookiecutterCompat ? 'cookiecutter' : 'default') ?? true)) {
      continue;
    }
    const source = cookiecutterCompat ? entry.template : entry.template.replaceAll('{{', '${{');
    assert.equal(renderer.render(source, entry.context), entry.expected, entry.id);
  }
}

let laterCalls = 0;
const renderer = createTemplateRenderer({
  filters: {
    'tools.identity'(value) { return value; },
  },
  globals: {
    later() { laterCalls += 1; return 'later'; },
    fail() { throw new Error('host detail'); },
    trap() {
      throw new Proxy({}, {
        get() { throw new Error('must not inspect exception'); },
        getPrototypeOf() { throw new Error('must not inspect exception'); },
      });
    },
  },
});
assert.equal(renderer.render('${{ "ok" | tools.identity }}'), 'ok');
assert.equal(renderer.render('${{ ["only"] | random }}'), 'only');
assert.ok(['a', 'b', 'c'].includes(renderer.render('${{ ["a", "b", "c"] | random }}')));
assert.equal(renderer.renderValue('${{ value }}', { value: 42 }), 42);
assert.equal(renderer.renderValue('{% if true %}false{% endif %}', {}, { coercion: 'json' }), false);
assert.equal(renderer.renderValue('{% if true %}not JSON{% endif %}', {}, { coercion: 'json' }), 'not JSON');
const value = { map: new Map([['one', 1]]), set: new Set(['two']) };
const copied = renderer.renderValue('${{ value }}', { value });
assert.equal(Object.getPrototypeOf(copied), null);
assert.ok(Object.isFrozen(copied));
assert.equal(copied.map.get('one'), 1);
assert.ok(copied.set.has('two'));
assert.notEqual(copied.map, value.map);
assert.notEqual(copied.set, value.set);
const prepared = renderer.prepareContext({ items: [1] });
assert.equal(renderer.render('${{ items.push(2) }}${{ items | length }}', prepared), '22');
assert.equal(renderer.render('${{ items | length }}', prepared), '1');
assert.equal(renderer.render('${{ user.name }}', prepared.withValue(['user', 'name'], 'browser')), 'browser');
let traps = 0;
assert.equal(renderer.render('${{ value }}', { value: new Proxy({ value: 'copied' }, {
  ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
}) }), '[object Object]');
assert.ok(traps > 0);
let getterCalls = 0;
assert.throws(() => renderer.render('${{ value }}', {
  get value() { getterCalls += 1; return 1; },
}));
assert.equal(getterCalls, 0);
for (const source of [
  '${{ fail() }}${{ later() }}',
  '${{ trap() }}${{ later() }}',
  '${{ value.constructor() }}${{ later() }}',
  '${{ Proxy() }}${{ later() }}',
  '${{ later() }}{% if %}',
]) {
  assert.throws(() => renderer.render(source, { value: {} }), TemplateRenderError);
  assert.equal(laterCalls, 0);
  assert.equal(renderer.render('clean'), 'clean');
}
assert.throws(() => renderer.render('${{ "large" }}', {}, {
  limits: { outputCodeUnits: 2 },
}), TemplateLimitError);
assert.equal(renderer.render('clean'), 'clean');

assert.throws(() => renderer.render('${{ fail() }}'), error => {
  assert.equal(error.message.includes('host detail'), typeof Error.isError === 'function');
  assert.equal(error.cause, undefined);
  return true;
});

for (const [source, minimum] of [
  ['${{ value | tools.identity }}', 3],
  ['${{ value.startsWith("x") }}', 6],
]) {
  assert.throws(() => renderer.render(source + '${{ later() }}', { value: 'x' }, {
    limits: { scratchBytes: minimum - 1 },
  }), error => {
    assert.ok(error instanceof TemplateLimitError);
    assert.equal(error.limit, 'scratchBytes');
    return true;
  });
  assert.equal(laterCalls, 0);
  assert.equal(typeof renderer.render(source, { value: 'x' }, {
    limits: { scratchBytes: minimum },
  }), 'string');
  assert.equal(renderer.render('clean'), 'clean');
}
