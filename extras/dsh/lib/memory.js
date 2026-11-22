import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Providers KRouter accepts on its key page; kept in sync with scripts/llm.py. */
export const KEY_NAMES = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "MOONSHOT_API_KEY",
  "DASHSCOPE_API_KEY",
];

const PLACEHOLDER = /^(YOUR_|CHANGE_ME|REPLACE|TODO|PASTE_|sk-your)/i;

export function keysFile() {
  return process.env.KROUTER_KEYS_ENV || join(homedir(), ".dsh-krouter-keys.env");
}

function usable(value) {
  const text = String(value || "").trim().replace(/^["']|["']$/g, "");
  return text.length > 0 && !PLACEHOLDER.test(text);
}

/** Read which providers currently have a usable key, without returning any value. */
export function keyStatus() {
  const path = keysFile();
  const present = [];
  if (!existsSync(path)) return { path, present };
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7);
    const index = line.indexOf("=");
    if (index < 1) continue;
    const name = line.slice(0, index).trim();
    if (KEY_NAMES.includes(name) && usable(line.slice(index + 1))) present.push(name);
  }
  return { path, present };
}

/**
 * Write one provider key into the 0600 keys file. The value never goes into the
 * DSH profile patch, the vault, or a log line; KRouter reads this file itself.
 */
export function setKey(name, value) {
  if (!KEY_NAMES.includes(name)) throw new Error(`unsupported key name: ${name}`);
  if (!usable(value)) throw new Error("key value looks like a placeholder");
  const path = keysFile();
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const kept = lines.filter(line => !new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(line.trim()));
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push(`${name}=${String(value).trim()}`);
  writeFileSync(path, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
  return { path, present: keyStatus().present };
}

export function clearKey(name) {
  if (!KEY_NAMES.includes(name)) throw new Error(`unsupported key name: ${name}`);
  const path = keysFile();
  if (!existsSync(path)) return { path, present: [] };
  const kept = readFileSync(path, "utf8").split("\n")
    .filter(line => !new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(line.trim()));
  writeFileSync(path, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
  return { path, present: keyStatus().present };
}

function excerptDir(vault) {
  return join(vault, "05 时间日志", "会话摘录");
}

function stamp(date) {
  const pad = value => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function clock(date) {
  const pad = value => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Accumulate one turn's question/answer text per session, flushed at turn end. */
export class TurnRecorder {
  constructor(vault, config, log) {
    this.vault = vault;
    this.config = config;
    this.log = log;
    this.turns = new Map();
  }

  key(sessionId) {
    return sessionId || "unknown";
  }

  state(sessionId) {
    const key = this.key(sessionId);
    if (!this.turns.has(key)) this.turns.set(key, { asked: "", answers: [], startedAt: new Date() });
    return this.turns.get(key);
  }

  noteUser(sessionId, text, cwd) {
    const state = this.state(sessionId);
    if (!state.asked) state.asked = text.slice(0, 4000);
    if (!state.cwd && cwd) state.cwd = cwd;
  }

  noteAssistant(sessionId, text) {
    const state = this.state(sessionId);
    if (text.trim()) state.answers.push(text.trim());
  }

  /** Write the accumulated turn as one bullet pair and reset it. */
  flush(sessionId) {
    if (this.config?.autoCapture === false) return null;
    const key = this.key(sessionId);
    const state = this.turns.get(key);
    if (!state || (!state.asked && state.answers.length === 0)) return null;
    this.turns.delete(key);
    if (!this.vault) return null;
    const dir = excerptDir(this.vault);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${stamp(state.startedAt)}｜${key.slice(0, 8)}.md`);
    const answer = state.answers[state.answers.length - 1] || "";
    const block = [
      `- **问**（${clock(state.startedAt)}）：${state.asked.replace(/\n+/g, " ").slice(0, 800)}`,
      answer ? `  **答**：${answer.replace(/\n+/g, "\n  ").slice(0, 2000)}` : "",
      "",
    ].filter(Boolean).join("\n");
    if (!existsSync(file)) {
      // Claude Code scopes memory per project; keep the same signal so a page
      // can be filtered by project later instead of being one global pile.
      const project = state.cwd ? state.cwd.replace(/\\/g, "/").replace(/\/+$/, "") : "";
      writeFileSync(file, [
        "---",
        "type: session-excerpt",
        "source: dsh-krouter",
        "status: imported",
        `date: ${stamp(state.startedAt)}`,
        "agent: dsh",
        `session: ${key}`,
        `project: ${project ? project.split("/").pop() : "-"}`,
        ...(project ? [`project_root: ${project}`] : []),
        "turns: 1",
        "---",
        "",
        "# 会话摘录",
        "",
        "## 摘录",
        "",
      ].join("\n"), "utf8");
    } else {
      const existing = readFileSync(file, "utf8");
      const count = Number((existing.match(/^- \*\*问\*\*/gm) || []).length) + 1;
      writeFileSync(file, existing.replace(/^turns: \d+$/m, `turns: ${count}`), "utf8");
    }
    appendFileSync(file, `${block}\n`, "utf8");
    this.log?.(`turn captured session=${key} chars=${block.length}`);
    return file;
  }
}

/** Run one nightly upkeep pass; returns the exit code and a short tail of output. */
/** Resolve a credential ref through DSH's credential service; the value never enters config or logs. */
export async function resolveModelEnv(credentials, channel) {
  if (!credentials?.resolve || !channel?.apiKeyEnv) return {};
  let value;
  try {
    const hit = await credentials.resolve(channel.apiKeyEnv);
    value = hit?.value;
  } catch {
    return {};
  }
  if (!value) return {};
  const env = { OPENAI_API_KEY: value };
  if (channel.baseURL) env.OPENAI_BASE_URL = channel.baseURL;
  if (channel.model) env.KROUTER_LEARN_MODEL = channel.model;
  return env;
}

/**
 * Read the profile patch and return one provider's `apiKeyEnv` / `baseURL`.
 * Uses `yaml` when the profile exposes it; otherwise falls back to a narrow scan
 * that only reads the two keys this plugin needs.
 */
export async function readProviderChannel(patchPath, provider) {
  if (!existsSync(patchPath) || !provider) return undefined;
  const text = readFileSync(patchPath, "utf8");
  try {
    const { parse } = await import("yaml");
    const doc = parse(text);
    const rows = Array.isArray(doc) ? doc : [];
    for (const row of rows) {
      const providers = row?.config?.providers;
      if (providers && typeof providers === "object" && providers[provider]) {
        const entry = providers[provider];
        return {
          apiKeyEnv: entry.apiKeyEnv || "",
          baseURL: entry.baseURL || "",
          api: entry.api || "",
        };
      }
    }
  } catch { /* fall through to the scan */ }
  const block = new RegExp(`\\n\\s{2,}${provider}:\\s*\\n([\\s\\S]*?)(?=\\n\\s{2,}[a-zA-Z0-9_-]+:\\s*\\n|\\n\\s*-\\s|$)`).exec(text);
  if (!block) return undefined;
  const apiKeyEnv = /apiKeyEnv:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(block[1]);
  const baseURL = /baseURL:\s*['"]?([^\s'"]+)['"]?/.exec(block[1]);
  const api = /\bapi:\s*['"]?([a-z0-9-]+)['"]?/.exec(block[1]);
  return { apiKeyEnv: apiKeyEnv?.[1] || "", baseURL: baseURL?.[1] || "", api: api?.[1] || "" };
}

export function runNightly(config, repoRoot, vault, python, log, extraEnv = {}) {  const script = join(repoRoot, "skill", "krouter", "scripts", "nightly.py");
  if (!existsSync(script)) return { ok: false, reason: "nightly.py missing" };
  const result = spawnSync(python, [script, "--vault", vault], {
    encoding: "utf8",
    timeout: 30 * 60_000,
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PYTHONLEGACYWINDOWSSTDIO: "0",
      KROUTER_VAULT: vault,
      OBSIDIAN_VAULT: vault,
      ...extraEnv,
    },
  });
  const tail = `${result.stdout || ""}${result.stderr || ""}`.trim().split("\n").slice(-8).join("\n");
  log?.(`nightly exit=${result.status} ${tail.slice(0, 400)}`);
  return { ok: result.status === 0, code: result.status, tail };
}
