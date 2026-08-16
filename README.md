# Vyline-Search

Desktop LINE（Themida 保護）向けの **unpack / ネイティブシンボル検索 / 逆コンパイル** ツールキット。

元は [Vyline](https://github.com/nezumi0627/Vyline) の `findNativeSymbol` / `focusRecoveredSource` を切り出したスタンドアロンリポジトリです。

> **免責（必読）:** 本ツールは **教育・学習・セキュリティ研究向けの実験用** です。  
> 利用規約・法令に反する用途、第三者への攻撃、実行ファイルや秘密情報の再配布には使わないでください。  
> 実行・解析の結果はすべて自己責任です。詳細は **[docs/DISCLAIMER.md](docs/DISCLAIMER.md)**。

## できること

1. **unpack** — Themida 保護の `LINE.exe` を [unlicense](https://github.com/ergrelet/unlicense) で dump → `data/unpacked_LINE.exe`
2. **find** — 単語（例: `sendMessage`）から文字列列挙 → LEA xref → Ghidra decompile
3. **focus** — 全件 decompile 結果のキーワード分類（任意）

## 必要環境

- [Bun](https://bun.sh) 1.1+
- Windows x64
- Desktop LINE（unpack 時）
- JDK 21+（decompile 時のみ）

## セットアップ

```powershell
cd E:\projects\Vyline-Search   # or: git clone https://github.com/nezumi0627/vyline-search
bun install
```

環境変数:

| 変数 | 意味 |
|---|---|
| `VYLINE_SEARCH_DATA` | データルート（既定: `./data`） |
| `VYLINE_SEARCH_EXE` | 既定の unpacked exe パス |
| `NEZU_LINE_ROOT` | Desktop LINE ルート（既定: `%LOCALAPPDATA%\LINE`） |

## 使い方

```powershell
# 1) Themida unpack（LINE を終了してから推奨）
bun run unpack
# bun run unpack -- --timeout 180

# 2) シンボル検索（文字列 + xref だけなら Ghidra 不要）
bun run find -- sendMessage --list-only --skip-setup

# 3) decompile まで
bun run find -- sendMessage

# 複数語 / CLI
bun run find -- sendMessage unsendMessage markAsRead
bun run search -- unpack
bun run search -- find sendMessage --max-functions 10
```

### find の主なオプション

| オプション | 既定 | 説明 |
|---|---|---|
| `--exe <path>` | `data/unpacked_LINE.exe` | 解析対象 |
| `--list-only` | off | decompile スキップ |
| `--max-functions <n>` | 20 | decompile 上限 |
| `--timeout <sec>` | 20 | 関数あたり timeout |
| `--include-all` | off | 全 xref を decompile |
| `--skip-setup` | off | Ghidra/JDK 自動取得スキップ |

詳細:

- [docs/unpack.md](docs/unpack.md)
- [docs/find-native-symbol.md](docs/find-native-symbol.md)

## 出力

```text
data/unpacked_LINE.exe
data/unpack-meta.json
data/out/native-search/<terms>/
  README.md
  strings.json
  xrefs.json
  rva-targets.txt
  functions/*.c
```

`data/` 以下（exe・ツールキャッシュ・出力）は gitignore 済みです。

## ディレクトリ構成

```text
Vyline-Search/
  src/
    cli.ts
    unpackLine.ts          # Themida unpack (unlicense)
    findNativeSymbol.ts
    focusRecoveredSource.ts
    paths.ts
  ghidra-scripts/
  docs/
  data/                    # ローカル作業領域（gitignore）
```

## Themida について

- **unpack**: unlicense が対象を起動し OEP 到達後にメモリ dump（仮想化コードは残る）
- **find**: 文字列・xref は生 PE スキャン。decompile だけ Ghidra（`-noanalysis`）

## License

MIT — see [LICENSE](LICENSE).

利用目的・禁止事項・自己責任の詳細は [docs/DISCLAIMER.md](docs/DISCLAIMER.md) を参照してください。

unlicense 本体は別ライセンス（[ergrelet/unlicense](https://github.com/ergrelet/unlicense)）です。取得物は `data/re-tools/` に置かれ、リポジトリには含まれません。
