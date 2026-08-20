/**
 * diffApk — 2 バージョンの jadx 出力を比較し、新規/変更/削除を抽出する。
 *
 *   bun run apk -- diff --old 14.9.0 --new 14.10.0
 *   bun run apk -- diff --old data/apk-jadx/14.9.0 --new data/apk-jadx/14.10.0
 *   bun run apk -- diff --auto    # 最新2版を自動選択
 *
 * 出力:
 *   data/out/apk-diff/<old>_vs_<new>/
 *     README.md
 *     added.json
 *     modified.json
 *     removed.json
 *     stats.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { APK_JADX_DIR, APK_DIR, OUT_DIR } from "./paths.js";
import { listLocalApks, compareVersions } from "./lineApkVersions.js";

const rawArgs = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]!;
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = rawArgs[i + 1];
  if (next && !next.startsWith("--")) {
    flags[key] = next;
    i++;
  } else {
    flags[key] = true;
  }
}

if (flags["help"] || flags["h"]) {
  console.log(`usage: bun run apk -- diff [options]

  --old <ver|path>       旧バージョン（バージョン文字列 or jadx 出力パス）
  --new <ver|path>       新バージョン（バージョン文字列 or jadx 出力パス）
  --auto                 最新の 2 バージョンを自動選択
  --threshold <n>        変更とみなす相違行数の下限（既定: 3）
`);
  process.exit(0);
}

function log(msg: string): void {
  console.info(`[apk-diff] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[apk-diff] ⚠ ${msg}`);
}

// ---------------------------------------------------------------------------
// バージョン / パス解決
// ---------------------------------------------------------------------------

function resolveVersionOrPath(input: string | undefined, label: string): { path: string; version: string } | null {
  if (!input) return null;

  if (existsSync(input)) {
    const version = basename(input).match(/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? basename(input);
    return { path: input, version };
  }

  const version = input;
  const jadxDir = join(APK_JADX_DIR, version);
  if (existsSync(jadxDir)) {
    return { path: jadxDir, version };
  }

  const apk = listLocalApks().find((a) => a.version === version);
  if (apk) {
    return { path: join(APK_JADX_DIR, version), version };
  }

  warn(`${label} を解決できません: ${input}`);
  return null;
}

function autoSelectVersions(): { old: { path: string; version: string }; new: { path: string; version: string } } | null {
  const versions = listLocalApks()
    .filter((a) => existsSync(join(APK_JADX_DIR, a.version, "sources")))
    .sort((a, b) => compareVersions(a.version, b.version));

  if (versions.length < 2) {
    warn("比較可能なバージョンが 2 以上必要です（jadx 出力があるもの）。");
    return null;
  }

  const newVer = versions[versions.length - 1]!;
  const oldVer = versions[versions.length - 2]!;
  return {
    old: { path: join(APK_JADX_DIR, oldVer.version), version: oldVer.version },
    new: { path: join(APK_JADX_DIR, newVer.version), version: newVer.version },
  };
}

// ---------------------------------------------------------------------------
// ファイルツリー収集
// ---------------------------------------------------------------------------

interface FileNode {
  rel: string;
  size: number;
  content?: string;
}

function collectTree(dir: string): Map<string, FileNode> {
  const map = new Map<string, FileNode>();
  if (!existsSync(dir)) return map;

  const sourcesDir = join(dir, "sources");
  const resourcesDir = join(dir, "resources");

  for (const root of [sourcesDir, resourcesDir]) {
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      const entries = readdirSync(cur, { withFileTypes: true });
      for (const entry of entries) {
        const p = join(cur, entry.name);
        if (entry.isDirectory()) stack.push(p);
        else {
          const rel = relative(dir, p);
          try {
            const stat = statSync(p);
            map.set(rel, { rel, size: stat.size });
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return map;
}

function readFileContent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 差分計算
// ---------------------------------------------------------------------------

interface DiffEntry {
  file: string;
  oldSize: number;
  newSize: number;
  addedLines: number;
  removedLines: number;
  changed: boolean;
}

function computeDiff(
  oldTree: Map<string, FileNode>,
  newTree: Map<string, FileNode>,
  threshold: number,
): { added: DiffEntry[]; modified: DiffEntry[]; removed: DiffEntry[] } {
  const added: DiffEntry[] = [];
  const modified: DiffEntry[] = [];
  const removed: DiffEntry[] = [];

  const allKeys = new Set([...oldTree.keys(), ...newTree.keys()]);

  for (const key of allKeys) {
    const oldNode = oldTree.get(key);
    const newNode = newTree.get(key);

    if (!oldNode && newNode) {
      added.push({
        file: key,
        oldSize: 0,
        newSize: newNode.size,
        addedLines: 0,
        removedLines: 0,
        changed: true,
      });
    } else if (oldNode && !newNode) {
      removed.push({
        file: key,
        oldSize: oldNode.size,
        newSize: 0,
        addedLines: 0,
        removedLines: 0,
        changed: true,
      });
    } else if (oldNode && newNode) {
      const oldContent = readFileContent(join(oldNode.rel.startsWith("sources") ? join("sources", oldNode.rel.slice(8)) : join("resources", oldNode.rel.slice(9)), oldNode.rel));
      const newContent = readFileContent(join(newNode.rel.startsWith("sources") ? join("sources", newNode.rel.slice(8)) : join("resources", newNode.rel.slice(9)), newNode.rel));

      // Simple line-based diff
      const oldLines = oldContent?.split(/\r?\n/) ?? [];
      const newLines = newContent?.split(/\r?\n/) ?? [];

      let addedLines = 0;
      let removedLines = 0;
      const maxLen = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < maxLen; i++) {
        const oldLine = oldLines[i];
        const newLine = newLines[i];
        if (oldLine === undefined) addedLines++;
        else if (newLine === undefined) removedLines++;
        else if (oldLine !== newLine) {
          addedLines++;
          removedLines++;
        }
      }

      const changed = Math.abs(addedLines - removedLines) >= threshold || addedLines + removedLines >= threshold;
      if (changed) {
        modified.push({
          file: key,
          oldSize: oldNode.size,
          newSize: newNode.size,
          addedLines,
          removedLines,
          changed: true,
        });
      }
    }
  }

  return { added, modified, removed };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const oldInput = typeof flags["old"] === "string" ? (flags["old"] as string) : null;
  const newInput = typeof flags["new"] === "string" ? (flags["new"] as string) : null;
  const auto = Boolean(flags["auto"]);

  if (!auto && (!oldInput || !newInput)) {
    throw new Error("--old と --new を指定するか、--auto を使用してください。");
  }

  let oldInfo: { path: string; version: string } | null = null;
  let newInfo: { path: string; version: string } | null = null;

  if (auto) {
    const pair = autoSelectVersions();
    if (!pair) throw new Error("自動選択に失敗しました。");
    oldInfo = pair.old;
    newInfo = pair.new;
  } else {
    oldInfo = resolveVersionOrPath(oldInput as string | undefined, "--old");
    newInfo = resolveVersionOrPath(newInput as string | undefined, "--new");
  }

  if (!oldInfo || !newInfo) {
    throw new Error("旧バージョンまたは新バージョンを解決できません。");
  }

  log(`比較: ${oldInfo.version} -> ${newInfo.version}`);
  log(`old: ${oldInfo.path}`);
  log(`new: ${newInfo.path}`);

  const oldTree = collectTree(oldInfo.path);
  const newTree = collectTree(newInfo.path);
  const threshold = Number(flags["threshold"] ?? 3);

  const { added, modified, removed } = computeDiff(oldTree, newTree, threshold);

  log(`added: ${added.length}, modified: ${modified.length}, removed: ${removed.length}`);

  const outDir = join(OUT_DIR, "apk-diff", `${oldInfo.version}_vs_${newInfo.version}`);
  mkdirSync(outDir, { recursive: true });

  const stats = {
    oldVersion: oldInfo.version,
    newVersion: newInfo.version,
    threshold,
    added: added.length,
    modified: modified.length,
    removed: removed.length,
    total: added.length + modified.length + removed.length,
  };

  writeFileSync(join(outDir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "added.json"), `${JSON.stringify(added, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "modified.json"), `${JSON.stringify(modified, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "removed.json"), `${JSON.stringify(removed, null, 2)}\n`, "utf8");

  writeReadme({ stats, added, modified, removed, outDir, oldVersion: oldInfo.version, newVersion: newInfo.version });
  log(`done -> ${outDir}`);
}

function writeReadme(args: {
  stats: Record<string, unknown>;
  added: DiffEntry[];
  modified: DiffEntry[];
  removed: DiffEntry[];
  outDir: string;
  oldVersion: string;
  newVersion: string;
}): void {
  const { stats, added, modified, removed, outDir, oldVersion, newVersion } = args;
  const lines: string[] = [];
  lines.push(`# apk-diff: ${oldVersion} -> ${newVersion}`);
  lines.push("");
  lines.push(`generatedAt: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## 統計");
  lines.push("");
  lines.push(`- added: ${added.length}`);
  lines.push(`- modified: ${modified.length}`);
  lines.push(`- removed: ${removed.length}`);
  lines.push(`- total: ${stats.total}`);
  lines.push("");

  if (added.length > 0) {
    lines.push("## Added");
    lines.push("");
    for (const entry of added.slice(0, 50)) {
      lines.push(`- \`${entry.file}\``);
    }
    if (added.length > 50) lines.push(`- ... and ${added.length - 50} more`);
    lines.push("");
  }

  if (modified.length > 0) {
    lines.push("## Modified");
    lines.push("");
    for (const entry of modified.slice(0, 50)) {
      lines.push(`- \`${entry.file}\` (+${entry.addedLines}/-${entry.removedLines})`);
    }
    if (modified.length > 50) lines.push(`- ... and ${modified.length - 50} more`);
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push("## Removed");
    lines.push("");
    for (const entry of removed.slice(0, 50)) {
      lines.push(`- \`${entry.file}\``);
    }
    if (removed.length > 50) lines.push(`- ... and ${removed.length - 50} more`);
    lines.push("");
  }

  lines.push("## 出力");
  lines.push("");
  lines.push("```text");
  lines.push(`${outDir}/`);
  lines.push("  README.md      (このファイル)");
  lines.push("  stats.json     統計");
  lines.push("  added.json     新規ファイル");
  lines.push("  modified.json  変更ファイル");
  lines.push("  removed.json   削除ファイル");
  lines.push("```");
  lines.push("");

  writeFileSync(join(outDir, "README.md"), `${lines.join("\n")}\n`, "utf8");
}

await main().catch((err) => {
  console.error(`[apk-diff] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
