/**
 * lineApkVersions — LINE Android (jp.naver.line.android) の APK バージョン管理。
 *
 * 機能:
 *   - ローカル APK のバージョン検出
 *   - APKPure からの APK ダウンロード (best-effort)
 *   - バージョン比較・一覧
 *
 *   bun run apk -- versions
 *   bun run apk -- latest
 *   bun run apk -- download
 *   bun run apk -- download --version 14.10.0
 *
 * 注意:
 *   - APKPure は scraping 耐性を持つ場合があります。取得不可時は手動で APK を data/apk/ に置いてください。
 *   - Google Play からの直接取得は gplaycli / apkeep 等の別ツールが必要です。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { APK_DIR, DATA_DIR } from "./paths.js";

export const LINE_PACKAGE = "jp.naver.line.android";
export const LINE_APK_PREFIX = "LINE-";

const APKPURE_BASE = "https://apkpure.com";
const APKPURE_LINE_PATH = "/line/line";

function log(msg: string): void {
  console.info(`[apk] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[apk] ⚠ ${msg}`);
}

// ---------------------------------------------------------------------------
// APK メタデータ
// ---------------------------------------------------------------------------

export interface ApkVersion {
  version: string;
  fileName: string;
  apkPath: string;
  size: number;
  sha256: string;
  downloadedAt: string | null;
}

// ---------------------------------------------------------------------------
// ローカル APK 検出
// ---------------------------------------------------------------------------

export function listLocalApks(): ApkVersion[] {
  if (!existsSync(APK_DIR)) return [];
  const entries = readdirSync(APK_DIR).filter((n) => n.startsWith(LINE_APK_PREFIX) && n.endsWith(".apk"));
  return entries
    .map((name) => {
      const path = join(APK_DIR, name);
      const m = name.match(/LINE-(\d+\.\d+\.\d+\.\d+)\.apk$/i);
      const version = m?.[1] ?? name.replace(/\.apk$/i, "");
      return {
        version,
        fileName: name,
        apkPath: path,
        size: statSync(path).size,
        sha256: sha256File(path),
        downloadedAt: statSync(path).mtime.toISOString(),
      };
    })
    .sort((a, b) => compareVersions(a.version, b.version));
}

export function findLocalApkByVersion(version: string): ApkVersion | null {
  return listLocalApks().find((v) => v.version === version) ?? null;
}

export function findLatestLocalApk(): ApkVersion | null {
  const list = listLocalApks();
  return list.length > 0 ? list[list.length - 1]! : null;
}

// ---------------------------------------------------------------------------
// APKPure から最新版情報を取得 (best-effort)
// ---------------------------------------------------------------------------

export interface ApkPureInfo {
  version: string;
  versionCode: string;
  downloadUrl: string | null;
  releaseDate: string | null;
}

async function fetchApkPureInfo(): Promise<ApkPureInfo | null> {
  try {
    const res = await fetch(`${APKPURE_BASE}${APKPURE_LINE_PATH}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) {
      warn(`APKPure レスポンス不正: HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();

    // APKPure のページから最新バージョン情報を抽出 (best-effort)
    const versionMatch = html.match(/"version_name"\s*:\s*"([^"]+)"/i);
    const versionCodeMatch = html.match(/"version_code"\s*:\s*"([^"]+)"/i);
    const downloadMatch = html.match(/download-link["\s]+href="([^"]+)"/i);
    const dateMatch = html.match(/"updated_on"\s*:\s*"([^"]+)"/i);

    const version = versionMatch?.[1] ?? null;
    const versionCode = versionCodeMatch?.[1] ?? null;
    const downloadUrl = downloadMatch?.[1] ?? null;

    if (!version) {
      warn("APKPure からバージョンを抽出できませんでした (DOM 構造変更の可能性)");
      return null;
    }

    return {
      version,
      versionCode: versionCode ?? version,
      downloadUrl: downloadUrl ? (downloadUrl.startsWith("http") ? downloadUrl : `${APKPURE_BASE}${downloadUrl}`) : null,
      releaseDate: dateMatch?.[1] ?? null,
    };
  } catch (err) {
    warn(`APKPure からの情報取得に失敗: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// APK ダウンロード
// ---------------------------------------------------------------------------

export async function downloadLatestApk(force = false): Promise<ApkVersion | null> {
  const latest = findLatestLocalApk();
  if (latest && !force) {
    log(`最新 APK は既に存在: ${latest.fileName}`);
    return latest;
  }

  const info = await fetchApkPureInfo();
  if (!info) {
    warn("APKPure から最新版情報を取得できませんでした。");
    warn("手動で APK を data/apk/ に配置するか、--apk <path> で指定してください。");
    return null;
  }

  if (!info.downloadUrl) {
    warn("ダウンロード URL を取得できませんでした。");
    return null;
  }

  log(`最新版: ${info.version} (code: ${info.versionCode})`);
  return downloadApk(info.version, info.downloadUrl);
}

export async function downloadApk(version: string, url: string): Promise<ApkVersion | null> {
  const fileName = `LINE-${version}.apk`;
  const outPath = join(APK_DIR, fileName);

  if (existsSync(outPath)) {
    log(`APK は既に存在: ${outPath}`);
    return {
      version,
      fileName,
      apkPath: outPath,
      size: statSync(outPath).size,
      sha256: sha256File(outPath),
      downloadedAt: statSync(outPath).mtime.toISOString(),
    };
  }

  log(`ダウンロード中: ${version} (${url})`);
  mkdirSync(APK_DIR, { recursive: true });

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    await Bun.write(outPath, res);
    log(`ダウンロード完了: ${outPath} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    warn(`ダウンロード失敗: ${err instanceof Error ? err.message : String(err)}`);
    warn("手動で APK を data/apk/ に配置してください。");
    return null;
  }

  return {
    version,
    fileName,
    apkPath: outPath,
    size: statSync(outPath).size,
    sha256: sha256File(outPath),
    downloadedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// APK バージョン抽出
// ---------------------------------------------------------------------------

export function extractApkVersion(apkPath: string): string | null {
  if (!existsSync(apkPath)) return null;
  const name = basename(apkPath);
  const m = name.match(/LINE-(\d+\.\d+\.\d+\.\d+)\.apk$/i);
  if (m) return m[1]!;

  // AndroidManifest.xml からバージョンを抽出 (aapt 等を使用)
  // ここではファイル名ベースで簡易判定
  const m2 = name.match(/(\d+\.\d+\.\d+\.\d+)/);
  return m2?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function sha256File(path: string): string {
  const hash = Bun.CryptoHasher.createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}
