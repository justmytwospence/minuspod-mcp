/**
 * Server-side credentials only. Secure cookies are explicitly sent to ONE trusted
 * origin on the local Docker bridge, like homelab/minuspod/configure.py. Never
 * weaken the app's browser cookie policy. No redirects or inherited HTTP proxy.
 */
import {podcastSearchInput, PodcastSearchError, PODCAST_SEARCH_TIMEOUT_MS,
  PODCAST_SEARCH_MAX_BYTES, type PodcastSearchInput} from "./podcast-search.js";

export class ApiError extends Error {
  constructor(public readonly status: number, message = "MinusPod API request failed", public readonly retryAfterAt:string|null=null) {
    super(`${message} (HTTP ${status}); inspect the app locally. Writes were not retried.`+
      (status===429 ? ` No automatic retry. ${retryAfterAt ? `Retry-After/cooldown until ${retryAfterAt}.` : "Retry-After/reset unknown; wait before a bounded manual retry."}` : ""));
  }
}
type Json = Record<string, any>;
type RequestKind="authentication"|"metadataRead"|"metadataWrite"|"directorySearch";
type Observation={attempts:number;inFlight:number;lastAttemptAt:string|null;lastResponseAt:string|null;
  lastHttpStatus:number|null;lastFailureAt:string|null;lastRateLimitAt:string|null;retryAfterAt:string|null;retryAfterObservedAt:string|null};
function retryAfter(value:string|null, now:number):string|null {
  if (!value || value.length>100) return null;
  const seconds=/^\d+$/.test(value);
  const ms=seconds ? now+Number(value)*1000 :
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms<now || ms>8640000000000000) return null;
  const date=new Date(ms);
  return seconds || date.toUTCString()===value ? date.toISOString() : null;
}
// A search deadline also bounds waiting for a shared login, without cancelling
// another caller's authentication request. Late login completion cannot search.
async function waitWithSignal<T>(promise:Promise<T>, signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener("abort",abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
  });
}
export class MinusPodClient {
  private cookies = new Map<string, string>();
  private loginFlight?: Promise<void>;
  private loginBlockedUntil = 0;
  private readonly base: URL;
  private readonly observations=Object.fromEntries(
    (["authentication","metadataRead","metadataWrite","directorySearch"] as const).map(kind=>[kind,{
      attempts:0,inFlight:0,lastAttemptAt:null,lastResponseAt:null,lastHttpStatus:null,
      lastFailureAt:null,lastRateLimitAt:null,retryAfterAt:null,retryAfterObservedAt:null,
    }])) as Record<RequestKind,Observation>;
  private readonly startedAt:string;
  constructor(
    base: string, private readonly password: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 90000,
    private readonly now:()=>number = Date.now,
  ) {
    this.startedAt=new Date(this.now()).toISOString();
    this.base = new URL(base);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username ||
        this.base.password || this.base.search || this.base.hash ||
        !["/", ""].includes(this.base.pathname) || !password) {
      throw new Error("Configure a trusted MinusPod origin and nonempty server-side password");
    }
  }
  // Pure local snapshot: no session refresh, health check or provider probe.
  localStatus() {
    return {source:"process-local HTTP attempt accounting; not upstream quota",startedAt:this.startedAt,
      generatedAt:new Date(this.now()).toISOString(),
      login:{sessionPresent:this.cookies.has("session")&&this.cookies.has("minuspod_csrf"),
        inFlight:!!this.loginFlight,cooldownUntil:this.loginBlockedUntil>this.now()?new Date(this.loginBlockedUntil).toISOString():null,
        cooldownSource:"local 60-second login-failure policy, or longer observed Retry-After"},
      observations:structuredClone(this.observations),
      cooldownScope:"process-local request groups; longest active app Retry-After observation, not an authoritative global/provider reset",
      metadataQuota:{limit:null,remaining:null,resetAt:null},
      directorySearch:{documentedAppRouteRequestsPerMinute:30,remaining:null,resetAt:null,
        providerQuota:"unknown; app 502 can mask PodcastIndex throttling/timeouts"},
      monetaryBudget:"separate app admission/spend state; not an HTTP request allowance"};
  }
  // No caller-supplied URL, arbitrary paths, HTTP verbs, or global-setting writes.
  private validPath(method: string, path: string): boolean {
    const p = path.split("?")[0];
    const feed = "[a-z0-9-]{1,200}", ep = "(?:[a-f0-9]{12}|s[0-9]{2,3}e[0-9]{2,4})";
    if (method === "GET") return [
      "^/(?:health|feeds|status|system/queue|stats/dashboard|settings/provider-budget|history)$",
      `^/feeds/${feed}(?:/episodes(?:/${ep})?)?$`,
    ].some(pattern => new RegExp(pattern).test(p));
    if (method === "POST") return p === "/feeds" ||
      new RegExp(`^/feeds/${feed}/refresh$`).test(p) ||
      new RegExp(`^/feeds/${feed}/episodes/${ep}/cancel$`).test(p) ||
      new RegExp(`^/episodes/${feed}/${ep}/reprocess$`).test(p);
    return method === "PATCH" && new RegExp(`^/feeds/${feed}$`).test(p);
  }
  private async request(method: string, path: string, body?: Json, options:{
    signal?:AbortSignal; maxBytes?:number;
  } = {}): Promise<Json> {
    const maxBytes=options.maxBytes??8*1024*1024;
    const kind:RequestKind=path==="/auth/login"?"authentication":path.startsWith("/podcast-search?")?
      "directorySearch":method==="GET"?"metadataRead":"metadataWrite";
    const observation=this.observations[kind];
    // Conservative process-local grouping, not a claim about the app's global limiter scope.
    if (observation.retryAfterAt && Date.parse(observation.retryAfterAt)>this.now())
      throw new ApiError(429,"MinusPod local request-group cooldown active",observation.retryAfterAt);
    observation.attempts++; observation.inFlight++;
    observation.lastAttemptAt=new Date(this.now()).toISOString();
    const headers: Record<string,string> = {
      "Content-Type":"application/json", "Accept":"application/json",
      // Cannot accidentally masquerade as Pocket Casts and trigger public JIT.
      "User-Agent":"minuspod-mcp (admin API only; no media fetching)",
    };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k,v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && this.cookies.has("minuspod_csrf"))
      headers["X-CSRF-Token"] = this.cookies.get("minuspod_csrf")!;
    try {
      const response = await this.fetcher(new URL("/api/v1"+path, this.base), {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect:"error", signal:options.signal??AbortSignal.timeout(this.timeoutMs),
      });
      observation.lastResponseAt=new Date(this.now()).toISOString();
      observation.lastHttpStatus=response.status;
      if (response.status===429) {
        observation.lastRateLimitAt=observation.lastResponseAt;
        const candidate=retryAfter(response.headers.get("retry-after"),this.now());
        // In-flight responses may arrive out of order. A shorter/missing header
        // must not erase a still-active cooldown already observed by this group.
        if (!observation.retryAfterAt || Date.parse(observation.retryAfterAt)<=this.now() ||
            (candidate && Date.parse(candidate)>Date.parse(observation.retryAfterAt))) {
          observation.retryAfterAt=candidate;
          observation.retryAfterObservedAt=candidate?observation.lastResponseAt:null;
        }
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status,undefined,response.status===429?observation.retryAfterAt:null);
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new Error("MinusPod returned a non-JSON response");
      }
      // Bound streamed bodies as well as declared Content-Length.
      if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
        await response.body?.cancel();
        throw new Error("MinusPod response exceeds the body limit");
      }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const {value,done} = await reader.read(); if (done) break;
        size += value.length;
        if (size > maxBytes) { await reader.cancel(); throw new Error("MinusPod response exceeds the body limit"); }
        chunks.push(value);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Unexpected API response");
      for (const cookie of response.headers.getSetCookie()) {
        const match = /^(session|minuspod_csrf)=([A-Za-z0-9_.-]*)(?:;|$)/.exec(cookie);
        if (match) {
          if (match[2]) this.cookies.set(match[1],match[2]);
          else this.cookies.delete(match[1]);
        }
      }
      return data;
    } catch (error) {
      observation.lastFailureAt=new Date(this.now()).toISOString();
      if (error instanceof ApiError) throw error;
      // Never propagate fetch/JSON/upstream error text or credential-bearing URLs.
      throw new Error("MinusPod transport/response failed; no write retry. Check local app health.");
    } finally { observation.inFlight--; }
  }
  private async login(): Promise<void> {
    if (this.cookies.has("session") && this.cookies.has("minuspod_csrf")) return;
    if (this.loginFlight) return this.loginFlight;
    if (this.now() < this.loginBlockedUntil) throw new Error(`MinusPod login cooling down after failure until ${new Date(this.loginBlockedUntil).toISOString()}`);
    this.loginFlight = (async () => {
      this.cookies.clear();
      try {
        const data = await this.request("POST","/auth/login",{password:this.password});
        if (data.authenticated !== true || !this.cookies.has("session") || !this.cookies.has("minuspod_csrf"))
          throw new Error("MinusPod did not establish an authenticated CSRF session");
      } catch {
        this.cookies.clear(); this.loginBlockedUntil = Math.max(this.now()+60000,
          Date.parse(this.observations.authentication.retryAfterAt??"")||0);
        throw new Error("MinusPod server-side login failed; verify the private app password locally");
      }
    })();
    try { await this.loginFlight; } finally { this.loginFlight = undefined; }
  }
  // Dedicated, validated GET capability: no arbitrary search params, provider
  // selection, settings reads/writes or direct PodcastIndex authentication.
  async searchPodcasts(input:PodcastSearchInput):Promise<Json> {
    const {query}=podcastSearchInput.parse(input);
    const signal=AbortSignal.timeout(Math.min(this.timeoutMs,PODCAST_SEARCH_TIMEOUT_MS));
    try {
      await waitWithSignal(this.login(),signal);
      for (let attempt=0;;attempt++) {
        signal.throwIfAborted();
        try {
          return await this.request("GET","/podcast-search?"+new URLSearchParams({q:query}),
            undefined,{signal,maxBytes:PODCAST_SEARCH_MAX_BYTES});
        } catch (error) {
          if (error instanceof ApiError && error.status===401) {
            this.cookies.clear();
            if (attempt===0) {
              signal.throwIfAborted();
              await waitWithSignal(this.login(),signal); continue;
            }
          }
          // No transient/transport/rate-limit retries for directory searches.
          throw error;
        }
      }
    } catch (error) {
      if (signal.aborted) throw new PodcastSearchError("Podcast Index search timed out; check the app locally before retrying.");
      if (error instanceof ApiError) {
        if (error.status===429) throw new PodcastSearchError("Podcast Index search rate limited by MinusPod (HTTP 429); wait before retrying. No automatic retry. "+
          (error.retryAfterAt?`Retry-After/cooldown until ${error.retryAfterAt}.`:"Retry-After/reset unknown."));
        if ([401,403].includes(error.status)) throw new PodcastSearchError("Podcast Index search authentication/permission failed; check the app locally.");
        if (error.status===503) throw new PodcastSearchError("Podcast Index search unavailable (HTTP 503); verify provider selection and configured credentials in MinusPod locally.");
        // The pinned proxy collapses provider errors (including 429/timeouts)
        // into 502, so do not claim we can distinguish them at this boundary.
        if (error.status===502) throw new PodcastSearchError("Podcast Index search provider unavailable (HTTP 502); MinusPod masks provider errors, throttling and timeouts. Check the app locally.");
      }
      throw new PodcastSearchError("Podcast Index search transport/response or login failed; check the app locally. No automatic retry.");
    }
  }
  async call(method: "GET"|"POST"|"PATCH", path: string, body?: Json): Promise<Json> {
    const pathname = path.split("?")[0];
    if (!this.validPath(method,path) || path.includes("#") || pathname.includes("%") ||
        pathname.includes("..") || /[\r\n]/.test(path)) throw new Error("API capability not allowed");
    await this.login();
    // Only GET may be retried, at most once. POST/PATCH ambiguities are fail-closed.
    for (let attempt=0;;attempt++) {
      try { return await this.request(method,path,body); }
      catch (error) {
        if (error instanceof ApiError && error.status === 401) this.cookies.clear();
        if (method !== "GET" || attempt > 0) throw error;
        if (error instanceof ApiError && error.status === 401) { await this.login(); continue; }
        if (!(error instanceof ApiError) || [408,502,503,504].includes(error.status)) continue;
        throw error;
      }
    }
  }
}
