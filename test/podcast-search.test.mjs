import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {createMcpHandler} from "@modelcontextprotocol/server";
import {MinusPodClient} from "../dist/client.js";
import {makeTools} from "../dist/tools.js";
import {buildServer} from "../dist/server.js";
import {podcastSearchInput,projectPodcastSearch,PODCAST_SEARCH_MAX_BYTES,
  PODCAST_SEARCH_TIMEOUT_MS} from "../dist/podcast-search.js";

// All credentials and directory responses in this file are synthetic fixtures.
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{
  status,headers:{"content-type":"application/json",...extra},
});
// Append Set-Cookie separately to preserve both authentication cookies.
const authenticated=()=>{
  const r=json({authenticated:true});
  r.headers.append("set-cookie","session=test-session; Secure; HttpOnly");
  r.headers.append("set-cookie","minuspod_csrf=test-csrf; Secure");
  return r;
};
const row=(id=123,patch={})=>({id,title:"Test Show",author:"Test Author",
  description:"Test description",feedUrl:"https://feeds.example.com/show.xml",...patch});
const response=(results=[row()],patch={})=>({provider:"podcastindex",results,...patch});
function fixture(responses=[response()]) {
  const calls=[];
  const client=new MinusPodClient("http://minuspod:8000","test-password",async(url,init)=>{
    calls.push({url:new URL(url),...init});
    if (url.pathname.endsWith("/auth/login")) return authenticated();
    const next=responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response?next:json(next??response());
  });
  const tools=makeTools(client);
  const search=tools.find(t=>t.name==="podcast_search");
  const run=async(input)=>search.run(search.schema.parse(input));
  return {client,calls,tools,search,run};
}

test("search reuses authenticated MinusPod GET, encoded q only, and local result limit",async()=>{
  const f=fixture([response([row(123),row(456)])]);
  const query="  Café science / O'Reilly? x=y  ";
  const result=await f.run({query,limit:1});
  assert.deepEqual(result,{provider:"podcastindex",results:[{
    podcastIndexId:123,title:"Test Show",author:"Test Author",
    description:"Test description",feedUrl:"https://feeds.example.com/show.xml",
  }]});
  assert.equal(f.calls.length,2);
  const [auth,search]=f.calls;
  assert.equal(auth.method,"POST");
  assert.equal(auth.url.pathname,"/api/v1/auth/login");
  assert.deepEqual(JSON.parse(auth.body),{password:"test-password"});
  assert.equal(search.method,"GET");
  assert.equal(search.url.origin,"http://minuspod:8000");
  assert.equal(search.url.pathname,"/api/v1/podcast-search");
  assert.deepEqual([...search.url.searchParams],[["q",query.trim()]]);
  assert.equal(search.body,undefined);
  assert.equal(search.redirect,"error");
  assert.equal(search.headers.Cookie,"session=test-session; minuspod_csrf=test-csrf");
  assert.equal(search.headers["X-CSRF-Token"],undefined);
  assert.equal(search.headers.Authorization,undefined);
  assert.equal(search.headers["X-Auth-Key"],undefined);
  assert.ok(search.signal);
  assert.equal(PODCAST_SEARCH_TIMEOUT_MS,30000);
});

test("concurrent search and app reads share one login",async()=>{
  const f=fixture([response(),response()]);
  await Promise.all([f.run({query:"show"}),f.client.call("GET","/feeds")]);
  assert.equal(f.calls.filter(c=>c.url.pathname.endsWith("/auth/login")).length,1);
  assert.equal(f.calls.length,3);
});

test("query and limit boundaries/defaults remain strict",()=>{
  assert.deepEqual(podcastSearchInput.parse({query:"x"}),{query:"x",limit:10});
  assert.equal(podcastSearchInput.parse({query:"x".repeat(200),limit:10}).query.length,200);
});
for (const input of [
  {},{query:""},{query:"   "},{query:"x".repeat(201)},
  ...["&max=1000","%26max=1000","#fragment","plus+term","\n","\r","\t","\0","\u007f","\u0085","\ud800"].map(c=>({query:"show"+c})),
  ...[0,11,1.5,"1",null].map(limit=>({query:"show",limit})),
  ...[{provider:"itunes"},{max:1000},{url:"https://evil.example"},{confirm:true},{queries:["a","b"]}].map(extra=>({query:"show",...extra})),
]) test("invalid search input is rejected before authentication: "+JSON.stringify(input),async()=>{
  const f=fixture();
  await assert.rejects(f.run(input));
  await assert.rejects(f.client.searchPodcasts(input));
  assert.equal(f.calls.length,0);
});

test("generic API capability stays closed to podcast search paths and writes",async()=>{
  const f=fixture();
  for(const method of ["GET","POST","PATCH"]) {
    await assert.rejects(f.client.call(method,"/podcast-search?q=show"),/not allowed/);
  }
  assert.equal(f.calls.length,0);
});

test("projection only returns bounded allowlisted directory metadata",()=>{
  const d=projectPodcastSearch(response([row(123,{
    title:"t".repeat(500),author:"a".repeat(500),description:"d".repeat(5000),
    artworkUrl:"https://example.com?token=SYNTHETIC_SECRET",link:"SYNTHETIC_SECRET",
    password:"SYNTHETIC_SECRET",settings:{session:"SYNTHETIC_SECRET"},
  })],{error:"SYNTHETIC_SECRET",query:"SYNTHETIC_SECRET"}),10);
  assert.deepEqual(Object.keys(d.results[0]).sort(),["author","description","feedUrl","podcastIndexId","title"]);
  assert.equal(d.results[0].title.length,200);
  assert.equal(d.results[0].author.length,200);
  assert.equal(d.results[0].description.length,4000);
  assert.ok(!JSON.stringify(d).includes("SYNTHETIC_SECRET"));
  const many=Array.from({length:100},(_,i)=>row(i+1));
  assert.equal(projectPodcastSearch(response(many),10).results.length,10);
  assert.equal(projectPodcastSearch(response(many),2).results.length,2);
  assert.deepEqual(projectPodcastSearch(response([]),10),{provider:"podcastindex",results:[]});
});

test("projection removes embedded URLs/auth values and controls from metadata",()=>{
  const d=projectPodcastSearch(response([row(123,{
    title:"Test\0\u0085\u202e Show",author:"Bearer SYNTHETIC_SECRET",
    description:'See https://user:SYNTHETIC_SECRET@example.com/feed and <a href="https://example.com/?token=SYNTHETIC_SECRET">link</a> api_key=SYNTHETIC_SECRET token=SYNTHETIC_SECRET password=SYNTHETIC_SECRET',
  })]),10);
  assert.equal(d.results[0].title,"Test Show");
  assert.equal(d.results[0].author,"[redacted]");
  assert.ok(!JSON.stringify(d).includes("SYNTHETIC_SECRET"));
  assert.match(d.results[0].description,/URL omitted/);
});

for(const feedUrl of [
  "https://user:pass@feeds.example.com/show","https://feeds.example.com/show?token=SYNTHETIC_SECRET",
  "https://feeds.example.com/show#SYNTHETIC_SECRET","https://feeds.example.com:8443/show",
  "https://127.0.0.1/show","http://2130706433/show","http://0x7f000001/show",
  "https://[::1]/show","https://[::ffff:127.0.0.1]/show","http://localhost/show",
  "http://host.local/show","http://host.internal/show","http://host.home/show","http://host.lan./show",
  "file:///etc/passwd","ftp://feeds.example.com/show","//feeds.example.com/show",
  "https://feeds.example.com/white space","https://feeds.example.com/\nshow",
  "https://feeds.example.com\\show","https://feeds.example.com/"+"x".repeat(2048),null,{},
]) test("suspicious feed URLs are omitted, not rewritten/fetched: "+String(feedUrl).slice(0,100),()=>{
  assert.deepEqual(projectPodcastSearch(response([row(123,{feedUrl})]),10).results,[]);
});

test("quoted credential values and truncated URLs remain redacted",()=>{
  const d=projectPodcastSearch(response([row(123,{
    title:'password="SYNTHETIC_SECRET with spaces"',author:"token='SYNTHETIC_SECRET with spaces'",
    description:'secret="SYNTHETIC_SECRET '+"x".repeat(5000)+'"',
  }),row(456,{description:"https://example.com/?token="+"SYNTHETIC_SECRET".repeat(300)})]),10);
  assert.ok(!JSON.stringify(d).includes("SYNTHETIC_SECRET"));
  assert.ok(d.results.every(r=>r.description.length<=4000));
});

test("HTTP public feeds can be discovered but cannot bypass feed_add's HTTPS host policy",()=>{
  const d=projectPodcastSearch(response([row(123,{feedUrl:"http://feeds.example.com/show"})]),10);
  assert.equal(d.results[0].feedUrl,"http://feeds.example.com/show");
});

test("malformed rows/IDs are omitted and non-string metadata cannot escape projection",()=>{
  const results=[null,[],"bad",{},...[-1,0,1.5,"123",Number.MAX_SAFE_INTEGER+1].map(id=>row(id)),
    row(123,{title:{password:"SYNTHETIC_SECRET"},author:null,description:[]})];
  const d=projectPodcastSearch(response(results),10);
  assert.deepEqual(d.results,[{podcastIndexId:123,title:"",author:"",description:"",feedUrl:"https://feeds.example.com/show.xml"}]);
});

for(const data of [null,[],"SYNTHETIC_SECRET",{},response(null),response({},{}),
  response([row()],{provider:"itunes"}),response([row()],{provider:"SYNTHETIC_SECRET"})]) {
  test("invalid/wrong provider response fails closed without echoing payload",()=>{
    assert.throws(()=>projectPodcastSearch(data,10),e=>!e.message.includes("SYNTHETIC_SECRET"));
  });
}

for(const status of [400,403,408,429,500,502,503,504]) test("search HTTP "+status+" is redacted and never transient-retried",async()=>{
  const f=fixture([json({error:"Bearer SYNTHETIC_SECRET",password:"SYNTHETIC_SECRET"},status)]);
  await assert.rejects(f.run({query:"show"}),e=>{
    assert.ok(!e.message.includes("SYNTHETIC_SECRET"));
    if(status===429) assert.match(e.message,/rate limited/);
    if(status===503) assert.match(e.message,/configured credentials/);
    if(status===502) assert.match(e.message,/masks provider errors/);
    return true;
  });
  assert.equal(f.calls.length,2);
});

test("one search authentication retry uses the same deadline",async()=>{
  const f=fixture([json({},401),response()]);
  await f.run({query:"show"});
  assert.equal(f.calls.length,4);
  assert.equal(f.calls[1].signal,f.calls[3].signal);
  const bad=fixture([json({error:"SYNTHETIC_SECRET"},401),json({error:"SYNTHETIC_SECRET"},401)]);
  await assert.rejects(bad.run({query:"show"}),/authentication\/permission failed/);
  assert.equal(bad.calls.length,4);
});

for(const reply of [
  new Error("https://user:SYNTHETIC_SECRET@example.com"),
  new Response("SYNTHETIC_SECRET"),
  new Response("{SYNTHETIC_SECRET",{headers:{"content-type":"application/json"}}),
  json([]),
  json({value:"x".repeat(PODCAST_SEARCH_MAX_BYTES)}),
  json({},200,{"content-length":String(PODCAST_SEARCH_MAX_BYTES+1)}),
]) test("transport, parse and 1 MiB body errors are sanitized without search replay",async()=>{
  const f=fixture([reply]);
  await assert.rejects(f.run({query:"show"}),e=>!e.message.includes("SYNTHETIC_SECRET"));
  assert.equal(f.calls.length,2);
});

test("failed authentication stays redacted and retains shared login cooldown",async()=>{
  let calls=0;
  const client=new MinusPodClient("http://minuspod:8000","test-password",async()=>{
    calls++;return json({error:"SYNTHETIC_SECRET"},401);
  });
  for(let i=0;i<2;i++) await assert.rejects(client.searchPodcasts({query:"show"}),e=>!e.message.includes("SYNTHETIC_SECRET"));
  assert.equal(calls,1);
});

for(const stage of ["login","headers","body"]) test("real fetch total search deadline bounds "+stage+" without replay",async()=>{
  let searches=0;
  const server=http.createServer((req,res)=>{
    if(req.url.endsWith("/auth/login")) {
      if(stage==="login") return;
      res.writeHead(200,{"content-type":"application/json","set-cookie":[
        "session=test-session; Secure","minuspod_csrf=test-csrf; Secure"]});
      res.end('{"authenticated":true}');
    }else{
      searches++;
      if(stage==="body") {
        res.writeHead(200,{"content-type":"application/json"});
        res.write('{"results":[');
      }
    }
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  try{
    const client=new MinusPodClient("http://127.0.0.1:"+server.address().port,"test-password",fetch,200);
    await assert.rejects(client.searchPodcasts({query:"show"}),/timed out/);
    assert.equal(searches,stage==="login"?0:1);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test("late shared login cannot issue a search after the deadline",async()=>{
  let release;let calls=0;
  const client=new MinusPodClient("http://minuspod:8000","test-password",async()=>{
    calls++;return new Promise(r=>release=r);
  },50);
  // AbortSignal timers are unref'd; keep the event loop alive for this mock.
  const keepAlive=setInterval(()=>{},1000);
  try{
    await assert.rejects(client.searchPodcasts({query:"show"}),/timed out/);
    release(authenticated());
    await new Promise(r=>setImmediate(r));
    assert.equal(calls,1);
  }finally{clearInterval(keepAlive);}
});

test("SDK exposes read-only open-world search, projects results, and redacts errors",async()=>{
  const f=fixture([response(),json({error:"SYNTHETIC_SECRET"},429),response([row()],{provider:"itunes"})]);
  const handler=createMcpHandler(()=>buildServer(f.tools));
  const rpc=async(method,params={})=>{
    const res=await handler.fetch(new Request("http://localhost/mcp",{method:"POST",
      headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})}));
    const text=await res.text();
    return text.startsWith("event:")?JSON.parse(text.split("\n").find(l=>l.startsWith("data: ")).slice(6)):JSON.parse(text);
  };
  try{
    await rpc("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"tests",version:"1"}});
    const list=await rpc("tools/list");
    const search=list.result.tools.find(t=>t.name==="podcast_search");
    assert.deepEqual(search.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true});
    assert.equal(search.inputSchema.additionalProperties,false);
    assert.equal(search.inputSchema.properties.limit.maximum,10);
    assert.equal(search.inputSchema.properties.query.maxLength,200);
    const call=()=>rpc("tools/call",{name:"podcast_search",arguments:{query:"show"}});
    const good=await call();assert.equal(good.result.structuredContent.results[0].podcastIndexId,123);
    const throttled=await call();assert.equal(throttled.result.isError,true);
    assert.match(throttled.result.content[0].text,/rate limited/);
    assert.ok(!JSON.stringify(throttled).includes("SYNTHETIC_SECRET"));
    const wrong=await call();assert.equal(wrong.result.isError,true);
    assert.match(wrong.result.content[0].text,/must use PodcastIndex/);
    const bad=await rpc("tools/call",{name:"podcast_search",arguments:{query:"show&max=1000"}});
    assert.ok(bad.error||bad.result?.isError);
    assert.equal(f.calls.length,4);
    assert.ok(f.calls.slice(1).every(c=>c.method==="GET"&&c.url.pathname==="/api/v1/podcast-search"));
    assert.ok(f.tools.every(t=>!t.name.includes("paid")));
  }finally{await handler.close();}
});
