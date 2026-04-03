import {
  normalizeTerminalBaseUrl,
  fetchHikvisionUsers,
  fetchHikvisionEvents,
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

/**
 * Terminal bilan to‘liq aloqa: foydalanuvchilar qidiruvi + hodisalar API (test.py mantiq).
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
    };
  }

  const { baseUrl } = norm;
  const steps = [];

  const userFetch = await fetchHikvisionUsers(baseUrl, login, password, timeoutMs);
  steps.push({
    id: "userInfoSearch",
    ok: userFetch.ok,
    httpStatus: userFetch.ok ? 200 : 0,
    userCount: userFetch.users?.length ?? 0,
    hint: userFetch.error,
  });

  const evFetch = await fetchHikvisionEvents(
    baseUrl,
    login,
    password,
    "2020-01-01T00:00:00+05:00",
    "2030-12-31T23:59:59+05:00",
    timeoutMs
  );
  steps.push({
    id: "acsEvent",
    ok: evFetch.ok,
    httpStatus: evFetch.ok ? 200 : 0,
    eventCount: evFetch.events?.length ?? 0,
    hint: evFetch.error,
  });

  const ok = steps.every((s) => s.ok);
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^::ffff:/i, "");
  } catch {
    /* ignore */
  }

  let contextHint = null;
  if (!ok && hostname && isPrivateLanHostname(hostname)) {
    contextHint =
      "Bu manzil ichki tarmoq (masalan 192.168.x). Agar RestoControl serveri Internetdagi VPS bo‘lsa, u yerdan ISAPI tekshiruvi (UserInfo / AcsEvent) ishlamaydi — «fetch failed». Yechim: VPN, serverni ofis LAN ida ishlatish, yoki router orqali qurilmaga ochiq yo‘l. Hodisalar bulutga Hikvision «HTTP monitoring» POST orqali kelishi alohida jarayon.";
  }

  return {
    ok,
    baseUrl,
    steps,
    error: ok ? null : "Bir yoki bir nechta ISAPI so‘rovi muvaffaqiyatsiz",
    contextHint,
  };
}
