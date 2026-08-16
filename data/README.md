# Local workspace (gitignored contents except this note)

> 教育・実験目的のみ。`unpacked_*.exe` や解析成果物はコミット・再配布しないでください。  
> 詳細: [../docs/DISCLAIMER.md](../docs/DISCLAIMER.md)

## Quick start

```powershell
bun run unpack          # → data/unpacked_LINE.exe
bun run find -- sendMessage --list-only
```

## Layout

```text
data/unpacked_LINE.exe      # unpack 出力（または手動配置）
data/unpack-meta.json       # 直近 unpack のメタ
data/re-tools/unlicense/    # unlicense 自動取得先
data/re-tools/ghidra/       # Ghidra（find が自動取得可）
data/out/                   # find / focus 出力
data/ghidra-projects/       # Ghidra project cache
data/unpack-work/           # unpack 作業用（成功後は削除）
```

Env: `VYLINE_SEARCH_EXE` / `VYLINE_SEARCH_DATA` / `NEZU_LINE_ROOT`
