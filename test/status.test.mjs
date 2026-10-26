import test from "node:test";
import assert from "node:assert/strict";
import {MinusPodClient} from "../dist/client.js";

const start=Date.parse("2026-10-25T12:00:00Z");
const response=(status=200,retryAfter,body={ok:true})=>new Response(JSON.stringify(body),{
  status,headers:{"content-type":"application/json",...(retryAfter===undefined?{}:{"retry-after":retryAfter})}});
function fixture(responses=[]) {
  let now=start;
  const calls=[];
  const client=new MinusPodClient("http://private-app:8000","synthetic-password",async(url,init)=>{
    calls.push({url:new URL(url),method:init.method});
    if (url.pathname.endsWith("/auth/login")) {
      const headers=new Headers({"content-type":"application/json"});
      headers.append("set-cookie","session=synthetic-session; Secure");
      headers.append("set-cookie","minuspod_csrf=synthetic-csrf; Secure");
      return new Response('{"authenticated":true}',{headers});
    }
    const next=responses.shift();if (next instanceof Error) throw next;
    return next??response();
  },90000,()=>now);
  return {client,calls,advance:ms=>now+=ms};
}

test("local status is zero-call, credential/path/query-free, timestamped attempt accounting not quota",async()=>{
  const f=fixture([response(502),response()]);
  const before=f.client.localStatus();assert.equal(f.calls.length,0);
  assert.equal(before.startedAt,new Date(start).toISOString());
  assert.deepEqual(before.metadataQuota,{limit:null,remaining:null,resetAt:null});
  assert.equal(before.directorySearch.documentedAppRouteRequestsPerMinute,30);
  await f.client.call("GET","/feeds/show/episodes?search=SECRET_QUERY");
  const status=f.client.localStatus();assert.equal(f.calls.length,3);
  assert.equal(status.observations.metadataRead.attempts,2);
  assert.equal(status.observations.authentication.attempts,1);
  assert.equal(status.observations.metadataRead.lastHttpStatus,200);
  assert.equal(status.observations.metadataRead.lastFailureAt,new Date(start).toISOString());
  const wire=JSON.stringify(status);
  for (const value of ["private-app","SECRET_QUERY","/feeds","synthetic-password","synthetic-session","synthetic-csrf"]) assert.ok(!wire.includes(value));
  status.observations.metadataRead.attempts=999;
  assert.equal(f.client.localStatus().observations.metadataRead.attempts,2); // isolated snapshots
});

for (const header of ["60","Sun, 25 Oct 2026 12:01:00 GMT"]) test("429 Retry-After is observed/enforced without automatic retry: "+header,async()=>{
  const f=fixture([response(429,header),response()]);
  await assert.rejects(f.client.call("GET","/feeds"),/2026-10-25T12:01:00.000Z/);
  assert.equal(f.calls.length,2);
  const status=f.client.localStatus().observations.metadataRead;
  assert.equal(status.attempts,1);assert.equal(status.lastRateLimitAt,new Date(start).toISOString());
  assert.equal(status.retryAfterAt,new Date(start+60000).toISOString());
  f.advance(1000);
  await assert.rejects(f.client.call("GET","/status"),/local request-group cooldown/);
  assert.equal(f.calls.length,2); // local refusal is not an HTTP attempt
  f.advance(60000);
  await f.client.call("GET","/feeds");
  assert.equal(f.calls.length,3);
  assert.equal(f.client.localStatus().observations.metadataRead.attempts,2);
  assert.equal(f.client.localStatus().observations.metadataRead.lastHttpStatus,200);
  assert.equal(f.client.localStatus().observations.metadataRead.retryAfterAt,status.retryAfterAt); // historical, expired
});
for (const header of [undefined,"https://user:SECRET@private.example/?token=SECRET","SECRET","-1","0.5","99999999999999999999999999999999999999","Sun, 25 Oct 2026 11:59:00 GMT","Mon, 25 Oct 2026 12:01:00 GMT","Wed, 31 Feb 2027 12:01:00 GMT"]) {
  test("missing/invalid/past Retry-After remains unknown and never leaks: "+String(header).slice(0,15),async()=>{
    const f=fixture([response(429,header)]);
    await assert.rejects(f.client.call("GET","/feeds"),error=>/unknown/.test(error.message)&&!error.message.includes("SECRET"));
    assert.equal(f.calls.length,2);
    assert.equal(f.client.localStatus().observations.metadataRead.retryAfterAt,null);
    assert.ok(!JSON.stringify(f.client.localStatus()).includes("SECRET"));
  });
}

test("directory throttle, metadata calls and monetary policy are separate, with honest masked 502",async()=>{
  const f=fixture([response(429,"60"),response(),response(502)]);
  await assert.rejects(f.client.searchPodcasts({query:"show"}),/Retry-After.*12:01:00/);
  await f.client.call("GET","/status"); // independent local group, not provider allowance
  await assert.rejects(f.client.searchPodcasts({query:"show"}),/rate limited/);
  assert.equal(f.calls.length,3);
  const before=f.client.localStatus();
  assert.equal(before.observations.directorySearch.attempts,1);
  assert.equal(before.observations.metadataRead.attempts,1);
  assert.match(before.monetaryBudget,/not an HTTP request allowance/);
  f.advance(61000);
  await assert.rejects(f.client.searchPodcasts({query:"show"}),/masks provider errors, throttling and timeouts/);
  const after=f.client.localStatus();
  assert.equal(after.observations.directorySearch.attempts,2);assert.equal(f.calls.length,4);
  assert.equal(after.directorySearch.remaining,null);assert.equal(after.directorySearch.resetAt,null);
});

test("concurrent 429 responses cannot erase the longest still-active Retry-After",async()=>{
  const f=fixture([response(429,"120"),response(429),response()]);
  const results=await Promise.allSettled([f.client.call("GET","/feeds"),f.client.call("GET","/status")]);
  assert.ok(results.every(r=>r.status==="rejected"));
  assert.equal(f.client.localStatus().observations.metadataRead.attempts,2);
  assert.equal(f.client.localStatus().observations.metadataRead.retryAfterAt,new Date(start+120000).toISOString());
  assert.equal(f.client.localStatus().observations.metadataRead.retryAfterObservedAt,new Date(start).toISOString());
  await assert.rejects(f.client.call("GET","/feeds"),/cooldown/);
  assert.equal(f.calls.length,3);
  f.advance(121000);await f.client.call("GET","/feeds");assert.equal(f.calls.length,4);
});

test("transport failures count attempts without overwriting last HTTP response as current health",async()=>{
  const f=fixture([response(),new Error("https://private?token=SECRET"),new Error("password=SECRET")]);
  await f.client.call("GET","/feeds");
  f.advance(1000);
  await assert.rejects(f.client.call("GET","/status"),error=>!error.message.includes("SECRET"));
  const o=f.client.localStatus().observations.metadataRead;
  assert.equal(o.attempts,3);assert.equal(o.inFlight,0);assert.equal(o.lastHttpStatus,200);
  assert.equal(o.lastResponseAt,new Date(start).toISOString());
  assert.equal(o.lastFailureAt,new Date(start+1000).toISOString());
});

test("401 read accounting includes reauthentication, but a 401 write is never replayed",async()=>{
  const f=fixture([response(401),response(),response(401),response()]);
  await f.client.call("GET","/feeds");
  let status=f.client.localStatus();
  assert.equal(status.observations.metadataRead.attempts,2);assert.equal(status.observations.authentication.attempts,2);
  await assert.rejects(f.client.call("PATCH","/feeds/show",{description:"x"}));
  assert.equal(f.calls.filter(c=>c.method==="PATCH").length,1);
  await f.client.call("GET","/feeds");
  status=f.client.localStatus();
  assert.equal(status.observations.metadataWrite.attempts,1);assert.equal(status.observations.authentication.attempts,3);
});

test("write 429 cooldown and ambiguous transport failures never replay a write",async()=>{
  const f=fixture([response(429,"60"),new Error("ambiguous-write-secret")]);
  await assert.rejects(f.client.call("POST","/feeds",{}),/no automatic retry/i);
  await assert.rejects(f.client.call("POST","/feeds",{}),/cooldown/);
  assert.equal(f.calls.length,2);
  f.advance(61000);
  await assert.rejects(f.client.call("POST","/feeds",{}),/no write retry/);
  assert.equal(f.client.localStatus().observations.metadataWrite.attempts,2);
  assert.equal(f.calls.filter(c=>c.url.pathname==="/api/v1/feeds").length,2);
});

test("login failure cooldown is a local timestamped policy, with no hidden status request",async()=>{
  let now=start,calls=0;
  const client=new MinusPodClient("http://private-app","synthetic-password",async()=>{calls++;return response(401);},90000,()=>now);
  await assert.rejects(client.call("GET","/feeds"),/login failed/);
  const status=client.localStatus();
  assert.equal(calls,1);assert.equal(status.login.cooldownUntil,new Date(start+60000).toISOString());
  assert.equal(status.observations.authentication.attempts,1);assert.equal(status.observations.metadataRead.attempts,0);
  await assert.rejects(client.call("GET","/feeds"),/cooling down.*12:01:00/);assert.equal(calls,1);
  now+=61000;
  assert.equal(client.localStatus().login.cooldownUntil,null);
  await assert.rejects(client.call("GET","/feeds"),/login failed/);assert.equal(calls,2);
});

test("longer login Retry-After is respected, still not a provider reset",async()=>{
  const client=new MinusPodClient("http://private-app","synthetic-password",async()=>response(429,"120"),90000,()=>start);
  await assert.rejects(client.call("GET","/feeds"),/login failed/);
  const status=client.localStatus();
  assert.equal(status.login.cooldownUntil,new Date(start+120000).toISOString());
  assert.equal(status.observations.authentication.retryAfterAt,status.login.cooldownUntil);
  assert.equal(status.directorySearch.resetAt,null);
});

test("concurrent requests share login and status observes in-flight calls without touching them",async()=>{
  let releaseLogin,releaseRead;
  const loginGate=new Promise(r=>releaseLogin=r),readGate=new Promise(r=>releaseRead=r);
  let calls=0;
  const client=new MinusPodClient("http://private-app","synthetic-password",async url=>{
    calls++;
    if (url.pathname.endsWith("/auth/login")) {
      await loginGate;
      const headers=new Headers({"content-type":"application/json"});
      headers.append("set-cookie","session=session; Secure");headers.append("set-cookie","minuspod_csrf=csrf; Secure");
      return new Response('{"authenticated":true}',{headers});
    }
    await readGate;return response();
  },90000,()=>start);
  const pending=Promise.all([client.call("GET","/feeds"),client.call("GET","/status")]);
  assert.equal(client.localStatus().login.inFlight,true);assert.equal(calls,1);
  releaseLogin();
  // A bounded microtask turn, not a polling loop or a real-time sleep.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(client.localStatus().observations.metadataRead.inFlight,2);assert.equal(calls,3);
  releaseRead();await pending;
  assert.equal(client.localStatus().observations.metadataRead.inFlight,0);
  assert.equal(client.localStatus().observations.authentication.attempts,1);
});
