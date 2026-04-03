import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  getStoredToken,
  getStoredUsername,
  setAuthSession,
  clearAuthSession,
  resolveMediaUrl,
} from "./api.js";
import { translate, translateApiError, localeToBcp47, LOCALE_STORAGE_KEY } from "./i18n/index.js";
import logoImage from "../logo_1.png";
import brandLogo from "../logo_2.png";
import loginBgImage from "../login_1.jpg";
import {
  Bell,
  CheckCheck,
  ChevronRight,
  Clock3,
  FileText,
  LayoutDashboard,
  LogOut,
  Moon,
  Plus,
  Pencil,
  Settings2,
  Sun,
  Trash2,
  RotateCcw,
  Wifi,
  Download,
  Monitor,
  Users,
  Wallet,
  X,
} from "lucide-react";

const menuItems = ["Dashboard", "Hodimlar", "Hisobot", "Sozlamalar"];
const ACTIVE_MENU_STORAGE_KEY = "active-menu";
const DENSITY_STORAGE_KEY = "ui-density";
const ALL_FILIALS_VALUE = "__all_filials__";
const SUBSCRIPTION_NOTICE_HISTORY_STORAGE_KEY = "subscription-notice-history-v1";
const SUPERADMIN_CONTACT_URL = "https://t.me/temur_8080";

function resolveAppWsUrl(token) {
  const fromEnv = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  if (fromEnv) {
    let base = fromEnv;
    if (base.startsWith("https://")) base = `wss://${base.slice(8)}`;
    else if (base.startsWith("http://")) base = `ws://${base.slice(7)}`;
    else base = `ws://${base}`;
    return `${base}/ws?token=${encodeURIComponent(token)}`;
  }
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

function normalizeAdjustmentKind(kind) {
  const v = String(kind || "").trim().toLowerCase();
  if (v === "fine") return "fine";
  if (v === "advance" || v === "avans") return "advance";
  if (v === "kpi") return "kpi";
  return "bonus";
}
const menuIcons = {
  Dashboard: LayoutDashboard,
  Hodimlar: Users,
  Hisobot: FileText,
  Sozlamalar: Settings2,
  Adminlar: Users,
  Baza: LayoutDashboard,
  Bildirishnoma: FileText,
  Terminallar: Monitor,
};

function menuI18nPath(item) {
  const map = {
    Dashboard: "menu.dashboard",
    Hodimlar: "menu.employees",
    Hisobot: "menu.report",
    Sozlamalar: "menu.settings",
    Adminlar: "menu.admins",
    Baza: "menu.database",
    Bildirishnoma: "menu.notice",
    Terminallar: "menu.terminals",
  };
  return map[item] || null;
}
const lavozimOptions = [
  "Ofitsiant",
  "Oshpaz",
  "Kassir",
  "Kichik oshpaz",
  "Manager",
  "Yetkazib beruvchi",
  "Barista",
  "Barmen",
  "Sotuvchi",
  "Mehmonxona boshqaruvchisi",
  "Idish yuvuvchi",
];

function getEmployeeFilialRaw(employee) {
  if (!employee) return "";
  const v = employee.filial ?? employee.department;
  return v != null ? String(v).trim() : "";
}

function displayFilial(employee) {
  const r = getEmployeeFilialRaw(employee);
  return r || "—";
}

function normalizeFilialInput(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isValidIpAddress(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (v.toLowerCase() === "localhost") return true;
  const ipv4 =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  return ipv4.test(v);
}

function removeUserFilial(setForm, f) {
  setForm((prev) => ({
    ...prev,
    filials: (prev.filials || []).filter((x) => x !== f),
  }));
}

function addFilialToList(setForm, raw, setInput, bcp47Locale = "uz-UZ") {
  const t = normalizeFilialInput(raw);
  if (!t) return;
  setForm((prev) => {
    const cur = prev.filials || [];
    if (cur.some((x) => String(x).toLowerCase() === t.toLowerCase())) return prev;
    return { ...prev, filials: [...cur, t].sort((a, b) => a.localeCompare(b, bcp47Locale)) };
  });
  setInput("");
}

function normalizeAdminFilials(u) {
  const v = u?.admin_filials;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

const WEEKDAY_KEYS = [
  { key: "mon", labelKey: "weekday.mon" },
  { key: "tue", labelKey: "weekday.tue" },
  { key: "wed", labelKey: "weekday.wed" },
  { key: "thu", labelKey: "weekday.thu" },
  { key: "fri", labelKey: "weekday.fri" },
  { key: "sat", labelKey: "weekday.sat" },
  { key: "sun", labelKey: "weekday.sun" },
];

function defaultWeeklySchedule(shiftStart, shiftEnd) {
  const s = shiftStart || "09:00";
  const e = shiftEnd || "18:00";
  const day = { work: true, start: s, end: e };
  return {
    mon: { ...day },
    tue: { ...day },
    wed: { ...day },
    thu: { ...day },
    fri: { ...day },
    sat: { ...day },
    sun: { ...day },
  };
}

function migrateEmployeeSchedule(emp) {
  if (emp.weeklySchedule && typeof emp.weeklySchedule === "object") {
    const keys = WEEKDAY_KEYS.map((d) => d.key);
    const ok = keys.every((k) => {
      const x = emp.weeklySchedule[k];
      return x && typeof x.start === "string" && typeof x.end === "string" && typeof x.work === "boolean";
    });
    if (ok) return emp;
  }
  return {
    ...emp,
    weeklySchedule: defaultWeeklySchedule(emp.shiftStart, emp.shiftEnd),
  };
}

function dateKeyFromISO(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[d.getDay()];
}

function getShiftForDate(employee, dateStr) {
  const ws = employee.weeklySchedule;
  if (!ws) {
    return { work: true, start: employee.shiftStart || "09:00", end: employee.shiftEnd || "18:00" };
  }
  const key = dateKeyFromISO(dateStr);
  const day = ws[key];
  if (!day) return { work: true, start: employee.shiftStart || "09:00", end: employee.shiftEnd || "18:00" };
  return { work: !!day.work, start: day.start || "09:00", end: day.end || "18:00" };
}

function formatScheduleForTable(employee, dateStr, restDayLabel) {
  const sh = getShiftForDate(employee, dateStr);
  if (!sh.work) return restDayLabel;
  return `${sh.start} – ${sh.end}`;
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowTime() {
  return new Date().toTimeString().slice(0, 5);
}

function toMinutes(time) {
  const s = String(time ?? "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return NaN;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return h * 60 + min;
}

function getLateGraceMinutesFromPolicy(salaryPolicy) {
  const g = salaryPolicy?.lateGraceMinutes;
  if (Number.isFinite(Number(g))) return Math.max(0, Math.trunc(Number(g)));
  return 5;
}

function resolveLateGraceForEmployee(employee, salaryPolicy, overrides) {
  if (!employee || employee.id == null) return 5;
  const emp = overrides?.[String(employee.id)] || {};
  const g = Number(emp.lateGraceMinutes);
  if (Number.isFinite(g)) return Math.max(0, Math.trunc(g));
  return getLateGraceMinutesFromPolicy(salaryPolicy);
}

function isLate(checkInTime, shiftStart, graceMinutes) {
  const g = Number.isFinite(Number(graceMinutes)) ? Math.max(0, Math.trunc(Number(graceMinutes))) : 5;
  const cin = toMinutes(String(checkInTime ?? "").trim());
  const st = toMinutes(String(shiftStart ?? "").trim());
  if (!Number.isFinite(cin) || !Number.isFinite(st)) return false;
  return cin > st + g;
}

function getAvatarClass(name) {
  return `small-avatar a${name.charCodeAt(0) % 6}`;
}

function sameEmployeeId(recordEmployeeId, employeeId) {
  return String(recordEmployeeId) === String(employeeId);
}

function isStillCheckedIn(record) {
  const out = record.checkOut;
  return out == null || String(out).trim() === "";
}

/** Kun uchun eng erta Keldi vaqtini qaytaradi. */
function minCheckInAmongDayRecords(records) {
  let best = "";
  let bestM = NaN;
  for (const r of records) {
    const s = r?.checkIn != null ? String(r.checkIn).trim() : "";
    if (!s) continue;
    const m = toMinutes(s);
    if (!Number.isFinite(m)) continue;
    if (!best || m < bestM) {
      best = s;
      bestM = m;
    }
  }
  return best;
}

/** Kun uchun eng kech Ketdi vaqtini (mavjud bo‘lsa) qaytaradi. */
function maxCheckOutAmongDayRecords(records) {
  let best = "";
  let bestM = NaN;
  for (const r of records) {
    const s = r?.checkOut != null ? String(r.checkOut).trim() : "";
    if (!s) continue;
    const m = toMinutes(s);
    if (!Number.isFinite(m)) continue;
    if (!best || m > bestM) {
      best = s;
      bestM = m;
    }
  }
  return best;
}

/** Keldi vaqti bo‘yicha tartiblangan qatorlardan hozircha ochiq segmentni topadi (oxirgi ochiq checkout). */
function findOpenDaySegment(sortedByCheckIn) {
  for (let i = sortedByCheckIn.length - 1; i >= 0; i--) {
    if (isStillCheckedIn(sortedByCheckIn[i])) return sortedByCheckIn[i];
  }
  return null;
}

/**
 * Kun davomida bir nechta qayd bo‘lsa ham: jadval + maosh — birinchi Keldi va oxirgi Ketdi.
 * API: checkOut / checkIn hali ochiq bo‘lgan oxirgi qator — openSegment (id bilan).
 */
function getEmployeeAttendance(employee, records, date, lateGraceMinutes = 5) {
  const employeeId = employee?.id ?? employee;
  const dayRecords = records.filter((record) => sameEmployeeId(record.employeeId, employeeId) && record.date === date);
  if (dayRecords.length === 0) return { state: "Kelmagan", current: null, openSegment: null, dayRecords: [] };

  const sorted = [...dayRecords].sort((a, b) => {
    const da = toMinutes(String(a?.checkIn ?? "").trim());
    const db = toMinutes(String(b?.checkIn ?? "").trim());
    if (!Number.isFinite(da) && !Number.isFinite(db)) return 0;
    if (!Number.isFinite(da)) return 1;
    if (!Number.isFinite(db)) return -1;
    return da - db;
  });

  const shift =
    employee && typeof employee === "object" ? getShiftForDate(employee, date) : { work: true, start: "09:00", end: "18:00" };
  const grace = Number.isFinite(Number(lateGraceMinutes)) ? Math.max(0, Math.trunc(Number(lateGraceMinutes))) : 5;

  const firstIn = minCheckInAmongDayRecords(sorted);
  const openSegment = findOpenDaySegment(sorted);
  const lastOutClosed = maxCheckOutAmongDayRecords(sorted);
  const displayCheckOut = openSegment ? "" : lastOutClosed;

  const isLateNow = shift.work && firstIn !== "" && isLate(firstIn, shift.start, grace);

  const current = {
    checkIn: firstIn,
    checkOut: displayCheckOut,
    late: isLateNow,
  };

  if (openSegment) {
    return { state: isLateNow ? "Kechikkan" : "Ishda", current, openSegment, dayRecords: sorted };
  }
  return { state: "Ketgan", current, openSegment: null, dayRecords: sorted };
}

/** Keldi / ketdi vaqti + qavsda daqiqalar (jadval va tarix modali uchun). */
function attendanceCheckInOutFragments(employee, record, dateStr, lateGraceMinutes) {
  const sh = getShiftForDate(employee, dateStr);
  if (!record?.checkIn) {
    return {
      inEl: <span>--:--</span>,
      outEl: <span>--:--</span>,
    };
  }
  const cin = String(record.checkIn).trim();
  const cinM = toMinutes(cin);
  const startM = toMinutes(sh.start);
  const endM = toMinutes(sh.end);
  const lateAfterStart =
    sh.work && Number.isFinite(cinM) && Number.isFinite(startM) ? Math.max(0, cinM - startM) : 0;
  const earlyBeforeStart =
    sh.work && Number.isFinite(cinM) && Number.isFinite(startM) && cinM < startM ? startM - cinM : 0;
  const inLate = sh.work && Number.isFinite(cinM) && Number.isFinite(startM) && isLate(cin, sh.start, lateGraceMinutes);
  const inEarly = earlyBeforeStart > 0;

  const coRaw = record.checkOut && String(record.checkOut).trim();
  let outEarly = false;
  let checkoutEarlyMin = 0;
  let outLate = false;
  let checkoutLateMin = 0;
  if (coRaw) {
    const coM = toMinutes(coRaw);
    const earlyMin =
      sh.work && Number.isFinite(coM) && Number.isFinite(endM) && coM < endM ? Math.max(0, endM - coM) : 0;
    outEarly = earlyMin > 0;
    checkoutEarlyMin = earlyMin;
    const lateMin =
      sh.work && Number.isFinite(coM) && Number.isFinite(endM) && coM > endM ? coM - endM : 0;
    outLate = lateMin > 0;
    checkoutLateMin = lateMin;
  }

  const inBracket =
    earlyBeforeStart > 0 ? (
      <span className="attn-time-bracket">[{earlyBeforeStart}]</span>
    ) : lateAfterStart > 0 ? (
      <span className="attn-time-bracket">[{lateAfterStart}]</span>
    ) : null;

  const inEl = (
    <span className={inLate ? "attn-in-late" : inEarly ? "attn-in-early" : undefined}>
      {cin}
      {inBracket}
    </span>
  );

  const outEl = (
    <span className={outEarly ? "attn-out-early" : outLate ? "attn-out-late" : undefined}>
      {coRaw || "--:--"}
      {outEarly ? (
        <span className="attn-time-bracket">[-{checkoutEarlyMin}]</span>
      ) : outLate ? (
        <span className="attn-time-bracket">[{checkoutLateMin}]</span>
      ) : null}
    </span>
  );

  return { inEl, outEl };
}

function attendanceCheckInOutMarkup(employee, record, dateStr, lateGraceMinutes) {
  const { inEl, outEl } = attendanceCheckInOutFragments(employee, record, dateStr, lateGraceMinutes);
  return (
    <span className="check-in-out-cell check-in-out-cell-pair">
      <span className="check-in-out-part check-in-out-part-in">{inEl}</span>
      <span className="check-in-out-sep" aria-hidden="true">
        {" / "}
      </span>
      <span className="check-in-out-part check-in-out-part-out">{outEl}</span>
    </span>
  );
}

function formatAttendanceDate(isoDate, localeCode) {
  if (!isoDate) return "—";
  const d = new Date(`${isoDate}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return String(isoDate);
  return d.toLocaleDateString(localeToBcp47(localeCode), { day: "numeric", month: "short", year: "numeric" });
}

function formatAttendanceHistoryDayHeader(isoDate, localeCode) {
  const dk = toAttendanceDateKey(isoDate);
  if (!dk) return String(isoDate || "");
  const d = new Date(`${dk}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return dk;
  return d.toLocaleDateString(localeToBcp47(localeCode), {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function toAttendanceDateKey(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = new Date(s);
    if (Number.isFinite(t.getTime())) {
      const y = t.getFullYear();
      const m = String(t.getMonth() + 1).padStart(2, "0");
      const d = String(t.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return s.slice(0, 10);
  }
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function filterAttendanceHistoryList(
  records,
  employeeId,
  mode,
  dayStr,
  monthStr,
  allFilterKind,
  allDayValue,
  allMonthValue
) {
  let list = records.filter((r) => sameEmployeeId(r.employeeId, employeeId));
  if (mode === "day") {
    const dk = toAttendanceDateKey(dayStr);
    list = dk ? list.filter((r) => toAttendanceDateKey(r.date) === dk) : [];
  } else if (mode === "month") {
    const ym = String(monthStr || "").trim().slice(0, 7);
    list = ym.length === 7 ? list.filter((r) => toAttendanceDateKey(r.date).startsWith(ym)) : [];
  } else if (mode === "all") {
    if (allFilterKind === "day") {
      const dk = toAttendanceDateKey(allDayValue);
      if (dk) list = list.filter((r) => toAttendanceDateKey(r.date) === dk);
    } else if (allFilterKind === "month") {
      const am = String(allMonthValue || "").trim().slice(0, 7);
      if (am.length === 7) list = list.filter((r) => toAttendanceDateKey(r.date).startsWith(am));
    }
  }
  return list.sort((a, b) => {
    const dc = String(b.date).localeCompare(String(a.date));
    if (dc !== 0) return dc;
    const ta = `${a.checkIn || ""}`;
    const tb = `${b.checkIn || ""}`;
    return tb.localeCompare(ta);
  });
}

function attendanceClass(label) {
  if (label === "Ishda") return "status working";
  if (label === "Kechikkan") return "status late";
  if (label === "Ketgan") return "status free";
  return "status busy";
}

function parseSumInput(raw) {
  const t = String(raw ?? "")
    .replace(/\s/g, "")
    .replace(/,/g, "");
  if (t === "") return null;
  const n = Number.parseInt(t, 10);
  return Number.isNaN(n) ? null : Math.max(0, n);
}

function formatSalaryUZS(value, opts = {}) {
  const currency = opts.currency ?? "so'm";
  const loc = localeToBcp47(opts.locale ?? "uz");
  const rateKind = typeof opts.rateKind === "function" ? opts.rateKind : (x) => x;
  if (value == null) return "—";
  if (typeof value === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `${Math.trunc(n).toLocaleString(loc)} ${currency}`;
  }
  if (typeof value === "object") {
    const amount = value.amount ?? value.salary ?? null;
    const type = value.type ?? value.salary_type ?? "oy";
    const n = Number(amount);
    if (!Number.isFinite(n)) return "—";
    const typeStr = String(type || "oy");
    return `${Math.trunc(n).toLocaleString(loc)} ${currency} / ${rateKind(typeStr)}`;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.trunc(n).toLocaleString(loc)} ${currency}`;
}

function salaryFromRoleMap(roleName, roleSalaries) {
  if (roleSalaries == null) return null;
  const key = roleName == null ? "" : String(roleName).trim();
  if (!key) return null;
  const v = roleSalaries[key] ?? roleSalaries[roleName];
  if (v == null || v === "") return null;
  if (typeof v === "number") return { amount: Number.isFinite(v) ? v : 0, type: "oy" };
  const amount = Number(v.amount ?? v.salary ?? NaN);
  if (!Number.isFinite(amount)) return null;
  return { amount: Math.trunc(amount), type: v.type ?? v.salary_type ?? "oy" };
}

function getEmployeeSalary(employee, roleSalaries, overrides) {
  const oid = String(employee.id);
  const ov = overrides[oid];
  if (ov != null && ov !== "") {
    if (typeof ov === "number") return { amount: ov, type: "oy" };
    const amount = Number(ov.amount ?? ov.salary ?? NaN);
    if (Number.isFinite(amount)) return { amount: Math.trunc(amount), type: ov.type ?? ov.salary_type ?? "oy" };
  }
  return salaryFromRoleMap(employee.role, roleSalaries);
}

function normalizeSalaryRateType(rate) {
  if (!rate || typeof rate !== "object") return null;
  const raw = String(rate.type ?? rate.salary_type ?? "oy")
    .toLowerCase()
    .trim();
  if (raw === "soat" || raw === "hour" || raw === "soatlik") return "soat";
  if (raw === "kun" || raw === "day" || raw === "kunlik") return "kun";
  if (raw === "hafta" || raw === "week" || raw === "haftalik") return "hafta";
  if (raw === "oy" || raw === "month" || raw === "oylik") return "oy";
  return "oy";
}

function hasCompletedCheckoutInMonth(employeeId, yearMonth, records) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(String(yearMonth)) || !Array.isArray(records)) return false;
  const ym = String(yearMonth);
  for (const r of records) {
    if (!sameEmployeeId(r.employeeId, employeeId)) continue;
    if (r.date == null) continue;
    if (!String(r.date).startsWith(ym)) continue;
    const co = r.checkOut;
    if (co != null && String(co).trim() !== "") return true;
  }
  return false;
}

function toLocalISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function computeWorkDaysInWeek(employee, dateStr) {
  const base = new Date(`${dateStr}T12:00:00`);
  const start = new Date(base);
  start.setDate(base.getDate() - base.getDay());
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = toLocalISODate(d);
    const sh = getShiftForDate(employee, key);
    if (sh.work) count++;
  }
  return count;
}

function computeWorkDaysInMonth(employee, dateStr) {
  const base = new Date(`${dateStr}T12:00:00`);
  const year = base.getFullYear();
  const month = base.getMonth();
  const start = new Date(year, month, 1, 12, 0, 0, 0);
  const end = new Date(year, month + 1, 0, 12, 0, 0, 0);
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = toLocalISODate(d);
    const sh = getShiftForDate(employee, key);
    if (sh.work) count++;
  }
  return count;
}

function getEmployeeEarnedSalary(employee, dateStr, attendance, roleSalaries, overrides, salaryCalcConfig) {
  const rate = getEmployeeSalary(employee, roleSalaries, overrides);
  if (!rate) return 0;
  if (!attendance || !attendance.current) return 0;

  const sh = getShiftForDate(employee, dateStr);
  if (!sh.work) return 0;

  const type = String(rate.type || "oy").toLowerCase();
  const checkInStr = attendance.current.checkIn;
  const checkOutStr = attendance.current.checkOut;

  if (type === "kun") return Math.trunc(rate.amount || 0);

  if (type === "soat") {
    const attendanceMode = salaryCalcConfig?.attendanceMode === "all_segments" ? "all_segments" : "first_last";
    const hours = getWorkedHoursOnDay(employee, dateStr, attendance, attendanceMode);
    return Math.round((rate.amount || 0) * hours);
  }

  if (type === "hafta") {
    const weekMode = salaryCalcConfig?.weekMode === "fixed" ? "fixed" : "workdays";
    const weekFixed = Number.isFinite(Number(salaryCalcConfig?.weekFixed)) ? Math.trunc(Number(salaryCalcConfig?.weekFixed)) : 5;
    const denom =
      weekMode === "fixed" ? weekFixed : computeWorkDaysInWeek(employee, dateStr);
    if (!Number.isFinite(denom) || denom <= 0) return 0;
    return Math.round((rate.amount || 0) / denom);
  }

  if (type === "oy") {
    const monthMode = salaryCalcConfig?.monthMode === "fixed" ? "fixed" : "workdays";
    const monthFixed = Number.isFinite(Number(salaryCalcConfig?.monthFixed)) ? Math.trunc(Number(salaryCalcConfig?.monthFixed)) : 30;
    const denom =
      monthMode === "fixed" ? monthFixed : computeWorkDaysInMonth(employee, dateStr);
    if (!Number.isFinite(denom) || denom <= 0) return 0;
    return Math.round((rate.amount || 0) / denom);
  }

  return 0;
}

function eachDateStrInMonth(yearMonth) {
  if (!yearMonth || !/^\d{4}-\d{2}$/.test(String(yearMonth))) return [];
  const parts = String(yearMonth).split("-");
  const y = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return [];
  const out = [];
  const last = new Date(y, m, 0).getDate();
  for (let d = 1; d <= last; d++) {
    out.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

function shiftYearMonth(yearMonth, deltaMonths) {
  const parts = String(yearMonth || "").split("-");
  const y = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return yearMonth;
  const d = new Date(y, m - 1 + Number(deltaMonths || 0), 1, 12, 0, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function buildMonthGrid(yearMonth) {
  const parts = String(yearMonth || "").split("-");
  const y = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return [];
  const first = new Date(y, m - 1, 1, 12, 0, 0, 0);
  const lastDay = new Date(y, m, 0, 12, 0, 0, 0).getDate();
  const startOffset = (first.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push({ key: `empty-start-${i}`, date: null });
  for (let d = 1; d <= lastDay; d++) {
    const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ key: date, date });
  }
  while (cells.length % 7 !== 0) cells.push({ key: `empty-end-${cells.length}`, date: null });
  return cells;
}

function sumEarnedSalaryInMonth(employee, yearMonth, attendanceRecords, roleSalaries, overrides, salaryCalcConfig) {
  let total = 0;
  for (const dateStr of eachDateStrInMonth(yearMonth)) {
    const att = getEmployeeAttendance(employee, attendanceRecords, dateStr, 5);
    total += getEmployeeEarnedSalary(employee, dateStr, att, roleSalaries, overrides, salaryCalcConfig);
  }
  return Math.round(total);
}

function getWorkedHoursOnDay(employee, dateStr, attendance, attendanceMode = "first_last") {
  const sh = getShiftForDate(employee, dateStr);
  if (!sh.work) return 0;
  if (!attendance || !attendance.current) return 0;
  if (attendanceMode === "all_segments") {
    const rows = Array.isArray(attendance.dayRecords) ? attendance.dayRecords : [];
    let totalMin = 0;
    for (const row of rows) {
      const inRaw = String(row?.checkIn || "").trim();
      if (!inRaw) continue;
      const startMin = toMinutes(inRaw);
      let endMin = row?.checkOut && String(row.checkOut).trim() ? toMinutes(String(row.checkOut).trim()) : toMinutes(sh.end);
      if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) continue;
      if (endMin <= startMin) endMin += 24 * 60;
      if (!row?.checkOut || String(row.checkOut).trim() === "") endMin = Math.min(endMin, 23 * 60 + 59);
      totalMin += Math.max(0, endMin - startMin);
    }
    return Math.max(0, totalMin / 60);
  }
  const cin = attendance.current.checkIn;
  if (cin == null || String(cin).trim() === "") return 0;
  const startMin = toMinutes(String(cin).trim());
  const rawOut = attendance.current.checkOut;
  let endMin =
    rawOut != null && String(rawOut).trim() !== "" ? toMinutes(String(rawOut).trim()) : toMinutes(sh.end);
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return 0;
  if (endMin <= startMin) endMin += 24 * 60;
  if (rawOut == null || String(rawOut).trim() === "") {
    endMin = Math.min(endMin, 23 * 60 + 59);
  }
  return Math.max(0, (endMin - startMin) / 60);
}

function sumWorkedHoursInMonth(employee, yearMonth, attendanceRecords, attendanceMode = "first_last") {
  let total = 0;
  for (const dateStr of eachDateStrInMonth(yearMonth)) {
    const att = getEmployeeAttendance(employee, attendanceRecords, dateStr, 5);
    total += getWorkedHoursOnDay(employee, dateStr, att, attendanceMode);
  }
  return Math.round(total * 100) / 100;
}

function formatWorkedHours(hours, hoursUnitLabel) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const totalMinutes = Math.max(0, Math.round(n * 60));
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${hh}:${String(mm).padStart(2, "0")} ${hoursUnitLabel}`;
}

function formatMonthHeading(yearMonth, localeCode) {
  if (!yearMonth) return "";
  const parts = String(yearMonth).split("-");
  const y = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return String(yearMonth);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString(localeToBcp47(localeCode), { month: "long", year: "numeric" });
}

function formatTimezonePreviewDateTime(offsetHours) {
  const raw = Number(offsetHours);
  const safeOffset = Number.isFinite(raw) ? Math.max(-12, Math.min(14, raw)) : 5;
  const shifted = new Date(Date.now() + safeOffset * 60 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  return { date: `${yyyy}.${mm}.${dd}`, time: `${hh}:${min}` };
}

function sparklinePath(values, width = 220, height = 64) {
  const arr = Array.isArray(values) ? values.map((x) => Number(x) || 0) : [];
  if (arr.length === 0) return "";
  const max = Math.max(1, ...arr);
  const step = arr.length > 1 ? width / (arr.length - 1) : width;
  let d = "";
  for (let i = 0; i < arr.length; i++) {
    const x = Math.round(i * step);
    const y = Math.round(height - (arr[i] / max) * height);
    d += `${i === 0 ? "M" : " L"}${x} ${y}`;
  }
  return d;
}

function App() {
  const [authToken, setAuthToken] = useState(() => getStoredToken());
  const [sessionUser, setSessionUser] = useState(() => getStoredUsername());
  const [userRole, setUserRole] = useState("admin");
  const [meEmployeeId, setMeEmployeeId] = useState(null);
  const [loginName, setLoginName] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [activeMenu, setActiveMenu] = useState(() => {
    try {
      const v = localStorage.getItem(ACTIVE_MENU_STORAGE_KEY);
      return menuItems.includes(v) ? v : "Hodimlar";
    } catch {
      return "Hodimlar";
    }
  });
  const [locale, setLocale] = useState(() => {
    try {
      const v = localStorage.getItem(LOCALE_STORAGE_KEY);
      return v === "ru" || v === "en" ? v : "uz";
    } catch {
      return "uz";
    }
  });
  const [theme, setTheme] = useState("light");
  const [uiDensity, setUiDensity] = useState(() => {
    try {
      const v = localStorage.getItem(DENSITY_STORAGE_KEY);
      return v === "dense" ? "dense" : "normal";
    } catch {
      return "normal";
    }
  });
  const [salaryCalcWeekMode, setSalaryCalcWeekMode] = useState("workdays");
  const [salaryCalcWeekFixed, setSalaryCalcWeekFixed] = useState(5);
  const [salaryCalcMonthMode, setSalaryCalcMonthMode] = useState("workdays");
  const [salaryCalcMonthFixed, setSalaryCalcMonthFixed] = useState(30);
  const [salaryCalcAttendanceMode, setSalaryCalcAttendanceMode] = useState("first_last");
  const [adminFilials, setAdminFilials] = useState([]);
  const [salaryCalcSelectedFilial, setSalaryCalcSelectedFilial] = useState("");
  const [salaryCalcConfigsByFilial, setSalaryCalcConfigsByFilial] = useState({});
  const [salaryCalcDefaultConfig, setSalaryCalcDefaultConfig] = useState({
    weekMode: "workdays",
    weekFixed: 5,
    monthMode: "workdays",
    monthFixed: 30,
    attendanceMode: "first_last",
  });
  const [salaryPolicy, setSalaryPolicy] = useState({
    enabled: true,
    latePerMinute: 1000,
    bonusPerMinute: 500,
    bonusGraceMinutes: 30,
    lateGraceMinutes: 5,
    maxDailyFine: 50000,
  });
  const [salaryPolicyEmployeeOverrides, setSalaryPolicyEmployeeOverrides] = useState({});
  const [salaryCalcBusy, setSalaryCalcBusy] = useState(false);
  const [salaryCalcError, setSalaryCalcError] = useState(null);
  const [terminalTimezoneOffsetHours, setTerminalTimezoneOffsetHours] = useState(5);
  const [selectedDate, setSelectedDate] = useState(getTodayDate());
  const [dashboardMonth, setDashboardMonth] = useState(() => getTodayDate().slice(0, 7));
  const [dashboardFilial, setDashboardFilial] = useState("all");
  const [dashboardTrendMode, setDashboardTrendMode] = useState("attendance");
  const [liveNow, setLiveNow] = useState(() => new Date());
  const [salaryReportMonth, setSalaryReportMonth] = useState(() => getTodayDate().slice(0, 7));
  const [salaryReportSegment, setSalaryReportSegment] = useState("all");
  const [filialFilter, setFilialFilter] = useState("all");
  const [cardFilter, setCardFilter] = useState("all");
  const [employees, setEmployees] = useState([]);
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [editForm, setEditForm] = useState(null);
  const [salaryModalOpen, setSalaryModalOpen] = useState(false);
  const [salaryModalTab, setSalaryModalTab] = useState("role");
  const [roleSalaryDraft, setRoleSalaryDraft] = useState([]);
  const [employeeOverrideDraft, setEmployeeOverrideDraft] = useState([]);
  const [salarySaveBusy, setSalarySaveBusy] = useState(false);

  const [roleSalaries, setRoleSalaries] = useState({});
  const [employeeSalaryOverrides, setEmployeeSalaryOverrides] = useState({});
  const [salaryPayments, setSalaryPayments] = useState([]);
  const [salaryAdjustments, setSalaryAdjustments] = useState([]);
  const [salaryAdjModal, setSalaryAdjModal] = useState({
    open: false,
    kind: "bonus",
    amount: "50000",
    note: "",
    busy: false,
    error: "",
  });

  const [users, setUsers] = useState([]);
  const [usersBusy, setUsersBusy] = useState(false);
  const [usersError, setUsersError] = useState(null);
  const [terminals, setTerminals] = useState([]);
  const [terminalsBusy, setTerminalsBusy] = useState(false);
  const [terminalsError, setTerminalsError] = useState(null);
  const [terminalModalOpen, setTerminalModalOpen] = useState(false);
  const [terminalSaveBusy, setTerminalSaveBusy] = useState(false);
  const [terminalSaveError, setTerminalSaveError] = useState("");
  const [terminalForm, setTerminalForm] = useState({
    terminalName: "",
    adminId: "",
    terminalType: "Kirish",
    ipAddress: "",
    login: "",
    password: "",
  });
  const [terminalProbeOpen, setTerminalProbeOpen] = useState(false);
  const [terminalProbeBusy, setTerminalProbeBusy] = useState(false);
  const [terminalProbeName, setTerminalProbeName] = useState("");
  const [terminalProbeResult, setTerminalProbeResult] = useState(null);
  const [terminalSyncBusy, setTerminalSyncBusy] = useState(false);
  const [terminalTableSyncBusyId, setTerminalTableSyncBusyId] = useState(null);

  const [userCreateModalOpen, setUserCreateModalOpen] = useState(false);
  const [userCreateBusy, setUserCreateBusy] = useState(false);
  const [userCreateError, setUserCreateError] = useState(null);
  const [userCreateForm, setUserCreateForm] = useState({
    username: "",
    password: "",
    role: "admin",
    employeeId: "",
    filials: [],
  });
  const [userCreateFilialInput, setUserCreateFilialInput] = useState("");

  const [userEditModalOpen, setUserEditModalOpen] = useState(false);
  const [userEditBusy, setUserEditBusy] = useState(false);
  const [userEditError, setUserEditError] = useState(null);
  const [userEditForm, setUserEditForm] = useState({
    id: null,
    role: "admin",
    employeeId: "",
    password: "",
    filials: [],
  });
  const [userEditFilialsLoading, setUserEditFilialsLoading] = useState(false);
  const [userEditFilialInput, setUserEditFilialInput] = useState("");

  const [userSubscriptionModalOpen, setUserSubscriptionModalOpen] = useState(false);
  const [userSubscriptionBusy, setUserSubscriptionBusy] = useState(false);
  const [userSubscriptionError, setUserSubscriptionError] = useState(null);
  const [userSubscriptionForm, setUserSubscriptionForm] = useState({
    endAt: "",
    amount: "",
    text: "",
  });
  const [userSubscriptionUserId, setUserSubscriptionUserId] = useState(null);

  const [adminSubLocked, setAdminSubLocked] = useState(false);
  const [adminSubNearEnd, setAdminSubNearEnd] = useState(false);
  const [adminSubEndAt, setAdminSubEndAt] = useState(null);
  const [adminSubText, setAdminSubText] = useState("");
  const [adminSubModalOpen, setAdminSubModalOpen] = useState(false);
  const [adminSubModalPersistent, setAdminSubModalPersistent] = useState(false);
  const [adminSubModalDismissed, setAdminSubModalDismissed] = useState(false);
  const [subscriptionNoticeHistory, setSubscriptionNoticeHistory] = useState(() => {
    try {
      const raw = localStorage.getItem(SUBSCRIPTION_NOTICE_HISTORY_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const [dbMeta, setDbMeta] = useState(null);
  const [dbTable, setDbTable] = useState("employees");
  const [dbAdminFilterId, setDbAdminFilterId] = useState("");
  const [dbEmployeeFilterId, setDbEmployeeFilterId] = useState("");
  const [dbBusy, setDbBusy] = useState(false);
  const [dbError, setDbError] = useState(null);
  const [dbColumns, setDbColumns] = useState([]);
  const [dbRows, setDbRows] = useState([]);

  const [dbEditOpen, setDbEditOpen] = useState(false);
  const [dbEditBusy, setDbEditBusy] = useState(false);
  const [dbEditError, setDbEditError] = useState(null);
  const [dbEditTable, setDbEditTable] = useState("");
  const [dbEditPkVal, setDbEditPkVal] = useState("");
  const [dbEditDraft, setDbEditDraft] = useState({});

  const [dbSelectedPks, setDbSelectedPks] = useState([]);

  const [attendanceHistoryEmployee, setAttendanceHistoryEmployee] = useState(null);
  const [attendanceHistoryMode, setAttendanceHistoryMode] = useState("all");
  const [attendanceHistoryDay, setAttendanceHistoryDay] = useState(() => getTodayDate());
  const [attendanceHistoryMonth, setAttendanceHistoryMonth] = useState(() => getTodayDate().slice(0, 7));
  const [attendanceHistoryAllFilterKind, setAttendanceHistoryAllFilterKind] = useState("none");
  const [attendanceHistoryAllDayValue, setAttendanceHistoryAllDayValue] = useState(() => getTodayDate());
  const [attendanceHistoryAllMonthValue, setAttendanceHistoryAllMonthValue] = useState(() =>
    getTodayDate().slice(0, 7)
  );
  const [attendanceHistoryLightbox, setAttendanceHistoryLightbox] = useState(null);
  const [reportDetailEmployee, setReportDetailEmployee] = useState(null);
  const [reportDetailMonth, setReportDetailMonth] = useState(() => getTodayDate().slice(0, 7));
  const [reportDetailSelectedDate, setReportDetailSelectedDate] = useState(() => getTodayDate());
  const [massPayModalOpen, setMassPayModalOpen] = useState(false);
  const [massPayFilial, setMassPayFilial] = useState("all");
  const [massPayOnlyDebtors, setMassPayOnlyDebtors] = useState(true);
  const [massPayDateFrom, setMassPayDateFrom] = useState(() => `${getTodayDate().slice(0, 7)}-01`);
  const [massPayDateTo, setMassPayDateTo] = useState(() => getTodayDate());
  const [massPaySelectedEmployeeIds, setMassPaySelectedEmployeeIds] = useState([]);
  const [massPayBusy, setMassPayBusy] = useState(false);
  const [massPayError, setMassPayError] = useState("");

  const closeEditModal = useCallback(() => setEditForm(null), []);
  const closeAttendanceHistoryModal = useCallback(() => {
    setAttendanceHistoryLightbox(null);
    setAttendanceHistoryEmployee(null);
  }, []);
  const closeReportDetailModal = useCallback(() => {
    setReportDetailEmployee(null);
  }, []);
  const closeMassPayModal = useCallback(() => {
    setMassPayModalOpen(false);
    setMassPayBusy(false);
    setMassPayError("");
  }, []);

  useEffect(() => {
    if (!attendanceHistoryLightbox) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [attendanceHistoryLightbox]);

  const t = useCallback((key, vars) => translate(locale, key, vars), [locale]);
  const pushSubscriptionNotice = useCallback((kind, message, endAt, persistent = false, uniqueKey = "") => {
    const trimmedMessage = String(message || "").trim();
    const title = kind === "expired" ? "admin.modalExpiredTitle" : "admin.modalNearExpiryTitle";
    const fallback = kind === "expired" ? "admin.modalExpiredBody" : "admin.modalNearExpiryBody";
    const text = trimmedMessage || t(fallback);
    const signature = `${kind}|${String(endAt || "")}|${text}|${String(uniqueKey || "")}`;
    setSubscriptionNoticeHistory((prev) => {
      if (prev.some((x) => x.signature === signature)) return prev;
      const next = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          signature,
          kind,
          title,
          text,
          endAt: endAt || null,
          persistent: !!persistent,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 80);
      return next;
    });
  }, [t]);
  const dismissAdminSubscriptionModal = useCallback(() => {
    pushSubscriptionNotice(
      adminSubModalPersistent ? "expired" : "near",
      adminSubText,
      adminSubEndAt,
      adminSubModalPersistent
    );
    setAdminSubModalOpen(false);
    setAdminSubModalDismissed(true);
  }, [adminSubEndAt, adminSubModalPersistent, adminSubText, pushSubscriptionNotice]);
  const clearSubscriptionNoticeHistory = useCallback(() => {
    setSubscriptionNoticeHistory([]);
  }, []);
  const markSubscriptionNoticeRead = useCallback((id) => {
    setSubscriptionNoticeHistory((prev) => prev.map((x) => (x.id === id ? { ...x, read: true } : x)));
  }, []);
  const markAllSubscriptionNoticesRead = useCallback(() => {
    setSubscriptionNoticeHistory((prev) => prev.map((x) => (x.read ? x : { ...x, read: true })));
  }, []);
  const unreadSubscriptionNoticeCount = useMemo(
    () => subscriptionNoticeHistory.reduce((acc, item) => acc + (item.read ? 0 : 1), 0),
    [subscriptionNoticeHistory]
  );
  const sortedSubscriptionNoticeHistory = useMemo(
    () =>
      [...subscriptionNoticeHistory].sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      ),
    [subscriptionNoticeHistory]
  );

  const moneyFmt = useMemo(
    () => ({
      currency: translate(locale, "common.currency"),
      locale,
      rateKind: (k) => {
        const rk = `salary.rateKind.${k}`;
        const v = translate(locale, rk);
        return v === rk ? k : v;
      },
    }),
    [locale]
  );
  const fmtMoney = useCallback((v) => formatSalaryUZS(v, moneyFmt), [moneyFmt]);
  const fmtHours = useCallback(
    (h) => formatWorkedHours(h, translate(locale, "common.hoursUnit")),
    [locale]
  );
  const terminalTimezonePreview = useMemo(
    () => formatTimezonePreviewDateTime(terminalTimezoneOffsetHours),
    [terminalTimezoneOffsetHours]
  );
  const attendanceStateLabel = useCallback(
    (state) => {
      const map = {
        Ishda: "attendance.present",
        Kechikkan: "attendance.late",
        Ketgan: "attendance.left",
        Kelmagan: "attendance.absent",
      };
      const path = map[state];
      return path ? translate(locale, path) : state;
    },
    [locale]
  );
  const userRoleLabel = useCallback(
    (role) => {
      if (role === "superadmin") return translate(locale, "admin.roleSuperadmin");
      if (role === "admin") return translate(locale, "admin.roleAdmin");
      if (role === "hodim") return translate(locale, "admin.roleHodim");
      return role;
    },
    [locale]
  );

  useEffect(() => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      document.documentElement.lang = localeToBcp47(locale);
    } catch {}
  }, [locale]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("theme-dark", theme === "dark");
    return () => root.classList.remove("theme-dark");
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, uiDensity);
    } catch {}
  }, [uiDensity]);

  useEffect(() => {
    try {
      localStorage.setItem(SUBSCRIPTION_NOTICE_HISTORY_STORAGE_KEY, JSON.stringify(subscriptionNoticeHistory));
    } catch {}
  }, [subscriptionNoticeHistory]);

  const attendanceHistoryFiltered = useMemo(() => {
    if (!attendanceHistoryEmployee) return [];
    return filterAttendanceHistoryList(
      attendanceRecords,
      attendanceHistoryEmployee.id,
      attendanceHistoryMode,
      attendanceHistoryDay,
      attendanceHistoryMonth,
      attendanceHistoryAllFilterKind,
      attendanceHistoryAllDayValue,
      attendanceHistoryAllMonthValue
    );
  }, [
    attendanceHistoryEmployee,
    attendanceRecords,
    attendanceHistoryMode,
    attendanceHistoryDay,
    attendanceHistoryMonth,
    attendanceHistoryAllFilterKind,
    attendanceHistoryAllDayValue,
    attendanceHistoryAllMonthValue,
  ]);

  const attendanceHistoryGrouped = useMemo(() => {
    const byDate = new Map();
    for (const rec of attendanceHistoryFiltered) {
      const dk = toAttendanceDateKey(rec.date);
      if (!dk) continue;
      if (!byDate.has(dk)) byDate.set(dk, []);
      byDate.get(dk).push(rec);
    }
    const dates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : -1));
    return dates.map((date) => ({
      date,
      items: (byDate.get(date) || []).sort((a, b) => Number(b.id) - Number(a.id)),
    }));
  }, [attendanceHistoryFiltered]);

  useEffect(() => {
    function onUnauthorized() {
      setAuthToken(null);
      setSessionUser("");
      setUserRole("admin");
      setMeEmployeeId(null);
      setAdminSubLocked(false);
      setAdminSubNearEnd(false);
      setAdminSubEndAt(null);
      setAdminSubText("");
      setAdminSubModalOpen(false);
      setAdminSubModalPersistent(false);
      setAdminSubModalDismissed(false);
      setDataReady(false);
      setEmployees([]);
      setAttendanceRecords([]);
      setRoleSalaries({});
      setEmployeeSalaryOverrides({});
      setSalaryPayments([]);
      setSalaryAdjustments([]);
      setEditForm(null);
      setSalaryModalOpen(false);
      setAttendanceHistoryEmployee(null);
      setDbMeta(null);
      setDbBusy(false);
      setDbError(null);
      setDbColumns([]);
      setDbRows([]);
      setDbEditOpen(false);
      setDbEditBusy(false);
      setDbEditError(null);
      setDbEditTable("");
      setDbEditPkVal("");
      setDbEditDraft({});
      setSalaryCalcWeekMode("workdays");
      setSalaryCalcWeekFixed(5);
      setSalaryCalcMonthMode("workdays");
      setSalaryCalcMonthFixed(30);
      setSalaryCalcAttendanceMode("first_last");
      setTerminalTimezoneOffsetHours(5);
      setSalaryCalcSelectedFilial("");
      setSalaryCalcConfigsByFilial({});
      setAdminFilials([]);
      setSalaryCalcBusy(false);
      setSalaryCalcError(null);
      setSalaryPolicy({
        enabled: true,
        latePerMinute: 1000,
        bonusPerMinute: 500,
        bonusGraceMinutes: 30,
        lateGraceMinutes: 5,
        maxDailyFine: 50000,
      });
      setSalaryPolicyEmployeeOverrides({});
      setMassPayBusy(false);
      setMassPayError("");
    }
    window.addEventListener("app-unauthorized", onUnauthorized);
    return () => window.removeEventListener("app-unauthorized", onUnauthorized);
  }, []);

  useEffect(() => {
    function onSubscriptionExpired(e) {
      if (userRole !== "admin") return;
      setAdminSubLocked(true);
      setAdminSubNearEnd(false);
      setAdminSubModalPersistent(true);
      setAdminSubModalOpen(true);
    }
    window.addEventListener("app-subscription-expired", onSubscriptionExpired);
    return () => window.removeEventListener("app-subscription-expired", onSubscriptionExpired);
  }, [userRole]);

  useEffect(() => {
    if (!authToken) {
      setDataReady(false);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await api.bootstrap();
        if (cancelled) return;
        setUserRole(d.userRole || "admin");
        setMeEmployeeId(d.me?.employeeId ?? null);
        const emps = Array.isArray(d.employees) ? d.employees.map(migrateEmployeeSchedule) : [];
        setEmployees(emps);
        setAttendanceRecords(Array.isArray(d.attendanceRecords) ? d.attendanceRecords : []);
        setRoleSalaries(d.roleSalaries && typeof d.roleSalaries === "object" ? d.roleSalaries : {});
        setEmployeeSalaryOverrides(
          d.employeeSalaryOverrides && typeof d.employeeSalaryOverrides === "object"
            ? d.employeeSalaryOverrides
            : {}
        );
        setSalaryPayments(Array.isArray(d.salaryPayments) ? d.salaryPayments : []);
        setSalaryAdjustments(Array.isArray(d.salaryAdjustments) ? d.salaryAdjustments : []);
        setTheme(d.theme === "dark" ? "dark" : "light");
        if (d.salaryCalcDefaultConfig && typeof d.salaryCalcDefaultConfig === "object") {
          setSalaryCalcDefaultConfig({
            weekMode: d.salaryCalcDefaultConfig.weekMode === "fixed" ? "fixed" : "workdays",
            weekFixed: Number.isFinite(Number(d.salaryCalcDefaultConfig.weekFixed))
              ? Math.trunc(Number(d.salaryCalcDefaultConfig.weekFixed))
              : 5,
            monthMode: d.salaryCalcDefaultConfig.monthMode === "fixed" ? "fixed" : "workdays",
            monthFixed: Number.isFinite(Number(d.salaryCalcDefaultConfig.monthFixed))
              ? Math.trunc(Number(d.salaryCalcDefaultConfig.monthFixed))
              : 30,
            attendanceMode:
              d.salaryCalcDefaultConfig.attendanceMode === "all_segments" ? "all_segments" : "first_last",
          });
        }
        setTerminalTimezoneOffsetHours(
          Number.isFinite(Number(d.terminalEventTimezoneOffsetHours))
            ? Math.max(-12, Math.min(14, Number(d.terminalEventTimezoneOffsetHours)))
            : 5
        );
        if (d.salaryPolicy && typeof d.salaryPolicy === "object") {
          setSalaryPolicy({
            enabled: d.salaryPolicy.enabled !== false,
            latePerMinute: Number.isFinite(Number(d.salaryPolicy.latePerMinute))
              ? Math.max(0, Math.trunc(Number(d.salaryPolicy.latePerMinute)))
              : 1000,
            bonusPerMinute: Number.isFinite(Number(d.salaryPolicy.bonusPerMinute))
              ? Math.max(0, Math.trunc(Number(d.salaryPolicy.bonusPerMinute)))
              : 500,
            bonusGraceMinutes: Number.isFinite(Number(d.salaryPolicy.bonusGraceMinutes))
              ? Math.max(0, Math.trunc(Number(d.salaryPolicy.bonusGraceMinutes)))
              : 30,
            lateGraceMinutes: Number.isFinite(Number(d.salaryPolicy.lateGraceMinutes))
              ? Math.max(0, Math.trunc(Number(d.salaryPolicy.lateGraceMinutes)))
              : 5,
            maxDailyFine: Number.isFinite(Number(d.salaryPolicy.maxDailyFine))
              ? Math.max(0, Math.trunc(Number(d.salaryPolicy.maxDailyFine)))
              : 50000,
          });
        }
        if (d.salaryPolicyEmployeeOverrides && typeof d.salaryPolicyEmployeeOverrides === "object") {
          setSalaryPolicyEmployeeOverrides(d.salaryPolicyEmployeeOverrides);
        }

        if (d.salaryCalcConfigsByFilial && typeof d.salaryCalcConfigsByFilial === "object") {
          setSalaryCalcConfigsByFilial(d.salaryCalcConfigsByFilial);
        }
        setAdminFilials(Array.isArray(d.adminFilials) ? d.adminFilials : []);
        setAdminSubLocked(!!d.adminSubscription?.locked);
        setAdminSubNearEnd(!!d.adminSubscription?.nearEnd);
        setAdminSubEndAt(d.adminSubscription?.subscription_end ?? null);
        setAdminSubText(d.adminSubscriptionMessage || "");
        if (d.adminSubscription?.locked) {
          setAdminSubModalOpen(true);
          setAdminSubModalPersistent(true);
          setAdminSubModalDismissed(false);
          pushSubscriptionNotice(
            "expired",
            d.adminSubscriptionMessage || "",
            d.adminSubscription?.subscription_end ?? null,
            true,
            d.adminSubscription?.noticeKey || ""
          );
        } else if (d.adminSubscription?.nearEnd && !adminSubModalDismissed) {
          setAdminSubModalOpen(true);
          setAdminSubModalPersistent(false);
          pushSubscriptionNotice(
            "near",
            d.adminSubscriptionMessage || "",
            d.adminSubscription?.subscription_end ?? null,
            false,
            d.adminSubscription?.noticeKey || ""
          );
        }
        // Respect stored active menu on reload; fall back by role if needed
        let nextMenu = activeMenu;
        if (d.userRole === "hodim") {
          if (!["Hisobot"].includes(nextMenu)) nextMenu = "Hisobot";
        } else if (d.userRole === "superadmin") {
          if (!["Adminlar", "Dashboard", "Hodimlar", "Hisobot", "Sozlamalar", "Baza", "Terminallar", "Bildirishnoma"].includes(nextMenu)) {
            nextMenu = "Adminlar";
          }
        } else {
          if (!["Dashboard", "Hodimlar", "Hisobot", "Sozlamalar"].includes(nextMenu)) nextMenu = "Hodimlar";
        }
        setActiveMenu(nextMenu);
        setLoadError(null);
        setDataReady(true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(translateApiError(err instanceof Error ? err.message : String(err), locale));
          setDataReady(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adminSubModalDismissed, authToken]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_MENU_STORAGE_KEY, activeMenu);
    } catch {}
  }, [activeMenu]);

  useEffect(() => {
    if (!authToken || !dataReady) return;
    if (userRole !== "admin" && userRole !== "hodim") return;
    let ws;
    try {
      ws = new WebSocket(resolveAppWsUrl(authToken));
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type !== "attendance" || !Array.isArray(msg.records)) return;
          let incoming = msg.records;
          if (userRole === "hodim" && meEmployeeId != null) {
            incoming = incoming.filter((r) => sameEmployeeId(r.employeeId, meEmployeeId));
            if (incoming.length === 0) return;
          }
          setAttendanceRecords((prev) => {
            const m = new Map(prev.map((r) => [Number(r.id), r]));
            for (const r of incoming) {
              if (r && r.id != null) m.set(Number(r.id), r);
            }
            return Array.from(m.values()).sort((a, b) => Number(a.id) - Number(b.id));
          });
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* ignore */
    }
    return () => {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [authToken, dataReady, userRole, meEmployeeId]);

  useEffect(() => {
    if (activeMenu !== "Adminlar" && activeMenu !== "Baza" && activeMenu !== "Terminallar") return;
    if (userRole !== "superadmin") return;
    let cancelled = false;
    (async () => {
      try {
        setUsersBusy(true);
        setUsersError(null);
        const d = await api.getUsers();
        if (cancelled) return;
        setUsers(Array.isArray(d?.users) ? d.users : []);
      } catch (err) {
        if (!cancelled) setUsersError(translateApiError(err instanceof Error ? err.message : String(err), locale));
      } finally {
        if (!cancelled) setUsersBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, userRole, authToken]);

  useEffect(() => {
    if (activeMenu !== "Terminallar") return;
    if (userRole !== "superadmin") return;
    let cancelled = false;
    (async () => {
      try {
        setTerminalsBusy(true);
        setTerminalsError(null);
        const d = await api.getTerminals();
        if (cancelled) return;
        setTerminals(Array.isArray(d?.terminals) ? d.terminals : []);
      } catch (err) {
        if (!cancelled) setTerminalsError(translateApiError(err instanceof Error ? err.message : String(err), locale));
      } finally {
        if (!cancelled) setTerminalsBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, userRole, locale]);

  useEffect(() => {
    if (activeMenu !== "Baza") return;
    if (userRole !== "superadmin") return;
    if (!authToken) return;
    if (dbMeta) return;
    let cancelled = false;
    (async () => {
      try {
        setDbBusy(true);
        setDbError(null);
        const d = await api.getDbMeta();
        if (cancelled) return;
        const tables = Array.isArray(d?.tables) ? d.tables : [];
        setDbMeta({ tables });
        if (tables.length > 0 && !tables.some((t) => t.name === dbTable)) setDbTable(tables[0].name);
      } catch (err) {
        if (!cancelled) setDbError(translateApiError(err instanceof Error ? err.message : String(err), locale));
      } finally {
        if (!cancelled) setDbBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, userRole, authToken, dbMeta, dbTable]);

  useEffect(() => {
    if (activeMenu !== "Baza") return;
    if (userRole !== "superadmin") return;
    if (!authToken) return;
    if (!dbMeta) return;
    let cancelled = false;
    (async () => {
      try {
        setDbBusy(true);
        setDbError(null);
        const params = {};
        if (dbAdminFilterId) params.adminId = dbAdminFilterId;
        if (dbEmployeeFilterId) params.employeeId = dbEmployeeFilterId;
        const d = await api.getDbTable(dbTable, params);
        if (cancelled) return;
        setDbColumns(Array.isArray(d?.columns) ? d.columns : []);
        setDbRows(Array.isArray(d?.rows) ? d.rows : []);
      } catch (err) {
        if (!cancelled) setDbError(translateApiError(err instanceof Error ? err.message : String(err), locale));
        if (!cancelled) {
          setDbColumns([]);
          setDbRows([]);
        }
      } finally {
        if (!cancelled) setDbBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeMenu, userRole, authToken, dbMeta, dbTable, dbAdminFilterId, dbEmployeeFilterId]);

  useEffect(() => {
    if (activeMenu !== "Baza") return;
    setDbSelectedPks([]);
  }, [activeMenu, dbTable, dbAdminFilterId, dbEmployeeFilterId]);

  async function submitLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoginBusy(true);
    try {
      const res = await api.login(loginName.trim() || "admin", loginPass);
      setAuthSession(res.token, res.username || loginName.trim());
      setAuthToken(res.token);
      setSessionUser(res.username || loginName.trim());
      setLoginPass("");
    } catch (err) {
      setLoginError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setLoginBusy(false);
    }
  }

  function logout() {
    clearAuthSession();
    setAuthToken(null);
    setSessionUser("");
    setDataReady(false);
    setEmployees([]);
    setAttendanceRecords([]);
    setRoleSalaries({});
    setEmployeeSalaryOverrides({});
    setSalaryPayments([]);
    setSalaryAdjustments([]);
    setAdminSubLocked(false);
    setAdminSubNearEnd(false);
    setAdminSubText("");
    setAdminSubModalOpen(false);
    setAdminSubModalPersistent(false);
    setAdminSubModalDismissed(false);
    setSalaryCalcWeekMode("workdays");
    setSalaryCalcWeekFixed(5);
    setSalaryCalcMonthMode("workdays");
    setSalaryCalcMonthFixed(30);
    setSalaryCalcAttendanceMode("first_last");
    setTerminalTimezoneOffsetHours(5);
    setSalaryCalcSelectedFilial("");
    setSalaryCalcConfigsByFilial({});
    setAdminFilials([]);
    setSalaryCalcDefaultConfig({
      weekMode: "workdays",
      weekFixed: 5,
      monthMode: "workdays",
      monthFixed: 30,
    });
    setSalaryCalcBusy(false);
    setSalaryCalcError(null);
    setSalaryPolicy({
      enabled: true,
      latePerMinute: 1000,
      bonusPerMinute: 500,
      bonusGraceMinutes: 30,
      lateGraceMinutes: 5,
      maxDailyFine: 50000,
    });
    setSalaryPolicyEmployeeOverrides({});
    setSalaryReportMonth(getTodayDate().slice(0, 7));
    setSalaryReportSegment("all");
    setAttendanceHistoryLightbox(null);
    setAttendanceHistoryEmployee(null);
    setMassPayBusy(false);
    setMassPayError("");
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape") return;
      if (editForm) closeEditModal();
      else if (salaryModalOpen && !salarySaveBusy) setSalaryModalOpen(false);
      else if (reportDetailEmployee) closeReportDetailModal();
      else if (attendanceHistoryLightbox) setAttendanceHistoryLightbox(null);
      else if (attendanceHistoryEmployee) closeAttendanceHistoryModal();
      else if (massPayModalOpen && !massPayBusy) closeMassPayModal();
    }
    if (
      !editForm &&
      !salaryModalOpen &&
      !reportDetailEmployee &&
      !attendanceHistoryLightbox &&
      !attendanceHistoryEmployee &&
      !massPayModalOpen
    )
      return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    editForm,
    closeEditModal,
    salaryModalOpen,
    salarySaveBusy,
    reportDetailEmployee,
    closeReportDetailModal,
    attendanceHistoryLightbox,
    attendanceHistoryEmployee,
    closeAttendanceHistoryModal,
    massPayModalOpen,
    massPayBusy,
    closeMassPayModal,
  ]);

  const employeesForRole = useMemo(() => {
    if (userRole !== "admin") return employees;
    if (!Array.isArray(adminFilials) || adminFilials.length <= 1) return employees;
    const allowed = new Set(adminFilials);
    return employees.filter((e) => allowed.has(getEmployeeFilialRaw(e)));
  }, [employees, userRole, adminFilials]);

  const employeesInScope = useMemo(() => {
    const base = userRole === "admin" ? employeesForRole : employees;
    if (filialFilter === "all") return base;
    return base.filter((employee) => getEmployeeFilialRaw(employee) === filialFilter);
  }, [employees, employeesForRole, userRole, filialFilter]);

  const employeesAfterCardFilter = useMemo(() => {
    if (activeMenu !== "Hodimlar") return employeesInScope;
    if (cardFilter === "all") return employeesInScope;
    return employeesInScope.filter((employee) => {
      const grace = resolveLateGraceForEmployee(employee, salaryPolicy, salaryPolicyEmployeeOverrides);
      const { state } = getEmployeeAttendance(employee, attendanceRecords, selectedDate, grace);
      if (cardFilter === "Ishda") return state === "Ishda" || state === "Kechikkan";
      return state === cardFilter;
    });
  }, [
    employeesInScope,
    attendanceRecords,
    selectedDate,
    cardFilter,
    activeMenu,
    salaryPolicy,
    salaryPolicyEmployeeOverrides,
  ]);

  const salaryReportRows = useMemo(() => {
    if (activeMenu !== "Hisobot") return null;
    return employeesAfterCardFilter.map((employee) => {
      const empFilial = getEmployeeFilialRaw(employee);
      const cfg =
        empFilial === salaryCalcSelectedFilial
          ? {
              weekMode: salaryCalcWeekMode,
              weekFixed: salaryCalcWeekFixed,
              monthMode: salaryCalcMonthMode,
              monthFixed: salaryCalcMonthFixed,
              attendanceMode: salaryCalcAttendanceMode,
            }
          : salaryCalcConfigsByFilial?.[empFilial] || salaryCalcDefaultConfig;
      const rate = getEmployeeSalary(employee, roleSalaries, employeeSalaryOverrides);
      const rateKind = normalizeSalaryRateType(rate);
      const pay = sumEarnedSalaryInMonth(
        employee,
        salaryReportMonth,
        attendanceRecords,
        roleSalaries,
        employeeSalaryOverrides,
        cfg
      );
      const paidMonth = (salaryPayments || []).reduce((acc, p) => {
        if (!sameEmployeeId(p.employeeId, employee.id)) return acc;
        const d = toAttendanceDateKey(p.date);
        if (!d || !d.startsWith(salaryReportMonth)) return acc;
        const amt = Number(p.amount);
        return acc + (Number.isFinite(amt) ? Math.max(0, Math.trunc(amt)) : 0);
      }, 0);
      let bonusMonth = 0;
      let fineMonth = 0;
      let advanceMonth = 0;
      for (const adj of salaryAdjustments || []) {
        if (!sameEmployeeId(adj.employeeId, employee.id)) continue;
        const d = toAttendanceDateKey(adj.date);
        if (!d || !d.startsWith(salaryReportMonth)) continue;
        const amt = Math.max(0, Math.trunc(Number(adj.amount) || 0));
        const kind = normalizeAdjustmentKind(adj.kind);
        if (kind === "fine") fineMonth += amt;
        else if (kind === "advance") advanceMonth += amt;
        else if (kind === "bonus") bonusMonth += amt;
      }
      const adjustedPay = Math.max(0, pay + bonusMonth - fineMonth - advanceMonth);
      const remaining = Math.max(0, adjustedPay - paidMonth);
      const finished = hasCompletedCheckoutInMonth(employee.id, salaryReportMonth, attendanceRecords);
      return { employee, pay: remaining, grossPay: adjustedPay, paidMonth, rateKind, finished };
    });
  }, [
    activeMenu,
    employeesAfterCardFilter,
    salaryReportMonth,
    attendanceRecords,
    roleSalaries,
    employeeSalaryOverrides,
    salaryPayments,
    salaryAdjustments,
    salaryCalcSelectedFilial,
    salaryCalcWeekMode,
    salaryCalcWeekFixed,
    salaryCalcMonthMode,
    salaryCalcMonthFixed,
    salaryCalcAttendanceMode,
    salaryCalcConfigsByFilial,
    salaryCalcDefaultConfig,
  ]);

  const salaryReportBreakdown = useMemo(() => {
    if (!salaryReportRows) return null;
    const rows = salaryReportRows;
    const agg = (predicate, amountSelector = (r) => r.pay) => {
      let sum = 0;
      let n = 0;
      for (const r of rows) {
        if (predicate(r)) {
          sum += amountSelector(r);
          n++;
        }
      }
      return { sum, n };
    };
    const allSum = rows.reduce((a, r) => a + r.pay, 0);
    return {
      all: { sum: allSum, n: rows.length },
      with_pay: agg((r) => r.pay > 0),
      soat: agg((r) => r.rateKind === "soat"),
      kun: agg((r) => r.rateKind === "kun"),
      hafta: agg((r) => r.rateKind === "hafta"),
      oy: agg((r) => r.rateKind === "oy"),
      finished: agg((r) => (r.paidMonth || 0) > 0, (r) => r.paidMonth || 0),
    };
  }, [salaryReportRows]);

  const filteredEmployees = useMemo(() => {
    if (activeMenu !== "Hisobot" || salaryReportSegment === "all") return employeesAfterCardFilter;
    if (!salaryReportRows) return employeesAfterCardFilter;
    const pick = (r) => {
      switch (salaryReportSegment) {
        case "with_pay":
          return r.pay > 0;
        case "soat":
          return r.rateKind === "soat";
        case "kun":
          return r.rateKind === "kun";
        case "hafta":
          return r.rateKind === "hafta";
        case "oy":
          return r.rateKind === "oy";
        case "finished":
          return (r.paidMonth || 0) > 0;
        default:
          return true;
      }
    };
    const ids = new Set(salaryReportRows.filter(pick).map((r) => r.employee.id));
    return employeesAfterCardFilter.filter((e) => ids.has(e.id));
  }, [activeMenu, employeesAfterCardFilter, salaryReportRows, salaryReportSegment]);

  const reportDetailData = useMemo(() => {
    if (!reportDetailEmployee) return null;
    const empFilial = getEmployeeFilialRaw(reportDetailEmployee);
    const cfg =
      empFilial === salaryCalcSelectedFilial
        ? {
            weekMode: salaryCalcWeekMode,
            weekFixed: salaryCalcWeekFixed,
            monthMode: salaryCalcMonthMode,
            monthFixed: salaryCalcMonthFixed,
            attendanceMode: salaryCalcAttendanceMode,
          }
        : salaryCalcConfigsByFilial?.[empFilial] || salaryCalcDefaultConfig;

    const salaryItems = [];
    const fineItems = [];
    const bonusItems = [];
    const advanceItems = [];
    let salaryTotal = 0;
    let paidTotal = 0;
    const paidByDate = new Map();
    for (const p of salaryPayments || []) {
      if (!sameEmployeeId(p.employeeId, reportDetailEmployee.id)) continue;
      const d = toAttendanceDateKey(p.date);
      if (!d || !d.startsWith(reportDetailMonth)) continue;
      const amt = Number(p.amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      paidByDate.set(d, (paidByDate.get(d) || 0) + Math.trunc(amt));
      paidTotal += Math.trunc(amt);
    }
    const reportGrace = resolveLateGraceForEmployee(
      reportDetailEmployee,
      salaryPolicy,
      salaryPolicyEmployeeOverrides
    );
    for (const dateStr of eachDateStrInMonth(reportDetailMonth)) {
      const att = getEmployeeAttendance(reportDetailEmployee, attendanceRecords, dateStr, reportGrace);
      const shift = getShiftForDate(reportDetailEmployee, dateStr);
      const pay = getEmployeeEarnedSalary(
        reportDetailEmployee,
        dateStr,
        att,
        roleSalaries,
        employeeSalaryOverrides,
        cfg
      );
      if (pay > 0) {
        salaryTotal += pay;
        const paidAmount = paidByDate.get(dateStr) || 0;
        const remaining = Math.max(0, pay - paidAmount);
        const openNoCheckout = !!att?.openSegment;
        salaryItems.push({
          date: dateStr,
          amount: pay,
          paidAmount,
          remaining,
          paid: paidAmount > 0,
          provisional: openNoCheckout,
        });
      }
      const empPolicy = salaryPolicyEmployeeOverrides?.[String(reportDetailEmployee.id)] || {};
      const hasEmpOverride = Object.prototype.hasOwnProperty.call(
        salaryPolicyEmployeeOverrides || {},
        String(reportDetailEmployee.id)
      );
      const policyEnabled = salaryPolicy?.enabled !== false || hasEmpOverride;
      if (
        policyEnabled &&
        att?.current?.checkIn &&
        shift.work &&
        isLate(String(att.current.checkIn).trim(), shift.start, reportGrace)
      ) {
        const startMin = toMinutes(shift.start || "09:00");
        const inMin = toMinutes(att.current.checkIn || "00:00");
        const perMinute = Number.isFinite(Number(empPolicy.latePerMinute))
          ? Math.max(0, Math.trunc(Number(empPolicy.latePerMinute)))
          : Math.max(0, Number(salaryPolicy?.latePerMinute) || 0);
        const maxDailyFine = Number.isFinite(Number(empPolicy.maxDailyFine))
          ? Math.max(0, Math.trunc(Number(empPolicy.maxDailyFine)))
          : Math.max(0, Number(salaryPolicy?.maxDailyFine) || 0);
        const lateMin = Math.max(0, inMin - startMin - reportGrace);
        const rawAmount = lateMin > 0 ? lateMin * perMinute : 0;
        const amount = maxDailyFine > 0 ? Math.min(maxDailyFine, rawAmount) : rawAmount;
        if (amount > 0) fineItems.push({ date: dateStr, lateMin, amount, auto: true, note: "Kechikish" });
      }
      if (policyEnabled && att?.current?.checkIn) {
        if (shift?.work) {
          const startMin = toMinutes(shift.start || "09:00");
          const endMin = toMinutes(shift.end || "18:00");
          const shiftDurMin = Math.max(0, endMin - startMin);
          const workedMin = Math.round(
            getWorkedHoursOnDay(reportDetailEmployee, dateStr, att, cfg?.attendanceMode) * 60
          );
          const grace = Math.max(0, Number(salaryPolicy?.bonusGraceMinutes) || 0);
          const bonusPerMinute = Math.max(0, Number(salaryPolicy?.bonusPerMinute) || 0);
          const extraMin = Math.max(0, workedMin - shiftDurMin - grace);
          const amount = extraMin > 0 ? extraMin * bonusPerMinute : 0;
          if (amount > 0) bonusItems.push({ date: dateStr, extraMin, amount, auto: true, note: "Ko'p ishlagan" });
        }
      }
    }

    const manualAdjustments = (salaryAdjustments || []).filter((x) => {
      if (!sameEmployeeId(x.employeeId, reportDetailEmployee.id)) return false;
      const d = toAttendanceDateKey(x.date);
      return !!d && d.startsWith(reportDetailMonth);
    });
    for (const adj of manualAdjustments) {
      const date = toAttendanceDateKey(adj.date);
      if (!date) continue;
      const item = {
        id: adj.id,
        date,
        amount: Math.max(0, Number(adj.amount) || 0),
        auto: false,
        note: adj.note || "",
      };
      const k = normalizeAdjustmentKind(adj.kind);
      if (k === "fine") fineItems.push(item);
      else if (k === "advance") advanceItems.push(item);
      else bonusItems.push(item);
    }

    const bonusTotal = bonusItems.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const advanceTotal = advanceItems.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const fineTotal = fineItems.reduce((a, x) => a + (Number(x.amount) || 0), 0);
    const bonusByDate = new Map();
    const fineByDate = new Map();
    const advanceByDate = new Map();
    for (const x of bonusItems) {
      const d = toAttendanceDateKey(x.date);
      if (!d) continue;
      bonusByDate.set(d, (bonusByDate.get(d) || 0) + Math.max(0, Math.trunc(Number(x.amount) || 0)));
    }
    for (const x of fineItems) {
      const d = toAttendanceDateKey(x.date);
      if (!d) continue;
      fineByDate.set(d, (fineByDate.get(d) || 0) + Math.max(0, Math.trunc(Number(x.amount) || 0)));
    }
    for (const x of advanceItems) {
      const d = toAttendanceDateKey(x.date);
      if (!d) continue;
      advanceByDate.set(d, (advanceByDate.get(d) || 0) + Math.max(0, Math.trunc(Number(x.amount) || 0)));
    }
    const adjustedSalaryItems = salaryItems.map((x) => {
      const bonus = bonusByDate.get(x.date) || 0;
      const fine = fineByDate.get(x.date) || 0;
      const advance = advanceByDate.get(x.date) || 0;
      const due = Math.max(0, Math.trunc(x.amount) + bonus - fine - advance);
      const remaining = Math.max(0, due - Math.max(0, Math.trunc(Number(x.paidAmount) || 0)));
      return {
        ...x,
        bonus,
        fine,
        advance,
        due,
        remaining,
      };
    });
    const remainingByDate = new Map(adjustedSalaryItems.map((x) => [x.date, x.remaining]));
    const calendarByDate = new Map(
      adjustedSalaryItems.map((x) => [
        x.date,
        {
          due: x.due,
          paid: Math.max(0, Math.trunc(Number(x.paidAmount) || 0)),
          remaining: x.remaining,
          settled: x.due > 0 && x.remaining <= 0,
        },
      ])
    );
    const selectedPay = remainingByDate.get(reportDetailSelectedDate) || 0;
    const adjustedTotal = adjustedSalaryItems.reduce((a, x) => a + x.due, 0);
    const remainingTotal = adjustedSalaryItems.reduce((a, x) => a + x.remaining, 0);
    const netTotal = Math.max(0, remainingTotal);
    return {
      salaryItems: adjustedSalaryItems,
      bonusItems,
      fineItems,
      advanceItems,
      salaryTotal,
      adjustedTotal,
      paidTotal,
      remainingTotal,
      bonusTotal,
      fineTotal,
      advanceTotal,
      netTotal,
      selectedPay,
      payByDate: remainingByDate,
      calendarByDate,
      calendarCells: buildMonthGrid(reportDetailMonth),
    };
  }, [
    reportDetailEmployee,
    reportDetailMonth,
    reportDetailSelectedDate,
    attendanceRecords,
    roleSalaries,
    employeeSalaryOverrides,
    salaryPayments,
    salaryAdjustments,
    salaryCalcSelectedFilial,
    salaryCalcWeekMode,
    salaryCalcWeekFixed,
    salaryCalcMonthMode,
    salaryCalcMonthFixed,
    salaryCalcAttendanceMode,
    salaryCalcConfigsByFilial,
    salaryCalcDefaultConfig,
    salaryPolicy,
    salaryPolicyEmployeeOverrides,
  ]);

  const getSalaryCalcConfigForEmployee = useCallback((employee) => {
    const empFilial = getEmployeeFilialRaw(employee);
    if (empFilial === salaryCalcSelectedFilial) {
      return {
        weekMode: salaryCalcWeekMode,
        weekFixed: salaryCalcWeekFixed,
        monthMode: salaryCalcMonthMode,
        monthFixed: salaryCalcMonthFixed,
        attendanceMode: salaryCalcAttendanceMode,
      };
    }
    return salaryCalcConfigsByFilial?.[empFilial] || salaryCalcDefaultConfig;
  }, [
    salaryCalcSelectedFilial,
    salaryCalcWeekMode,
    salaryCalcWeekFixed,
    salaryCalcMonthMode,
    salaryCalcMonthFixed,
    salaryCalcAttendanceMode,
    salaryCalcConfigsByFilial,
    salaryCalcDefaultConfig,
  ]);

  const massPayPrepared = useMemo(() => {
    if (activeMenu !== "Hisobot") return { rows: [], entries: [], total: 0, days: 0, dueTotal: 0 };
    const fromDate = String(massPayDateFrom || "").slice(0, 10);
    const toDate = String(massPayDateTo || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      return { rows: [], entries: [], total: 0, days: 0, dueTotal: 0 };
    }
    const rangeStart = fromDate <= toDate ? fromDate : toDate;
    const rangeEnd = fromDate <= toDate ? toDate : fromDate;
    const paidByEmpDate = new Map();
    for (const p of salaryPayments || []) {
      const d = toAttendanceDateKey(p.date);
      if (!d || !d.startsWith(salaryReportMonth)) continue;
      const k = `${p.employeeId}|${d}`;
      const amt = Number(p.amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      paidByEmpDate.set(k, (paidByEmpDate.get(k) || 0) + Math.trunc(amt));
    }
    const rows = [];
    for (const emp of employeesAfterCardFilter || []) {
      if (!emp) continue;
      const filial = getEmployeeFilialRaw(emp) || "Asosiy filial";
      if (massPayFilial !== "all" && filial !== massPayFilial) continue;
      const cfg = getSalaryCalcConfigForEmployee(emp);
      let remainingAmount = 0;
      let remainingDays = 0;
      const entries = [];
      for (const dateStr of eachDateStrInMonth(salaryReportMonth)) {
        if (dateStr < rangeStart || dateStr > rangeEnd) continue;
        const att = getEmployeeAttendance(emp, attendanceRecords, dateStr, 5);
        const dayPay = getEmployeeEarnedSalary(emp, dateStr, att, roleSalaries, employeeSalaryOverrides, cfg);
        if (dayPay <= 0) continue;
        const paidAmt = paidByEmpDate.get(`${emp.id}|${dateStr}`) || 0;
        const remaining = Math.max(0, dayPay - paidAmt);
        if (remaining <= 0) continue;
        remainingAmount += remaining;
        remainingDays += 1;
        entries.push({ employeeId: emp.id, date: dateStr, amount: remaining });
      }
      if (massPayOnlyDebtors && remainingAmount <= 0) continue;
      rows.push({ employee: emp, filial, role: String(emp.role || ""), remainingAmount, remainingDays, entries });
    }
    rows.sort((a, b) => b.remainingAmount - a.remainingAmount || a.employee.name.localeCompare(b.employee.name));
    const selected = new Set(massPaySelectedEmployeeIds.map((x) => Number(x)));
    const selectedRows = rows.filter((x) => selected.has(Number(x.employee.id)));
    const entries = selectedRows.flatMap((x) => x.entries);
    const total = entries.reduce((acc, x) => acc + x.amount, 0);
    const dueTotal = rows.reduce((acc, x) => acc + x.remainingAmount, 0);
    return { rows, entries, total, days: entries.length, dueTotal };
  }, [
    activeMenu,
    massPayDateFrom,
    massPayDateTo,
    salaryPayments,
    salaryReportMonth,
    massPayFilial,
    massPayOnlyDebtors,
    getSalaryCalcConfigForEmployee,
    massPaySelectedEmployeeIds,
    employeesAfterCardFilter,
    attendanceRecords,
    roleSalaries,
    employeeSalaryOverrides,
  ]);

  useEffect(() => {
    if (!massPayModalOpen) return;
    const availableIds = new Set(massPayPrepared.rows.map((x) => Number(x.employee.id)));
    setMassPaySelectedEmployeeIds((prev) => {
      const next = prev.filter((id) => availableIds.has(Number(id)));
      if (next.length === prev.length && next.every((v, i) => v === prev[i])) return prev;
      return next;
    });
  }, [massPayModalOpen, massPayPrepared.rows]);

  const submitMassSalaryPayment = useCallback(async () => {
    if (massPayPrepared.entries.length === 0) {
      setMassPayError("To'lash uchun hodim yoki kun tanlanmagan.");
      return;
    }
    setMassPayBusy(true);
    setMassPayError("");
    try {
      const paidAtDate = String(massPayDateTo || "").slice(0, 10);
      const res = await api.createSalaryPayments(massPayPrepared.entries, `${paidAtDate}T23:59`, "Report bulk payment");
      const inserted = Array.isArray(res?.inserted) ? res.inserted : [];
      if (inserted.length > 0) {
        setSalaryPayments((prev) => prev.concat(inserted));
        setMassPaySelectedEmployeeIds([]);
      } else {
        setMassPayError("Tanlangan kunlar allaqachon to'langan bo'lishi mumkin.");
      }
    } catch (err) {
      setMassPayError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setMassPayBusy(false);
    }
  }, [massPayPrepared.entries, massPayDateTo, locale]);

  const dashboardData = useMemo(() => {
    const today = getTodayDate();
    const scopedEmployees =
      dashboardFilial === "all"
        ? employeesInScope
        : employeesInScope.filter((e) => (getEmployeeFilialRaw(e) || "Asosiy filial") === dashboardFilial);
    const inOffice = scopedEmployees.reduce((acc, emp) => {
      const g = resolveLateGraceForEmployee(emp, salaryPolicy, salaryPolicyEmployeeOverrides);
      const state = getEmployeeAttendance(emp, attendanceRecords, today, g).state;
      return acc + (state === "Ishda" || state === "Kechikkan" ? 1 : 0);
    }, 0);
    const stateCounts = { late: 0, gone: 0, absent: 0 };
    for (const emp of scopedEmployees) {
      const g = resolveLateGraceForEmployee(emp, salaryPolicy, salaryPolicyEmployeeOverrides);
      const state = getEmployeeAttendance(emp, attendanceRecords, today, g).state;
      if (state === "Kechikkan") stateCounts.late += 1;
      else if (state === "Ketgan") stateCounts.gone += 1;
      else if (state === "Kelmagan") stateCounts.absent += 1;
    }

    const byFilialMap = new Map();
    for (const emp of scopedEmployees) {
      const f = getEmployeeFilialRaw(emp) || "Asosiy filial";
      byFilialMap.set(f, (byFilialMap.get(f) || 0) + 1);
    }
    const byFilial = Array.from(byFilialMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    const trendDays = [];
    const trendChecks = [];
    const trendSalary = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dk = toLocalISODate(d);
      trendDays.push(dk);
      let n = 0;
      let salarySum = 0;
      for (const emp of scopedEmployees) {
        const att = getEmployeeAttendance(emp, attendanceRecords, dk, 5);
        if (att?.current?.checkIn) n += 1;
        const cfg = getSalaryCalcConfigForEmployee(emp);
        salarySum += getEmployeeEarnedSalary(emp, dk, att, roleSalaries, employeeSalaryOverrides, cfg);
      }
      trendChecks.push(n);
      trendSalary.push(Math.max(0, Math.trunc(salarySum)));
    }

    const monthRows = scopedEmployees.map((employee) => {
      const cfg = getSalaryCalcConfigForEmployee(employee);
      const gross = sumEarnedSalaryInMonth(
        employee,
        dashboardMonth,
        attendanceRecords,
        roleSalaries,
        employeeSalaryOverrides,
        cfg
      );
      const paid = (salaryPayments || []).reduce((acc, p) => {
        if (!sameEmployeeId(p.employeeId, employee.id)) return acc;
        const d = toAttendanceDateKey(p.date);
        if (!d || !d.startsWith(dashboardMonth)) return acc;
        const amt = Number(p.amount);
        return acc + (Number.isFinite(amt) ? Math.max(0, Math.trunc(amt)) : 0);
      }, 0);
      const hours = sumWorkedHoursInMonth(employee, dashboardMonth, attendanceRecords, cfg?.attendanceMode);
      return { employee, gross, paid, remaining: Math.max(0, gross - paid), hours };
    });
    const grossMonth = monthRows.reduce((a, x) => a + x.gross, 0);
    const paidMonth = monthRows.reduce((a, x) => a + x.paid, 0);
    const remainingMonth = monthRows.reduce((a, x) => a + x.remaining, 0);
    const topRemaining = monthRows
      .filter((x) => x.remaining > 0)
      .sort((a, b) => b.remaining - a.remaining)
      .slice(0, 5);
    const topActive = monthRows
      .filter((x) => x.hours > 0)
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 5);
    const topLate = scopedEmployees
      .map((emp) => {
        let lateN = 0;
        const g = resolveLateGraceForEmployee(emp, salaryPolicy, salaryPolicyEmployeeOverrides);
        for (const d of eachDateStrInMonth(dashboardMonth)) {
          const att = getEmployeeAttendance(emp, attendanceRecords, d, g);
          const cin = att?.current?.checkIn;
          if (!cin) continue;
          const sh = getShiftForDate(emp, d);
          if (sh.work && isLate(String(cin).trim(), sh.start, g)) lateN += 1;
        }
        return { employee: emp, lateN };
      })
      .filter((x) => x.lateN > 0)
      .sort((a, b) => b.lateN - a.lateN)
      .slice(0, 5);
    const paidPercent = grossMonth > 0 ? Math.round((paidMonth / grossMonth) * 100) : 0;
    const presentNow = Math.max(0, scopedEmployees.length - stateCounts.absent);
    const attendanceTotal = Math.max(1, scopedEmployees.length);
    const attendanceRing = {
      present: Math.round((Math.max(0, presentNow) / attendanceTotal) * 100),
      late: Math.round((stateCounts.late / attendanceTotal) * 100),
      absent: Math.round((stateCounts.absent / attendanceTotal) * 100),
    };
    const heatDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dk = toLocalISODate(d);
      let present = 0;
      for (const emp of scopedEmployees) {
        const att = getEmployeeAttendance(emp, attendanceRecords, dk, 5);
        if (att?.current?.checkIn) present += 1;
      }
      heatDays.push({
        date: dk,
        label: dk.slice(5),
        value: present,
        pct: Math.max(0, Math.min(100, Math.round((present / attendanceTotal) * 100))),
      });
    }
    return {
      totalEmployees: scopedEmployees.length,
      inOffice,
      stateCounts,
      presentNow,
      grossMonth,
      paidMonth,
      remainingMonth,
      paidPercent,
      attendanceRing,
      heatDays,
      byFilial,
      trendDays,
      trendChecks,
      trendSalary,
      topRemaining,
      topActive,
      topLate,
    };
  }, [
    dashboardFilial,
    dashboardMonth,
    employeesInScope,
    attendanceRecords,
    getSalaryCalcConfigForEmployee,
    roleSalaries,
    employeeSalaryOverrides,
    salaryPayments,
    salaryPolicy,
    salaryPolicyEmployeeOverrides,
  ]);

  useEffect(() => {
    if (activeMenu !== "Dashboard") return undefined;
    const id = setInterval(() => setLiveNow(new Date()), 10000);
    return () => clearInterval(id);
  }, [activeMenu]);

  const openAddSalaryAdjustmentModal = useCallback((kind) => {
    setSalaryAdjModal({
      open: true,
      kind: kind === "fine" || kind === "advance" ? kind : "bonus",
      amount: "50000",
      note: "",
      busy: false,
      error: "",
    });
  }, []);

  const closeAddSalaryAdjustmentModal = useCallback(() => {
    setSalaryAdjModal((prev) => ({ ...prev, open: false, busy: false, error: "" }));
  }, []);

  const submitAddSalaryAdjustment = useCallback(async () => {
    if (!reportDetailEmployee) return;
    const amount = Number(salaryAdjModal.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setSalaryAdjModal((prev) => ({ ...prev, error: t("salaryAdj.amountInvalid") }));
      return;
    }
    const date = reportDetailSelectedDate || `${reportDetailMonth}-01`;
    try {
      setSalaryAdjModal((prev) => ({ ...prev, busy: true, error: "" }));
      const row = await api.createSalaryAdjustment({
        employeeId: reportDetailEmployee.id,
        date,
        kind: salaryAdjModal.kind,
        amount: Math.trunc(amount),
        note: String(salaryAdjModal.note || ""),
      });
      const normalized = { ...row, kind: normalizeAdjustmentKind(salaryAdjModal.kind) };
      setSalaryAdjustments((prev) => prev.concat(normalized));
      setSalaryAdjModal((prev) => ({ ...prev, open: false, busy: false, error: "" }));
    } catch (err) {
      setSalaryAdjModal((prev) => ({
        ...prev,
        busy: false,
        error: translateApiError(err instanceof Error ? err.message : String(err), locale),
      }));
    }
  }, [reportDetailEmployee, reportDetailSelectedDate, reportDetailMonth, salaryAdjModal, locale, t]);

  const editSalaryAdjustment = useCallback(
    async (item, kind) => {
      if (!item?.id) return;
      const amountRaw = window.prompt(t("salaryAdj.promptAmount"), String(item.amount || 0));
      if (amountRaw == null) return;
      const amount = Number(amountRaw);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const note = window.prompt(t("salaryAdj.promptNote"), String(item.note || "")) || "";
      try {
        const row = await api.updateSalaryAdjustment(item.id, { amount: Math.trunc(amount), note, kind });
        const normalized = { ...row, kind: normalizeAdjustmentKind(kind) };
        setSalaryAdjustments((prev) => prev.map((x) => (x.id === item.id ? normalized : x)));
      } catch (err) {
        alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
      }
    },
    [locale]
  );

  const deleteSalaryAdjustment = useCallback(
    async (itemId) => {
      if (!itemId) return;
      if (!window.confirm(t("salaryAdj.confirmDelete"))) return;
      try {
        await api.deleteSalaryAdjustment(itemId);
        setSalaryAdjustments((prev) => prev.filter((x) => x.id !== itemId));
      } catch (err) {
        alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
      }
    },
    [locale]
  );

  useEffect(() => {
    setSalaryReportSegment("all");
  }, [salaryReportMonth]);

  const stats = useMemo(() => {
    const list = employeesInScope.map((employee) => {
      const g = resolveLateGraceForEmployee(employee, salaryPolicy, salaryPolicyEmployeeOverrides);
      return getEmployeeAttendance(employee, attendanceRecords, selectedDate, g);
    });
    const atWork = list.filter((item) => item.state === "Ishda" || item.state === "Kechikkan").length;
    return {
      total: employeesInScope.length,
      atWork,
      late: list.filter((item) => item.state === "Kechikkan").length,
      gone: list.filter((item) => item.state === "Ketgan").length,
      absent: list.filter((item) => item.state === "Kelmagan").length,
    };
  }, [attendanceRecords, employeesInScope, selectedDate, salaryPolicy, salaryPolicyEmployeeOverrides]);

  const filialOptions = useMemo(() => {
    if (userRole === "admin") {
      if (Array.isArray(adminFilials) && adminFilials.length > 1) {
        return [...adminFilials].sort((a, b) => a.localeCompare(b, localeToBcp47(locale)));
      }
    }
    const set = new Set();
    employees.forEach((e) => {
      const f = getEmployeeFilialRaw(e);
      if (f) set.add(f);
    });
    return [...set].sort((a, b) => a.localeCompare(b, localeToBcp47(locale)));
  }, [employees, userRole, adminFilials, locale]);

  useEffect(() => {
    if (filialFilter !== "all" && !filialOptions.includes(filialFilter)) {
      setFilialFilter("all");
    }
  }, [filialFilter, filialOptions]);

  useEffect(() => {
    if (salaryCalcSelectedFilial) return;
    if (!Array.isArray(filialOptions) || filialOptions.length === 0) return;
    setSalaryCalcSelectedFilial(ALL_FILIALS_VALUE);
  }, [filialOptions, salaryCalcSelectedFilial]);

  useEffect(() => {
    if (!salaryCalcSelectedFilial) return;
    if (!Array.isArray(filialOptions) || filialOptions.length === 0) {
      setSalaryCalcSelectedFilial("");
      return;
    }
    if (salaryCalcSelectedFilial === ALL_FILIALS_VALUE) return;
    if (!filialOptions.includes(salaryCalcSelectedFilial)) setSalaryCalcSelectedFilial(ALL_FILIALS_VALUE);
  }, [filialOptions, salaryCalcSelectedFilial]);

  useEffect(() => {
    if (!salaryCalcSelectedFilial) return;
    if (salaryCalcSelectedFilial === ALL_FILIALS_VALUE) {
      setSalaryCalcWeekMode(salaryCalcDefaultConfig?.weekMode === "fixed" ? "fixed" : "workdays");
      setSalaryCalcWeekFixed(
        Number.isFinite(Number(salaryCalcDefaultConfig?.weekFixed))
          ? Math.trunc(Number(salaryCalcDefaultConfig.weekFixed))
          : 5
      );
      setSalaryCalcMonthMode(salaryCalcDefaultConfig?.monthMode === "fixed" ? "fixed" : "workdays");
      setSalaryCalcMonthFixed(
        Number.isFinite(Number(salaryCalcDefaultConfig?.monthFixed))
          ? Math.trunc(Number(salaryCalcDefaultConfig.monthFixed))
          : 30
      );
      setSalaryCalcAttendanceMode(
        salaryCalcDefaultConfig?.attendanceMode === "all_segments" ? "all_segments" : "first_last"
      );
      return;
    }
    const cfg = salaryCalcConfigsByFilial?.[salaryCalcSelectedFilial] || salaryCalcDefaultConfig;
    const safeWeekFixed = Number.isFinite(Number(cfg?.weekFixed)) ? Math.trunc(Number(cfg.weekFixed)) : 5;
    const safeMonthFixed = Number.isFinite(Number(cfg?.monthFixed)) ? Math.trunc(Number(cfg.monthFixed)) : 30;
    setSalaryCalcWeekMode(cfg?.weekMode === "fixed" ? "fixed" : "workdays");
    setSalaryCalcWeekFixed(safeWeekFixed);
    setSalaryCalcMonthMode(cfg?.monthMode === "fixed" ? "fixed" : "workdays");
    setSalaryCalcMonthFixed(safeMonthFixed);
    setSalaryCalcAttendanceMode(cfg?.attendanceMode === "all_segments" ? "all_segments" : "first_last");
  }, [salaryCalcSelectedFilial, salaryCalcConfigsByFilial, salaryCalcDefaultConfig]);

  const lavozimSelectOptions = useMemo(() => {
    const set = new Set(lavozimOptions);
    const source = userRole === "admin" ? employeesForRole : employees;
    source.forEach((e) => {
      const r = e.role?.trim();
      if (r) set.add(r);
    });
    Object.keys(roleSalaries || {}).forEach((r) => {
      const v = String(r).trim();
      if (v) set.add(v);
    });
    return [...set].sort((a, b) => a.localeCompare(b, localeToBcp47(locale)));
  }, [employees, employeesForRole, userRole, locale, roleSalaries]);
  const editFilialOptions = useMemo(() => {
    const set = new Set(Array.isArray(filialOptions) ? filialOptions : []);
    const currentEditFilial = String(editForm?.filial || "").trim();
    if (currentEditFilial) set.add(currentEditFilial);
    if (set.size === 0) set.add(t("employees.defaultBranch"));
    return [...set].sort((a, b) => a.localeCompare(b, localeToBcp47(locale)));
  }, [filialOptions, editForm?.filial, t, locale]);

  function openEditModal(id) {
    const current = employees.find((employee) => employee.id === id);
    if (!current) return;
    const migrated = migrateEmployeeSchedule(current);
    setEditForm({
      id: migrated.id,
      name: migrated.name,
      role: migrated.role,
      filial: getEmployeeFilialRaw(migrated) || t("employees.defaultBranch"),
      weeklySchedule: JSON.parse(JSON.stringify(migrated.weeklySchedule)),
    });
  }

  function patchEditScheduleDay(dayKey, patch) {
    setEditForm((f) => {
      if (!f?.weeklySchedule) return f;
      return {
        ...f,
        weeklySchedule: {
          ...f.weeklySchedule,
          [dayKey]: { ...f.weeklySchedule[dayKey], ...patch },
        },
      };
    });
  }

  async function submitEditModal(e) {
    e.preventDefault();
    if (!editForm) return;
    const name = editForm.name.trim();
    const role = editForm.role.trim();
    const filial = String(editForm.filial ?? "").trim() || t("employees.defaultBranch");
    if (!name || !role) return;
    const ws = editForm.weeklySchedule;
    if (!ws) return;
    for (const { key, labelKey } of WEEKDAY_KEYS) {
      const day = ws[key];
      if (day.work && (!day.start?.trim() || !day.end?.trim())) {
        window.alert(t("validation.shiftTimesRequired", { day: t(labelKey) }));
        return;
      }
    }
    const id = editForm.id;
    const mon = ws.mon;
    const current = employees.find((employee) => employee.id === id);
    const shiftStart = mon?.start || current?.shiftStart || "09:00";
    const shiftEnd = mon?.end || current?.shiftEnd || "18:00";
    try {
      const updated = await api.updateEmployee(id, {
        name,
        role,
        filial,
        shiftStart,
        shiftEnd,
        weeklySchedule: JSON.parse(JSON.stringify(ws)),
      });
      setEmployees((prev) => prev.map((employee) => (employee.id === id ? migrateEmployeeSchedule(updated) : employee)));
      closeEditModal();
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  async function deleteEmployee(id) {
    if (!window.confirm(t("confirm.deleteEmployee"))) return;
    try {
      await api.deleteEmployee(id);
      setEmployees((prev) => prev.filter((employee) => employee.id !== id));
      setAttendanceRecords((prev) => prev.filter((record) => !sameEmployeeId(record.employeeId, id)));
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  async function checkIn(employee) {
    const g = resolveLateGraceForEmployee(employee, salaryPolicy, salaryPolicyEmployeeOverrides);
    const attendance = getEmployeeAttendance(employee, attendanceRecords, selectedDate, g);
    if (attendance.openSegment && isStillCheckedIn(attendance.openSegment)) {
      window.alert(t("alerts.alreadyCheckedIn"));
      return;
    }

    const sched = getShiftForDate(employee, selectedDate);
    if (!sched.work) {
      window.alert(t("alerts.notWorkDay"));
      return;
    }

    const checkInTime = nowTime();
    try {
      const row = await api.createAttendance({
        employeeId: employee.id,
        date: selectedDate,
        checkIn: checkInTime,
        checkOut: "",
        late: isLate(checkInTime, sched.start, g),
      });
      setAttendanceRecords((prev) => [...prev, row]);
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  function draftRoleSalariesMap(draft) {
    const map = {};
    draft.forEach(({ role, salary, type }) => {
      const r = role.trim();
      if (!r) return;
      const n = parseSumInput(salary);
      const t = type && String(type).trim() ? String(type).trim() : "oy";
      map[r] = { amount: n == null ? 0 : n, type: t };
    });
    return map;
  }

  function openSalaryModal() {
    const source = userRole === "admin" ? employeesForRole : employees;
    const employeeRoles = [...new Set((source || []).map((e) => (e?.role ? String(e.role).trim() : "")).filter(Boolean))];
    const salaryRoles = Object.keys(roleSalaries || {})
      .map((r) => String(r).trim())
      .filter(Boolean);

    const orderedRoles = [];
    const seen = new Set();
    for (const r of employeeRoles) {
      if (seen.has(r)) continue;
      seen.add(r);
      orderedRoles.push(r);
    }
    for (const r of salaryRoles) {
      if (seen.has(r)) continue;
      seen.add(r);
      orderedRoles.push(r);
    }

    const rows =
      orderedRoles.length > 0
        ? orderedRoles.map((role) => {
            const v = roleSalaries?.[role];
            if (typeof v === "number") return { role, salary: String(v), type: "oy" };
            const amount = v && typeof v === "object" ? v.amount ?? v.salary ?? 0 : 0;
            const type = v && typeof v === "object" ? v.type ?? v.salary_type ?? "oy" : "oy";
            return { role, salary: String(amount), type: String(type || "oy") };
          })
        : [{ role: "", salary: "", type: "oy" }];
    setRoleSalaryDraft(rows);
    setEmployeeOverrideDraft(
      (userRole === "admin" ? employeesForRole : employees).map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role,
        value:
          employeeSalaryOverrides[String(e.id)] != null
            ? (() => {
                const v = employeeSalaryOverrides[String(e.id)];
                if (typeof v === "number") return String(v);
                const amount = v && typeof v === "object" ? v.amount ?? v.salary ?? 0 : "";
                return String(amount);
              })()
            : "",
        type:
          employeeSalaryOverrides[String(e.id)] != null
            ? (() => {
                const v = employeeSalaryOverrides[String(e.id)];
                if (typeof v === "number") return "oy";
                return (v && typeof v === "object" ? v.type ?? v.salary_type ?? "oy" : "oy") || "oy";
              })()
            : "oy",
      }))
    );
    setSalaryModalTab("role");
    setSalaryModalOpen(true);
  }

  async function saveSalarySettings() {
    const nextRoles = {};
    roleSalaryDraft.forEach(({ role, salary, type }) => {
      const r = role.trim();
      if (!r) return;
      const n = parseSumInput(salary);
      const t = type && String(type).trim() ? String(type).trim() : "oy";
      nextRoles[r] = { amount: n == null ? 0 : n, type: t };
    });

    const nextOverrides = { ...employeeSalaryOverrides };
    employeeOverrideDraft.forEach(({ id, value, type }) => {
      const oid = String(id);
      const n = parseSumInput(value);
      const t = type && String(type).trim() ? String(type).trim() : "oy";
      if (n == null) delete nextOverrides[oid];
      else nextOverrides[oid] = { amount: n, type: t };
    });
    setSalarySaveBusy(true);
    try {
      await api.putRoleSalaries(nextRoles);
      await api.putSalaryOverrides(nextOverrides);
      setRoleSalaries(nextRoles);
      setEmployeeSalaryOverrides(nextOverrides);
      setSalaryModalOpen(false);
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setSalarySaveBusy(false);
    }
  }

  async function checkOut(employee) {
    const g = resolveLateGraceForEmployee(employee, salaryPolicy, salaryPolicyEmployeeOverrides);
    const attendance = getEmployeeAttendance(employee, attendanceRecords, selectedDate, g);
    if (!attendance.openSegment) {
      window.alert(t("alerts.notCheckedIn"));
      return;
    }

    const cur = attendance.openSegment;
    const checkOutTime = nowTime();
    try {
      const row = await api.updateAttendance(cur.id, { checkOut: checkOutTime });
      setAttendanceRecords((prev) => prev.map((record) => (record.id === cur.id ? row : record)));
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  function getEmployeeNameById(id) {
    if (id == null) return "";
    const eid = Number(id);
    if (!Number.isFinite(eid)) return "";
    const emp = employees.find((e) => e.id === eid);
    return emp?.name || "";
  }

  async function refreshUsers() {
    try {
      setUsersBusy(true);
      setUsersError(null);
      const d = await api.getUsers();
      setUsers(Array.isArray(d?.users) ? d.users : []);
    } catch (err) {
      setUsersError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setUsersBusy(false);
    }
  }

  function toDateOnlyValue(v) {
    if (v == null || v === "") return "";
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isFinite(d.getTime())) return "";
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function toLocalDatetimeLocalValue(v) {
    if (v == null || v === "") return "";
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isFinite(d.getTime())) return "";
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toJsonText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function formatDbValue(v) {
    if (v == null) return "";
    if (typeof v === "object") {
      if (v instanceof Date) return v.toISOString();
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    return String(v);
  }

  async function refreshDbTable() {
    if (activeMenu !== "Baza") return;
    if (userRole !== "superadmin") return;
    if (!dbMeta) return;
    const params = {};
    if (dbAdminFilterId) params.adminId = dbAdminFilterId;
    if (dbEmployeeFilterId) params.employeeId = dbEmployeeFilterId;
    const d = await api.getDbTable(dbTable, params);
    setDbColumns(Array.isArray(d?.columns) ? d.columns : []);
    setDbRows(Array.isArray(d?.rows) ? d.rows : []);
  }

  function openDbEditModal(row) {
    if (!dbTableCfg) return;
    const pkName = dbTableCfg.pk.name;
    const pkVal = row[pkName];
    setDbEditError(null);
    setDbEditBusy(false);
    setDbEditTable(dbTable);
    setDbEditPkVal(String(pkVal ?? ""));
    const draft = {};
    const editableCols = Array.isArray(dbTableCfg.columns) ? dbTableCfg.columns.filter((c) => c.editable) : [];
    for (const c of editableCols) {
      const colName = c.name;
      const colType = c.type;
      const raw = row[colName];
      if (colType === "jsonb") draft[colName] = toJsonText(raw);
      else if (colType === "timestamptz") draft[colName] = toLocalDatetimeLocalValue(raw);
      else if (colType === "date") draft[colName] = toDateOnlyValue(raw);
      else if (colType === "boolean") draft[colName] = !!raw;
      else draft[colName] = raw == null ? "" : String(raw);
    }
    setDbEditDraft(draft);
    setDbEditOpen(true);
  }

  function closeDbEditModal() {
    setDbEditOpen(false);
    setDbEditBusy(false);
    setDbEditError(null);
    setDbEditTable("");
    setDbEditPkVal("");
    setDbEditDraft({});
  }

  async function submitDbEdit(e) {
    e.preventDefault();
    if (!dbEditTable || !dbEditPkVal) return;
    const cfg = Array.isArray(dbMeta?.tables) ? dbMeta.tables.find((t) => t.name === dbEditTable) : null;
    if (!cfg) return;
    const editableCols = Array.isArray(cfg.columns) ? cfg.columns.filter((c) => c.editable) : [];
    const data = {};
    for (const c of editableCols) {
      if (dbEditDraft && c.name in dbEditDraft) data[c.name] = dbEditDraft[c.name];
    }
    try {
      setDbEditBusy(true);
      setDbEditError(null);
      await api.updateDbRow(dbEditTable, dbEditPkVal, data);
      closeDbEditModal();
      await refreshDbTable();
    } catch (err) {
      setDbEditError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setDbEditBusy(false);
    }
  }

  async function deleteDbRow(table, pkVal) {
    const ok = window.confirm(t("confirm.deleteDbRow"));
    if (!ok) return;
    try {
      setDbBusy(true);
      setDbError(null);
      await api.deleteDbRow(table, pkVal);
      setDbSelectedPks((prev) => prev.filter((x) => String(x) !== String(pkVal)));
      await refreshDbTable();
    } catch (err) {
      setDbError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setDbBusy(false);
    }
  }

  async function deleteDbRowsBulk(table, pks) {
    const list = Array.isArray(pks) ? pks.map((x) => String(x)).filter((x) => x) : [];
    if (list.length === 0) return;
    const ok = window.confirm(t("confirm.deleteDbBulk", { n: list.length }));
    if (!ok) return;
    try {
      setDbBusy(true);
      setDbError(null);
      await api.bulkDeleteDbRows(table, list);
      setDbSelectedPks([]);
      await refreshDbTable();
    } catch (err) {
      setDbError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setDbBusy(false);
    }
  }

  async function handleCreateUser() {
    const username = window.prompt(t("admin.promptLogin"));
    if (!username) return;
    const password = window.prompt(t("admin.promptPassword"));
    if (!password) return;

    const role = window.prompt(t("admin.promptRole"), "admin")?.trim();
    if (!role) return;

    let employeeId = null;
    if (role === "hodim") {
      const eidIn = window.prompt(t("admin.promptEmployeeId"));
      const eid = Number.parseInt(eidIn || "", 10);
      if (!Number.isFinite(eid)) {
        window.alert(t("validation.employeeIdNumeric"));
        return;
      }
      employeeId = eid;
    }

    try {
      await api.createUser({ username: username.trim(), password, role, employeeId });
      await refreshUsers();
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  function openCreateUserModal() {
    setUserCreateError(null);
    setUserCreateBusy(false);
    setUserCreateFilialInput("");
    setUserCreateForm({
      username: "",
      password: "",
      role: "admin",
      employeeId: "",
      filials: [],
    });
    setUserCreateModalOpen(true);
  }

  function closeCreateUserModal() {
    setUserCreateModalOpen(false);
    setUserCreateBusy(false);
    setUserCreateError(null);
    setUserCreateFilialInput("");
  }

  async function submitCreateUser(e) {
    e.preventDefault();
    const username = userCreateForm.username.trim();
    const password = userCreateForm.password.trim();
    const role = userCreateForm.role;

    if (!username || !password) {
      setUserCreateError(t("validation.loginPasswordRequired"));
      return;
    }

    let employeeId = null;
    if (role === "hodim") {
      const eid = Number.parseInt(userCreateForm.employeeId, 10);
      if (!Number.isFinite(eid)) {
        setUserCreateError(t("validation.employeeIdRequiredCreate"));
        return;
      }
      employeeId = eid;
    }

    try {
      setUserCreateBusy(true);
      setUserCreateError(null);
      const body = { username, password, role, employeeId };
      if (role === "admin") body.filials = Array.isArray(userCreateForm.filials) ? userCreateForm.filials : [];
      await api.createUser(body);
      await refreshUsers();
      closeCreateUserModal();
    } catch (err) {
      setUserCreateError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setUserCreateBusy(false);
    }
  }

  async function openEditUserModal(u) {
    setUserEditError(null);
    setUserEditBusy(false);
    setUserEditFilialInput("");
    setUserEditForm({
      id: u.id,
      role: u.role,
      employeeId: u.employee_id != null ? String(u.employee_id) : "",
      password: "",
      filials: [],
    });
    setUserEditModalOpen(true);
    if (u.role === "admin") {
      setUserEditFilialsLoading(true);
      try {
        const d = await api.getUserFilials(u.id);
        setUserEditForm((f) => ({
          ...f,
          filials: Array.isArray(d?.filials) ? d.filials : [],
        }));
      } catch (err) {
        setUserEditError(translateApiError(err instanceof Error ? err.message : String(err), locale));
      } finally {
        setUserEditFilialsLoading(false);
      }
    }
  }

  function closeEditUserModal() {
    setUserEditModalOpen(false);
    setUserEditBusy(false);
    setUserEditError(null);
    setUserEditFilialsLoading(false);
    setUserEditFilialInput("");
  }

  async function submitEditUser(e) {
    e.preventDefault();
    if (!userEditForm.id) return;
    const role = userEditForm.role;

    let employeeId = null;
    if (role === "hodim") {
      const eid = Number.parseInt(userEditForm.employeeId, 10);
      if (!Number.isFinite(eid)) {
        setUserEditError(t("validation.employeeIdPickEdit"));
        return;
      }
      employeeId = eid;
    }

    const payload = { role };
    if (role === "hodim") payload.employeeId = employeeId;

    const pw = userEditForm.password.trim();
    if (pw) payload.password = pw;

    try {
      setUserEditBusy(true);
      setUserEditError(null);
      await api.updateUser(userEditForm.id, payload);
      if (role === "admin") {
        await api.putUserFilials(userEditForm.id, Array.isArray(userEditForm.filials) ? userEditForm.filials : []);
      }
      await refreshUsers();
      closeEditUserModal();
    } catch (err) {
      setUserEditError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setUserEditBusy(false);
    }
  }

  function openUserSubscriptionModal(u) {
    setUserSubscriptionError(null);
    setUserSubscriptionBusy(false);
    setUserSubscriptionUserId(u.id);
    const defaultTemplate = t("admin.subscriptionNoticeDefault");
    const end = u.subscription_end ? new Date(u.subscription_end) : null;
    let endValue = "";
    if (end && Number.isFinite(end.getTime())) {
      const pad = (x) => String(x).padStart(2, "0");
      endValue = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
    }
    const storedText =
      u.subscription_notice_template && String(u.subscription_notice_template).trim()
        ? String(u.subscription_notice_template)
        : defaultTemplate;
    setUserSubscriptionForm({
      endAt: endValue,
      amount: u.subscription_amount != null ? String(u.subscription_amount) : "",
      text: storedText,
    });
    setUserSubscriptionModalOpen(true);
  }

  function closeUserSubscriptionModal() {
    setUserSubscriptionModalOpen(false);
    setUserSubscriptionBusy(false);
    setUserSubscriptionError(null);
    setUserSubscriptionUserId(null);
  }

  async function submitUserSubscription(e) {
    e.preventDefault();
    if (!userSubscriptionUserId) return;
    const endAt = userSubscriptionForm.endAt;
    const amount = Number.parseInt(userSubscriptionForm.amount || "", 10);
    const text = String(userSubscriptionForm.text || "").trim();
    if (!endAt) {
      setUserSubscriptionError(t("validation.subscriptionEndRequired"));
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setUserSubscriptionError(t("validation.subscriptionAmountInvalid"));
      return;
    }
    if (!text) {
      setUserSubscriptionError(t("validation.subscriptionTextRequired"));
      return;
    }
    try {
      setUserSubscriptionBusy(true);
      setUserSubscriptionError(null);
      await api.setUserSubscription(userSubscriptionUserId, endAt, amount, text);
      await refreshUsers();
      closeUserSubscriptionModal();
    } catch (err) {
      setUserSubscriptionError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setUserSubscriptionBusy(false);
    }
  }

  async function cancelUserSubscription(u) {
    const ok = window.confirm(t("confirm.cancelAdminSubscription"));
    if (!ok) return;
    try {
      await api.cancelUserSubscription(u.id);
      await refreshUsers();
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  async function handleResetPassword(userId) {
    const password = window.prompt(t("admin.promptNewPassword"));
    if (!password) return;
    try {
      await api.updateUser(userId, { password });
      await refreshUsers();
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  async function handleChangeRole(userId) {
    const role = window.prompt(t("admin.promptRole"), "admin")?.trim();
    if (!role) return;
    let employeeId = null;
    if (role === "hodim") {
      const eidIn = window.prompt(t("admin.promptEmployeeId"));
      const eid = Number.parseInt(eidIn || "", 10);
      if (!Number.isFinite(eid)) {
        window.alert(t("validation.employeeIdNumeric"));
        return;
      }
      employeeId = eid;
    }

    try {
      await api.updateUser(userId, { role, employeeId });
      await refreshUsers();
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  async function handleDeleteUser(userId) {
    const ok = window.confirm(t("confirm.deleteUser"));
    if (!ok) return;
    try {
      await api.deleteUser(userId);
      await refreshUsers();
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    }
  }

  const terminalAdminOptions = useMemo(
    () => (Array.isArray(users) ? users.filter((u) => u.role === "admin") : []),
    [users]
  );

  function openCreateTerminalModal() {
    setTerminalSaveError("");
    setTerminalForm({
      terminalName: "",
      adminId: terminalAdminOptions[0]?.id != null ? String(terminalAdminOptions[0].id) : "",
      terminalType: "Kirish",
      ipAddress: "",
      login: "",
      password: "",
    });
    setTerminalModalOpen(true);
  }

  async function submitTerminalForm(e) {
    e.preventDefault();
    const terminalName = String(terminalForm.terminalName || "").trim();
    const adminId = String(terminalForm.adminId || "").trim();
    const terminalType = terminalForm.terminalType === "Chiqish" ? "Chiqish" : "Kirish";
    const ipAddress = String(terminalForm.ipAddress || "").trim();
    const login = String(terminalForm.login || "").trim();
    const password = String(terminalForm.password || "").trim();
    if (!terminalName || !adminId || !ipAddress || !login || !password) {
      setTerminalSaveError(t("terminal.validationRequired"));
      return;
    }
    if (!isValidIpAddress(ipAddress)) {
      setTerminalSaveError(t("terminal.validationIp"));
      return;
    }
    try {
      setTerminalSaveBusy(true);
      setTerminalSaveError("");
      await api.createTerminal({
        terminalName,
        adminId,
        terminalType,
        ipAddress,
        login,
        password,
      });
      const d = await api.getTerminals();
      setTerminals(Array.isArray(d?.terminals) ? d.terminals : []);
      setTerminalModalOpen(false);
    } catch (err) {
      setTerminalSaveError(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setTerminalSaveBusy(false);
    }
  }

  async function runTerminalConnectionTest(row) {
    if (!row?.id) return;
    setTerminalProbeName(String(row.terminal_name || "").trim() || `#${row.id}`);
    setTerminalProbeResult(null);
    setTerminalProbeOpen(true);
    setTerminalProbeBusy(true);
    try {
      const r = await api.testTerminalConnection(row.id);
      setTerminalProbeResult(r && typeof r === "object" ? r : { ok: false, error: String(r), steps: [] });
    } catch (err) {
      setTerminalProbeResult({
        ok: false,
        error: translateApiError(err instanceof Error ? err.message : String(err), locale),
        steps: [],
        baseUrl: null,
      });
    } finally {
      setTerminalProbeBusy(false);
    }
  }

  function closeTerminalProbeModal() {
    setTerminalProbeOpen(false);
    setTerminalProbeBusy(false);
    setTerminalProbeResult(null);
    setTerminalProbeName("");
  }

  async function pullEmployeesFromTerminals() {
    if (userRole !== "admin") return;
    setTerminalSyncBusy(true);
    try {
      const r = await api.syncAllTerminalsEmployees();
      const d = await api.bootstrap();
      if (d?.employees) {
        setEmployees(Array.isArray(d.employees) ? d.employees.map(migrateEmployeeSchedule) : []);
      }
      if (d?.attendanceRecords) {
        setAttendanceRecords(Array.isArray(d.attendanceRecords) ? d.attendanceRecords : []);
      }
      window.alert(
        t("employees.terminalSyncSummary", {
          created: r.created ?? 0,
          updated: r.updated ?? 0,
          terminals: r.terminalCount ?? 0,
        })
      );
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setTerminalSyncBusy(false);
    }
  }

  async function syncTerminalEmployeesFromTable(row) {
    if (!row?.id) return;
    setTerminalTableSyncBusyId(row.id);
    try {
      const r = await api.syncTerminalEmployees(row.id);
      window.alert(
        t("employees.terminalSyncSummarySingle", {
          created: r.created ?? 0,
          updated: r.updated ?? 0,
          total: r.total ?? 0,
        })
      );
    } catch (err) {
      window.alert(translateApiError(err instanceof Error ? err.message : String(err), locale));
    } finally {
      setTerminalTableSyncBusyId(null);
    }
  }

  if (!authToken) {
    return (
      <div className="page theme-light login-page" style={{ "--login-bg-image": `url(${loginBgImage})` }}>
        <div className="login-card">
          <div className="login-logo-wrap">
            <img src={logoImage} alt="Logo" className="login-logo-image" />
          </div>
          <form className="login-form" onSubmit={submitLogin}>
            <div className="login-field">
              <label htmlFor="login-name">{t("login.loginLabel")}</label>
              <input
                id="login-name"
                autoComplete="username"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                placeholder={t("login.placeholderUser")}
              />
            </div>
            <div className="login-field">
              <label htmlFor="login-pass">{t("login.passwordLabel")}</label>
              <input
                id="login-pass"
                type="password"
                autoComplete="current-password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                placeholder={t("login.placeholderPass")}
              />
            </div>
            {loginError ? <p className="login-err">{loginError}</p> : null}
            <button type="submit" className="login-submit" disabled={loginBusy}>
              {loginBusy ? t("login.wait") : t("login.submit")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={`page theme-light app-bootstrap`}>
        <div className="app-bootstrap-inner">
          <p className="app-bootstrap-title">{t("bootstrap.dbErrorTitle")}</p>
          <p className="app-bootstrap-msg">{loadError}</p>
          <p className="app-bootstrap-hint">{t("bootstrap.dbErrorHint")}</p>
          <button type="button" className="login-submit login-submit-inline" onClick={logout}>
            {t("sidebar.logout")}
          </button>
        </div>
      </div>
    );
  }

  if (!dataReady) {
    return (
      <div className={`page theme-${theme} app-bootstrap`}>
        <div className="app-bootstrap-inner">
          <p className="app-bootstrap-title">{t("bootstrap.loading")}</p>
        </div>
      </div>
    );
  }

  const isHodim = userRole === "hodim";
  const canManageEmployees = userRole === "superadmin" || (userRole === "admin" && !adminSubLocked);
  const showEmployeeAttendanceGrid =
    (activeMenu === "Hodimlar" && canManageEmployees) || (activeMenu === "Hisobot" && (isHodim || canManageEmployees));
  const showHodimlarWorkActions = activeMenu === "Hodimlar" && canManageEmployees;

  const dbTableCfg = Array.isArray(dbMeta?.tables) ? dbMeta.tables.find((t) => t.name === dbTable) : null;
  const dbPkName = dbTableCfg?.pk?.name || "";
  const dbAllPkVals = dbPkName && Array.isArray(dbRows) ? dbRows.map((r) => r?.[dbPkName]).filter((x) => x != null).map((x) => String(x)) : [];
  const dbAllSelected = dbAllPkVals.length > 0 && dbAllPkVals.every((x) => dbSelectedPks.includes(x));

  return (
    <div className={`page theme-${theme} ui-${uiDensity}`}>
      <aside className="sidebar scroll-modern">
        <div>
          <div className="profile">
            <div className="profile-brand">
              <img src={brandLogo} alt="RestoControl" className="profile-brand-logo" />
              <div className="profile-brand-text">
                <h4 className="profile-brand-title">RestoControl</h4>
                <p className="profile-brand-subtitle">{sessionUser || "Administrator"}</p>
              </div>
            </div>
          </div>
          <div className="sidebar-divider" aria-hidden="true" />

          <nav className="menu">
              {(
                userRole === "superadmin"
                  ? ["Adminlar", "Terminallar", "Baza", "Sozlamalar"]
                  : isHodim
                    ? menuItems.filter((i) => i !== "Hodimlar")
                    : menuItems
              ).map((item) => {
                const Icon = menuIcons[item] || LayoutDashboard;
                const path = menuI18nPath(item);
                return (
                  <button
                    key={item}
                    className={`menu-item ${activeMenu === item ? "active" : ""}`}
                    type="button"
                    onClick={() => setActiveMenu(item)}
                  >
                    <Icon size={14} />
                    {path ? t(path) : item}
                    <span className="right">
                      <ChevronRight size={14} />
                    </span>
                  </button>
                );
              })}
          </nav>
        </div>

        <div className="bottom-links">
          <button
            type="button"
            className="bottom-link-support"
            aria-label={t("menu.notice")}
            title={t("menu.notice")}
            onClick={() => setActiveMenu("Bildirishnoma")}
          >
            <Bell size={15} />
            {unreadSubscriptionNoticeCount > 0 ? (
              <span className="notice-badge" aria-label={`${unreadSubscriptionNoticeCount}`}>
                {unreadSubscriptionNoticeCount > 99 ? "99+" : unreadSubscriptionNoticeCount}
              </span>
            ) : null}
          </button>
          <button type="button" className="bottom-link-logout" onClick={logout}>
            <LogOut size={15} /> {t("sidebar.logout")}
          </button>
        </div>
      </aside>

      <main className="content scroll-modern">
        {activeMenu === "Hodimlar" || activeMenu === "Hisobot" ? (
          <section className="heading-row">
            <div className="heading-titles">
              <h2>{menuI18nPath(activeMenu) ? t(menuI18nPath(activeMenu)) : activeMenu}</h2>
              {activeMenu === "Hodimlar" ? (
                <p className="page-subtitle">
                  <Users size={14} strokeWidth={1.75} className="page-subtitle-icon" aria-hidden />
                  {filialFilter === "all" ? t("common.allBranches") : filialFilter}
                  <span className="page-subtitle-sep"> · </span>
                  <span className="page-subtitle-muted">{selectedDate}</span>
                </p>
              ) : null}
              {activeMenu === "Hisobot" ? (
                <p className="page-subtitle">
                  <Wallet size={14} strokeWidth={1.75} className="page-subtitle-icon" aria-hidden />
                  {formatMonthHeading(salaryReportMonth, locale)}
                  <span className="page-subtitle-sep"> · </span>
                  <span className="page-subtitle-muted">{t("report.salaryReportLine")}</span>
                </p>
              ) : null}
            </div>
            {activeMenu === "Hodimlar" && canManageEmployees ? (
              <div className="content-toolbar">
                <div className="filters">
                  <button
                    className="filters-salary-btn"
                    type="button"
                    onClick={openSalaryModal}
                    aria-label={t("employees.salaryTitle")}
                    title={t("employees.salaryTitle")}
                  >
                    <Wallet size={15} strokeWidth={1.75} />
                  </button>
                  {userRole === "admin" ? (
                    <button
                      className="add-icon-btn"
                      type="button"
                      disabled={terminalSyncBusy}
                      onClick={() => pullEmployeesFromTerminals()}
                      aria-label={t("employees.terminalSyncAria")}
                      title={t("employees.terminalSyncTitle")}
                    >
                      <Download size={15} strokeWidth={2} />
                    </button>
                  ) : null}
                  <select
                    className="date-input filial-filter"
                    aria-label={t("employees.filterFilial")}
                    value={filialFilter}
                    onChange={(e) => setFilialFilter(e.target.value)}
                  >
                    <option value="all">{t("common.allBranches")}</option>
                    {filialOptions.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <input className="date-input" type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
                </div>
              </div>
            ) : activeMenu === "Hisobot" && canManageEmployees ? (
              <div className="content-toolbar">
                <div className="filters filters-report-bar filters-salary-report">
                  <button
                    className="filters-salary-btn"
                    type="button"
                    onClick={() => {
                      setMassPayModalOpen(true);
                      setMassPayError("");
                      setMassPayFilial(filialFilter);
                      setMassPayOnlyDebtors(true);
                      setMassPaySelectedEmployeeIds([]);
                      const monthDays = eachDateStrInMonth(salaryReportMonth);
                      setMassPayDateFrom(`${salaryReportMonth}-01`);
                      setMassPayDateTo(monthDays.length > 0 ? monthDays[monthDays.length - 1] : `${salaryReportMonth}-01`);
                    }}
                    aria-label={t("report.massPayOpenAria")}
                    title={t("report.massPayOpenAria")}
                  >
                    <Wallet size={15} strokeWidth={1.75} />
                  </button>
                  <input
                    className="date-input report-month-input"
                    type="month"
                    aria-label={t("report.monthFieldAria")}
                    value={salaryReportMonth}
                    onChange={(e) => setSalaryReportMonth(e.target.value)}
                  />
                  <select
                    className="date-input filial-filter"
                    aria-label={t("employees.filterFilial")}
                    value={filialFilter}
                    onChange={(e) => setFilialFilter(e.target.value)}
                  >
                    <option value="all">{t("common.allBranches")}</option>
                    {filialOptions.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : isHodim && activeMenu === "Hisobot" ? (
              <div className="content-toolbar">
                <div className="filters filters-report-bar filters-salary-report">
                  <input
                    className="date-input report-month-input"
                    type="month"
                    aria-label={t("report.monthFieldAria")}
                    value={salaryReportMonth}
                    onChange={(e) => setSalaryReportMonth(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {showEmployeeAttendanceGrid ? (
          <>
            {activeMenu === "Hisobot" && salaryReportBreakdown ? (
              <div className="salary-breakdown-row scroll-modern">
                <section
                  className="cards cards-salary-report cards-salary-breakdown"
                  aria-label={t("report.breakdownAria")}
                >
                  <button
                    type="button"
                    className={`card salary-report-card salary-report-card-total${salaryReportSegment === "all" ? " active" : ""}`}
                    onClick={() => setSalaryReportSegment("all")}
                    aria-pressed={salaryReportSegment === "all"}
                    title={t("report.segTotalTitle")}
                  >
                    <p>{t("report.segTotal", { n: salaryReportBreakdown.all.n })}</p>
                    <span className="salary-breakdown-amount">
                      {fmtMoney(salaryReportBreakdown.all.sum)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`card salary-report-card${salaryReportSegment === "with_pay" ? " active" : ""}`}
                    onClick={() =>
                      setSalaryReportSegment((prev) => (prev === "with_pay" ? "all" : "with_pay"))
                    }
                    aria-pressed={salaryReportSegment === "with_pay"}
                    title={t("report.segWithPayTitle")}
                  >
                    <p>{t("report.segWithPay", { n: salaryReportBreakdown.with_pay.n })}</p>
                    <span className="salary-breakdown-amount">
                      {fmtMoney(salaryReportBreakdown.with_pay.sum)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`card salary-report-card${salaryReportSegment === "soat" ? " active" : ""}`}
                    onClick={() => setSalaryReportSegment((prev) => (prev === "soat" ? "all" : "soat"))}
                    aria-pressed={salaryReportSegment === "soat"}
                    title={t("report.segHourlyTitle")}
                  >
                    <p>{t("report.segHourly", { n: salaryReportBreakdown.soat.n })}</p>
                    <span className="salary-breakdown-amount">
                      {fmtMoney(salaryReportBreakdown.soat.sum)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`card salary-report-card${salaryReportSegment === "kun" ? " active" : ""}`}
                    onClick={() => setSalaryReportSegment((prev) => (prev === "kun" ? "all" : "kun"))}
                    aria-pressed={salaryReportSegment === "kun"}
                    title={t("report.segDailyTitle")}
                  >
                    <p>{t("report.segDaily", { n: salaryReportBreakdown.kun.n })}</p>
                    <span className="salary-breakdown-amount">
                      {fmtMoney(salaryReportBreakdown.kun.sum)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`card salary-report-card${salaryReportSegment === "hafta" ? " active" : ""}`}
                    onClick={() => setSalaryReportSegment((prev) => (prev === "hafta" ? "all" : "hafta"))}
                    aria-pressed={salaryReportSegment === "hafta"}
                    title={t("report.segWeeklyTitle")}
                  >
                    <p>{t("report.segWeekly", { n: salaryReportBreakdown.hafta.n })}</p>
                    <span className="salary-breakdown-amount">
                      {fmtMoney(salaryReportBreakdown.hafta.sum)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`card salary-report-card${salaryReportSegment === "oy" ? " active" : ""}`}
                    onClick={() => setSalaryReportSegment((prev) => (prev === "oy" ? "all" : "oy"))}
                    aria-pressed={salaryReportSegment === "oy"}
                    title={t("report.segMonthlyTitle")}
                  >
                    <p>{t("report.segMonthly", { n: salaryReportBreakdown.oy.n })}</p>
                    <span className="salary-breakdown-amount">
                      {fmtMoney(salaryReportBreakdown.oy.sum)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`card salary-report-card${salaryReportSegment === "finished" ? " active" : ""}`}
                    onClick={() =>
                      setSalaryReportSegment((prev) => (prev === "finished" ? "all" : "finished"))
                    }
                    aria-pressed={salaryReportSegment === "finished"}
                    title={t("report.segFinishedTitle")}
                  >
                    <p>{t("report.segFinished", { n: salaryReportBreakdown.finished.n })}</p>
                    <span className="salary-breakdown-amount">
                      {fmtMoney(salaryReportBreakdown.finished.sum)}
                    </span>
                  </button>
                </section>
              </div>
            ) : (
              <section className="cards" aria-label={t("attendance.filterCardsAria")}>
                <button
                  type="button"
                  className={`card ${cardFilter === "all" ? "active" : ""}`}
                  onClick={() => setCardFilter("all")}
                >
                  <p>{t("dashboard.totalEmployees")}</p>
                  <h3>{stats.total}</h3>
                </button>
                <button
                  type="button"
                  className={`card ${cardFilter === "Ishda" ? "active" : ""}`}
                  onClick={() => setCardFilter("Ishda")}
                >
                  <p>{t("dashboard.atWorkNow")}</p>
                  <h3>{stats.atWork}</h3>
                </button>
                <button
                  type="button"
                  className={`card ${cardFilter === "Kechikkan" ? "active" : ""}`}
                  onClick={() => setCardFilter("Kechikkan")}
                >
                  <p>{t("dashboard.late")}</p>
                  <h3>{stats.late}</h3>
                </button>
                <button
                  type="button"
                  className={`card ${cardFilter === "Ketgan" ? "active" : ""}`}
                  onClick={() => setCardFilter("Ketgan")}
                >
                  <p>{t("dashboard.left")}</p>
                  <h3>{stats.gone}</h3>
                </button>
                <button
                  type="button"
                  className={`card ${cardFilter === "Kelmagan" ? "active" : ""}`}
                  onClick={() => setCardFilter("Kelmagan")}
                >
                  <p>{t("dashboard.absent")}</p>
                  <h3>{stats.absent}</h3>
                </button>
              </section>
            )}

            <section className={`table-wrap scroll-modern${activeMenu === "Hisobot" ? " report-table-panel" : ""}`}>
              <table>
                <thead>
                  <tr>
                    <th>{t("table.employee")}</th>
                    <th>{t("table.role")}</th>
                    {activeMenu === "Hisobot" ? (
                      <>
                        <th>{t("table.rate")}</th>
                        <th className="salary-worked-hours-head">{t("table.hoursWorked")}</th>
                        <th>{t("table.calculatedPay")}</th>
                        <th>{t("table.paidDays")}</th>
                        <th>{t("table.branch")}</th>
                      </>
                    ) : (
                      <>
                        <th>{t("table.salary")}</th>
                        <th>{t("table.branch")}</th>
                        <th>{t("table.shift")}</th>
                        <th>{t("table.status")}</th>
                        <th className="th-check-in-out">
                          <span className="check-in-out-cell-pair check-in-out-header-pair">
                            <span className="check-in-out-part check-in-out-part-in">{t("attendance.colCheckIn")}</span>
                            <span className="check-in-out-sep" aria-hidden="true">
                              {" / "}
                            </span>
                            <span className="check-in-out-part check-in-out-part-out">{t("attendance.colCheckOut")}</span>
                          </span>
                        </th>
                      </>
                    )}
                    {showHodimlarWorkActions ? <th className="actions-head">{t("common.actions")}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.map((employee) => {
                    const empFilial = getEmployeeFilialRaw(employee);
                    const cfg =
                      empFilial === salaryCalcSelectedFilial
                        ? {
                            weekMode: salaryCalcWeekMode,
                            weekFixed: salaryCalcWeekFixed,
                            monthMode: salaryCalcMonthMode,
                            monthFixed: salaryCalcMonthFixed,
                            attendanceMode: salaryCalcAttendanceMode,
                          }
                        : salaryCalcConfigsByFilial?.[empFilial] || salaryCalcDefaultConfig;
                    const rowGrace = resolveLateGraceForEmployee(employee, salaryPolicy, salaryPolicyEmployeeOverrides);
                    const attendance = getEmployeeAttendance(employee, attendanceRecords, selectedDate, rowGrace);
                    const rate = getEmployeeSalary(employee, roleSalaries, employeeSalaryOverrides);
                    const hasOverride = employeeSalaryOverrides[String(employee.id)] != null;
                    const payDay = getEmployeeEarnedSalary(
                      employee,
                      selectedDate,
                      attendance,
                      roleSalaries,
                      employeeSalaryOverrides,
                      cfg
                    );
                    const payMonth = sumEarnedSalaryInMonth(
                      employee,
                      salaryReportMonth,
                      attendanceRecords,
                      roleSalaries,
                      employeeSalaryOverrides,
                      cfg
                    );
                    const paidMonthAmount = (salaryPayments || []).reduce((acc, p) => {
                      if (!sameEmployeeId(p.employeeId, employee.id)) return acc;
                      const d = toAttendanceDateKey(p.date);
                      if (!d || !d.startsWith(salaryReportMonth)) return acc;
                      const amt = Number(p.amount);
                      return acc + (Number.isFinite(amt) ? Math.max(0, Math.trunc(amt)) : 0);
                    }, 0);
                    const bonusByDate = new Map();
                    const fineByDate = new Map();
                    const advanceByDate = new Map();
                    for (const adj of salaryAdjustments || []) {
                      if (!sameEmployeeId(adj.employeeId, employee.id)) continue;
                      const d = toAttendanceDateKey(adj.date);
                      if (!d || !d.startsWith(salaryReportMonth)) continue;
                      const amt = Math.max(0, Math.trunc(Number(adj.amount) || 0));
                      const kind = normalizeAdjustmentKind(adj.kind);
                      if (kind === "fine") fineByDate.set(d, (fineByDate.get(d) || 0) + amt);
                      else if (kind === "advance") advanceByDate.set(d, (advanceByDate.get(d) || 0) + amt);
                      else if (kind === "bonus") bonusByDate.set(d, (bonusByDate.get(d) || 0) + amt);
                    }
                    let bonusMonth = 0;
                    let fineMonth = 0;
                    let advanceMonth = 0;
                    for (const v of bonusByDate.values()) bonusMonth += v;
                    for (const v of fineByDate.values()) fineMonth += v;
                    for (const v of advanceByDate.values()) advanceMonth += v;
                    const payMonthAdjusted = Math.max(0, payMonth + bonusMonth - fineMonth - advanceMonth);
                    const payMonthRemaining = Math.max(0, payMonthAdjusted - paidMonthAmount);
                    const isPaidSegment = salaryReportSegment === "with_pay" || salaryReportSegment === "finished";
                    const reportPayDisplay = isPaidSegment ? payMonthAdjusted : payMonthRemaining;
                    let remainingDaysInMonth = 0;
                    let paidDaysInMonth = 0;
                    let remainingWorkedHoursMonth = 0;
                    for (const dateStr of eachDateStrInMonth(salaryReportMonth)) {
                      const att = getEmployeeAttendance(employee, attendanceRecords, dateStr, 5);
                      const dayPay = getEmployeeEarnedSalary(
                        employee,
                        dateStr,
                        att,
                        roleSalaries,
                        employeeSalaryOverrides,
                        cfg
                      );
                      if (dayPay <= 0) continue;
                      const paidDateAmount = (salaryPayments || []).reduce((acc, p) => {
                        if (!sameEmployeeId(p.employeeId, employee.id)) return acc;
                        if (toAttendanceDateKey(p.date) !== dateStr) return acc;
                        const amt = Number(p.amount);
                        return acc + (Number.isFinite(amt) ? Math.max(0, Math.trunc(amt)) : 0);
                      }, 0);
                      const bonusDay = bonusByDate.get(dateStr) || 0;
                      const fineDay = fineByDate.get(dateStr) || 0;
                      const advanceDay = advanceByDate.get(dateStr) || 0;
                      const adjustedDayPay = Math.max(0, dayPay + bonusDay - fineDay - advanceDay);
                      const remainingDayPay = adjustedDayPay - paidDateAmount;
                      if (remainingDayPay > 0) {
                        remainingDaysInMonth += 1;
                        remainingWorkedHoursMonth += getWorkedHoursOnDay(employee, dateStr, att, cfg?.attendanceMode);
                      } else if (paidDateAmount > 0) {
                        paidDaysInMonth += 1;
                      }
                    }
                    const workedHoursMonth = sumWorkedHoursInMonth(
                      employee,
                      salaryReportMonth,
                      attendanceRecords,
                      cfg?.attendanceMode
                    );
                    const reportHoursDisplay = isPaidSegment ? workedHoursMonth : remainingWorkedHoursMonth;
                    const reportDaysDisplay = isPaidSegment ? paidDaysInMonth : remainingDaysInMonth;

                    if (activeMenu === "Hisobot") {
                      return (
                        <tr
                          key={employee.id}
                          className="employee-row-attendance"
                          onClick={() => {
                            setReportDetailEmployee(employee);
                            setReportDetailMonth(salaryReportMonth);
                            const seedDate = selectedDate.startsWith(salaryReportMonth)
                              ? selectedDate
                              : `${salaryReportMonth}-01`;
                            setReportDetailSelectedDate(seedDate);
                          }}
                        >
                          <td>
                            <div className="name-cell">
                              <div className={getAvatarClass(employee.name)}>{employee.name[0]}</div>
                              <div>
                                <strong>{employee.name}</strong>
                              </div>
                            </div>
                          </td>
                          <td>{employee.role}</td>
                          <td className="salary-cell salary-stavka-cell">
                            <span className="salary-amount">{rate ? fmtMoney(rate) : "—"}</span>
                            {hasOverride ? <span className="salary-badge">{t("employees.salaryBadgeCustom")}</span> : null}
                          </td>
                          <td className="salary-cell salary-worked-hours-cell">
                            <span className="salary-worked-hours">{fmtHours(reportHoursDisplay)}</span>
                          </td>
                          <td className="salary-cell">
                            <span className="salary-amount salary-amount-strong">{fmtMoney(reportPayDisplay)}</span>
                          </td>
                          <td className="salary-paid-days">{reportDaysDisplay}</td>
                          <td>{displayFilial(employee)}</td>
                        </tr>
                      );
                    }

                    const pay = payDay;
                    return (
                      <tr
                        key={employee.id}
                        className="employee-row-attendance"
                        onClick={(e) => {
                          if (!showHodimlarWorkActions) return;
                          if (e.target.closest("button")) return;
                          setAttendanceHistoryEmployee(employee);
                          setAttendanceHistoryMode("all");
                          setAttendanceHistoryDay(selectedDate);
                          setAttendanceHistoryMonth(selectedDate.slice(0, 7));
                          setAttendanceHistoryAllFilterKind("none");
                          setAttendanceHistoryAllDayValue(selectedDate);
                          setAttendanceHistoryAllMonthValue(selectedDate.slice(0, 7));
                        }}
                      >
                        <td>
                          <div className="name-cell">
                            <div className={getAvatarClass(employee.name)}>{employee.name[0]}</div>
                            <div>
                              <strong>{employee.name}</strong>
                            </div>
                          </div>
                        </td>
                        <td>{employee.role}</td>
                        <td className="salary-cell">
                          <span className="salary-amount">{fmtMoney(pay)}</span>
                          {hasOverride ? <span className="salary-badge">{t("employees.salaryBadgeCustom")}</span> : null}
                        </td>
                        <td>{displayFilial(employee)}</td>
                        <td className="schedule-table-cell">
                          {formatScheduleForTable(employee, selectedDate, t("schedule.dayOff"))}
                        </td>
                        <td>
                          <span className={attendanceClass(attendance.state)}>
                            {attendanceStateLabel(attendance.state)}
                          </span>
                        </td>
                        <td className="td-check-in-out">
                          {attendanceCheckInOutMarkup(employee, attendance.current, selectedDate, rowGrace)}
                        </td>
                        {showHodimlarWorkActions ? (
                          <td className="actions">
                            <button type="button" onClick={() => checkIn(employee)}>
                              {t("attendance.checkIn")}
                            </button>
                            <button type="button" onClick={() => checkOut(employee)}>
                              {t("attendance.checkOut")}
                            </button>
                            <button
                              type="button"
                              className="actions-icon actions-edit-btn"
                              onClick={() => openEditModal(employee.id)}
                              aria-label={t("common.edit")}
                              title={t("common.edit")}
                            >
                              <Pencil size={15} strokeWidth={1.75} />
                            </button>
                            <button
                              type="button"
                              className="actions-icon actions-delete-btn"
                              onClick={() => deleteEmployee(employee.id)}
                              aria-label={t("common.delete")}
                              title={t("common.delete")}
                            >
                              <Trash2 size={15} strokeWidth={1.75} />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                  {filteredEmployees.length === 0 ? (
                    <tr>
                      <td
                        colSpan={
                          activeMenu === "Hisobot"
                            ? 7
                            : showHodimlarWorkActions
                              ? 8
                              : 7
                        }
                        className="empty-row"
                      >
                        {t("dashboard.emptyFilter")}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </section>
          </>
        ) : null}

        {activeMenu === "Adminlar" ? (
          <section className="table-wrap journal-wrap scroll-modern">
            <div className="journal-top-row">
              <h3 className="journal-title">{t("admin.pageTitle")}</h3>
              <button
                type="button"
                className="module-right-btn"
                aria-label={t("admin.addUserAria")}
                onClick={openCreateUserModal}
              >
                <Plus size={14} strokeWidth={2} />
              </button>
            </div>

            {usersError ? <p className="login-err">{usersError}</p> : null}
            {usersBusy ? <p className="salary-hint">{t("common.loading")}</p> : null}

            {!usersBusy ? (
              <table>
                <thead>
                  <tr>
                    <th>{t("table.login")}</th>
                    <th>{t("table.userRole")}</th>
                    <th>{t("table.branches")}</th>
                    <th>{t("table.linkedEmployee")}</th>
                    <th>{t("table.subscription")}</th>
                    <th className="actions-head">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => {
                    const adminFilialList = normalizeAdminFilials(u);
                    return (
                    <tr key={u.id}>
                      <td>{u.username}</td>
                      <td>{userRoleLabel(u.role)}</td>
                      <td>
                        {u.role === "admin"
                          ? adminFilialList.length
                            ? adminFilialList.join(", ")
                            : "—"
                          : "—"}
                      </td>
                      <td>{u.role === "hodim" ? getEmployeeNameById(u.employee_id) || "—" : "—"}</td>
                      <td>
                        {u.role === "admin"
                          ? u.subscription_end
                            ? new Date(u.subscription_end).toLocaleString(localeToBcp47(locale))
                            : t("common.subscriptionNone")
                          : "—"}
                        {u.role === "admin" && u.subscription_amount != null
                          ? ` · ${Number(u.subscription_amount).toLocaleString(localeToBcp47(locale))} ${t("common.currency")}`
                          : ""}
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          className="actions-icon actions-edit-btn"
                          onClick={() => openEditUserModal(u)}
                          aria-label={t("common.edit")}
                          title={t("common.edit")}
                        >
                          <Pencil size={14} strokeWidth={1.75} />
                        </button>

                        {u.role === "admin" ? (
                          <button
                            type="button"
                            className="actions-icon"
                            onClick={() => openUserSubscriptionModal(u)}
                            aria-label={t("admin.grantSubscriptionAria")}
                            title={t("admin.grantSubscriptionAria")}
                          >
                            <Wallet size={14} strokeWidth={1.75} />
                          </button>
                        ) : null}

                        {u.role === "admin" ? (
                          <button
                            type="button"
                            className="actions-icon"
                            onClick={() => cancelUserSubscription(u)}
                            aria-label={t("admin.cancelSubscriptionAria")}
                            title={t("admin.cancelSubscriptionAria")}
                          >
                            <X size={14} strokeWidth={1.75} />
                          </button>
                        ) : null}

                        <button
                          type="button"
                          className="actions-icon actions-delete-btn"
                          onClick={() => handleDeleteUser(u.id)}
                          disabled={u.role === "superadmin"}
                          aria-label={t("common.delete")}
                          title={u.role === "superadmin" ? t("admin.cannotDeleteSuper") : t("common.delete")}
                        >
                          <Trash2 size={14} strokeWidth={1.75} />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="empty-row">
                        {t("admin.noUsers")}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            ) : null}
          </section>
        ) : !showEmployeeAttendanceGrid ? (
          activeMenu === "Terminallar" ? (
            <section className="table-wrap journal-wrap scroll-modern">
              <div className="journal-top-row">
                <h3 className="journal-title">{t("terminal.pageTitle")}</h3>
                <button
                  type="button"
                  className="module-right-btn"
                  aria-label={t("terminal.addAria")}
                  onClick={openCreateTerminalModal}
                >
                  <Plus size={14} strokeWidth={2} />
                </button>
              </div>

              {terminalsError ? <p className="login-err">{terminalsError}</p> : null}
              {terminalsBusy ? <p className="salary-hint">{t("common.loading")}</p> : null}

              {!terminalsBusy ? (
                <table>
                  <thead>
                    <tr>
                      <th>{t("terminal.name")}</th>
                      <th>{t("terminal.admin")}</th>
                      <th>{t("terminal.type")}</th>
                      <th>{t("terminal.ipAddress")}</th>
                      <th>{t("terminal.login")}</th>
                      <th>{t("terminal.password")}</th>
                      <th className="actions-head">{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {terminals.map((row) => (
                      <tr key={row.id}>
                        <td>{row.terminal_name || "—"}</td>
                        <td>{row.admin_username || "—"}</td>
                        <td>{row.terminal_type || "—"}</td>
                        <td>{row.ip_address || "—"}</td>
                        <td>{row.login || "—"}</td>
                        <td>{row.password || "—"}</td>
                        <td>
                          <div className="terminal-actions-cell">
                            <button
                              type="button"
                              className="add-icon-btn"
                              aria-label={t("terminal.testConnectionAria")}
                              title={t("terminal.testConnection")}
                              disabled={terminalProbeBusy || terminalTableSyncBusyId != null}
                              onClick={() => runTerminalConnectionTest(row)}
                            >
                              <Wifi size={15} strokeWidth={2} />
                            </button>
                            <button
                              type="button"
                              className="add-icon-btn"
                              aria-label={t("terminal.syncEmployeesAria")}
                              title={t("terminal.syncEmployees")}
                              disabled={terminalProbeBusy || terminalTableSyncBusyId === row.id}
                              onClick={() => syncTerminalEmployeesFromTable(row)}
                            >
                              <Download size={15} strokeWidth={2} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {terminals.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="empty-row">
                          {t("terminal.empty")}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              ) : null}
            </section>
          ) : activeMenu === "Baza" ? (
            <section className="table-wrap journal-wrap baza-panel scroll-modern">
              <div className="journal-top-row">
                <h3 className="journal-title">{t("baza.pageTitle")}</h3>
              </div>

              <div className="baza-filters" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                <div className="modal-field" style={{ margin: 0 }}>
                  <label htmlFor="db-admin">{t("baza.labelAdmin")}</label>
                  <select
                    id="db-admin"
                    value={dbAdminFilterId}
                    onChange={(e) => setDbAdminFilterId(e.target.value)}
                  >
                    <option value="">{t("common.allRecords")}</option>
                    {Array.isArray(users) && users
                      .filter((u) => u.role === "admin" || u.role === "superadmin")
                      .map((u) => (
                        <option key={u.id} value={String(u.id)}>
                          {u.username}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="modal-field" style={{ margin: 0 }}>
                  <label htmlFor="db-table">{t("baza.labelTable")}</label>
                  <select
                    id="db-table"
                    value={dbTable}
                    onChange={(e) => setDbTable(e.target.value)}
                    disabled={!dbMeta}
                  >
                    {!dbMeta ? <option value="">{t("common.loading")}</option> : null}
                    {Array.isArray(dbMeta?.tables)
                      ? dbMeta.tables.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))
                      : null}
                  </select>
                </div>

                <div className="modal-field" style={{ margin: 0 }}>
                  <label htmlFor="db-employee">{t("baza.labelEmployee")}</label>
                  <select
                    id="db-employee"
                    value={dbEmployeeFilterId}
                    onChange={(e) => setDbEmployeeFilterId(e.target.value)}
                  >
                    <option value="">{t("common.allRecords")}</option>
                    {Array.isArray(employees)
                      ? employees.map((e) => (
                          <option key={e.id} value={String(e.id)}>
                            {e.id} · {e.name}
                          </option>
                        ))
                      : null}
                  </select>
                </div>

                <div style={{ display: "flex", alignItems: "flex-end", marginLeft: "auto" }}>
                  <button
                    type="button"
                    className="modal-btn modal-btn-ghost"
                    onClick={() => deleteDbRowsBulk(dbTable, dbSelectedPks)}
                    disabled={dbSelectedPks.length === 0 || dbBusy}
                    title={t("admin.deleteSelectedAria")}
                    aria-label={t("admin.deleteSelectedAria")}
                  >
                    <Trash2 size={16} strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              {dbError ? <p className="login-err" style={{ marginTop: 10 }}>{dbError}</p> : null}

              <div className="db-table scroll-modern" style={{ marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 12, width: 34 }}>
                        <input
                          type="checkbox"
                          checked={dbAllSelected}
                          disabled={dbAllPkVals.length === 0 || dbBusy}
                          onChange={(e) => {
                            if (e.target.checked) setDbSelectedPks(dbAllPkVals);
                            else setDbSelectedPks([]);
                          }}
                        />
                      </th>
                      {dbColumns.map((c) => (
                        <th key={c} style={{ textAlign: "left", padding: "6px 8px", fontSize: 12 }}>
                          {c}
                        </th>
                      ))}
                      <th style={{ textAlign: "left", padding: "6px 8px", fontSize: 12 }}>{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dbBusy ? (
                      <tr>
                        <td colSpan={dbColumns.length + 2} className="empty-row">
                          {t("common.loading")}
                        </td>
                      </tr>
                    ) : null}

                    {!dbBusy && dbRows.length === 0 ? (
                      <tr>
                        <td colSpan={dbColumns.length + 2} className="empty-row">
                          {t("baza.noRows")}
                        </td>
                      </tr>
                    ) : null}

                    {!dbBusy && Array.isArray(dbRows)
                      ? dbRows.map((r, idx) => {
                          const pkName = dbTableCfg?.pk?.name;
                          const pkVal = pkName ? r[pkName] : "";
                          const pkValStr = pkVal != null ? String(pkVal) : "";
                          return (
                            <tr key={pkValStr || String(idx)}>
                              <td style={{ padding: "6px 8px", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                                <input
                                  type="checkbox"
                                  checked={dbSelectedPks.includes(pkValStr)}
                                  disabled={dbBusy || !pkValStr}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setDbSelectedPks((prev) => {
                                      if (checked) {
                                        if (prev.includes(pkValStr)) return prev;
                                        return [...prev, pkValStr];
                                      }
                                      return prev.filter((x) => x !== pkValStr);
                                    });
                                  }}
                                />
                              </td>
                              {dbColumns.map((c) => (
                                <td
                                  key={c}
                                  style={{
                                    padding: "6px 8px",
                                    borderTop: "1px solid rgba(0,0,0,0.06)",
                                    verticalAlign: "top",
                                    fontSize: 12,
                                    maxWidth: 360,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                  title={typeof r[c] === "object" ? formatDbValue(r[c]) : String(r[c] ?? "")}
                                >
                                  {formatDbValue(r[c])}
                                </td>
                              ))}
                              <td style={{ padding: "6px 8px", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
                                <div style={{ display: "flex", gap: 10 }}>
                                  <button
                                    type="button"
                                    className="actions-icon actions-edit-btn"
                                    onClick={() => openDbEditModal(r)}
                                    aria-label={t("common.edit")}
                                    title={t("common.edit")}
                                  >
                                    <Pencil size={14} strokeWidth={1.75} />
                                  </button>
                                  <button
                                    type="button"
                                    className="actions-icon actions-delete-btn"
                                    onClick={() => deleteDbRow(dbTable, pkVal)}
                                    aria-label={t("common.delete")}
                                    title={t("common.delete")}
                                  >
                                    <Trash2 size={14} strokeWidth={1.75} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      : null}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <section
              className={
                activeMenu === "Sozlamalar"
                  ? "settings-min-page scroll-modern"
                  : "journal-wrap module-placeholder"
              }
            >
              {activeMenu === "Sozlamalar" ? (
                <div className="settings-min">
                  <header className="settings-min-hero">
                    <h1 className="settings-min-title">{t("settings.heroTitle")}</h1>
                  </header>

                  {userRole === "hodim" ? (
                    <div className="settings-min-card settings-min-notice">
                      <p>{t("settings.adminOnly")}</p>
                    </div>
                  ) : (
                    <div className="settings-min-stack">
                      <section className="settings-min-card" aria-labelledby="settings-lang-title">
                        <h2 id="settings-lang-title" className="settings-min-h settings-min-h-compact">
                          {t("settings.languageTitle")}
                        </h2>
                        <div className="settings-lang-seg" role="group" aria-label={t("settings.languageTitle")}>
                          {(["uz", "ru", "en"]).map((code) => (
                            <button
                              key={code}
                              type="button"
                              className={`settings-lang-btn${locale === code ? " active" : ""}`}
                              onClick={() => setLocale(code)}
                            >
                              {code === "uz" ? t("settings.langUz") : code === "ru" ? t("settings.langRu") : t("settings.langEn")}
                            </button>
                          ))}
                        </div>
                      </section>

                      <section className="settings-min-card" aria-labelledby="settings-theme-title">
                        <h2 id="settings-theme-title" className="settings-min-h settings-min-h-compact">
                          {t("settings.appearanceTitle")}
                        </h2>
                        <div className="settings-min-theme-row">
                          <span className="settings-min-theme-current">
                            {theme === "light" ? t("settings.themeLight") : t("settings.themeDark")}
                          </span>
                          <button
                            type="button"
                            className="settings-min-theme-toggle"
                            aria-label={theme === "light" ? t("settings.themeGoDark") : t("settings.themeGoLight")}
                            onClick={() => {
                              const next = theme === "light" ? "dark" : "light";
                              setTheme(next);
                              api.putTheme(next).catch(() => {});
                            }}
                          >
                            {theme === "light" ? <Moon size={18} strokeWidth={1.75} /> : <Sun size={18} strokeWidth={1.75} />}
                            <span>{theme === "light" ? t("settings.themeGoDark") : t("settings.themeGoLight")}</span>
                          </button>
                        </div>
                        <div className="settings-min-density-row" role="group" aria-label={t("settings.densityAria")}>
                          <button
                            type="button"
                            className={`settings-lang-btn${uiDensity === "normal" ? " active" : ""}`}
                            onClick={() => setUiDensity("normal")}
                          >
                            {t("settings.densityNormal")}
                          </button>
                          <button
                            type="button"
                            className={`settings-lang-btn${uiDensity === "dense" ? " active" : ""}`}
                            onClick={() => setUiDensity("dense")}
                          >
                            {t("settings.densityCompact")}
                          </button>
                        </div>
                      </section>

                      <section className="settings-min-card settings-min-card-salary" aria-labelledby="settings-salary-title">
                        <h2 id="settings-salary-title" className="settings-min-h settings-min-h-compact">
                          {t("settings.salaryTitle")}
                        </h2>

                        {salaryCalcError ? <p className="login-err settings-min-err">{salaryCalcError}</p> : null}

                        <div className="settings-min-form">
                          <div className="settings-min-triple-row">
                          <div className="settings-min-field settings-min-field-inline">
                            <label htmlFor="salary-filial" className="settings-min-label-cap">{t("settings.filial")}</label>
                            <label htmlFor="salary-filial" className="settings-min-sub-label">{t("settings.filialSelectedOnly")}</label>
                            {userRole === "admin" && filialOptions.length === 0 ? (
                              <p className="settings-min-hint">{t("settings.filialHint")}</p>
                            ) : null}
                            <select
                              id="salary-filial"
                              className="settings-min-input"
                              value={
                                salaryCalcSelectedFilial === ALL_FILIALS_VALUE || filialOptions.includes(salaryCalcSelectedFilial)
                                  ? salaryCalcSelectedFilial
                                  : ""
                              }
                              onChange={(e) => setSalaryCalcSelectedFilial(e.target.value)}
                              disabled={userRole === "admin" && filialOptions.length === 0}
                            >
                              {filialOptions.length === 0 ? <option value="">—</option> : null}
                              {filialOptions.length > 0 ? <option value={ALL_FILIALS_VALUE}>{t("common.allBranches")}</option> : null}
                              {filialOptions.map((f) => (
                                <option key={f} value={f}>
                                  {f}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="settings-min-field settings-min-field-wide settings-min-field-inline">
                            <span className="settings-min-label-cap">{t("settings.week")}</span>
                            <div className="settings-min-inline">
                              <div className="settings-min-grow">
                                <label htmlFor="sal-week-mode">{t("settings.calcType")}</label>
                                <select
                                  id="sal-week-mode"
                                  className="settings-min-input"
                                  value={salaryCalcWeekMode}
                                  onChange={(e) => setSalaryCalcWeekMode(e.target.value)}
                                >
                                  <option value="workdays">{t("settings.workdaysSchedule")}</option>
                                  <option value="fixed">{t("settings.fixedWeekOption")}</option>
                                </select>
                              </div>
                              {salaryCalcWeekMode === "fixed" ? (
                                <div className="settings-min-num">
                                  <label htmlFor="sal-week-fixed">{t("settings.days")}</label>
                                  <input
                                    id="sal-week-fixed"
                                    className="settings-min-input"
                                    type="number"
                                    min={1}
                                    inputMode="numeric"
                                    value={salaryCalcWeekFixed}
                                    onChange={(e) => setSalaryCalcWeekFixed(e.target.value)}
                                  />
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <div className="settings-min-field settings-min-field-wide settings-min-field-inline">
                            <span className="settings-min-label-cap">{t("settings.month")}</span>
                            <div className="settings-min-inline">
                              <div className="settings-min-grow">
                                <label htmlFor="sal-month-mode">{t("settings.calcType")}</label>
                                <select
                                  id="sal-month-mode"
                                  className="settings-min-input"
                                  value={salaryCalcMonthMode}
                                  onChange={(e) => setSalaryCalcMonthMode(e.target.value)}
                                >
                                  <option value="workdays">{t("settings.workdaysSchedule")}</option>
                                  <option value="fixed">{t("settings.fixedMonthOption")}</option>
                                </select>
                              </div>
                              {salaryCalcMonthMode === "fixed" ? (
                                <div className="settings-min-num">
                                  <label htmlFor="sal-month-fixed">{t("settings.days")}</label>
                                  <input
                                    id="sal-month-fixed"
                                    className="settings-min-input"
                                    type="number"
                                    min={1}
                                    inputMode="numeric"
                                    value={salaryCalcMonthFixed}
                                    onChange={(e) => setSalaryCalcMonthFixed(e.target.value)}
                                  />
                                </div>
                              ) : null}
                            </div>
                          </div>
                          </div>

                          <div className="settings-min-field settings-min-field-wide">
                            <span className="settings-min-label-cap">{t("settings.attendanceAlgoTitle")}</span>
                            <div className="settings-min-inline">
                              <div className="settings-min-grow">
                                <label htmlFor="salary-attendance-mode">{t("settings.calcType")}</label>
                                <select
                                  id="salary-attendance-mode"
                                  className="settings-min-input"
                                  value={salaryCalcAttendanceMode}
                                  onChange={(e) =>
                                    setSalaryCalcAttendanceMode(
                                      e.target.value === "all_segments" ? "all_segments" : "first_last"
                                    )
                                  }
                                >
                                  <option value="first_last">{t("settings.attendanceAlgoFirstLast")}</option>
                                  <option value="all_segments">{t("settings.attendanceAlgoAllSegments")}</option>
                                </select>
                                <p className="settings-min-hint">{t("settings.attendanceAlgoHelp")}</p>
                              </div>
                            </div>
                          </div>

                          <div className="settings-min-field settings-min-field-wide settings-min-field-timezone">
                            <span className="settings-min-label-cap">{t("settings.terminalTimeTitle")}</span>
                            <div className="settings-min-timezone-row">
                              <label htmlFor="terminal-timezone-offset" className="settings-min-timezone-label">
                                {t("settings.terminalTimeOffsetLabel")}
                              </label>
                              <select
                                id="terminal-timezone-offset"
                                className="settings-min-input settings-min-timezone-select"
                                value={String(terminalTimezoneOffsetHours)}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  setTerminalTimezoneOffsetHours(
                                    Number.isFinite(n) ? Math.max(-12, Math.min(14, n)) : 5
                                  );
                                }}
                              >
                                {Array.from({ length: 27 }, (_, i) => i - 12).map((h) => (
                                  <option key={h} value={String(h)}>
                                    UTC{h >= 0 ? `+${h}` : h}
                                  </option>
                                ))}
                              </select>
                              <div className="settings-min-time-preview" aria-live="polite">
                                <span className="settings-min-time-preview-date">{terminalTimezonePreview.date}</span>
                                <span className="settings-min-time-preview-sep">|</span>
                                <span className="settings-min-time-preview-time">{terminalTimezonePreview.time}</span>
                              </div>
                            </div>
                            <p className="settings-min-hint">{t("settings.terminalTimeHelp")}</p>
                          </div>

                          <div className="settings-min-field settings-min-field-wide">
                            <span className="settings-min-label-cap">{t("settings.policyTitle")}</span>
                            <div className="settings-lang-seg" style={{ marginBottom: 8 }}>
                              <button
                                type="button"
                                className={`settings-lang-btn${salaryPolicy.enabled !== false ? " active" : ""}`}
                                onClick={() => setSalaryPolicy((prev) => ({ ...prev, enabled: true }))}
                              >
                                {t("settings.policyEnabledOn")}
                              </button>
                              <button
                                type="button"
                                className={`settings-lang-btn${salaryPolicy.enabled === false ? " active" : ""}`}
                                onClick={() => setSalaryPolicy((prev) => ({ ...prev, enabled: false }))}
                              >
                                {t("settings.policyEnabledOff")}
                              </button>
                            </div>
                            <div className="settings-min-inline">
                              <div className="settings-min-num">
                                <label htmlFor="policy-late-grace">{t("settings.lateGraceMinutes")}</label>
                                <input
                                  id="policy-late-grace"
                                  className="settings-min-input"
                                  type="number"
                                  min={0}
                                  inputMode="numeric"
                                  disabled={salaryPolicy.enabled === false}
                                  value={salaryPolicy.lateGraceMinutes}
                                  onChange={(e) =>
                                    setSalaryPolicy((prev) => ({
                                      ...prev,
                                      lateGraceMinutes: Number.isFinite(Number(e.target.value))
                                        ? Math.max(0, Math.trunc(Number(e.target.value)))
                                        : 0,
                                    }))
                                  }
                                />
                              </div>
                              <div className="settings-min-num">
                                <label htmlFor="policy-late-per-minute">{t("settings.latePerMinute")}</label>
                                <input
                                  id="policy-late-per-minute"
                                  className="settings-min-input"
                                  type="number"
                                  min={0}
                                  inputMode="numeric"
                                  disabled={salaryPolicy.enabled === false}
                                  value={salaryPolicy.latePerMinute}
                                  onChange={(e) =>
                                    setSalaryPolicy((prev) => ({
                                      ...prev,
                                      latePerMinute: Number.isFinite(Number(e.target.value))
                                        ? Math.max(0, Math.trunc(Number(e.target.value)))
                                        : 0,
                                    }))
                                  }
                                />
                              </div>
                              <div className="settings-min-num">
                                <label htmlFor="policy-max-fine">{t("settings.maxDailyFine")}</label>
                                <input
                                  id="policy-max-fine"
                                  className="settings-min-input"
                                  type="number"
                                  min={0}
                                  inputMode="numeric"
                                  disabled={salaryPolicy.enabled === false}
                                  value={salaryPolicy.maxDailyFine}
                                  onChange={(e) =>
                                    setSalaryPolicy((prev) => ({
                                      ...prev,
                                      maxDailyFine: Number.isFinite(Number(e.target.value))
                                        ? Math.max(0, Math.trunc(Number(e.target.value)))
                                        : 0,
                                    }))
                                  }
                                />
                              </div>
                              <div className="settings-min-num">
                                <label htmlFor="policy-bonus-per-minute">{t("settings.bonusPerMinute")}</label>
                                <input
                                  id="policy-bonus-per-minute"
                                  className="settings-min-input"
                                  type="number"
                                  min={0}
                                  inputMode="numeric"
                                  disabled={salaryPolicy.enabled === false}
                                  value={salaryPolicy.bonusPerMinute}
                                  onChange={(e) =>
                                    setSalaryPolicy((prev) => ({
                                      ...prev,
                                      bonusPerMinute: Number.isFinite(Number(e.target.value))
                                        ? Math.max(0, Math.trunc(Number(e.target.value)))
                                        : 0,
                                    }))
                                  }
                                />
                              </div>
                              <div className="settings-min-num">
                                <label htmlFor="policy-bonus-grace">{t("settings.bonusGraceMinutes")}</label>
                                <input
                                  id="policy-bonus-grace"
                                  className="settings-min-input"
                                  type="number"
                                  min={0}
                                  inputMode="numeric"
                                  disabled={salaryPolicy.enabled === false}
                                  value={salaryPolicy.bonusGraceMinutes}
                                  onChange={(e) =>
                                    setSalaryPolicy((prev) => ({
                                      ...prev,
                                      bonusGraceMinutes: Number.isFinite(Number(e.target.value))
                                        ? Math.max(0, Math.trunc(Number(e.target.value)))
                                        : 0,
                                    }))
                                  }
                                />
                              </div>
                            </div>
                            <div className="settings-min-emp-override-head">
                              <span>{t("settings.employeeOverrideTitle")}</span>
                              <button
                                type="button"
                                className="settings-min-add-btn"
                                onClick={() => {
                                  const first = (employeesInScope || [])[0];
                                  if (!first) return;
                                  setSalaryPolicyEmployeeOverrides((prev) => ({
                                    ...prev,
                                    [String(first.id)]: prev[String(first.id)] || {
                                      lateGraceMinutes: salaryPolicy.lateGraceMinutes,
                                      latePerMinute: salaryPolicy.latePerMinute,
                                      maxDailyFine: salaryPolicy.maxDailyFine,
                                    },
                                  }));
                                }}
                                aria-label={t("settings.addOverride")}
                                title={t("settings.addOverride")}
                              >
                                <Plus size={14} strokeWidth={2} />
                              </button>
                            </div>
                            <div className="settings-min-emp-override-list">
                              {Object.entries(salaryPolicyEmployeeOverrides || {}).map(([empId, item]) => {
                                return (
                                  <div key={empId} className="settings-min-emp-override-row">
                                    <select
                                      className="settings-min-input"
                                      value={empId}
                                      onChange={(e) => {
                                        const nextId = String(e.target.value);
                                        setSalaryPolicyEmployeeOverrides((prev) => {
                                          const copy = { ...prev };
                                          const cur = copy[empId] || {};
                                          delete copy[empId];
                                          copy[nextId] = {
                                            lateGraceMinutes: Number.isFinite(Number(cur.lateGraceMinutes))
                                              ? Math.max(0, Math.trunc(Number(cur.lateGraceMinutes)))
                                              : salaryPolicy.lateGraceMinutes,
                                            latePerMinute: Number.isFinite(Number(cur.latePerMinute))
                                              ? Math.max(0, Math.trunc(Number(cur.latePerMinute)))
                                              : salaryPolicy.latePerMinute,
                                            maxDailyFine: Number.isFinite(Number(cur.maxDailyFine))
                                              ? Math.max(0, Math.trunc(Number(cur.maxDailyFine)))
                                              : salaryPolicy.maxDailyFine,
                                          };
                                          return copy;
                                        });
                                      }}
                                    >
                                      {(employeesInScope || []).map((x) => (
                                        <option key={x.id} value={String(x.id)}>
                                          {x.name}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      className="settings-min-input"
                                      type="number"
                                      min={0}
                                      inputMode="numeric"
                                      value={Number(item?.lateGraceMinutes) || 0}
                                      onChange={(e) =>
                                        setSalaryPolicyEmployeeOverrides((prev) => ({
                                          ...prev,
                                          [empId]: {
                                            ...(prev[empId] || {}),
                                            lateGraceMinutes: Number.isFinite(Number(e.target.value))
                                              ? Math.max(0, Math.trunc(Number(e.target.value)))
                                              : 0,
                                          },
                                        }))
                                      }
                                      placeholder={t("settings.overrideLatePlaceholder")}
                                      title={t("settings.lateGraceMinutes")}
                                    />
                                    <input
                                      className="settings-min-input"
                                      type="number"
                                      min={0}
                                      inputMode="numeric"
                                      value={Number(item?.latePerMinute) || 0}
                                      onChange={(e) =>
                                        setSalaryPolicyEmployeeOverrides((prev) => ({
                                          ...prev,
                                          [empId]: {
                                            ...(prev[empId] || {}),
                                            latePerMinute: Number.isFinite(Number(e.target.value))
                                              ? Math.max(0, Math.trunc(Number(e.target.value)))
                                              : 0,
                                          },
                                        }))
                                      }
                                      placeholder={t("settings.overridePerMinutePlaceholder")}
                                      title={t("settings.latePerMinute")}
                                    />
                                    <input
                                      className="settings-min-input"
                                      type="number"
                                      min={0}
                                      inputMode="numeric"
                                      value={Number(item?.maxDailyFine) || 0}
                                      onChange={(e) =>
                                        setSalaryPolicyEmployeeOverrides((prev) => ({
                                          ...prev,
                                          [empId]: {
                                            ...(prev[empId] || {}),
                                            maxDailyFine: Number.isFinite(Number(e.target.value))
                                              ? Math.max(0, Math.trunc(Number(e.target.value)))
                                              : 0,
                                          },
                                        }))
                                      }
                                      placeholder={t("settings.overrideMaxPlaceholder")}
                                      title={t("settings.maxDailyFine")}
                                    />
                                    <button
                                      type="button"
                                      className="settings-min-del-btn"
                                      onClick={() =>
                                        setSalaryPolicyEmployeeOverrides((prev) => {
                                          const copy = { ...prev };
                                          delete copy[empId];
                                          return copy;
                                        })
                                      }
                                      aria-label={t("settings.removeOverride")}
                                      title={t("settings.removeOverride")}
                                    >
                                      <X size={14} strokeWidth={1.75} />
                                    </button>
                                  </div>
                                );
                              })}
                              {Object.keys(salaryPolicyEmployeeOverrides || {}).length === 0 ? (
                                <p className="settings-min-hint">{t("settings.overrideEmpty")}</p>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        <div className="settings-min-actions">
                          <button
                            type="button"
                            className="settings-min-save"
                            disabled={salaryCalcBusy || (userRole === "admin" && filialOptions.length === 0)}
                            onClick={async () => {
                              try {
                                setSalaryCalcBusy(true);
                                setSalaryCalcError(null);
                                if (!salaryCalcSelectedFilial) {
                                  setSalaryCalcError(t("settings.selectFilial"));
                                  return;
                                }
                                const payload = {
                                  weekMode: salaryCalcWeekMode,
                                  weekFixed: salaryCalcWeekFixed,
                                  monthMode: salaryCalcMonthMode,
                                  monthFixed: salaryCalcMonthFixed,
                                  attendanceMode: salaryCalcAttendanceMode,
                                };
                                if (salaryCalcSelectedFilial === ALL_FILIALS_VALUE) {
                                  if (!Array.isArray(filialOptions) || filialOptions.length === 0) {
                                    setSalaryCalcError(t("settings.selectFilial"));
                                    return;
                                  }
                                  await Promise.all(filialOptions.map((f) => api.putSalaryCalcConfigFilial(f, payload)));
                                } else {
                                  await api.putSalaryCalcConfigFilial(salaryCalcSelectedFilial, payload);
                                }
                                await api.putSalaryPolicy({
                                  enabled: salaryPolicy.enabled !== false,
                                  latePerMinute: salaryPolicy.latePerMinute,
                                  bonusPerMinute: salaryPolicy.bonusPerMinute,
                                  bonusGraceMinutes: salaryPolicy.bonusGraceMinutes,
                                  lateGraceMinutes: salaryPolicy.lateGraceMinutes,
                                  maxDailyFine: salaryPolicy.maxDailyFine,
                                  employeeOverrides: salaryPolicyEmployeeOverrides,
                                });
                                await api.putTerminalTimezoneOffset(terminalTimezoneOffsetHours);
                                setSalaryCalcConfigsByFilial((prev) => {
                                  const next = { ...prev };
                                  const nextCfg = {
                                    weekMode: salaryCalcWeekMode,
                                    weekFixed: Math.trunc(Number(salaryCalcWeekFixed)),
                                    monthMode: salaryCalcMonthMode,
                                    monthFixed: Math.trunc(Number(salaryCalcMonthFixed)),
                                    attendanceMode: salaryCalcAttendanceMode,
                                  };
                                  if (salaryCalcSelectedFilial === ALL_FILIALS_VALUE) {
                                    for (const f of filialOptions) next[f] = nextCfg;
                                  } else {
                                    next[salaryCalcSelectedFilial] = nextCfg;
                                  }
                                  return next;
                                });
                              } catch (err) {
                                setSalaryCalcError(translateApiError(err instanceof Error ? err.message : String(err), locale));
                              } finally {
                                setSalaryCalcBusy(false);
                              }
                            }}
                          >
                            {salaryCalcBusy ? t("settings.saving") : t("settings.save")}
                          </button>
                        </div>
                      </section>
                    </div>
                  )}
                </div>
              ) : activeMenu === "Bildirishnoma" ? (
                <div className="notice-history-page">
                  <div className="notice-history-head">
                    <h3 className="journal-title">{t("menu.notice")}</h3>
                    <div className="notice-history-head-actions">
                      <button
                        type="button"
                        className="module-right-btn notice-head-mark-all"
                        onClick={markAllSubscriptionNoticesRead}
                        disabled={unreadSubscriptionNoticeCount === 0}
                        aria-label={t("admin.markAllAsRead")}
                        title={t("admin.markAllAsRead")}
                      >
                        <CheckCheck size={14} />
                      </button>
                      <button type="button" className="module-right-btn" onClick={clearSubscriptionNoticeHistory} aria-label={t("common.delete")}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>

                  {sortedSubscriptionNoticeHistory.length === 0 ? (
                    <p className="report-detail-empty">{t("admin.noticeHistoryEmpty")}</p>
                  ) : (
                    <div className="notice-history-list">
                      {sortedSubscriptionNoticeHistory.map((item) => (
                        <article key={item.id} className={`notice-history-item${item.read ? "" : " unread"}`}>
                          <div className="notice-history-item-head">
                            <strong>{t(item.title)}</strong>
                            <span>
                              {new Date(item.createdAt).toLocaleString(localeToBcp47(locale), {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                          <p>{item.text}</p>
                          {item.endAt ? (
                            <small>
                              {t("admin.endsAt")}{" "}
                              {new Date(item.endAt).toLocaleString(localeToBcp47(locale), {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </small>
                          ) : null}
                          {!item.read ? (
                            <div className="notice-history-item-actions">
                              <button
                                type="button"
                                className="module-right-btn"
                                onClick={() => markSubscriptionNoticeRead(item.id)}
                                aria-label={t("admin.markAsRead")}
                              >
                                {t("admin.markAsRead")}
                              </button>
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  )}

                  <div className="notice-history-contact">
                    <a href={SUPERADMIN_CONTACT_URL} target="_blank" rel="noreferrer" className="login-submit notice-contact-link">
                      {t("admin.contactSuperadmin")} {t("admin.openTelegram")}
                    </a>
                  </div>
                </div>
              ) : activeMenu === "Dashboard" ? (
                <div className="dashboard-page">
                  <section className="dashboard-hero">
                    <div>
                      <h2>{t("menu.dashboard")}</h2>
                      <p>
                        {formatMonthHeading(dashboardMonth, locale)} · {dashboardFilial === "all" ? t("common.allBranches") : dashboardFilial}
                      </p>
                    </div>
                    <div className="dashboard-hero-progress">
                      <span>{t("dashboard.payCompletion")}</span>
                      <strong>{dashboardData.paidPercent}%</strong>
                    </div>
                  </section>
                  <section className="dashboard-filters">
                    <input
                      className="date-input report-month-input"
                      type="month"
                      value={dashboardMonth}
                      onChange={(e) => setDashboardMonth(e.target.value)}
                    />
                    <select
                      className="date-input filial-filter"
                      value={dashboardFilial}
                      onChange={(e) => setDashboardFilial(e.target.value)}
                    >
                      <option value="all">{t("common.allBranches")}</option>
                      {filialOptions.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                    <select
                      className="date-input filial-filter"
                      value={dashboardTrendMode}
                      onChange={(e) => setDashboardTrendMode(e.target.value)}
                    >
                      <option value="attendance">{t("dashboard.trendAttendance")}</option>
                      <option value="salary">{t("dashboard.trendSalary")}</option>
                    </select>
                  </section>
                  <section className="dashboard-kpis">
                    <article className="dashboard-kpi">
                      <p>{t("dashboard.kpiEmployees")}</p>
                      <strong>{dashboardData.totalEmployees}</strong>
                    </article>
                    <article className="dashboard-kpi">
                      <p>{t("dashboard.kpiAtWork")}</p>
                      <strong>{dashboardData.inOffice}</strong>
                    </article>
                    <article className="dashboard-kpi">
                      <p>{t("dashboard.kpiCalculatedMonth")}</p>
                      <strong>{fmtMoney(dashboardData.grossMonth)}</strong>
                    </article>
                    <article className="dashboard-kpi">
                      <p>{t("dashboard.kpiPaidMonth")}</p>
                      <strong>{fmtMoney(dashboardData.paidMonth)}</strong>
                    </article>
                    <article className="dashboard-kpi">
                      <p>{t("dashboard.kpiRemainingMonth")}</p>
                      <strong>{fmtMoney(dashboardData.remainingMonth)}</strong>
                    </article>
                    <article className="dashboard-kpi">
                      <p>{t("dashboard.kpiLate")}</p>
                      <strong>{dashboardData.stateCounts.late}</strong>
                    </article>
                    <article className="dashboard-kpi">
                      <p>{t("dashboard.kpiAbsent")}</p>
                      <strong>{dashboardData.stateCounts.absent}</strong>
                    </article>
                  </section>

                  <section className="dashboard-live-row">
                    <article className="dashboard-card dashboard-live-card">
                      <h3>{t("dashboard.liveToday")}</h3>
                      <div className="dashboard-live-meta">
                        <span>{liveNow.toLocaleTimeString(localeToBcp47(locale), { hour: "2-digit", minute: "2-digit" })}</span>
                        <strong>{t("dashboard.refreshEach10s")}</strong>
                      </div>
                      <div className="dashboard-live-stats">
                        <span>{t("dashboard.presentNow")}: {dashboardData.presentNow}</span>
                        <span>{t("attendance.late")}: {dashboardData.stateCounts.late}</span>
                        <span>{t("attendance.absent")}: {dashboardData.stateCounts.absent}</span>
                      </div>
                    </article>
                    <article className="dashboard-card dashboard-ring-card">
                      <h3>{t("dashboard.dailyAttendanceProgress")}</h3>
                      <div className="dashboard-ring-wrap">
                        <div
                          className="dashboard-ring"
                          style={{
                            background: `conic-gradient(#4f7dff 0 ${dashboardData.attendanceRing.present}%, #f59e0b ${dashboardData.attendanceRing.present}% ${dashboardData.attendanceRing.present + dashboardData.attendanceRing.late}%, #e5e7eb ${dashboardData.attendanceRing.present + dashboardData.attendanceRing.late}% 100%)`,
                          }}
                        >
                          <div className="dashboard-ring-center">
                            <strong>{dashboardData.attendanceRing.present}%</strong>
                            <span>{t("dashboard.presentShort")}</span>
                          </div>
                        </div>
                        <div className="dashboard-ring-legend">
                          <span>Kelgan {dashboardData.attendanceRing.present}%</span>
                          <span>Kechikkan {dashboardData.attendanceRing.late}%</span>
                          <span>Kelmagan {dashboardData.attendanceRing.absent}%</span>
                        </div>
                      </div>
                    </article>
                  </section>

                  <section className="dashboard-grid">
                    <article className="dashboard-card">
                      <h3>{dashboardTrendMode === "salary" ? "Oxirgi 7 kun maosh trend" : "Oxirgi 7 kun davomat"}</h3>
                      <svg viewBox="0 0 220 64" className="dashboard-spark" role="img" aria-label={t("dashboard.trendAttendance")}>
                        <path
                          d={sparklinePath(
                            dashboardTrendMode === "salary" ? dashboardData.trendSalary : dashboardData.trendChecks,
                            220,
                            64
                          )}
                        />
                      </svg>
                      <div className="dashboard-spark-labels">
                        <span>{dashboardData.trendDays[0] || ""}</span>
                        <span>{dashboardData.trendDays[6] || ""}</span>
                      </div>
                    </article>

                    <article className="dashboard-card">
                      <h3>{t("dashboard.branchDistribution")}</h3>
                      <div className="dashboard-bars">
                        {dashboardData.byFilial.map((row) => {
                          const max = Math.max(1, ...dashboardData.byFilial.map((x) => x.count));
                          const w = Math.max(8, Math.round((row.count / max) * 100));
                          return (
                            <div key={row.name} className="dashboard-bar-row">
                              <span>{row.name}</span>
                              <div className="dashboard-bar-track">
                                <i style={{ width: `${w}%` }} />
                              </div>
                              <b>{row.count}</b>
                            </div>
                          );
                        })}
                      </div>
                    </article>

                    <article className="dashboard-card">
                      <h3>{t("dashboard.branchHeatmap7d")}</h3>
                      <div className="dashboard-heatmap">
                        {dashboardData.heatDays.map((d) => (
                          <div key={d.date} className="dashboard-heat-cell" title={`${d.date}: ${d.value}`}>
                            <i style={{ opacity: Math.max(0.18, d.pct / 100) }} />
                            <span>{d.label}</span>
                          </div>
                        ))}
                      </div>
                    </article>

                    <article className="dashboard-card">
                      <h3>{t("dashboard.topByRemaining")}</h3>
                      <div className="dashboard-top-list">
                        {dashboardData.topRemaining.length === 0 ? (
                          <p className="report-detail-empty">{t("baza.noRows")}</p>
                        ) : (
                          dashboardData.topRemaining.map((row) => (
                            <div key={row.employee.id} className="dashboard-top-row">
                              <span>{row.employee.name}</span>
                              <strong>{fmtMoney(row.remaining)}</strong>
                            </div>
                          ))
                        )}
                      </div>
                    </article>

                    <article className="dashboard-card">
                      <h3>{t("dashboard.topActive5")}</h3>
                      <div className="dashboard-top-list">
                        {dashboardData.topActive.length === 0 ? (
                          <p className="report-detail-empty">{t("baza.noRows")}</p>
                        ) : (
                          dashboardData.topActive.map((row, idx) => (
                            <div key={`active-${row.employee.id}`} className="dashboard-top-row">
                              <span>
                                {idx + 1}. {row.employee.name}
                              </span>
                              <strong>{fmtHours(row.hours)}</strong>
                            </div>
                          ))
                        )}
                      </div>
                    </article>

                    <article className="dashboard-card">
                      <h3>{t("dashboard.topLate5")}</h3>
                      <div className="dashboard-top-list">
                        {dashboardData.topLate.length === 0 ? (
                          <p className="report-detail-empty">{t("baza.noRows")}</p>
                        ) : (
                          dashboardData.topLate.map((row, idx) => (
                            <div key={`late-${row.employee.id}`} className="dashboard-top-row">
                              <span>
                                {idx + 1}. {row.employee.name}
                              </span>
                              <strong>{row.lateN} marta</strong>
                            </div>
                          ))
                        )}
                      </div>
                    </article>

                  </section>
                </div>
              ) : (
                <h3 className="journal-title">
                  {t("common.sectionStub", {
                    name: menuI18nPath(activeMenu) ? t(menuI18nPath(activeMenu)) : activeMenu,
                  })}
                </h3>
              )}
            </section>
          )
        ) : null}
      </main>

      {reportDetailEmployee && reportDetailData ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeReportDetailModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size report-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="report-detail-title">{reportDetailEmployee.name}</h3>
              <button type="button" className="modal-close" onClick={closeReportDetailModal} aria-label={t("common.close")}>
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <div className="modal-scroll scroll-modern report-detail-scroll">
              <section className="report-detail-metrics">
                <div className="report-metric-card">
                  <p>{t("report.detailSalary")}</p>
                  <strong>{fmtMoney(reportDetailData.salaryTotal)}</strong>
                </div>
                <div className="report-metric-card">
                  <p>{t("report.detailAdjusted")}</p>
                  <strong>{fmtMoney(reportDetailData.adjustedTotal)}</strong>
                </div>
                <div className="report-metric-card ok">
                  <p>{t("report.detailPaid")}</p>
                  <strong>{fmtMoney(reportDetailData.paidTotal)}</strong>
                </div>
                <div className="report-metric-card">
                  <p>{t("report.detailRemaining")}</p>
                  <strong>{fmtMoney(reportDetailData.remainingTotal)}</strong>
                </div>
                <div className="report-metric-card">
                  <p>{t("report.detailBonus")}</p>
                  <strong>{fmtMoney(reportDetailData.bonusTotal)}</strong>
                </div>
                <div className="report-metric-card danger">
                  <p>{t("report.detailFine")}</p>
                  <strong>{fmtMoney(reportDetailData.fineTotal)}</strong>
                </div>
                <div className="report-metric-card">
                  <p>{t("report.detailAdvance")}</p>
                  <strong>{fmtMoney(reportDetailData.advanceTotal)}</strong>
                </div>
                <div className="report-metric-card total">
                  <p>{t("report.detailTotal")}</p>
                  <strong>{fmtMoney(reportDetailData.netTotal)}</strong>
                </div>
              </section>

              <section className="report-detail-grid">
                <article className="report-detail-card report-detail-card-salary">
                  <h4>{t("report.detailSalaries")}</h4>
                  {reportDetailData.salaryItems.length === 0 ? (
                    <p className="report-detail-empty">{t("baza.noRows")}</p>
                  ) : (
                    <div className="report-detail-list">
                      {reportDetailData.salaryItems.slice().reverse().map((item) => {
                        const mainAmount = item.remaining > 0 ? item.remaining : item.due;
                        const showSalaryCalcSub =
                          (item.bonus || 0) > 0 ||
                          (item.fine || 0) > 0 ||
                          (item.advance || 0) > 0 ||
                          Math.trunc(Number(item.amount) || 0) !== Math.trunc(Number(mainAmount) || 0);
                        return (
                          <div key={`sal-${item.date}`} className="report-detail-row">
                            <div>
                              <strong>{formatAttendanceDate(item.date, locale)}</strong>
                              <small>
                                {item.remaining > 0 ? t("report.detailRemainStatus") : t("report.detailPaidStatus")}
                                {item.provisional ? ` · ${t("report.detailProvisional")}` : ""}
                              </small>
                            </div>
                            <div className="report-row-right report-row-right-column">
                              <span>{fmtMoney(mainAmount)}</span>
                              {showSalaryCalcSub ? (
                                <small className="report-row-sub">
                                  {t("report.detailCalc")}: {fmtMoney(item.amount)}
                                  {item.bonus > 0 ? ` · +${fmtMoney(item.bonus)}` : ""}
                                  {item.fine > 0 ? ` · -${fmtMoney(item.fine)}` : ""}
                                  {item.advance > 0 ? ` · -${fmtMoney(item.advance)}` : ""}
                                </small>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>

                <article className="report-detail-card">
                  <div className="report-card-head">
                    <h4>{t("report.detailBonuses")}</h4>
                    <button
                      type="button"
                      className="actions-icon report-add-btn"
                      onClick={() => openAddSalaryAdjustmentModal("bonus")}
                    >
                      <Plus size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                  {reportDetailData.bonusItems.length === 0 ? (
                    <p className="report-detail-empty">{t("baza.noRows")}</p>
                  ) : (
                    <div className="report-detail-list">
                      {reportDetailData.bonusItems.slice().reverse().map((item, idx) => (
                        <div key={`bonus-${item.id || `${item.date}-${idx}`}`} className="report-detail-row">
                          <div>
                            <strong>{formatAttendanceDate(item.date, locale)}</strong>
                            <small>
                              {item.auto
                                ? `${t("report.detailAutoBonus")}${item.extraMin ? `: +${item.extraMin} ${t("report.detailMinUnit")}` : ""}`
                                : item.note || t("report.detailManualBonus")}
                            </small>
                          </div>
                          <div className="report-row-right">
                            <span>{fmtMoney(item.amount)}</span>
                            {!item.auto && item.id ? (
                              <>
                                <button
                                  type="button"
                                  className="actions-icon actions-edit-btn"
                                  onClick={() => editSalaryAdjustment(item, "bonus")}
                                  aria-label={t("common.edit")}
                                >
                                  <Pencil size={13} strokeWidth={1.75} />
                                </button>
                                <button
                                  type="button"
                                  className="actions-icon"
                                  onClick={() => deleteSalaryAdjustment(item.id)}
                                  aria-label={t("common.delete")}
                                >
                                  <Trash2 size={13} strokeWidth={1.75} />
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </article>

                <article className="report-detail-card">
                  <div className="report-card-head">
                    <h4>{t("report.detailFines")}</h4>
                    <button
                      type="button"
                      className="actions-icon report-add-btn"
                      onClick={() => openAddSalaryAdjustmentModal("fine")}
                    >
                      <Plus size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                  {reportDetailData.fineItems.length === 0 ? (
                    <p className="report-detail-empty">{t("baza.noRows")}</p>
                  ) : (
                    <div className="report-detail-list">
                      {reportDetailData.fineItems.slice().reverse().map((item, idx) => (
                        <div key={`fine-${item.id || `${item.date}-${idx}`}`} className="report-detail-row danger">
                          <div>
                            <strong>{formatAttendanceDate(item.date, locale)}</strong>
                            <small>
                              {item.auto
                                ? `${t("report.detailLatePrefix")}: ${item.lateMin || 0} ${t("report.detailMinUnit")}`
                                : item.note || t("report.detailManualFine")}
                            </small>
                          </div>
                          <div className="report-row-right">
                            <span>{fmtMoney(item.amount || 0)}</span>
                            {!item.auto && item.id ? (
                              <>
                                <button
                                  type="button"
                                  className="actions-icon actions-edit-btn"
                                  onClick={() => editSalaryAdjustment(item, "fine")}
                                  aria-label={t("common.edit")}
                                >
                                  <Pencil size={13} strokeWidth={1.75} />
                                </button>
                                <button
                                  type="button"
                                  className="actions-icon"
                                  onClick={() => deleteSalaryAdjustment(item.id)}
                                  aria-label={t("common.delete")}
                                >
                                  <Trash2 size={13} strokeWidth={1.75} />
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </article>

                <article className="report-detail-card">
                  <div className="report-card-head">
                    <h4>{t("report.detailAdvances")}</h4>
                    <button
                      type="button"
                      className="actions-icon report-add-btn"
                      onClick={() => openAddSalaryAdjustmentModal("advance")}
                    >
                      <Plus size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                  {reportDetailData.advanceItems.length === 0 ? (
                    <p className="report-detail-empty">{t("baza.noRows")}</p>
                  ) : (
                    <div className="report-detail-list">
                      {reportDetailData.advanceItems.slice().reverse().map((item, idx) => (
                        <div key={`adv-${item.id || `${item.date}-${idx}`}`} className="report-detail-row">
                          <div>
                            <strong>{formatAttendanceDate(item.date, locale)}</strong>
                            <small>{item.note || t("report.detailManualAdvance")}</small>
                          </div>
                          <div className="report-row-right">
                            <span>{fmtMoney(item.amount || 0)}</span>
                            {!item.auto && item.id ? (
                              <>
                                <button
                                  type="button"
                                  className="actions-icon actions-edit-btn"
                                  onClick={() => editSalaryAdjustment(item, "advance")}
                                  aria-label={t("common.edit")}
                                >
                                  <Pencil size={13} strokeWidth={1.75} />
                                </button>
                                <button
                                  type="button"
                                  className="actions-icon"
                                  onClick={() => deleteSalaryAdjustment(item.id)}
                                  aria-label={t("common.delete")}
                                >
                                  <Trash2 size={13} strokeWidth={1.75} />
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              </section>

              <section className="report-detail-calendar">
                <div className="report-cal-head">
                  <button
                    type="button"
                    className="report-cal-nav"
                    onClick={() => setReportDetailMonth((m) => shiftYearMonth(m, -1))}
                    aria-label={t("report.prevMonthAria")}
                  >
                    {"<"}
                  </button>
                  <strong>{formatMonthHeading(reportDetailMonth, locale)}</strong>
                  <button
                    type="button"
                    className="report-cal-nav"
                    onClick={() => setReportDetailMonth((m) => shiftYearMonth(m, 1))}
                    aria-label={t("report.nextMonthAria")}
                  >
                    {">"}
                  </button>
                </div>
                <div className="report-cal-weekdays">
                  {[t("weekday.mon"), t("weekday.tue"), t("weekday.wed"), t("weekday.thu"), t("weekday.fri"), t("weekday.sat"), t("weekday.sun")].map((w) => (
                    <span key={w}>{String(w).slice(0, 2)}</span>
                  ))}
                </div>
                <div className="report-cal-grid">
                  {reportDetailData.calendarCells.map((cell) => {
                    if (!cell.date) return <div key={cell.key} className="report-cal-day empty" />;
                    const day = Number(cell.date.slice(-2));
                    const cal = reportDetailData.calendarByDate.get(cell.date) || null;
                    const pay = cal?.remaining || 0;
                    const active = cell.date === reportDetailSelectedDate;
                    return (
                      <button
                        key={cell.key}
                        type="button"
                        className={`report-cal-day${active ? " active" : ""}${cal?.paid > 0 ? " paid" : ""}${cal?.settled ? " settled" : ""}`}
                        onClick={() => setReportDetailSelectedDate(cell.date)}
                      >
                        <span>{day}</span>
                        {cal?.due > 0 ? <small>{fmtMoney(cal.due)}</small> : null}
                        {cal?.settled ? <em>{t("report.detailPaidStatus")}</em> : cal?.remaining > 0 ? <em>{t("report.detailRemainStatus")}</em> : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
            <div className="modal-footer">
              <div className="modal-actions">
                <button type="button" className="modal-btn modal-btn-primary" onClick={closeReportDetailModal}>
                  {t("common.close")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {salaryAdjModal.open && reportDetailEmployee ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !salaryAdjModal.busy) closeAddSalaryAdjustmentModal();
          }}
        >
          <div className="modal-panel report-adj-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {salaryAdjModal.kind === "fine"
                  ? t("salaryAdj.modalFineTitle")
                  : salaryAdjModal.kind === "advance"
                    ? t("salaryAdj.modalAdvanceTitle")
                    : t("salaryAdj.modalBonusTitle")}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={closeAddSalaryAdjustmentModal}
                aria-label={t("common.close")}
                disabled={salaryAdjModal.busy}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <form
              className="modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitAddSalaryAdjustment();
              }}
            >
              <div className="modal-field">
                <label>{t("common.dateLabel")}</label>
                <input type="date" value={reportDetailSelectedDate || `${reportDetailMonth}-01`} readOnly disabled />
              </div>
              <div className="modal-field">
                <label>{t("salaryAdj.amountLabel")}</label>
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={salaryAdjModal.amount}
                  onChange={(e) => setSalaryAdjModal((prev) => ({ ...prev, amount: e.target.value }))}
                  disabled={salaryAdjModal.busy}
                />
              </div>
              <div className="modal-field">
                <label>{t("salaryAdj.noteLabel")}</label>
                <input
                  type="text"
                  value={salaryAdjModal.note}
                  onChange={(e) => setSalaryAdjModal((prev) => ({ ...prev, note: e.target.value }))}
                  disabled={salaryAdjModal.busy}
                />
              </div>
              {salaryAdjModal.error ? <p className="login-err">{salaryAdjModal.error}</p> : null}
              <div className="modal-actions">
                <button type="button" className="modal-btn" onClick={closeAddSalaryAdjustmentModal} disabled={salaryAdjModal.busy}>
                  {t("common.cancel")}
                </button>
                <button type="submit" className="modal-btn modal-btn-primary" disabled={salaryAdjModal.busy}>
                  {salaryAdjModal.busy ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {massPayModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !massPayBusy) closeMassPayModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size report-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mass-pay-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="mass-pay-title" className="mass-pay-title">{t("report.massPayTitle")}</h3>
              <button type="button" className="modal-close" onClick={closeMassPayModal} aria-label={t("common.close")}>
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <div className="modal-scroll scroll-modern report-detail-scroll">
              <section className="report-detail-card mass-pay-card mass-pay-min">
                <div className="mass-pay-filters">
                  <label className="mass-pay-toggle">
                    <input
                      type="checkbox"
                      checked={massPayOnlyDebtors}
                      onChange={(e) => setMassPayOnlyDebtors(e.target.checked)}
                      disabled={massPayBusy}
                    />
                    <span>{t("report.debtorsShort")}</span>
                  </label>
                  <select
                    className="date-input filial-filter"
                    value={massPayFilial}
                    onChange={(e) => setMassPayFilial(e.target.value)}
                    disabled={massPayBusy}
                  >
                    <option value="all">{t("common.allBranches")}</option>
                    {filialOptions.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    className="date-input"
                    value={massPayDateFrom}
                    onChange={(e) => setMassPayDateFrom(e.target.value)}
                    disabled={massPayBusy}
                  />
                  <input
                    type="date"
                    className="date-input"
                    value={massPayDateTo}
                    onChange={(e) => setMassPayDateTo(e.target.value)}
                    disabled={massPayBusy}
                  />
                </div>
                <div className="mass-pay-summary-row">
                  <span>{t("report.summaryEmployees", { n: massPayPrepared.rows.length })}</span>
                  <span>{t("report.summaryRemaining", { amount: fmtMoney(massPayPrepared.dueTotal) })}</span>
                  <span>Tanlandi: {massPaySelectedEmployeeIds.length}</span>
                </div>
                {massPayError ? <p className="auth-error">{massPayError}</p> : null}
              </section>

              <section className="report-detail-card">
                <div className="mass-pay-list-head">
                  <h4>{t("report.remainingSalariesTitle")}</h4>
                  {massPayPrepared.rows.length > 0 ? (
                    <input
                      type="checkbox"
                      checked={
                        massPayPrepared.rows.length > 0 &&
                        massPayPrepared.rows.every((row) => massPaySelectedEmployeeIds.includes(Number(row.employee.id)))
                      }
                      disabled={massPayBusy}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setMassPaySelectedEmployeeIds(massPayPrepared.rows.map((x) => Number(x.employee.id)));
                        } else {
                          setMassPaySelectedEmployeeIds([]);
                        }
                      }}
                    />
                  ) : null}
                </div>
                {massPayPrepared.rows.length === 0 ? (
                  <p className="report-detail-empty">{t("baza.noRows")}</p>
                ) : (
                  <div className="report-detail-list salary-remain-list">
                    {massPayPrepared.rows.map((row) => {
                      const checked = massPaySelectedEmployeeIds.includes(Number(row.employee.id));
                      return (
                        <label key={`mass-pay-${row.employee.id}`} className="report-detail-row salary-remain-item">
                          <div>
                            <strong>{row.employee.name}</strong>
                            <small className="mass-pay-item-meta">
                              {row.filial} · {row.role || "—"} · {row.remainingDays} kun ·{" "}
                              <span className="mass-pay-item-amount">{fmtMoney(row.remainingAmount)}</span>
                            </small>
                          </div>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={massPayBusy}
                            onChange={(e) => {
                              const nextChecked = e.target.checked;
                              setMassPaySelectedEmployeeIds((prev) => {
                                const set = new Set(prev.map((x) => Number(x)));
                                if (nextChecked) set.add(Number(row.employee.id));
                                else set.delete(Number(row.employee.id));
                                return Array.from(set);
                              });
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
            <div className="modal-footer">
              <div className="modal-actions">
                <button type="button" className="modal-btn modal-btn-ghost" onClick={closeMassPayModal} disabled={massPayBusy}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="modal-btn modal-btn-primary"
                  disabled={massPayBusy || massPayPrepared.entries.length === 0}
                  onClick={submitMassSalaryPayment}
                >
                  {massPayBusy ? "Saqlanmoqda..." : "Tanlangan hodimlarga to‘lash"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {attendanceHistoryEmployee ? (
        <>
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAttendanceHistoryModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size modal-panel-attendance-history"
            role="dialog"
            aria-modal="true"
            aria-labelledby="attendance-history-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="attendance-history-title">
                {t("attendance.attendanceHistoryTitle", { name: attendanceHistoryEmployee.name })}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={closeAttendanceHistoryModal}
                aria-label={t("common.close")}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <div className="modal-scroll scroll-modern">
              <div className="attendance-history-toolbar">
                <div className="attendance-history-period" role="group" aria-label={t("attendance.period")}>
                  <button
                    type="button"
                    className={`attendance-history-period-btn${attendanceHistoryMode === "day" ? " active" : ""}`}
                    onClick={() => {
                      setAttendanceHistoryMode("day");
                      setAttendanceHistoryDay(selectedDate);
                    }}
                  >
                    {t("attendance.periodDay")}
                  </button>
                  <button
                    type="button"
                    className={`attendance-history-period-btn${attendanceHistoryMode === "month" ? " active" : ""}`}
                    onClick={() => {
                      setAttendanceHistoryMode("month");
                      setAttendanceHistoryMonth(selectedDate.slice(0, 7));
                    }}
                  >
                    {t("attendance.periodMonth")}
                  </button>
                  <button
                    type="button"
                    className={`attendance-history-period-btn${attendanceHistoryMode === "all" ? " active" : ""}`}
                    onClick={() => setAttendanceHistoryMode("all")}
                  >
                    {t("attendance.periodAll")}
                  </button>
                </div>
                {attendanceHistoryMode === "all" ? (
                  <div className="attendance-history-range-fields">
                    <select
                      className="date-input attendance-history-range-select filial-filter"
                      aria-label={t("attendance.filterAllModeAria")}
                      value={attendanceHistoryAllFilterKind}
                      onChange={(e) => {
                        const v = e.target.value;
                        setAttendanceHistoryAllFilterKind(
                          v === "day" ? "day" : v === "month" ? "month" : "none"
                        );
                        if (v === "day") setAttendanceHistoryAllDayValue(selectedDate);
                        if (v === "month") setAttendanceHistoryAllMonthValue(selectedDate.slice(0, 7));
                      }}
                    >
                      <option value="none">{t("attendance.filterAllRecords")}</option>
                      <option value="day">{t("attendance.filterByDay")}</option>
                      <option value="month">{t("attendance.filterByMonth")}</option>
                    </select>
                    {attendanceHistoryAllFilterKind === "day" ? (
                      <input
                        className="date-input attendance-history-date"
                        type="date"
                        aria-label={t("attendance.dayAria")}
                        value={attendanceHistoryAllDayValue}
                        onChange={(e) => setAttendanceHistoryAllDayValue(e.target.value)}
                      />
                    ) : null}
                    {attendanceHistoryAllFilterKind === "month" ? (
                      <input
                        className="date-input report-month-input attendance-history-month"
                        type="month"
                        aria-label={t("attendance.monthAria")}
                        value={attendanceHistoryAllMonthValue}
                        onChange={(e) => setAttendanceHistoryAllMonthValue(e.target.value)}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
              <p className="attendance-history-count">{t("attendance.historyCount", { n: attendanceHistoryFiltered.length })}</p>
              <div className="attendance-history-list-wrap scroll-modern">
                {attendanceHistoryGrouped.length === 0 ? (
                  <p className="attendance-history-empty">{t("attendance.emptyHistory")}</p>
                ) : (
                  attendanceHistoryGrouped.map(({ date, items }) => {
                    const historyGrace = resolveLateGraceForEmployee(
                      attendanceHistoryEmployee,
                      salaryPolicy,
                      salaryPolicyEmployeeOverrides
                    );
                    return (
                    <section key={date} className="attendance-history-day-group" aria-label={date}>
                      <header className="attendance-history-day-head">
                        <span className="attendance-history-day-title">
                          {formatAttendanceHistoryDayHeader(date, locale)}
                        </span>
                        <span className="attendance-history-day-meta">
                          {t("attendance.historyDayCount", { n: items.length })}
                        </span>
                      </header>
                      <ul className="attendance-history-entries">
                        {items.map((rec) => {
                          const { inEl, outEl } = attendanceCheckInOutFragments(
                            attendanceHistoryEmployee,
                            rec,
                            date,
                            historyGrace
                          );
                          return (
                          <li key={rec.id} className="attendance-history-entry">
                            <div className="attendance-history-entry-row">
                              <div className="attendance-history-snaps">
                                <figure className="attendance-history-snap">
                                  <figcaption>{t("attendance.snapshotCheckIn")}</figcaption>
                                  {rec.checkInSnapshot ? (
                                    <button
                                      type="button"
                                      className="attendance-history-snap-btn"
                                      aria-label={t("attendance.snapshotEnlarge", { kind: t("attendance.snapshotCheckIn") })}
                                      onClick={() =>
                                        setAttendanceHistoryLightbox({
                                          src: resolveMediaUrl(rec.checkInSnapshot),
                                          label: t("attendance.snapshotCheckIn"),
                                        })
                                      }
                                    >
                                      <img
                                        src={resolveMediaUrl(rec.checkInSnapshot)}
                                        alt=""
                                        className="attendance-history-snap-img"
                                      />
                                    </button>
                                  ) : (
                                    <div className="attendance-history-snap-ph">{t("attendance.noSnapshot")}</div>
                                  )}
                                </figure>
                                <figure className="attendance-history-snap">
                                  <figcaption>{t("attendance.snapshotCheckOut")}</figcaption>
                                  {rec.checkOutSnapshot ? (
                                    <button
                                      type="button"
                                      className="attendance-history-snap-btn"
                                      aria-label={t("attendance.snapshotEnlarge", { kind: t("attendance.snapshotCheckOut") })}
                                      onClick={() =>
                                        setAttendanceHistoryLightbox({
                                          src: resolveMediaUrl(rec.checkOutSnapshot),
                                          label: t("attendance.snapshotCheckOut"),
                                        })
                                      }
                                    >
                                      <img
                                        src={resolveMediaUrl(rec.checkOutSnapshot)}
                                        alt=""
                                        className="attendance-history-snap-img"
                                      />
                                    </button>
                                  ) : (
                                    <div className="attendance-history-snap-ph">{t("attendance.noSnapshot")}</div>
                                  )}
                                </figure>
                              </div>
                              <div className="attendance-history-entry-meta" aria-label={t("attendance.recordSummaryAria")}>
                                <span className="attendance-history-inline-line">
                                  <span className="ah-meta-pair">
                                    <span className="ah-meta-k">{t("attendance.colCheckIn")}</span>
                                    <span className="ah-meta-v ah-attn-inline">
                                      <span className="check-in-out-cell ah-cio-history">{inEl}</span>
                                    </span>
                                  </span>
                                  <span className="ah-meta-dot" aria-hidden>
                                    ·
                                  </span>
                                  <span className="ah-meta-pair">
                                    <span className="ah-meta-k">{t("attendance.colCheckOut")}</span>
                                    <span className="ah-meta-v ah-attn-inline">
                                      <span className="check-in-out-cell ah-cio-history">{outEl}</span>
                                    </span>
                                  </span>
                                  <span className="ah-meta-dot" aria-hidden>
                                    ·
                                  </span>
                                  <span className={`ah-meta-pair ah-meta-late${rec.late ? " is-late" : ""}`}>
                                    <span className="ah-meta-k">{t("attendance.colLate")}</span>
                                    <span className="ah-meta-v">{rec.late ? t("attendance.yes") : t("attendance.no")}</span>
                                  </span>
                                </span>
                              </div>
                            </div>
                          </li>
                          );
                        })}
                      </ul>
                    </section>
                    );
                  })
                )}
              </div>
            </div>
            <div className="modal-footer">
              <div className="modal-actions">
                <button type="button" className="modal-btn modal-btn-primary" onClick={closeAttendanceHistoryModal}>
                  {t("common.close")}
                </button>
              </div>
            </div>
          </div>
        </div>
        {attendanceHistoryLightbox ? (
          <div
            className="attendance-snapshot-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={t("attendance.snapshotLightboxTitle")}
            onClick={() => setAttendanceHistoryLightbox(null)}
          >
            <button
              type="button"
              className="attendance-snapshot-lightbox-close"
              aria-label={t("common.close")}
              onClick={() => setAttendanceHistoryLightbox(null)}
            >
              <X size={22} strokeWidth={2} />
            </button>
            <div
              className="attendance-snapshot-lightbox-inner"
              role="presentation"
              onClick={(e) => e.stopPropagation()}
            >
              {attendanceHistoryLightbox.label ? (
                <p className="attendance-snapshot-lightbox-label">{attendanceHistoryLightbox.label}</p>
              ) : null}
              <div className="attendance-snapshot-lightbox-frame">
                <img
                  src={attendanceHistoryLightbox.src}
                  alt=""
                  className="attendance-snapshot-lightbox-img"
                  decoding="async"
                />
              </div>
            </div>
          </div>
        ) : null}
        </>
      ) : null}

      {salaryModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (salarySaveBusy) return;
            if (e.target === e.currentTarget) setSalaryModalOpen(false);
          }}
        >
          <div
            className="modal-panel modal-panel-size modal-panel-salary"
            role="dialog"
            aria-modal="true"
            aria-labelledby="salary-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <datalist id="salary-role-hints">
              {lavozimOptions.map((opt) => (
                <option key={opt} value={opt} />
              ))}
            </datalist>
            <div className="modal-header">
              <h3 id="salary-modal-title">{t("salary.modalTitle")}</h3>
              <button
                type="button"
                className="modal-close"
                disabled={salarySaveBusy}
                onClick={() => {
                  if (!salarySaveBusy) setSalaryModalOpen(false);
                }}
                aria-label={t("common.close")}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <div className="salary-modal-layout">
              <div className="salary-modal-toolbar">
                <div className="salary-tabs" role="tablist" aria-label={t("salary.tabsGroupAria")}>
                  <button
                    type="button"
                    role="tab"
                    id="salary-tab-role"
                    aria-selected={salaryModalTab === "role"}
                    aria-controls="salary-panel-role"
                    className={`salary-tab ${salaryModalTab === "role" ? "active" : ""}`}
                    disabled={salarySaveBusy}
                    onClick={() => setSalaryModalTab("role")}
                  >
                    {t("salary.tabRole")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="salary-tab-employee"
                    aria-selected={salaryModalTab === "employee"}
                    aria-controls="salary-panel-employee"
                    className={`salary-tab ${salaryModalTab === "employee" ? "active" : ""}`}
                    disabled={salarySaveBusy}
                    onClick={() => setSalaryModalTab("employee")}
                  >
                    {t("salary.tabEmployee")}
                  </button>
                </div>
              </div>

              <div className="modal-scroll scroll-modern">
                {salaryModalTab === "role" ? (
                  <div
                    className="salary-tab-panel"
                    role="tabpanel"
                    id="salary-panel-role"
                    aria-labelledby="salary-tab-role"
                  >
                    <div className="salary-hint salary-hint-callout">{t("salary.hintRole")}</div>
                    <div className="salary-role-rows">
                      <div className="salary-role-header">
                        <span>{t("salary.headRole")}</span>
                        <span>{t("salary.headPeriod")}</span>
                        <span>{t("salary.headAmount")}</span>
                        <span className="salary-role-header-actions" aria-hidden="true" />
                      </div>
                      {roleSalaryDraft.map((row, index) => (
                        <div className="salary-role-row" key={index}>
                          <input
                            type="text"
                            className="salary-input"
                            list="salary-role-hints"
                            autoComplete="off"
                            placeholder={t("salary.placeholderRole")}
                            value={row.role}
                            onChange={(e) =>
                              setRoleSalaryDraft((prev) =>
                                prev.map((r, i) => (i === index ? { ...r, role: e.target.value } : r))
                              )
                            }
                          />
                          <select
                            className="salary-input salary-input-compact"
                            aria-label={t("salary.headPeriod")}
                            value={row.type || "oy"}
                            onChange={(e) =>
                              setRoleSalaryDraft((prev) =>
                                prev.map((r, i) => (i === index ? { ...r, type: e.target.value } : r))
                              )
                            }
                          >
                            <option value="soat">{t("salary.rateKind.soat")}</option>
                            <option value="kun">{t("salary.rateKind.kun")}</option>
                            <option value="hafta">{t("salary.rateKind.hafta")}</option>
                            <option value="oy">{t("salary.rateKind.oy")}</option>
                          </select>
                          <input
                            type="text"
                            inputMode="numeric"
                            className="salary-input"
                            aria-label={t("salary.headAmount")}
                            placeholder={t("salary.placeholderAmount")}
                            value={row.salary}
                            onChange={(e) =>
                              setRoleSalaryDraft((prev) =>
                                prev.map((r, i) => (i === index ? { ...r, salary: e.target.value } : r))
                              )
                            }
                          />
                          <button
                            type="button"
                            className="salary-row-remove"
                            aria-label={t("salary.removeRowAria")}
                            disabled={salarySaveBusy}
                            onClick={() =>
                              setRoleSalaryDraft((prev) => {
                                const next = prev.filter((_, i) => i !== index);
                                return next.length > 0 ? next : [{ role: "", salary: "", type: "oy" }];
                              })
                            }
                          >
                            <Trash2 size={12} strokeWidth={1.75} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="salary-add-row-btn"
                      disabled={salarySaveBusy}
                      onClick={() =>
                        setRoleSalaryDraft((prev) => {
                          const hasEmptyRole = prev.some((r) => !String(r.role ?? "").trim());
                          if (hasEmptyRole) return prev; // faqat bitta bo'sh qator saqlaymiz
                          return [...prev, { role: "", salary: "", type: "oy" }];
                        })
                      }
                    >
                      <Plus size={14} strokeWidth={1.75} />
                      <span>{t("salary.addRoleRow")}</span>
                    </button>
                  </div>
                ) : (
                  <div
                    className="salary-tab-panel"
                    role="tabpanel"
                    id="salary-panel-employee"
                    aria-labelledby="salary-tab-employee"
                  >
                    <div className="salary-hint salary-hint-callout">{t("salary.hintEmployee")}</div>
                    <div className="salary-emp-list">
                      <div className="salary-emp-header">
                        <span>{t("salary.headEmployee")}</span>
                        <span>{t("salary.headPeriod")}</span>
                        <span>{t("salary.headOverrideAmount")}</span>
                        <span className="salary-emp-header-actions" aria-hidden="true" />
                      </div>
                      {employeeOverrideDraft.map((row) => {
                        const draftMap = draftRoleSalariesMap(roleSalaryDraft);
                        const base = salaryFromRoleMap(row.role, draftMap);
                        const hasOverride = String(row.value ?? "").trim() !== "";
                        return (
                          <div
                            className={`salary-emp-row${hasOverride ? " salary-emp-row--override" : ""}`}
                            key={row.id}
                          >
                            <div className="salary-emp-info">
                              <div className="salary-emp-name">{row.name}</div>
                              <div className="salary-emp-meta">
                                {row.role}
                                {base != null
                                  ? t("salary.baseLine", { amount: fmtMoney(base) })
                                  : t("salary.baseLine", { amount: t("common.emDash") })}
                              </div>
                            </div>
                            <select
                              className="salary-input salary-input-compact"
                              aria-label={t("salary.headPeriod")}
                              value={row.type || "oy"}
                              disabled={salarySaveBusy || !hasOverride}
                              onChange={(e) =>
                                setEmployeeOverrideDraft((prev) =>
                                  prev.map((r) => (sameEmployeeId(r.id, row.id) ? { ...r, type: e.target.value } : r))
                                )
                              }
                            >
                              <option value="soat">{t("salary.rateKind.soat")}</option>
                              <option value="kun">{t("salary.rateKind.kun")}</option>
                              <option value="hafta">{t("salary.rateKind.hafta")}</option>
                              <option value="oy">{t("salary.rateKind.oy")}</option>
                            </select>
                            <input
                              type="text"
                              inputMode="numeric"
                              className="salary-input salary-input-compact"
                              placeholder={t("salary.placeholderOverride")}
                              value={row.value}
                              aria-label={t("salary.headOverrideAmount")}
                              onChange={(e) =>
                                setEmployeeOverrideDraft((prev) =>
                                  prev.map((r) =>
                                    sameEmployeeId(r.id, row.id) ? { ...r, value: e.target.value } : r
                                  )
                                )
                              }
                            />
                            <button
                              type="button"
                              className="salary-override-clear"
                              disabled={salarySaveBusy || !hasOverride}
                              aria-label={t("salary.clearOverrideAria")}
                              onClick={() =>
                                setEmployeeOverrideDraft((prev) =>
                                  prev.map((r) =>
                                    sameEmployeeId(r.id, row.id) ? { ...r, value: "", type: "oy" } : r
                                  )
                                )
                              }
                            >
                              <RotateCcw size={13} strokeWidth={1.75} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="modal-footer">
                <div className="modal-actions">
                  <button
                    type="button"
                    className="modal-btn modal-btn-ghost"
                    disabled={salarySaveBusy}
                    onClick={() => setSalaryModalOpen(false)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="modal-btn modal-btn-primary"
                    disabled={salarySaveBusy}
                    onClick={saveSalarySettings}
                  >
                    {salarySaveBusy ? t("common.saving") : t("common.save")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {userCreateModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeCreateUserModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size modal-panel-admin-form"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-create-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="user-create-title">{t("admin.createTitle")}</h3>
              <button
                type="button"
                className="modal-close"
                onClick={closeCreateUserModal}
                aria-label={t("common.close")}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>

            <form className="modal-panel-form" onSubmit={submitCreateUser}>
              <div className="modal-scroll scroll-modern">
                <div className="modal-field">
                  <label htmlFor="user-login">{t("login.loginLabel")}</label>
                  <input
                    id="user-login"
                    autoComplete="username"
                    value={userCreateForm.username}
                    onChange={(e) => setUserCreateForm((f) => ({ ...f, username: e.target.value }))}
                    required
                    placeholder={t("admin.placeholderLogin")}
                  />
                </div>

                <div className="modal-field">
                  <label htmlFor="user-password">{t("login.passwordLabel")}</label>
                  <input
                    id="user-password"
                    type="password"
                    autoComplete="new-password"
                    value={userCreateForm.password}
                    onChange={(e) => setUserCreateForm((f) => ({ ...f, password: e.target.value }))}
                    required
                    placeholder={t("admin.placeholderPassword")}
                  />
                </div>

                <div className="modal-field">
                  <label htmlFor="user-role">{t("admin.roleLabel")}</label>
                  <select
                    id="user-role"
                    value={userCreateForm.role}
                    onChange={(e) => setUserCreateForm((f) => ({ ...f, role: e.target.value }))}
                    required
                  >
                    <option value="superadmin">{t("admin.roleSuperadmin")}</option>
                    <option value="admin">{t("admin.roleAdmin")}</option>
                    <option value="hodim">{t("admin.roleHodim")}</option>
                  </select>
                </div>

                {userCreateForm.role === "hodim" ? (
                  <div className="modal-field">
                    <label htmlFor="user-employee">{t("admin.employeeIdLabel")}</label>
                    <select
                      id="user-employee"
                      value={userCreateForm.employeeId}
                      onChange={(e) => setUserCreateForm((f) => ({ ...f, employeeId: e.target.value }))}
                      required
                    >
                      <option value="">{t("common.select")}</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={String(emp.id)}>
                          {emp.id} · {emp.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {userCreateForm.role === "admin" ? (
                  <div className="filial-block">
                    <div className="filial-block-head">
                      <label className="filial-block-label" htmlFor="user-filial-input">
                        {t("admin.filialsLabel")}
                      </label>
                      <span className="filial-block-count">
                        {userCreateForm.filials.length > 0 ? t("common.countItems", { n: userCreateForm.filials.length }) : ""}
                      </span>
                    </div>
                    <div className="filial-add-bar">
                      <input
                        id="user-filial-input"
                        type="text"
                        className="filial-add-input"
                        value={userCreateFilialInput}
                        onChange={(e) => setUserCreateFilialInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addFilialToList(setUserCreateForm, userCreateFilialInput, setUserCreateFilialInput, localeToBcp47(locale));
                          }
                        }}
                        placeholder={t("admin.filialPlaceholder")}
                        list="filial-hints-create"
                        autoComplete="off"
                      />
                      <datalist id="filial-hints-create">
                        {filialOptions
                          .filter(
                            (x) =>
                              !userCreateForm.filials.some((f) => String(f).toLowerCase() === String(x).toLowerCase())
                          )
                          .map((f) => (
                            <option key={f} value={f} />
                          ))}
                      </datalist>
                      <button
                        type="button"
                        className="filial-add-icon-btn"
                        aria-label={t("admin.addFilialAria")}
                        title={t("common.add")}
                        onClick={() =>
                          addFilialToList(
                            setUserCreateForm,
                            userCreateFilialInput,
                            setUserCreateFilialInput,
                            localeToBcp47(locale)
                          )
                        }
                      >
                        <Plus size={18} strokeWidth={2.25} />
                      </button>
                    </div>
                    <div className="filial-chips-scroll scroll-modern" aria-label={t("admin.filialsLinkedAria")}>
                      {userCreateForm.filials.length === 0 ? (
                        <div className="filial-empty-inner">{t("admin.filialEmptyHint")}</div>
                      ) : (
                        [...userCreateForm.filials].sort((a, b) => a.localeCompare(b, localeToBcp47(locale))).map((f) => (
                          <div key={f} className="filial-chip">
                            <span className="filial-chip-text">{f}</span>
                            <button
                              type="button"
                              className="filial-chip-remove"
                              onClick={() => removeUserFilial(setUserCreateForm, f)}
                              aria-label={t("common.removeFilialChip", { name: f })}
                            >
                              <X size={14} strokeWidth={1.75} />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}

                {userCreateError ? <p className="login-err">{userCreateError}</p> : null}
              </div>

              <div className="modal-footer">
                <div className="modal-actions">
                  <button type="button" className="modal-btn modal-btn-ghost" onClick={closeCreateUserModal}>
                    {t("common.cancel")}
                  </button>
                  <button type="submit" className="modal-btn modal-btn-primary" disabled={userCreateBusy}>
                    {userCreateBusy ? t("common.loading") : t("common.save")}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {userEditModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEditUserModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size modal-panel-admin-form"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="admin-edit-title">
                {userEditForm.role === "hodim"
                  ? t("admin.editHodim")
                  : userEditForm.role === "superadmin"
                    ? t("admin.editSuper")
                    : t("admin.editAdmin")}
              </h3>
              <button type="button" className="modal-close" onClick={closeEditUserModal} aria-label={t("common.close")}>
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>

            <form className="modal-panel-form" onSubmit={submitEditUser}>
              <div className="modal-scroll scroll-modern">
                <div className="modal-field">
                  <label htmlFor="edit-username">{t("login.loginLabel")}</label>
                  <input id="edit-username" value={userEditForm.id ? String(users.find((x) => x.id === userEditForm.id)?.username || "") : ""} disabled />
                </div>

                <div className="modal-field">
                  <label htmlFor="edit-role">{t("admin.roleLabel")}</label>
                  <select
                    id="edit-role"
                    value={userEditForm.role}
                    onChange={async (e) => {
                      const next = e.target.value;
                      if (next === "admin" && userEditForm.id) {
                        setUserEditFilialsLoading(true);
                        try {
                          const d = await api.getUserFilials(userEditForm.id);
                          setUserEditForm((f) => ({
                            ...f,
                            role: next,
                            filials: Array.isArray(d?.filials) ? d.filials : [],
                          }));
                        } catch (err) {
                          setUserEditError(translateApiError(err instanceof Error ? err.message : String(err), locale));
                          setUserEditForm((f) => ({ ...f, role: next }));
                        } finally {
                          setUserEditFilialsLoading(false);
                        }
                      } else {
                        setUserEditForm((f) => ({ ...f, role: next, filials: [] }));
                      }
                    }}
                    required
                  >
                    <option value="superadmin">{t("admin.roleSuperadmin")}</option>
                    <option value="admin">{t("admin.roleAdmin")}</option>
                    <option value="hodim">{t("admin.roleHodim")}</option>
                  </select>
                </div>

                {userEditForm.role === "hodim" ? (
                  <div className="modal-field">
                    <label htmlFor="edit-employee">{t("admin.employeeIdLabel")}</label>
                    <select
                      id="edit-employee"
                      value={userEditForm.employeeId}
                      onChange={(e) => setUserEditForm((f) => ({ ...f, employeeId: e.target.value }))}
                      required
                    >
                      <option value="">{t("common.select")}</option>
                      {employees.map((emp) => (
                        <option key={emp.id} value={String(emp.id)}>
                          {emp.id} · {emp.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {userEditForm.role === "admin" ? (
                  <div className="filial-block">
                    <div className="filial-block-head">
                      <label className="filial-block-label" htmlFor="edit-filial-input">
                        {t("admin.filialsLabel")}
                      </label>
                      <span className="filial-block-count">
                        {!userEditFilialsLoading && userEditForm.filials.length > 0
                          ? t("common.countItems", { n: userEditForm.filials.length })
                          : ""}
                      </span>
                    </div>
                    {userEditFilialsLoading ? (
                      <p className="salary-hint">{t("common.loading")}</p>
                    ) : (
                      <>
                        <div className="filial-add-bar">
                          <input
                            id="edit-filial-input"
                            type="text"
                            className="filial-add-input"
                            value={userEditFilialInput}
                            onChange={(e) => setUserEditFilialInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                addFilialToList(setUserEditForm, userEditFilialInput, setUserEditFilialInput, localeToBcp47(locale));
                              }
                            }}
                            placeholder={t("admin.filialPlaceholder")}
                            list="filial-hints-edit"
                            autoComplete="off"
                          />
                          <datalist id="filial-hints-edit">
                            {filialOptions
                              .filter(
                                (x) =>
                                  !userEditForm.filials.some((f) => String(f).toLowerCase() === String(x).toLowerCase())
                              )
                              .map((f) => (
                                <option key={f} value={f} />
                              ))}
                          </datalist>
                          <button
                            type="button"
                            className="filial-add-icon-btn"
                            aria-label={t("admin.addFilialAria")}
                            title={t("common.add")}
                            onClick={() =>
                              addFilialToList(
                                setUserEditForm,
                                userEditFilialInput,
                                setUserEditFilialInput,
                                localeToBcp47(locale)
                              )
                            }
                          >
                            <Plus size={18} strokeWidth={2.25} />
                          </button>
                        </div>
                        <div className="filial-chips-scroll scroll-modern" aria-label={t("admin.filialsLinkedAria")}>
                          {userEditForm.filials.length === 0 ? (
                            <div className="filial-empty-inner">{t("admin.filialEmptyHint")}</div>
                          ) : (
                            [...userEditForm.filials].sort((a, b) => a.localeCompare(b, localeToBcp47(locale))).map((f) => (
                              <div key={f} className="filial-chip">
                                <span className="filial-chip-text">{f}</span>
                                <button
                                  type="button"
                                  className="filial-chip-remove"
                                  onClick={() => removeUserFilial(setUserEditForm, f)}
                                  aria-label={t("common.removeFilialChip", { name: f })}
                                >
                                  <X size={14} strokeWidth={1.75} />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}

                <div className="modal-field">
                  <label htmlFor="edit-password">{t("admin.passwordOptional")}</label>
                  <input
                    id="edit-password"
                    type="password"
                    autoComplete="new-password"
                    value={userEditForm.password}
                    onChange={(e) => setUserEditForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder={t("admin.passwordOptionalPh")}
                  />
                </div>

                {userEditError ? <p className="login-err">{userEditError}</p> : null}
              </div>

              <div className="modal-footer">
                <div className="modal-actions">
                  <button type="button" className="modal-btn modal-btn-ghost" onClick={closeEditUserModal}>
                    {t("common.cancel")}
                  </button>
                  <button type="submit" className="modal-btn modal-btn-primary" disabled={userEditBusy}>
                    {userEditBusy ? t("common.loading") : t("common.save")}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {userSubscriptionModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeUserSubscriptionModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-subscription-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="user-subscription-title">{t("admin.subscriptionModalTitle")}</h3>
              <button
                type="button"
                className="modal-close"
                onClick={closeUserSubscriptionModal}
                aria-label={t("common.close")}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>

            <form className="modal-panel-form" onSubmit={submitUserSubscription}>
              <div className="modal-scroll scroll-modern">
                <div className="modal-field">
                  <label htmlFor="sub-endAt">{t("admin.subscriptionEnd")}</label>
                  <input
                    id="sub-endAt"
                    type="datetime-local"
                    value={userSubscriptionForm.endAt}
                    onChange={(e) => setUserSubscriptionForm((f) => ({ ...f, endAt: e.target.value }))}
                    required
                  />
                </div>

                <div className="modal-field">
                  <label htmlFor="sub-amount">{t("admin.subscriptionAmount")}</label>
                  <input
                    id="sub-amount"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={userSubscriptionForm.amount}
                    onChange={(e) => setUserSubscriptionForm((f) => ({ ...f, amount: e.target.value }))}
                    required
                    placeholder={t("admin.subscriptionPlaceholderAmount")}
                  />
                </div>

                <div className="modal-field">
                  <label htmlFor="sub-text">{t("admin.subscriptionText")}</label>
                  <textarea
                    id="sub-text"
                    className="notice-textarea"
                    value={userSubscriptionForm.text}
                    onChange={(e) => setUserSubscriptionForm((f) => ({ ...f, text: e.target.value }))}
                    required
                  />
                </div>

                {userSubscriptionError ? <p className="login-err">{userSubscriptionError}</p> : null}
              </div>

              <div className="modal-footer">
                <div className="modal-actions">
                  <button type="button" className="modal-btn modal-btn-ghost" onClick={closeUserSubscriptionModal}>
                    {t("common.cancelShort")}
                  </button>
                  <button type="submit" className="modal-btn modal-btn-primary" disabled={userSubscriptionBusy}>
                    {userSubscriptionBusy ? t("common.loading") : t("common.save")}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {terminalModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setTerminalModalOpen(false);
          }}
        >
          <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="terminal-create-title" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 id="terminal-create-title">{t("terminal.createTitle")}</h3>
              <button type="button" className="modal-close" onClick={() => setTerminalModalOpen(false)} aria-label={t("common.close")}>
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <form className="modal-form" onSubmit={submitTerminalForm}>
              <div className="modal-field">
                <label htmlFor="terminal-name">{t("terminal.name")}</label>
                <input
                  id="terminal-name"
                  value={terminalForm.terminalName}
                  onChange={(e) => setTerminalForm((f) => ({ ...f, terminalName: e.target.value }))}
                  required
                />
              </div>
              <div className="modal-field">
                <label htmlFor="terminal-admin">{t("terminal.selectAdmin")}</label>
                <select
                  id="terminal-admin"
                  value={terminalForm.adminId}
                  onChange={(e) => setTerminalForm((f) => ({ ...f, adminId: e.target.value }))}
                  required
                >
                  <option value="">{t("common.select")}</option>
                  {terminalAdminOptions.map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.username}
                    </option>
                  ))}
                </select>
              </div>
              <div className="modal-field">
                <label htmlFor="terminal-type">{t("terminal.type")}</label>
                <select
                  id="terminal-type"
                  value={terminalForm.terminalType}
                  onChange={(e) => setTerminalForm((f) => ({ ...f, terminalType: e.target.value === "Chiqish" ? "Chiqish" : "Kirish" }))}
                  required
                >
                  <option value="Kirish">{t("terminal.typeIn")}</option>
                  <option value="Chiqish">{t("terminal.typeOut")}</option>
                </select>
              </div>
              <div className="modal-field">
                <label htmlFor="terminal-ip">{t("terminal.ipAddress")}</label>
                <input
                  id="terminal-ip"
                  value={terminalForm.ipAddress}
                  onChange={(e) => setTerminalForm((f) => ({ ...f, ipAddress: e.target.value }))}
                  placeholder={t("terminal.ipPlaceholder")}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </div>
              <div className="modal-field">
                <label htmlFor="terminal-login">{t("terminal.login")}</label>
                <input
                  id="terminal-login"
                  value={terminalForm.login}
                  onChange={(e) => setTerminalForm((f) => ({ ...f, login: e.target.value }))}
                  required
                />
              </div>
              <div className="modal-field">
                <label htmlFor="terminal-password">{t("terminal.password")}</label>
                <input
                  id="terminal-password"
                  type="text"
                  value={terminalForm.password}
                  onChange={(e) => setTerminalForm((f) => ({ ...f, password: e.target.value }))}
                  required
                />
              </div>
              {terminalSaveError ? <p className="login-err">{terminalSaveError}</p> : null}
              <div className="modal-actions">
                <button type="button" className="modal-btn modal-btn-ghost" onClick={() => setTerminalModalOpen(false)}>
                  {t("common.cancelShort")}
                </button>
                <button type="submit" className="modal-btn modal-btn-primary" disabled={terminalSaveBusy}>
                  {terminalSaveBusy ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {terminalProbeOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !terminalProbeBusy) closeTerminalProbeModal();
          }}
        >
          <div
            className="modal-panel modal-panel-terminal-probe"
            role="dialog"
            aria-modal="true"
            aria-labelledby="terminal-probe-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="terminal-probe-title">{t("terminal.probeTitle")}</h3>
              <button
                type="button"
                className="modal-close"
                disabled={terminalProbeBusy}
                onClick={closeTerminalProbeModal}
                aria-label={t("common.close")}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <div className="modal-form terminal-probe-body">
              <p className="terminal-probe-terminal-name">
                <strong>{terminalProbeName}</strong>
              </p>
              {terminalProbeBusy ? (
                <p className="salary-hint">{t("terminal.probeRunning")}</p>
              ) : terminalProbeResult ? (
                <>
                  {terminalProbeResult.baseUrl ? (
                    <p className="terminal-probe-base">
                      <span className="terminal-probe-label">{t("terminal.probeBaseUrl")}:</span>{" "}
                      <code className="terminal-probe-code">{terminalProbeResult.baseUrl}</code>
                    </p>
                  ) : null}
                  {terminalProbeResult.error ? <p className="login-err">{terminalProbeResult.error}</p> : null}
                  {terminalProbeResult.contextHint ? (
                    <p className="salary-hint terminal-probe-context">{terminalProbeResult.contextHint}</p>
                  ) : null}
                  <ul className="terminal-probe-steps">
                    {(terminalProbeResult.steps || []).map((s) => (
                      <li key={s.id} className={`terminal-probe-step ${s.ok ? "terminal-probe-step-ok" : "terminal-probe-step-fail"}`}>
                        <div className="terminal-probe-step-title">
                          {s.id === "userInfoSearch" ? t("terminal.probeStepUser") : null}
                          {s.id === "acsEvent" ? t("terminal.probeStepEvents") : null}
                          {!["userInfoSearch", "acsEvent"].includes(s.id) ? s.id : null}
                        </div>
                        <div className="terminal-probe-step-meta">
                          {t("terminal.probeHttp", { status: s.httpStatus ?? "—" })}
                          {s.userCount != null ? (
                            <span className="terminal-probe-step-count">
                              {" · "}
                              {t("terminal.probeUsersFound", { n: s.userCount })}
                            </span>
                          ) : null}
                          {s.eventCount != null ? (
                            <span className="terminal-probe-step-count">
                              {" · "}
                              {t("terminal.probeEventsFound", { n: s.eventCount })}
                            </span>
                          ) : null}
                        </div>
                        {s.hint ? <pre className="terminal-probe-hint">{s.hint}</pre> : null}
                      </li>
                    ))}
                  </ul>
                  {terminalProbeResult.ok ? (
                    <p className="salary-hint terminal-probe-summary-ok">{t("terminal.probeSuccess")}</p>
                  ) : (terminalProbeResult.steps || []).length > 0 ? (
                    <p className="login-err terminal-probe-summary-fail">{t("terminal.probePartial")}</p>
                  ) : null}
                </>
              ) : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="modal-btn modal-btn-primary"
                  disabled={terminalProbeBusy}
                  onClick={closeTerminalProbeModal}
                >
                  {t("terminal.probeClose")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {adminSubModalOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (adminSubModalPersistent) return;
            if (e.target === e.currentTarget) {
              dismissAdminSubscriptionModal();
            }
          }}
        >
          <div
            className={`modal-panel modal-panel-size modal-panel-admin-sub-near`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-sub-notice-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3
                id="admin-sub-notice-title"
                className="sr-only"
              >
                {adminSubModalPersistent ? t("admin.modalExpiredTitle") : t("admin.modalNearExpiryTitle")}
              </h3>
              {adminSubModalPersistent ? (
                <button type="button" className="modal-close" onClick={logout} aria-label={t("sidebar.logout")}>
                  <X size={15} strokeWidth={1.75} />
                </button>
              ) : (
                  <button
                    type="button"
                    className="modal-close"
                    onClick={dismissAdminSubscriptionModal}
                    aria-label={t("common.close")}
                  >
                    <X size={15} strokeWidth={1.75} />
                  </button>
              )}
            </div>

            <div className="modal-scroll scroll-modern">
              {adminSubModalPersistent ? (
                <div className="admin-sub-near-card">
                  <div className="admin-sub-near-title admin-sub-near-title-center">
                        <Clock3 size={16} strokeWidth={1.75} />
                    <span>{t("admin.modalExpiredTitle")}</span>
                  </div>
                  <p className="admin-sub-near-message admin-sub-near-message-center">
                    {adminSubText
                      ? adminSubText
                      : t("admin.modalExpiredBody")}
                  </p>
                </div>
              ) : (
                <div className="admin-sub-near-card">
                  <div className="admin-sub-near-title admin-sub-near-title-center">
                    <Clock3 size={16} strokeWidth={1.75} />
                    <span>{t("admin.modalNearExpiryTitle")}</span>
                  </div>
                  <p className="admin-sub-near-message">
                    {adminSubText
                      ? adminSubText
                      : t("admin.modalNearExpiryBody")}
                  </p>
                </div>
              )}

              {adminSubEndAt ? (
                <div style={{ marginTop: 10, textAlign: "center" }}>
                  <p className="admin-sub-endat-text" style={{ margin: 0, display: "inline-block" }}>
                    {t("admin.endsAt")}{" "}
                    {new Date(adminSubEndAt).toLocaleString(localeToBcp47(locale), {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              ) : null}
            </div>

            {adminSubModalPersistent ? null : null}
          </div>
        </div>
      ) : null}

      {dbEditOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDbEditModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size"
            role="dialog"
            aria-modal="true"
            aria-labelledby="db-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="db-edit-title">{t("baza.editRowTitle")}</h3>
              <button type="button" className="modal-close" onClick={closeDbEditModal} aria-label={t("common.close")}>
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>

            <form className="modal-panel-form" onSubmit={submitDbEdit}>
              <div className="modal-scroll scroll-modern">
                {Array.isArray(dbMeta?.tables) && (() => {
                  const cfg = dbMeta.tables.find((t) => t.name === dbEditTable);
                  if (!cfg) return null;
                  const editableCols = cfg.columns.filter((c) => c.editable);
                  return editableCols.map((c) => {
                    const name = c.name;
                    const type = c.type;
                    const label = name;
                    const val = dbEditDraft?.[name];
                    if (type === "boolean") {
                      return (
                        <div className="modal-field" key={name}>
                          <label htmlFor={`db-edit-${name}`}> {label} </label>
                          <div style={{ marginTop: 6 }}>
                            <input
                              id={`db-edit-${name}`}
                              type="checkbox"
                              checked={!!val}
                              onChange={(e) => setDbEditDraft((d) => ({ ...d, [name]: e.target.checked }))}
                            />
                          </div>
                        </div>
                      );
                    }
                    if (type === "date") {
                      return (
                        <div className="modal-field" key={name}>
                          <label htmlFor={`db-edit-${name}`}>{label}</label>
                          <input
                            id={`db-edit-${name}`}
                            type="date"
                            value={val || ""}
                            onChange={(e) => setDbEditDraft((d) => ({ ...d, [name]: e.target.value }))}
                          />
                        </div>
                      );
                    }
                    if (type === "timestamptz") {
                      return (
                        <div className="modal-field" key={name}>
                          <label htmlFor={`db-edit-${name}`}>{label}</label>
                          <input
                            id={`db-edit-${name}`}
                            type="datetime-local"
                            value={val || ""}
                            onChange={(e) => setDbEditDraft((d) => ({ ...d, [name]: e.target.value }))}
                          />
                        </div>
                      );
                    }
                    if (type === "jsonb" || name.toLowerCase().includes("template")) {
                      return (
                        <div className="modal-field" key={name}>
                          <label htmlFor={`db-edit-${name}`}>{label}</label>
                          <textarea
                            id={`db-edit-${name}`}
                            className="notice-textarea"
                            value={val || ""}
                            onChange={(e) => setDbEditDraft((d) => ({ ...d, [name]: e.target.value }))}
                          />
                        </div>
                      );
                    }
                    if (name.toLowerCase().includes("amount") || name.endsWith("_id") || name === "id") {
                      return (
                        <div className="modal-field" key={name}>
                          <label htmlFor={`db-edit-${name}`}>{label}</label>
                          <input
                            id={`db-edit-${name}`}
                            type="text"
                            value={val || ""}
                            onChange={(e) => setDbEditDraft((d) => ({ ...d, [name]: e.target.value }))}
                          />
                        </div>
                      );
                    }
                    return (
                      <div className="modal-field" key={name}>
                        <label htmlFor={`db-edit-${name}`}>{label}</label>
                        <input
                          id={`db-edit-${name}`}
                          type="text"
                          value={val || ""}
                          onChange={(e) => setDbEditDraft((d) => ({ ...d, [name]: e.target.value }))}
                        />
                      </div>
                    );
                  });
                })()}

                {dbEditError ? <p className="login-err">{dbEditError}</p> : null}
              </div>

              <div className="modal-footer">
                <div className="modal-actions">
                  <button type="button" className="modal-btn modal-btn-ghost" onClick={closeDbEditModal}>
                    {t("common.cancelShort")}
                  </button>
                  <button type="submit" className="modal-btn modal-btn-primary" disabled={dbEditBusy}>
                    {dbEditBusy ? t("common.saving") : t("common.save")}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editForm ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEditModal();
          }}
        >
          <div
            className="modal-panel modal-panel-size modal-panel-edit"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id="edit-modal-title">{t("editEmployee.title")}</h3>
              <button type="button" className="modal-close" onClick={closeEditModal} aria-label={t("common.close")}>
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
            <form className="modal-panel-form" onSubmit={submitEditModal}>
              <div className="modal-scroll scroll-modern">
                <div className="modal-row">
                  <div className="modal-field">
                    <label htmlFor="edit-name">{t("editEmployee.fullName")}</label>
                    <input
                      id="edit-name"
                      autoComplete="name"
                      value={editForm.name}
                      onChange={(e) => setEditForm((f) => (f ? { ...f, name: e.target.value } : f))}
                      required
                    />
                  </div>
                  <div className="modal-field">
                    <label htmlFor="employee-edit-role">{t("editEmployee.role")}</label>
                    <select
                      id="employee-edit-role"
                      value={editForm.role}
                      onChange={(e) => setEditForm((f) => (f ? { ...f, role: e.target.value } : f))}
                      required
                    >
                      {editForm.role && !lavozimSelectOptions.includes(editForm.role) ? (
                        <option value={editForm.role}>{editForm.role}</option>
                      ) : null}
                      {lavozimSelectOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="modal-field modal-field-filial">
                  <label htmlFor="edit-filial">{t("editEmployee.branch")}</label>
                  <select
                    id="edit-filial"
                    value={editForm.filial}
                    onChange={(e) => setEditForm((f) => (f ? { ...f, filial: e.target.value } : f))}
                    required
                  >
                    {editFilialOptions.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="schedule-block">
                  <div className="schedule-block-title">
                    <Clock3 size={15} strokeWidth={1.75} aria-hidden />
                    <span>{t("schedule.title")}</span>
                  </div>
                  {WEEKDAY_KEYS.map(({ key, labelKey }) => {
                    const day = editForm.weeklySchedule?.[key];
                    if (!day) return null;
                    const dayLabel = t(labelKey);
                    return (
                      <div className="schedule-day-row" key={key}>
                        <span className="schedule-day-name">{dayLabel}</span>
                        <label className="schedule-ish-kuni">
                          <input
                            type="checkbox"
                            checked={day.work}
                            aria-label={t("schedule.workDayCheck", { day: dayLabel })}
                            onChange={(e) => patchEditScheduleDay(key, { work: e.target.checked })}
                          />
                        </label>
                        <div className="schedule-time-field">
                          <span>{t("schedule.from")}</span>
                          <input
                            type="time"
                            className="schedule-time-input"
                            value={day.start}
                            disabled={!day.work}
                            onChange={(e) => patchEditScheduleDay(key, { start: e.target.value })}
                          />
                        </div>
                        <div className="schedule-time-field">
                          <span>{t("schedule.to")}</span>
                          <input
                            type="time"
                            className="schedule-time-input"
                            value={day.end}
                            disabled={!day.work}
                            onChange={(e) => patchEditScheduleDay(key, { end: e.target.value })}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="modal-footer">
                <div className="modal-actions">
                  <button type="button" className="modal-btn modal-btn-ghost" onClick={closeEditModal}>
                    {t("common.cancel")}
                  </button>
                  <button type="submit" className="modal-btn modal-btn-primary">
                    {t("common.save")}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
