/**
 * Format a byte count for humans.
 *
 * Uses binary units (KiB, MiB) because that is what disk tools report.
 */
export function formatBytes(bytes: number, precision: number = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("bytes must be a non-negative finite number");
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  // Whole numbers of bytes read better without a decimal point.
  const digits = index === 0 ? 0 : precision;
  return `${value.toFixed(digits)} ${units[index]}`;
}

/**
 * Inverse of `formatBytes`, tolerant of missing or lower-case units.
 */
export function parseBytes(text: string): number {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B?)\s*$/i.exec(text);
  if (match === null) {
    throw new SyntaxError(`cannot parse ${JSON.stringify(text)} as a byte count`);
  }
  const scale = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const suffix = match[2].replace(/i?b?$/i, "").toUpperCase() as keyof typeof scale;
  return Number(match[1]) * scale[suffix];
}
