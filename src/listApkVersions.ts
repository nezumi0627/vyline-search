/**
 * listApkVersions — ローカル APK の一覧表示。
 *
 *   bun run apk -- versions
 *   bun run apk -- versions --json
 */

import { existsSync } from "node:fs";
import { APK_DIR } from "./paths.js";
import { listLocalApks } from "./lineApkVersions.js";

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
const apks = listLocalApks();

if (jsonOut) {
  console.log(JSON.stringify({ apkDir: APK_DIR, apks }, null, 2));
  process.exit(0);
}

console.log(`APK dir : ${APK_DIR}`);
if (apks.length === 0) {
  console.log("APK が見つかりません。");
  console.log("  bun run apk -- download");
  process.exit(0);
}
console.log("");
for (const apk of apks) {
  console.log(`  ${apk.version}  (${(apk.size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log("");
