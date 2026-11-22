# KRouter for DeepSeek Harness

This folder is the KRouter source plus its DSH socket, configured against the
bundled `vault/` template.

## Installed surfaces

- **7 native DSH tools** (from `extras/dsh/lib/register.js`):
  `krouter_status`, `krouter_preference`, `krouter_correction`, `krouter_memory`,
  `krouter_project`, `krouter_search`, `krouter_suggest`.
- **5 MCP tools** (`skill/krouter/scripts/mcp_server.py`, registered through
  `ctx.mcpManager`): `krouter_ask`, `krouter_status`, `krouter_note`,
  `krouter_correct`, `krouter_learn`.
- **DSH hooks**: session-start context and user-prompt recall are wired in
  `extras/dsh/lib/index.js` over `agent/created` and `session/event`. A real
  subagent event was observed injecting a `source.kind = krouter-hook` user
  message (`hook injected ... chars=761`); the primary user-message path was
  not separately observed. `enableSubagentHooks` is `false` by default and was
  enabled only for that isolated injection test, then reverted.
- **Turn capture**: `turn/end` flushes one excerpt page per session and day to
  `05 时间日志/会话摘录/`, matching KRouter's `session-excerpt` format. Verified
  live: a subagent turn produced `event type=turn/end` →
  `turn captured session=... chars=72` → `turn/end flush=written`, and the page
  landed with the question and answer.
- **Nightly**: `nightlyEveryHours` runs `nightly.py` on a timer. The shipped
  config uses `24`. Verified: the plugin logged `nightly scheduled every 24h`,
  then the first delayed run produced `nightly exit=0` and `nightly done ok=true`.
  That run was against the template vault, so `import_sessions` reported zero
  sessions; it proves the timer path, not distillation on real data.
- **Keys**: the `krouter_keys` tool reads and writes `~/.dsh-krouter-keys.env`.
  A real set/status/clear cycle was run: the value went only to that file, and
  a grep found no key in the profile patch, the vault, or the debug log. The
  file is created with mode 0600 in code, but on Windows the resulting ACL is
  inherited from the folder (`SYSTEM`, `Administrators`, the owning user), not
  a POSIX 0600 mask.

The upstream `hooks/hooks.json` has five lifecycle hooks (SessionStart,
SessionEnd, UserPromptSubmit, Stop, PreCompact). The DSH socket maps the
context-injection hooks (start and prompt) and adds a `turn/end` capture that
writes `session-excerpt` pages; DSH sessions are zstd JSONL, so KRouter's own
`import_sessions.py` cannot read them directly and the DSH-side capture is what
feeds the vault instead.

`turn/end` was verified once with `enableSubagentHooks: true`: the log shows
`event type=turn/end` → `turn captured session=f89fe61e-… chars=72` →
`turn/end flush=written`, and the page
`05 时间日志/会话摘录/2026-11-22｜f89fe61e.md` held that turn's question and
answer. With the shipped `enableSubagentHooks: false`, only the main session is
hooked; a main-session `turn/end` has not been captured yet in this install.

## Install

```bash
plugin_manager install_bundle "D:/krouter-dsh"
```

The default vault is `D:/krouter-dsh/vault` (copy of `template-zh`). Change
`vaultPath` in `extras/dsh/cordis.patch.yml` or the plugin config to point at
your real Obsidian vault. `enableSubagentHooks` defaults to `false`; set it to
`true` only if subagents should also receive KRouter memory.

## Model key

KRouter's nightly distillation needs a callable model. Configure it with the
`krouter_keys` tool:

```json
{ "action": "status" }
{ "action": "set", "name": "DEEPSEEK_API_KEY", "value": "sk-..." }
{ "action": "clear", "name": "DEEPSEEK_API_KEY" }
```

Values go to `~/.dsh-krouter-keys.env`. They never enter the DSH profile patch,
the Obsidian vault, or a debug log line. The file is created with mode `0600`
in code; on Windows the effective ACL is inherited from the folder
(`SYSTEM`, `Administrators`, the owning user) rather than a POSIX 0600 mask.

## Nightly upkeep

Set `nightlyEveryHours` to a positive number to run `nightly.py` on a timer:

```yaml
nightlyEveryHours: 24
```

`0` disables the timer. The shipped config uses `24`; the first run is delayed
by one minute after the plugin loads, then repeats on the interval.

### Following the agent's current model

`followAgentModel: true` (the default) makes the plugin reuse whatever model the
agent is currently on, instead of needing its own key:

1. `request/header` carries the exact `provider` and `model` of the next request;
   the plugin records both (only when they change, so logs stay quiet).
2. It reads that provider's `apiKeyEnv`, `baseURL` and `api` from this profile's
   `cordis.patch.yml`.
3. It resolves the credential through `ctx.credentials.resolve()` and passes the
   value to `nightly.py` as `OPENAI_API_KEY` + `OPENAI_BASE_URL`, plus
   `KROUTER_LEARN_MODEL`.

The value exists only in the child process environment — never in the patch,
the vault, or a log line. `modelChannel` is a fixed fallback for when no
selection has been seen yet.

A provider whose `api` is not `openai-completions` is refused with a log line
rather than silently producing an unusable key: KRouter talks OpenAI
`chat/completions`, so an Anthropic-style or account-token route does not fit.

The first run after a plugin reload waits until a `request/header` has been seen
(up to 30 minutes), so a restart does not silently skip the model steps for a
whole night.

Verified, both paths now showing the same outcome:

```text
# plugin path (timer → follow → nightly.py)
krouter-debug.log: model followed provider=magpie model=group/never-stuck
krouter-debug.log: nightly first run (header seen=true)
krouter-debug.log: nightly model env keys=OPENAI_API_KEY,OPENAI_BASE_URL,KROUTER_LEARN_MODEL
krouter-debug.log: nightly done ok=true

# what that timer-triggered run wrote into the vault
90 系统文件/自动化/夜间维护.md:
  nightly: ok
  lane: api:OPENAI_API_KEY
  reconsolidate | ok | 1 次 / 2580 字 / 1603 tokens
```

The earlier cold-start gap is fixed and was observed before the fix: a reload
left `nightly model env keys=none` because the first run fired 60 s after load,
before any `request/header` had been seen. The run above is the corrected
behaviour — the first run waited for the header and then injected the env.

```bash
python skill/krouter/scripts/nightly.py --vault D:/krouter-dsh/vault
```

Without a key the model-dependent steps are skipped, but import, subconscious
compilation, alias learning, answer cards, checkup and backup still run.

## Test

```bash
cd D:/krouter-dsh
node --test test/*.test.mjs
```

Current result: **2 pass / 0 fail** (native tools, MCP tools list). The
`session_hook.py` command is present and invoked by the DSH hook wiring, but a
real DSH event injection has not been observed yet.

## Notes

KRouter's MCP server is Python stdlib only. `PYTHONIOENCODING=utf-8` is set for
all Python route, hook and MCP spawns so Chinese paths do not mojibake on
Windows.
