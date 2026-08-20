# APK 解析 — LINE Android

`jadx` で LINE Android APK (`jp.naver.line.android`) をデコンパイルし、
文字列・クラス・メソッドの検索、およびバージョン間差分を取る。

## 前提

- jadx (https://github.com/skylot/jadx/releases) がインストール済み、または `JADX_HOME` が設定されている
- APK が `data/apk/` に存在する（自動取得は best-effort）

## 使い方

```powershell
# APK 一覧
bun run apk -- versions

# 最新版情報 (APKPure)
bun run apk -- latest

# APK ダウンロード (best-effort)
bun run apk -- download

# jadx デコンパイル
bun run apk -- unpack
bun run apk -- unpack --version 14.10.0
bun run apk -- unpack --apk data/apk/LINE-14.10.0.apk --deobfuscate

# 文字列 / クラス / メソッド検索
bun run apk -- find sendMessage
bun run apk -- find editMessage --version 14.10.0
bun run apk -- find "R.raw" --type resource

# バージョン間差分
bun run apk -- diff --auto
bun run apk -- diff --old 14.9.0 --new 14.10.0

# Thrift 構造体の検証
bun run apk -- verify-thrift
bun run apk -- verify-thrift --version 14.10.0
```

## 出力

```text
data/apk/
  LINE-14.10.0.apk

data/apk-jadx/
  14.10.0/
    sources/          (Java ソース)
    resources/        (リソース)
    _meta.json

data/out/apk-search/
  14.10.0_sendMessage/
    README.md
    strings.json

data/out/apk-diff/
  14.9.0_vs_14.10.0/
    README.md
    stats.json
    added.json
    modified.json
    removed.json

data/out/apk-thrift-verify/
  verify.json
```

## Thrift プロトコルの検証

LINE Android の Thrift 通信を検証するには:

```powershell
# jadx でデコンパイル後
bun run apk -- verify-thrift --version 14.10.0
```

`verify-thrift` は以下をスキャンします:

- `editMessage_args` — seq (fid=1), from (fid=2), to (fid=3), toType (fid=4), messageId (fid=5), text (fid=10), contentType (fid=15)
- `getMessageEditNotice_args` — chatMid (fid=1)
- `TCompactProtocol` の使用箇所
- `/S4` エンドポイント

検証結果は `data/out/apk-thrift-verify/verify.json` に保存されます。

## 制限

- APKPure の scraping は best-effort です。取得不可時は手動で APK を配置してください
- jadx のデコンパイル品質は難読化・アンチリバースの影響を受けます
- Thrift 構造体の確認は jadx 出力 + 差分検索で行います
