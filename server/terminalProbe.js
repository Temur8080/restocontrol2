import {
  normalizeTerminalBaseUrl,
  fetchHikvisionUsers,
  fetchHikvisionEvents,
  getWithDigest,
  probeUserInfoRecordApi,
  DEFAULT_TIMEOUT_MS,
} from "./terminalHikvision.js";

/** 192.168.x, 10.x, 172.16–31, 127.x — server odatda bulutdan bu manzillarga yeta olmaydi. */
export function isPrivateLanHostname(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^::ffff:/i, "");
  if (!h || h === "localhost") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function deviceInfoLabel(json, textPreview) {
  if (json?.deviceName && String(json.deviceName).trim()) return String(json.deviceName).trim();
  if (json?.DeviceInfo) {
    const d = json.DeviceInfo;
    const parts = [d.deviceName, d.model, d.serialNumber, d.deviceID, d.macAddress].filter(
      (x) => x != null && String(x).trim() !== ""
    );
    if (parts.length) return parts.map((x) => String(x).trim()).join(" · ");
  }
  const raw = String(textPreview || "");
  const dm = raw.match(/<deviceName[^>]*>([^<]+)/i);
  if (dm) return dm[1].trim();
  const mm = raw.match(/<model[^>]*>([^<]+)/i);
  if (mm) return mm[1].trim();
  return "";
}

function systemTimeHint(json) {
  if (!json) return "";
  const t = json.Time || json.time || json;
  const local = t.localTime ?? t.LocalTime ?? t.utcTime ?? t.UTCtime;
  return local != null ? String(local).trim() : "";
}

/**
 * Terminal bilan chuqur aloqa: System/deviceInfo, vaqt, AC capabilities,
 * UserInfo/Search (sahifalash bilan), birinchi foydalanuvchi uchun UserInfo/Record,
 * AcsEvent.
 */
export async function probeHikvisionTerminal({
  ipAddress,
  login,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const norm = normalizeTerminalBaseUrl(ipAddress);
  if (norm.error) {
    return {
      ok: false,
      error: norm.error,
      baseUrl: null,
      steps: [],
      optionalFailed: false,
    };
  }

  const { baseUrl } = norm;
  const steps = [];
  const t = timeoutMs;

  let di = await getWithDigest(baseUrl, "/ISAPI/System/deviceInfo?format=json", login, password, t);
  if (!di.httpOk || di.status === 404) {
    di = await getWithDigest(baseUrl, "/ISAPI/System/deviceInfo", login, password, t);
  }
  const diLabel = deviceInfoLabel(di.json, di.textPreview);
  const diOk = di.httpOk && di.status === 200 && (!!di.json || (di.textPreview && di.textPreview.length > 40));
  steps.push({
    id: "deviceInfo",
    optional: true,
    ok: diOk,
    httpStatus: di.status,
    hint: diOk ? diLabel || undefined : di.networkError || di.textPreview?.slice(0, 160) || `HTTP ${di.status}`,
  });

  const st = await getWithDigest(baseUrl, "/ISAPI/System/time?format=json", login, password, t);
  if (!st.httpOk || st.status === 404) {
    const st2 = await getWithDigest(baseUrl, "/ISAPI/System/time", login, password, t);
    const tHint = systemTimeHint(st2.json) || systemTimeHint(st.json);
    const ok = st2.httpOk && st2.status === 200;
    steps.push({
      id: "systemTime",
      optional: true,
      ok,
      httpStatus: st2.status || st.status,
      hint: ok ? tHint || undefined : st2.networkError || st.networkError || st2.textPreview?.slice(0, 100),
    });
  } else {
    const tHint = systemTimeHint(st.json);
    steps.push({
      id: "systemTime",
      optional: true,
      ok: true,
      httpStatus: st.status,
      hint: tHint || undefined,
    });
  }

  const cap = await getWithDigest(baseUrl, "/ISAPI/AccessControl/capabilities?format=json", login, password, t);
  steps.push({
    id: "accessControlCap",
    optional: true,
    ok: cap.httpOk && cap.status === 200,
    httpStatus: cap.status,
    hint:
      cap.networkError ||
      (cap.json && typeof cap.json === "object" ? "capabilities OK" : cap.textPreview?.slice(0, 80)),
  });

  const userFetch = await fetchHikvisionUsers(baseUrl, login, password, t);
  const uMeta = userFetch.meta || {};
  steps.push({
    id: "userInfoSearch",
    optional: false,
    ok: userFetch.ok,
    httpStatus: userFetch.ok ? 200 : 0,
    userCount: userFetch.users?.length ?? 0,
    userScanned: uMeta.listedRaw ?? userFetch.users?.length ?? 0,
    searchPages: uMeta.pages ?? 0,
    recordEnriched: uMeta.enriched ?? 0,
    hint: userFetch.error,
  });

  const sampleKey = userFetch.ok
    ? userFetch.users?.find((u) => u?.employeeNo && String(u.employeeNo).trim())?.employeeNo
    : null;
  if (sampleKey) {
    const rec = await probeUserInfoRecordApi(baseUrl, login, password, sampleKey, Math.min(12000, t));
    steps.push({
      id: "userInfoRecord",
      optional: true,
      ok: rec.skipped ? true : rec.ok,
      httpStatus: rec.ok ? 200 : 0,
      hint: rec.skipped ? undefined : rec.detail,
    });
  }

  const evFetch = await fetchHikvisionEvents(
    baseUrl,
    login,
    password,
    "2020-01-01T00:00:00+05:00",
    "2030-12-31T23:59:59+05:00",
    t
  );
  steps.push({
    id: "acsEvent",
    optional: false,
    ok: evFetch.ok,
    httpStatus: evFetch.ok ? 200 : 0,
    eventCount: evFetch.events?.length ?? 0,
    hint: evFetch.error,
  });

  const coreOk = steps.filter((s) => !s.optional).every((s) => s.ok);
  const optionalFailed = steps.some((s) => s.optional && !s.ok);
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^::ffff:/i, "");
  } catch {
    /* ignore */
  }

  let contextHint = null;
  if (!coreOk && hostname && isPrivateLanHostname(hostname)) {
    contextHint =
      "Bu manzil ichki tarmoq (masalan 192.168.x). Agar RestoControl serveri Internetdagi VPS bo‘lsa, u yerdan ISAPI tekshiruvi (UserInfo / AcsEvent) ishlamaydi — «fetch failed». Yechim: VPN, serverni ofis LAN ida ishlatish, yoki router orqali qurilmaga ochiq yo‘l. Hodisalar bulutga Hikvision «HTTP monitoring» POST orqali kelishi alohida jarayon.";
  }

  return {
    ok: coreOk,
    baseUrl,
    steps,
    error: coreOk ? null : "Asosiy ISAPI qadamlari (UserInfo qidiruv yoki AcsEvent) muvaffaqiyatsiz",
    contextHint,
    optionalFailed: coreOk && optionalFailed,
  };
}
