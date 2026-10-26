# MinusPod MCP

Maintained MCP server for MinusPod, tested against **2.100.10-cpu**. TypeScript
SDK v2 `createServer()` factory; SDK-owned stdio and Streamable HTTP via Hono.
Source/image: https://github.com/justmytwospence/minuspod-mcp /
`ghcr.io/justmytwospence/minuspod-mcp:0.2.0`.

## Capabilities

| Tools | Scope |
| --- | --- |
| `podcast_search` | Read-only Podcast Index discovery: title, author, description, public feed URL, PodcastIndex ID |
| `feeds_list`, `feed_get` | Feed metadata, safe settings, refresh health |
| `episodes_list`, `episode_get` | Metadata, live job state, ad counts, per-episode spend |
| `queue_get`, `errors_list`, `spend_get` | Queue/holds, categorized failed history, aggregate spend/admission |
| `feed_add` | One HTTPS RSS source on operator-allowlisted hosts; auto-processing forced off before initial refresh |
| `feed_update` | Only titleOverride, description, autoProcessOverride=false |
| `feed_refresh` | One feed, only with explicit autoProcessOverride=false |
| `episode_cancel` | One currently queued/processing episode |
| `episode_process_paid` | One idle discovered/pending episode without prior processed output |
| `episode_retry_paid` | One idle failed/error/permanently_failed episode without prior processed output |

Paid tools are absent unless `MINUSPOD_ENABLE_PAID_OPERATIONS=true`. They call
the documented single-episode reprocess endpoint with fixed `mode=reprocess`;
no caller-selectable full/LLM/recut modes. They use existing models/routes/budgets,
may reset prior attempt state, and trigger paid transcription/provider work.
Completed or previously processed episodes cannot be reprocessed through MCP.

No deletion, bulk/OPML, arbitrary API paths/settings, audio/JIT fetching, global
settings, retention, models, providers, security, cleanup or shadow-session controls.
Pagination is bounded to 100 items. Writes are serialized across HTTP request
factories. Strict schemas reject unknown fields, including fake confirmation fields.
All tools declare titles, all four annotation hints, and runtime-validated output
schemas alongside matching JSON text/structured results. Safe projection fields
are optional scalar values to tolerate upstream field absence; nested/unrecognized
fields are omitted, not passed through. Display override replacement is destructive
and idempotent; other writes are non-idempotent. Remote app metadata reads are
closed-scope; directory/RSS/paid actions advertise open-world interaction.

### Podcast Index search

`podcast_search` accepts `query` (1–200 characters) and optional `limit` (1–10,
default 10). It calls MinusPod's authenticated `GET /api/v1/podcast-search?q=...`;
existing PodcastIndex credentials stay in MinusPod, with no new MCP secrets or
environment variables. Select **PodcastIndex.org** in the app's Podcast Search
settings and configure its credentials there if not already set. MCP never reads
or changes provider settings and refuses responses from iTunes/unknown providers
rather than mislabeling their IDs.

The pinned app uses `requote_uri` rather than query-component encoding when
forwarding search terms. MCP therefore rejects `&`, `%`, `#`, `+`, controls and
invalid Unicode, even though the first hop is encoded. Results are capped at 10;
title/author at 200 characters and description at 4,000. Malformed IDs and
suspicious feed URLs (credentials, queries, fragments, custom ports, IP literals,
local-looking hosts) are omitted, not rewritten. Embedded metadata URLs and
recognizable authorization/credential values are redacted. No returned feed or
artwork URL is fetched; directory content is untrusted data, not instructions.
Discovery does not subscribe, change the existing `feed_add` HTTPS/host allowlist,
or trigger processing/paid actions.

Search has a **30-second total deadline**, including waiting for login and any
single 401 re-authentication, and a **1 MiB** response-body limit. It never retries
transport/transient errors or HTTP 429 automatically. MinusPod limits this route
to 30 requests/minute; a 429 becomes a fixed rate-limit error. The pinned app
masks PodcastIndex errors (including provider throttling/timeouts) as HTTP 502,
so MCP reports that ambiguity without echoing raw errors. HTTP 503 advises
checking app-side provider/credentials locally. No production search is needed
for the offline tests.

### Approval is client-dependent

OAuth consent authenticates a client; it does **not** approve each paid call.
Tool annotations are hints, not proof a human confirmed. Paid tools and cancellation
advertise `readOnlyHint=false`, `destructiveHint=true`; paid tools also advertise
`openWorldHint=true`, `idempotentHint=false`. A model could issue multiple
single-episode calls; this is not a hard spending cap. Existing app/provider
admission and external provider budgets remain the final monetary limits.

Use Hermes `trust: untrusted` to request approval for each non-read-only tool.
NanoClaw's current `bypassPermissions` flow does not guarantee such approval;
do not rely on a prompt saying “ask first.” For unattended clients that must never
spend, leave paid tools disabled or enforce tool-level permission/approval in the
client or its gateway. The server itself cannot verify a human approved a call.

## Resources, templates and review prompts

Discovery and prompt retrieval never contact MinusPod, log in, probe a provider,
fetch media or run a write. All use the same authenticated MCP transport as tools.

| Resource | Base request cost on read |
| --- | --- |
| `minuspod://usage` | 0; usage, bounds, backoff and monetary-safety guide |
| `minuspod://capabilities` | 0; exposed tools and paid enablement, no provider/settings credentials |
| `minuspod://status` | 0; cached process-local attempt counters, timestamps, last observations and login cooldown |
| `minuspod://queue` | 2 app metadata GETs; jobs, counts and app-maintenance holds |
| `minuspod://spend` | 2 app metadata GETs; aggregate LLM spend and existing monetary admission state |
| `minuspod:feeds/{slug}` | 1 app metadata GET; sanitized feed projection |
| `minuspod:feeds/{slug}/episodes/{episodeId}` | 1 app metadata GET; sanitized episode and per-run spend |
| `minuspod:feeds/{slug}/episodes?limit={limit}&offset={offset}` | 1 app metadata GET; one explicit bounded page |

These base costs exclude login and at most one retry per metadata GET. Each
constituent call may add an initial login and a 401 re-login; concurrent requests
coalesce authentication. `observedAt` is receipt time, not a provider refresh time;
two-endpoint queue/spend reads are non-atomic and fail without a partial result
if either request fails. Cached status is not app health and does not refresh data.
Counters include failed attempts/retries since this process started, not other
clients. An old last HTTP status may precede a newer transport/response failure.

Templates deliberately use opaque `minuspod:feeds/` URIs to avoid the SDK's
hierarchical URL dot-segment normalization. They accept only the same literal
safe slugs/episode IDs as tools; pagination
requires canonical decimal limit 1–100 and offset 0–100000, with no extra query
parameters. Arrays are defensively capped with explicit truncation flags (queue
arrays at 100, lists at the requested limit), text is bounded, and metadata-embedded
URLs/recognizable credentials are redacted. Response slicing does not bound the
upstream app's work. Pagination totals, when supplied, come from the app; one page
is not full coverage. No template exposes audio, transcripts or raw provider errors.
Only `podcast_search` can return separately validated public directory feed URLs.

`failure-triage` and `paid-action-review` take one `slug` and `episodeId`. They return
review-only checklists, including read costs, stale/unknown state, eligibility,
monetary uncertainty and ambiguous-write recovery. They do not read resources,
execute tools, authorize a write or imply a human confirmed. The paid review is
available with paid tools disabled and explicitly states those tools are absent.

### Three separate kinds of limits

- **App metadata requests:** general quota/remaining/reset are unknown. Use cached
  status first, bounded pages next, and avoid rapid polling or unbounded fan-out.
- **Directory search:** the pinned app route is 30/minute, not a known PodcastIndex
  provider quota or remaining allowance. Search has no transient/429 retry, and
  HTTP 502 can mask provider throttling/timeouts. It does not spend a processing budget.
- **Monetary processing admission:** existing daily budgets, active reservations,
  known/unknown spend and provider policy are separate from HTTP quotas. Aggregate
  LLM spend is not a complete transcription/provider cost estimate or a hard MCP cap.

Status records last 429 observation and validated `Retry-After` times from app
responses only (integer seconds or canonical RFC 1123 HTTP-date); no direct
provider-header visibility is
claimed. A known 429 cooldown blocks further attempts conservatively in the same
local request group (authentication, metadata read/write, directory search), not
an invented authoritative app-wide limiter. Missing/invalid reset headers remain
unknown, not a fabricated wait/allowance. After expiry the historical observation
remains visible; it is not proof quota is available. Failed login applies a local
60-second cooldown, or a longer observed `Retry-After`. These observations contain
no request URLs, paths, queries, credentials, cookies or raw errors.

Write base costs: feed add/update are 1 POST/PATCH respectively; refresh, cancel
and paid tools are 1 preflight GET + 1 POST. Feed add/refresh can fetch RSS; only
paid tools can request paid episode processing. No write is automatically replayed,
including on authentication failure, rate limiting or a lost response.

## Authentication and privacy

Only the backend holds `MINUSPOD_ADMIN_PASSWORD`. It logs in at
`/api/v1/auth/login`, keeps session/CSRF cookies **in memory**, and echoes
`X-CSRF-Token` on writes. Secure cookies are explicitly sent over the trusted
local Docker bridge to the one configured origin; browser cookie security is
unchanged. Configure a trusted origin only. No redirect following, inherited
proxy, credential-bearing agent headers, persistent session state or new backup
volume. The backend's app password still grants broad app privileges: protect
Docker/network access; these capability restrictions are implemented by MCP.

Responses project allowlisted metadata and financial fields. Authenticated feed,
signed audio and source URLs, raw provider errors, prompts/responses and secret
settings are omitted. Errors become fixed categories; detailed diagnostics stay
in the app. Non-search requests time out after 90 seconds; bodies are bounded to
8 MiB. Only GET can retry once (401 re-login or transient/transport failure);
search uses the stricter limits above and retries only a single 401. No write
is ever replayed. After an ambiguous write, inspect state before acting again.
Failed login has a local cooldown of at least 60 seconds.

## Deployment

```sh
cp .env.example .env
# Fill only server-side values, then deploy behind an OAuth resource sidecar.
docker compose up -d
```

No host port is published. Place on MinusPod's existing private Docker app
network. The homelab currently uses `traefik` as that bridge, without adding or
recreating its existing app. Agentgateway alone owns
`https://minuspod.mcp.spencerboucher.com/mcp`, validating Authelia JWT access
tokens for exactly that resource audience and stripping them before proxying.
The backend has no Traefik labels. Set `MCP_ALLOWED_HOSTS` to the public
hostname and `minuspod-mcp` (DNS-rebinding protection).

Stdio: supply the same environment and run `npm start`; HTTP:
`MCP_TRANSPORT=http MCP_ALLOWED_HOSTS=minuspod-mcp npm start`. Port defaults to 8000.

## Development and releases

```sh
npm ci --ignore-scripts
npm test
```

No test contacts production or triggers paid work. Tests cover secure-cookie/CSRF
handling, login coalescing/cooldown, timeouts, body bounds, no write retries,
strict inputs, credential-free projections, paid eligibility, safe feed writes,
write concurrency, SDK handshake/list/call and tool annotations. Search tests
cover query injection, provider identity, bounded projections, unsafe URLs,
metadata/error redaction, rate limits, body limits and total deadlines. Discovery
contract tests exercise initialization, resources/templates/prompts, zero-call cached
status, request costs, URI bounds, output schemas, truncation, metadata redaction,
paid-disabled behavior, fake-clock cooldowns and exact HTTP-attempt accounting.
Dependencies are exact pins selected from releases at least seven days old.
`vX.Y.Z` tags publish multi-architecture GHCR images via the Hardcover workflow
pattern; CI and release both run tests.

Fresh contract review: MinusPod [v2.100.10 API docs](https://github.com/ttlequals0/MinusPod/blob/v2.100.10/docs/api-and-webhooks.md),
[OpenAPI](https://github.com/ttlequals0/MinusPod/blob/v2.100.10/openapi.yaml),
[pinned route source](https://github.com/ttlequals0/MinusPod/tree/v2.100.10/src/api),
[current API docs](https://github.com/ttlequals0/MinusPod/blob/main/docs/api-and-webhooks.md),
[search route](https://github.com/ttlequals0/MinusPod/blob/v2.100.10/src/api/podcast_search.py),
[PodcastIndex current API specification](https://podcastindex-org.github.io/docs-api/pi_api.json),
and SDK [Hono](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/hono.md).
Revalidate the contract on future MinusPod upgrades.
