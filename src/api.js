function resolveApiRoot() {
  const fromEnv = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (import.meta.env.DEV) return "http://127.0.0.1:8000";
  return "";
}

const API_ROOT = resolveApiRoot();

/** Bootstrap /uploads/faces/ yoki data: — <img src> uchun to'liq URL. */
export function resolveMediaUrl(urlOrPath) {
  if (urlOrPath == null || urlOrPath === "") return "";
  const s = String(urlOrPath);
  if (s.startsWith("data:")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) {
    return API_ROOT ? `${API_ROOT}${s}` : s;
  }
  return s;
}

const AUTH_STORAGE_KEY = "app-auth-token";
const AUTH_USER_KEY = "app-auth-user";

export function getStoredToken() {
  try {
    return sessionStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getStoredUsername() {
  try {
    return sessionStorage.getItem(AUTH_USER_KEY) || "";
  } catch {
    return "";
  }
}

export function setAuthSession(token, username) {
  try {
    if (token) sessionStorage.setItem(AUTH_STORAGE_KEY, token);
    else sessionStorage.removeItem(AUTH_STORAGE_KEY);
    if (username) sessionStorage.setItem(AUTH_USER_KEY, username);
    else sessionStorage.removeItem(AUTH_USER_KEY);
  } catch {}
}

export function clearAuthSession() {
  try {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    sessionStorage.removeItem(AUTH_USER_KEY);
  } catch {}
}

function notifyUnauthorized() {
  try {
    window.dispatchEvent(new CustomEvent("app-unauthorized"));
  } catch {}
}

async function publicRequest(path, options = {}) {
  const url = `${API_ROOT}/api${path}`;
  const headers = { "Content-Type": "application/json", ...options.headers };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      try {
        const t = await res.text();
        if (t) msg = t;
      } catch {}
    }
    throw new Error(msg);
  }
  return res.json();
}

async function request(path, options = {}) {
  const url = `${API_ROOT}/api${path}`;
  const token = getStoredToken();
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearAuthSession();
    notifyUnauthorized();
    let msg = "Kirish talab qilinadi";
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 403) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    if (String(msg).toLowerCase().includes("obuna")) {
      window.dispatchEvent(new CustomEvent("app-subscription-expired", { detail: { message: msg } }));
    }
    throw new Error(msg);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      try {
        const t = await res.text();
        if (t) msg = t;
      } catch {}
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  login: (username, password) =>
    publicRequest("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  bootstrap: () => request("/bootstrap"),
  getUsers: () => request("/users"),
  createUser: (body) => request("/users", { method: "POST", body: JSON.stringify(body) }),
  getUserFilials: (id) => request(`/users/${id}/filials`),
  putUserFilials: (id, filials) =>
    request(`/users/${id}/filials`, { method: "PUT", body: JSON.stringify({ filials }) }),
  updateUser: (id, body) => request(`/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),
  getTerminals: () => request("/terminals"),
  createTerminal: (body) => request("/terminals", { method: "POST", body: JSON.stringify(body) }),
  testTerminalConnection: (id) =>
    request(`/terminals/${encodeURIComponent(String(id))}/test-connection`, { method: "POST", body: "{}" }),
  syncTerminalEmployees: (id) =>
    request(`/terminals/${encodeURIComponent(String(id))}/sync-employees`, { method: "POST", body: "{}" }),
  syncAllTerminalsEmployees: () => request("/terminals/sync-all-my-employees", { method: "POST", body: "{}" }),
  setUserSubscription: (id, endAt, amount, text) =>
    request(`/users/${id}/subscription`, { method: "PATCH", body: JSON.stringify({ endAt, amount, text }) }),
  cancelUserSubscription: (id) => request(`/users/${id}/subscription`, { method: "DELETE" }),
  createEmployee: (body) => request("/employees", { method: "POST", body: JSON.stringify(body) }),
  updateEmployee: (id, body) => request(`/employees/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteEmployee: (id) => request(`/employees/${id}`, { method: "DELETE" }),
  createAttendance: (body) => request("/attendance", { method: "POST", body: JSON.stringify(body) }),
  updateAttendance: (id, body) => request(`/attendance/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  putRoleSalaries: (obj) => request("/salary/roles", { method: "PUT", body: JSON.stringify(obj) }),
  putSalaryOverrides: (obj) => request("/salary/overrides", { method: "PUT", body: JSON.stringify(obj) }),
  createSalaryPayments: (entries, paidAt, note = "") =>
    request("/salary/payments", { method: "POST", body: JSON.stringify({ entries, paidAt, note }) }),
  createSalaryAdjustment: (body) => request("/salary/adjustments", { method: "POST", body: JSON.stringify(body) }),
  updateSalaryAdjustment: (id, body) =>
    request(`/salary/adjustments/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteSalaryAdjustment: (id) => request(`/salary/adjustments/${id}`, { method: "DELETE" }),
  putSalaryPolicy: (body) => request("/settings/salary-policy", { method: "PUT", body: JSON.stringify(body) }),
  putTheme: (theme) => request("/settings/theme", { method: "PUT", body: JSON.stringify({ theme }) }),
  putTerminalTimezoneOffset: (offsetHours) =>
    request("/settings/terminal-timezone", { method: "PUT", body: JSON.stringify({ offsetHours }) }),
  putSalaryCalcConfig: (cfg) => request("/settings/salary-calc", { method: "PUT", body: JSON.stringify(cfg) }),
  putSalaryCalcConfigFilial: (filial, cfg) =>
    request("/settings/salary-calc/filial", { method: "PUT", body: JSON.stringify({ filial, ...cfg }) }),
  getDbMeta: () => request("/db/meta"),
  getDbTable: (table, params = {}) => {
    const qs = new URLSearchParams(params);
    const q = qs.toString();
    return request(`/db/table/${encodeURIComponent(table)}${q ? `?${q}` : ""}`);
  },
  updateDbRow: (table, pkVal, data) =>
    request(`/db/table/${encodeURIComponent(table)}/${encodeURIComponent(String(pkVal))}`, {
      method: "PATCH",
      body: JSON.stringify({ data }),
    }),
  deleteDbRow: (table, pkVal) =>
    request(`/db/table/${encodeURIComponent(table)}/${encodeURIComponent(String(pkVal))}`, { method: "DELETE" }),
  bulkDeleteDbRows: (table, pks) =>
    request(`/db/table/${encodeURIComponent(table)}/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ pks }),
    }),
  downloadAttendanceFaceImages: () =>
    request("/attendance/download-images", { method: "POST", body: JSON.stringify({}) }),
};
