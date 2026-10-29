/**
 * Arithmetic mean of a sample.
 *
 * @param values - the sample; must not be empty
 * @returns the arithmetic mean
 * @throws RangeError if `values` is empty
 */
export function mean(values: number[]): number {
  if (values.length === 0) {
    throw new RangeError("mean() requires at least one value");
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

/**
 * Unbiased (sample) variance, using Welford's online algorithm so that a long
 * sample does not lose precision to catastrophic cancellation.
 *
 * @param values - the sample; must contain at least two values
 * @returns the sample variance
 * @throws RangeError if fewer than two values are supplied
 */
export function variance(values: number[]): number {
  if (values.length < 2) {
    throw new RangeError("variance() requires at least two values");
  }
  let count = 0;
  let runningMean = 0;
  let sumSquares = 0;
  for (const value of values) {
    count += 1;
    const delta = value - runningMean;
    runningMean += delta / count;
    sumSquares += delta * (value - runningMean);
  }
  return sumSquares / (count - 1);
}

/**
 * Constrain a value to a closed interval.
 *
 * @param value - the value to constrain
 * @param lower - inclusive lower bound
 * @param upper - inclusive upper bound
 * @returns `value` clamped to `[lower, upper]`
 */
export function clamp(value: number, lower: number, upper: number): number {
  if (lower > upper) {
    throw new RangeError(`empty interval [${lower}, ${upper}]`);
  }
  return Math.min(Math.max(value, lower), upper);
}
