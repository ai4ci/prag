// @prag/core — ADR-022 code set, status mapping and exit-code table
//
// Structural: these hold no matter what a handler does, which is what makes the
// per-endpoint tests in @prag/daemon shorter — they assert one code each and the
// totality below guarantees no code is unhandled.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EXIT,
  EXIT_FOR_CODE,
  HTTP_STATUS_FOR_CODE,
  DaemonFailure,
  exitForCode,
} from "../src/errors.js";

// The closed set is a type, so the runtime view is the mapping's key list. The
// two mappings must cover exactly the same codes.
const CODES = Object.keys(EXIT_FOR_CODE).sort();

function errorCodeContractSuite(): void {
  void it("every code has both an HTTP status and an exit code", () => {
    assert.deepEqual(Object.keys(HTTP_STATUS_FOR_CODE).sort(), CODES);
  });

  void it("the code set is the one ADR-022 lists, by name", () => {
    // Names are the contract, so they are asserted literally: renaming a code is
    // a breaking change and this test is where it surfaces.
    assert.deepEqual(CODES, [
      "API_VERSION_MISMATCH",
      "CRAWL_BACKEND_REQUIRED",
      "CRAWL_CAPABILITY_UNAVAILABLE",
      "DAEMON_IDENTITY_MISMATCH",
      "EMBEDDING_MODEL_MISMATCH",
      "INTERNAL",
      "INVALID_REQUEST",
      "METHOD_NOT_ALLOWED",
      "NOT_FOUND",
      "ORIGIN_REJECTED",
      "PROJECT_ID_REQUIRED",
      "PROJECT_NOT_FOUND",
      "REEMBED_IN_PROGRESS",
      "SEARCH_FAILED",
      "SERVICE_UNAVAILABLE",
      "SYNC_FAILED",
      "SYNC_TIMEOUT",
      "UNAUTHORIZED",
      "WATCH_LIMIT_EXCEEDED",
    ]);
  });

  void it("statuses are the classes ADR-022 §2 names", () => {
    const statuses = [...new Set(Object.values(HTTP_STATUS_FOR_CODE))].sort((a, b) => a - b);
    for (const s of statuses) {
      assert.ok(
        [400, 401, 404, 405, 409, 422, 500, 503, 504].includes(s),
        `status ${s} is not in the ADR-022 mapping`,
      );
    }
  });

  void it("exit codes are the table in ADR-022 §3", () => {
    assert.deepEqual(EXIT_FOR_CODE, {
      UNAUTHORIZED: EXIT.AUTH,
      ORIGIN_REJECTED: EXIT.AUTH,
      NOT_FOUND: EXIT.USAGE,
      METHOD_NOT_ALLOWED: EXIT.USAGE,
      INVALID_REQUEST: EXIT.USAGE,
      INTERNAL: EXIT.UNEXPECTED,
      SERVICE_UNAVAILABLE: EXIT.NO_DAEMON,
      DAEMON_IDENTITY_MISMATCH: EXIT.IDENTITY_MISMATCH,
      API_VERSION_MISMATCH: EXIT.IDENTITY_MISMATCH,
      EMBEDDING_MODEL_MISMATCH: EXIT.MODEL_MISMATCH,
      REEMBED_IN_PROGRESS: EXIT.UNEXPECTED,
      PROJECT_ID_REQUIRED: EXIT.USAGE,
      PROJECT_NOT_FOUND: EXIT.NOT_GRANTED,
      SYNC_TIMEOUT: EXIT.TIMEOUT,
      SYNC_FAILED: EXIT.UNEXPECTED,
      SEARCH_FAILED: EXIT.UNEXPECTED,
      WATCH_LIMIT_EXCEEDED: EXIT.USAGE,
      CRAWL_BACKEND_REQUIRED: EXIT.UNEXPECTED,
      CRAWL_CAPABILITY_UNAVAILABLE: EXIT.UNEXPECTED,
    } as Record<string, number>);
  });

  void it("client-raised codes map without falling through a default", () => {
    assert.equal(exitForCode("DAEMON_NOT_RUNNING"), EXIT.NO_DAEMON);
    assert.equal(exitForCode("DAEMON_UNREACHABLE"), EXIT.NO_DAEMON);
  });

  void it("a failure renders as the ADR-022 envelope", () => {
    const f = new DaemonFailure("SYNC_TIMEOUT", "drain exceeded", "Run prag sync again", {
      pendingFiles: 3,
    });
    assert.deepEqual(f.toEnvelope(), {
      error: {
        code: "SYNC_TIMEOUT",
        message: "drain exceeded",
        remedy: "Run prag sync again",
        details: { pendingFiles: 3 },
      },
    });
    // Optional fields are absent, not null: an empty remedy is not a remedy.
    assert.deepEqual(new DaemonFailure("NOT_FOUND", "nope").toEnvelope(), {
      error: { code: "NOT_FOUND", message: "nope" },
    });
  });
}

describe("error code contract", errorCodeContractSuite);
