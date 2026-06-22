import { types } from 'node:util';

const runtimeEvaluationErrors = new WeakSet<object>();

/** Stable internal category for one expected evaluator failure. */
export type RuntimeEvaluationErrorCode = 'evaluation_error' | 'capability_error';

/** Engine-owned evaluator failure containing no original thrown value. */
export class RuntimeEvaluationError extends Error {
  /** Stable internal evaluator failure category. */
  readonly code: RuntimeEvaluationErrorCode;
  /** Zero-based template line when known. */
  readonly line: number | undefined;
  /** Zero-based template column when known. */
  readonly column: number | undefined;

  /** Creates one cause-free internal evaluator diagnostic. */
  constructor(
    code: RuntimeEvaluationErrorCode,
    message: string,
    line?: number,
    column?: number,
  ) {
    super(message);
    this.name = 'RuntimeEvaluationError';
    this.code = code;
    this.line = line;
    this.column = column;
    runtimeEvaluationErrors.add(this);
  }

  /** Adds the deepest available zero-based template location. */
  withLocation(line: number, column: number): RuntimeEvaluationError {
    return this.line === undefined
      ? new RuntimeEvaluationError(this.code, this.message, line, column)
      : this;
  }

  /** Converts an unknown internal failure without retaining it. */
  static from(error: unknown, line: number, column: number): RuntimeEvaluationError {
    if (RuntimeEvaluationError.is(error)) {
      return error.withLocation(line, column);
    }
    return new RuntimeEvaluationError(
      'evaluation_error',
      extractNativeErrorMessage(error) ?? 'Template evaluation failed',
      line,
      column,
    );
  }

  /** Checks the private engine-owned error brand without invoking object behavior. */
  static is(error: unknown): error is RuntimeEvaluationError {
    return typeof error === 'object' && error !== null && runtimeEvaluationErrors.has(error);
  }
}

function extractNativeErrorMessage(error: unknown): string | undefined {
  if (!types.isNativeError(error)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}
