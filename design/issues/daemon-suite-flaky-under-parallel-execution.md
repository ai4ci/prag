---
class: issue
id: daemon-suite-flaky-under-parallel-execution.md
title: Daemon test files fail intermittently at file level under parallel execution
status: open
priority: medium
relates-to:
- feature:test-harness-and-fixtures.md
---
## Problem

Running the daemon suite repeatedly, a run occasionally fails with a
**file-level** error and no named subtest — a different file each time:

```
✖ packages/daemon/test/error-envelope.test.ts (2310.654861ms)
✖ failing tests:
✖ packages/daemon/test/error-envelope.test.ts (2310.654861ms)
```

## Root cause: a Node bug, not a prag one

Reproduced deterministically by constraining the runner to one CPU
(`taskset -c 0 npx tsx --test 'packages/daemon/test/*.test.ts'`, 3 runs to
first failure). With the full output captured, the cause is visible and is not
a timeout:

```
FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal
----- Native stack trace -----
 1: 0x735da0 node::OnFatalError(char const*, char const*)
 3: 0x88c165 node::cjs_lexer::Parse(v8::FunctionCallbackInfo<v8::Value> const&)
```

Node aborts inside its own CommonJS lexer while loading a module. This is
[nodejs/node#63323](https://github.com/nodejs/node/issues/63323): v24.14.0
replaced `cjs-module-lexer` with `merve`
([#61456](https://github.com/nodejs/node/pull/61456)), and the new native
lexer called `ToLocalChecked()` unconditionally, so an allocation failure or a
pending exception aborts the process instead of throwing. It surfaces while
ESM imports a CJS module, which is why it lands at file scope with no subtest
attached, and why load makes it more likely.

**Fixed in Node 24.19.0** by
[#63885](https://github.com/nodejs/node/pull/63885). This machine runs
**v24.14.1**, which is affected.

## Not a CI problem

`.github/workflows/ci.yaml` pins `node-version: "22"`, which predates the
regression entirely. CI is unaffected — an earlier note in this repo claiming
CI had "been green by luck" was wrong. The flakiness is local to a developer
machine running an affected Node 24.

## Fix

Upgrade the local toolchain to **Node >= 24.19.0** (or use 22, as CI does).
Nothing in this repository needs to change: the test harness, the worker pool
and the teardown paths were all suspected and all exonerated. Serialising the
runner (`--test-concurrency=1`) also hides it, at roughly 3x wall clock
(24s vs 8s), but it is a workaround for someone else's bug, not a fix.

Worth considering: raise `engines.node` from `>=22` with a note that 24.14.0
through 24.18.x are known-bad, so the next person does not spend an afternoon
on it.
