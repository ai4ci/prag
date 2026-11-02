// @prag/core — ADR-022 error envelope
//
// `code` is the contract; `message` is free to be reworded. Tests, the CLI and
// MCP clients branch on code alone, so rewording a sentence for clarity must
// never break a caller.

/** The closed set of failure codes (ADR-022 §1). */
export type ErrorCode =
  // Transport / identity
  | "UNAUTHORIZED"
  | "ORIGIN_REJECTED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_REQUEST"
  | "INTERNAL"
  | "SERVICE_UNAVAILABLE"
  // Identity & version (ADR-016)
  | "DAEMON_IDENTITY_MISMATCH"
  | "API_VERSION_MISMATCH"
  // Embedding index (ADR-015)
  | "EMBEDDING_MODEL_MISMATCH"
  | "REEMBED_IN_PROGRESS"
  // Project scoping (ADR-018)
  | "PROJECT_ID_REQUIRED"
  | "PROJECT_NOT_FOUND"
  // Sync (ADR-019)
  | "SYNC_TIMEOUT"
  | "SYNC_FAILED"
  | "SEARCH_FAILED"
  // Admission (ADR-023)
  | "WATCH_LIMIT_EXCEEDED"
  // Web backends (ADR-024)
  | "CRAWL_BACKEND_REQUIRED"
  | "CRAWL_CAPABILITY_UNAVAILABLE";

/**
 * ADR-022 §1. `remedy` is the action the user can take; `details` is optional.
 * `code` is `FailureCode`, not just the daemon-side set, so a client can put a
 * failure it raised itself (e.g. DAEMON_UNREACHABLE) in the same shape.
 */
export interface ErrorEnvelope {
  error: {
    code: FailureCode;
    message: string;
    remedy?: string;
    details?: Record<string, unknown>;
  };
}

/** CLI exit codes (ADR-022 §3). `0` includes a search that matched nothing. */
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  NO_DAEMON: 3,
  IDENTITY_MISMATCH: 4,
  AUTH: 5,
  MODEL_MISMATCH: 6,
  NOT_GRANTED: 7,
  TIMEOUT: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * The one mapping from error code to CLI exit code. Kept next to the code set so
 * adding a code forces the decision here rather than leaving it to a default arm.
 */
export const EXIT_FOR_CODE: Record<ErrorCode, ExitCode> = {
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
};

/**
 * Codes the prag CLI raises for its own failures. A client cannot receive these
 * from the daemon — they describe the client's inability to use it — but they
 * need a home in the same closed set so exit-code mapping stays total.
 */
export type ClientErrorCode =
  | "DAEMON_UNREACHABLE"
  | "DAEMON_NOT_RUNNING"
  | "SHUTDOWN_FAILED";

/** Everything a `DaemonError` can carry. */
export type FailureCode = ErrorCode | ClientErrorCode;

/** Exit code for any code the CLI can encounter, daemon-side or client-side. */
export function exitForCode(code: FailureCode): ExitCode {
  if (code in EXIT_FOR_CODE) return EXIT_FOR_CODE[code as ErrorCode];
  switch (code) {
    case "DAEMON_UNREACHABLE":
    case "DAEMON_NOT_RUNNING":
      return EXIT.NO_DAEMON;
    default:
      return EXIT.UNEXPECTED;
  }
}

/**
 * HTTP status for each daemon-side code (ADR-022 §1 pairs a code with a status
 * class). Client-only codes are absent: they never travel over HTTP.
 */
export const HTTP_STATUS_FOR_CODE: Partial<Record<ErrorCode, number>> = {
  UNAUTHORIZED: 401,
  ORIGIN_REJECTED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INVALID_REQUEST: 400,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
  DAEMON_IDENTITY_MISMATCH: 409,
  API_VERSION_MISMATCH: 409,
  EMBEDDING_MODEL_MISMATCH: 409,
  REEMBED_IN_PROGRESS: 409,
  PROJECT_ID_REQUIRED: 422,
  PROJECT_NOT_FOUND: 404,
  SYNC_TIMEOUT: 504,
  SYNC_FAILED: 500,
  SEARCH_FAILED: 500,
  WATCH_LIMIT_EXCEEDED: 409,
  CRAWL_BACKEND_REQUIRED: 503,
  CRAWL_CAPABILITY_UNAVAILABLE: 503,
};

/**
 * A failure that carries its ADR-022 code. Used on both sides: the daemon throws
 * it to answer with an envelope, and MCP tools catch it to answer with the same
 * envelope, so one code set describes a failure wherever it is observed.
 */
export class DaemonFailure extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
    public readonly remedy?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DaemonFailure";
  }

  /** The wire form of this failure (ADR-022 §1). */
  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.remedy ? { remedy: this.remedy } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

