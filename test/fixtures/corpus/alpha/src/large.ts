export interface RawConfig {
  [key: string]: unknown;
}

export interface NormalisedConfig {
  name: string;
  root: string;
  include: string[];
  exclude: string[];
  concurrency: number;
  chunkTokens: number;
  overlapTokens: number;
  embedModel: string;
  batchSize: number;
  watch: boolean;
  followSymlinks: boolean;
  maxFileBytes: number;
  logLevel: "silent" | "error" | "warn" | "info" | "debug";
  warnings: string[];
}

/**
 * Validate and normalise a user-supplied configuration object into the shape
 * the indexer expects.
 *
 * Every field is checked individually so that a single bad key produces a
 * message naming that key, rather than a generic "invalid config". Recoverable
 * problems (an out-of-range number, a deprecated alias) are clamped or
 * rewritten and recorded in `warnings`; unrecoverable ones throw.
 *
 * This is deliberately one long function: the fixture it belongs to exists to
 * prove that a single AST node larger than the chunk budget is split into
 * several overlapping vectorised units under one chunk hash.
 */
export function normaliseConfig(raw: RawConfig): NormalisedConfig {
  const warnings: string[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("config must be a plain object");
  }

  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("config.name must be a non-empty string");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new TypeError(
      `config.name ${JSON.stringify(name)} may only contain letters, digits, dot, dash and underscore`,
    );
  }

  const rootValue = raw.root ?? raw.path;
  if (raw.path !== undefined) {
    warnings.push("config.path is deprecated; use config.root");
  }
  if (typeof rootValue !== "string" || rootValue.length === 0) {
    throw new TypeError("config.root must be a non-empty string");
  }
  const root = rootValue.endsWith("/") && rootValue !== "/" ? rootValue.slice(0, -1) : rootValue;

  const toPatternList = (value: unknown, key: string): string[] => {
    if (value === undefined || value === null) {
      return [];
    }
    const list = Array.isArray(value) ? value : [value];
    const patterns: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string") {
        throw new TypeError(`config.${key} must contain only strings`);
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        warnings.push(`config.${key} contained an empty pattern, which was dropped`);
        continue;
      }
      if (trimmed.startsWith("!")) {
        throw new TypeError(
          `config.${key} entry ${JSON.stringify(trimmed)} uses negation; put it in config.exclude instead`,
        );
      }
      if (patterns.includes(trimmed)) {
        warnings.push(`config.${key} contained duplicate pattern ${JSON.stringify(trimmed)}`);
        continue;
      }
      patterns.push(trimmed);
    }
    return patterns;
  };

  const include = toPatternList(raw.include, "include");
  const exclude = toPatternList(raw.exclude, "exclude");
  if (include.length === 0) {
    include.push("**/*");
  }
  for (const pattern of include) {
    if (exclude.includes(pattern)) {
      warnings.push(
        `pattern ${JSON.stringify(pattern)} appears in both include and exclude; exclude wins`,
      );
    }
  }

  const readInteger = (value: unknown, key: string, fallback: number, min: number, max: number): number => {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`config.${key} must be a finite number`);
    }
    if (!Number.isInteger(value)) {
      warnings.push(`config.${key} was rounded from ${value} to ${Math.round(value)}`);
      value = Math.round(value);
    }
    const integer = value as number;
    if (integer < min) {
      warnings.push(`config.${key} raised from ${integer} to the minimum ${min}`);
      return min;
    }
    if (integer > max) {
      warnings.push(`config.${key} lowered from ${integer} to the maximum ${max}`);
      return max;
    }
    return integer;
  };

  const concurrency = readInteger(raw.concurrency, "concurrency", 4, 1, 64);
  const chunkTokens = readInteger(raw.chunkTokens, "chunkTokens", 400, 64, 8192);
  let overlapTokens = readInteger(raw.overlapTokens, "overlapTokens", 60, 0, 4096);
  const batchSize = readInteger(raw.batchSize, "batchSize", 32, 1, 512);
  const maxFileBytes = readInteger(raw.maxFileBytes, "maxFileBytes", 2 * 1024 * 1024, 1024, 256 * 1024 * 1024);

  if (overlapTokens >= chunkTokens) {
    const reduced = Math.floor(chunkTokens / 4);
    warnings.push(
      `config.overlapTokens (${overlapTokens}) must be smaller than chunkTokens (${chunkTokens}); using ${reduced}`,
    );
    overlapTokens = reduced;
  }

  let embedModel: string;
  if (raw.embedModel === undefined) {
    embedModel = "bge-small-en-v1.5";
  } else if (typeof raw.embedModel !== "string" || raw.embedModel.trim().length === 0) {
    throw new TypeError("config.embedModel must be a non-empty string");
  } else {
    embedModel = raw.embedModel.trim();
    if (embedModel.includes(" ")) {
      throw new TypeError("config.embedModel must not contain spaces");
    }
  }

  let watch: boolean;
  if (raw.watch === undefined) {
    watch = true;
  } else if (typeof raw.watch === "boolean") {
    watch = raw.watch;
  } else if (raw.watch === "true" || raw.watch === "false") {
    warnings.push("config.watch was a string; coerced to a boolean");
    watch = raw.watch === "true";
  } else {
    throw new TypeError("config.watch must be a boolean");
  }

  const followSymlinks = raw.followSymlinks === true;
  if (followSymlinks && watch) {
    warnings.push("following symlinks while watching can produce duplicate events");
  }

  const levels = ["silent", "error", "warn", "info", "debug"] as const;
  type Level = (typeof levels)[number];
  let logLevel: Level = "info";
  if (raw.logLevel !== undefined) {
    if (typeof raw.logLevel !== "string") {
      throw new TypeError("config.logLevel must be a string");
    }
    const candidate = raw.logLevel.toLowerCase();
    if (candidate === "verbose" || candidate === "trace") {
      warnings.push(`config.logLevel ${JSON.stringify(raw.logLevel)} mapped to "debug"`);
      logLevel = "debug";
    } else if ((levels as readonly string[]).includes(candidate)) {
      logLevel = candidate as Level;
    } else {
      throw new TypeError(
        `config.logLevel must be one of ${levels.join(", ")}, got ${JSON.stringify(raw.logLevel)}`,
      );
    }
  }

  const known = new Set([
    "name",
    "root",
    "path",
    "include",
    "exclude",
    "concurrency",
    "chunkTokens",
    "overlapTokens",
    "embedModel",
    "batchSize",
    "watch",
    "followSymlinks",
    "maxFileBytes",
    "logLevel",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      warnings.push(`unknown config key ${JSON.stringify(key)} was ignored`);
    }
  }

  return {
    name,
    root,
    include,
    exclude,
    concurrency,
    chunkTokens,
    overlapTokens,
    embedModel,
    batchSize,
    watch,
    followSymlinks,
    maxFileBytes,
    logLevel,
    warnings,
  };
}
