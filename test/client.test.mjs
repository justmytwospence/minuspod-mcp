import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {MinusPodClient} from "../dist/client.js";

const json=(value,status=200,cookies=[])=>{
  const headers=new Headers({"content-type":"application/json"});
  for (const cookie of cookies) headers.append("set-cookie",cookie);
  return new Response(JSON.stringify(value),{status,headers});
};
const login=()=>json({authenticated:true},200,[
  "session=session-cookie; Secure; HttpOnly; SameSite=Strict",
  "minuspod_csrf=csrf-token; Secure; SameSite=Strict",
  "ignored=other-secret; Secure",
]);
function fixture(responses=[]) {
  const calls=[];const client=new MinusPodClient("http://minuspod:8000","dummy-password",
    async(url,init)=>{
      calls.push({url:new URL(url),...init});
      if (url.pathname.endsWith("/auth/login")) return login();
      const value=responses.shift();
      if (value instanceof Error) throw value;
      return value??json({ok:true});
    });
  return {client,calls};
}
test("session Secure cookies stay on trusted origin and CSRF accompanies writes",async()=>{
  const {client,calls}=fixture();
  await client.call("GET","/feeds"); await client.call("PATCH","/feeds/show",{description:"test"});
  assert.equal(calls.length,3);
  assert.deepEqual(JSON.parse(calls[0].body),{password:"dummy-password"});
  assert.equal(calls[2].headers.Cookie,"session=session-cookie; minuspod_csrf=csrf-token");
  assert.equal(calls[2].headers["X-CSRF-Token"],"csrf-token");
  assert.equal(calls[2].redirect,"error");
  assert.equal(calls[2].url.origin,"http://minuspod:8000");
  assert.ok(calls.every(c=>c.signal));
  assert.equal(calls[1].headers["X-CSRF-Token"],undefined);
});
test("concurrent reads coalesce login",async()=>{
  const {client,calls}=fixture();
  await Promise.all([client.call("GET","/feeds"),client.call("GET","/status")]);
  assert.equal(calls.filter(c=>c.url.pathname.endsWith("/auth/login")).length,1);
});
for (const status of [408,502,503,504]) test("GET retries transient "+status+" once",async()=>{
  const {client,calls}=fixture([json({error:"secret"},status),json({ok:true})]);
  assert.deepEqual(await client.call("GET","/feeds"),{ok:true});assert.equal(calls.length,3);
});
test("GET transport failure retries once with sanitized final error",async()=>{
  const {client,calls}=fixture([new Error("Bearer upstream-secret"),new Error("password=secret")]);
  await assert.rejects(client.call("GET","/status"),e=>!e.message.includes("secret"));
  assert.equal(calls.length,3);
});
for (const status of [403,404,429,500]) test("GET does not retry "+status,async()=>{
  const {client,calls}=fixture([json({error:"Bearer upstream-secret"},status)]);
  await assert.rejects(client.call("GET","/feeds"),e=>e.status===status&&!e.message.includes("secret"));
  assert.equal(calls.length,2);
});
for (const method of ["POST","PATCH"]) for (const status of [401,403,429,502]) {
  test(method+" never retries "+status,async()=>{
    const {client,calls}=fixture([json({error:"secret"},status)]);
    await assert.rejects(client.call(method,method==="POST"?"/feeds":"/feeds/show",{}));
    assert.equal(calls.length,2);
  });
}
test("write transport failure is not retried",async()=>{
  const {client,calls}=fixture([new Error("session=SECRET")]);
  await assert.rejects(client.call("POST","/feeds",{}),/no write retry/);assert.equal(calls.length,2);
});
test("expired read session reauthenticates once",async()=>{
  const {client,calls}=fixture([json({},401),json({ok:true})]);
  assert.deepEqual(await client.call("GET","/feeds"),{ok:true});assert.equal(calls.length,4);
});
test("401 write invalidates session but does not replay; later read can login",async()=>{
  const {client,calls}=fixture([json({},401),json({ok:true})]);
  await assert.rejects(client.call("POST","/feeds",{}));
  await client.call("GET","/status");assert.equal(calls.length,4);
});
for (const response of [
  json({authenticated:false}),
  json({authenticated:true}),
  json({authenticated:true},200,["session=only; Secure"]),
  json({error:"dummy-password"},401),
]) test("failed/incomplete login fails closed with cooldown",async()=>{
  let count=0;const client=new MinusPodClient("http://minuspod:8000","dummy-password",async()=>{count++;return response;});
  await assert.rejects(client.call("GET","/feeds"),/server-side login failed/);
  await assert.rejects(client.call("GET","/feeds"),/cooling down/);assert.equal(count,1);
});
test("body parse errors and HTML do not echo content",async()=>{
  const {client}=fixture([new Response("SECRET"),new Response("SECRET")]);
  await assert.rejects(client.call("GET","/status"),e=>!e.message.includes("SECRET"));
});
test("oversize declared and streamed bodies are refused",async()=>{
  for (const r of [
    new Response("{}",{headers:{"content-type":"application/json","content-length":"99999999"}}),
    json({value:"x".repeat(8*1024*1024)}),
  ]) {
    const {client}=fixture([r,new Response("bad")]);
    await assert.rejects(client.call("GET","/status"),/transport\/response failed/);
  }
});
test("arbitrary paths/verbs, encoded identifiers, traversal and global writes are refused before login",async()=>{
  const {client,calls}=fixture();
  for (const [method,path] of [["GET","https://evil/feeds"],["GET","//evil/feeds"],
    ["GET","/feeds/../settings"],["GET","/feeds/show%2fsecret"],["POST","/feeds/refresh"],
    ["POST","/feeds/show/episodes/bulk"],["DELETE","/feeds/show"],["PATCH","/settings"]])
    await assert.rejects(client.call(method,path,{}),/not allowed/);
  assert.equal(calls.length,0);
});
test("untrusted base origin shapes and missing password rejected",()=>{
  for (const base of ["ftp://x","http://user:pw@x","http://x/path","http://x?key=secret"])
    assert.throws(()=>new MinusPodClient(base,"password"));
  assert.throws(()=>new MinusPodClient("http://x",""));
});
test("real fetch timeout does not replay a POST",async()=>{
  let writes=0;
  const server=http.createServer((req,res)=>{
    if (req.url.endsWith("/auth/login")) {
      res.writeHead(200,{"content-type":"application/json","set-cookie":[
        "session=session-cookie; Secure","minuspod_csrf=csrf-token; Secure"]});
      res.end('{"authenticated":true}');
    } else {writes++; /* AbortSignal must terminate this hung request. */}
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  try {
    const client=new MinusPodClient("http://127.0.0.1:"+server.address().port,"password",fetch,100);
    await assert.rejects(client.call("POST","/feeds",{}),/no write retry/);assert.equal(writes,1);
  } finally {server.closeAllConnections(); await new Promise(r=>server.close(r));}
});
