/**
 * Retry policy shared by the HTTP and queue clients.
 */
export interface RetryOptions {
  /** Maximum number of attempts, including the first one. */
  attempts: number;
  /** Delay before the second attempt, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound on any single delay, in milliseconds. */
  maxDelayMs: number;
}

const DEFAULTS: RetryOptions = {
  attempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
};

/**
 * Exponential backoff with full jitter, as described in the AWS architecture
 * blog. Jitter matters more than the exponent: it is what stops a fleet of
 * clients retrying in lockstep after a shared outage.
 */
export function backoffDelay(attempt: number, options: Partial<RetryOptions> = {}): number {
  const { baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...options };
  if (attempt < 1) {
    throw new RangeError("attempt is 1-based");
  }
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

/**
 * Run `task` until it resolves or the attempt budget is exhausted.
 *
 * `isRetryable` decides which failures are worth another attempt; the default
 * retries everything, which is only safe for idempotent work.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> & { isRetryable?: (error: unknown) => boolean } = {},
): Promise<T> {
  const { attempts } = { ...DEFAULTS, ...options };
  const isRetryable = options.isRetryable ?? (() => true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) {
        break;
      }
      await sleep(backoffDelay(attempt, options));
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
