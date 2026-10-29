/**
 * Feature flags resolved from the environment at startup.
 */
export type FeatureFlags = Record<string, boolean>;

/**
 * Read `PRAG_FEATURE_*` environment variables into a flag map.
 *
 * `PRAG_FEATURE_FAST_PATH=1` becomes `{ fastPath: true }`.
 */
export function readFeatureFlags(env: Record<string, string | undefined>): FeatureFlags {
  const flags: FeatureFlags = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("PRAG_FEATURE_")) {
      continue;
    }
    const name = key
      .slice("PRAG_FEATURE_".length)
      .toLowerCase()
      .replace(/_(.)/g, (_, c: string) => c.toUpperCase());
    flags[name] = value === "1" || value?.toLowerCase() === "true";
  }
  return flags;
}
