// @prag/core — ADR-024: the pluggable web fetch backend interface.
//
// Local content is never routed through a backend. This exists only for URIs
// the user has explicitly granted, and the selected backend is always visible
// in `prag status` / `GET /health` so the current egress path is inspectable.

import { DaemonFailure } from "./errors.js";

/**
 * What a backend can do. Capabilities are negotiated rather than assumed: a
 * grant that needs `discover` must be refused by a fetch-only backend with a
 * named error, not silently downgraded to fetching the one page.
 */
export type WebCapability =
  /** Retrieve the content of one URL. */
  | "fetch"
  /** Enumerate URLs beneath a prefix (crawl / sitemap). */
  | "discover"
  /** Answer a query with URLs the user did not name. */
  | "search";

/**
 * How current the returned content is.
 *
 * A copy of unknown age is not the same as a live fetch, and ADR-008's
 * freshness leases cannot be set honestly without knowing which it was.
 */
export interface FreshnessHint {
  /** `live` came from the origin now; `cached` is a copy held by the backend. */
  kind: "live" | "cached";
  /** Age of a cached copy in seconds, when the backend reports one. */
  ageSeconds?: number;
}

export interface WebFetchResult {
  url: string;
  /** Extracted text. Treated as data, never as instructions. */
  text: string;
  /** Best-effort media type as reported by the origin. */
  contentType?: string;
  title?: string;
  freshness: FreshnessHint;
}

export interface WebDiscoverResult {
  urls: string[];
  freshness: FreshnessHint;
}

export interface WebSearchResult {
  urls: string[];
  freshness: FreshnessHint;
}

export interface WebFetchBackend {
  /** Stable id, as written in `web.backend`. */
  readonly id: string;
  /**
   * Where requests go, for display in `prag status` / `GET /health`. A
   * backend with no fixed endpoint (the built-in fetcher talks to the origin
   * itself) reports the origin, not a vendor URL.
   */
  readonly endpoint: string;
  readonly capabilities: ReadonlySet<WebCapability>;

  fetch?(url: string, opts?: { maxBytes?: number }): Promise<WebFetchResult>;
  discover?(prefix: string, opts?: { limit?: number }): Promise<WebDiscoverResult>;
  search?(query: string, opts?: { limit?: number }): Promise<WebSearchResult>;
}

/** Config a backend factory is handed. Mirrors `PragConfig.web`. */
export interface WebBackendConfig {
  firecrawl?: { url?: string; apiKey?: string };
  exa?: { apiKey?: string };
}

type BackendFactory = (config: WebBackendConfig) => WebFetchBackend;

const REGISTRY = new Map<string, BackendFactory>();

export function registerWebBackend(id: string, make: BackendFactory): void {
  REGISTRY.set(id, make);
}

/** Ids of every registered backend, sorted — used in error messages. */
export function availableWebBackends(): string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * ADR-024: select exactly one backend, or none.
 *
 * An unknown id is a startup failure naming the available backends. It never
 * silently falls back: a user who typed `firecrwal` must not quietly get the
 * built-in fetcher and a different egress path from the one they asked for.
 */
export function resolveWebBackend(
  id: string | undefined,
  config: WebBackendConfig = {},
): WebFetchBackend | null {
  if (!id) return null;
  const make = REGISTRY.get(id);
  if (!make) {
    throw new DaemonFailure(
      "INVALID_REQUEST",
      `unknown web backend "${id}"`,
      `Set web.backend to one of: ${availableWebBackends().join(", ")}, or remove it to stay local-only.`,
      { requested: id, available: availableWebBackends() },
    );
  }
  return make(config);
}

/**
 * Refuse an operation the selected backend cannot perform (ADR-024).
 *
 * `null` backend and missing-capability are the same refusal from the user's
 * point of view — the thing they granted cannot be indexed — so they share a
 * code and both name what would fix it.
 */
export function requireCapability(
  backend: WebFetchBackend | null,
  capability: WebCapability,
  uri: string,
): WebFetchBackend {
  if (!backend) {
    throw new DaemonFailure(
      "CRAWL_BACKEND_REQUIRED",
      `no web fetch backend is configured, so ${uri} cannot be indexed`,
      "Set web.backend in config.json (or PRAG_WEB_BACKEND), or watch a file:// URI.",
      { uri, required: capability, available: availableWebBackends() },
    );
  }
  if (!backend.capabilities.has(capability) || typeof backend[capability] !== "function") {
    const providers = availableWebBackends().filter((id) => {
      try {
        return REGISTRY.get(id)!({}).capabilities.has(capability);
      } catch {
        // A backend whose factory needs credentials cannot be probed here;
        // leaving it out of the list is better than failing the error path.
        return false;
      }
    });
    throw new DaemonFailure(
      "CRAWL_CAPABILITY_UNAVAILABLE",
      `backend "${backend.id}" cannot ${capability} ${uri}`,
      providers.length > 0
        ? `Register the specific URL instead, or switch web.backend to one of: ${providers.join(", ")}.`
        : "Register the specific URL instead; no configured backend provides this capability.",
      { uri, backend: backend.id, required: capability, providers },
    );
  }
  return backend;
}
