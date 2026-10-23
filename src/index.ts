import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only: stdout is the MCP protocol channel.
  console.error("subq-snap-mcp: server running on stdio");
}

main().catch((err: unknown) => {
  console.error("subq-snap-mcp: fatal error starting server:", err);
  process.exit(1);
});
