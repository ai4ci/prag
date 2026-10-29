#!/usr/bin/env node
// Build the git-backed fixture repositories from the static corpus in ./corpus.
//
// Usage: node build-git-fixtures.mjs <targetDir>
//
// Idempotent: <targetDir> is removed and rebuilt. Commits are fully
// deterministic (fixed identity and timestamps), so commit SHAs are stable
// across runs and machines and may be asserted on in tests.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CORPUS = resolve(import.meta.dirname, "corpus");

const IDENTITY = {
  name: "Prag Fixture",
  email: "fixtures@prag.invalid",
};

// Fixed timestamps: one per commit, so SHAs do not move between runs.
const DATES = {
  alphaMain: "2024-01-02T03:04:05+00:00",
  alphaFeature: "2024-01-03T03:04:05+00:00",
  betaMain: "2024-01-04T03:04:05+00:00",
};

function git(cwd, args, date) {
  return execFileSync(
    "git",
    [
      // Never depend on the host's global config.
      "-c",
      `user.name=${IDENTITY.name}`,
      "-c",
      `user.email=${IDENTITY.email}`,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: IDENTITY.name,
        GIT_AUTHOR_EMAIL: IDENTITY.email,
        GIT_COMMITTER_NAME: IDENTITY.name,
        GIT_COMMITTER_EMAIL: IDENTITY.email,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    },
  );
}

function initRepo(dir, source) {
  mkdirSync(dir, { recursive: true });
  cpSync(source, dir, { recursive: true });
  git(dir, ["init", "-b", "main", "-q"]);
  // Belt and braces: the repo keeps its own identity even if a test runs git
  // against it without our environment.
  git(dir, ["config", "user.name", IDENTITY.name]);
  git(dir, ["config", "user.email", IDENTITY.email]);
}

function commit(dir, message, date) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message], date);
}

function buildAlpha(dir) {
  initRepo(dir, resolve(CORPUS, "alpha"));
  commit(dir, "Initial import of alpha", DATES.alphaMain);

  git(dir, ["checkout", "-q", "-b", "feature-x"]);
  cpSync(resolve(CORPUS, "alpha-feature-x"), dir, { recursive: true });
  git(dir, ["rm", "-q", "src/stats.R"]);
  commit(dir, "Extend analysis, add new-feature, drop stats.R", DATES.alphaFeature);

  git(dir, ["checkout", "-q", "main"]);
}

function buildBeta(dir) {
  initRepo(dir, resolve(CORPUS, "beta"));
  commit(dir, "Initial import of beta", DATES.betaMain);
}

function buildPlain(dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(CORPUS, "plain"), dir, { recursive: true });
}

// Untracked files that the built-in ignore rules must skip. Written after the
// commits so they never enter history.
function addExclusionNoise(dir) {
  writeFileSync(
    resolve(dir, ".env"),
    "# not a real credential, only here so ignore rules can be tested\nAPI_TOKEN=sk-test-000000000000000000000000\n",
  );
  const junk = resolve(dir, "node_modules/junk/index.js");
  mkdirSync(dirname(junk), { recursive: true });
  writeFileSync(junk, 'module.exports = function junk() { return "should never be indexed"; };\n');
}

function main() {
  const [targetArg] = process.argv.slice(2);
  if (!targetArg) {
    throw new Error("usage: node build-git-fixtures.mjs <targetDir>");
  }
  const target = resolve(targetArg);
  if (target === "/" || target === resolve(import.meta.dirname)) {
    throw new Error(`refusing to wipe ${target}`);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const alpha = resolve(target, "alpha");
  const beta = resolve(target, "beta");
  const plain = resolve(target, "plain");

  buildAlpha(alpha);
  buildBeta(beta);
  buildPlain(plain);
  addExclusionNoise(alpha);

  process.stdout.write(`${JSON.stringify({ alpha, beta, plain })}\n`);
}

try {
  main();
} catch (error) {
  const detail = error?.stderr?.toString().trim() || error?.message || String(error);
  process.stderr.write(`build-git-fixtures: ${detail}\n`);
  process.exit(1);
}
