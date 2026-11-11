#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  runDoctorCli, runExportSnapshotCli, runLiveBatchCli, runLiveCoreStatusCli, runLiveCurrentBlockCli, runLiveQueryCli,
  runPrepareLiveSessionCli
} from "./cli.js";
import { SERVER_VERSION, validateConfig } from "./environment.js";
import { refreshPreparedLiveInventory, resolveWorkflowSession } from "./live-session.js";
import { registerEnvironmentTools } from "./tools/environment.js";
import { registerExportAnalysisTools } from "./tools/export-analysis.js";
import { registerHmiTools } from "./tools/hmi.js";
import { registerLiveTools } from "./tools/live.js";
import { registerPlcImportTools } from "./tools/plc-import.js";

function registerTools(server: McpServer) {
  registerHmiTools(server);
  registerEnvironmentTools(server);
  registerExportAnalysisTools(server, registerLiveTools(server));
  registerPlcImportTools(server, { resolveExactLiveSession: (args) => resolveWorkflowSession(args, false, true), refreshPreparedLiveInventory });
}

async function main() {
  if (process.argv.includes("--list-tools")) {
    const tools: string[] = [];
    registerTools({ registerTool: (name: string) => { tools.push(name); } } as unknown as McpServer);
    console.log(JSON.stringify({ name: "tia-portal-mcp-server", version: SERVER_VERSION, tools }, null, 2));
    return;
  }

  if (process.argv.includes("--validate-config")) {
    console.log(JSON.stringify(await validateConfig(), null, 2));
    return;
  }

  if (process.argv.includes("--doctor")) {
    await runDoctorCli();
    return;
  }

  if (process.argv.includes("--live-core-status") || process.argv.includes("--prewarm")) {
    await runLiveCoreStatusCli();
    return;
  }

  if (process.argv.includes("--prepare-live-session")) {
    await runPrepareLiveSessionCli();
    return;
  }

  if (process.argv.includes("--export-snapshot")) {
    await runExportSnapshotCli();
    return;
  }

  if (process.argv.includes("--live-current-block")) {
    await runLiveCurrentBlockCli();
    return;
  }

  if (process.argv.includes("--live-query")) {
    await runLiveQueryCli();
    return;
  }

  if (process.argv.includes("--live-batch")) {
    await runLiveBatchCli();
    return;
  }

  const server = new McpServer({
    name: "tia-portal-mcp-server",
    version: SERVER_VERSION
  });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TIA Portal MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in TIA Portal MCP server:", error);
  process.exit(1);
});
