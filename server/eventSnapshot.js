import { cleanTerminalImagePath } from "./hikvisionImageDownload.js";

/** Terminal hodisasidan yuz surati (data URL yoki xom base64) — DB uchun qisqartirish. */

const MAX_SNAPSHOT_LEN = 280_000;

/**
 * @param {unknown} raw
 * @returns {string} data:image/...;base64,... yoki bo'sh
 */
export function normalizeEventSnapshot(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/\s/g, "");
  if (s.length > MAX_SNAPSHOT_LEN) s = s.slice(0, MAX_SNAPSHOT_LEN);
  if (/^data:image\//i.test(s)) return s;
  if (/^[A-Za-z0-9+/=]+$/.test(s) && s.length > 200) {
    return `data:image/jpeg;base64,${s}`;
  }
  return "";
}

/**
 * Terminaldagi nisbiy yo'l (/LOCALS/pic/...) yoki to'liq URL — GET orqali yuklab olinadi.
 * @param {Record<string, unknown>} ev — Hikvision / HTTP JSON
 */
export function terminalImagePathFromEvent(ev) {
  if (!ev || typeof ev !== "object") return "";
  const o = ev;
  const pathKeys = [
    "pictureURL",
    "PictureURL",
    "pictureUrl",
    "PictureUrl",
    "snapPictureURL",
    "SnapPictureURL",
    "pictureUri",
    "PictureUri",
    "picUri",
    "imagePath",
    "ImagePath",
  ];
  for (const k of pathKeys) {
    const raw = o[k];
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s || s.length > 2048) continue;
    if (/^data:image/i.test(s)) continue;
    const compact = s.replace(/\s/g, "");
    if (/^[A-Za-z0-9+/=]{400,}$/.test(compact)) continue;
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        return cleanTerminalImagePath(u.pathname);
      } catch {
        continue;
      }
    }
    if (s.startsWith("/") || /LOCALS/i.test(s)) return cleanTerminalImagePath(s);
  }
  const pic = o.picture ?? o.Picture;
  if (pic != null) {
    const s = String(pic).trim();
    if (
      s &&
      s.length < 400 &&
      !/^data:image/i.test(s) &&
      !/^[A-Za-z0-9+/=]{200,}$/.test(s.replace(/\s/g, "")) &&
      (s.startsWith("/") || /LOCALS/i.test(s))
    ) {
      return cleanTerminalImagePath(s);
    }
  }
  return "";
}

export function snapshotFromHikvisionEvent(ev) {
  if (!ev || typeof ev !== "object") return "";
  const o = ev;
  const keys = [
    "picture",
    "Picture",
    "SNAPPicture",
    "snapPicture",
    "SnapPicture",
    "faceSnap",
    "FaceSnap",
    "pictureData",
    "PictureData",
    "faceImage",
    "FaceImage",
  ];
  for (const k of keys) {
    const n = normalizeEventSnapshot(o[k]);
    if (n) return n;
  }
  return "";
}
