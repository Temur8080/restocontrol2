import { DigestClient } from "digest-fetch";

export const DEFAULT_TIMEOUT_MS = 15000;

export const USER_SEARCH_PATH = "/ISAPI/AccessControl/UserInfo/Search?format=json";
export const ACS_EVENT_PATH = "/ISAPI/AccessControl/AcsEvent?format=json";

export function normalizeTerminalBaseUrl(ipOrUrl) {
  const raw = String(ipOrUrl || "").trim();
  if (!raw) return { error: "Bo'sh manzil" };
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const u = new URL(withProto);
    if (u.username || u.password) {
      return { error: "Login va parol alohida maydonlarda bo'lsin" };
    }
    return { baseUrl: `${u.protocol}//${u.host}` };
  } catch {
    return { error: "Noto'g'ri manzil" };
  }
}

export function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export async function postJsonDigest(baseUrl, path, username, password, body, timeoutMs) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const client = new DigestClient(String(username || ""), String(password || ""));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await client.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      httpOk: res.ok,
      status: res.status,
      json,
      textPreview: text ? text.slice(0, 400) : "",
    };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return {
      httpOk: false,
      status: 0,
      json: null,
      textPreview: "",
      networkError: aborted ? "Vaqt tugadi (timeout)" : String(e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHikvisionUsers(baseUrl, login, password, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const payload = {
    UserInfoSearchCond: {
      searchID: "1",
      searchResultPosition: 0,
      maxResults: 2000,
    },
  };
  const res = await postJsonDigest(baseUrl, USER_SEARCH_PATH, login, password, payload, timeoutMs);
  if (!res.httpOk || res.status !== 200 || !res.json?.UserInfoSearch) {
    return { ok: false, users: [], error: res.networkError || res.textPreview || `HTTP ${res.status}` };
  }
  const raw = asArray(res.json.UserInfoSearch.UserInfo);
  const users = [];
  for (const u of raw) {
    const no =
      u?.employeeNoString != null && String(u.employeeNoString).trim() !== ""
        ? String(u.employeeNoString).trim()
        : u?.employeeNo != null
          ? String(u.employeeNo).trim()
          : u?.cardNo != null
            ? String(u.cardNo).trim()
            : "";
    const name =
      u?.name != null && String(u.name).trim() !== ""
        ? String(u.name).trim()
        : u?.userName != null && String(u.userName).trim() !== ""
          ? String(u.userName).trim()
          : "";
    if (!name) continue;
    users.push({ employeeNo: no || "", name });
  }
  return { ok: true, users, error: null };
}

export async function fetchHikvisionEvents(
  baseUrl,
  login,
  password,
  startTime,
  endTime,
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const payload = {
    AcsEventCond: {
      searchID: `sync-${Date.now()}`,
      searchResultPosition: 0,
      maxResults: 200,
      major: 0,
      minor: 0,
      startTime: startTime || "2020-01-01T00:00:00+05:00",
      endTime: endTime || "2035-12-31T23:59:59+05:00",
    },
  };
  const res = await postJsonDigest(baseUrl, ACS_EVENT_PATH, login, password, payload, timeoutMs);
  if (!res.httpOk || res.status !== 200 || !res.json?.AcsEvent) {
    return { ok: false, events: [], error: res.networkError || res.textPreview || `HTTP ${res.status}` };
  }
  const raw = asArray(res.json.AcsEvent.InfoList);
  return { ok: true, events: raw, error: null };
}

export function eventEmployeeKey(ev) {
  if (!ev || typeof ev !== "object") return "";
  const a = ev.employeeNoString ?? ev.employeeNo ?? ev.cardNo;
  if (a == null) return "";
  return String(a).trim();
}

/** Hikvision JSON/XML maydonlari — HTTP ingest va eventEmployeeName uchun umumiy. */
export const HIKVISION_PERSON_NAME_KEYS = [
  "name",
  "Name",
  "employeeName",
  "EmployeeName",
  "personName",
  "PersonName",
  "userName",
  "UserName",
];

/** Hodisa tanasidan ko'rinadigan ism (keldi-ketdi bazada shu bilan bog'lanadi). */
export function eventEmployeeName(ev) {
  if (!ev || typeof ev !== "object") return "";
  for (const k of HIKVISION_PERSON_NAME_KEYS) {
    const v = ev[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

export function normalizeEmployeeEventName(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function eventTimeIso(ev) {
  const t = ev?.time ?? ev?.Time;
  return t != null ? String(t).trim() : "";
}

export function eventDedupeKey(terminalId, ev) {
  const time = eventTimeIso(ev);
  const nameNorm = normalizeEmployeeEventName(eventEmployeeName(ev));
  const major = ev?.major ?? ev?.Major ?? "";
  const minor = ev?.minor ?? ev?.Minor ?? "";
  const serial = ev?.serialNo ?? ev?.SerialNo ?? "";
  if (serial !== "" && serial != null) return `${terminalId}|${serial}`;
  const identity = nameNorm || eventEmployeeKey(ev);
  return `${terminalId}|${time}|${identity}|${major}|${minor}`;
}

/** Qurilma qatoridagi vaqtdan sana + HH:MM (qurilma yozgan vaqt zonasi bo‘yicha). */
export function deviceEventLocalDateTime(isoTimeStr) {
  const s = String(isoTimeStr || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (m) return { date: m[1], time: `${m[2]}:${m[3]}` };
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return { date: `${y}-${mo}-${day}`, time: `${hh}:${mm}` };
}

/** ISO vaqtni berilgan UTC offset (soat) bo'yicha YYYY-MM-DD + HH:MM ga aylantiradi. */
export function deviceEventDateTimeWithTargetOffset(isoTimeStr, targetOffsetHours = 5) {
  const s = String(isoTimeStr || "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return deviceEventLocalDateTime(s);
  const off = Number.isFinite(Number(targetOffsetHours)) ? Number(targetOffsetHours) : 5;
  const offsetMs = Math.trunc(off * 60 * 60 * 1000);
  const shifted = new Date(d.getTime() + offsetMs);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return { date: `${y}-${mo}-${day}`, time: `${hh}:${mm}` };
}
