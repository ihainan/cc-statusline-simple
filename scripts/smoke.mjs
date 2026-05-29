#!/usr/bin/env node
// End-to-end smoke test: feed a synthetic stdin payload and a fake transcript,
// invoke the bundled CLI, print the result so you can eyeball it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "csl-"));
const transcript = join(tmp, "transcript.jsonl");
// Two usage records; the latter wins (most recent).
writeFileSync(
  transcript,
  [
    JSON.stringify({
      timestamp: "2026-05-29T01:00:00Z",
      isSidechain: false,
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0 },
    }),
    JSON.stringify({
      timestamp: "2026-05-29T02:00:00Z",
      isSidechain: false,
      usage: {
        input_tokens: 5000,
        output_tokens: 300,
        cache_read_input_tokens: 300_000,
        cache_creation_input_tokens: 13_500,
      },
    }),
    JSON.stringify({
      timestamp: "2026-05-29T02:30:00Z",
      isSidechain: true,
      usage: { input_tokens: 999_999 },
    }),
  ].join("\n") + "\n",
);

const cases = [
  {
    name: "Opus 4.7 with 1M window, 318.5K ctx",
    payload: {
      transcript_path: transcript,
      cwd: process.cwd(),
      model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
      workspace: { current_dir: process.cwd() },
      cost: {
        total_cost_usd: 26.45,
        total_duration_ms: 3_600_000,
        total_lines_added: 12,
        total_lines_removed: 4,
      },
    },
  },
  {
    name: "Haiku 4.5 (200K window) — should show high %",
    payload: {
      transcript_path: transcript,
      cwd: process.cwd(),
      model: { id: "claude-haiku-4-5", display_name: "Haiku 4.5" },
      cost: { total_cost_usd: 0.42, total_duration_ms: 60_000 },
    },
  },
  {
    name: "Unknown future model — falls back gracefully",
    payload: {
      transcript_path: transcript,
      cwd: process.cwd(),
      model: { id: "claude-opus-5-1", display_name: "Opus 5.1" },
      cost: { total_cost_usd: 0.05 },
    },
  },
  {
    name: "Missing model, missing transcript",
    payload: {
      cwd: process.cwd(),
      cost: { total_cost_usd: 0 },
    },
  },
];

const cli = join(import.meta.dirname, "..", "dist", "cli.js");
let failures = 0;
for (const c of cases) {
  const res = spawnSync("node", [cli], {
    input: JSON.stringify(c.payload),
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error(`FAIL ${c.name}: exit=${res.status}`);
    console.error(res.stderr);
    failures++;
    continue;
  }
  console.log(`# ${c.name}`);
  console.log(res.stdout);
  console.log();
}
process.exit(failures > 0 ? 1 : 0);
