import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    profile: { type: 'string' },
  },
});
const profile = values.profile ?? 'thorough';
if (profile !== 'smoke' && profile !== 'thorough') {
  throw new Error('Fuzz property profile must be smoke or thorough');
}

const child = spawn(
  process.execPath,
  ['--test', 'tests/source/fuzz.test.ts'],
  {
    env: {
      ...process.env,
      NUNJITSU_FUZZ_PROFILE: profile,
    },
    stdio: 'inherit',
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
