import { execFileSync } from "child_process";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";

export interface McpStatusContext {
  serverName: string;
  serverVersion: string;
  startedAt: Date;
  startupGitCommit: string | null;
  pobDirectory: string;
  luaEnabled: boolean;
  getLuaClient: () => PoBLuaApiClient | null;
  readCurrentGitCommit?: () => string | null;
  now?: () => Date;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function readGitCommit(cwd: string = process.cwd()): string | null {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return commit || null;
  } catch {
    return null;
  }
}

function formatBuildInfo(info: any): string {
  const parts: string[] = [];

  if (info?.name) parts.push(String(info.name));
  if (info?.level) parts.push(`level ${info.level}`);

  const classParts = [info?.className, info?.ascendancy].filter(Boolean).map(String);
  if (classParts.length > 0) parts.push(classParts.join(" / "));

  if (info?.treeVersion) parts.push(`tree ${info.treeVersion}`);

  return parts.length > 0 ? parts.join(" — ") : "unknown loaded build";
}

function isBootstrapBuild(info: any): boolean {
  const name = String(info?.name ?? "");
  return name.trim().toLowerCase() === "init test";
}

export async function handleMcpStatus(context: McpStatusContext) {
  const now = context.now?.() ?? new Date();
  const currentGitCommit = context.readCurrentGitCommit?.() ?? readGitCommit();
  const luaClient = context.getLuaClient();
  const warnings: string[] = [];

  let luaState = context.luaEnabled ? "enabled" : "disabled";
  let loadedBuild = "(none)";

  if (!context.luaEnabled) {
    warnings.push("Lua bridge is disabled; loaded-build tools cannot inspect live PoB state.");
  } else if (!luaClient) {
    luaState = "enabled, not started";
    warnings.push("Lua bridge is enabled but no Lua client is active; load a build before trusting loaded-build analysis tools.");
  } else if (!luaClient.isAlive()) {
    luaState = "enabled, process not ready";
    warnings.push("Lua bridge client exists but is not ready; restart or run lua_start before loaded-build analysis.");
  } else {
    luaState = "enabled, active";
    try {
      const info = await luaClient.getBuildInfo();
      loadedBuild = formatBuildInfo(info);
      if (isBootstrapBuild(info)) {
        warnings.push("Loaded build is the Lua bootstrap build (Init Test); run lua_load_build or lua_import_character before analysis.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      loadedBuild = `(unavailable: ${message})`;
      warnings.push("Unable to read the loaded build; reload the build before interpreting build-specific recommendations.");
    }
  }

  if (
    context.startupGitCommit &&
    currentGitCommit &&
    context.startupGitCommit !== currentGitCommit
  ) {
    warnings.push(
      `Server code may be stale: started at ${context.startupGitCommit}, working tree now reports ${currentGitCommit}. Restart the MCP server.`
    );
  }

  const lines = [
    "=== MCP Status ===",
    "",
    "## Server",
    `- Name: ${context.serverName}`,
    `- Version: ${context.serverVersion}`,
    `- Started: ${context.startedAt.toISOString()}`,
    `- Uptime: ${formatDuration(now.getTime() - context.startedAt.getTime())}`,
    `- Startup git commit: ${context.startupGitCommit ?? "unknown"}`,
    `- Current git commit: ${currentGitCommit ?? "unknown"}`,
    "",
    "## Runtime",
    `- Builds directory: ${context.pobDirectory}`,
    `- Lua bridge: ${luaState}`,
    `- Loaded build: ${loadedBuild}`,
    "",
    "## Warnings",
  ];

  if (warnings.length === 0) {
    lines.push("- None detected.");
  } else {
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: lines.join("\n"),
      },
    ],
  };
}
