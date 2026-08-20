/**
 * apkLatest — APKPure から最新版情報を取得。
 *
 *   bun run apk -- latest
 *   bun run apk -- latest --json
 */

import { fetchApkPureInfo } from "./lineApkVersions.js";

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

const jsonOut = Boolean(flags["json"]);

async function main(): Promise<void> {
  const info = await fetchApkPureInfo();
  if (!info) {
    console.error("最新版情報を取得できませんでした。");
    process.exit(1);
  }
  if (jsonOut) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(`version: ${info.version}`);
    console.log(`code  : ${info.versionCode}`);
    if (info.downloadUrl) console.log(`url   : ${info.downloadUrl}`);
    if (info.releaseDate) console.log(`date  : ${info.releaseDate}`);
  }
}

await main().catch((err) => {
  console.error(`[apk-latest] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
