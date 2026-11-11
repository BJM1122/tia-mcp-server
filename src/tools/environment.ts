import { realpath } from "node:fs/promises";
import net from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  allowedOutputRoots, getAllowedProjectRoots, isAllowedProjectPath, normalizePath, normalizeTiaProjectPath
} from "../core/local-paths.js";
import { jsonResult, type JsonValue } from "../core/results.js";
import { op } from "../core/tool-op.js";
import {
  collectApiEvidence, collectDoctorReport, requiredCapability, SERVER_VERSION, splitValidatedConfig, validateConfig, validateSnapshotAdapter
} from "../environment.js";
import { liveCoreOptions } from "../live-session.js";
import { validateImporterForVersion } from "../plc-importer.js";
import { portalVersionReport } from "../native-capabilities.js";
import { type TiaCapabilityKey } from "../tia-capabilities.js";
import { queryTiaLiveCore } from "../tia-live-core.js";
import {
  portalVersion as portalVersionProfile, projectExtensions, readOnlyProjectVersion, supportedVersionIds
} from "../tia-version.js";

// Environment, doctor, live-core status, network probe and online capability tools.

const DEFAULT_PROBE_HOSTS = ["127.0.0.1", "localhost"];

const DEFAULT_PROBE_PORTS = [102, 4840, 80, 443];

function getAllowedProbeHosts(): string[] {
  return (process.env.TIA_MCP_ALLOWED_PROBE_HOSTS ?? DEFAULT_PROBE_HOSTS.join(","))
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function getAllowedProbePorts(): number[] {
  return (process.env.TIA_MCP_ALLOWED_PROBE_PORTS ?? DEFAULT_PROBE_PORTS.join(","))
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

async function probeTcpPort(host: string, port: number, timeoutMs: number) {
  return new Promise<Record<string, JsonValue>>((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;

    function finish(open: boolean, error: string) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, open, error, elapsedMs: Date.now() - started });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, ""));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => finish(false, error.message));
  });
}

export function registerEnvironmentTools(server: McpServer) {
  const validateEnvironment = op({
        projectPath: z.string().optional().describe(`Optional exact project path (${projectExtensions("snapshot_export").join(", ")}).`),
        portalVersion: z.enum(supportedVersionIds()).optional().describe("Version to validate when no project path is supplied; defaults to V20.")
      },
    async ({ projectPath, portalVersion }) => {
      const selectedVersion = projectPath ? readOnlyProjectVersion(projectPath) : portalVersion ?? "V20";
      if (portalVersion && portalVersion !== selectedVersion) return jsonResult({ ok: false, status: "project_version_mismatch" });
      if (portalVersionProfile(selectedVersion).adapter === "v15-snapshot") {
        const validated = await validateSnapshotAdapter(selectedVersion);
        const importer = await validateImporterForVersion(selectedVersion);
        validated.projectImportReady = importer.available;
        validated.readOnly = !importer.available;
        validated.importer = importer as unknown as JsonValue;
        validated.portalVersions = await portalVersionReport() as unknown as JsonValue;
        if (projectPath) {
          try {
            const canonical = await realpath(normalizePath(projectPath));
            if (readOnlyProjectVersion(canonical) !== selectedVersion) throw new Error("Canonical project version mismatch.");
            if (process.env.TIA_MCP_ALLOW_ANY_PROJECT_PATH !== "1" && !isAllowedProjectPath(canonical)) throw new Error("Project is outside allowed roots.");
            validated.projectPath = canonical;
          } catch (error) {
            return jsonResult({ ...validated, ok: false, ready: false, status: "project_path_invalid", error: error instanceof Error ? error.message : String(error) });
          }
        }
        return jsonResult(validated);
      }
      if (!projectPath) {
        const validated = splitValidatedConfig(await validateConfig());
        return jsonResult({
          ok: validated.capabilityReport.readiness.coreReadReady,
          status: validated.capabilityReport.status,
          ready: validated.capabilityReport.status === "ready",
          checks: validated.checks as unknown as JsonValue,
          capabilities: validated.capabilityReport as unknown as JsonValue,
          // capabilities = verified by self-test; declaredCapabilities = table upper bound.
          portalVersions: await portalVersionReport() as unknown as JsonValue,
          allowedProjectRoots: getAllowedProjectRoots() as JsonValue,
          allowedExportRoots: allowedOutputRoots as JsonValue
        });
      }
      const checks = await validateConfig();
      let canonicalProjectPath = "";
      try {
        canonicalProjectPath = await normalizeTiaProjectPath(projectPath);
      } catch (error) {
        return jsonResult({
          ok: false,
          status: "project_path_invalid",
          error: error instanceof Error ? error.message : String(error),
          checks: splitValidatedConfig(checks).checks as unknown as JsonValue,
          capabilities: checks.capabilityReport as unknown as JsonValue
        });
      }
      if (!checks.capabilityReport.capabilities.projectExport.available) {
        return jsonResult({
          ok: false,
          status: "capability_unavailable",
          reason: {
            code: checks.capabilityReport.capabilities.projectExport.reasonCode,
            message: checks.capabilityReport.capabilities.projectExport.summary,
            missingComponents: checks.capabilityReport.capabilities.projectExport.missingComponents
          },
          project: {
            path: canonicalProjectPath,
            pathValidated: true,
            lockState: "not_checked"
          },
          checks: splitValidatedConfig(checks).checks as unknown as JsonValue,
          capabilities: checks.capabilityReport as unknown as JsonValue
        });
      }
      return jsonResult({
        ok: true,
        status: "project_path_valid",
        project: {
          path: canonicalProjectPath,
          pathValidated: true,
          lockState: "not_checked",
          attached: false
        },
        checks: splitValidatedConfig(checks).checks as unknown as JsonValue,
        capabilities: checks.capabilityReport as unknown as JsonValue,
        guarantees: {
          tiaAttached: false,
          projectModified: false,
          plcAccessed: false
        }
      });
    }
  );
  const doctor = op({
        require: z.enum([
          "core-read",
          "project-export",
          "project-import",
          "network-probe"
        ]).optional().describe("Optional capability that must be ready for ok=true.")
      },
    async ({ require }) => {
      const validated = await collectDoctorReport();
      const requirement = requiredCapability(validated.capabilityReport, require);
      return jsonResult({
        ok: requirement?.available ?? validated.status === "ready",
        status: requirement && !requirement.available
          ? "required_capability_unavailable"
          : validated.capabilityReport.status,
        serverVersion: SERVER_VERSION,
        requiredCapability: require ?? "",
        portalVersions: validated.portalVersions as unknown as JsonValue,
        unavailableCapabilities: validated.unavailableCapabilities as unknown as JsonValue,
        requirement: requirement as unknown as JsonValue,
        checks: validated.checks as unknown as JsonValue,
        capabilityReport: validated.capabilityReport as unknown as JsonValue,
        guarantees: {
          tiaAttached: false,
          residentWorkerStarted: false,
          projectModified: false,
          plcAccessed: false
        }
      });
    }
  );
  const liveCoreStatus = op({
        timeoutMs: z.number().int().min(1_000).max(60_000).default(5_000)
      },
    async ({ timeoutMs }) => {
      const checks = await validateConfig();
      const liveRead = checks.capabilityReport.capabilities.residentLiveRead;
      if (!liveRead.available) {
        return jsonResult({
          ok: false,
          status: "capability_unavailable",
          reason: liveRead as unknown as JsonValue
        });
      }
      try {
        const response = await queryTiaLiveCore(
          { operation: "ping", timeoutMs },
          liveCoreOptions(timeoutMs)
        );
        return jsonResult({
          ...response,
          capability: liveRead as unknown as JsonValue,
          guarantees: {
            projectModified: false,
            projectOpenedClosedSavedOrCompiled: false,
            plcAccessed: false
          }
        } as Record<string, JsonValue>);
      } catch (error) {
        return jsonResult({
          ok: false,
          status: "live_core_unavailable",
          error: error instanceof Error ? error.message : String(error),
          capability: liveRead as unknown as JsonValue
        });
      }
    }
  );
  server.registerTool(
    "plc_probe_ports",
    {
      title: "Probe PLC Ports",
      description: "Read-only TCP connectivity probe for likely S7/OPC UA/Web API endpoints. Does not authenticate or read PLC data.",
      inputSchema: {
        host: z.string(),
        ports: z.array(z.number().int().min(1).max(65535)).max(16).default([102, 4840, 80, 443]),
        timeoutMs: z.number().int().min(100).max(10_000).default(1500)
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ host, ports, timeoutMs }) => {
      if (process.env.TIA_MCP_ENABLE_NETWORK_PROBE !== "1") {
        return jsonResult({
          ok: false,
          blocked: true,
          reason: "Network probing is disabled by default. Set TIA_MCP_ENABLE_NETWORK_PROBE=1 and TIA_MCP_ALLOWED_PROBE_HOSTS for a deliberate read-only session."
        });
      }
      const allowedHosts = getAllowedProbeHosts();
      if (!allowedHosts.includes(host.toLowerCase())) {
        return jsonResult({
          ok: false,
          blocked: true,
          reason: `Host is not in TIA_MCP_ALLOWED_PROBE_HOSTS: ${host}`,
          allowedHosts
        });
      }
      const allowedPorts = getAllowedProbePorts();
      const rejectedPorts = ports.filter((port) => !allowedPorts.includes(port));
      if (rejectedPorts.length > 0) {
        return jsonResult({
          ok: false,
          blocked: true,
          reason: `Ports are not in TIA_MCP_ALLOWED_PROBE_PORTS: ${rejectedPorts.join(",")}`,
          allowedPorts
        });
      }
      const results = await Promise.all(ports.map((port) => probeTcpPort(host, port, timeoutMs)));
      return jsonResult({
        ok: true,
        host,
        timeoutMs,
        results: results as JsonValue,
        interpretation: "Open 102 suggests S7 communication is reachable; open 4840 suggests OPC UA may be reachable; open 80/443 suggests Web API or web server may be reachable. This is not proof that credentials, tag permissions, or online monitoring are configured."
      });
    }
  );
  const onlineCapabilityReport = op({
        includeLocalApiEvidence: z.boolean().default(true)
      },
    async ({ includeLocalApiEvidence }) => {
      const environment = await validateConfig();
      const capabilityReport = environment.capabilityReport;
      const evidence = includeLocalApiEvidence ? await collectApiEvidence() : [];
      const supportedNow = [
        capabilityReport.capabilities.offlineIndexRead.available
          ? "Read existing bounded TIA export indexes."
          : null,
        capabilityReport.capabilities.offlineBatchLookup.available
          ? "Resolve up to 50 cached offline queries in one MCP call."
          : null,
        capabilityReport.capabilities.currentUiContext.available
          ? "Observe the exact current TIA V20 process and canonical project path."
          : null,
        capabilityReport.capabilities.residentLiveRead.available
          ? "Query exact blocks, PLC types, tag tables, and PLC tags through the resident attached-only Openness core."
          : null,
        capabilityReport.capabilities.liveBatchQuery.available
          ? "Query up to 50 exact live project objects after one current-project observation while reusing the resident core."
          : null,
        capabilityReport.capabilities.projectExport.available
          ? "Export all PLC blocks, PLC types, and complete tag tables, then build bounded local indexes and an execution model."
          : null,
        capabilityReport.capabilities.singleBlockImport.available
          ? "Create an exact live-session plan and apply one confirmed block import with compile and verification."
          : null,
        capabilityReport.capabilities.networkProbe.available
          ? "Probe allowlisted PLC TCP endpoints without authenticating or reading data."
          : null
      ].filter((item): item is string => item !== null);
      const configuredButDisabled = [
        capabilityReport.capabilities.networkProbe.state === "disabled_by_policy"
          ? "TCP endpoint probing is installed but disabled until TIA_MCP_ENABLE_NETWORK_PROBE=1 and explicit allowlists are set."
          : null
      ].filter((item): item is string => item !== null);
      const unavailableNow = ([
        "projectExport",
        "singleBlockImport",
        "liveBatchQuery",
        "hardwareAndNetworkEngineering",
        "projectLifecycle"
      ] as TiaCapabilityKey[])
        .map((key) => ({ key, capability: capabilityReport.capabilities[key] }))
        .filter(({ capability }) => !capability.available)
        .map(({ key, capability }) => ({
          capability: key,
          state: capability.state,
          reasonCode: capability.reasonCode,
          summary: capability.summary,
          missingComponents: capability.missingComponents
        }));
      return jsonResult({
        summary: "Openness can establish online state and download, but this MCP server does not claim full Portal-style network monitoring. Variable-level live monitoring should be implemented through PLC Web API, OPC UA, or a dedicated S7 read path after a test PLC/PLCSIM proof.",
        status: capabilityReport.status,
        supportedNow,
        configuredButDisabled,
        unavailableNow: unavailableNow as unknown as JsonValue,
        intentionallyBlocked: [
          "Downloading to a real PLC.",
          "Forcing variables or writing live PLC values.",
          "Claiming full LAD/FBD green-flow monitoring from public Openness APIs."
        ],
        recommendedNextProof: [
          "Test OnlineProvider.GoOnline against PLCSIM or a lab S7-1200/1500.",
          "Test PLC Web API or OPC UA reads for a small variable whitelist.",
          "Map offline condition chains to live variable reads before adding any write path."
        ],
        capabilityReport: capabilityReport as unknown as JsonValue,
        localApiEvidence: evidence as JsonValue
      });
    }
  );
  const section = async (result: Promise<{ structuredContent?: Record<string, JsonValue> }>) => (await result).structuredContent ?? null;
  server.registerTool(
    "tia_doctor",
    {
      title: "TIA MCP Doctor",
      description: "Read-only capability diagnosis shared with the CLI: installed files, policy gates and stale native binaries. By default it attaches to nothing and starts nothing. Optional sections: projectPath or portalVersion adds `environment` (project path and version-adapter validation); liveCore=true starts the resident read-only core when absent and adds its version, uptime and attached session; onlineReport=true adds the online-monitoring boundary report.",
      inputSchema: {
        require: z.enum(["core-read", "project-export", "project-import", "network-probe"]).optional().describe("Optional capability that must be ready for ok=true."),
        projectPath: z.string().optional().describe(`Exact project path to validate (${projectExtensions("snapshot_export").join(", ")}). Versions other than V20 have snapshot export and block import only.`),
        portalVersion: z.enum(supportedVersionIds()).optional().describe("Version to validate when no project path is given."),
        liveCore: z.boolean().default(false),
        onlineReport: z.boolean().default(false),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(5_000).describe("Only for liveCore.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async ({ require, projectPath, portalVersion, liveCore, onlineReport, timeoutMs }) => {
      const report = await section(doctor({ require })) ?? {};
      if (projectPath || portalVersion) report.environment = await section(validateEnvironment({ projectPath, portalVersion }));
      if (liveCore) {
        report.liveCore = await section(liveCoreStatus({ timeoutMs }));
        report.guarantees = { ...report.guarantees as Record<string, JsonValue>, residentWorkerStarted: true };
      }
      if (onlineReport) report.online = await section(onlineCapabilityReport({}));
      return jsonResult(report);
    }
  );
}
