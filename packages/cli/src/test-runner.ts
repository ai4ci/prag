// Test helper: runs CLI in-process with captured output

import { Writable } from "node:stream";
import { main } from "./main.js";

/**
 * One stream per descriptor, installed once and reused.
 *
 * It must be a single long-lived object rather than a fresh one per call:
 * Node's global `console` resolves `process.stdout` once and holds the
 * stream it finds. Swapping in a new stream for the second `runCLI` call
 * therefore captured nothing -- `console.log` kept writing into the first
 * call's buffer -- so every assertion on `stdout` after the first in a
 * process saw an empty string. Resetting the buffer keeps the identity
 * stable while still giving each call its own output.
 */
class CaptureStream extends Writable {
  chunks: string[] = [];
  _write(chunk: any, _encoding: string, callback: () => void): void {
    this.chunks.push(String(chunk));
    callback();
  }
  reset(): void {
    this.chunks = [];
  }
  text(): string {
    return this.chunks.join("");
  }
  isTTY = false;
  columns = 80;
  rows = 24;
  // Allow the test runner to reference the real stdout for its own output
  fd = 1;
}

const stdoutCapture = new CaptureStream();
const stderrCapture = new CaptureStream();

export async function runCLI(
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const origArgv = process.argv;
  const origExit = process.exit;
  const origEnv = { ...process.env };

  // Set test env
  Object.assign(process.env, extraEnv);
  process.argv = ["node", "prag", ...args];

  stdoutCapture.reset();
  stderrCapture.reset();

  // Save originals before overriding
  const origStdout = (process as any).__orig_stdout ?? process.stdout;
  const origStderr = (process as any).__orig_stderr ?? process.stderr;
  (process as any).__orig_stdout = origStdout;
  (process as any).__orig_stderr = origStderr;

  function override(name: "stdout" | "stderr", stream: Writable) {
    Object.defineProperty(process, name, {
      get: () => stream,
      set: () => {},
      configurable: true,
      enumerable: true,
    });
  }

  override("stdout", stdoutCapture);
  override("stderr", stderrCapture);

  let exitCode = 0;
  const origExitFn = process.exit.bind(process);
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitIntercept(exitCode);
  }) as (code?: number) => never;

  try {
    await main();
  } catch (e: unknown) {
    if (!(e instanceof ExitIntercept)) {
      process.argv = origArgv;
      process.exit = origExitFn;
      override("stdout", origStdout as any);
      override("stderr", origStderr as any);
      process.env = origEnv;
      throw e;
    }
  } finally {
    process.argv = origArgv;
    process.exit = origExitFn;
    override("stdout", origStdout as any);
    override("stderr", origStderr as any);
    process.env = origEnv;
  }

  return { stdout: stdoutCapture.text(), stderr: stderrCapture.text(), exitCode };
}

class ExitIntercept extends Error {
  code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}
