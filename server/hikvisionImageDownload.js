import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DigestClient } from "digest-fetch";
import { DEFAULT_TIMEOUT_MS } from "./terminalHikvision.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} imagePath — masalan /LOCALS/pic/acsLinkCap/...@WEB...
 */
export function cleanTerminalImagePath(imagePath) {
  if (imagePath == null) return "";
  let s = String(imagePath).trim();
  if (!s) return "";
  if (s.includes("@")) s = s.split("@")[0];
  s = s.trim();
  if (!s.startsWith("/")) s = `/${s.replace(/^\/+/, "")}`;
  return s;
}

function sniffImageExt(buf) {
  if (!buf || buf.length < 4) return ".jpg";
  if (buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  return ".jpg";
}

function isLikelyXmlOrTextError(buf) {
  if (!buf || buf.length < 1) return true;
  const t = buf.subarray(0, Math.min(200, buf.length)).toString("utf8").trimStart();
  return t.startsWith("<") || t.startsWith("{") || t.toLowerCase().includes("<?xml");
}

/**
 * Terminaldan rasm — Digest auth GET.
 * @returns {Promise<{ ok: boolean, buffer?: Buffer, ext?: string, error?: string }>}
 */
export async function downloadTerminalImageDigest(
  baseUrl,
  username,
  password,
  imagePath,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const cleanPath = cleanTerminalImagePath(imagePath);
  if (!cleanPath) return { ok: false, error: "Bo'sh rasm yo'li" };
  const url = `${String(baseUrl).replace(/\/$/, "")}${cleanPath}`;
  const client = new DigestClient(String(username || ""), String(password || ""));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await client.fetch(url, {
      method: "GET",
      headers: {
        Accept: "image/*, */*",
        "User-Agent": "Keldi-Hikvision-ISAPI",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 80) return { ok: false, error: "Juda kichik javob" };
    if (isLikelyXmlOrTextError(buf)) return { ok: false, error: "Rasm emas (XML/matn)" };
    return { ok: true, buffer: buf, ext: sniffImageExt(buf) };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { ok: false, error: aborted ? "Timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

export function getFacesUploadDir() {
  const fromEnv = process.env.FACES_UPLOAD_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  return path.join(__dirname, "public", "uploads", "faces");
}

/**
 * @param {number} terminalId
 * @param {Record<string, unknown>} ev
 * @param {Buffer} buffer
 * @param {string} ext — .jpg yoki .png
 * @returns {{ publicPath: string, absolutePath: string } | null}
 */
export function saveFaceImageFile(terminalId, ev, buffer, ext) {
  if (!buffer || buffer.length === 0) return null;
  const dir = getFacesUploadDir();
  fs.mkdirSync(dir, { recursive: true });
  const serialRaw = ev?.serialNo ?? ev?.SerialNo ?? "0";
  const serial = String(serialRaw)
    .replace(/\W/g, "")
    .slice(0, 48) || "0";
  const safeExt = ext && /^\.(jpe?g|png)$/i.test(ext) ? ext.toLowerCase() : ".jpg";
  const fn = `face_${Number(terminalId) || 0}_${serial}_${Date.now()}${safeExt}`;
  const absolutePath = path.join(dir, fn);
  fs.writeFileSync(absolutePath, buffer);
  return { publicPath: `/uploads/faces/${fn}`, absolutePath };
}
