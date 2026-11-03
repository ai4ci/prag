// @prag/core — ADR-023 built-in ignores are scoped to the project root.
//
// Tested against the whole absolute path, the predicate answered "ignore" for
// every file in a project that merely *lived* under a hidden or
// conventionally-named ancestor. `prag watch ~/.config/notes` then reported
// `0 files` with an empty `skipped` map and indexed nothing, which is the
// worst shape a skip can take: ADR-023 requires skipped-by-design be visible,
// and this was neither indexed nor counted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isBuiltinIgnored, discoveryDryRun } from "../src/discovery.js";

function ignoreScopeSuite(): void {
  void it("still ignores the conventional directories inside a project", () => {
    const root = "/home/u/repo";
    for (const p of [
      "/home/u/repo/node_modules/x/index.js",
      "/home/u/repo/.git/config",
      "/home/u/repo/dist/bundle.js",
      "/home/u/repo/src/__pycache__/m.pyc",
      "/home/u/repo/.env",
    ]) {
      assert.equal(isBuiltinIgnored(p, root), true, p);
    }
    assert.equal(isBuiltinIgnored("/home/u/repo/src/a.ts", root), false);
    // The one hidden file that is content.
    assert.equal(isBuiltinIgnored("/home/u/repo/.gitignore", root), false);
  });

  void it("does not ignore a project because of where it lives", () => {
    // Each of these roots contains a segment that would match: `.config` and
    // `.local` are hidden, `build` and `target` are in the built-in list.
    for (const [root, file] of [
      ["/home/u/.config/notes", "/home/u/.config/notes/readme.md"],
      ["/home/u/.local/src/proj", "/home/u/.local/src/proj/src/a.ts"],
      ["/srv/build/project", "/srv/build/project/src/a.ts"],
      ["/srv/target/project", "/srv/target/project/main.go"],
    ] as const) {
      assert.equal(isBuiltinIgnored(file, root), false,
        `${file} was ignored because its root ${root} contains an ignored segment`);
    }
  });

  void it("ignores a Windows-separated path too", () => {
    // The predicate split on "/" alone, so node_modules on Windows was indexed.
    assert.equal(
      isBuiltinIgnored("C:\\Users\\u\\repo\\node_modules\\x\\i.js", "C:\\Users\\u\\repo"),
      true,
    );
  });

  void it("falls back to the whole path when the file is not under the root", () => {
    // A caller that passes a mismatched root must not accidentally widen what
    // is indexed; testing everything is the safe direction.
    assert.equal(isBuiltinIgnored("/other/node_modules/x.js", "/home/u/repo"), true);
  });

  void it("discovers a project that lives under a hidden directory", async () => {
    const base = mkdtempSync(join(tmpdir(), "prag-hidden-"));
    const root = join(base, ".config", "notes");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "readme.md"), "# Notes\n\nSome prose.\n");
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    // ...and the ignores still apply *below* that root.
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");

    try {
      const out = await discoveryDryRun(root, [], {});
      assert.equal(out.files, 2,
        `expected the 2 real files, got ${out.files}: ${JSON.stringify(out.skipped)}`);
      assert.ok(!out.sample.some((s) => s.includes("node_modules")),
        "node_modules was indexed below the hidden root");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
void describe("built-in ignore scoping", ignoreScopeSuite);
