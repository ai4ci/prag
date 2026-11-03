// @prag/daemon — ADR-024: the crawlberg web fetch backend.
//
// Lives in the daemon, not in core, for the same reason LanceDB does: the
// package resolves to a ~46MB native addon, and core is on the CLI's import
// path. A `prag search` must not load a crawler to print results.
//
// Chosen as the default over `plain-fetcher` because it answers the two
// questions that one could not: it emits real Markdown (so the heading
// chunker has headings to split on rather than a wall of prose), and it can
// enumerate a site, which is the `discover` capability `watchUri` asks for
// when a bare origin is registered.

import {
  registerWebBackend,
  type WebBackendConfig,
  type WebCapability,
  type WebDiscoverResult,
  type WebFetchBackend,
  type WebFetchResult,
} from "@prag/core";
import {
  createEngine,
  mapUrls,
  scrape,
  type CrawlConfig,
  type CrawlEngineHandle,
} from "@xberg-io/crawlberg";

export const CRAWLBERG_ID = "crawlberg";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_DISCOVER_LIMIT = 500;

/**
 * Knobs prag exposes from crawlberg's much larger `CrawlConfig`.
 *
 * Deliberately small. Everything not listed here is pinned below, because a
 * crawler's defaults are an egress policy and ADR-024 requires the egress
 * path be inspectable rather than inherited.
 */
export interface CrawlbergOptions {
  /**
   * Permit requests to private and loopback addresses. Default `false`.
   *
   * The test suite serves fixtures from `127.0.0.1` and must set this; no
   * other caller should. It is pinned rather than merely defaulted -- see
   * `ssrfDenyPrivateExplicit` below.
   */
  allowPrivateNetwork?: boolean;
  /** Ignore robots.txt. Default `false`. */
  ignoreRobotsTxt?: boolean;
  /** Minimum delay between requests to one host, ms. Default 200 (crawlberg's own). */
  rateLimitMs?: number;
  /** Identify prag to the origin. */
  userAgent?: string;
}

/**
 * Engine configuration, with every field that bears on egress stated.
 *
 * `ssrfDenyPrivateExplicit` is the load-bearing one. Left unset, crawlberg
 * treats `ssrf.denyPrivate: true` as inconclusive -- its own structural
 * default is also `true`, so it cannot tell a caller's intent from a binding's
 * boilerplate -- and defers to the `CRAWLBERG_ALLOW_PRIVATE_NETWORK`
 * environment variable. That would make an environment variable prag does not
 * document, and does not read, able to widen prag's egress to the user's LAN.
 * Pinning it says the decision is prag's and the variable is not consulted.
 */
function engineConfig(opts: CrawlbergOptions, maxBytes: number): CrawlConfig {
  const allowPrivate = opts.allowPrivateNetwork === true;
  return {
    ssrf: { denyPrivate: !allowPrivate },
    ssrfDenyPrivateExplicit: !allowPrivate,
    respectRobotsTxt: opts.ignoreRobotsTxt !== true,
    userAgent: opts.userAgent ?? "prag (+https://github.com/ai4ci/prag)",
    requestTimeout: REQUEST_TIMEOUT_MS,
    rateLimitMs: opts.rateLimitMs,
    maxBodySize: maxBytes,
    // No browser, no screenshots, no assets, no document downloads: this
    // backend returns text for one granted URL. Each of those would be a
    // separate egress decision and a separate disk cost.
    downloadAssets: false,
    downloadDocuments: false,
    captureScreenshot: false,
    content: {
      outputFormat: "markdown",
      // The YAML frontmatter crawlberg prepends carries the page title, which
      // the heading chunker then treats as content. The title is returned
      // separately below instead.
      extractMetadata: false,
      // `standard` strips nav, nav-hinted headers/footers and forms. Page
      // chrome embedded as prose is the single biggest source of noise in a
      // web index.
      preprocessingPreset: "standard",
    },
    mapLimit: DEFAULT_DISCOVER_LIMIT,
  };
}

class CrawlbergBackend implements WebFetchBackend {
  readonly id = CRAWLBERG_ID;
  // In-process: there is no service in the path, so the honest answer for
  // `prag status` is the origin itself, exactly as for plain-fetcher.
  readonly endpoint = "(direct to origin)";
  readonly capabilities: ReadonlySet<WebCapability> =
    new Set<WebCapability>(["fetch", "discover"]);

  /**
   * Engines are cached per byte budget. Building one parses the config and
   * allocates a connection pool, and `maxBytes` is the only field that varies
   * between calls.
   */
  readonly #engines = new Map<number, CrawlEngineHandle>();

  constructor(private readonly opts: CrawlbergOptions) {}

  #engine(maxBytes: number): CrawlEngineHandle {
    let engine = this.#engines.get(maxBytes);
    if (!engine) {
      engine = createEngine(engineConfig(this.opts, maxBytes));
      this.#engines.set(maxBytes, engine);
    }
    return engine;
  }

  async fetch(url: string, opts?: { maxBytes?: number }): Promise<WebFetchResult> {
    const max = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    const result = await scrape(this.#engine(max), url);

    // `softHttpErrors` is left off, so a 4xx/5xx throws rather than arriving
    // here. A 2xx that crawlberg declined to render still needs saying.
    if (result.wasSkipped) {
      throw new Error(`${url} was skipped: content is binary or unrenderable`);
    }

    const markdown = result.markdown?.content ?? "";
    return {
      url: result.finalUrl ?? url,
      text: markdown.slice(0, max),
      contentType: result.contentType,
      title: result.metadata?.title ?? undefined,
      // crawlberg holds no cache of its own, so every result came from the
      // origin just now. Claiming otherwise would feed ADR-008's freshness
      // leases a lie they would then act on.
      freshness: { kind: "live" },
    };
  }

  async discover(prefix: string, opts?: { limit?: number }): Promise<WebDiscoverResult> {
    const limit = opts?.limit ?? DEFAULT_DISCOVER_LIMIT;
    const result = await mapUrls(this.#engine(DEFAULT_MAX_BYTES), prefix);
    const urls: string[] = [];
    for (const entry of result.urls ?? []) {
      if (entry.url) urls.push(entry.url);
      if (urls.length >= limit) break;
    }
    return { urls, freshness: { kind: "live" } };
  }
}

/**
 * A backend whose two capabilities are statically known.
 *
 * `WebFetchBackend` declares `fetch` and `discover` optional, because a
 * backend may have neither; a caller holding this type has already been told
 * which it has and need not re-narrow at every call.
 */
export type CrawlbergWebBackend = WebFetchBackend &
  Required<Pick<WebFetchBackend, "fetch" | "discover">>;

/** Build a backend directly. Exported for tests, which need loopback. */
export function makeCrawlbergBackend(opts: CrawlbergOptions = {}): CrawlbergWebBackend {
  return new CrawlbergBackend(opts);
}

registerWebBackend(CRAWLBERG_ID, (config: WebBackendConfig) =>
  new CrawlbergBackend(config.crawlberg ?? {}));
