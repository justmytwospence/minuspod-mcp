#!/usr/bin/env node
// Based on justmytwospence/hardcover-mcp: SDK owns stdio and HTTP protocol handling.
import {serve} from "@hono/node-server";
import {createMcpHonoApp} from "@modelcontextprotocol/hono";
import {createMcpHandler} from "@modelcontextprotocol/server";
import {serveStdio} from "@modelcontextprotocol/server/stdio";
import type {Context} from "hono";
import {createServer,productionTools,SERVER_NAME,VERSION} from "./server.js";
productionTools(); // Fail startup if server-side authentication is missing.
const transport=(process.env.MCP_TRANSPORT??"stdio").toLowerCase();
if (transport==="stdio") {
  serveStdio(createServer);
  console.error(`${SERVER_NAME} ${VERSION} running via stdio`);
} else if (transport==="http") {
  const port=Number(process.env.PORT??8000);
  const extra=(process.env.MCP_ALLOWED_HOSTS??"").split(",").map(h=>h.trim()).filter(Boolean);
  if (!extra.length) throw new Error("MCP_ALLOWED_HOSTS is required for HTTP; deploy behind OAuth");
  const handler=createMcpHandler(createServer);
  const app=createMcpHonoApp({host:"0.0.0.0",allowedHosts:["localhost","127.0.0.1",...extra]});
  app.get("/health",c=>c.json({status:"ok",name:SERVER_NAME,version:VERSION}));
  const mcp=(c:Context)=>handler.fetch(c.req.raw,{parsedBody:c.get("parsedBody")});
  app.all("/mcp",mcp);
  app.all("/",mcp); // agentgateway target convention matches Hardcover.
  const http=serve({fetch:app.fetch,port,hostname:"0.0.0.0"},info=>
    console.error(`${SERVER_NAME} ${VERSION} listening on port ${info.port}`));
  const shutdown=async()=>{await handler.close();http.close(()=>process.exit(0));};
  process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
} else throw new Error("MCP_TRANSPORT must be stdio or http");
