import { z } from "zod";
import type { MinusPodClient } from "./client.js";

type Obj = Record<string,any>;
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
const JOB_FIELDS = ["slug","episodeId","title","podcastName","stage","progress","startedAt",
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
function pick(obj:Obj, fields:string[]):Obj {
  return Object.fromEntries(fields.filter(key=>obj[key]===null ||
    ["string","number","boolean"].includes(typeof obj[key])).map(key=>[key,obj[key]]));
}
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
  name:string; description:string; schema:z.ZodType<any>;
  readOnly:boolean; destructive?:boolean; openWorld?:boolean;
  run:(input:any)=>Promise<Obj>;
};

/** Process-wide write lock, shared across SDK per-request server instances. */
export function makeTools(client:MinusPodClient, options:{
  paidEnabled?:boolean; feedHosts?:string[];
} = {}):Tool[] {
  let writing=false;
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
  const tools:Tool[] = [
    {name:"feeds_list",readOnly:true,description:"List subscribed feeds and refresh-error categories; credential-bearing URLs are omitted.",
      schema:z.strictObject({page,limit}),run:async a=>{
        const d=await get("/feeds"+query(a)); return {...pick(d,["page","limit","total","totalPages"]),
          feeds:d.feeds.map(projectFeed)};
      }},
    {name:"feed_get",readOnly:true,description:"Inspect one feed's safe settings and health. No security/provider credentials or URLs.",
      schema:z.strictObject({slug}),run:async a=>projectFeed(await get("/feeds/"+a.slug))},
    {name:"episodes_list",readOnly:true,description:"List one feed's episodes, status and error categories without media fetches or paid JIT work.",
      schema:z.strictObject({slug,limit,offset:z.number().int().min(0).max(100000).default(0),
        status:z.enum(["all","discovered","pending","processing","completed","failed","error","permanently_failed"]).default("all"),
        search:z.string().max(200).optional()}),run:async a=>{
        const {slug,...q}=a; const d=await get(`/feeds/${slug}/episodes`+query(q));
        return {...pick(d,["limit","offset","total"]),episodes:d.episodes.map(projectEpisode)};
      }},
    {name:"episode_get",readOnly:true,description:"Inspect one episode's metadata, processing status, ad counts and spend; no audio, prompts, raw errors or credential-bearing URLs.",
      schema:z.strictObject(episodeInput),run:async a=>{
        const d=await get(epPath(a)); const spendFields=["knownCostUsd","unknownCostCount","inputTokens","outputTokens",
          "totalCost","costUsd","costStatus","runId","usd","display","amount","currency","incomplete",
          "hasUnknownCost","breakdownAvailable","input_tokens","output_tokens","cost_usd","has_unknown_cost"];
        return {...projectEpisode(d),spend:{
          active:d.activeRunSpend ? pick(d.activeRunSpend,spendFields):null,
          latest:d.latestRunSpend ? pick(d.latestRunSpend,spendFields):null,
          cumulative:d.cumulativeSpend ? pick(d.cumulativeSpend,spendFields):null}};
      }},
    {name:"queue_get",readOnly:true,description:"Inspect active jobs, queue counts and holds. Does not probe providers or modify queue admission.",
      schema:z.strictObject({}),run:async()=>{
        const [s,q]=await Promise.all([get("/status"),get("/system/queue")]);
        return {processingPaused:s.processingPaused,queueLength:s.queueLength,
          jobs:(s.jobs??[]).map((j:Obj)=>pick(j,JOB_FIELDS)),
          queuedEpisodes:(s.queuedEpisodes??[]).map((j:Obj)=>pick(j,JOB_FIELDS)),
          hold:pick(s.hold??{},["queuePaused","holdUntil","holdSince","offlineHeld"]),
          queue:{...pick(q,["completed","deferred","failed","pending","processing","total"]),
            items:(q.items??[]).map((j:Obj)=>pick(j,JOB_FIELDS))}};
      }},
    {name:"errors_list",readOnly:true,description:"Inspect failed processing history, paginated. Error categories replace raw provider errors to prevent credential leakage. Use episodes_list status=error for current failures.",
      schema:z.strictObject({page,limit,slug:slug.optional()}),run:async a=>{
        const d=await get("/history"+query({page:a.page,limit:a.limit,status:"failed",podcast_slug:a.slug}));
        return {...pick(d,["page","limit","total","totalPages"]),history:d.history.map(projectHistory)};
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
    {name:"feed_update",readOnly:false,description:"Change ONE feed's display title/description or disable auto-processing. Strict allowlist; cannot enable auto-processing, change source, retention, models, providers or security.",
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
  return tools;
}
