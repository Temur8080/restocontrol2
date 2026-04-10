import {
  normalizeTerminalBaseUrl,
  fetchHikvisionUsers,
  fetchHikvisionEvents,
  eventTimeIso,
  eventDedupeKey,
  eventEmployeeKey,
  eventEmployeeName,
  normalizeEmployeeEventName,
  deviceEventDateTimeWithTargetOffset,
  DEFAULT_TIMEOUT_MS,
} from "./terminalHikvision.js";
import { computeCheckInLateFlag, fetchLateGraceForEmployee } from "./shiftUtils.js";
import { resolveSnapshotForTerminalEvent } from "./attendanceFaceImages.js";
import {
  employeeMatchByNormalizedNameAndFilialSql,
  employeeMatchByAccessCardAndFilialSql,
} from "./employeeAccessCards.js";
import { isCheckoutTerminalType, isExitLikeAccessEvent } from "./hikvisionAccessDirection.js";
import { isPrivateLanHostname } from "./terminalProbe.js";

/**
 * Terminal avtomatik qo‘ygan "Hodim {id}" yoki bo‘sh ism — keyingi hodisalar/sinxron boshqa
 * terminaldagi boshqacha yozuvdan ustidan yozishi mumkin. Haqiqiy F.I.Sh allaqachon
 * kiritilgan bo‘lsa, turli qurilmalarda bir xil ID uchun farq qiluvchi ismlarni almashtirmaymiz.
 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isPlaceholderOrAutoHodimName(normalizedDbName, terminalKey) {
  const n = normalizeEmployeeEventName(normalizedDbName);
  const key = String(terminalKey || "").trim();
  const compact = n.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  if (key) {
    return new RegExp(`^Hodim\\s+${escapeRegExp(key)}$`, "i").test(compact);
  }
  return /^Hodim\s+\S+$/i.test(compact);
}

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
  const cinF = row.check_in_filial != null ? String(row.check_in_filial).trim() : "";
  const coutF = row.check_out_filial != null ? String(row.check_out_filial).trim() : "";
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    date: d,
    checkIn: row.check_in,
    checkOut: row.check_out == null ? "" : String(row.check_out),
    late: !!row.late,
    checkInSnapshot: cinS || null,
    checkOutSnapshot: coutS || null,
    checkInFilial: cinF || null,
    checkOutFilial: coutF || null,
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

/** Terminalga biriktirilgan filial (admin_filial_map bo‘yicha) yoki admin uchun birlamchi. */
export async function resolveEmployeeFilialForTerminal(pool, terminalRow) {
  const adminId = Number(terminalRow?.admin_id);
  if (!Number.isFinite(adminId)) return "Asosiy filial";
  const tf = terminalRow.filial != null ? String(terminalRow.filial).trim() : "";
  if (tf) {
    const { rows } = await pool.query(
      `SELECT filial FROM admin_filial_map WHERE admin_id = $1 AND filial = $2 LIMIT 1`,
      [adminId, tf]
    );
    if (rows.length > 0) return String(rows[0].filial).trim();
  }
  return getDefaultFilialForAdmin(pool, adminId);
}

/**
 * Terminaldan hodimlar (Hikvision UserInfo): ism va employeeNo/karta `access_card_no` ga yoziladi.
 */
export async function syncEmployeesFromTerminal(pool, terminalRow) {
  const norm = normalizeTerminalBaseUrl(terminalRow.ip_address);
  if (norm.error) {
    return {
      ok: false,
      error: norm.error,
      created: 0,
      updated: 0,
      total: 0,
      scanned: 0,
      pages: 0,
      enriched: 0,
    };
  }

  const { users, ok, error, meta } = await fetchHikvisionUsers(
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
    return {
      ok: false,
      error: errMsg,
      created: 0,
      updated: 0,
      total: 0,
      scanned: 0,
      pages: 0,
      enriched: 0,
    };
  }

  const adminId = Number(terminalRow.admin_id);
  if (!Number.isFinite(adminId)) {
    return {
      ok: false,
      error: "Admin id yo'q",
      created: 0,
      updated: 0,
      total: 0,
      scanned: 0,
      pages: 0,
      enriched: 0,
    };
  }

  const defaultFilial = await resolveEmployeeFilialForTerminal(pool, terminalRow);
  let created = 0;
  let updated = 0;

  for (const u of users) {
    const nm = normalizeEmployeeEventName(u.name || "");
    if (!nm) continue;

    const terminalKey =
      u.employeeNo != null && String(u.employeeNo).trim() !== "" ? String(u.employeeNo).trim() : "";
    if (terminalKey) {
      const byCard = await pool.query(
        `SELECT id, name, access_card_no FROM employees e
         WHERE ${employeeMatchByAccessCardAndFilialSql}
         ORDER BY e.id ASC
         LIMIT 1`,
        [adminId, terminalKey, defaultFilial]
      );
      if (byCard.rows.length > 0) {
        const row = byCard.rows[0];
        const byCardName = normalizeEmployeeEventName(row.name);
        const hasRealNameConflict =
          nm && byCardName && byCardName !== nm && !isPlaceholderOrAutoHodimName(byCardName, terminalKey);
        if (hasRealNameConflict) {
          // ID boshqa terminalda qayta ishlatilgan bo'lishi mumkin; by-name/alias oqimiga o'tamiz.
        } else {
        const prevName = normalizeEmployeeEventName(row.name);
        const prevCard = String(row.access_card_no || "").trim();
        const allowNameFromTerminal = isPlaceholderOrAutoHodimName(prevName, terminalKey);
        const nameToStore = allowNameFromTerminal ? nm : prevName;
        const nameChanged = allowNameFromTerminal && nameToStore !== prevName;
        const cardChanged = prevCard !== terminalKey;
        if (nameChanged || cardChanged) {
          await pool.query(`UPDATE employees SET name = $1, access_card_no = $2 WHERE id = $3`, [
            nameToStore || nm,
            terminalKey,
            row.id,
          ]);
          updated += 1;
        }
        await upsertEmployeeTerminalAlias(pool, Number(row.id), Number(terminalRow.id), terminalKey);
        continue;
        }
      }
    }

    const byName = await pool.query(
      `SELECT id, name, access_card_no FROM employees
       WHERE admin_id = $1
         AND (
           COALESCE(NULLIF(TRIM(filial), ''), 'Asosiy filial') = COALESCE(NULLIF(TRIM($3::text), ''), 'Asosiy filial')
           OR COALESCE(NULLIF(TRIM(filial), ''), 'Asosiy filial') = '*'
         )
         AND LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(name, '')), E'\\\\s+', ' ', 'g'))) = LOWER($2::text)
       ORDER BY id ASC
       LIMIT 1`,
      [adminId, nm, defaultFilial]
    );
    if (byName.rows.length > 0) {
      const row = byName.rows[0];
      const prevName = normalizeEmployeeEventName(row.name);
      const prevCard = String(row.access_card_no || "").trim();
      const allowName = isPlaceholderOrAutoHodimName(prevName, terminalKey);
      const newName = allowName ? nm : String(row.name ?? "").trim() || prevName;
      const nameChanged = allowName && normalizeEmployeeEventName(nm) !== prevName;
      let newCard = prevCard;
      if (terminalKey && !prevCard) newCard = terminalKey;
      const cardChanged = newCard !== prevCard;
      if (nameChanged || cardChanged) {
        await pool.query(`UPDATE employees SET name = $1, access_card_no = $2 WHERE id = $3`, [
          newName,
          newCard || null,
          row.id,
        ]);
        updated += 1;
      }
      if (terminalKey && prevCard && prevCard !== terminalKey) {
        // Bir admin+filialda bir xil ism uchun turli terminal ID'lar bo'lsa:
        // employees.access_card_no ni yagona canonical kalitga o'tkazamiz.
        await promoteEmployeeToCanonicalKey(pool, Number(row.id));
      }
      if (terminalKey) {
        await upsertEmployeeTerminalAlias(pool, Number(row.id), Number(terminalRow.id), terminalKey);
      }
      continue;
    }

    if (terminalKey) {
      const ins = await pool.query(
        `INSERT INTO employees (admin_id, name, role, filial, shift_start, shift_end, access_card_no)
         VALUES ($1, $2, $3, $4, '09:00', '18:00', $5)
         RETURNING id`,
        [adminId, nm, "Hodim", defaultFilial, terminalKey]
      );
      const createdId = Number(ins.rows?.[0]?.id || 0);
      if (createdId > 0) {
        await upsertEmployeeTerminalAlias(pool, createdId, Number(terminalRow.id), terminalKey);
      }
    } else {
      await pool.query(
        `INSERT INTO employees (admin_id, name, role, filial, shift_start, shift_end)
         VALUES ($1, $2, $3, $4, '09:00', '18:00')`,
        [adminId, nm, "Hodim", defaultFilial]
      );
    }
    created += 1;
  }

  return {
    ok: true,
    error: null,
    created,
    updated,
    total: users.length,
    scanned: meta?.listedRaw ?? users.length,
    pages: meta?.pages ?? 1,
    enriched: meta?.enriched ?? 0,
  };
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

async function dedupeKeyExists(pool, terminalId, dedupeKey) {
  const r = await pool.query(
    `SELECT 1 FROM terminal_event_dedupe WHERE terminal_id = $1 AND dedupe_key = $2 LIMIT 1`,
    [terminalId, dedupeKey]
  );
  return r.rows.length > 0;
}

/** Faqat davomat yozuvi muvaffaqiyatli bo‘lgandan keyin chaqiriladi — qayta urinish uchun yo‘l qoldiradi. */
async function recordDedupeSuccess(pool, terminalId, dedupeKey) {
  try {
    await pool.query(
      `INSERT INTO terminal_event_dedupe (terminal_id, dedupe_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [terminalId, dedupeKey]
    );
  } catch (e) {
    console.error(`[terminal] recordDedupeSuccess terminal_id=${terminalId}`, e);
  }
}

async function findEmployeeByTerminalAlias(pool, adminId, terminalId, terminalKey) {
  if (!terminalId || !terminalKey) return null;
  const r = await pool.query(
    `SELECT e.id, e.admin_id, e.name, e.access_card_no, e.shift_start, e.shift_end, e.weekly_schedule
     FROM employee_terminal_keys k
     JOIN employees e ON e.id = k.employee_id
     WHERE k.terminal_id = $1
       AND LOWER(TRIM(k.terminal_key)) = LOWER(TRIM($2::text))
       AND e.admin_id = $3
     ORDER BY e.id ASC
     LIMIT 1`,
    [terminalId, terminalKey, adminId]
  );
  return r.rows[0] || null;
}

async function upsertEmployeeTerminalAlias(pool, employeeId, terminalId, terminalKey) {
  if (!employeeId || !terminalId || !terminalKey) return;
  await pool.query(
    `INSERT INTO employee_terminal_keys (employee_id, terminal_id, terminal_key, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (terminal_id, terminal_key)
     DO UPDATE SET employee_id = EXCLUDED.employee_id, updated_at = NOW()`,
    [employeeId, terminalId, String(terminalKey).trim()]
  );
}

function buildCanonicalEmployeeKey(employeeId) {
  return `ID_A${String(employeeId)}`;
}

async function promoteEmployeeToCanonicalKey(pool, employeeId) {
  if (!employeeId) return;
  const canonical = buildCanonicalEmployeeKey(employeeId);
  await pool.query(`UPDATE employees SET access_card_no = $2 WHERE id = $1`, [employeeId, canonical]);
}

async function getTerminalEventTimezoneOffsetHours(pool) {
  const { rows } = await pool.query(`SELECT value FROM app_kv WHERE key = 'terminal_event_timezone_offset_hours' LIMIT 1`);
  const n = Number(rows[0]?.value);
  if (!Number.isFinite(n)) return 5;
  return Math.max(-12, Math.min(14, n));
}

/**
 * Hodim-nazorati kabi: birinchi kirish/chiqishda hodisadan kelgan ism (va karta raqami) Hodimlar ro‘yxatiga
 * yoziladi yoki yangilanadi, keyin davomat shu yozuvga bog‘lanadi.
 * Qidiruv: avvalo access_card_no, keyin ism. Mavjud hodim nomi turli terminaldagi boshqacha
 * variantdan faqat avto-yaratilgan "Hodim {id}" / bo‘sh bo‘lsa yangilanadi — aks holda qo‘lda saqlanadi.
 * @returns {Promise<{ ok: boolean, duplicate?: boolean, reason?: string }>}
 */
export async function applyTerminalEvent(pool, terminalRow, ev, broadcast) {
  const isCheckoutSource = isCheckoutTerminalType(terminalRow?.terminal_type);
  const rawNameFromEvent = normalizeEmployeeEventName(eventEmployeeName(ev));
  // Kirish/chiqish terminallari bir xil ishlaydi: ism bo'lsa create/update va match uchun ishlatiladi.
  const nameForCreateUpdate = rawNameFromEvent;
  const empKey = eventEmployeeKey(ev);
  const timeIso = eventTimeIso(ev);

  if (!timeIso) {
    return { ok: false, reason: "vaqt_yoq (hodisada time/dateTime kerak)" };
  }
  if (!empKey && !rawNameFromEvent) {
    return {
      ok: false,
      reason:
        "hodim_aniqlanmadi (hodisada ism yoki employeeNoString/employeeNo/cardNo kerak — birinchi hodisa bilan Hodimlar ro‘yxatiga tushadi)",
    };
  }

  const dedupeKey = eventDedupeKey(terminalRow.id, ev);
  if (await dedupeKeyExists(pool, terminalRow.id, dedupeKey)) {
    return { ok: false, duplicate: true, reason: "takroriy_hodisa (oldingi yuborilgan)" };
  }

  const tzOffsetHours = await getTerminalEventTimezoneOffsetHours(pool);
  const dt = deviceEventDateTimeWithTargetOffset(timeIso, tzOffsetHours);
  if (!dt) return { ok: false, reason: `vaqt_tahlil_xato (time="${timeIso.slice(0, 80)}")` };

  const adminId = Number(terminalRow.admin_id);
  if (!Number.isFinite(adminId)) {
    return { ok: false, reason: "terminal_admin_yoq" };
  }

  const eventFilial = await resolveEmployeeFilialForTerminal(pool, terminalRow);

  let empR = { rows: [] };

  // Avval karta/terminal ID bo'yicha (aniqroq), keyin ism bo'yicha — bir xil ismli bir nechta
  // hodim yoki LIMIT 1 tasodifiy qator tanlashining oldini oladi. Turli terminallarda bir
  // odamning cardNo farq qilsa, ism mos kelganda baribir bir yozuvga bog'lanadi.
  if (empKey) {
    empR = await pool.query(
      `SELECT id, admin_id, name, access_card_no, shift_start, shift_end, weekly_schedule
       FROM employees e
       WHERE ${employeeMatchByAccessCardAndFilialSql}
       ORDER BY e.id ASC
       LIMIT 1`,
      [adminId, empKey, eventFilial]
    );
    if (empR.rows.length > 0 && rawNameFromEvent) {
      const byCardName = normalizeEmployeeEventName(empR.rows[0].name);
      // Turli terminallarda ID qayta ishlatilsa (masalan T1:5=Temur, T2:5=Zuhra),
      // noto'g'ri employeega yopishib ketmasligi uchun by-card nomini tekshiramiz.
      if (
        byCardName &&
        byCardName !== rawNameFromEvent &&
        !isPlaceholderOrAutoHodimName(byCardName, empKey)
      ) {
        empR = { rows: [] };
      }
    }
    if (empR.rows.length === 0) {
      const byAlias = await findEmployeeByTerminalAlias(pool, adminId, Number(terminalRow.id), empKey);
      if (byAlias) empR = { rows: [byAlias] };
    }
  }

  if (empR.rows.length === 0 && rawNameFromEvent) {
    empR = await pool.query(
      `SELECT id, admin_id, name, access_card_no, shift_start, shift_end, weekly_schedule
       FROM employees e
       WHERE ${employeeMatchByNormalizedNameAndFilialSql}
       ORDER BY e.id ASC
       LIMIT 1`,
      [adminId, rawNameFromEvent, eventFilial]
    );
  }

  if (empR.rows.length === 0) {
    const defaultFilial = eventFilial;
    const keyTrim = empKey ? String(empKey).trim() : "";
    const newName = keyTrim
      ? nameForCreateUpdate || `Hodim ${keyTrim}`
      : rawNameFromEvent;
    if (!newName) {
      return { ok: false, reason: "hodim_aniqlanmadi (ism yoki ID kerak)" };
    }
    const cardVal = keyTrim || null;
    empR = await pool.query(
      `INSERT INTO employees (admin_id, name, role, filial, shift_start, shift_end, access_card_no)
       VALUES ($1, $2, 'Hodim', $3, '09:00', '18:00', $4)
       RETURNING id, admin_id, name, access_card_no, shift_start, shift_end, weekly_schedule`,
      [adminId, newName, defaultFilial, cardVal]
    );
  } else {
    const row = empR.rows[0];
    const prevName = normalizeEmployeeEventName(row.name);
    const prevCard = String(row.access_card_no || "").trim();
    if (nameForCreateUpdate) {
      const next = normalizeEmployeeEventName(nameForCreateUpdate);
      if (next !== prevName && isPlaceholderOrAutoHodimName(prevName, empKey)) {
        await pool.query(`UPDATE employees SET name = $1 WHERE id = $2`, [nameForCreateUpdate, row.id]);
      }
    }
    if (empKey) {
      await pool.query(
        `UPDATE employees SET access_card_no = $2
         WHERE id = $1
           AND (access_card_no IS NULL OR BTRIM(COALESCE(access_card_no::text, '')) = '')`,
        [row.id, String(empKey).trim()]
      );
    }
    if (empKey && prevCard && prevCard !== String(empKey).trim()) {
      await promoteEmployeeToCanonicalKey(pool, Number(row.id));
    }
  }

  const emp = empR.rows[0];
  const eid = Number(emp.id);
  if (empKey) {
    await upsertEmployeeTerminalAlias(pool, eid, Number(terminalRow.id), empKey);
  }

  const chiqishQurilma = isCheckoutSource;
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
         END,
         check_out_filial = $4
       WHERE id = $2
       RETURNING id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot,
         check_in_filial, check_out_filial`,
      [dt.time, openR.rows[0].id, snap || null, eventFilial]
    );
    if (rows[0] && broadcast && adminId != null) {
      broadcast({ adminId, records: [rowToAttendanceRow(rows[0])] });
    }
    await recordDedupeSuccess(pool, terminalRow.id, dedupeKey);
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
    `INSERT INTO employee_attendance (admin_id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_in_filial)
     VALUES ($1, $2, $3::date, $4, NULL, $5, $6, $7)
     RETURNING id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot,
       check_in_filial, check_out_filial`,
    [adminId, eid, dt.date, dt.time, lateFlag, snap || null, eventFilial]
  );
  if (rows[0] && broadcast && adminId != null) {
    broadcast({ adminId, records: [rowToAttendanceRow(rows[0])] });
  }
  await recordDedupeSuccess(pool, terminalRow.id, dedupeKey);
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
    `SELECT id, admin_id, terminal_type, ip_address, login, password, filial FROM terminals ORDER BY id ASC`
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

  let maxAppliedTime = cursor;
  for (const ev of list) {
    const ti = eventTimeIso(ev);
    let result;
    try {
      result = await applyTerminalEvent(pool, terminalRow, ev, broadcast);
    } catch (e) {
      console.error(`[terminal poll] id=${terminalRow.id} applyTerminalEvent`, e);
      result = { ok: false, reason: String(e?.message || e) };
    }
    // Muvaffaqiyat yoki avvalgi sessiyada allaqachon qayta ishlangan (duplicate) — kursor ilgarilaydi.
    // Boshqa xato (masalan chiqish_mumkin_emas) — shu hodisadan keyingi vaqtlarni o‘tkazib yubormaslik uchun to‘xtaymiz.
    if (result.ok || result.duplicate) {
      if (ti && ti > maxAppliedTime) maxAppliedTime = ti;
    } else {
      break;
    }
  }

  if (maxAppliedTime && maxAppliedTime !== cursor) {
    await setCursor(pool, terminalRow.id, maxAppliedTime);
  }
}

export function startTerminalEventPoller(pool, broadcast) {
  const ms = Math.max(3000, Number(process.env.TERMINAL_POLL_MS || 5000));
  const tick = () => pollAllTerminalsOnce(pool, broadcast).catch((e) => console.error("[terminal poll]", e));
  const id = setInterval(tick, ms);
  tick();
  return () => clearInterval(id);
}
