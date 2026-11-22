import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { registerKrouterTools } from "./register.js";
import { parseReceipt, runRoute } from "./route.js";

export const name = "dsh-krouter";
export const inject = ["tools", "agents"];

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MCP_SERVER = join(REPO_ROOT, "skill", "krouter", "scripts", "mcp_server.py");
const SESSION_HOOK = join(REPO_ROOT, "skill", "krouter", "scripts", "session_hook.py");
const DEBUG_LOG = "D:/krouter-dsh/krouter-debug.log";

function debug(config, message) {
  if (config?.debug !== true) return;
  try {
    mkdirSync("D:/krouter-dsh", { recursive: true });
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch { /* diagnostics must never break memory */ }
}

function pythonOf(config) {
  return config?.pythonPath || process.env.KROUTER_PYTHON || process.env.PYTHON || "python";
}

function vaultOf(config) {
  return config?.vaultPath || process.env.KROUTER_VAULT || process.env.OBSIDIAN_VAULT || "";
}

function runSessionHook(kind, payload, config) {
  const vault = vaultOf(config);
  if (!vault) return "";
  const result = spawnSync(pythonOf(config), [SESSION_HOOK, kind, "--agent", "codex"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15_000,
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", KROUTER_VAULT: vault, OBSIDIAN_VAULT: vault },
  });
  const text = String(result.stdout || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return parsed?.hookSpecificOutput?.additionalContext || parsed?.additional_context || "";
  } catch {
    return text;
  }
}

function mountMcp(ctx, config) {
  if (config?.enableMcp === false) return;
  const vault = vaultOf(config);
  if (!vault || !existsSync(MCP_SERVER)) {
    console.error(`KRouter MCP: missing vault or mcp_server.py (vault=${vault})`);
    return;
  }
  ctx.inject(["mcpManager"], mcpCtx => {
    const manager = mcpCtx.mcpManager ?? mcpCtx.get?.("mcpManager");
    if (!manager) return;
    mcpCtx.effect(() => manager.register("krouter", {
      transport: "stdio",
      command: pythonOf(config),
      args: [MCP_SERVER, "--vault", vault],
      cwd: REPO_ROOT,
      env: { PYTHONIOENCODING: "utf-8" },
      startupTimeoutMs: 30_000,
    }), "krouter MCP server");
    debug(config, `mcp registered vault=${vault}`);
    const logStatus = () => {
      try {
        debug(config, `mcp status=${JSON.stringify(manager.list?.().find?.(entry => entry?.name === "krouter"))}`);
      } catch (error) {
        debug(config, `mcp list failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    setTimeout(logStatus, 1200);
    setTimeout(logStatus, 5000);
  });
}

function eventText(event) {
  const data = event?.data ?? {};
  const message = data.message ?? data;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text);
    return texts[0] ?? "";
  }
  return "";
}

function mountHooks(ctx, config) {
  if (config?.enableHooks === false) return;
  const attach = agent => {
    if (agent?.ctx === undefined) return;
    if (agent?.session?.header?.origin === "subagent" && config?.enableSubagentHooks !== true) return;
    const cwd = agent.session?.header?.cwd;
    const sessionId = agent.session?.id;
    if (!cwd || !sessionId) return;
    debug(config, `agent seen=${sessionId} origin=${agent.session?.header?.origin ?? "main"}`);
    const start = runSessionHook("start", { session_id: sessionId, cwd, transcript_path: "" }, config);
    if (start) {
      try {
        agent.inject?.({
          id: `krouter-start-${Date.now()}`,
          role: "user",
          content: [{ type: "text", text: start }],
          source: { kind: "krouter-hook" },
        });
      } catch { /* best effort */ }
    }
    ctx.effect(() => agent.ctx.on("session/event", (session, event) => {
      try {
        if (event?.type !== "user/message" || session?.id !== sessionId) return;
        if (event?.data?.source?.kind === "krouter-hook") return;
        const prompt = eventText(event);
        debug(config, `session event type=${event?.type} agent=${sessionId} promptLen=${prompt.length}`);
        if (!prompt.trim()) return;
        let text = "";
        try {
          const route = runRoute({
            route: "search",
            query: prompt.slice(0, 200),
            vault: vaultOf(config),
            router: config.routerScript || "",
          });
          const receipt = parseReceipt(route.stdout || "");
          if (route.ok && receipt.canonical_match === "true") text = route.stdout;
        } catch (error) {
          debug(config, `route recall failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!text) {
          text = runSessionHook("prompt", { session_id: sessionId, cwd, prompt, transcript_path: "" }, config);
        }
        if (text) {
          const injection = text;
          setTimeout(() => {
            try {
              agent.inject?.({
                id: `krouter-prompt-${Date.now()}`,
                role: "user",
                content: [{ type: "text", text: injection }],
                source: { kind: "krouter-hook" },
              });
              debug(config, `hook injected agent=${sessionId} chars=${injection.length}`);
            } catch (error) {
              debug(config, `hook inject failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }, 0);
        } else {
          debug(config, `hook no recall agent=${sessionId}`);
        }
      } catch (error) {
        debug(config, `prompt hook failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }), "krouter session hook");
    debug(config, `hooks attached agent=${sessionId}`);
  };
  for (const agent of ctx.agents?.list?.() ?? []) attach(agent);
  ctx.effect(() => ctx.on("agent/created", ({ agent }) => attach(agent)), "krouter agent hook wiring");
}


function usable(val) {
  const v = String(val || "").trim();
  if (!v) return false;
  return !/^(YOUR_|CHANGE_ME|REPLACE|TODO)/.test(v);
}

function isKeyName(name) {
  return /(_API_KEY|_API_TOKEN)$/.test(name) || name === "HF_TOKEN" || name === "KROUTER_CLI_LOGIN";
}

function keyPresent() {
  if (process.env.KROUTER_WRITER && existsSync(process.env.KROUTER_WRITER)) return true;
  if (Object.keys(process.env).some((n) => isKeyName(n) && usable(process.env[n]))) return true;
  const path = process.env.KROUTER_KEYS_ENV || join(homedir(), ".dsh-krouter-keys.env");
  if (existsSync(path)) {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      let line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice(7);
      const idx = line.indexOf("=");
      if (idx < 1) continue;
      const name = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (isKeyName(name) && usable(val)) return true;
    }
  }
  const vault = process.env.KROUTER_VAULT || process.env.OBSIDIAN_VAULT || "";
  const page = join(vault, "90 系统文件", "自动化", "自进化钥匙.md");
  if (vault && existsSync(page)) {
    for (const raw of readFileSync(page, "utf8").split("\n")) {
      const m = raw.match(/^([A-Z][A-Z0-9_]+)=(.*)$/);
      if (m && isKeyName(m[1]) && usable(m[2])) return true;
    }
  }
  return false;
}

export const Config = z.object({
  vaultPath: z
    .string()
    .default("")
    .description("Absolute path of the memory folder. Empty uses KROUTER_VAULT, then OBSIDIAN_VAULT."),
  routerScript: z
    .string()
    .default("")
    .description(
      "Absolute path to route_knowledge.sh. Empty uses KROUTER_ROUTER, then ~/.agents/skills/krouter.",
    ),
  pythonPath: z
    .string()
    .default("")
    .description("Python executable for the MCP server and session hooks. Empty uses KROUTER_PYTHON/PYTHON, then python."),
  enableMcp: z.boolean().default(true),
  enableHooks: z.boolean().default(true),
  enableSubagentHooks: z.boolean().default(false),
  debug: z.boolean().default(false),
});

export function apply(ctx, config = {}) {
  registerKrouterTools(ctx, config, defineTool);
  mountMcp(ctx, config);
  mountHooks(ctx, config);
  if (!keyPresent()) {
    console.error(
      "KRouter HOST ACTION: login a Claudian-class CLI (grok / official Codex / claude) or put *_API_KEY on the vault page / ~/.dsh-krouter-keys.env. Chat login is not the timer. Run ./scripts/install.sh to graft the writer.",
    );
  }
}
