import {
  normalizeTerminalBaseUrl,
  fetchHikvisionUsers,
  fetchHikvisionEvents,
  eventTimeIso,
  eventDedupeKey,
  eventEmployeeName,
  normalizeEmployeeEventName,
  deviceEventDateTimeWithTargetOffset,
  DEFAULT_TIMEOUT_MS,
} from "./terminalHikvision.js";
import { computeCheckInLateFlag, fetchLateGraceForEmployee } from "./shiftUtils.js";
import { resolveSnapshotForTerminalEvent } from "./attendanceFaceImages.js";
import { employeeMatchByNormalizedNameSql } from "./employeeAccessCards.js";
import { isCheckoutTerminalType, isExitLikeAccessEvent } from "./hikvisionAccessDirection.js";
import { isPrivateLanHostname } from "./terminalProbe.js";

export function rowToAttendanceRow(row) {
  if (!row) return null;
  let d = row.record_date;
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    d = `${y}-${m}-${day}`;
  } else if (typeof d === "string" && d.length > 10) d = d.slice(0, 10);
  const cinS = row.check_in_snapshot != null ? String(row.check_in_snapshot).trim() : "";
  const coutS = row.check_out_snapshot != null ? String(row.check_out_snapshot).trim() : "";
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    date: d,
    checkIn: row.check_in,
    checkOut: row.check_out == null ? "" : String(row.check_out),
    late: !!row.late,
    checkInSnapshot: cinS || null,
    checkOutSnapshot: coutS || null,
  };
}

async function getDefaultFilialForAdmin(pool, adminId) {
  const { rows } = await pool.query(
    `SELECT filial FROM admin_filial_map WHERE admin_id = $1 ORDER BY filial ASC LIMIT 1`,
    [adminId]
  );
  return rows[0]?.filial != null && String(rows[0].filial).trim() !== ""
    ? String(rows[0].filial).trim()
    : "Asosiy filial";
}

/**
 * Terminaldan hodimlar: faqat ism (qurilma id/karta raqami bazaga yozilmaydi).
 */
export async function syncEmployeesFromTerminal(pool, terminalRow) {
  const norm = normalizeTerminalBaseUrl(terminalRow.ip_address);
  if (norm.error) return { ok: false, error: norm.error, created: 0, updated: 0, total: 0 };

  const { users, ok, error } = await fetchHikvisionUsers(
    norm.baseUrl,
    terminalRow.login,
    terminalRow.password,
    DEFAULT_TIMEOUT_MS
  );
  if (!ok) {
    let errMsg = error || "UserInfo xatosi";
    try {
      const host = new URL(norm.baseUrl).hostname.toLowerCase().replace(/^::ffff:/i, "");
      if (isPrivateLanHostname(host)) {
        errMsg +=
          " Ichki tarmoq manzili: agar server Internetdagi VPS bo‘lsa, bu yerdan ISAPI (hodimlarni yuklash) ishlamaydi — VPN yoki serverni LAN da ishlating.";
      }
    } catch {
      /* ignore */
    }
    return { ok: false, error: errMsg, created: 0, updated: 0, total: 0 };
  }

  const adminId = Number(terminalRow.admin_id);
  if (!Number.isFinite(adminId)) return { ok: false, error: "Admin id yo'q", created: 0, updated: 0, total: 0 };

  const defaultFilial = await getDefaultFilialForAdmin(pool, adminId);
  let created = 0;
  let updated = 0;

  for (const u of users) {
    const nm = normalizeEmployeeEventName(u.name || "");
    if (!nm) continue;

    const byName = await pool.query(
      `SELECT id, name, access_card_no FROM employees
       WHERE admin_id = $1
         AND LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(name, '')), E'\\\\s+', ' ', 'g'))) = LOWER($2::text)
       LIMIT 1`,
      [adminId, nm]
    );
    if (byName.rows.length > 0) {
      const row = byName.rows[0];
      const prevName = normalizeEmployeeEventName(row.name);
      const hadCard = String(row.access_card_no || "").trim() !== "";
      if (prevName !== nm || hadCard) {
        await pool.query(`UPDATE employees SET name = $1, access_card_no = NULL WHERE id = $2`, [nm, row.id]);
        updated += 1;
      }
      continue;
    }

    await pool.query(
      `INSERT INTO employees (admin_id, name, role, filial, shift_start, shift_end)
       VALUES ($1, $2, $3, $4, '09:00', '18:00')`,
      [adminId, nm, "Hodim", defaultFilial]
    );
    created += 1;
  }

  return { ok: true, error: null, created, updated, total: users.length };
}

async function getCursor(pool, terminalId) {
  const { rows } = await pool.query(`SELECT last_event_time FROM terminal_poll_cursors WHERE terminal_id = $1`, [
    terminalId,
  ]);
  return rows[0]?.last_event_time != null ? String(rows[0].last_event_time) : "";
}

async function setCursor(pool, terminalId, timeStr) {
  await pool.query(
    `INSERT INTO terminal_poll_cursors (terminal_id, last_event_time)
     VALUES ($1, $2)
     ON CONFLICT (terminal_id) DO UPDATE SET last_event_time = EXCLUDED.last_event_time`,
    [terminalId, timeStr]
  );
}

async function tryInsertDedupe(pool, terminalId, dedupeKey) {
  const r = await pool.query(
    `INSERT INTO terminal_event_dedupe (terminal_id, dedupe_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [terminalId, dedupeKey]
  );
  return r.rowCount > 0;
}

async function getTerminalEventTimezoneOffsetHours(pool) {
  const { rows } = await pool.query(`SELECT value FROM app_kv WHERE key = 'terminal_event_timezone_offset_hours' LIMIT 1`);
  const n = Number(rows[0]?.value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(-12, Math.min(14, n));
}

/**
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function applyTerminalEvent(pool, terminalRow, ev, broadcast) {
  const nameNorm = normalizeEmployeeEventName(eventEmployeeName(ev));
  const timeIso = eventTimeIso(ev);
  if (!nameNorm || !timeIso) {
    const key = eventEmployeeKey(ev);
    const bits = [];
    if (!nameNorm) bits.push("ism_yoq");
    if (!timeIso) bits.push("vaqt_yoq");
    const hint = key ? `; terminal_raqami/karta=${key}` : "";
    return { ok: false, reason: `${bits.join("+")}${hint} (hodim XMLda name/EmployeeName bo‘lishi yoki bazadagi ism bilan mos kelishi kerak)` };
  }

  const dedupeKey = eventDedupeKey(terminalRow.id, ev);
  const fresh = await tryInsertDedupe(pool, terminalRow.id, dedupeKey);
  if (!fresh) return { ok: false, reason: "takroriy_hodisa (oldingi yuborilgan)" };

  const tzOffsetHours = await getTerminalEventTimezoneOffsetHours(pool);
  const dt = deviceEventDateTimeWithTargetOffset(timeIso, tzOffsetHours);
  if (!dt) return { ok: false, reason: `vaqt_tahlil_xato (time="${timeIso.slice(0, 80)}")` };

  const empR = await pool.query(
    `SELECT id, admin_id, shift_start, shift_end, weekly_schedule
     FROM employees e
     WHERE ${employeeMatchByNormalizedNameSql}
     LIMIT 1`,
    [terminalRow.admin_id, nameNorm]
  );
  if (empR.rows.length === 0) {
    return {
      ok: false,
      reason: `hodim_topilmadi (ism="${nameNorm}" — bazada aynan shu ism; faqat ism bo‘yicha, karta ID emas)`,
    };
  }

  const emp = empR.rows[0];
  const adminId = emp.admin_id != null ? Number(emp.admin_id) : null;
  const eid = Number(emp.id);

  const chiqishQurilma = isCheckoutTerminalType(terminalRow.terminal_type);
  // Chiqish deb belgilangan terminal: minor va boshqa maydonlardan qat'iy nazar chiqish.
  // Kirish terminalda HTTP / noto'g'ri tanlash uchun hodisadan chiqish izi bo'lsa ham checkout.
  const checkout = chiqishQurilma || (!chiqishQurilma && isExitLikeAccessEvent(ev));
  const snap = await resolveSnapshotForTerminalEvent(terminalRow, ev);

  if (checkout) {
    const openR = await pool.query(
      `SELECT id FROM employee_attendance
       WHERE employee_id = $1 AND record_date = $2::date
         AND (check_out IS NULL OR BTRIM(check_out::text) = '')
       ORDER BY id DESC LIMIT 1`,
      [eid, dt.date]
    );
    if (openR.rows.length === 0) {
      return {
        ok: false,
        reason: `chiqish_mumkin_emas: ${dt.date} sanasida ochiq kirish (check-in) topilmadi — avval kirish yozilishi kerak`,
      };
    }
    const { rows } = await pool.query(
      `UPDATE employee_attendance SET check_out = $1,
         check_out_snapshot = CASE
           WHEN $3::text IS NOT NULL AND BTRIM($3::text) <> '' THEN $3
           ELSE check_out_snapshot
         END
       WHERE id = $2
       RETURNING id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot`,
      [dt.time, openR.rows[0].id, snap || null]
    );
    if (rows[0] && broadcast && adminId != null) {
      broadcast({ adminId, records: [rowToAttendanceRow(rows[0])] });
    }
    return { ok: true };
  }

  const openR = await pool.query(
    `SELECT id FROM employee_attendance
     WHERE employee_id = $1 AND record_date = $2::date
       AND (check_out IS NULL OR BTRIM(check_out::text) = '')
     LIMIT 1`,
    [eid, dt.date]
  );
  if (openR.rows.length > 0) {
    return {
      ok: false,
      reason: `kirish_mumkin_emas: ${dt.date} uchun allaqachon ochiq smena bor (check-out qilinmasdan ikkinchi kirish)`,
    };
  }

  const grace = await fetchLateGraceForEmployee(pool, eid);
  const lateFlag = computeCheckInLateFlag(emp, dt.date, dt.time, grace);

  const { rows } = await pool.query(
    `INSERT INTO employee_attendance (admin_id, employee_id, record_date, check_in, check_out, late, check_in_snapshot)
     VALUES ($1, $2, $3::date, $4, NULL, $5, $6)
     RETURNING id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot`,
    [adminId, eid, dt.date, dt.time, lateFlag, snap || null]
  );
  if (rows[0] && broadcast && adminId != null) {
    broadcast({ adminId, records: [rowToAttendanceRow(rows[0])] });
  }
  return { ok: true };
}

function defaultPollStartTime() {
  const d = new Date(Date.now() - 36 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+05:00`;
}

/**
 * Barcha terminallardan hodisalarni bir marta o‘qiydi (server ichki sikl).
 */
export async function pollAllTerminalsOnce(pool, broadcast) {
  const { rows: terminals } = await pool.query(
    `SELECT id, admin_id, terminal_type, ip_address, login, password FROM terminals ORDER BY id ASC`
  );
  for (const t of terminals) {
    try {
      await pollOneTerminal(pool, t, broadcast);
    } catch (e) {
      console.error(`[terminal poll] id=${t.id}`, e);
    }
  }
}

async function pollOneTerminal(pool, terminalRow, broadcast) {
  const norm = normalizeTerminalBaseUrl(terminalRow.ip_address);
  if (norm.error) return;

  let cursor = await getCursor(pool, terminalRow.id);
  if (!cursor) cursor = defaultPollStartTime();

  const endTime = "2035-12-31T23:59:59+05:00";
  const { ok, events, error } = await fetchHikvisionEvents(
    norm.baseUrl,
    terminalRow.login,
    terminalRow.password,
    cursor,
    endTime,
    DEFAULT_TIMEOUT_MS
  );
  if (!ok) {
    if (error) console.warn(`[terminal poll] id=${terminalRow.id} fetch: ${error}`);
    return;
  }

  const list = Array.isArray(events) ? [...events] : [];
  list.sort((a, b) => String(eventTimeIso(a) || "").localeCompare(String(eventTimeIso(b) || "")));

  let maxTime = cursor;
  for (const ev of list) {
    const ti = eventTimeIso(ev);
    if (ti && ti > maxTime) maxTime = ti;
    await applyTerminalEvent(pool, terminalRow, ev, broadcast).catch((e) => {
      console.error(`[terminal poll] id=${terminalRow.id} applyTerminalEvent`, e);
      return { ok: false };
    });
  }

  if (maxTime && maxTime !== cursor) {
    await setCursor(pool, terminalRow.id, maxTime);
  }
}

export function startTerminalEventPoller(pool, broadcast) {
  const ms = Math.max(3000, Number(process.env.TERMINAL_POLL_MS || 5000));
  const tick = () => pollAllTerminalsOnce(pool, broadcast).catch((e) => console.error("[terminal poll]", e));
  const id = setInterval(tick, ms);
  tick();
  return () => clearInterval(id);
}
