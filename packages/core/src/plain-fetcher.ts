// @prag/core — ADR-024: the zero-configuration built-in web backend.
//
// `fetch` only, standard library, no dependency and no third party: it talks
// to the origin the user granted and nothing else. Registering it is what
// makes `web.backend: "plain-fetcher"` a working configuration rather than a
// reason to install something.

import {
  registerWebBackend,
  type WebFetchBackend,
  type WebFetchResult,
  type WebCapability,
} from "./web-backend.js";

export const PLAIN_FETCHER_ID = "plain-fetcher";

/** Bytes read before giving up, when the caller names no limit. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** Tags whose content is chrome, not prose. */
const STRIP_BLOCKS = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * HTML to text, deliberately crude.
 *
 * Layout-preserving extraction is LiteParse's job
 * (`task:liteparse-document-pipeline.md`); this only has to produce something
 * chunkable for a plain page. It is not a sanitiser — the output is stored and
 * embedded as data, never interpreted.
 */
export function htmlToText(html: string): string {
  return html
    .replace(STRIP_BLOCKS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlToText(m[1]).slice(0, 300) || undefined : undefined;
}

class PlainFetcher implements WebFetchBackend {
  readonly id = PLAIN_FETCHER_ID;
  // No vendor in the path: requests go to the granted origin itself, and
  // saying so is the honest answer for `prag status`.
  readonly endpoint = "(direct to origin)";
  readonly capabilities: ReadonlySet<WebCapability> = new Set<WebCapability>(["fetch"]);

  async fetch(url: string, opts?: { maxBytes?: number }): Promise<WebFetchResult> {
    const max = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`plain-fetcher cannot fetch ${parsed.protocol} URLs`);
    }

    const res = await globalThis.fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1" },
    });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);

    const contentType = res.headers.get("content-type") ?? undefined;

    // Truncated while reading, not after: a caller's maxFileBytes is a budget
    // for what prag will hold, and buffering a 2GB response to then reject it
    // spends the memory anyway.
    const body = await readCapped(res, max);
    const text = /html/i.test(contentType ?? "") ? htmlToText(body) : body;

    return {
      url: res.url || url,
      text,
      contentType,
      title: /html/i.test(contentType ?? "") ? titleOf(body) : undefined,
      // Always live: this backend has no cache of its own. A `cached` hint
      // would be a lie that ADR-008's freshness leases would then act on.
      freshness: { kind: "live" },
    };
  }
}

/** Read at most `max` bytes of a response body, decoded as UTF-8. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, max);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.byteLength;
    if (total >= max) {
      await reader.cancel();
      break;
    }
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(joined.subarray(0, max));
}

registerWebBackend(PLAIN_FETCHER_ID, () => new PlainFetcher());
