import {createRequire} from "node:module";
import {McpServer} from "@modelcontextprotocol/server";
import {MinusPodClient} from "./client.js";
import {makeTools, type Tool, type ToolSet} from "./tools.js";
import {INSTRUCTIONS,registerDiscovery} from "./discovery.js";
import {jsonText} from "./contracts.js";
import {metadataText} from "./podcast-search.js";
export const SERVER_NAME="minuspod-mcp";
export const VERSION:string=createRequire(import.meta.url)("../package.json").version;
let sharedTools:ToolSet|undefined;
export function productionTools():ToolSet {
  return sharedTools??=makeTools(new MinusPodClient(
    process.env.MINUSPOD_URL??"http://minuspod:8000",
    process.env.MINUSPOD_ADMIN_PASSWORD??"",
  ),{
    paidEnabled:process.env.MINUSPOD_ENABLE_PAID_OPERATIONS==="true",
    feedHosts:(process.env.MINUSPOD_FEED_HOSTS??"").split(",").map(s=>s.trim()).filter(Boolean),
  });
}
export function createServer():McpServer { return buildServer(productionTools()); }
export function buildServer(tools:Tool[]):McpServer {
  const server=new McpServer({name:SERVER_NAME,version:VERSION},{
    instructions:INSTRUCTIONS,
  });
  for (const tool of tools) server.registerTool(tool.name,{
    title:tool.title,description:tool.description,inputSchema:tool.schema,outputSchema:tool.outputSchema,
    annotations:{readOnlyHint:tool.readOnly,destructiveHint:tool.destructive,
      idempotentHint:tool.idempotent,openWorldHint:tool.openWorld},
  },async input=>{
    try {
      // Validate explicitly too: never silently strip unsupported settings.
      const data=await tool.run(tool.schema.parse(input));
      const text=jsonText(data);
      const result=tool.outputSchema.safeParse(JSON.parse(text));
      if (!result.success) throw new Error("Sanitized MinusPod result did not match the output contract; inspect locally. No write retry.");
      return {content:[{type:"text" as const,text}],structuredContent:result.data};
    } catch (error) {
      // All client/capability errors are fixed text, never upstream response bodies.
      const text=error instanceof Error && error.name!=="ZodError" ? error.message :
        "Invalid tool input; only the documented fields are allowed";
      return {isError:true,content:[{type:"text" as const,text:metadataText(text,4000).replaceAll(
        process.env.MINUSPOD_ADMIN_PASSWORD||"\u0000","[redacted]")}]};
    }
  });
  registerDiscovery(server,tools);
  return server;
}
