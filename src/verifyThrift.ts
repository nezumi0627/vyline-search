/**
 * verifyThrift — jadx デコンパイル済み APK から Thrift 構造体を検証する。
 *
 * 事前に以下を実行しておく:
 *   bun run apk -- unpack --version <ver>
 *   bun run apk -- find Thrift
 *
 * このスクリプトは jadx 出力をスキャンし、
 * editMessage / getMessageEditNotice の Thrift 構造体を確認する。
 *
 *   bun run apk -- verify-thrift
 *   bun run apk -- verify-thrift --version 14.10.0
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { APK_JADX_DIR, OUT_DIR } from "./paths.js";

const flags: Record<string, string | boolean> = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    flags[key] = next;
    i++;
  } else {
    flags[key] = true;
  }
}

const version = typeof flags["version"] === "string" ? (flags["version"] as string) : null;

function log(msg: string): void {
  console.info(`[verify-thrift] ${msg}`);
}

function resolveJadxDir(): string {
  if (version) {
    return join(APK_JADX_DIR, version);
  }
  const entries = readdirSync(APK_JADX_DIR).filter((n) => existsSync(join(APK_JADX_DIR, n, "sources")));
  if (entries.length === 0) {
    throw new Error("jadx 出力がありません。先に `bun run apk -- unpack` を実行してください。");
  }
  entries.sort();
  return join(APK_JADX_DIR, entries[entries.length - 1]!);
}

function scanJavaFiles(dir: string): string[] {
  const sourcesDir = join(dir, "sources");
  if (!existsSync(sourcesDir)) return [];
  const out: string[] = [];
  const stack = [sourcesDir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".java")) out.push(p);
    }
  }
  return out;
}

function searchInFile(path: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of patterns) {
        if (pattern.test(lines[i]!)) {
          hits.push(`L${i + 1}: ${lines[i]!.trim()}`);
          break;
        }
      }
    }
  } catch {
    // ignore
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Thrift 構造体の検証パターン
// ---------------------------------------------------------------------------

const THRIFT_VERIFICATIONS = [
  {
    name: "editMessage_args",
    description: "editMessage Thrift args 構造体",
    patterns: [
      /editMessage.*args/i,
      /class\s+\w+editMessage\w*args/i,
      /seq\s*[:=].*\bfid\s*[:=]?\s*1/i,
      /from\s*[:=].*\bfid\s*[:=]?\s*2/i,
      /to\s*[:=].*\bfid\s*[:=]?\s*3/i,
      /toType\s*[:=].*\bfid\s*[:=]?\s*4/i,
      /messageId\s*[:=].*\bfid\s*[:=]?\s*5/i,
      /text\s*[:=].*\bfid\s*[:=]?\s*10/i,
      /contentType\s*[:=].*\bfid\s*[:=]?\s*15/i,
    ],
  },
  {
    name: "getMessageEditNotice_args",
    description: "getMessageEditNotice Thrift args 構造体",
    patterns: [
      /getMessageEditNotice.*args/i,
      /class\s+\w+getMessageEditNotice\w*args/i,
      /chatMid\s*[:=].*\bfid\s*[:=]?\s*1/i,
    ],
  },
  {
    name: "TCompactProtocol",
    description: "TCompactProtocol の使用箇所",
    patterns: [
      /TCompactProtocol/i,
      /compact.*protocol/i,
      /PROTOCOL_ID.*4/i,
      /VERSION_1.*1/i,
    ],
  },
  {
    name: "Thrift endpoint /S4",
    description: "/S4 エンドポイント",
    patterns: [
      /"\/S4"/i,
      /'\/S4'/i,
      /\/S4.*endpoint/i,
    ],
  },
];

async function main(): Promise<void> {
  const jadxDir = resolveJadxDir();
  log(`jadx dir: ${jadxDir}`);

  const files = scanJavaFiles(jadxDir);
  log(`Java ファイル: ${files.length}`);

  const results: Record<string, { description: string; files: string[]; hits: string[] }> = {};

  for (const check of THRIFT_VERIFICATIONS) {
    const filesWithHits: string[] = [];
    const allHits: string[] = [];

    for (const file of files) {
      const hits = searchInFile(file, check.patterns);
      if (hits.length > 0) {
        filesWithHits.push(relative(jadxDir, file));
        allHits.push(...hits.slice(0, 10));
      }
    }

    results[check.name] = {
      description: check.description,
      files: filesWithHits,
      hits: allHits,
    };

    const status = filesWithHits.length > 0 ? "✓" : "✗";
    console.log(`\n${status} ${check.name}: ${check.description}`);
    if (filesWithHits.length === 0) {
      console.log("  (未検出)");
    } else {
      for (const f of filesWithHits.slice(0, 5)) {
        console.log(`  - ${f}`);
      }
      for (const h of allHits.slice(0, 5)) {
        console.log(`    ${h}`);
      }
    }
  }

  const outDir = join(OUT_DIR, "apk-thrift-verify");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "verify.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), jadxDir, results }, null, 2)}\n`,
    "utf8",
  );
  log(`\ndone -> ${join(outDir, "verify.json")}`);
}

await main().catch((err) => {
  console.error(`[verify-thrift] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
