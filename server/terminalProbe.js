import {
  normalizeTerminalBaseUrl,
  fetchHikvisionUsers,
  fetchHikvisionEvents,
  DEFAULT_TIMEOUT_MS,
} from "./terminalHikvision.js";

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
  return {
    ok,
    baseUrl,
    steps,
    error: ok ? null : "Bir yoki bir nechta ISAPI so‘rovi muvaffaqiyatsiz",
  };
}
