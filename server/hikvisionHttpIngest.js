import { applyTerminalEvent } from "./terminalIntegration.js";
import { emitAttendanceBroadcast } from "./attendanceBroadcastHub.js";
import { normalizeEventSnapshot } from "./eventSnapshot.js";
import { cleanTerminalImagePath } from "./hikvisionImageDownload.js";
import { directionHintFromEvents, isCheckoutTerminalType } from "./hikvisionAccessDirection.js";
import { HIKVISION_PERSON_NAME_KEYS } from "./terminalHikvision.js";

function normalizeDeviceHost(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "");
  s = s.split("/")[0];
  s = s.split(":")[0];
  s = s.replace(/^::ffff:/i, "");
  return s.toLowerCase();
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return normalizeDeviceHost(String(xff).split(",")[0]);
  const ra = req.socket?.remoteAddress || "";
  return normalizeDeviceHost(ra);
}

function xmlTagInner(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  return String(m[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1").trim();
}

function xmlFirstTagValue(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? String(m[1]).trim() : "";
}

function extractPicturePathFromXmlBlock(block) {
  if (!block || typeof block !== "string") return "";
  const tags = [
    "pictureURL",
    "PictureURL",
    "pictureUrl",
    "PictureUrl",
    "snapPictureURL",
    "SnapPictureURL",
    "pictureUri",
    "PictureUri",
  ];
  for (const tag of tags) {
    let v = xmlFirstTagValue(block, tag);
    if (!v) v = xmlTagInner(block, tag);
    if (!v) continue;
    const s = String(v).trim();
    if (!s || s.length > 2048) continue;
    if (/^https?:\/\//i.test(s)) {
      try {
        return cleanTerminalImagePath(new URL(s).pathname);
      } catch {
        continue;
      }
    }
    if (s.startsWith("/") || /LOCALS/i.test(s)) return cleanTerminalImagePath(s);
  }
  return "";
}

function extractPictureFromAccessControlXml(block) {
  if (!block || typeof block !== "string") return "";
  const tags = [
    "picture",
    "Picture",
    "SNAPPicture",
    "snapPic",
    "SnapPic",
    "faceSnap",
    "FaceSnap",
    "pPicture",
    "PPicture",
  ];
  for (const tag of tags) {
    const inner = xmlTagInner(block, tag);
    const compact = inner ? inner.replace(/\s/g, "") : "";
    if (compact.length > 200) return normalizeEventSnapshot(compact);
    const fv = xmlFirstTagValue(block, tag);
    const fc = fv ? fv.replace(/\s/g, "") : "";
    if (fc.length > 200) return normalizeEventSnapshot(fc);
  }
  return "";
}

/** Multipart tanadan birinchi JPEG qismi → data URL. */
function firstJpegDataUrlFromMultipart(buf, contentType) {
  const ct = String(contentType || "");
  const bm = ct.match(/boundary=([^;\s]+)/i);
  if (!bm || !Buffer.isBuffer(buf)) return "";
  const boundaryStr = bm[1].trim().replace(/^["']|["']$/g, "");
  const boundary = Buffer.from(`--${boundaryStr}`);
  let start = 0;
  while (true) {
    const i = buf.indexOf(boundary, start);
    if (i < 0) break;
    const next = buf.indexOf(boundary, i + boundary.length);
    const partEnd = next < 0 ? buf.length : next;
    const part = buf.subarray(i + boundary.length, partEnd);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > 0) {
      const headers = part.subarray(0, headerEnd).toString("latin1").toLowerCase();
      const body = part.subarray(headerEnd + 4);
      if (
        (headers.includes("image/jpeg") || headers.includes("image/jpg")) &&
        body.length > 500 &&
        body[0] === 0xff &&
        body[1] === 0xd8
      ) {
        const b64 = body.toString("base64");
        return normalizeEventSnapshot(`data:image/jpeg;base64,${b64}`);
      }
    }
    start = i + boundary.length;
    if (next < 0) break;
  }
  return "";
}

function personNameFromXmlBlock(block) {
  if (!block || typeof block !== "string") return "";
  for (const tag of HIKVISION_PERSON_NAME_KEYS) {
    let v = xmlFirstTagValue(block, tag);
    if (!v) v = xmlTagInner(block, tag);
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function personNameFromAccessControl(ac) {
  if (!ac || typeof ac !== "object") return "";
  for (const k of HIKVISION_PERSON_NAME_KEYS) {
    const v = ac[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function attachXmlAccessHints(block, ev) {
  if (!block || typeof block !== "string") return;
  const tags = [
    "attendanceState",
    "AttendanceState",
    "accessType",
    "AccessType",
    "direction",
    "eventType",
    "subEventType",
    "currentEventType",
    "accessChannel",
    "label",
  ];
  for (const tag of tags) {
    let v = xmlFirstTagValue(block, tag);
    if (!v) v = xmlTagInner(block, tag);
    if (v != null && String(v).trim()) ev[tag] = String(v).trim();
  }
}

/** Multipart yoki to‘liq matndan EventNotificationAlert XML qismini ajratish. */
function extractXmlPayload(buffer, contentType) {
  const ct = String(contentType || "");
  let raw = buffer.toString("utf8");

  if (/multipart/i.test(ct)) {
    const alertIdx = raw.indexOf("<EventNotificationAlert");
    if (alertIdx >= 0) {
      const closeTag = "</EventNotificationAlert>";
      const endIdx = raw.indexOf(closeTag, alertIdx);
      if (endIdx >= 0) return raw.slice(alertIdx, endIdx + closeTag.length);
    }
    const xmlDecl = raw.indexOf("<?xml");
    if (xmlDecl >= 0) {
      const alertIdx2 = raw.indexOf("<", xmlDecl + 1);
      if (alertIdx2 >= 0) {
        const end = raw.indexOf("</", alertIdx2);
        if (end > 0) {
          const close = raw.indexOf(">", raw.indexOf(">", end) + 1);
          if (close > 0) return raw.slice(xmlDecl, close + 1);
        }
      }
    }
  }

  return raw;
}

/**
 * Hikvision HTTP monitoring tanasi → AccessControl hodisalari ro‘yxati + qurilma IP.
 */
export function parseHikvisionHttpPayload(buffer, contentType) {
  const text = extractXmlPayload(buffer, contentType).trim();
  const out = { deviceIp: "", events: [] };

  if (!text) return out;

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const j = JSON.parse(text);
      const root = Array.isArray(j) ? j[0] : j;
      out.deviceIp =
        root?.ipAddress ||
        root?.deviceIP ||
        root?.IpAddress ||
        root?.AccessControlEvent?.ipAddress ||
        "";
      const ac = root?.AccessControlEvent || root?.accessControlEvent || root;
      if (ac && typeof ac === "object") {
        const picRaw =
          ac.picture ??
          ac.Picture ??
          ac.SNAPPicture ??
          ac.snapPicture ??
          ac.faceSnap ??
          ac.pictureData;
        const picNorm = picRaw != null ? normalizeEventSnapshot(picRaw) : "";
        const pathRaw =
          ac.pictureURL ??
          ac.PictureURL ??
          ac.pictureUrl ??
          ac.PictureUrl ??
          ac.snapPictureURL ??
          ac.SnapPictureURL;
        const pathNorm = pathRaw != null ? String(pathRaw).trim() : "";
        const ev = {
          employeeNoString: ac.employeeNoString ?? ac.employeeNo,
          employeeNo: ac.employeeNo,
          cardNo: ac.cardNo,
          time: ac.time ?? ac.dateTime ?? root?.dateTime,
          major: ac.major ?? root?.major,
          minor: ac.minor ?? root?.minor,
        };
        const displayName = personNameFromAccessControl(ac);
        if (displayName) ev.name = displayName;
        const hintKeys = [
          "attendanceState",
          "AttendanceState",
          "accessType",
          "AccessType",
          "direction",
          "eventType",
          "subEventType",
          "currentEventType",
          "accessChannel",
          "label",
        ];
        for (const k of hintKeys) {
          if (ac[k] != null && String(ac[k]).trim()) ev[k] = String(ac[k]).trim();
        }
        if (picNorm) ev.picture = picNorm;
        if (pathNorm) {
          if (/^https?:\/\//i.test(pathNorm)) {
            try {
              ev.pictureURL = cleanTerminalImagePath(new URL(pathNorm).pathname);
            } catch {
              /* ignore */
            }
          } else if (pathNorm.startsWith("/") || /LOCALS/i.test(pathNorm)) {
            ev.pictureURL = cleanTerminalImagePath(pathNorm);
          }
        }
        out.events.push(ev);
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  out.deviceIp = xmlFirstTagValue(text, "ipAddress") || xmlFirstTagValue(text, "IPAddress");

  const pushFromBlock = (block, rootTime) => {
    const pic = extractPictureFromAccessControlXml(block);
    const picPath = extractPicturePathFromXmlBlock(block);
    const displayName = personNameFromXmlBlock(block);
    const ev = {
      employeeNoString:
        xmlFirstTagValue(block, "employeeNoString") ||
        xmlFirstTagValue(block, "employeeNo") ||
        xmlFirstTagValue(block, "cardNo"),
      employeeNo: xmlFirstTagValue(block, "employeeNo"),
      cardNo: xmlFirstTagValue(block, "cardNo"),
      time:
        xmlFirstTagValue(block, "time") ||
        xmlFirstTagValue(block, "dateTime") ||
        rootTime ||
        xmlFirstTagValue(text, "dateTime"),
      major: xmlFirstTagValue(block, "major") || xmlFirstTagValue(text, "major"),
      minor: xmlFirstTagValue(block, "minor") || xmlFirstTagValue(text, "minor"),
      picture: pic || undefined,
      pictureURL: picPath || undefined,
    };
    if (displayName) ev.name = displayName;
    attachXmlAccessHints(block, ev);
    if (ev.employeeNoString || ev.employeeNo || ev.cardNo || ev.name) {
      if (!ev.employeeNoString) ev.employeeNoString = ev.employeeNo || ev.cardNo || "";
      out.events.push(ev);
    }
  };

  const rootDt = xmlFirstTagValue(text, "dateTime");
  const multiRe = /<AccessControlEvent[^>]*>([\s\S]*?)<\/AccessControlEvent>/gi;
  let mm;
  let anyMulti = false;
  while ((mm = multiRe.exec(text)) !== null) {
    anyMulti = true;
    pushFromBlock(mm[1], rootDt);
  }
  if (anyMulti) return out;

  const acBlock =
    xmlTagInner(text, "AccessControlEvent") ||
    xmlTagInner(text, "AccessControllerEvent") ||
    xmlTagInner(text, "AcsEvent");

  pushFromBlock(acBlock || text, rootDt);

  return out;
}

async function findTerminalRow(pool, deviceIpNorm, clientIpNorm, preferredTerminalId, directionHint) {
  const tid = preferredTerminalId != null ? Number.parseInt(String(preferredTerminalId), 10) : NaN;
  if (Number.isFinite(tid)) {
    const { rows: one } = await pool.query(
      `SELECT id, admin_id, terminal_type, ip_address, login, password FROM terminals WHERE id = $1`,
      [tid]
    );
    if (one[0]) return one[0];
  }

  const { rows } = await pool.query(
    `SELECT id, admin_id, terminal_type, ip_address, login, password FROM terminals ORDER BY id ASC`
  );

  const collect = (ip) => {
    const n = normalizeDeviceHost(ip);
    if (!n) return [];
    return rows.filter((row) => normalizeDeviceHost(row.ip_address) === n);
  };

  let matches = collect(deviceIpNorm);
  if (matches.length === 0) matches = collect(clientIpNorm);

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  if (directionHint === "out") {
    const c = matches.find((r) => isCheckoutTerminalType(r.terminal_type));
    if (c) return c;
  }
  if (directionHint === "in") {
    const k = matches.find((r) => !isCheckoutTerminalType(r.terminal_type));
    if (k) return k;
  }

  console.warn(
    `[hikvision http] ${matches.length} terminal bir xil IP maslahati; URL ga ?terminalId=<id> qo'shing (masalan monitoring sozlamasida).`
  );
  return matches[0];
}

/**
 * Terminal sozlamalari: POST http://HOST:8000/api/hikvision/event
 */
export async function handleHikvisionHttpEvent(req, pool) {
  const secret = process.env.HIKVISION_HTTP_SECRET;
  if (secret) {
    const q = req.query?.secret ?? req.headers["x-hikvision-secret"];
    if (String(q || "") !== String(secret)) {
      return { status: 401, body: "Unauthorized" };
    }
  }

  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");
  const ct = req.get("content-type") || "";
  const parsed = parseHikvisionHttpPayload(buf, ct);
  const multiPic = firstJpegDataUrlFromMultipart(buf, ct);
  if (multiPic) {
    for (const ev of parsed.events) {
      if (!ev.picture) ev.picture = multiPic;
      break;
    }
  }
  const clientIp = getClientIp(req);
  const deviceIp = parsed.deviceIp || "";

  const terminalIdParam = req.query?.terminalId ?? req.query?.terminal ?? "";

  let applied = 0;
  let lastTerminalId = null;
  for (const ev of parsed.events) {
    const directionHint = directionHintFromEvents([ev]);
    const terminalRow = await findTerminalRow(pool, deviceIp, clientIp, terminalIdParam, directionHint);
    if (!terminalRow) {
      console.warn(
        `[hikvision http] Terminal topilmadi (qurilma IP: "${deviceIp || "—"}", ulanish IP: "${clientIp || "—"}")`
      );
      continue;
    }
    lastTerminalId = terminalRow.id;
    const ok = await applyTerminalEvent(pool, terminalRow, ev, emitAttendanceBroadcast);
    if (ok) applied += 1;
  }

  if (applied > 0 && lastTerminalId != null) {
    console.log(`[hikvision http] qayta ishlangan hodisalar: ${applied} (oxirgi terminal_id=${lastTerminalId})`);
  }

  return { status: 200, body: "OK" };
}
