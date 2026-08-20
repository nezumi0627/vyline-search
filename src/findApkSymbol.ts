/**
 * findApkSymbol — jadx デコンパイル済み APK から文字列 / 関数を検索する。
 *
 *   bun run apk -- find sendMessage
 *   bun run apk -- find editMessage --version 14.10.0
 *   bun run apk -- find Thrift --deobf
 *   bun run apk -- find "R.raw" --type resource
 *
 * 検索対象:
 *   - Java ソース内の文字列リテラル
 *   - メソッド名 / クラス名
 *   - リソースファイル名
 *
 * 出力:
 *   data/out/apk-search/<version>_<slug>/
 *     README.md
 *     strings.json
 *     classes.json
 *     resources.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { APK_JADX_DIR, APK_DIR, OUT_DIR } from "./paths.js";
import { listLocalApks, findLocalApkByVersion, compareVersions } from "./lineApkVersions.js";

const CONCURRENCY = 32;

async function parallelMap<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return Promise.resolve([]);
  const results: R[] = new Array(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

const rawArgs = process.argv.slice(2);
const terms: string[] = [];
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]!;
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = rawArgs[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    terms.push(a);
  }
}

if (terms.length === 0) {
  console.error("usage: bun run apk -- find <term> [more...] [options]");
  console.error("  --version <ver>       APK バージョン（既定: 最新）");
  console.error("  --jadx-dir <path>     jadx 出力ディレクトリ（既定: data/apk-jadx/<version>/）");
  console.error("  --type <kind>         string | class | method | resource | all（既定: all）");
  console.error("  --max-results <n>     結果の上限（既定: 200）");
  console.error("  --include-content     一致した行の内容を出力に含める");
  process.exit(1);
}

function log(msg: string): void {
  console.info(`[apk-find] ${msg}`);
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const searchType = (typeof flags["type"] === "string" ? (flags["type"] as string) : "all").toLowerCase();
const maxResults = Number(flags["max-results"] ?? 200);
const includeContent = Boolean(flags["include-content"]);

// ---------------------------------------------------------------------------
// 入力解決
// ---------------------------------------------------------------------------

function resolveJadxDir(): { dir: string; version: string } | null {
  const jadxOverride = typeof flags["jadx-dir"] === "string" ? (flags["jadx-dir"] as string) : null;
  const versionSelect = typeof flags["version"] === "string" ? (flags["version"] as string) : null;

  if (jadxOverride) {
    const name = basename(jadxOverride);
    const m = name.match(/(\d+\.\d+\.\d+\.\d+)/);
    const version = m?.[1] ?? name;
    return { dir: jadxOverride, version };
  }

  let version: string | null = null;
  if (versionSelect) {
    const found = findLocalApkByVersion(versionSelect);
    if (!found) {
      throw new Error(`バージョン ${versionSelect} の APK が見つかりません。`);
    }
    version = found.version;
  } else {
    const latest = listLocalApks().sort((a, b) => compareVersions(a.version, b.version)).at(-1);
    version = latest?.version ?? null;
  }

  if (!version) {
    throw new Error("jadx 出力ディレクトリを解決できません。--jadx-dir または --version を指定してください。");
  }

  const dir = join(APK_JADX_DIR, version);
  if (!existsSync(dir)) {
    throw new Error(
      `jadx 出力がありません: ${dir}\n` +
        "先に以下を実行してください:\n" +
        `  bun run apk -- unpack --version ${version}`,
    );
  }
  return { dir, version };
}

// ---------------------------------------------------------------------------
// ファイル列挙
// ---------------------------------------------------------------------------

interface SourceFile {
  path: string;
  relative: string;
  packageName: string;
  className: string;
}

function listJavaSources(jadxDir: string): SourceFile[] {
  const sourcesDir = join(jadxDir, "sources");
  if (!existsSync(sourcesDir)) return [];
  const out: SourceFile[] = [];
  const stack = [sourcesDir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".java")) {
        const rel = relative(sourcesDir, p);
        const parts = rel.replace(/\.java$/, "").split(/[/\\]/);
        const className = parts.at(-1) ?? entry.name;
        const packageName = parts.slice(0, -1).join(".");
        out.push({ path: p, relative: rel, packageName, className });
      }
    }
  }
  return out;
}

function listResourceFiles(jadxDir: string): { path: string; relative: string; ext: string }[] {
  const resourcesDir = join(jadxDir, "resources");
  if (!existsSync(resourcesDir)) return [];
  const out: { path: string; relative: string; ext: string }[] = [];
  const stack = [resourcesDir];
  while (stack.length) {
    const cur = stack.pop()!;
    const entries = readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const p = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else {
        const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
        out.push({ path: p, relative: relative(resourcesDir, p), ext });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 検索ロジック
// ---------------------------------------------------------------------------

type SearchResult = {
  term: string;
  kind: "string" | "class" | "method" | "resource";
  file: string;
  line: number;
  content: string;
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchInFile(path: string, term: string, kind: string, regex: RegExp): SearchResult[] {
  const results: SearchResult[] = [];
  if (!existsSync(path)) return results;

  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (regex.test(line)) {
      results.push({
        term,
        kind: kind === "all" ? inferKind(line) : (kind as SearchResult["kind"]),
        file: path,
        line: i + 1,
        content: includeContent ? line.trim() : "",
      });
    }
  }

  return results;
}

function inferKind(line: string): SearchResult["kind"] {
  if (line.includes('"') && line.match(/"[^"]*"/)) return "string";
  if (/\b(class|interface|enum)\s+\w+/.test(line)) return "class";
  if (/\b(public|private|protected|static).*\w+\s*\(/.test(line)) return "method";
  return "string";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`検索語: ${terms.join(", ")}`);
  const resolved = resolveJadxDir();
  if (!resolved) {
    throw new Error("jadx 出力ディレクトリを解決できません。");
  }
  const { dir: jadxDir, version } = resolved;
  log(`jadx dir: ${jadxDir}`);

  const sources = listJavaSources(jadxDir);
  const resources = listResourceFiles(jadxDir);
  log(`ソース: ${sources.length} ファイル、リソース: ${resources.length} ファイル`);

  const allResults: SearchResult[] = [];
  const termStats = new Map<string, number>();

  const escapedTerms = terms.map(escapeRegex);

  for (const term of terms) {
    const termResults: SearchResult[] = [];

    if (searchType === "resource" || searchType === "all") {
      for (const res of resources.slice(0, maxResults)) {
        if (res.relative.includes(term) || res.ext === term.replace(/^\./, "")) {
          termResults.push({
            term,
            kind: "resource",
            file: res.path,
            line: 0,
            content: includeContent ? res.relative : "",
          });
        }
      }
    }

    if (searchType !== "resource") {
      const kinds = searchType === "all" ? ["string", "class", "method"] : [searchType];
      const compiled = kinds.map(k => {
        const escaped = escapeRegex(term);
        return {
          kind: k as SearchResult["kind"],
          regex: k === "string"
            ? new RegExp(`"([^"\\\\]|\\\\.)*${escaped}([^"\\\\]|\\\\.)*"`, "i")
            : k === "class"
            ? new RegExp(`\\b${escaped}\\b`)
            : new RegExp(`(?:\\b|\\()${escaped}(?:\\s*\\()`, "i"),
        };
      });

      const filesToSearch = searchType === "all"
        ? sources
        : sources.filter((s) => {
            if (searchType === "class") return s.className.includes(term) || s.packageName.includes(term);
            return true;
          });

      const searchResults = await parallelMap(
        filesToSearch.slice(0, maxResults),
        CONCURRENCY,
        async (src) => {
          const hits: SearchResult[] = [];
          for (const { kind, regex } of compiled) {
            hits.push(...searchInFile(src.path, term, kind, regex));
          }
          return hits;
        }
      );

      for (const hits of searchResults) {
        termResults.push(...hits);
      }
    }

    termResults.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const limited = termResults.slice(0, maxResults);
    allResults.push(...limited);
    termStats.set(term, termResults.length);
    log(`"${term}": ${termResults.length} 件 (表示: ${limited.length})`);
  }

  const outDir = join(OUT_DIR, "apk-search", `${version}_${slugify(terms.join("+"))}`);
  mkdirSync(outDir, { recursive: true });

  const byTerm: Record<string, { total: number; results: SearchResult[] }> = {};
  for (const term of terms) {
    byTerm[term] = {
      total: termStats.get(term) ?? 0,
      results: allResults.filter((r) => r.term === term),
    };
  }

  writeFileSync(
    join(outDir, "strings.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        version,
        jadxDir,
        terms: byTerm,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  writeReadme({ terms, byTerm, allResults, outDir, version, jadxDir });
  log(`done -> ${outDir}`);
}

function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

function writeReadme(args: {
  terms: string[];
  byTerm: Record<string, { total: number; results: SearchResult[] }>;
  allResults: SearchResult[];
  outDir: string;
  version: string;
  jadxDir: string;
}): void {
  const { terms, byTerm, allResults, outDir, version, jadxDir } = args;
  const lines: string[] = [];
  lines.push(`# apk-find: ${terms.join(", ")}`);
  lines.push("");
  lines.push(`generatedAt: ${new Date().toISOString()}`);
  lines.push(`version: ${version}`);
  lines.push(`jadxDir: ${jadxDir}`);
  lines.push("");

  for (const term of terms) {
    const entry = byTerm[term] ?? { total: 0, results: [] };
    lines.push(`## "${term}" (${entry.total} 件)`);
    lines.push("");
    for (const r of entry.results.slice(0, 100)) {
      const kind = r.kind === "string" ? "str" : r.kind === "class" ? "cls" : r.kind === "method" ? "mtd" : "res";
      lines.push(`- [${kind}] \`${relative(r.file, jadxDir)}\` L${r.line}${r.content ? `: \`${r.content.slice(0, 120)}\`` : ""}`);
    }
    if (entry.results.length > 100) {
      lines.push(`- ... and ${entry.results.length - 100} more (see strings.json)`);
    }
    lines.push("");
  }

  lines.push("## 統計");
  lines.push("");
  lines.push(`- total hits: ${allResults.length}`);
  lines.push("");
  lines.push("## 出力");
  lines.push("");
  lines.push("```text");
  lines.push(`${outDir}/`);
  lines.push("  README.md        (このファイル)");
  lines.push("  strings.json     検索結果 (JSON)");
  lines.push("```");
  lines.push("");

  writeFileSync(join(outDir, "README.md"), `${lines.join("\n")}\n`, "utf8");
}

await main().catch((err) => {
  console.error(`[apk-find] エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
