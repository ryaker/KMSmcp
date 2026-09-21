#!/usr/bin/env node
/**
 * Phase 1 inventory: count top-level session files and user-turn lines per project
 * under ~/.claude/projects, largest first. Read-only.
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = path.join(os.homedir(), ".claude", "projects");
const rows = [];
for (const d of fs.readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(root, d.name);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) continue;
  let userLines = 0;
  for (const f of files) {
    // Count user-turn lines by substring: jsonl lines lead with uuid/parentUuid, not "type".
    const buf = fs.readFileSync(path.join(dir, f), "utf8");
    for (const line of buf.split("\n")) {
      if (line.includes('"type":"user"')) userLines++;
    }
  }
  rows.push({ project: d.name, files: files.length, userLines });
}
rows.sort((a, b) => b.userLines - a.userLines);
for (const r of rows)
  console.log(String(r.userLines).padStart(8), String(r.files).padStart(4), r.project);