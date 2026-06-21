import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import nunjucks from 'nunjucks';

import { createEngine } from '../src/index.ts';
import {
  benchmarkWorkloads,
  type BenchmarkCaseId,
  type BenchmarkWorkload,
} from './cases.ts';

type Implementation = 'nunjitsu' | 'nunjucks';

interface BenchmarkOptions {
  warmup: number;
  iterations: number;
  cases: readonly BenchmarkCaseId[];
  json: boolean;
}

interface BenchmarkRunner {
  render(): string;
}

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

interface ReportResult extends Omit<WorkerResult, 'output' | 'samplesMs'> {
  medianMs: number;
  p95Ms: number;
  meanMs: number;
  operationsPerSecond: number;
}

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
  comparisons: Array<{ caseId: BenchmarkCaseId; medianRatio: number }>;
}

const implementations: readonly Implementation[] = ['nunjitsu', 'nunjucks'];
const scriptPath = fileURLToPath(import.meta.url);

async function runBenchmarks(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const workers: WorkerResult[] = [];
  for (const caseId of options.cases) {
    const pair = await Promise.all(
      implementations.map(implementation => runInSubprocess(implementation, caseId, options)),
    );
    if (pair[0]!.output !== pair[1]!.output) {
      throw new Error(`Output mismatch for benchmark case ${caseId}`);
    }
    workers.push(...pair);
  }

  const results = workers.map(summarizeResult);
  const comparisons = options.cases.map(caseId => {
    const nunjitsu = results.find(result =>
      result.caseId === caseId && result.implementation === 'nunjitsu'
    );
    const nunjucks = results.find(result =>
      result.caseId === caseId && result.implementation === 'nunjucks'
    );
    if (!nunjitsu || !nunjucks) {
      throw new Error(`Missing benchmark result for ${caseId}`);
    }
    return { caseId, medianRatio: nunjitsu.medianMs / nunjucks.medianMs };
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
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
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
        reject(new Error(`Invalid benchmark output for ${caseId}`, { cause: error }));
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
  const runner = createRunner(implementation, workload);
  const setupMs = performance.now() - setupStart;

  let output: string | undefined;
  for (let index = 0; index < options.warmup; index += 1) {
    output = verifyStableOutput(output, runner.render(), workload.id);
  }
  const samplesMs: number[] = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const start = performance.now();
    const rendered = runner.render();
    samplesMs.push(performance.now() - start);
    output = verifyStableOutput(output, rendered, workload.id);
  }
  if (output === undefined) {
    output = runner.render();
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
}

function createRunner(
  implementation: Implementation,
  workload: BenchmarkWorkload,
): BenchmarkRunner {
  if (implementation === 'nunjitsu') {
    const engine = createEngine();
    const context = engine.prepareContext(workload.context);
    return {
      render() {
        return workload.sources
          .map(source => engine.render(source, context))
          .join('');
      },
    };
  }

  const environment = new nunjucks.Environment(null, {
    autoescape: false,
    noCache: true,
    tags: { variableStart: '${{', variableEnd: '}}' },
  });
  return {
    render() {
      return workload.sources
        .map(source => environment.renderString(source, workload.context))
        .join('');
    },
  };
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
  const value = sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  if (value === undefined) {
    throw new Error('Benchmark requires at least one measured iteration');
  }
  return value;
}

function formatReport(report: BenchmarkReport): string {
  const lines = [
    'Nunjitsu benchmark against Nunjucks 3.2.4',
    `Node ${report.runtime.node} on ${report.runtime.platform}/${report.runtime.architecture}; ${report.runtime.parallelism} logical CPUs`,
    `${report.runtime.warmup} warmup and ${report.runtime.iterations} measured operations per result`,
    '',
    '| case | engine | setup | median | p95 | operations/s | retained RSS | peak RSS | output |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of report.results) {
    lines.push(`| ${[
      result.caseId,
      result.implementation,
      formatMilliseconds(result.setupMs),
      formatMilliseconds(result.medianMs),
      formatMilliseconds(result.p95Ms),
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
  return {
    warmup,
    iterations,
    cases: caseOption === undefined
      ? benchmarkWorkloads.map(workload => workload.id)
      : caseOption.split(',').map(parseCaseId),
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
  if (!implementations.includes(implementation as Implementation)) {
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
  const result = await runWorker(
    workerArguments.implementation,
    workerArguments.caseId,
    workerArguments,
  );
  process.stdout.write(JSON.stringify(result));
} else {
  const options = parseOptions(process.argv.slice(2));
  const report = await runBenchmarks(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
}
