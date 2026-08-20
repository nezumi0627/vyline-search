/**
 * unpackApk — LINE APK を jadx でデコンパイルし、data/apk-jadx/<version>/ に出力する。
 *
 *   bun run apk -- unpack
 *   bun run apk -- unpack --apk data/apk/LINE-14.10.0.apk
 *   bun run apk -- unpack --apk data/apk/LINE-14.10.0.apk --deobfuscate
 *   bun run apk -- unpack --jadx-out data/apk-jadx/custom
 *
 * 前提:
 *   - jadx が PATH にあるか、JADX_HOME で指定
 *   - または --jadx <path> で直接指定
 *
 * 出力:
 *   data/apk-jadx/<version>/sources/     (Java ソース)
 *   data/apk-jadx/<version>/resources/   (リソース)
 *   data/apk-jadx/<version>/_meta.json   (メタデータ)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { APK_DIR, APK_JADX_DIR, DATA_DIR } from "./paths.js";
import { listLocalApks, findLocalApkByVersion, compareVersions, sha256File } from "./lineApkVersions.js";

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
  console.log(`usage: bun run apk -- unpack [options]

  --apk <path>           入力 APK（未指定なら data/apk/ から最新版を選択）
  --version <ver>       バージョン指定（例: 14.10.0）
  --jadx <path>         jadx 実行ファイル（未指定なら PATH / JADX_HOME から探索）
  --deobfuscate         jadx-deobfuscate を実行（ Retrolambda / map ファイルがあれば）
  --jadx-out <path>     出力先（既定: data/apk-jadx/<version>/）
  --threads <n>         jadx スレッド数（既定: 4）
  --jvm-mem <pct>       JVM 最大メモリ割合 (既定: 70)。例: 50, 70
`);
  process.exit(0);
}

function log(msg: string): void {
  console.info(`[apk-unpack] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[apk-unpack] ⚠ ${msg}`);
}

const jvmMemPct = Number(flags["jvm-mem"] ?? 70);

// ---------------------------------------------------------------------------
// jadx の探索
// ---------------------------------------------------------------------------

export function findJadx(): string | null {
  const envHome = process.env["JADX_HOME"]?.trim();
  if (envHome) {
    const candidates = [
      join(envHome, "bin", "jadx.bat"),
      join(envHome, "bin", "jadx"),
      join(envHome, "jadx.bat"),
      join(envHome, "jadx"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }

  const pathDirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const dir of pathDirs) {
    const bat = join(dir, "jadx.bat");
    const exe = join(dir, "jadx");
    if (existsSync(bat)) return bat;
    if (existsSync(exe)) return exe;
  }

  const reToolsJadx = join(DATA_DIR, "re-tools", "jadx");
  if (existsSync(reToolsJadx)) {
    const found = findJadxInDir(reToolsJadx);
    if (found) return found;
  }

  return null;
}

function findJadxInDir(root: string): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const nested = findJadxInDir(join(root, entry.name));
      if (nested) return nested;
    } else if (entry.name === "jadx.bat" || entry.name === "jadx") {
      return join(root, entry.name);
    }
  }
  return null;
}

async function ensureJadx(): Promise<string> {
  const jadxPath = typeof flags["jadx"] === "string" ? (flags["jadx"] as string) : null;
  if (jadxPath && existsSync(jadxPath)) {
    log(`jadx 検出: ${jadxPath}`);
    return jadxPath;
  }

  const found = findJadx();
  if (found) {
    log(`jadx 検出: ${found}`);
    return found;
  }

  warn("jadx が見つかりません。以下からダウンロードして PATH を通すか、--jadx で指定してください:");
  warn("  https://github.com/skylot/jadx/releases");
  throw new Error("jadx が見つかりません");
}

// ---------------------------------------------------------------------------
// APK 選択
// ---------------------------------------------------------------------------

function resolveApk(): { path: string; version: string } | null {
  const apkOverride = typeof flags["apk"] === "string" ? (flags["apk"] as string) : null;
  const versionSelect = typeof flags["version"] === "string" ? (flags["version"] as string) : null;

  if (apkOverride) {
    if (!existsSync(apkOverride)) {
      throw new Error(`APK が見つかりません: ${apkOverride}`);
    }
    const ver = extractVersionFromPath(apkOverride) ?? "unknown";
    return { path: apkOverride, version: ver };
  }

  if (versionSelect) {
    const found = findLocalApkByVersion(versionSelect);
    if (!found) {
      throw new Error(
        `バージョン ${versionSelect} の APK が見つかりません。` +
          `data/apk/ に配置するか、--apk で指定してください。`,
      );
    }
    return { path: found.apkPath, version: found.version };
  }

  const latest = listLocalApks().sort((a, b) => compareVersions(a.version, b.version)).at(-1);
  if (!latest) {
    throw new Error(
      "APK が見つかりません。以下を実行してください:\n" +
        "  bun run apk -- download\n" +
        "  または手動で data/apk/LINE-<version>.apk を配置",
    );
  }
  return { path: latest.apkPath, version: latest.version };
}

function extractVersionFromPath(path: string): string | null {
  const m = path.match(/LINE-(\d+(?:\.\d+)+)\.apk$/i);
  if (m) return m[1]!;
  const m2 = path.match(/(\d+\.\d+\.\d+\.\d+)\.apk$/);
  return m2?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// jadx 実行
// ---------------------------------------------------------------------------

function runJadx(jadx: string, apkPath: string, outDir: string, threads: number): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const args = [
    "-d", outDir,
    "-j", String(threads),
    "--output-format", "java",
  ];

  if (flags["deobfuscate"]) {
    args.push("--deobf");
  }

  args.push(apkPath);

  log(`jadx 実行: ${basename(apkPath)} -> ${outDir}`);
  const proc = spawnSync(jadx, args, {
    cwd: dirname(outDir),
    stdio: "pipe",
    encoding: "utf8",
    timeout: 30 * 60 * 1000,
    env: {
      ...process.env,
      JAVA_TOOL_OPTIONS: `-Xms256m -XX:MaxRAMPercentage=${jvmMemPct}`,
    },
  });

  return {
    ok: proc.status === 0,
    status: proc.status,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const jadx = await ensureJadx();
  const apk = resolveApk();
  if (!apk) {
    throw new Error("APK を解決できませんでした。");
  }

  const apkStat = statSync(apk.path);
  log(`APK: ${apk.path} (${(apkStat.size / 1024 / 1024).toFixed(1)} MB)`);

  const version = apk.version;
  const outDir = typeof flags["jadx-out"] === "string"
    ? (flags["jadx-out"] as string)
    : join(APK_JADX_DIR, version);

  mkdirSync(outDir, { recursive: true });

  if (existsSync(join(outDir, "sources")) && !(flags["force"] as boolean | undefined)) {
    log(`既にデコンパイル済み: ${outDir}`);
    log(`再実行する場合は --force を指定してください。`);
    return;
  }

  const threads = Number(flags["threads"] ?? 4);
  const res = runJadx(jadx, apk.path, outDir, threads);

  if (res.stdout) console.log(res.stdout.trimEnd());
  if (res.stderr) console.error(res.stderr.trimEnd());

  if (!res.ok) {
    throw new Error(`jadx が失敗しました (exit ${res.status ?? "?"}). 詳細は上記ログを確認してください。`);
  }

  const sourcesDir = join(outDir, "sources");
  const hasSources = existsSync(sourcesDir);
  const javaCount = hasSources
    ? countJavaFiles(sourcesDir)
    : 0;

  const meta = {
    version,
    apkPath: apk.path,
    apkSize: apkStat.size,
    apkSha256: sha256File(apk.path),
    jadx,
    deobfuscate: Boolean(flags["deobfuscate"]),
    threads,
    decompiledAt: new Date().toISOString(),
    javaFiles: javaCount,
    outputDir: outDir,
  };

  writeFileSync(
    join(outDir, "_meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );

  log(`✓ デコンパイル完了: ${outDir} (${javaCount} Java ファイル)`);
  log(`次: bun run apk -- find <keyword>`);
}

function countJavaFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".java")) count++;
    }
  }
  return count;
}

await main().catch((err) => {
  console.error(`[apk-unpack] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
