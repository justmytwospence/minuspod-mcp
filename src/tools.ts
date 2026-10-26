import { z } from "zod";
import type { MinusPodClient } from "./client.js";
import {podcastSearchInput, projectPodcastSearch} from "./podcast-search.js";
import {fields, pick, rows, MAX_ITEMS, type Obj} from "./contracts.js";
export const slug = z.string().regex(/^[a-z0-9-]{1,200}$/);
export const episodeId = z.string().regex(/^(?:[a-f0-9]{12}|s[0-9]{2,3}e[0-9]{2,4})$/);
const episodeInput = {slug, episodeId};
const page = z.number().int().min(1).max(10000).default(1);
const limit = z.number().int().min(1).max(100).default(25);
export const safeFeedPatch = z.strictObject({
  titleOverride:z.string().trim().min(1).max(200).nullable().optional(),
  description:z.string().max(4000).optional(),
  // Disable only; neither true nor null may re-enable inherited paid processing.
  autoProcessOverride:z.literal(false).optional(),
}).refine(value => Object.keys(value).length > 0, "Supply at least one allowed setting");

const FEED_FIELDS = ["slug","title","titleOverride","description","feedType","episodeCount",
  "processedCount","statusCounts","lastRefreshed","lastRefreshErrorAt","autoProcessOverride",
  "maxEpisodes","processingMode","queuePriority","onlyExposeProcessedEpisodes"];
const EP_FIELDS = ["id","episodeId","title","status","jobState","published","duration",
  "originalDuration","newDuration","timeSaved","adsRemoved","processedAt","hasBeenProcessed",
  "hasOriginalAudio","titleSkipped","descriptionSkipped","durationSkipped","transcriptAvailable",
  "chaptersAvailable","adDetectionStatus","pendingReviewCount"];
const JOB_FIELDS = ["id","slug","podcastSlug","episodeId","title","podcastName","stage","progress","startedAt",
  "elapsed","status","priority","attempts","createdAt","updatedAt"];
const HISTORY_FIELDS = ["id","podcastSlug","podcastName","episodeId","episodeTitle","processedAt",
  "processingDurationSeconds","status","adsDetected","reprocessNumber"];
const STAT_FIELDS = ["totalEpisodesProcessed","totalRuns","totalLlmCost","totalInputTokens",
  "totalOutputTokens","totalTimeSavedSeconds","totalAdsRemoved","avgCostPerEpisode",
  "maxCostPerEpisode","avgProcessingTimeSeconds","avgTimeSavedSeconds"];
const BUDGET_FIELDS = ["enabled","dailyLimit","dailyLimitMicrousd","displayCurrency",
  "maxReservations","unknownCost","unknownReserve","unknownReserveMicrousd"];
const query = (values:Obj) => {
  const pairs=Object.entries(values).filter(([,v])=>v!==undefined);
  return pairs.length ? "?"+new URLSearchParams(pairs.map(([k,v])=>[k,String(v)])) : "";
};
// Raw provider/refresh errors may quote headers, signed URLs or keys. Return only
// fixed categories, never their original message; detailed diagnosis stays local.
function errorCategory(value:unknown):string|null {
  if (!value) return null;
  const s=String(value).toLowerCase();
  if (/429|rate.limit/.test(s)) return "rate_limited";
  if (/timeout|timed.out/.test(s)) return "timeout";
  if (/401|403|auth|credential/.test(s)) return "authentication_or_permission";
  if (/budget|cost|reservation/.test(s)) return "budget_or_admission";
  if (/transcri|whisper/.test(s)) return "transcription";
  if (/feed|fetch|rss/.test(s)) return "feed_fetch";
  return "processing_error";
}
export const projectFeed = (obj:Obj) => ({...pick(obj,FEED_FIELDS),
  statusCounts:pick(obj.statusCounts??{},["discovered","pending","processing","completed","failed","error","permanently_failed"]),
  refreshErrorCategory:errorCategory(obj.lastRefreshError)});
export const projectEpisode = (obj:Obj) => ({...pick(obj,EP_FIELDS),
  errorCategory:errorCategory(obj.error)});
const projectHistory = (obj:Obj) => ({...pick(obj,HISTORY_FIELDS),
  errorCategory:errorCategory(obj.errorMessage)});
const message = (text:string) => ({message:text});
export type Tool = {
  name:string; title:string; description:string; schema:z.ZodType<any>; outputSchema:z.ZodType<any>;
  readOnly:boolean; destructive:boolean; idempotent:boolean; openWorld:boolean;
  run:(input:any)=>Promise<Obj>;
};
type Definition = Omit<Tool,"title"|"outputSchema"|"destructive"|"idempotent"|"openWorld"> &
  Partial<Pick<Tool,"destructive"|"idempotent"|"openWorld">>;
export type ToolSet = Tool[] & {localStatus:()=>Obj};
const counts=["discovered","pending","processing","completed","failed","error","permanently_failed"];
const spendFields=["knownCostUsd","unknownCostCount","inputTokens","outputTokens","totalCost","costUsd",
  "costStatus","runId","usd","display","amount","currency","incomplete","hasUnknownCost","breakdownAvailable",
  "input_tokens","output_tokens","cost_usd","has_unknown_cost"];
const episodeSchema=fields(EP_FIELDS).extend({errorCategory:z.string().nullable()});
const feedSchema=fields(FEED_FIELDS).extend({statusCounts:fields(counts),refreshErrorCategory:z.string().nullable()});
const pagination=fields(["page","limit","offset","total","totalPages"]).extend({returned:z.number().int().min(0).max(MAX_ITEMS),truncated:z.boolean()});
const jobList=z.array(fields(JOB_FIELDS)).max(MAX_ITEMS);
const outputSchemas:Record<string,z.ZodType<any>>={
  podcast_search:z.strictObject({provider:z.literal("podcastindex"),results:z.array(z.strictObject({
    podcastIndexId:z.number().int().positive(),title:z.string().max(200),author:z.string().max(200),
    description:z.string().max(4000),feedUrl:z.string().url().max(2048),})).max(10)}),
  feeds_list:pagination.extend({feeds:z.array(feedSchema).max(MAX_ITEMS)}),
  feed_get:feedSchema,
  episodes_list:pagination.extend({episodes:z.array(episodeSchema).max(MAX_ITEMS)}),
  episode_get:episodeSchema.extend({spend:z.strictObject({active:fields(spendFields).nullable(),
    latest:fields(spendFields).nullable(),cumulative:fields(spendFields).nullable()})}),
  queue_get:fields(["processingPaused","queueLength"]).extend({jobs:jobList,queuedEpisodes:jobList,
    jobsTruncated:z.boolean(),queuedEpisodesTruncated:z.boolean(),
    hold:fields(["queuePaused","holdUntil","holdSince","offlineHeld"]),
    queue:fields(["completed","deferred","failed","pending","processing","total"]).extend({items:jobList,itemsTruncated:z.boolean()})}),
  errors_list:pagination.extend({history:z.array(fields(HISTORY_FIELDS).extend({errorCategory:z.string().nullable()})).max(MAX_ITEMS)}),
  spend_get:z.strictObject({stats:fields(STAT_FIELDS),budget:fields(BUDGET_FIELDS).extend({
    status:fields(["activeReservations","provider","reservedMicrousd","spentMicrousd"])})}),
  feed_add:fields(["slug"]).extend({message:z.string()}),
  feed_update:z.strictObject({message:z.string()}),
  feed_refresh:fields(["slug","episodeCount","lastRefreshed"]).extend({outcome:fields(["status","newEpisodes","queuedEpisodes","new_episodes","queued_episodes"])}),
  episode_cancel:z.strictObject({message:z.string()}),
  episode_process_paid:fields(["episodeId","mode","status","jobState"]).extend({message:z.string()}),
  episode_retry_paid:fields(["episodeId","mode","status","jobState"]).extend({message:z.string()}),
};
const costs:Record<string,string>={
  podcast_search:"1 directory GET; pinned app route throttle 30/minute, not a monetary budget or known PodcastIndex quota. At most one 401 replay plus authentication; provider 502 may mask throttling/timeouts.",
  queue_get:"2 app metadata GETs; no provider probe or paid processing.",
  spend_get:"2 app metadata GETs; amounts/reservations are monetary admission state, not API quotas or complete transcription cost guarantees.",
  feed_add:"1 app POST plus app-side initial RSS refresh; no paid processing. No write replay.",
  feed_update:"1 app PATCH replacing supplied display overrides; no write replay.",
  feed_refresh:"1 preflight app GET + 1 POST and RSS fetch; no write replay.",
  episode_cancel:"1 preflight app GET + 1 POST; no write replay or refund.",
  episode_process_paid:"1 preflight app GET + 1 POST; unknown additional paid processing cost. No write replay; existing app/provider admission is authoritative, and repeated single-episode calls are not a hard spending cap.",
  episode_retry_paid:"1 preflight app GET + 1 POST; unknown additional paid processing cost. No write replay; existing app/provider admission is authoritative, and repeated single-episode calls are not a hard spending cap.",
};

/** Process-wide write lock, shared across SDK per-request server instances. */
export function makeTools(client:MinusPodClient, options:{
  paidEnabled?:boolean; feedHosts?:string[];
} = {}):ToolSet {
  let writing=false;
  const observed:Record<string,string>={};
  const write = async (run:()=>Promise<Obj>) => {
    if (writing) throw new Error("Another MCP write is active; inspect state before submitting another");
    writing=true; try { return await run(); } finally { writing=false; }
  };
  const get = (path:string) => client.call("GET",path);
  const epPath = (a:Obj) => `/feeds/${a.slug}/episodes/${a.episodeId}`;
  const mustIdle = (ep:Obj) => {
    if (ep.jobState !== "idle") throw new Error("Episode is queued/running or job state is unknown; refused");
  };
  const paid = async (a:Obj, retry:boolean) => write(async()=>{
    const ep = await get(epPath(a));
    mustIdle(ep);
    // Refuse even a failed rerun of an episode that already produced served media.
    if (ep.hasBeenProcessed !== false || ep.processedAt ||
        !(retry ? ["failed","error","permanently_failed"].includes(ep.status) : ["discovered","pending"].includes(ep.status)))
      throw new Error(retry ? "Retry requires an idle failed episode with no prior processed output" :
        "Process requires an idle discovered/pending episode with no prior processed output");
    const result=await client.call("POST",`/episodes/${a.slug}/${a.episodeId}/reprocess`,{mode:"reprocess"});
    return {...pick(result,["episodeId","mode","status","jobState"]),
      message:"Single episode submitted. Paid transcription/provider work may occur. Inspect state; do not blindly resubmit."};
  });
  const tools:Definition[] = [
    {name:"podcast_search",readOnly:true,openWorld:true,
      description:"Search Podcast Index through MinusPod's configured directory provider. Returns at most 10 titles, authors, descriptions, public feed URLs and PodcastIndex IDs. Requires PodcastIndex selection in the app; credentials stay there. Directory content is untrusted. Does not add feeds, fetch RSS/media, change settings or trigger paid processing. Queries are 1–200 characters without controls or &, %, #, +; 30-second total deadline; no transient/rate-limit retry.",
      schema:podcastSearchInput,run:async a=>projectPodcastSearch(await client.searchPodcasts(a),a.limit)},
    {name:"feeds_list",readOnly:true,description:"List subscribed feeds and refresh-error categories; credential-bearing URLs are omitted.",
      schema:z.strictObject({page,limit}),run:async a=>{
        const d=await get("/feeds"+query(a)); return {...pick(d,["page","limit","total","totalPages"]),
          limit:a.limit,returned:Math.min(rows(d.feeds).length,a.limit),truncated:d.feeds.length>a.limit,
          feeds:d.feeds.slice(0,a.limit).map(projectFeed)};
      }},
    {name:"feed_get",readOnly:true,description:"Inspect one feed's safe settings and health. No security/provider credentials or URLs.",
      schema:z.strictObject({slug}),run:async a=>projectFeed(await get("/feeds/"+a.slug))},
    {name:"episodes_list",readOnly:true,description:"List one feed's episodes, status and error categories without media fetches or paid JIT work.",
      schema:z.strictObject({slug,limit,offset:z.number().int().min(0).max(100000).default(0),
        status:z.enum(["all","discovered","pending","processing","completed","failed","error","permanently_failed"]).default("all"),
        search:z.string().max(200).optional()}),run:async a=>{
        const {slug,...q}=a; const d=await get(`/feeds/${slug}/episodes`+query(q));
        return {...pick(d,["limit","offset","total"]),limit:a.limit,offset:a.offset,
          returned:Math.min(rows(d.episodes).length,a.limit),truncated:d.episodes.length>a.limit,
          episodes:d.episodes.slice(0,a.limit).map(projectEpisode)};
      }},
    {name:"episode_get",readOnly:true,description:"Inspect one episode's metadata, processing status, ad counts and spend; no audio, prompts, raw errors or credential-bearing URLs.",
      schema:z.strictObject(episodeInput),run:async a=>{
        const d=await get(epPath(a));
        return {...projectEpisode(d),spend:{
          active:d.activeRunSpend ? pick(d.activeRunSpend,spendFields):null,
          latest:d.latestRunSpend ? pick(d.latestRunSpend,spendFields):null,
          cumulative:d.cumulativeSpend ? pick(d.cumulativeSpend,spendFields):null}};
      }},
    {name:"queue_get",readOnly:true,description:"Inspect active jobs, queue counts and holds. Does not probe providers or modify queue admission.",
      schema:z.strictObject({}),run:async()=>{
        const [s,q]=await Promise.all([get("/status"),get("/system/queue")]);
        const jobs=rows(s.jobs,true),queued=rows(s.queuedEpisodes,true),items=rows(q.items,true);
        return {...pick(s,["processingPaused","queueLength"]),
          jobs:jobs.slice(0,MAX_ITEMS).map(j=>pick(j,JOB_FIELDS)),jobsTruncated:jobs.length>MAX_ITEMS,
          queuedEpisodes:queued.slice(0,MAX_ITEMS).map(j=>pick(j,JOB_FIELDS)),queuedEpisodesTruncated:queued.length>MAX_ITEMS,
          hold:pick(s.hold??{},["queuePaused","holdUntil","holdSince","offlineHeld"]),
          queue:{...pick(q,["completed","deferred","failed","pending","processing","total"]),
            items:items.slice(0,MAX_ITEMS).map(j=>pick(j,JOB_FIELDS)),itemsTruncated:items.length>MAX_ITEMS}};
      }},
    {name:"errors_list",readOnly:true,description:"Inspect failed processing history, paginated. Error categories replace raw provider errors to prevent credential leakage. Use episodes_list status=error for current failures.",
      schema:z.strictObject({page,limit,slug:slug.optional()}),run:async a=>{
        const d=await get("/history"+query({page:a.page,limit:a.limit,status:"failed",podcast_slug:a.slug}));
        return {...pick(d,["page","limit","total","totalPages"]),limit:a.limit,
          returned:Math.min(rows(d.history).length,a.limit),truncated:d.history.length>a.limit,
          history:d.history.slice(0,a.limit).map(projectHistory)};
      }},
    {name:"spend_get",readOnly:true,description:"Read aggregate LLM spend and existing provider admission/budget state. No model/provider/security settings are writable.",
      schema:z.strictObject({slug:slug.optional()}),run:async a=>{
        const [stats,b]=await Promise.all([get("/stats/dashboard"+query({podcast_slug:a.slug})),get("/settings/provider-budget")]);
        return {stats:pick(stats,STAT_FIELDS),budget:{...pick(b,BUDGET_FIELDS),
          status:pick(b.status??{},["activeReservations","provider","reservedMicrousd","spentMicrousd"])}};
      }},
    {name:"feed_add",readOnly:false,openWorld:true,description:"Add ONE public HTTPS RSS feed from an operator-allowlisted host. Always autoProcessOverride=false before its initial refresh; never enables paid automatic processing. No local/private/authenticated feeds or OPML.",
      schema:z.strictObject({sourceUrl:z.string().url().max(2048),slug,maxEpisodes:z.number().int().min(10).max(500).default(50)}),
      run:async a=>write(async()=>{
        const url=new URL(a.sourceUrl);
        if (url.protocol!=="https:" || url.username || url.password || url.search || url.hash ||
            (url.port && url.port!=="443") || !(options.feedHosts??[]).includes(url.hostname))
          throw new Error("RSS source must be HTTPS on an operator-allowlisted host, without credentials, query, fragment or custom port");
        const d=await client.call("POST","/feeds",{...a,autoProcessOverride:false});
        return {...pick(d,["slug"]),...message("Feed added with auto-processing disabled; initial RSS refresh attempted. Inspect the feed before retrying.")};
      })},
    {name:"feed_update",readOnly:false,destructive:true,idempotent:true,description:"Change ONE feed's display title/description or disable auto-processing. Strict allowlist; cannot enable auto-processing, change source, retention, models, providers or security.",
      schema:z.strictObject({slug,settings:safeFeedPatch}),run:async a=>write(async()=>{
        await client.call("PATCH","/feeds/"+a.slug,a.settings);
        return message("Allowed feed settings updated. All other settings are unchanged.");
      })},
    {name:"feed_refresh",readOnly:false,openWorld:true,description:"Refresh ONE feed's RSS only when its autoProcessOverride is explicitly false. Refuses inherited/enabled automatic processing to avoid paid bulk work; never forces a full refresh.",
      schema:z.strictObject({slug}),run:async a=>write(async()=>{
        const f=await get("/feeds/"+a.slug);
        if (f.autoProcessOverride!==false) throw new Error("Refresh refused: set this feed's autoProcessOverride=false first, or refresh in the app");
        const d=await client.call("POST",`/feeds/${a.slug}/refresh`,{});
        return {...pick(d,["slug","episodeCount","lastRefreshed"]),outcome:pick(d.outcome??{},
          ["status","newEpisodes","queuedEpisodes","new_episodes","queued_episodes"])};
      })},
    {name:"episode_cancel",readOnly:false,destructive:true,description:"Cancel ONE currently queued/running episode. May interrupt work and leave partial state; costs already incurred are not refunded. Does not clear the queue or any shadow sessions.",
      schema:z.strictObject(episodeInput),run:async a=>write(async()=>{
        const ep=await get(epPath(a));
        if (!["queued","running","processing"].includes(ep.jobState)) throw new Error("Cancel requires a currently queued/running episode");
        await client.call("POST",epPath(a)+"/cancel",{});
        return message("Cancellation requested for one episode; inspect its status. Incurred spend is not refunded.");
      })},
  ];
  if (options.paidEnabled) tools.push(
    {name:"episode_process_paid",readOnly:false,destructive:true,openWorld:true,
      description:"PAID WORK: start transcription and LLM/provider processing for ONE idle discovered/pending episode without prior processed output, using EXISTING app models/routes/budgets. May reset prior attempt state. No completed-episode reprocess, modes or bulk. Client must require user approval if desired; annotation is not server-enforced confirmation.",
      schema:z.strictObject(episodeInput),run:a=>paid(a,false)},
    {name:"episode_retry_paid",readOnly:false,destructive:true,openWorld:true,
      description:"PAID WORK: retry ONE idle failed episode that has never produced processed output. Resets failed attempt state and starts transcription and LLM/provider work with existing app configuration. No completed-episode reprocess, modes or bulk. Client approval is client-dependent; the server cannot verify a human confirmed.",
      schema:z.strictObject(episodeInput),run:a=>paid(a,true)},
  );
  const registered=tools.map(definition=>({
    ...definition,
    title:definition.name.split("_").map(word=>word[0].toUpperCase()+word.slice(1)).join(" "),
    destructive:definition.destructive??false,idempotent:definition.idempotent??definition.readOnly,
    openWorld:definition.openWorld??false,outputSchema:outputSchemas[definition.name],
    description:definition.description+" Request cost: "+(costs[definition.name]??"1 app metadata GET; no directory/provider/media fetch or paid processing.")+" Metadata GETs may retry once after 401 or transient/transport failure; each constituent call can add an initial login and one GET 401 re-login. No automatic 429 retry; honor observed Retry-After/cooldown, otherwise wait and inspect locally. Use bounded pages, not polling loops.",
    run:async(input:unknown)=>{
      const result=outputSchemas[definition.name].safeParse(await definition.run(definition.schema.parse(input)));
      if (!result.success) throw new Error("Unexpected MinusPod metadata result; inspect the app locally. No write retry.");
      observed[definition.name]=new Date().toISOString();
      return result.data;
    },
  })) as ToolSet;
  registered.localStatus=()=>({paidEnabled:options.paidEnabled===true,writeActive:writing,
    lastSuccessfulReads:Object.fromEntries(Object.entries(observed).filter(([name])=>tools.find(t=>t.name===name)?.readOnly)),
    guidance:"Zero-request cached observations, not current app/provider health or authoritative quota. Metadata quota unknown; directory route 30/minute is separate from unknown PodcastIndex quota. Monetary admission is separate: known LLM spend may omit transcription/unknown costs; reservations are not settled spend. One episode per call is not a hard spending cap; paid disabled by default. Honor observed cooldowns, avoid polling loops and never replay an ambiguous write. Usage resource lists templates/prompts and costs.",
    requests:client.localStatus?.()??null});
  return registered;
}
