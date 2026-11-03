#!/usr/bin/env bun
/** Compare every file in two installed LINE Desktop versions and write an evidence report. */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { DATA_DIR, defaultLineRoot, lineBinDir } from "./paths.js";
import {
  UPDATE_INFO_URL,
  compareVersions,
  fetchUpdateInfo,
  lineZipUrl,
  osVersionString,
  resolveTargetVersion,
  sharedLibZipUrl,
} from "./lineVersions.js";

type FileEntry = { path: string; size: number; sha256: string };
type Change = {
  path: string;
  status: "added" | "removed" | "changed";
  from?: FileEntry;
  to?: FileEntry;
};

const flags: Record<string, string | boolean> = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (!args[i]!.startsWith("--")) continue;
  const key = args[i]!.slice(2);
  const value = args[i + 1];
  if (value && !value.startsWith("--")) {
    flags[key] = value;
    i++;
  } else flags[key] = true;
}

if (flags.help || flags.h) {
  console.log(`usage: bun run diff -- --from <version> --to <version> [options]

  --line-root <path>          LINE root (default: %LOCALAPPDATA%\\LINE)
  --to latest                 Download and compare the official applicable update
  --release-notes-url <url>   Official release notes URL to record
  --out <path>                Report directory (default: data/reports/line-diff)
  --json                      Print report JSON to stdout instead of a short summary
`);
  process.exit(0);
}

const fromVersion = typeof flags.from === "string" ? flags.from : "";
let toVersion = typeof flags.to === "string" ? flags.to : "";
if (!/^\d+(?:\.\d+){3}$/.test(fromVersion) || (toVersion !== "latest" && !/^\d+(?:\.\d+){3}$/.test(toVersion))) {
  throw new Error("--from と --to に4区切りのバージョン、または --to latest を指定してください。");
}
const lineRoot = defaultLineRoot(typeof flags["line-root"] === "string" ? flags["line-root"] : undefined);
const binDir = lineBinDir(lineRoot);
const outputDir = typeof flags.out === "string" ? flags.out : join(DATA_DIR, "reports", "line-diff");
const officialUrl = UPDATE_INFO_URL;
const checkedAt = new Date().toISOString();
const info = await fetchUpdateInfo(officialUrl);
const target = resolveTargetVersion(
  info,
  fromVersion,
  osVersionString(),
  process.arch === "x64" ? "x64" : "x86",
);
const latest = info.infos.map((entry) => entry.version).sort(compareVersions).at(-1) ?? null;
const downloadLatest = toVersion === "latest";
if (downloadLatest) {
  if (!target) throw new Error(`公式 update_info に ${fromVersion} 向けの更新対象がありません。`);
  toVersion = target.version;
}
const toShared = downloadLatest
  ? target!.shared_version ?? info.shared.version
  : info.infos.find((entry) => entry.version === toVersion)?.shared_version ?? info.shared.version;


async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function collect(root: string, label: string): Promise<Map<string, FileEntry>> {
  if (!(await isDirectory(root))) throw new Error(`${label} のフォルダがありません: ${root}`);
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  files.sort();
  const result = new Map<string, FileEntry>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index]!;
      const before = await stat(file);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(file)) digest.update(chunk);
      const after = await stat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`比較中にファイルが変更されました。LINE を終了して再実行してください: ${file}`);
      }
      const key = relative(root, file).split(sep).join("/");
      result.set(key, { path: key, size: after.size, sha256: digest.digest("hex") });
    }
  });
  await Promise.all(workers);
  return result;
}

function versionRoot(version: string): string {
  return join(binDir, version);
}

async function collectVersion(version: string): Promise<Map<string, FileEntry>> {
  const base = versionRoot(version);
  const fallback = join(binDir, "current");
  const root = await isDirectory(base) ? base : fallback;
  return collect(root, `LINE ${version}`);
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr || result.error || "unknown error"}`);
  return result.stdout ?? "";
}

function extractOfficialZip(zipPath: string, destination: string): void {
  const entries = run("tar.exe", ["-tf", zipPath]).split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\//, "");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`ZIP に不正な展開パスがあります: ${entry}`);
    }
  }
  mkdirSync(destination, { recursive: true });
  run("tar.exe", ["-xf", zipPath, "-C", destination]);
}

function downloadOfficialFile(url: string, destination: string): void {
  if (existsSync(destination)) return;
  const result = spawnSync("curl.exe", ["-sS", "-L", "--fail", "--retry", "3", "-o", destination, url], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !existsSync(destination)) {
    throw new Error(`公式ファイルをダウンロードできません: ${url}\n${result.stderr ?? ""}`);
  }
}

function ensureOfficialArchiveExtracted(zip: string, destination: string): void {
  const marker = `${destination}.complete`;
  if (existsSync(marker)) return;
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  extractOfficialZip(zip, destination);
  writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

const officialCache = join(DATA_DIR, "releases", toVersion);
const officialSource = downloadLatest ? {
  lineZip: lineZipUrl(info, toVersion),
  sharedZip: sharedLibZipUrl(info, toShared),
  lineDirectory: join(officialCache, "LINE"),
  sharedDirectory: join(officialCache, "shared"),
} : null;
if (officialSource) {
  await mkdir(officialCache, { recursive: true });
  const lineZip = join(officialCache, "LINE.zip");
  const sharedZip = join(officialCache, "lib.zip");
  downloadOfficialFile(officialSource.lineZip, lineZip);
  downloadOfficialFile(officialSource.sharedZip, sharedZip);
  ensureOfficialArchiveExtracted(lineZip, officialSource.lineDirectory);
  ensureOfficialArchiveExtracted(sharedZip, officialSource.sharedDirectory);
}

const startedAt = performance.now();
const [fromFiles, toFiles] = await Promise.all([
  collectVersion(fromVersion),
  officialSource
    ? (async () => {
        const files = await collect(officialSource.lineDirectory, `official LINE ${toVersion}`);
        for (const [key, file] of await collect(officialSource.sharedDirectory, `official shared ${toShared}`)) {
          files.set(key, { ...file, path: key });
        }
        return files;
      })()
    : collectVersion(toVersion),
]);
const [lineZipSha256, sharedZipSha256] = officialSource
  ? await Promise.all([
      sha256File(join(officialCache, "LINE.zip")),
      sha256File(join(officialCache, "lib.zip")),
    ])
  : [null, null];
const changes: Change[] = [];
for (const path of new Set([...fromFiles.keys(), ...toFiles.keys()])) {
  const from = fromFiles.get(path);
  const to = toFiles.get(path);
  if (!from) changes.push({ path, status: "added", to });
  else if (!to) changes.push({ path, status: "removed", from });
  else if (from.sha256 !== to.sha256) changes.push({ path, status: "changed", from, to });
}
changes.sort((a, b) => a.path.localeCompare(b.path));

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  comparison: { fromVersion, toVersion, fromFiles: fromFiles.size, toFiles: toFiles.size },
  sharedVersion: toShared,
  official: {
    source: officialUrl,
    checkedAt,
    latestVersion: latest,
    updateTargetFromBase: target,
    lineZipUrl: lineZipUrl(info, toVersion),
    sharedZipUrl: sharedLibZipUrl(info, toShared),
    downloadedOfficialPackages: downloadLatest,
    lineZipSha256,
    sharedZipSha256,
    releaseNotesUrl: typeof flags["release-notes-url"] === "string" ? flags["release-notes-url"] : null,
    releaseNotesStatus: flags["release-notes-url"] ? "user-supplied URL; content not fetched" : "not provided by official update metadata",
  },
  summary: {
    added: changes.filter((c) => c.status === "added").length,
    removed: changes.filter((c) => c.status === "removed").length,
    changed: changes.filter((c) => c.status === "changed").length,
    elapsedMs: Math.round(performance.now() - startedAt),
  },
  changes,
};

await mkdir(outputDir, { recursive: true });
const stem = `line-${fromVersion}-to-${toVersion}`;
const jsonPath = join(outputDir, `${stem}.json`);
const mdPath = join(outputDir, `${stem}.md`);
await Bun.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const rows = changes.length
  ? changes.map((change) => {
      const before = change.from ? `${change.from.size} B / ${change.from.sha256}` : "—";
      const after = change.to ? `${change.to.size} B / ${change.to.sha256}` : "—";
      return `| ${change.status} | \`${change.path.replaceAll("|", "&#124;")}\` | ${before} | ${after} |`;
    }).join("\n")
  : "| — | No file differences | — | — |";
const markdown = `# LINE Desktop file diff: ${fromVersion} → ${toVersion}

- Generated: ${report.generatedAt}
- Official update metadata: [${officialUrl}](${officialUrl}) (checked ${checkedAt})
- Official latest version: ${latest ?? "unknown"}
- Official target from ${fromVersion}: ${target ? `${target.version} (shared ${toShared})` : "no matching update entry"}
- Official package: [LINE.zip](${report.official.lineZipUrl})
- Shared package: [lib.zip](${report.official.sharedZipUrl})
- Compared target: ${downloadLatest ? "downloaded from the official distribution before installation" : "local installed files"}
- Official ZIP SHA-256: LINE ${lineZipSha256 ?? "not downloaded"}; shared ${sharedZipSha256 ?? "not downloaded"}
- Release notes: ${report.official.releaseNotesUrl ?? "not provided in official update metadata; no public release notes URL was supplied"}
- Totals: ${report.summary.added} added, ${report.summary.removed} removed, ${report.summary.changed} changed; ${fromFiles.size} → ${toFiles.size} files; ${report.summary.elapsedMs} ms

Every added, removed, or SHA-256-different file is listed below. Hashes and byte sizes are recorded for both sides when present.

| Status | File | From (bytes / SHA-256) | To (bytes / SHA-256) |
|---|---|---:|---:|
${rows}
`;
await Bun.write(mdPath, markdown);

if (flags.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Compared LINE ${fromVersion} → ${toVersion}: ${changes.length} file changes`);
  console.log(`Official latest: ${latest ?? "unknown"} (${officialUrl})`);
  console.log(`Markdown: ${mdPath}`);
  console.log(`JSON:     ${jsonPath}`);
}
