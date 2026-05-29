# claude-statusline

Minimal Claude Code status line. No pets, no leaderboards, no sync. Five segments:

```
Opus 4.7 │ Ctx 318.5K (31.9% / u 39.8%) │ $26.45 (1h0m) │ +12 -4 │ main ±3
```

| Segment | Source |
| --- | --- |
| Model | stdin `model.display_name` (or shortened `model.id`) |
| Context | tail-scan of `transcript_path` jsonl; `%` computed against a per-model window table — Opus 4.6/4.7 and Sonnet 4.6 = 1M, Haiku 4.5 = 200K, family fallback otherwise. `u` is against 80% of the window (compaction-relevant). |
| Cost + duration | stdin `cost.total_cost_usd` and `cost.total_duration_ms` (Claude Code's own numbers, not estimated) |
| Edits | stdin `cost.total_lines_added` / `total_lines_removed` |
| Git | branch via `git rev-parse --abbrev-ref HEAD`; `±N` = dirty file count, `✓` = clean |

Color thresholds on the `Ctx` value: green < 50% (usable), cyan < 80%, yellow < 95%, red otherwise.

## Why this exists

[ccpet](https://github.com/terryso/ccpet) hardcodes the context window at 200K (line `2e5` / `16e4` in its bundle), so any session past 200K reads `Ctx: 100.0%` even though Opus 4.7 has a 1M window. The repo has been stale since 2025-08-30 and the bug isn't tracked. This is a strip-down replacement.

## Install

```bash
npm install -g cc-statusline-simple
```

Then point `~/.claude/settings.json` at the `cc-statusline` command:

```json
{
  "statusLine": {
    "type": "command",
    "command": "cc-statusline",
    "padding": 0
  }
}
```

Restart Claude Code (or open a new session) for the status line to appear.

### From source

```bash
git clone https://github.com/ihainan/cc-statusline-simple.git
cd cc-statusline-simple
npm install
npm run build
# then set "command": "node /absolute/path/to/cc-statusline-simple/dist/cli.js"
```

## Verify

```bash
npm run smoke
```

Spawns the CLI four times with synthetic payloads (Opus 4.7 / Haiku 4.5 / unknown model / no transcript) and prints each rendered line.

## Extending

The whole thing is one ~200-line file (`src/index.ts`). Common edits:

- **New model windows** — add to `MODEL_WINDOW` map.
- **Drop git** — delete the `readGitState` block; saves a few ms per render.
- **More transcript stats** (5h burn rate, cache hit %) — they're in `readContextTokens`'s tail scan; aggregate while you're there.
