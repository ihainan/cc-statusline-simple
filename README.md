# claude-statusline

Minimal Claude Code status line. No pets, no leaderboards, no sync:

```
Opus 4.7 │ Ctx 318.5K (31.9% / u 39.8%) │ $26.45 (1h0m) │ +12 -4 │ 5h 66% (2h37m) · wk 93% (3d7h) │ main ±3
```

| Segment | Source |
| --- | --- |
| Model | stdin `model.display_name` (or shortened `model.id`) |
| Context | tail-scan of `transcript_path` jsonl; `%` computed against a per-model window table — Opus 4.6/4.7 and Sonnet 4.6 = 1M, Haiku 4.5 = 200K, family fallback otherwise. `u` is against 80% of the window (compaction-relevant). |
| Cost + duration | stdin `cost.total_cost_usd` and `cost.total_duration_ms` (Claude Code's own numbers, not estimated) |
| Edits | stdin `cost.total_lines_added` / `total_lines_removed` |
| Usage quota | stdin `rate_limits`; `5h` = 5-hour rolling window, `wk` = 7-day window. Shows **remaining** % (`100 − used_percentage`) and time-to-reset in parens. Only present for Claude.ai Pro/Max, and only after the session's first API response — hidden otherwise. |
| Git | branch via `git rev-parse --abbrev-ref HEAD`; `±N` = dirty file count, `✓` = clean |

Color thresholds on the `Ctx` value: green < 50% (usable), cyan < 80%, yellow < 95%, red otherwise. On the quota %: green > 20% remaining, yellow ≤ 20%, red ≤ 5%.

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
    "padding": 0,
    "refreshInterval": 60
  }
}
```

Restart Claude Code (or open a new session) for the status line to appear.

`refreshInterval` (seconds) re-runs the command on a timer in addition to the event-driven updates, so the usage-quota countdown stays current while the session is idle. Drop it if you don't show the quota segment.

## Usage-quota persistence

Whenever Claude Code supplies `rate_limits`, each render also writes the quota to disk so you can analyze it outside the status line:

| File | Contents |
| --- | --- |
| `~/.claude/cc-statusline/usage.json` | Latest snapshot, overwritten atomically each render. |
| `~/.claude/cc-statusline/usage.jsonl` | One line appended **only when the numbers change**, so the high-frequency renders don't bloat the log — a clean time series. |

Each record carries `updated_at` plus, per window, `used_percentage`, `remaining_percentage`, `resets_at_epoch`, `resets_at_raw`, and `resets_in_seconds`. Writes are best-effort and never block or crash the status line.

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
