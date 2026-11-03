---
class: task
id: local-first-enforcement.md
title: Implement hardware acceleration provider selection and local-first enforcement
status: in_progress
priority: medium
relates-to:
  - feature:local-first-runtime.md
tested-by:
  - daemontest:local-first-egress.test.ts
---
## Objective
Implement hardware-configurable acceleration provider selection for the local ONNX
embedding runtime, and make the local-first guarantee (ADR-024) independently
verifiable.

## Requirements
- Detect available acceleration providers (CUDA, WebGPU, DirectML) at daemon startup; honor `PRAG_EMBEDDING_DEVICE`.
- Automatic graceful fallback to CPU SIMD execution when no dedicated accelerator is present or initialization fails.
- Log the selected provider on startup (visible via `prag daemon status`).
- Add a CI/test check (e.g. network-call interception in tests) asserting that a
  normal index+search cycle over **local** content makes zero outbound network
  connections. Local content here means `file://` grants only; the check is not
  weakened to "localhost only", and it holds even when a web backend is configured,
  since serving a local query must never touch the backend.
- Report the active web backend (id + endpoint) in `GET /health` and `prag status`,
  and reflect it in the local-first assertion above: the assertion is about the
  local path, not about the process never having a network route.
- Add a test that a configured-but-unreachable web backend cannot make a local
  search fail or emit a request (no fallback, no retry storm, per ADR-024).

## Implementation status 2026-11-03

Partially complete. The local-first guarantee and the device selection are
done; the two web-backend requirements are blocked on work that does not exist
yet.

- **`PRAG_EMBEDDING_DEVICE` — DONE.** It was documented in
  `env-and-storage-paths.md` and read by nobody: `OnnxEmbeddingProvider` had a
  `device` option that nothing populated, so every install silently ran on CPU
  whatever the user configured. The `onnx:` provider factory now reads it.
- **Graceful CPU fallback — DONE.** A device that fails to initialise falls
  back to CPU rather than failing startup, and says so on stderr. Silently
  running an order of magnitude slower than the user believes is its own
  failure, so it is logged, not swallowed.
- **Selected provider is visible — DONE.** `activeDevice` (what is *in use*,
  not what was asked for) is reported by `GET /health` as `embeddingDevice`
  and printed by `prag status` and the daemon's startup line.
- **Zero-egress assertion — DONE.** `daemontest:local-first-egress.test.ts`
  runs a full watch -> sync -> search cycle over `file://` content and asserts
  no non-loopback socket connection or DNS lookup occurs. The hook is at the
  socket layer rather than at `fetch`, because a native-addon telemetry call
  or a model download would bypass `fetch` entirely and those are the paths
  worth catching. It is not weakened to "localhost only": loopback is allowed
  because the daemon is a loopback service, but anything leaving the machine
  fails.

  The suite also tests the watcher itself against a TEST-NET-1 address, which
  is what makes the first assertion mean anything. That second test earned its
  place immediately: the first version of the hook read `args[0].host`, but
  Node calls `Socket.prototype.connect` with the normalised array
  `[options, cb]`, so it silently recorded nothing and the egress assertion
  passed vacuously.

### 2026-11-03: the socket hook has a measured blind spot

The claim above -- "the hook is at the socket layer ... because a native-addon
telemetry call would bypass `fetch`" -- is **only half true**, and installing
`@xberg-io/crawlberg` is what exposed it. The hook patches
`net.Socket.prototype.connect` and `dns.lookup`, so it sees connections made
through Node's `net` module. A native addon that carries its own HTTP stack
does not use it. Measured against one loopback URL:

| | `net.Socket.connect` calls observed |
|---|---|
| Node's own `fetch` | 1 |
| `crawlberg.scrape` | **0** |

So a green run of the zero-egress test is not evidence that a native addon
stayed silent. It never was; there was simply no such addon in the tree making
requests until now.

**What was done about it.** A second, behavioural assertion:
`the local path never calls the web backend` configures a counting backend and
runs the same watch -> sync -> search cycle, asserting the backend is not
invoked once. That is the property actually at stake, and unlike a socket
count it is observable from JavaScript whatever the backend is written in.
It also closes the second item below.

**What is still not provable here.** A native addon's silence. Doing that
properly needs an OS-level boundary -- a network namespace, seccomp, or an
strace-based check -- which belongs to deployment verification rather than a
unit test. Recorded so a green suite is not mistaken for a stronger guarantee
than it gives.

### Remaining

- ~~**Report the active web backend in `GET /health` and `prag status`.**~~
  Done. `/health` already carried `webBackend` (id, endpoint, capabilities);
  `prag status` now prints it, and prints `Web: none (local content only)`
  when none is configured -- which is the case worth stating, since a blank
  line leaves a user unable to tell "local only" from "not reported".

  Writing the test for it surfaced a defect in the CLI test harness: it
  installed a fresh capture stream per `runCLI` call, but Node's global
  `console` resolves `process.stdout` once and keeps the stream it found, so
  **only the first call in a process captured anything**. Every later
  assertion on stdout would have seen `""`. Nothing caught it because every
  other test in the file asserts on the exit code alone. Fixed by keeping one
  long-lived stream and resetting its buffer, with a test that makes two calls
  and asserts both capture.
- ~~**Test that a configured-but-unreachable web backend cannot fail a local
  search or emit a request (ADR-024).**~~ Done, by the behavioural assertion
  above: the backend is configured and never reached, so whether it is
  reachable cannot affect a local search.

Hardware acceleration beyond honouring the variable -- probing for CUDA,
WebGPU or DirectML availability and choosing among them -- is not implemented.
`device` is passed to Transformers.js, which does its own dispatch; there is no
independent detection. Recorded rather than guessed at: what counts as
"detecting" a provider depends on whether the project wants to prefer an
accelerator automatically or only ever honour an explicit setting, and that is
a decision, not an implementation detail.
