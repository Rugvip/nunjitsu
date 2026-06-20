import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import nunjucks from 'nunjucks';

import {
  createEngine,
  memoryLoader,
  type EngineOptions,
  type TemplateValue,
} from '../src/index.ts';
import {
  benchmarkWorkloads,
  type BenchmarkCaseId,
  type BenchmarkWorkload,
} from './cases.ts';

/** Engine implementation measured in an isolated process. */
type Implementation = 'nunjitsu' | 'nunjucks';

/** Validated public benchmark command options. */
interface BenchmarkOptions {
  warmup: number;
  iterations: number;
  cases: readonly BenchmarkCaseId[];
  json: boolean;
}

/** Uniform render lifecycle used by each implementation adapter. */
interface BenchmarkRunner {
  render(): Promise<string>;
  dispose(): Promise<void>;
}

/** Raw measurements and output returned by an isolated worker process. */
interface WorkerResult {
  implementation: Implementation;
  caseId: BenchmarkCaseId;
  description: string;
  setupMs: number;
  samplesMs: number[];
  output: string;
  outputBytes: number;
  retainedRssBytes: number;
  peakRssBytes: number;
}

/** Serializable statistics retained in human and JSON reports. */
interface ReportResult extends Omit<WorkerResult, 'output' | 'samplesMs'> {
  medianMs: number;
  p95Ms: number;
  meanMs: number;
  operationsPerSecond: number;
}

/** Complete benchmark report with runtime provenance. */
interface BenchmarkReport {
  generatedAt: string;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
    parallelism: number;
    warmup: number;
    iterations: number;
  };
  results: ReportResult[];
  comparisons: Array<{
    caseId: BenchmarkCaseId;
    medianRatio: number;
  }>;
}

/** Missing DefinitelyTyped surface present in Nunjucks 3.2.4. */
interface NunjucksEnvironmentWithTests extends nunjucks.Environment {
  addTest(name: string, callback: (...arguments_: unknown[]) => boolean): nunjucks.Environment;
}

const implementationValues: readonly Implementation[] = ['nunjitsu', 'nunjucks'];
const scriptPath = fileURLToPath(import.meta.url);

async function runBenchmarks(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const workerResults: WorkerResult[] = [];
  for (const caseId of options.cases) {
    const pair: WorkerResult[] = [];
    for (const implementation of implementationValues) {
      pair.push(await runInSubprocess(implementation, caseId, options));
    }
    if (pair[0]?.output !== pair[1]?.output) {
      throw new Error(`Output mismatch for benchmark case ${caseId}`);
    }
    workerResults.push(...pair);
  }

  const results = workerResults.map(summarizeResult);
  const comparisons = options.cases.map(caseId => {
    const nunjitsuResult = results.find(
      result => result.caseId === caseId && result.implementation === 'nunjitsu',
    );
    const nunjucksResult = results.find(
      result => result.caseId === caseId && result.implementation === 'nunjucks',
    );
    if (!nunjitsuResult || !nunjucksResult) {
      throw new Error(`Missing benchmark result for ${caseId}`);
    }
    return {
      caseId,
      medianRatio: nunjitsuResult.medianMs / nunjucksResult.medianMs,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      parallelism: availableParallelism(),
      warmup: options.warmup,
      iterations: options.iterations,
    },
    results,
    comparisons,
  };
}

async function runInSubprocess(
  implementation: Implementation,
  caseId: BenchmarkCaseId,
  options: BenchmarkOptions,
): Promise<WorkerResult> {
  return await new Promise<WorkerResult>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--expose-gc',
      scriptPath,
      '--worker',
      `--implementation=${implementation}`,
      `--case=${caseId}`,
      `--warmup=${options.warmup}`,
      `--iterations=${options.iterations}`,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(
          `${implementation} benchmark worker for ${caseId} exited with ${code}: ${stderr.trim()}`,
        ));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerResult);
      } catch (error) {
        reject(new Error(`Invalid benchmark worker output for ${caseId}`, { cause: error }));
      }
    });
  });
}

async function runWorker(
  implementation: Implementation,
  caseId: BenchmarkCaseId,
  options: Pick<BenchmarkOptions, 'warmup' | 'iterations'>,
): Promise<WorkerResult> {
  const workload = benchmarkWorkloads.find(candidate => candidate.id === caseId);
  if (!workload) {
    throw new Error(`Unknown benchmark case: ${caseId}`);
  }
  await collectGarbage();
  const initialRss = process.memoryUsage.rss();
  const setupStart = performance.now();
  const runner = implementation === 'nunjitsu'
    ? await createNunjitsuRunner(workload)
    : createNunjucksRunner(workload);
  const setupMs = performance.now() - setupStart;

  try {
    let output: string | undefined;
    for (let index = 0; index < options.warmup; index += 1) {
      output = verifyStableOutput(output, await runner.render(), workload.id);
    }
    const samplesMs: number[] = [];
    for (let index = 0; index < options.iterations; index += 1) {
      const start = performance.now();
      const rendered = await runner.render();
      samplesMs.push(performance.now() - start);
      output = verifyStableOutput(output, rendered, workload.id);
    }
    if (output === undefined) {
      output = await runner.render();
    }
    await collectGarbage();
    return {
      implementation,
      caseId,
      description: workload.description,
      setupMs,
      samplesMs,
      output,
      outputBytes: Buffer.byteLength(output),
      retainedRssBytes: process.memoryUsage.rss() - initialRss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
  } finally {
    await runner.dispose();
  }
}

async function createNunjitsuRunner(workload: BenchmarkWorkload): Promise<BenchmarkRunner> {
  const options: EngineOptions = {
    autoescape: false,
    workerPool: { minWorkers: 1, maxWorkers: 1 },
    ...(workload.template.type === 'named'
      ? { loaders: [memoryLoader(workload.template.files)] }
      : {}),
    ...(workload.capabilities ? createNunjitsuCapabilities() : {}),
  };
  const engine = await createEngine(options);
  return {
    async render() {
      return await engine.render(
        workload.template.type === 'named'
          ? { name: workload.template.name }
          : { source: workload.template.source },
        workload.context,
      );
    },
    async dispose() {
      await engine.dispose();
    },
  };
}

function createNunjucksRunner(workload: BenchmarkWorkload): BenchmarkRunner {
  const loader = workload.template.type === 'named'
    ? new BenchmarkNunjucksLoader(workload.template.files)
    : null;
  const environment = new nunjucks.Environment(loader, {
    autoescape: false,
    noCache: true,
  });
  if (workload.capabilities) {
    configureNunjucksCapabilities(environment as NunjucksEnvironmentWithTests);
  }
  return {
    async render() {
      return await new Promise<string>((resolve, reject) => {
        const callback: nunjucks.TemplateCallback<string> = (error, result) => {
          if (error) {
            reject(error);
          } else if (result === null) {
            reject(new Error('Nunjucks returned no benchmark output'));
          } else {
            resolve(result);
          }
        };
        if (workload.template.type === 'named') {
          environment.render(workload.template.name, workload.context, callback);
        } else {
          environment.renderString(workload.template.source, workload.context, callback);
        }
      });
    },
    async dispose() {},
  };
}

class BenchmarkNunjucksLoader extends nunjucks.Loader {
  readonly async = false;
  readonly #files: Readonly<Record<string, string>>;

  constructor(files: Readonly<Record<string, string>>) {
    super();
    this.#files = files;
  }

  getSource(name: string): nunjucks.LoaderSource {
    const source = this.#files[name];
    if (source === undefined) {
      throw new Error(`Benchmark template not found: ${name}`);
    }
    return { src: source, path: name, noCache: true };
  }
}

function createNunjitsuCapabilities(): Pick<EngineOptions, 'filters' | 'tests' | 'globals'> {
  return {
    filters: {
      hostOffset(input, arguments_) {
        return numberValue(input) + numberValue(arguments_[0]);
      },
      async asyncScale(input, arguments_) {
        return await defer(numberValue(input) * numberValue(arguments_[0]));
      },
      hostWrap(input, arguments_) {
        return `${stringValue(arguments_[0])}${stringValue(input)}${stringValue(arguments_[1])}`;
      },
      async asyncSuffix(input, arguments_) {
        return await defer(`${stringValue(input)}${stringValue(arguments_[0])}`);
      },
    },
    tests: {
      above(input, arguments_) {
        return numberValue(input) > numberValue(arguments_[0]);
      },
    },
    globals: {
      checksum(arguments_) {
        return checksum(stringValue(arguments_[0]));
      },
      formatRow(arguments_) {
        return `${numberValue(arguments_[0])}:${numberValue(arguments_[1])}:${numberValue(arguments_[2])}`;
      },
    },
  };
}

function configureNunjucksCapabilities(environment: NunjucksEnvironmentWithTests): void {
  environment.addFilter('hostOffset', (input: number, offset: number) => input + offset);
  environment.addFilter(
    'asyncScale',
    (input: number, factor: number, callback: (error: Error | null, result: number) => void) => {
      queueMicrotask(() => callback(null, input * factor));
    },
    true,
  );
  environment.addFilter(
    'hostWrap',
    (input: string, left: string, right: string) => `${left}${input}${right}`,
  );
  environment.addFilter(
    'asyncSuffix',
    (input: string, suffix: string, callback: (error: Error | null, result: string) => void) => {
      queueMicrotask(() => callback(null, `${input}${suffix}`));
    },
    true,
  );
  environment.addTest('above', (input, minimum) => Number(input) > Number(minimum));
  environment.addGlobal('checksum', (value: string) => checksum(value));
  environment.addGlobal(
    'formatRow',
    (index: number, value: number, valueChecksum: number) => `${index}:${value}:${valueChecksum}`,
  );
}

function checksum(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result + value.charCodeAt(index) * (index + 1)) % 65_521;
  }
  return result;
}

function numberValue(value: TemplateValue | undefined): number {
  if (typeof value !== 'number') {
    throw new TypeError(`Expected benchmark number, received ${typeof value}`);
  }
  return value;
}

function stringValue(value: TemplateValue | undefined): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected benchmark string, received ${typeof value}`);
  }
  return value;
}

async function defer<T>(value: T): Promise<T> {
  return await new Promise(resolve => queueMicrotask(() => resolve(value)));
}

function verifyStableOutput(
  previous: string | undefined,
  current: string,
  caseId: BenchmarkCaseId,
): string {
  if (previous !== undefined && previous !== current) {
    throw new Error(`Benchmark output changed between iterations for ${caseId}`);
  }
  return current;
}

function summarizeResult(result: WorkerResult): ReportResult {
  const sorted = [...result.samplesMs].sort((left, right) => left - right);
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    implementation: result.implementation,
    caseId: result.caseId,
    description: result.description,
    setupMs: result.setupMs,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    meanMs,
    operationsPerSecond: 1_000 / meanMs,
    outputBytes: result.outputBytes,
    retainedRssBytes: result.retainedRssBytes,
    peakRssBytes: result.peakRssBytes,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error('Benchmark requires at least one measured iteration');
  }
  return value;
}

function formatReport(report: BenchmarkReport): string {
  const lines = [
    `Nunjitsu benchmark against Nunjucks 3.2.4`,
    [
      `Node ${report.runtime.node} on ${report.runtime.platform}/${report.runtime.architecture};`,
      `${report.runtime.parallelism} logical CPUs`,
    ].join(' '),
    `${report.runtime.warmup} warmup and ${report.runtime.iterations} measured one-shot renders per result`,
    '',
    '| case | engine | setup | median | p95 | renders/s | retained RSS | peak RSS | output |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of report.results) {
    lines.push(`| ${[
      result.caseId,
      result.implementation,
      `${formatMilliseconds(result.setupMs)}`,
      `${formatMilliseconds(result.medianMs)}`,
      `${formatMilliseconds(result.p95Ms)}`,
      result.operationsPerSecond.toFixed(2),
      formatBytes(result.retainedRssBytes),
      formatBytes(result.peakRssBytes),
      formatBytes(result.outputBytes),
    ].join(' | ')} |`);
  }
  lines.push('', 'Median ratio (Nunjitsu / Nunjucks; lower is better):');
  for (const comparison of report.comparisons) {
    lines.push(`- ${comparison.caseId}: ${comparison.medianRatio.toFixed(2)}x`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function formatMilliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function formatBytes(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute < 1024) {
    return `${value} B`;
  }
  if (absolute < 1024 * 1024) {
    return `${sign}${(absolute / 1024).toFixed(1)} KiB`;
  }
  return `${sign}${(absolute / (1024 * 1024)).toFixed(1)} MiB`;
}

async function collectGarbage(): Promise<void> {
  const garbageCollector = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  garbageCollector?.();
  await new Promise<void>(resolve => setImmediate(resolve));
}

function parseOptions(arguments_: readonly string[]): BenchmarkOptions {
  const warmup = parseNonNegativeInteger(optionValue(arguments_, 'warmup') ?? '3', 'warmup');
  const iterations = parsePositiveInteger(optionValue(arguments_, 'iterations') ?? '15', 'iterations');
  const caseOption = optionValue(arguments_, 'case');
  const cases = caseOption === undefined
    ? benchmarkWorkloads.map(workload => workload.id)
    : caseOption.split(',').map(parseCaseId);
  return {
    warmup,
    iterations,
    cases,
    json: arguments_.includes('--json'),
  };
}

function parseWorkerArguments(arguments_: readonly string[]): (
  Pick<BenchmarkOptions, 'warmup' | 'iterations'> & {
    implementation: Implementation;
    caseId: BenchmarkCaseId;
  }
) | undefined {
  if (!arguments_.includes('--worker')) {
    return undefined;
  }
  const implementation = optionValue(arguments_, 'implementation');
  if (!implementationValues.includes(implementation as Implementation)) {
    throw new Error(`Invalid benchmark implementation: ${implementation ?? ''}`);
  }
  const caseValue = optionValue(arguments_, 'case');
  if (!caseValue) {
    throw new Error('Benchmark worker requires --case');
  }
  return {
    implementation: implementation as Implementation,
    caseId: parseCaseId(caseValue),
    warmup: parseNonNegativeInteger(optionValue(arguments_, 'warmup') ?? '', 'warmup'),
    iterations: parsePositiveInteger(optionValue(arguments_, 'iterations') ?? '', 'iterations'),
  };
}

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return arguments_.find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

function parseCaseId(value: string): BenchmarkCaseId {
  const workload = benchmarkWorkloads.find(candidate => candidate.id === value);
  if (!workload) {
    throw new Error(`Unknown benchmark case: ${value}`);
  }
  return workload.id;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = parseNonNegativeInteger(value, name);
  if (parsed === 0) {
    throw new Error(`--${name} must be greater than zero`);
  }
  return parsed;
}

const workerArguments = parseWorkerArguments(process.argv.slice(2));
if (workerArguments) {
  const result = await runWorker(workerArguments.implementation, workerArguments.caseId, workerArguments);
  process.stdout.write(JSON.stringify(result));
} else {
  const options = parseOptions(process.argv.slice(2));
  const report = await runBenchmarks(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
}
