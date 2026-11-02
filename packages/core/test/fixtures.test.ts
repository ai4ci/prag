// @prag/core — the fixture corpus keeps the properties the suite depends on
//
// The corpus under test/fixtures/ is hand-maintained, and several tests assert
// against properties of it (shared.ts dedups across projects; large.ts is bigger
// than one vector unit; reformat/ differs only in whitespace). Those assertions
// are only meaningful while the corpus holds still, so the invariant checker runs
// as part of `npm test` rather than only "in CI" — until now nothing executed it
// and a one-sided edit to shared.ts would have broken no build at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { approximateTokenizer, DEFAULT_MAX_VECTOR_UNIT_TOKENS } from "../src/vector-units.js";

const ROOT = join(import.meta.dirname!, "..", "..", "..");
const CORPUS = join(ROOT, "test", "fixtures", "corpus");

function fixtureInvariantSuite(): void {
  void it("check-invariants.ts passes", () => {
    // Spawned rather than imported: it is a standalone script with its own exit
    // code, and the way CI will run it is the way it is checked here.
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "test", "fixtures", "check-invariants.ts")], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      assert.fail(`fixture invariants failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    assert.match(stdout, /All fixture invariants pass/);
  });

  void it("large.ts is one structural unit larger than a vector unit", () => {
    // The property the splitting tests rely on; asserted by check-invariants.ts
    // with the same tokenizer the daemon uses, so it lives there and not twice.
    const content = readFileSync(join(CORPUS, "alpha/src/large.ts"), "utf-8");
    assert.equal(
      (content.match(/^(export )?(async )?function /gm) ?? []).length,
      1,
      "large.ts must stay a single function, or >1 stored row would prove nothing about splitting",
    );
    assert.ok(
      approximateTokenizer().countTokens(content) > DEFAULT_MAX_VECTOR_UNIT_TOKENS,
      "large.ts must exceed one vector unit",
    );
  });

  void it("every fixture the README lists is present and shaped as documented", () => {
    // The README is the corpus's contract; it listed PDF/DOCX/web fixtures that
    // no check looked at. Presence is asserted here, content parity where the
    // format allows it, and the ingestion-side claims stay with their features.
    const listed = [
      "corpus/alpha/src/shared.ts",
      "corpus/alpha/src/stats.R",
      "corpus/alpha/src/large.ts",
      "corpus/alpha/docs/guide.md",
      "corpus/alpha-feature-x/src/new-feature.ts",
      "corpus/beta/src/only-beta.ts",
      "corpus/plain/notes.md",
      "corpus/reformat/original.ts",
      "documents/sample.md",
      "documents/sample.pdf",
      "documents/sample.docx",
      "web/firecrawl-stub.json",
    ];
    for (const rel of listed) {
      assert.ok(existsSync(join(ROOT, "test", "fixtures", rel)), `missing fixture: ${rel}`);
    }

    // guide.md: the README promises ≥2 heading levels, a bullet list, a fence and a table.
    const guide = readFileSync(join(CORPUS, "alpha/docs/guide.md"), "utf-8");
    assert.match(guide, /^# /m, "guide.md needs an h1");
    assert.match(guide, /^## /m, "guide.md needs an h2");
    assert.match(guide, /^[-*] /m, "guide.md needs a bullet list");
    assert.match(guide, /^```/m, "guide.md needs a fenced block");
    assert.match(guide, /^\|.*\|/m, "guide.md needs a table");

    // stats.R: roxygen comments are the whole point of the fixture.
    assert.match(readFileSync(join(CORPUS, "alpha/src/stats.R"), "utf-8"), /^#'/m);

    // The web stub is consumed by no ingestion code yet (ADR-024 is unimplemented),
    // but its fields are a contract with whoever writes it, so they are pinned now.
    const stub = JSON.parse(
      readFileSync(join(ROOT, "test", "fixtures", "web/firecrawl-stub.json"), "utf-8"),
    ) as Record<string, unknown> & { metadata?: Record<string, unknown> };
    for (const field of ["url", "markdown", "html"]) {
      assert.equal(typeof stub[field], "string", `firecrawl-stub.json.${field} must be a string`);
    }
    for (const field of ["title", "description", "statusCode"]) {
      assert.ok(stub.metadata && field in stub.metadata, `firecrawl-stub.json.metadata.${field} missing`);
    }
  });
}
void describe("fixture corpus invariants", fixtureInvariantSuite);
