/**
 * downloadApk — LINE APK をダウンロード。
 *
 *   bun run apk -- download
 *   bun run apk -- download --version 14.10.0
 *   bun run apk -- download --force
 */

import { downloadLatestApk, downloadApk } from "./lineApkVersions.js";

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
const force = Boolean(flags["force"]);

async function main(): Promise<void> {
  if (version) {
    const info = await import("./lineApkVersions.js").then((m) => m.fetchApkPureInfo());
    if (!info || !info.downloadUrl) {
      console.error("ダウンロード URL を取得できませんでした。");
      process.exit(1);
    }
    const result = await downloadApk(version, info.downloadUrl);
    if (!result) process.exit(1);
  } else {
    const result = await downloadLatestApk(force);
    if (!result) process.exit(1);
  }
}

await main().catch((err) => {
  console.error(`[apk-download] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
