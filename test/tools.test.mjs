import test from "node:test";
import assert from "node:assert/strict";
import {createMcpHandler} from "@modelcontextprotocol/server";
import {makeTools,projectFeed,projectEpisode} from "../dist/tools.js";
import {buildServer} from "../dist/server.js";

function fixture(data={},paidEnabled=true) {
  const calls=[];
  const tools=makeTools({call:async(method,path,body)=>{
    calls.push({method,path,body}); return typeof data==="function"?data(method,path,body):data;
  }},{paidEnabled,feedHosts:["feeds.megaphone.fm"]});
  const call=async(name,input={})=>{
    const tool=tools.find(t=>t.name===name);return tool.run(tool.schema.parse(input));
  };
  return {tools,calls,call};
}
const input={slug:"show",episodeId:"abcdef123456"};
const eligible={id:input.episodeId,status:"discovered",jobState:"idle",hasBeenProcessed:false,processedAt:null};
test("paid capabilities disabled by default and contain no arbitrary/bulk/global tools",()=>{
  const tools=makeTools({call:async()=>({})});
  assert.equal(tools.length,11);assert.ok(tools.every(t=>!t.name.includes("paid")));
  const f=fixture();assert.equal(f.tools.length,13);
  assert.ok(f.tools.every(t=>!/delete|bulk|clear|model|provider|security/.test(t.name)));
});
test("all mutating tools have explicit annotation inputs and paid descriptions",()=>{
  for (const t of fixture().tools.filter(t=>t.name.includes("_paid"))) {
    assert.equal(t.readOnly,false);assert.equal(t.destructive,true);
    assert.match(t.description,/PAID WORK/);assert.match(t.description,/ONE/);
  }
});
for (const bad of ["../show","show%2fapi","SHOW","a/b","", "x".repeat(201)]) test("invalid slug "+bad.slice(0,10),async()=>{
  const f=fixture();await assert.rejects(f.call("episode_process_paid",{...input,slug:bad}));
  assert.equal(f.calls.length,0);
});
for (const bad of ["../foo","abc","abcdef123456/..","s1e2","ABCDEF123456"]) test("invalid episode ID "+bad,async()=>{
  const f=fixture();await assert.rejects(f.call("episode_process_paid",{...input,episodeId:bad}));
  assert.equal(f.calls.length,0);
});
test("strict tools reject mode, paid confirmation fakery and bulk lists",async()=>{
  const f=fixture(eligible);
  for (const extra of [{mode:"full"},{confirm:true},{episodeIds:[input.episodeId]}])
    await assert.rejects(f.call("episode_process_paid",{...input,...extra}));
  assert.equal(f.calls.length,0);
});
test("process submits exactly one existing-config reprocess",async()=>{
  const f=fixture((method)=>method==="GET"?eligible:{status:"processing",jobState:"processing",episodeId:input.episodeId});
  const d=await f.call("episode_process_paid",input);assert.equal(d.status,"processing");
  assert.deepEqual(f.calls[1],{method:"POST",path:"/episodes/show/abcdef123456/reprocess",body:{mode:"reprocess"}});
});
test("retry supports pinned permanently_failed and fails without explicit unprocessed history",async()=>{
  for (const status of ["failed","error","permanently_failed"]) {
    const f=fixture((method)=>method==="GET"?{...eligible,status}:{status:"queued"});
    await f.call("episode_retry_paid",input);assert.equal(f.calls.length,2);
  }
});
for (const patch of [
  {status:"completed"},{status:"processing"},{status:"unknown"},
  {jobState:"queued"},{jobState:"processing"},{jobState:undefined},
  {hasBeenProcessed:true},{hasBeenProcessed:undefined},{processedAt:"2026-01-01"},
]) test("paid preflight refuses "+JSON.stringify(patch),async()=>{
  const f=fixture({...eligible,...patch});
  await assert.rejects(f.call("episode_process_paid",input));
  assert.equal(f.calls.filter(c=>c.method!=="GET").length,0);
});
test("retry refuses completed and previously processed failures",async()=>{
  for (const ep of [{...eligible,status:"completed"},{...eligible,status:"failed",hasBeenProcessed:true}]) {
    const f=fixture(ep);await assert.rejects(f.call("episode_retry_paid",input));assert.equal(f.calls.length,1);
  }
});
test("feed add forces auto-processing off before initial refresh and drops URLs/secrets",async()=>{
  const f=fixture({slug:"new-show",sourceUrl:"secret",feedUrl:"?key=SECRET",password:"SECRET"});
  const d=await f.call("feed_add",{slug:"new-show",sourceUrl:"https://feeds.megaphone.fm/show"});
  assert.deepEqual(f.calls[0].body,{slug:"new-show",sourceUrl:"https://feeds.megaphone.fm/show",maxEpisodes:50,autoProcessOverride:false});
  assert.ok(!JSON.stringify(d).includes("SECRET"));
});
for (const sourceUrl of ["http://feeds.megaphone.fm/show","https://127.0.0.1/feed",
  "https://evil.example/feed","https://user:pass@feeds.megaphone.fm/feed",
  "https://feeds.megaphone.fm/show?key=secret","https://feeds.megaphone.fm:8080/feed"])
  test("feed source refused "+sourceUrl,async()=>{
    const f=fixture();await assert.rejects(f.call("feed_add",{slug:"new",sourceUrl}));assert.equal(f.calls.length,0);
  });
test("feed patch strict allowlist rejects auto-enable/inherit, security, models, retention, URLs and empty",async()=>{
  for (const settings of [{},{autoProcessOverride:true},{autoProcessOverride:null},{sourceUrl:"https://x"},
    {retentionDaysOverride:1},{detectionModel:"x"},{appPassword:"x"},{titleOverride:"ok",unexpected:"x"}]) {
    const f=fixture();await assert.rejects(f.call("feed_update",{slug:"show",settings}));assert.equal(f.calls.length,0);
  }
  const f=fixture();await f.call("feed_update",{slug:"show",settings:{titleOverride:"New",autoProcessOverride:false}});
  assert.equal(f.calls[0].method,"PATCH");
});
test("refresh refuses enabled, inherited and missing auto override",async()=>{
  for (const autoProcessOverride of [true,null,undefined]) {
    const f=fixture({autoProcessOverride});await assert.rejects(f.call("feed_refresh",{slug:"show"}));
    assert.equal(f.calls.length,1);
  }
  const f=fixture((method)=>method==="GET"?{autoProcessOverride:false}:{slug:"show",outcome:{status:"ok",queuedEpisodes:0}});
  await f.call("feed_refresh",{slug:"show"});
  assert.deepEqual(f.calls[1].body,{});
});
test("cancel only active single episode and cannot clear queue",async()=>{
  for (const jobState of ["idle",undefined]) {
    const f=fixture({jobState});await assert.rejects(f.call("episode_cancel",input));assert.equal(f.calls.length,1);
  }
  const f=fixture({jobState:"processing"});await f.call("episode_cancel",input);
  assert.equal(f.calls[1].path,"/feeds/show/episodes/abcdef123456/cancel");
});
test("process-wide write guard covers preflight and mutation",async()=>{
  let release;
  const f=fixture(()=>new Promise(r=>release=r));
  const first=f.call("feed_refresh",{slug:"show"});
  await assert.rejects(f.call("feed_update",{slug:"show",settings:{description:"x"}}),/write is active/);
  release({autoProcessOverride:true});await assert.rejects(first,/Refresh refused/);
});
test("projections omit credentials, URLs, raw errors, prompts and nested surprise fields",()=>{
  const bad={title:"title",sourceUrl:"?key=SECRET",feedUrl:"?key=SECRET",originalUrl:"?key=SECRET",
    firstPassPrompt:"SECRET",lastRefreshError:"Authorization: Bearer SECRET timeout",error:"api_key=SECRET",
    statusCounts:{completed:2,password:"SECRET"},jobState:{session:"SECRET"}};
  const f=projectFeed(bad),ep=projectEpisode(bad);
  assert.ok(!JSON.stringify([f,ep]).includes("SECRET"));
  assert.equal(f.refreshErrorCategory,"timeout");assert.equal(ep.errorCategory,"processing_error");
});
test("errors_list uses pinned history pagination/filter names and suppresses provider errors",async()=>{
  const f=fixture({history:[{podcastSlug:"show",errorMessage:"token=SECRET timeout",episodeId:input.episodeId}],total:1,page:1,limit:25});
  const d=await f.call("errors_list",{slug:"show"});assert.match(f.calls[0].path,/status=failed&podcast_slug=show/);
  assert.equal(d.history[0].errorCategory,"timeout");assert.ok(!JSON.stringify(d).includes("SECRET"));
});
test("SDK v2 HTTP initialize, list, annotations, schema rejection and real read call",async()=>{
  const f=fixture({feeds:[{slug:"show",title:"Show",feedUrl:"?key=SECRET"}],total:1,page:1,limit:25});
  const handler=createMcpHandler(()=>buildServer(f.tools));
  const rpc=async(method,params={})=>{
    const res=await handler.fetch(new Request("http://localhost/mcp",{method:"POST",
      headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}));
    const text=await res.text();
    const data=text.startsWith("event:")?JSON.parse(text.split("\n").find(l=>l.startsWith("data: ")).slice(6)):JSON.parse(text);
    return data;
  };
  try {
    const init=await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"tests",version:"1"}});
    assert.equal(init.result.serverInfo.name,"minuspod-mcp");
    const list=await rpc("tools/list");assert.equal(list.result.tools.length,13);
    const paid=list.result.tools.find(t=>t.name==="episode_process_paid");
    assert.equal(paid.annotations.readOnlyHint,false);assert.equal(paid.annotations.destructiveHint,true);
    assert.equal(paid.inputSchema.additionalProperties,false);
    const call=await rpc("tools/call",{name:"feeds_list",arguments:{}});
    assert.equal(call.result.structuredContent.feeds[0].slug,"show");
    assert.ok(!JSON.stringify(call).includes("SECRET"));
    const bad=await rpc("tools/call",{name:"episode_process_paid",arguments:{...input,mode:"full"}});
    assert.ok(bad.error||bad.result?.isError);
    assert.equal(f.calls.length,1);
  } finally {await handler.close();}
});
