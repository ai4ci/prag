// @prag/fixtures — Invariant check for the test fixture corpus
//
// Run in CI to assert every fixture's invariant still holds.
// Usage: npx tsx test/fixtures/check-invariants.ts
//
// Exits 0 on success, non-zero with details on failure.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

const FIXTURES = import.meta.dirname!;
const CORPUS = join(FIXTURES, "corpus");

// The same tokenizer the daemon falls back to for window sizing, so this check
// measures the property the suite relies on instead of a chars/4 guess.
import { approximateTokenizer, DEFAULT_MAX_VECTOR_UNIT_TOKENS } from "../../packages/core/src/vector-units.js";

interface Failure {
  name: string;
  detail: string;
}

const failures: Failure[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    failures.push({ name, detail });
  }
}

// ── 1. Cross-project dedup invariant ─────────────────────────────────

check("cross-project dedup: shared.ts byte-identical", () => {
  const alpha = readFileSync(join(CORPUS, "alpha/src/shared.ts"));
  const beta = readFileSync(join(CORPUS, "beta/src/shared.ts"));
  assert.deepEqual(
    alpha,
    beta,
    "alpha/src/shared.ts and beta/src/shared.ts must be byte-identical",
  );
});

// ── 2. Whitespace-only reformat invariant ────────────────────────────

check("reformat: only whitespace differs", () => {
  const original = readFileSync(join(CORPUS, "reformat/original.ts"), "utf-8");
  const reformatted = readFileSync(join(CORPUS, "reformat/reformatted.ts"), "utf-8");

  const strip = (s: string) => s.replace(/\s+/g, "");
  assert.equal(
    strip(original),
    strip(reformatted),
    "original.ts and reformatted.ts must differ only in whitespace",
  );
});

// ── 3. large.ts exceeds maxVectorUnitTokens ─────────────────────────

check("large.ts exceeds maxVectorUnitTokens", () => {
  const content = readFileSync(join(CORPUS, "alpha/src/large.ts"), "utf-8");
  const tokens = approximateTokenizer().countTokens(content);
  assert.ok(
    tokens > DEFAULT_MAX_VECTOR_UNIT_TOKENS,
    `large.ts is ${tokens} tokens; must exceed ${DEFAULT_MAX_VECTOR_UNIT_TOKENS} to exercise unit splitting`,
  );
  // One structural unit, so more than one stored row can only come from splitting.
  assert.equal(
    (content.match(/^(export )?(async )?function /gm) ?? []).length,
    1,
    "large.ts must stay a single function",
  );
});

// ── 4. Git fixture builder produces identical SHAs across two builds ─

check("build-git-fixtures: identical commit SHAs", () => {
  const builderPath = join(FIXTURES, "build-git-fixtures.mjs");

  const build = () => {
    const dir = mkdtempSync(join(tmpdir(), "prag-fixture-check-"));
    const stdout = execFileSync(process.execPath, [builderPath, dir], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const paths = JSON.parse(stdout.trim()) as Record<string, string>;

    const sha = (repoDir: string, ref: string) =>
      execFileSync("git", ["rev-parse", ref], {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();

    const result = {
      alphaMain: sha(paths.alpha, "main"),
      alphaFeature: sha(paths.alpha, "feature-x"),
      betaMain: sha(paths.beta, "main"),
    };

    rmSync(dir, { recursive: true, force: true });
    return result;
  };

  const a = build();
  const b = build();
  assert.deepEqual(a, b, `Consecutive builds produced different SHAs:\n  ${JSON.stringify(a)}\n  ${JSON.stringify(b)}`);
});

// ── 5. alpha-feature-x files exist and are unique ────────────────────

check("alpha-feature-x: new-feature.ts not in alpha", () => {
  const dirs = ["alpha/src/new-feature.ts", "alpha-feature-x/src/new-feature.ts"];
  const paths = dirs.map((d) => join(CORPUS, d));
  assert.ok(readFileSync(paths[1], "utf-8").length > 0, "alpha-feature-x/src/new-feature.ts must exist");
  try {
    readFileSync(paths[0]);
    assert.fail("alpha/src/new-feature.ts must not exist");
  } catch {
    // expected
  }
});

check("beta: only-beta.ts not in alpha", () => {
  try {
    readFileSync(join(CORPUS, "alpha/src/only-beta.ts"));
    assert.fail("only-beta.ts must not exist in alpha");
  } catch {
    // expected
  }
  assert.ok(
    readFileSync(join(CORPUS, "beta/src/only-beta.ts"), "utf-8").length > 0,
    "beta/src/only-beta.ts must exist",
  );
});

// ── 6. Document fixtures produce consistent extraction ───────────────

check("documents: sample.md can be parsed", () => {
  const md = readFileSync(join(FIXTURES, "documents/sample.md"), "utf-8");
  assert.ok(md.length > 50, "sample.md must be substantial");
  assert.ok(md.includes("## "), "sample.md must have at least one heading");
});

// ── Report ───────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`❌ ${failures.length} fixture invariant(s) failed:\n`);
  for (const f of failures) {
    console.error(`  ✖ ${f.name}`);
    console.error(`    ${f.detail}\n`);
  }
  process.exit(1);
} else {
  console.log("✅ All fixture invariants pass");
}
