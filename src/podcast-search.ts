import {isIP} from "node:net";
import {z} from "zod";

export class PodcastSearchError extends Error {}
export const PODCAST_SEARCH_TIMEOUT_MS = 30000;
export const PODCAST_SEARCH_MAX_BYTES = 1024*1024;
export const podcastSearchInput = z.strictObject({
  // MinusPod v2.100.10 reassembles q with requote_uri, not urlencode.
  // Reject delimiters/escapes and '+' even though we encode the first hop:
  // Flask decodes it before the app builds the provider's query string.
  query:z.string().max(200).regex(/^[^&%#+\p{Cc}\p{Cs}]*$/u,
    "Search terms cannot contain controls, invalid Unicode or &, %, #, +").trim().min(1),
  limit:z.number().int().min(1).max(10).default(10),
});
export type PodcastSearchInput = z.input<typeof podcastSearchInput>;

function publicFeedUrl(value:unknown):string|null {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\p{Cc}]/u.test(value)) return null;
  try {
    const url=new URL(value);
    const host=url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    // Never fetch/resolve these URLs. Omit suspicious rows rather than modify a
    // credential-bearing URL into a different, seemingly subscribable feed.
    if (!["http:","https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || url.port || isIP(host) || !host.includes(".") ||
        /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}
function metadataText(value:unknown, max:number):string {
  if (typeof value !== "string") return "";
  // Metadata is untrusted directory content. Embedded links may themselves be
  // authenticated/signed; return only the separately checked feed URL.
  return value.slice(0,max)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/(?:https?|ftp):\/\/[^\s<>"']*/giu, "[URL omitted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s<>"']+/giu, "[redacted]")
    .replace(/\b(?:api[-_ ]?(?:key|secret)|password|secret|token|cookie|authorization|session|x-auth-key)\s*[:=]\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;<>]+)/giu, "[redacted]")
    .slice(0,max);
}

export function projectPodcastSearch(data:unknown, limit:number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 ||
      !data || typeof data !== "object" || Array.isArray(data))
    throw new PodcastSearchError("Podcast Index search returned an invalid response");
  const response=data as Record<string,unknown>;
  // The app can also search iTunes. Never mislabel an Apple ID as PodcastIndex.
  if (response.provider !== "podcastindex") throw new PodcastSearchError(
    "Search refused: MinusPod must use PodcastIndex.org; select it in the app's Podcast Search settings. MCP does not change providers.");
  if (!Array.isArray(response.results)) throw new PodcastSearchError("Podcast Index search returned an invalid response");
  const results=[];
  // Upstream requests max=10. Bound work/output even if its response drifts.
  for (const item of response.results.slice(0,10)) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !Number.isSafeInteger(item.id) || item.id <= 0) continue;
    const feedUrl=publicFeedUrl(item.feedUrl);
    if (!feedUrl) continue;
    results.push({podcastIndexId:item.id,title:metadataText(item.title,200),author:metadataText(item.author,200),
      description:metadataText(item.description,4000),feedUrl});
    if (results.length >= limit) break;
  }
  return {provider:"podcastindex",results};
}
