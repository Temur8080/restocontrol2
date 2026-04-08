import { applyTerminalEvent } from "./terminalIntegration.js";
import { emitAttendanceBroadcast } from "./attendanceBroadcastHub.js";
import { normalizeEventSnapshot } from "./eventSnapshot.js";
import { cleanTerminalImagePath } from "./hikvisionImageDownload.js";
import { directionHintFromEvents, isCheckoutTerminalType } from "./hikvisionAccessDirection.js";
import { HIKVISION_PERSON_NAME_KEYS } from "./terminalHikvision.js";
import { getWebhookClientIp, normalizeDeviceHost } from "./webhookGuards.js";

/** Hikvision «HTTP monitoring» yurak urishi — tahlil qilmay tez 200 OK. */
function bufferLooksLikeHeartbeat(buf) {
  const n = Math.min(buf.length, 65536);
  if (n === 0) return false;
  const s = buf.subarray(0, n).toString("utf8");
  if (!/heartBeat|heartbeat/i.test(s)) return false;
  if (/["']eventType["']\s*:\s*["']heartBeat["']/i.test(s)) return true;
  if (/eventType"\s*:\s*"heartBeat"/i.test(s)) return true;
  if (/["']eventDescription["']\s*:\s*["']heartBeat["']/i.test(s)) return true;
  if (/["']heartBeat["']\s*:\s*true/i.test(s)) return true;
  if (/heartBeat\s*[=:]\s*true/i.test(s)) return true;
  if (/"active"\s*:\s*1/i.test(s) && /heartbeat/i.test(s)) return true;
  return false;
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

/** multipart qism: sarlavha / tana chegarasi (\r\n yoki ba'zan faqat \n). */
function mimePartHeaderBodySplit(part) {
  if (!Buffer.isBuffer(part) || part.length === 0) return null;
  const crlf = part.indexOf(Buffer.from("\r\n\r\n"));
  if (crlf >= 0) return { headerLen: crlf, bodyStart: crlf + 4 };
  const lf = part.indexOf(Buffer.from("\n\n"));
  if (lf >= 0) return { headerLen: lf, bodyStart: lf + 2 };

  /* Hikvision ba'zan ikki bo'sh qator o'rniga bitta CRLF/LF qo'yadi (noto'g'ri multipart). */
  const scanLen = Math.min(part.length, 65536);
  const s = part.toString("latin1", 0, scanLen);
  const m1 = s.match(/\r\n(?=(?:\s|\u00a0|\ufeff)*[\[{])/m);
  const m2 =
    !m1 && s.length > 0
      ? s.match(/\n(?=(?:\s|\u00a0|\ufeff)*[\[{])/m)
      : null;
  const m = m1 || m2;
  if (m && m.index !== undefined) {
    return { headerLen: m.index, bodyStart: m.index + m[0].length };
  }
  return null;
}

/**
 * JSON ajratish: ba'zi Hikvision qurilmalar qism Content-Length noto‘g‘ri beradi,
 * tana oxirida boundary oldidan ortiqcha bayt bo‘lishi mumkin — qattiq kesish `}` yo‘qoladi.
 */
function tryParseJsonLenient(raw) {
  let t = String(raw ?? "").trim();
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1).trim();
  if (!t) return null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let p = tryParse(t);
  if (p != null) return p;
  const iObj = t.indexOf("{");
  const iArr = t.indexOf("[");
  const preferArr = iArr >= 0 && (iObj < 0 || iArr < iObj);
  if (preferArr && iArr >= 0) {
    let j = t.lastIndexOf("]");
    while (j > iArr) {
      p = tryParse(t.slice(iArr, j + 1));
      if (p != null) return p;
      j = t.lastIndexOf("]", j - 1);
    }
  }
  if (iObj >= 0) {
    let j = t.lastIndexOf("}");
    while (j > iObj) {
      p = tryParse(t.slice(iObj, j + 1));
      if (p != null) return p;
      j = t.lastIndexOf("}", j - 1);
    }
  }
  return null;
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
    const split = mimePartHeaderBodySplit(part);
    if (split && split.headerLen >= 0) {
      const headers = part.subarray(0, split.headerLen).toString("latin1").toLowerCase();
      const body = part.subarray(split.bodyStart);
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

/**
 * multipart/form-data ichidan Content-Disposition name= bo‘yicha qism tanasini ajratadi.
 */
function extractMultipartPartByFieldName(buffer, contentType, fieldName) {
  const want = String(fieldName || "").toLowerCase();
  if (!want || !Buffer.isBuffer(buffer)) return null;
  const ct = String(contentType || "");
  const bm = ct.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
  if (!bm) return null;
  const boundaryStr = bm[1].trim().replace(/^["']|["']$/g, "");
  const delimiter = Buffer.from(`--${boundaryStr}`);
  let offset = 0;
  for (;;) {
    const idx = buffer.indexOf(delimiter, offset);
    if (idx < 0) break;
    let partBegin = idx + delimiter.length;
    if (partBegin + 1 < buffer.length && buffer[partBegin] === 0x2d && buffer[partBegin + 1] === 0x2d) {
      break;
    }
    if (partBegin + 1 < buffer.length && buffer[partBegin] === 0x0d && buffer[partBegin + 1] === 0x0a) {
      partBegin += 2;
    } else if (partBegin < buffer.length && buffer[partBegin] === 0x0a) {
      partBegin += 1;
    }
    const nextBoundary = buffer.indexOf(delimiter, partBegin);
    const partEnd = nextBoundary < 0 ? buffer.length : nextBoundary;
    const part = buffer.subarray(partBegin, partEnd);
    const split = mimePartHeaderBodySplit(part);
    if (!split) {
      offset = idx + delimiter.length;
      continue;
    }
    const headers = part.subarray(0, split.headerLen).toString("latin1");
    const nameMatch = headers.match(/name\s*=\s*"([^"]+)"/i) || headers.match(/name\s*=\s*([^;\r\n]+)/i);
    const fn = nameMatch ? String(nameMatch[1] || nameMatch[2]).trim().replace(/^"|"$/g, "") : "";
    if (fn.toLowerCase() !== want) {
      offset = idx + delimiter.length;
      continue;
    }
    let body = part.subarray(split.bodyStart);
    while (
      body.length >= 2 &&
      body[body.length - 2] === 0x0d &&
      body[body.length - 1] === 0x0a
    ) {
      body = body.subarray(0, body.length - 2);
    }
    while (body.length >= 1 && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 1);
    }
    return body.length > 0 ? body : null;
  }
  return null;
}

/** multipart/form-data ichidagi barcha qismlar (name + tana). */
function listMultipartParts(buffer, contentType) {
  const ct = String(contentType || "");
  const bm = ct.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
  if (!bm || !Buffer.isBuffer(buffer)) return [];
  const boundaryStr = bm[1].trim().replace(/^["']|["']$/g, "");
  const delimiter = Buffer.from(`--${boundaryStr}`);
  const parts = [];
  let offset = 0;
  for (;;) {
    const idx = buffer.indexOf(delimiter, offset);
    if (idx < 0) break;
    let partBegin = idx + delimiter.length;
    if (partBegin + 1 < buffer.length && buffer[partBegin] === 0x2d && buffer[partBegin + 1] === 0x2d) {
      break;
    }
    if (partBegin + 1 < buffer.length && buffer[partBegin] === 0x0d && buffer[partBegin + 1] === 0x0a) {
      partBegin += 2;
    } else if (partBegin < buffer.length && buffer[partBegin] === 0x0a) {
      partBegin += 1;
    }
    const nextBoundary = buffer.indexOf(delimiter, partBegin);
    const partEnd = nextBoundary < 0 ? buffer.length : nextBoundary;
    const part = buffer.subarray(partBegin, partEnd);
    const split = mimePartHeaderBodySplit(part);
    if (!split) {
      offset = idx + delimiter.length;
      continue;
    }
    const headers = part.subarray(0, split.headerLen).toString("latin1");
    const nameMatch = headers.match(/name\s*=\s*"([^"]+)"/i) || headers.match(/name\s*=\s*([^;\r\n]+)/i);
    const fn = nameMatch ? String(nameMatch[1] || nameMatch[2]).trim().replace(/^"|"$/g, "") : "";
    let body = part.subarray(split.bodyStart);
    while (
      body.length >= 2 &&
      body[body.length - 2] === 0x0d &&
      body[body.length - 1] === 0x0a
    ) {
      body = body.subarray(0, body.length - 2);
    }
    while (body.length >= 1 && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 1);
    }
    if (body.length > 0) parts.push({ name: fn, body });
    offset = idx + delimiter.length;
  }
  return parts;
}

/** JPEG qismi — UTF-8 tekshiruvdan tashlab ketish. */
function looksLikeBinaryImageBody(body) {
  return body.length > 500 && body[0] === 0xff && body[1] === 0xd8;
}

/** Multipart qism: fayl/rasm (matn emas) — hodim-nazorati «Files: N» uchun. */
function looksLikeBinaryAttachmentBody(body, headersLatin1) {
  if (!body || body.length === 0) return false;
  const h = String(headersLatin1 || "");
  if (/filename\s*=/i.test(h)) return true;
  if (looksLikeBinaryImageBody(body)) return true;
  const ctPart = h.match(/Content-Type:\s*([^\r\n]+)/i);
  const ctv = ctPart ? String(ctPart[1]).toLowerCase() : "";
  if ((ctv.includes("image/") || ctv.includes("application/octet-stream")) && body.length > 80) return true;
  if (body.length > 400 && body.includes(0)) return true;
  return false;
}

/**
 * Debug: multipart `name=` lar, fayl soni, matn qismlardan yig‘ilgan obyekt (boshqa loyihadagi Body sample ga o‘xshash).
 * @returns {{ keys: string[], fileCount: number, pseudoBody: Record<string, string> } | null}
 */
function multipartDebugInspect(buffer, contentType) {
  const ct = String(contentType || "");
  const bm = ct.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
  if (!bm || !Buffer.isBuffer(buffer)) return null;
  const boundaryStr = bm[1].trim().replace(/^["']|["']$/g, "");
  const delimiter = Buffer.from(`--${boundaryStr}`);
  const keys = [];
  let fileCount = 0;
  /** @type {Record<string, string>} */
  const pseudoBody = {};
  let offset = 0;
  for (;;) {
    const idx = buffer.indexOf(delimiter, offset);
    if (idx < 0) break;
    let partBegin = idx + delimiter.length;
    if (partBegin + 1 < buffer.length && buffer[partBegin] === 0x2d && buffer[partBegin + 1] === 0x2d) {
      break;
    }
    if (partBegin + 1 < buffer.length && buffer[partBegin] === 0x0d && buffer[partBegin + 1] === 0x0a) {
      partBegin += 2;
    } else if (partBegin < buffer.length && buffer[partBegin] === 0x0a) {
      partBegin += 1;
    }
    const nextBoundary = buffer.indexOf(delimiter, partBegin);
    const partEnd = nextBoundary < 0 ? buffer.length : nextBoundary;
    const part = buffer.subarray(partBegin, partEnd);
    const split = mimePartHeaderBodySplit(part);
    if (!split) {
      offset = idx + delimiter.length;
      continue;
    }
    const headers = part.subarray(0, split.headerLen).toString("latin1");
    const nameMatch = headers.match(/name\s*=\s*"([^"]+)"/i) || headers.match(/name\s*=\s*([^;\r\n]+)/i);
    const fn = nameMatch ? String(nameMatch[1] || nameMatch[2]).trim().replace(/^"|"$/g, "") : "";
    let body = part.subarray(split.bodyStart);
    while (
      body.length >= 2 &&
      body[body.length - 2] === 0x0d &&
      body[body.length - 1] === 0x0a
    ) {
      body = body.subarray(0, body.length - 2);
    }
    while (body.length >= 1 && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 1);
    }
    const isFile = looksLikeBinaryAttachmentBody(body, headers);
    if (isFile) fileCount += 1;
    else if (fn && body.length > 0) {
      try {
        pseudoBody[fn] = body.toString("utf8");
      } catch {
        pseudoBody[fn] = "[binary]";
      }
    }
    if (fn) keys.push(fn);
    offset = idx + delimiter.length;
  }
  return { keys, fileCount, pseudoBody };
}

/**
 * Hodim-nazorati uslubidagi batafsil log (.env: HIKVISION_HTTP_DEBUG=1).
 */
function logHikvisionVerboseIncoming(req, buf, ct, clientIp) {
  const line = (s) => console.log(`[hikvision http] ${s}`);
  line("==========================================");
  line("HIKVISION EVENT KELDI");
  line("==========================================");
  const headers = {
    host: req.get("host") || "",
    "x-real-ip": req.get("x-real-ip") || "",
    "x-forwarded-for": req.get("x-forwarded-for") || "",
    "x-forwarded-proto": req.get("x-forwarded-proto") || "",
    connection: req.get("connection") || "",
    "content-length": req.get("content-length") || "",
    accept: req.get("accept") || "",
    "content-type": ct,
  };
  line(`Headers: ${JSON.stringify(headers, null, 2)}`);
  line(`Method: ${req.method || ""}`);
  line(`URL: ${req.originalUrl || req.url || ""}`);
  line(`Content-Type: ${ct || ""}`);

  if (/multipart\/form-data/i.test(ct)) {
    const ins = multipartDebugInspect(buf, ct);
    if (ins) {
      line("Body type: object");
      line(`Body keys: ${JSON.stringify(ins.keys)}`);
      line(`Files: ${ins.fileCount}`);
      const sample = JSON.stringify(ins.pseudoBody);
      const max = 4000;
      line(`Body sample: ${sample.length > max ? `${sample.slice(0, max)}…` : sample}`);
    } else {
      line("Body type: buffer (multipart boundary topilmadi)");
      const t = buf.toString("utf8", 0, Math.min(buf.length, 1200)).replace(/\s+/g, " ").trim();
      line(`Body sample: ${t}`);
    }
  } else {
    line("Body type: buffer");
    const t =
      buf.length === 0
        ? "(bo‘sh)"
        : buf.toString("utf8", 0, Math.min(buf.length, 2500)).replace(/\s+/g, " ").trim();
    line(`Body sample: ${t}`);
  }
  line("==========================================");
}

/**
 * Bitta matndan JSON yoki XML Hikvision hodisasini ajratib `out` ga qo‘shadi.
 * @returns {boolean} — biror hodisa qo‘shildi yoki deviceIp topildi
 */
function tryProcessPayloadString(txt, out) {
  const s = String(txt || "").trim();
  if (!s) return false;
  const evBefore = out.events.length;
  const dipBefore = out.deviceIp;

  const parsed = tryParseJsonLenient(s);
  if (parsed) {
    try {
      appendEventsFromHikvisionJson(parsed, out);
      return out.events.length > evBefore || (!!out.deviceIp && out.deviceIp !== dipBefore);
    } catch {
      return false;
    }
  }

  if (
    s.includes("<") &&
    (/AccessControl/i.test(s) || /EventNotification/i.test(s) || /<\?xml/i.test(s))
  ) {
    const nested = parseHikvisionHttpPayload(Buffer.from(s, "utf8"), "application/xml");
    if (nested.events.length > 0 || nested.deviceIp) {
      if (nested.deviceIp) out.deviceIp = nested.deviceIp || out.deviceIp;
      out.events.push(...nested.events);
      return true;
    }
  }
  return false;
}

/** Hikvision: JSON ichida AccessControl / AccessController (Controller!) yozilishlari. */
function resolveHikvisionAcSubobject(root) {
  if (!root || typeof root !== "object") return null;
  const raw =
    root.AccessControlEvent ??
    root.accessControlEvent ??
    root.AccessControllerEvent ??
    root.accessControllerEvent;
  if (raw == null) return root;
  if (typeof raw === "string") {
    const p = tryParseJsonLenient(raw);
    if (p && typeof p === "object") {
      // Ba'zi qurilmalarda field ichidagi string yana wrapper obyekt bo'ladi.
      // Shu holatda ichki AccessControl(ler) obyektigacha tushamiz.
      const nested = resolveHikvisionAcSubobject(p);
      return nested && typeof nested === "object" ? nested : p;
    }
    return root;
  }
  if (typeof raw === "object") return raw;
  return root;
}

/** Hikvision AccessControl JSON obyektidan hodisa qo‘shadi (HTTP multipart ichidagi JSON). */
function appendEventsFromHikvisionJson(j, out) {
  const root = Array.isArray(j) ? j[0] : j;
  if (!root || typeof root !== "object") return;

  const rootEt = String(root.eventType ?? root.EventType ?? "").trim();
  const rootDesc = String(root.eventDescription ?? root.EventDescription ?? "").trim();
  if (/heartBeat/i.test(rootEt) || /heartBeat/i.test(rootDesc)) return;

  const dip =
    root.ipAddress ||
    root.deviceIP ||
    root.IpAddress ||
    root.AccessControlEvent?.ipAddress ||
    root.AccessControllerEvent?.ipAddress ||
    "";
  if (dip && String(dip).trim()) {
    if (!out.deviceIp) out.deviceIp = String(dip).trim();
  }

  const ac = resolveHikvisionAcSubobject(root);
  if (!ac || typeof ac !== "object") return;

  const acEt = String(ac.eventType ?? ac.EventType ?? "").trim();
  const acDesc = String(ac.eventDescription ?? ac.EventDescription ?? "").trim();
  if (/heartBeat/i.test(acEt) || /heartBeat/i.test(acDesc)) return;

  const picRaw =
    ac.picture ?? ac.Picture ?? ac.SNAPPicture ?? ac.snapPicture ?? ac.faceSnap ?? ac.pictureData;
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
    major: ac.major ?? ac.majorEventType ?? root?.major ?? root?.majorEventType,
    minor: ac.minor ?? ac.subEventType ?? root?.minor ?? root?.subEventType,
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

  const hasPersonId =
    String(ev.employeeNoString ?? ev.employeeNo ?? ev.cardNo ?? "").trim() !== "";
  const hasName = String(ev.name ?? "").trim() !== "";
  if (!hasPersonId && !hasName && !picNorm) {
    /* Qurilma/controller JSON (faqat serialNo va h.k.) — XML yo‘lidagi kabi davomatga yuborilmaydi */
    return;
  }
  out.events.push(ev);
}

function personNameFromXmlBlock(block) {
  if (!block || typeof block !== "string") return "";
  for (const tag of HIKVISION_PERSON_NAME_KEYS) {
    let v = xmlFirstTagValue(block, tag);
    if (!v) v = xmlTagInner(block, tag);
    if (v != null && String(v).trim()) return String(v).trim();
  }
  const gn =
    xmlFirstTagValue(block, "givenName") ||
    xmlFirstTagValue(block, "GivenName") ||
    xmlFirstTagValue(block, "firstName") ||
    xmlFirstTagValue(block, "FirstName");
  const fn =
    xmlFirstTagValue(block, "familyName") ||
    xmlFirstTagValue(block, "FamilyName") ||
    xmlFirstTagValue(block, "lastName") ||
    xmlFirstTagValue(block, "LastName");
  const parts = [gn, fn].map((s) => String(s || "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
  return "";
}

function personNameFromAccessControl(ac) {
  if (!ac || typeof ac !== "object") return "";
  for (const k of HIKVISION_PERSON_NAME_KEYS) {
    const v = ac[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  const gn = ac.givenName ?? ac.GivenName ?? ac.firstName ?? ac.FirstName;
  const fn = ac.familyName ?? ac.FamilyName ?? ac.lastName ?? ac.LastName;
  const parts = [gn, fn].map((s) => String(s ?? "").trim()).filter(Boolean);
  if (parts.length) return parts.join(" ");
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
 * Hikvision HTTP monitoring tanasi → AccessControl hodisalari.
 * Qo‘llab-quvvatlanadi: to‘g‘ri XML, to‘g‘ri JSON, multipart/form-data (har qismda JSON yoki XML),
 * Content-Type: application/json | text/xml | application/xml | multipart/form-data.
 */
export function parseHikvisionHttpPayload(buffer, contentType) {
  const ct = String(contentType || "");
  const out = { deviceIp: "", events: [] };

  if (/multipart\/form-data/i.test(ct) && Buffer.isBuffer(buffer)) {
    const fieldNames = [
      "AccessControllerEvent",
      "AccessControlEvent",
      "EventNotificationAlert",
      "AcsEvent",
      "event",
    ];
    for (const fieldName of fieldNames) {
      const partBody = extractMultipartPartByFieldName(buffer, ct, fieldName);
      if (!partBody || partBody.length === 0) continue;
      if (tryProcessPayloadString(partBody.toString("utf8"), out)) return out;
    }
    for (const { body } of listMultipartParts(buffer, ct)) {
      if (looksLikeBinaryImageBody(body)) continue;
      if (tryProcessPayloadString(body.toString("utf8"), out)) return out;
    }
  }

  const text = Buffer.isBuffer(buffer) ? extractXmlPayload(buffer, contentType).trim() : String(buffer).trim();
  if (!text) return out;

  if (text.startsWith("{") || text.startsWith("[")) {
    const j = tryParseJsonLenient(text);
    if (j) {
      try {
        appendEventsFromHikvisionJson(j, out);
      } catch {
        /* ignore */
      }
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
      `SELECT id, admin_id, terminal_type, ip_address, login, password, filial FROM terminals WHERE id = $1`,
      [tid]
    );
    if (one[0]) return one[0];
  }

  const { rows } = await pool.query(
    `SELECT id, admin_id, terminal_type, ip_address, login, password, filial FROM terminals ORDER BY id ASC`
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
 * Terminal sozlamalari: POST https://DOMEN/api/hikvision/event (Nginx → 127.0.0.1:8000).
 * Maxsus holatda to‘g‘ridan-to‘g‘ri: POST http://HOST:8000/api/hikvision/event
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
  const clientIp = getWebhookClientIp(req);
  const debugHttp = String(process.env.HIKVISION_HTTP_DEBUG || "").trim() === "1";

  if (debugHttp) {
    logHikvisionVerboseIncoming(req, buf, ct, clientIp);
  }

  if (bufferLooksLikeHeartbeat(buf)) {
    if (debugHttp) {
      console.log(`[hikvision http] HeartBeat event o'tkazib yuborildi (${ct || "multipart/form-data"})`);
    }
    console.log(`[hikvision http] heartBeat → 200 OK (ip="${clientIp}", tana=${buf.length}b)`);
    return { status: 200, body: "OK" };
  }

  console.log(
    `[hikvision http] keldi: tana=${buf.length}b, ct="${String(ct).slice(0, 100)}", ip="${clientIp}"`
  );

  const parsed = parseHikvisionHttpPayload(buf, ct);
  const multiPic = firstJpegDataUrlFromMultipart(buf, ct);
  if (multiPic) {
    for (const ev of parsed.events) {
      if (!ev.picture) ev.picture = multiPic;
      break;
    }
  }
  const deviceIp = parsed.deviceIp || "";

  const terminalIdParam = req.query?.terminalId ?? req.query?.terminal ?? "";

  const nEv = parsed.events.length;
  console.log(
    `[hikvision http] qabul: hodisalar=${nEv}, deviceIp="${deviceIp || "—"}", ulanish_ip="${clientIp}"` +
      (terminalIdParam ? `, terminalId_param=${terminalIdParam}` : "")
  );

  if (debugHttp && nEv > 0) {
    const e0 = parsed.events[0];
    const snap = {
      employeeNoString: e0?.employeeNoString,
      employeeNo: e0?.employeeNo,
      cardNo: e0?.cardNo,
      name: e0?.name,
      time: e0?.time,
      major: e0?.major,
      minor: e0?.minor,
    };
    console.log(`[hikvision http] Tahlildan keyin 1-hodisa: ${JSON.stringify(snap)}`);
  }

  if (nEv === 0) {
    const ctShort = String(ct || "").slice(0, 120);
    const preview = buf.length === 0 ? "(bo‘sh tana)" : buf.slice(0, 200).toString("utf8").replace(/\s+/g, " ").trim();
    console.warn(
      `[hikvision http] tahlildan keyin 0 ta hodisa (Content-Type: ${ctShort || "—"}, tana ${buf.length} bayt). Boshlang‘ich: ${preview.slice(0, 160)}`
    );
  }

  let applied = 0;
  let lastTerminalId = null;
  for (const ev of parsed.events) {
    const directionHint = directionHintFromEvents([ev]);
    const terminalRow = await findTerminalRow(pool, deviceIp, clientIp, terminalIdParam, directionHint);
    if (!terminalRow) {
      console.warn(
        `[hikvision http] Terminal topilmadi — bazada ip_address="${deviceIp || clientIp || "—"}" yoki ?terminalId= mos kelishi kerak (qurilma_XML_ip="${deviceIp || "—"}", ulanish_ip="${clientIp || "—"}")`
      );
      continue;
    }
    lastTerminalId = terminalRow.id;
    const result = await applyTerminalEvent(pool, terminalRow, ev, emitAttendanceBroadcast);
    if (result.ok) {
      applied += 1;
    } else if (result.reason) {
      console.warn(`[hikvision http] hodisa saqlanmadi (terminal_id=${terminalRow.id}): ${result.reason}`);
    }
  }

  if (applied > 0 && lastTerminalId != null) {
    console.log(`[hikvision http] muvaffaq: ${applied} ta yozuv (oxirgi terminal_id=${lastTerminalId})`);
  } else if (nEv > 0 && applied === 0) {
    console.warn(
      `[hikvision http] ${nEv} ta hodisa keldi, lekin hech biri davomatga yozilmadi (yuqoridagi sabablarni ko‘ring)`
    );
  }

  return { status: 200, body: "OK" };
}
