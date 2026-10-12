/**
 * Server-side credentials only. Secure cookies are explicitly sent to ONE trusted
 * origin on the local Docker bridge, like homelab/minuspod/configure.py. Never
 * weaken the app's browser cookie policy. No redirects or inherited HTTP proxy.
 */
export class ApiError extends Error {
  constructor(public readonly status: number, message = "MinusPod API request failed") {
    super(`${message} (HTTP ${status}); inspect the app locally. Writes were not retried.`);
  }
}
type Json = Record<string, any>;
export class MinusPodClient {
  private cookies = new Map<string, string>();
  private loginFlight?: Promise<void>;
  private loginBlockedUntil = 0;
  private readonly base: URL;
  constructor(
    base: string, private readonly password: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 90000,
  ) {
    this.base = new URL(base);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username ||
        this.base.password || this.base.search || this.base.hash ||
        !["/", ""].includes(this.base.pathname) || !password) {
      throw new Error("Configure a trusted MinusPod origin and nonempty server-side password");
    }
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
  private async request(method: string, path: string, body?: Json): Promise<Json> {
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
        redirect:"error", signal:AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status);
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.body?.cancel();
        throw new Error("MinusPod returned a non-JSON response");
      }
      // Bound streamed bodies as well as declared Content-Length.
      if (Number(response.headers.get("content-length") ?? 0) > 8*1024*1024) {
        await response.body?.cancel();
        throw new Error("MinusPod response exceeds the 8 MiB limit");
      }
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const {value,done} = await reader.read(); if (done) break;
        size += value.length;
        if (size > 8*1024*1024) { await reader.cancel(); throw new Error("MinusPod response exceeds the 8 MiB limit"); }
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
      if (error instanceof ApiError) throw error;
      // Never propagate fetch/JSON/upstream error text or credential-bearing URLs.
      throw new Error("MinusPod transport/response failed; no write retry. Check local app health.");
    }
  }
  private async login(): Promise<void> {
    if (this.cookies.has("session") && this.cookies.has("minuspod_csrf")) return;
    if (this.loginFlight) return this.loginFlight;
    if (Date.now() < this.loginBlockedUntil) throw new Error("MinusPod login cooling down after failure");
    this.loginFlight = (async () => {
      this.cookies.clear();
      try {
        const data = await this.request("POST","/auth/login",{password:this.password});
        if (data.authenticated !== true || !this.cookies.has("session") || !this.cookies.has("minuspod_csrf"))
          throw new Error("MinusPod did not establish an authenticated CSRF session");
      } catch {
        this.cookies.clear(); this.loginBlockedUntil = Date.now()+60000;
        throw new Error("MinusPod server-side login failed; verify the private app password locally");
      }
    })();
    try { await this.loginFlight; } finally { this.loginFlight = undefined; }
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
