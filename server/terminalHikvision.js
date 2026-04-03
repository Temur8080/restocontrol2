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

/** ISAPI GET (Digest) — System/deviceInfo, capabilities va boshqalar. */
export async function getWithDigest(baseUrl, path, username, password, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const client = new DigestClient(String(username || ""), String(password || ""));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await client.fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    const t = text ? text.trim() : "";
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        json = JSON.parse(t);
      } catch {
        json = null;
      }
    }
    return {
      httpOk: res.ok,
      status: res.status,
      json,
      textPreview: text ? text.slice(0, 600) : "",
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

const USER_RECORD_PATH = "/ISAPI/AccessControl/UserInfo/Record?format=json";
const USER_SEARCH_PAGE_SIZE = 300;
const USER_SEARCH_MAX_PAGES = 80;
const USER_RECORD_ENRICH_MAX = 100;

function numOfMatchesFromSearch(json) {
  const u = json?.UserInfoSearch;
  if (!u) return null;
  const n = u.numOfMatches ?? u.NumOfMatches ?? u.totalMatches ?? u.TotalMatches;
  if (n == null || n === "") return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

/** Hikvision UserInfo obyektidan ko‘rinadigan F.I.Sh (qurilmalar turlicha maydon yuboradi). */
export function extractUserInfoDisplayName(u) {
  if (!u || typeof u !== "object") return "";
  const keys = [
    "name",
    "Name",
    "userName",
    "UserName",
    "personName",
    "PersonName",
    "employeeName",
    "EmployeeName",
    "fullName",
    "FullName",
  ];
  for (const k of keys) {
    const v = u[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  const g = u.givenName ?? u.GivenName ?? u.firstName ?? u.FirstName ?? "";
  const f = u.familyName ?? u.FamilyName ?? u.lastName ?? u.LastName ?? "";
  const combo = `${String(g).trim()} ${String(f).trim()}`.replace(/\s+/g, " ").trim();
  return combo || "";
}

function employeeKeyFromUserInfo(u) {
  if (u?.employeeNoString != null && String(u.employeeNoString).trim() !== "") {
    return String(u.employeeNoString).trim();
  }
  if (u?.employeeNo != null && String(u.employeeNo).trim() !== "") {
    return String(u.employeeNo).trim();
  }
  if (u?.cardNo != null && String(u.cardNo).trim() !== "") {
    return String(u.cardNo).trim();
  }
  return "";
}

/** Tek proba: bitta kalit bo‘yicha UserInfo/Record ishlaydimi (chuqur tekshiruv). */
export async function probeUserInfoRecordApi(baseUrl, login, password, employeeKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!employeeKey || !String(employeeKey).trim()) {
    return { ok: true, skipped: true, detail: "" };
  }
  const nm = await fetchHikvisionUserRecordName(baseUrl, login, password, String(employeeKey).trim(), timeoutMs);
  if (nm) return { ok: true, skipped: false, detail: nm };
  return { ok: false, skipped: false, detail: "Record javob bermadi yoki ism yo‘q" };
}

async function fetchHikvisionUserRecordName(baseUrl, login, password, employeeKey, timeoutMs) {
  if (!employeeKey) return "";
  const bodies = [
    { UserInfo: { employeeNoString: String(employeeKey) } },
    { UserInfo: { employeeNo: /^\d+$/.test(String(employeeKey)) ? Number(employeeKey) : String(employeeKey) } },
  ];
  for (const body of bodies) {
    const res = await postJsonDigest(baseUrl, USER_RECORD_PATH, login, password, body, timeoutMs);
    if (!res.httpOk || res.status !== 200 || !res.json) continue;
    const info = res.json.UserInfo ?? res.json.userInfo;
    const ui = Array.isArray(info) ? info[0] : info;
    const nm = extractUserInfoDisplayName(ui);
    if (nm) return nm;
  }
  return "";
}

/**
 * AccessControl UserInfo/Search — sahifalab o‘qiydi, qo‘shimcha maydonlardan ism ajratadi,
 * ismsiz yozuvlar uchun UserInfo/Record bilan boyitishni sinaydi.
 */
export async function fetchHikvisionUsers(baseUrl, login, password, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const searchID = `s${Date.now()}`;
  let position = 0;
  let pages = 0;
  let reportedTotal = null;
  const collected = [];

  while (pages < USER_SEARCH_MAX_PAGES) {
    const payload = {
      UserInfoSearchCond: {
        searchID,
        searchResultPosition: position,
        maxResults: USER_SEARCH_PAGE_SIZE,
      },
    };
    const res = await postJsonDigest(baseUrl, USER_SEARCH_PATH, login, password, payload, timeoutMs);
    pages += 1;

    if (!res.httpOk || res.status !== 200 || !res.json?.UserInfoSearch) {
      if (pages === 1) {
        return {
          ok: false,
          users: [],
          error: res.networkError || res.textPreview || `HTTP ${res.status}`,
          meta: { pages, listedRaw: 0, enriched: 0 },
        };
      }
      break;
    }

    const block = res.json.UserInfoSearch;
    if (reportedTotal == null) {
      reportedTotal = numOfMatchesFromSearch(res.json);
    }
    const st = block.responseStatusStrg ?? block.ResponseStatusStrg ?? "";
    if (pages === 1 && st && !/OK|SUCCESS|success/i.test(String(st)) && !asArray(block.UserInfo).length) {
      return {
        ok: false,
        users: [],
        error: `UserInfoSearch: ${st || "not OK"}`,
        meta: { pages, listedRaw: 0, enriched: 0 },
      };
    }

    const raw = asArray(block.UserInfo);
    if (raw.length === 0) break;

    for (const u of raw) {
      const no = employeeKeyFromUserInfo(u);
      let name = extractUserInfoDisplayName(u);
      collected.push({ employeeNo: no, name });
    }

    position += raw.length;
    if (reportedTotal != null && position >= reportedTotal) break;
    if (raw.length < USER_SEARCH_PAGE_SIZE) break;
  }

  let enriched = 0;
  const enrichTimeout = Math.min(12000, Math.max(8000, timeoutMs));
  for (const row of collected) {
    if (row.name) continue;
    if (!row.employeeNo) continue;
    if (enriched >= USER_RECORD_ENRICH_MAX) break;
    const nm = await fetchHikvisionUserRecordName(
      baseUrl,
      login,
      password,
      row.employeeNo,
      enrichTimeout
    );
    if (nm) {
      row.name = nm;
      enriched += 1;
    }
  }

  const users = [];
  for (const row of collected) {
    if (!row.name) continue;
    users.push({ employeeNo: row.employeeNo || "", name: row.name });
  }

  return {
    ok: true,
    users,
    error: null,
    meta: {
      pages,
      listedRaw: collected.length,
      enriched,
    },
  };
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
