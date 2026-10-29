// Test helper: runs CLI in-process with captured output

import { Writable } from "node:stream";
import { main } from "./main.js";

class CaptureStream extends Writable {
  chunks: string[] = [];
  _write(chunk: any, _encoding: string, callback: () => void): void {
    this.chunks.push(String(chunk));
    callback();
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

  const stdoutCapture = new CaptureStream();
  const stderrCapture = new CaptureStream();

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
