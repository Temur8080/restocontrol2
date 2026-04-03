/** Hodim smenasi (frontend getShiftForDate bilan mos). */

function dateKeyFromISO(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return "mon";
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[d.getDay()];
}

function parseHHMMToMinutes(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return h * 60 + min;
}

/**
 * @param {object} row — employees qatori: shift_start, shift_end, weekly_schedule
 * @param {string} dateStr — YYYY-MM-DD
 */
export function getShiftForEmployeeRow(row, dateStr) {
  const shiftStart = row.shift_start != null && String(row.shift_start).trim() !== "" ? String(row.shift_start).trim() : "09:00";
  const shiftEnd = row.shift_end != null && String(row.shift_end).trim() !== "" ? String(row.shift_end).trim() : "18:00";
  let ws = row.weekly_schedule;
  if (ws && typeof ws === "string") {
    try {
      ws = JSON.parse(ws);
    } catch {
      ws = null;
    }
  }
  if (ws && typeof ws === "object") {
    const key = dateKeyFromISO(dateStr);
    const day = ws[key];
    if (day && typeof day === "object") {
      return {
        work: !!day.work,
        start: day.start != null && String(day.start).trim() !== "" ? String(day.start).trim() : shiftStart,
        end: day.end != null && String(day.end).trim() !== "" ? String(day.end).trim() : shiftEnd,
      };
    }
  }
  return { work: true, start: shiftStart, end: shiftEnd };
}

/**
 * Kelish vaqti smena boshlanishidan grace dan keyin bo‘lsa — kechikkan.
 */
export function computeCheckInLateFlag(row, recordDate, checkInHHMM, graceMinutes) {
  const sh = getShiftForEmployeeRow(row, recordDate);
  if (!sh.work) return false;
  const cin = parseHHMMToMinutes(checkInHHMM);
  const st = parseHHMMToMinutes(sh.start);
  if (cin == null || st == null) return false;
  const g = Math.max(0, Number(graceMinutes) || 0);
  return cin > st + g;
}

export async function fetchGlobalLateGraceMinutes(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_kv WHERE key = 'salary_policy_late_grace_minutes' ORDER BY admin_id NULLS FIRST LIMIT 1`
    );
    const n = Number(rows[0]?.value);
    if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  } catch {
    /* ignore */
  }
  return 5;
}

/** Hodim bo‘yicha kechikish «sabr» daqiqalari (global + salary_policy_employee_overrides). */
export async function fetchLateGraceForEmployee(pool, employeeId) {
  const fallback = await fetchGlobalLateGraceMinutes(pool);
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_kv WHERE key = 'salary_policy_employee_overrides' ORDER BY admin_id NULLS FIRST LIMIT 1`
    );
    const raw = rows[0]?.value;
    if (raw == null || String(raw).trim() === "") return fallback;
    const obj = JSON.parse(String(raw));
    const v = obj[String(employeeId)];
    const g = Number(v?.lateGraceMinutes);
    if (Number.isFinite(g)) return Math.max(0, Math.trunc(g));
  } catch {
    /* ignore */
  }
  return fallback;
}
