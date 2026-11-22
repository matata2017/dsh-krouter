import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { registerKrouterTools } from "./register.js";
import { parseReceipt, runRoute } from "./route.js";
import { KEY_NAMES, TurnRecorder, clearKey, keyStatus, readProviderChannel, resolveModelEnv, runNightly, setKey } from "./memory.js";

export const name = "dsh-krouter";
export const inject = ["tools", "agents", "timer", "credentials"];

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
  const recorder = new TurnRecorder(vaultOf(config), config, message => debug(config, message));
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
        if (session?.id !== sessionId) return;
        debug(config, `event type=${event?.type} agent=${sessionId}`);
        if (event?.type === "turn/end") {
          const file = recorder.flush(sessionId);
          debug(config, `turn/end flush=${file ? "written" : "empty"} agent=${sessionId}`);
          return;
        }
        if (event?.type === "assistant/message") {
          recorder.noteAssistant(sessionId, eventText(event));
          return;
        }
        if (event?.type !== "user/message") return;
        if (event?.data?.source?.kind === "krouter-hook") return;
        const prompt = eventText(event);
        recorder.noteUser(sessionId, prompt, cwd);
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
  mountNightly(ctx, config);
}

function mountNightly(ctx, config) {
  const hours = Number(config?.nightlyEveryHours ?? 0);
  if (!Number.isFinite(hours) || hours <= 0) return;
  const vault = vaultOf(config);
  if (!vault) return;

  // Follow the agent's current model. `request/header` carries the exact
  // provider/model of the next request and fires far more often than
  // `model/selection` (which only records a change).
  const follow = config?.followAgentModel !== false;
  const live = { provider: "", model: "" };
  let sawHeader = false;
  const recordSelection = event => {
    if (!follow) return;
    const data = event?.data || {};
    let provider = "";
    let model = "";
    if (event?.type === "request/header") {
      const callConfig = data.header?.config;
      provider = String(callConfig?.provider || "");
      model = String(callConfig?.model || "");
      sawHeader = true;
    } else if (event?.type === "model/selection") {
      provider = String(data.provider || "");
      model = String(data.model || "");
    } else {
      return;
    }
    const changed = (provider && provider !== live.provider) || (model && model !== live.model);
    if (provider) live.provider = provider;
    if (model) live.model = model;
    if (changed) debug(config, `model followed provider=${live.provider} model=${live.model}`);
  };
  if (follow) {
    for (const agent of ctx.agents?.list?.() ?? []) {
      ctx.effect(() => agent.ctx.on("session/event", (session, event) => recordSelection(event)), "krouter model follow");
    }
    ctx.effect(() => ctx.on("agent/created", ({ agent }) => {
      ctx.effect(() => agent.ctx.on("session/event", (session, event) => recordSelection(event)), "krouter model follow");
    }), "krouter model follow wiring");
  }

  const channelFor = async () => {
    const explicit = config?.modelChannel || {};
    if (explicit.apiKeyEnv) return explicit;
    if (!follow) return undefined;
    if (!live.provider) {
      debug(config, "model follow: no request/header seen yet, so no model channel");
      return undefined;
    }
    const provider = live.provider;
    const model = live.model;
    const patchPath = join(ctx.profileContext?.dir || "", "cordis.patch.yml");
    const found = await readProviderChannel(patchPath, provider);
    if (!found?.apiKeyEnv) {
      debug(config, `model follow: provider=${provider} has no apiKeyEnv in ${patchPath}`);
      return undefined;
    }
    if (found.api && found.api !== "openai-completions") {
      debug(config, `model follow: provider=${provider} api=${found.api} is not openai-completions; KRouter needs an OpenAI-style endpoint`);
      return undefined;
    }
    return { ...found, model };
  };

  const run = () => {
    channelFor().then(channel => {
      const env = channel?.apiKeyEnv ? resolveModelEnv(ctx.credentials, channel) : Promise.resolve({});
      return env.then(extraEnv => {
        debug(config, `nightly model env keys=${Object.keys(extraEnv).join(",") || "none"}`);
        const result = runNightly(config, REPO_ROOT, vault, pythonOf(config), message => debug(config, message), extraEnv);
        debug(config, `nightly done ok=${result.ok}`);
      });
    }).catch(error => {
      debug(config, `nightly failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  ctx.effect(() => ctx.interval(run, hours * 3600_000), "krouter nightly");

  // The first run waits for a request/header so it does not silently skip the
  // model steps right after a plugin reload; if none arrives within 30 minutes,
  // run anyway (the model-dependent steps then skip, as designed).
  const FIRST_DELAY = 60_000;
  const FIRST_MAX_WAIT = 30 * 60_000;
  const startedAt = Date.now();
  const tryFirst = () => {
    if (follow && !sawHeader && Date.now() - startedAt < FIRST_MAX_WAIT) {
      setTimeout(tryFirst, 30_000);
      return;
    }
    debug(config, `nightly first run (header seen=${sawHeader})`);
    run();
  };
  setTimeout(tryFirst, FIRST_DELAY);
  debug(config, `nightly scheduled every ${hours}h follow=${follow}`);
}

function mountKeys(ctx, config) {
  if (config?.enableKeyTools === false) return;
  const tool = {
    name: "krouter_keys",
    description:
      "Inspect, set or clear the model API key KRouter's nightly distillation uses. Values go to the 0600 keys file (~/.dsh-krouter-keys.env), never into the DSH profile patch or the vault. Actions: status, set, clear.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["status", "set", "clear"] },
        name: { type: "string", description: `Provider key name, one of: ${KEY_NAMES.join(", ")}` },
        value: { type: "string", description: "Key value for action=set. Never echoed back." },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          text: { type: "string" },
        },
        required: ["ok", "text"],
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(input) {
      try {
        if (input.action === "status") {
          const status = keyStatus();
          return {
            ok: true,
            text: [
              `keys file: ${status.path}`,
              status.present.length > 0 ? `configured: ${status.present.join(", ")}` : "configured: none",
            ].join("\n"),
          };
        }
        if (input.action === "set") {
          if (!input.name || !input.value) throw new Error("set requires name and value");
          const status = setKey(String(input.name), String(input.value));
          debug(config, `key set name=${input.name}`);
          return { ok: true, text: `saved ${input.name} to ${status.path}\nconfigured: ${status.present.join(", ") || "none"}` };
        }
        if (input.action === "clear") {
          if (!input.name) throw new Error("clear requires name");
          const status = clearKey(String(input.name));
          debug(config, `key cleared name=${input.name}`);
          return { ok: true, text: `removed ${input.name}\nconfigured: ${status.present.join(", ") || "none"}` };
        }
        throw new Error(`unknown action: ${input.action}`);
      } catch (error) {
        return { ok: false, text: `krouter_keys error: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
  ctx.effect(() => ctx.tools.register(tool), "krouter keys tool");
  debug(config, "krouter_keys tool registered");
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
  enableKeyTools: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  nightlyEveryHours: z.number().default(0).description("Run nightly upkeep every N hours. 0 disables the timer."),
  modelChannel: z.object({
    apiKeyEnv: z.string().default("").description("Credential ref resolved through DSH, e.g. MAGPIE_GATEWAY_KEY."),
    baseURL: z.string().default("").description("OpenAI-compatible base URL, e.g. http://127.0.0.1:3425/v1."),
    model: z.string().default("").description("Model id passed to KRouter as KROUTER_LEARN_MODEL."),
  }).default({ apiKeyEnv: "", baseURL: "", model: "" }),
  followAgentModel: z.boolean().default(true).description(
    "Read the agent's current provider/model from model/selection and reuse that provider's apiKeyEnv + baseURL. Overrides modelChannel when set.",
  ),
  debug: z.boolean().default(false),
});

export function apply(ctx, config = {}) {
  registerKrouterTools(ctx, config, defineTool);
  mountMcp(ctx, config);
  mountHooks(ctx, config);
  mountKeys(ctx, config);
  if (!keyPresent()) {
    console.error(
      "KRouter HOST ACTION: login a Claudian-class CLI (grok / official Codex / claude) or put *_API_KEY on the vault page / ~/.dsh-krouter-keys.env. Chat login is not the timer. Run ./scripts/install.sh to graft the writer.",
    );
  }
}
