import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code statusLine input (passed via stdin as a JSON object).
 * Only the fields we actually consume are typed.
 */
interface StatusInput {
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  // Present only for Claude.ai Pro/Max subscribers, and only after the first
  // API response of the session. Each window may be independently absent.
  // Field naming has varied across versions, so we accept both variants.
  rate_limits?: {
    five_hour?: RateWindow;
    session?: RateWindow;
    seven_day?: RateWindow;
    weekly?: RateWindow;
  };
}

interface RateWindow {
  used_percentage?: number;
  // Epoch seconds in current versions; tolerate ISO8601 strings just in case.
  resets_at?: number | string;
}

interface TranscriptEntry {
  isSidechain?: boolean;
  timestamp?: string;
  usage?: TokenUsage;
  message?: { usage?: TokenUsage };
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Per-model context window in tokens. Opus 4.6/4.7 and Sonnet 4.6 ship with 1M;
// Haiku 4.5 keeps 200K. Family fallbacks below handle minor revisions.
const MODEL_WINDOW: Record<string, number> = {
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

const DEFAULT_WINDOW = 200_000;
const USABLE_RATIO = 0.8;

function resolveContextWindow(modelId: string | undefined): number {
  if (!modelId) return DEFAULT_WINDOW;
  const exact = MODEL_WINDOW[modelId];
  if (exact) return exact;
  // Family fallback for future minor revisions
  if (modelId.includes("opus-4") || modelId.includes("sonnet-4")) return 1_000_000;
  if (modelId.includes("haiku-4")) return 200_000;
  return DEFAULT_WINDOW;
}

function shortModelName(model: StatusInput["model"]): string {
  const id = model?.id ?? "";
  const display = model?.display_name?.trim();
  if (display) return display;
  // Strip the "claude-" prefix and any date suffix for compactness
  return id.replace(/^claude-/, "").replace(/-\d{8}$/, "") || "unknown";
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "$?";
  return `$${n.toFixed(2)}`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

function readContextTokens(transcriptPath: string | undefined): number {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  try {
    // Transcripts grow; for status-line responsiveness we only scan the tail.
    // 256KB is enough to find a recent usage record on every realistic conversation.
    const st = statSync(transcriptPath);
    const tailBytes = Math.min(st.size, 256 * 1024);
    const fd = readFileSync(transcriptPath);
    const start = fd.length - tailBytes;
    const text = fd.subarray(start).toString("utf8");
    const lines = text.split("\n");

    let latest: TranscriptEntry | null = null;
    let latestTs = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        // Partial first line from tail-slicing; skip it.
        continue;
      }
      if (entry.isSidechain === true) continue;
      const usage = entry.usage ?? entry.message?.usage;
      if (!usage) continue;
      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      if (!latest || ts >= latestTs) {
        latest = entry;
        latestTs = ts;
      }
    }
    if (!latest) return 0;
    const u = latest.usage ?? latest.message?.usage ?? {};
    return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  } catch {
    return 0;
  }
}

interface GitState {
  branch: string;
  changed: number;
}

function readGitState(cwd: string | undefined): GitState | null {
  if (!cwd) return null;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 200,
      encoding: "utf8",
    }).trim();
    if (!branch) return null;
    const porcelain = execSync("git status --porcelain", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 200,
      encoding: "utf8",
    });
    const changed = porcelain ? porcelain.split("\n").filter((l) => l.trim()).length : 0;
    return { branch, changed };
  } catch {
    return null;
  }
}

// ANSI: avoid heavy dependencies; rely on 8-color codes which work everywhere.
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  brightBlue: "\x1b[94m",
};

function ctxColor(pct: number): string {
  if (pct >= 95) return C.red;
  if (pct >= 80) return C.yellow;
  if (pct >= 50) return C.cyan;
  return C.green;
}

// Normalized per-window usage snapshot used for both display and persistence.
interface WindowState {
  used: number | null; // percentage 0-100
  remaining: number | null; // 100 - used
  resetsAtEpoch: number | null; // unix seconds
  resetsAtRaw: number | string | null; // original value as received
}

function toEpochSeconds(v: number | string | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.floor(v) : null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function normalizeWindow(w: RateWindow | undefined): WindowState | null {
  if (!w) return null;
  const used = typeof w.used_percentage === "number" && Number.isFinite(w.used_percentage)
    ? w.used_percentage
    : null;
  const resetsAtEpoch = toEpochSeconds(w.resets_at);
  // A window with no usable data at all is treated as absent.
  if (used == null && resetsAtEpoch == null) return null;
  return {
    used,
    remaining: used == null ? null : Math.max(0, 100 - used),
    resetsAtEpoch,
    resetsAtRaw: w.resets_at ?? null,
  };
}

interface UsageState {
  fiveHour: WindowState | null;
  weekly: WindowState | null;
}

function readRateLimits(input: StatusInput): UsageState {
  const rl = input.rate_limits;
  return {
    fiveHour: normalizeWindow(rl?.five_hour ?? rl?.session),
    weekly: normalizeWindow(rl?.seven_day ?? rl?.weekly),
  };
}

// Compact "time until reset" from now, e.g. 45m, 2h13m, 3d4h.
function formatResetIn(epochSeconds: number | null, nowSec: number): string {
  if (epochSeconds == null) return "";
  let s = epochSeconds - nowSec;
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// Lower remaining quota => more urgent color.
function quotaColor(remaining: number | null): string {
  if (remaining == null) return C.cyan;
  if (remaining <= 5) return C.red;
  if (remaining <= 20) return C.yellow;
  return C.green;
}

function formatWindowSegment(label: string, w: WindowState | null, nowSec: number): string | null {
  if (!w) return null;
  const col = quotaColor(w.remaining);
  const pct = w.remaining == null ? "?" : `${w.remaining.toFixed(0)}%`;
  const reset = formatResetIn(w.resetsAtEpoch, nowSec);
  const tail = reset ? ` ${C.dim}(${reset})${C.reset}` : "";
  return `${C.dim}${label}${C.reset} ${col}${pct}${C.reset}${tail}`;
}

// Persist usage so it can be analyzed outside the status line.
//   <dir>/usage.json  — latest snapshot (overwritten atomically each run)
//   <dir>/usage.jsonl — one line appended only when the numbers change
// Never throws: persistence must not break the status line.
function persistUsage(state: UsageState, nowSec: number): void {
  if (!state.fiveHour && !state.weekly) return; // nothing meaningful to record
  try {
    const dir = join(homedir(), ".claude", "cc-statusline");
    mkdirSync(dir, { recursive: true });
    const snapshotPath = join(dir, "usage.json");
    const historyPath = join(dir, "usage.jsonl");

    const win = (w: WindowState | null) =>
      w == null
        ? null
        : {
            used_percentage: w.used,
            remaining_percentage: w.remaining,
            resets_at_epoch: w.resetsAtEpoch,
            resets_at_raw: w.resetsAtRaw,
            resets_in_seconds: w.resetsAtEpoch == null ? null : w.resetsAtEpoch - nowSec,
          };

    const snapshot = {
      updated_at: nowSec,
      five_hour: win(state.fiveHour),
      weekly: win(state.weekly),
    };

    // Append to history only when the rate-limit values actually changed,
    // so the high-frequency status-line invocations don't bloat the log.
    const changeKey = JSON.stringify([
      state.fiveHour?.used ?? null,
      state.fiveHour?.resetsAtEpoch ?? null,
      state.weekly?.used ?? null,
      state.weekly?.resetsAtEpoch ?? null,
    ]);
    let prevKey: string | null = null;
    if (existsSync(snapshotPath)) {
      try {
        const prev = JSON.parse(readFileSync(snapshotPath, "utf8"));
        prevKey = JSON.stringify([
          prev?.five_hour?.used_percentage ?? null,
          prev?.five_hour?.resets_at_epoch ?? null,
          prev?.weekly?.used_percentage ?? null,
          prev?.weekly?.resets_at_epoch ?? null,
        ]);
      } catch {
        // Corrupt/old snapshot: treat as changed.
      }
    }

    const tmp = `${snapshotPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, snapshotPath);

    if (changeKey !== prevKey) {
      appendFileSync(historyPath, JSON.stringify(snapshot) + "\n");
    }
  } catch {
    // Ignore: analytics persistence is best-effort.
  }
}

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const raw = readStdinSync();
  let input: StatusInput = {};
  if (raw) {
    try {
      input = JSON.parse(raw) as StatusInput;
    } catch {
      // Keep input empty; we'll degrade gracefully.
    }
  }

  const model = shortModelName(input.model);
  const window = resolveContextWindow(input.model?.id);
  const usable = Math.floor(window * USABLE_RATIO);
  const ctxTokens = readContextTokens(input.transcript_path);
  const pctTotal = window > 0 ? (ctxTokens / window) * 100 : 0;
  const pctUsable = usable > 0 ? (ctxTokens / usable) * 100 : 0;

  const cost = formatCost(input.cost?.total_cost_usd);
  const dur = formatDuration(input.cost?.total_duration_ms);
  const added = input.cost?.total_lines_added ?? 0;
  const removed = input.cost?.total_lines_removed ?? 0;
  const gitCwd = input.workspace?.current_dir ?? input.cwd;
  const git = readGitState(gitCwd);

  const nowSec = Math.floor(Date.now() / 1000);
  const usage = readRateLimits(input);
  persistUsage(usage, nowSec);

  const segments: string[] = [];

  // Model
  segments.push(`${C.bold}${C.magenta}${model}${C.reset}`);

  // Context: absolute + total% + usable%
  const ctxColr = ctxColor(pctUsable);
  segments.push(
    `Ctx ${ctxColr}${formatTokens(ctxTokens)}${C.reset} ` +
      `${ctxColr}(${pctTotal.toFixed(1)}% / u ${pctUsable.toFixed(1)}%)${C.reset}`,
  );

  // Cost + session duration
  const costSeg = dur ? `${cost} (${dur})` : cost;
  segments.push(`${C.green}${costSeg}${C.reset}`);

  // Edits in this session
  if (added > 0 || removed > 0) {
    segments.push(`${C.green}+${added}${C.reset} ${C.red}-${removed}${C.reset}`);
  }

  // Usage quota: 5h + weekly remaining %, with time-to-reset.
  // Shown only when Claude Code supplies rate_limits (Pro/Max, post first response).
  const fiveSeg = formatWindowSegment("5h", usage.fiveHour, nowSec);
  const weekSeg = formatWindowSegment("wk", usage.weekly, nowSec);
  const quotaParts = [fiveSeg, weekSeg].filter((s): s is string => s != null);
  if (quotaParts.length > 0) {
    segments.push(quotaParts.join(`${C.dim} · ${C.reset}`));
  }

  // Git
  if (git) {
    const dirty = git.changed > 0 ? `${C.yellow}±${git.changed}${C.reset}` : `${C.green}✓${C.reset}`;
    segments.push(`${C.brightBlue}${git.branch}${C.reset} ${dirty}`);
  }

  process.stdout.write(segments.join(`${C.dim} │ ${C.reset}`));
}

main().catch((err) => {
  // Never crash the status line — surface a short diagnostic instead.
  process.stdout.write(`statusline error: ${(err as Error).message}`);
});
