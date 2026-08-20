#!/usr/bin/env bun
/**
 * cliApk — APK 解析のサブコマンドルータ。
 *
 *   bun run apk -- versions
 *   bun run apk -- latest
 *   bun run apk -- download
 *   bun run apk -- download --version 14.10.0
 *   bun run apk -- unpack
 *   bun run apk -- unpack --apk data/apk/LINE-14.10.0.apk
 *   bun run apk -- find sendMessage
 *   bun run apk -- find editMessage --version 14.10.0
 *   bun run apk -- diff --auto
 *   bun run apk -- diff --old 14.9.0 --new 14.10.0
 *   bun run apk -- verify-thrift
 */

export {};

const [sub, ...rest] = process.argv.slice(2);

if (!sub || sub === "-h" || sub === "--help") {
  console.log(`vyline-search apk — LINE Android APK 解析

Usage:
  bun run apk -- versions                    # ローカル APK 一覧
  bun run apk -- latest                      # 最新版情報 (APKPure)
  bun run apk -- download                    # APK ダウンロード (best-effort)
  bun run apk -- download --version 14.10.0  # 特定バージョンをダウンロード
  bun run apk -- unpack                      # jadx デコンパイル
  bun run apk -- unpack --apk <path>         # APK 指定してデコンパイル
  bun run apk -- find <term>                 # 文字列 / クラス / メソッド検索
  bun run apk -- find <term> --version 14.10.0
  bun run apk -- diff --auto                 # 最新 2 バージョンの差分
  bun run apk -- diff --old <v> --new <v>    # 指定バージョンの差分
  bun run apk -- verify-thrift               # Thrift 構造体の検証

Docs:
  docs/apk.md
`);
  process.exit(sub ? 0 : 1);
}

if (sub === "versions") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await import("./listApkVersions.js");
} else if (sub === "latest") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await import("./apkLatest.js");
} else if (sub === "download") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await import("./downloadApk.js");
} else if (sub === "unpack") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await import("./unpackApk.js");
} else if (sub === "find") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await import("./findApkSymbol.js");
} else if (sub === "diff") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await import("./diffApk.js");
} else if (sub === "verify-thrift") {
  process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  await import("./verifyThrift.js");
} else {
  console.error(`unknown apk subcommand: ${sub}`);
  console.error(`try: bun run apk -- versions`);
  process.exit(1);
}
