import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const targetNames = Object.freeze(['parser', 'render']);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    maxLength: { type: 'string' },
    mode: { type: 'string' },
    seconds: { type: 'string' },
    timeout: { type: 'string' },
  },
});
const mode = values.mode ?? 'fuzzing';
if (mode !== 'fuzzing' && mode !== 'regression') {
  throw new Error('Fuzz target mode must be fuzzing or regression');
}

const selectedTargets = positionals.length === 0 ? targetNames : positionals;
for (const target of selectedTargets) {
  if (!targetNames.includes(target)) {
    throw new Error(`Unknown fuzz target ${target}`);
  }
}

const seconds = positiveInteger(values.seconds ?? '30', 'seconds');
const timeout = positiveInteger(values.timeout ?? '1000', 'timeout');
const maxLength = positiveInteger(values.maxLength ?? '8192', 'maxLength');
const jazzer = fileURLToPath(new URL(
  process.platform === 'win32' ? '../node_modules/.bin/jazzer.cmd' : '../node_modules/.bin/jazzer',
  import.meta.url,
));

for (const target of selectedTargets) {
  await runTarget(target);
}

function positiveInteger(rawValue, name) {
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function runTarget(target) {
  const args = [
    `./.fuzz/targets/${target}.fuzz.js`,
    `./.fuzz/corpus/${target}`,
    '--sync',
    `--mode=${mode}`,
    `--timeout=${timeout}`,
  ];
  if (mode === 'fuzzing') {
    args.push(
      '--',
      `-max_total_time=${seconds}`,
      `-max_len=${maxLength}`,
      '-dict=fuzz/template.dict',
    );
  }

  await new Promise((resolve, reject) => {
    const child = spawn(jazzer, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Fuzz target ${target} exited with signal ${signal}`));
      } else if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`Fuzz target ${target} exited with code ${code}`));
      }
    });
  });
}
