import test from "node:test";
import assert from "node:assert/strict";
import {createMcpHandler} from "@modelcontextprotocol/server";
import {MinusPodClient} from "../dist/client.js";
import {makeTools} from "../dist/tools.js";
import {buildServer,createServer} from "../dist/server.js";

const target={slug:"show",episodeId:"abcdef123456"};
const secret="SYNTHETIC_SECRET";
const sensitive=`https://user:${secret}@private.example/feed?token=${secret} token=${secret} Bearer ${secret}`;
const episode={...target,id:target.episodeId,status:"failed",jobState:"idle",hasBeenProcessed:false,
  processedAt:null,error:`timeout ${sensitive}`,title:sensitive,originalUrl:sensitive,
  transcript:secret,activeRunSpend:{knownCostUsd:0.1,token:secret,display:sensitive}};
const feed={slug:"show",title:sensitive,description:sensitive+"x".repeat(5000),lastRefreshError:`429 ${sensitive}`,
  autoProcessOverride:false,feedUrl:sensitive,sourceUrl:sensitive,providerPassword:secret,
  statusCounts:{completed:2,token:secret}};
const routes={
  "/feeds":{feeds:[feed],page:1,limit:25,total:1,totalPages:1},
  "/feeds/show":feed,
  "/feeds/show/episodes":{episodes:[episode],limit:25,offset:0,total:1},
  "/feeds/show/episodes/abcdef123456":episode,
  "/status":{processingPaused:true,queueLength:130,hold:{queuePaused:true,holdUntil:"2026-10-25T12:00:00Z",
    holdSince:"2026-10-25T11:00:00Z",offlineHeld:1,offlineServices:[{url:sensitive,password:secret}]},
    jobs:Array(130).fill({slug:"show",episodeId:target.episodeId,title:sensitive,progress:10,token:secret}),
    queuedEpisodes:Array(130).fill({slug:"show",title:sensitive})},
  "/system/queue":{pending:130,total:130,items:Array(130).fill({podcastSlug:"show",episodeId:target.episodeId,
    status:"pending",createdAt:"2026-10-25T11:00:00Z",url:sensitive})},
  "/stats/dashboard":{totalLlmCost:1.5,totalRuns:3,password:secret},
  "/settings/provider-budget":{enabled:true,dailyLimitMicrousd:10000000,displayCurrency:"USD",
    status:{provider:"existing-provider",reservedMicrousd:100000,spentMicrousd:1500000,activeReservations:1,
      apiKey:secret},token:secret},
};
function fixture(data=routes,paidEnabled=false) {
  const calls=[];
  const client=new MinusPodClient("http://minuspod:8000","dummy-password",async(url,init)=>{
    calls.push({url:new URL(url),method:init.method});
    if (url.pathname.endsWith("/auth/login")) return login();
    const key=url.pathname.replace("/api/v1","");
    const value=typeof data==="function"?data(key):data[key];
    return value instanceof Response?value:new Response(JSON.stringify(value??{}),{headers:{"content-type":"application/json"}});
  });
  const tools=makeTools(client,{paidEnabled});
  return {client,tools,calls};
}
function login(){
  const headers=new Headers({"content-type":"application/json"});
  headers.append("set-cookie","session=test-session; Secure; HttpOnly");
  headers.append("set-cookie","minuspod_csrf=test-csrf; Secure");
  return new Response('{"authenticated":true}',{headers});
}
async function harness(f,run) {
  const handler=createMcpHandler(()=>buildServer(f.tools));
  let id=0;
  const rpc=async(method,params={})=>{
    const res=await handler.fetch(new Request("http://localhost/mcp",{method:"POST",
      headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},
      body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})}));
    const body=await res.text();
    return body.startsWith("event:")?JSON.parse(body.split("\n").find(line=>line.startsWith("data: ")).slice(6)):JSON.parse(body);
  };
  const read=async uri=>{
    const response=await rpc("resources/read",{uri});
    assert.ok(response.result,JSON.stringify(response));
    return JSON.parse(response.result.contents[0].text);
  };
  try {await run({rpc,read});} finally {await handler.close();}
}

test("native factory advertises discovery, complete contracts, safe paid-disabled static guide and zero hidden requests",async()=>{
  const f=fixture();
  await harness(f,async({rpc,read})=>{
    const init=await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"offline",version:"1"}});
    for (const capability of ["tools","resources","prompts"]) assert.ok(init.result.capabilities[capability]);
    assert.ok(!init.result.capabilities.resources.subscribe);
    assert.match(init.result.instructions,/Monetary processing budgets are not API quotas/);
    const listed=(await rpc("resources/list")).result.resources;
    assert.deepEqual(listed.map(r=>r.uri).sort(),["usage","capabilities","status","queue","spend"].map(n=>`minuspod://${n}`).sort());
    assert.ok(listed.every(r=>r.title&&r.description&&r.mimeType));
    const guide=(await rpc("resources/read",{uri:"minuspod://usage"})).result.contents[0].text;
    for (const item of ["minuspod:feeds/{slug}","minuspod:feeds/{slug}/episodes/{episodeId}",
      "minuspod:feeds/{slug}/episodes?limit={limit}&offset={offset}","failure-triage","paid-action-review",
      '"slug":"show"',"abcdef123456","1 app GET","zero app/provider requests","no write retry"]) {
      assert.ok(guide.toLowerCase().includes(item.toLowerCase()),item);
    }
    const templates=(await rpc("resources/templates/list")).result.resourceTemplates;
    assert.equal(templates.length,3);
    assert.ok(templates.every(t=>/1 app metadata GET/.test(t.description)));
    const prompts=(await rpc("prompts/list")).result.prompts;
    assert.deepEqual(prompts.map(p=>p.name).sort(),["failure-triage","paid-action-review"]);
    for (const p of prompts) {
      assert.deepEqual(p.arguments.map(a=>a.name).sort(),["episodeId","slug"]);
      assert.ok(p.arguments.every(a=>a.required));
      const prompt=(await rpc("prompts/get",{name:p.name,arguments:target})).result;
      assert.match(prompt.messages[0].content.text,/Paid tools are absent/);
      assert.match(prompt.messages[0].content.text,/zero requests/);
      assert.match(prompt.messages[0].content.text,/Do not execute writes/);
    }
    const caps=await read("minuspod://capabilities");
    assert.equal(caps.paidEnabled,false);assert.equal(caps.tools.length,12);
    assert.equal(caps.approvalEnforced,false);assert.equal(caps.writeReplay,false);
    const status=await read("minuspod://status");
    assert.equal(status.appRequests,0);assert.equal(status.paidEnabled,false);
    assert.equal(status.requests.login.sessionPresent,false);
    assert.deepEqual(status.lastSuccessfulReads,{});
    assert.equal(status.requests.directorySearch.documentedAppRouteRequestsPerMinute,30);
    assert.equal(status.requests.metadataQuota.remaining,null);
    assert.match(status.guidance,/not a hard spending cap/);
    for (const o of Object.values(status.requests.observations)) assert.equal(o.attempts,0);
    assert.equal(f.calls.length,0);
  });
});

test("every tool has meaningful titles and explicit accurate four-hint/input/output contracts",async()=>{
  for (const paid of [false,true]) {
    const f=fixture(routes,paid);
    await harness(f,async({rpc})=>{
      const listed=(await rpc("tools/list")).result.tools;
      const prompt=(await rpc("prompts/get",{name:"paid-action-review",arguments:target})).result;
      assert.match(prompt.messages[0].content.text,paid?/are enabled, but this prompt is not approval/:/are absent/);
      assert.equal(f.calls.length,0);
      assert.equal(listed.length,paid?14:12);
      const writes=new Set(["feed_add","feed_update","feed_refresh","episode_cancel","episode_process_paid","episode_retry_paid"]);
      const destructive=new Set(["feed_update","episode_cancel","episode_process_paid","episode_retry_paid"]);
      const open=new Set(["podcast_search","feed_add","feed_refresh","episode_process_paid","episode_retry_paid"]);
      for (const t of listed) {
        assert.ok(t.title&&t.title!==t.name);
        assert.deepEqual(t.annotations,{readOnlyHint:!writes.has(t.name),destructiveHint:destructive.has(t.name),
          idempotentHint:!writes.has(t.name)||t.name==="feed_update",openWorldHint:open.has(t.name)},t.name);
        assert.equal(t.inputSchema.additionalProperties,false);
        assert.equal(t.outputSchema.additionalProperties,false);
        assert.match(t.description,/Request cost:/);
        assert.match(t.description,/cooldown/);
        if (t.name.endsWith("_paid")) assert.match(t.description,/not a hard spending cap/);
      }
      const result=(await rpc("tools/call",{name:"feeds_list",arguments:{limit:1}})).result;
      assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
      f.tools.find(t=>t.name==="feeds_list").outputSchema.parse(result.structuredContent);
      assert.equal(result.structuredContent.returned,1);
      assert.equal(result.structuredContent.truncated,false);
      const invalid=await rpc("tools/call",{name:"feed_update",arguments:{slug:"show",settings:{autoProcessOverride:true}}});
      assert.ok(invalid.error||invalid.result?.isError);
      assert.ok(!JSON.stringify(result).includes(secret));
    });
  }
});

test("live resources/templates cost only documented metadata GETs, sanitize and bound projections",async()=>{
  const f=fixture();
  await harness(f,async({read,rpc})=>{
    const queue=await read("minuspod://queue");
    assert.equal(f.calls.length,3); // one login + two metadata GETs
    assert.equal(queue.appGetRequests,2);assert.ok(!Number.isNaN(Date.parse(queue.observedAt)));
    assert.equal(queue.data.jobs.length,100);assert.equal(queue.data.jobsTruncated,true);
    assert.equal(queue.data.queuedEpisodes.length,100);assert.equal(queue.data.queuedEpisodesTruncated,true);
    assert.equal(queue.data.queue.items.length,100);assert.equal(queue.data.queue.itemsTruncated,true);
    assert.equal(queue.data.queue.items[0].podcastSlug,"show");
    assert.equal(queue.data.hold.holdUntil,"2026-10-25T12:00:00Z");
    const spend=await read("minuspod://spend");
    assert.equal(f.calls.length,5);assert.equal(spend.appGetRequests,2);
    assert.equal(spend.data.budget.status.spentMicrousd,1500000);
    const feedData=await read("minuspod:feeds/show");
    assert.equal(f.calls.length,6);assert.equal(feedData.appGetRequests,1);
    assert.equal(feedData.data.refreshErrorCategory,"rate_limited");
    assert.ok(feedData.data.title.length<=200);assert.ok(feedData.data.description.length<=4000);
    const ep=await read("minuspod:feeds/show/episodes/abcdef123456");
    assert.equal(f.calls.length,7);assert.equal(ep.data.errorCategory,"timeout");
    assert.equal(ep.data.spend.active.knownCostUsd,0.1);
    const page=await read("minuspod:feeds/show/episodes?limit=1&offset=0");
    assert.equal(f.calls.length,8);assert.equal(page.data.limit,1);assert.equal(page.data.offset,0);
    assert.equal(page.data.episodes.length,1);
    assert.equal(f.calls.at(-1).url.search,"?limit=1&offset=0&status=all");
    const status=await read("minuspod://status");
    assert.equal(f.calls.length,8);
    assert.equal(status.requests.observations.metadataRead.attempts,7);
    assert.equal(status.requests.observations.authentication.attempts,1);
    for (const name of ["queue_get","spend_get","feed_get","episode_get","episodes_list"])
      assert.ok(!Number.isNaN(Date.parse(status.lastSuccessfulReads[name])));
    const wire=JSON.stringify([queue,spend,feedData,ep,page,status]);
    for (const bad of [secret,"private.example","user:","test-session","test-csrf","dummy-password","providerPassword",'"transcript":'])
      assert.ok(!wire.includes(bad),bad);
    assert.equal(f.calls.filter(c=>c.method!=="GET").length,1); // login only
    assert.ok(f.tools.every(t=>!t.name.endsWith("_paid")));
    const paid=await rpc("tools/call",{name:"episode_process_paid",arguments:target});
    assert.ok(paid.error||paid.result?.isError);assert.equal(f.calls.length,8);
  });
});

test("invalid/encoded URIs and prompt arguments fail before any app request",async()=>{
  const f=fixture();
  const uris=["minuspod:feeds/SHOW","minuspod:feeds/"+"a".repeat(201),"minuspod:feeds/../settings",
    "minuspod:feeds/show%2fsecret","minuspod:feeds/%73how","minuspod:feeds/show?force=true",
    "minuspod:feeds/show#token","minuspod:feeds/show/episodes/ABCDEF123456",
    "minuspod:feeds/show/episodes/s1e2","minuspod:feeds/show/episodes/abcdef123456?mode=full",
    "minuspod:feeds/show/episodes?limit=0&offset=0","minuspod:feeds/show/episodes?limit=101&offset=0",
    "minuspod:feeds/show/episodes?limit=1&offset=100001","minuspod:feeds/show/episodes?limit=1&offset=-1",
    "minuspod:feeds/show/episodes?limit=01&offset=0","minuspod:feeds/show/episodes?limit=1e2&offset=0",
    "minuspod:feeds/show/episodes?limit=1&offset=0&force=true","minuspod:feeds/show/episodes?offset=0&limit=1",
    "minuspod:feeds/show/episodes?limit=1&offset=0#token","minuspod:feeds/show/episodes?limit=1&limit=2&offset=0",
    "minuspod://user:password@feeds/show","minuspod://queue?refresh=true","minuspod://status?probe=true",
    "https://minuspod/feeds/show","minuspod://settings/provider-budget"];
  await harness(f,async({rpc})=>{
    for (const uri of uris) {
      const response=await rpc("resources/read",{uri});
      assert.ok(response.error,uri);assert.equal(f.calls.length,0,uri);
    }
    for (const arguments_ of [{...target,slug:"../show"},{...target,episodeId:".."},{...target,confirm:"true"},{slug:"show"}]) {
      const result=await rpc("prompts/get",{name:"paid-action-review",arguments:arguments_});
      assert.ok(result.error,JSON.stringify(arguments_));assert.equal(f.calls.length,0);
    }
  });
});

test("template maximum boundaries and season-form IDs stay bounded read-only metadata",async()=>{
  const f=fixture();
  await harness(f,async({read})=>{
    const slug="a".repeat(200);
    await read(`minuspod:feeds/${slug}`);
    await read(`minuspod:feeds/${slug}/episodes/s123e1234`);
    const page=await read("minuspod:feeds/show/episodes?limit=100&offset=100000");
    assert.equal(page.data.limit,100);assert.equal(page.data.offset,100000);
    assert.equal(f.calls.length,4); // one login + three GETs, no hidden pages
  });
});

test("server-enforced list bounds/truncation apply even when app ignores pagination",async()=>{
  const f=fixture({
    ...routes,"/feeds":{feeds:Array(150).fill(feed),total:150},
    "/feeds/show/episodes":{episodes:Array(150).fill(episode),total:150},
    "/history":{history:Array(150).fill({episodeId:target.episodeId,errorMessage:`timeout ${sensitive}`}),total:150},
  });
  await harness(f,async({read,rpc})=>{
    const page=await read("minuspod:feeds/show/episodes?limit=3&offset=100000");
    assert.equal(page.data.episodes.length,3);assert.equal(page.data.truncated,true);assert.equal(page.data.returned,3);
    for (const [name,key] of [["feeds_list","feeds"],["errors_list","history"]]) {
      const result=(await rpc("tools/call",{name,arguments:{limit:2}})).result.structuredContent;
      assert.equal(result[key].length,2);assert.equal(result.truncated,true);assert.equal(result.returned,2);
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  });
});

test("resource errors disclose no raw upstream failures or misleading partial snapshot",async()=>{
  const f=fixture(path=>path==="/system/queue" ? new Response(`password=${secret} ${sensitive}`,{status:500}) : routes[path]);
  await harness(f,async({rpc,read})=>{
    const response=await rpc("resources/read",{uri:"minuspod://queue"});
    assert.ok(response.error);assert.match(response.error.message,/no partial snapshot/);
    assert.ok(!JSON.stringify(response).includes(secret));assert.equal(f.calls.length,3);
    const status=await read("minuspod://status");
    assert.equal(status.lastSuccessfulReads.queue_get,undefined);
    assert.equal(status.requests.observations.metadataRead.attempts,2);
  });
  const malformed=fixture({...routes,"/feeds":{feeds:"not an array"}});
  await harness(malformed,async({rpc})=>{
    const result=(await rpc("tools/call",{name:"feeds_list",arguments:{}})).result;
    assert.equal(result.isError,true);assert.match(result.content[0].text,/Unexpected MinusPod metadata response/);
  });
});

test("wire status exposes app 429 observations without probing or treating them as provider quota",async()=>{
  const f=fixture(path=>path==="/feeds/show"?new Response(`token=${secret}`,{status:429,headers:{"retry-after":"60"}}):routes[path]);
  await harness(f,async({rpc,read})=>{
    const failure=await rpc("resources/read",{uri:"minuspod:feeds/show"});
    assert.ok(failure.error);assert.equal(f.calls.length,2);
    const status=await read("minuspod://status");
    const o=status.requests.observations.metadataRead;
    assert.equal(o.attempts,1);assert.equal(o.lastHttpStatus,429);
    const wait=Date.parse(o.retryAfterAt)-Date.parse(o.retryAfterObservedAt);
    assert.ok(wait>=60000&&wait<61000);
    assert.equal(status.requests.metadataQuota.remaining,null);
    assert.equal(status.requests.directorySearch.remaining,null);
    await rpc("resources/read",{uri:"minuspod:feeds/show"});
    assert.equal(f.calls.length,2);
    assert.ok(!JSON.stringify([failure,status]).includes(secret));
  });
});

test("metadata projections redact non-HTTP and protocol-relative credential URLs",async()=>{
  for (const url of [`wss://user:${secret}@private.example/socket`,`//user:${secret}@private.example/feed`,`file:///private/${secret}`]) {
    const f=fixture({...routes,"/feeds/show":{slug:"show",title:url}});
    await harness(f,async({read})=>{
      const result=await read("minuspod:feeds/show");
      assert.equal(result.data.title,"[URL omitted]");assert.ok(!JSON.stringify(result).includes(secret));
    });
  }
});

test("known app secret is redacted before JSON escaping in resources and tool results",async()=>{
  const previous=process.env.MINUSPOD_ADMIN_PASSWORD;
  const password='synthetic"\\credential'+"x".repeat(250);process.env.MINUSPOD_ADMIN_PASSWORD=password;
  try {
    const f=fixture({...routes,"/feeds/show":{slug:"show",title:password}});
    await harness(f,async({read,rpc})=>{
      const resource=await read("minuspod:feeds/show");assert.equal(resource.data.title,"[redacted]");
      const tool=(await rpc("tools/call",{name:"feed_get",arguments:{slug:"show"}})).result;
      assert.equal(tool.structuredContent.title,"[redacted]");
      assert.deepEqual(JSON.parse(tool.content[0].text),tool.structuredContent);
    });
  } finally {
    if (previous===undefined) delete process.env.MINUSPOD_ADMIN_PASSWORD;else process.env.MINUSPOD_ADMIN_PASSWORD=previous;
  }
});

test("production native createServer factory registers discovery without authenticating",async()=>{
  const previous={url:process.env.MINUSPOD_URL,password:process.env.MINUSPOD_ADMIN_PASSWORD,paid:process.env.MINUSPOD_ENABLE_PAID_OPERATIONS};
  process.env.MINUSPOD_URL="http://must-not-contact.invalid";process.env.MINUSPOD_ADMIN_PASSWORD="test";
  delete process.env.MINUSPOD_ENABLE_PAID_OPERATIONS;
  const originalFetch=globalThis.fetch;
  let requests=0;globalThis.fetch=async()=>{requests++;throw new Error("No real API calls in tests");};
  const handler=createMcpHandler(createServer);
  try {
    const response=await handler.fetch(new Request("http://localhost/mcp",{method:"POST",headers:{
      "content-type":"application/json",accept:"application/json, text/event-stream"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"resources/read",params:{uri:"minuspod://capabilities"}})}));
    const body=await response.text();
    assert.ok(body.includes("capabilities"));assert.ok(!body.includes("episode_process_paid"));assert.equal(requests,0);
  } finally {
    globalThis.fetch=originalFetch;
    await handler.close();
    for (const [key,value] of [["MINUSPOD_URL",previous.url],["MINUSPOD_ADMIN_PASSWORD",previous.password],["MINUSPOD_ENABLE_PAID_OPERATIONS",previous.paid]])
      if (value===undefined) delete process.env[key];else process.env[key]=value;
  }
});
