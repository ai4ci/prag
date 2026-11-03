// @prag/core — "not right now" is not "not ever".
//
// Every filesystem failure in the ingestion path arrived at one `catch` and
// was recorded as `unreadable`, a final-looking skip with nothing to retry
// it. Under load the failures are not final: EMFILE and ENFILE are
// descriptor exhaustion, ENOMEM memory pressure, EAGAIN/EBUSY contention.
// Recording a passing resource shortage as a property of the file loses it
// until something else touches it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isTransientFsError } from "../src/discovery.js";

function errWith(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

function transientErrorSuite(): void {
  void it("classifies resource exhaustion as retryable", () => {
    for (const code of ["EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "EBUSY", "EINTR"]) {
      assert.equal(isTransientFsError(errWith(code)), true, code);
    }
  });

  void it("classifies real properties of the file as final", () => {
    // These say something true and lasting: retrying changes nothing, and a
    // retry loop on EACCES would hammer a file the user deliberately
    // protected.
    for (const code of ["EACCES", "EPERM", "ENOENT", "EISDIR", "ELOOP", "ENAMETOOLONG"]) {
      assert.equal(isTransientFsError(errWith(code)), false, code);
    }
  });

  void it("treats an error with no code as final", () => {
    // Unknown means unknown. Retrying forever on something unrecognised is
    // worse than skipping it and saying so.
    assert.equal(isTransientFsError(new Error("boom")), false);
    assert.equal(isTransientFsError(null), false);
    assert.equal(isTransientFsError(undefined), false);
    assert.equal(isTransientFsError("EMFILE"), false, "a bare string is not an errno");
  });
}
void describe("transient filesystem errors", transientErrorSuite);
