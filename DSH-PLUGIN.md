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

The upstream `hooks/hooks.json` has five lifecycle hooks (SessionStart,
SessionEnd, UserPromptSubmit, Stop, PreCompact). The DSH socket maps the two
read-only, context-injection hooks (start and prompt). The import-oriented
`Stop`/`SessionEnd` hooks require a Claude/Codex/Cursor JSONL transcript reader;
DSH stores sessions as zstd JSONL, which KRouter's importer does not read
directly, so those are not claimed as wired.

## Install

```bash
plugin_manager install_bundle "D:/krouter-dsh"
```

The default vault is `D:/krouter-dsh/vault` (copy of `template-zh`). Change
`vaultPath` in `extras/dsh/cordis.patch.yml` or the plugin config to point at
your real Obsidian vault. `enableSubagentHooks` defaults to `false`; set it to
`true` only if subagents should also receive KRouter memory.

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
