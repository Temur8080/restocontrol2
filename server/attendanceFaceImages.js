import {
  cleanTerminalImagePath,
  downloadTerminalImageDigest,
  saveFaceImageFile,
} from "./hikvisionImageDownload.js";
import { normalizeTerminalBaseUrl } from "./terminalHikvision.js";
import { snapshotFromHikvisionEvent, terminalImagePathFromEvent } from "./eventSnapshot.js";

function urlTerminalHostKey(urlStr) {
  try {
    return new URL(String(urlStr).trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

function terminalRowHostKey(row) {
  const base = normalizeTerminalBaseUrl(row.ip_address);
  if (base.error) return "";
  try {
    return new URL(base.baseUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Real vaqt hodisasi: avvalo terminal yo'li bo'yicha yuklab olish, bo'lmasa inline base64.
 * Yuklab bo'lmasa — bazaga qayta urinish uchun to'liq http(s) URL yoziladi.
 */
export async function resolveSnapshotForTerminalEvent(terminalRow, ev) {
  const path = terminalImagePathFromEvent(ev);
  const norm = normalizeTerminalBaseUrl(terminalRow.ip_address);
  if (path && !norm.error) {
    const dl = await downloadTerminalImageDigest(
      norm.baseUrl,
      terminalRow.login,
      terminalRow.password,
      path
    );
    if (dl.ok && dl.buffer) {
      const saved = saveFaceImageFile(terminalRow.id, ev, dl.buffer, dl.ext);
      if (saved) return saved.publicPath;
    }
    return `${norm.baseUrl.replace(/\/$/, "")}${cleanTerminalImagePath(path)}`;
  }
  return snapshotFromHikvisionEvent(ev) || "";
}

function pathFromTerminalSnapshotUrl(urlStr) {
  try {
    const u = new URL(String(urlStr).trim());
    return cleanTerminalImagePath(u.pathname);
  } catch {
    return "";
  }
}

/**
 * Bazada hali terminal URL turgan check_in/out snapshotlarni yuklab, /uploads/faces/ ga o'tkazadi.
 */
export async function batchDownloadPendingAttendanceSnapshots(pool, { role, adminSub }) {
  const { rows: terminals } = await pool.query(
    `SELECT id, admin_id, ip_address, login, password FROM terminals ORDER BY id ASC`
  );

  const isScopedAdmin = role === "admin" && adminSub != null;
  const attQuery = isScopedAdmin
    ? `SELECT a.id, a.check_in_snapshot, a.check_out_snapshot
       FROM employee_attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE e.admin_id = $1
         AND (
           a.check_in_snapshot LIKE 'http://%' OR a.check_in_snapshot LIKE 'https://%' OR
           a.check_out_snapshot LIKE 'http://%' OR a.check_out_snapshot LIKE 'https://%'
         )`
    : `SELECT id, check_in_snapshot, check_out_snapshot
       FROM employee_attendance
       WHERE check_in_snapshot LIKE 'http://%' OR check_in_snapshot LIKE 'https://%'
          OR check_out_snapshot LIKE 'http://%' OR check_out_snapshot LIKE 'https://%'`;

  const attR = isScopedAdmin ? await pool.query(attQuery, [adminSub]) : await pool.query(attQuery);

  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  function findTerminal(snapshotUrl) {
    const h = urlTerminalHostKey(snapshotUrl);
    if (!h) return null;
    for (const t of terminals) {
      if (terminalRowHostKey(t) !== h) continue;
      if (isScopedAdmin && Number(t.admin_id) !== Number(adminSub)) continue;
      return t;
    }
    return null;
  }

  async function processOne(rowId, col, url) {
    const safeCol = col === "check_out_snapshot" ? "check_out_snapshot" : "check_in_snapshot";
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) return;
    const term = findTerminal(u);
    if (!term) {
      skipped += 1;
      return;
    }
    const imgPath = pathFromTerminalSnapshotUrl(u);
    if (!imgPath) {
      skipped += 1;
      return;
    }
    const base = normalizeTerminalBaseUrl(term.ip_address);
    if (base.error) {
      skipped += 1;
      return;
    }
    const dl = await downloadTerminalImageDigest(
      base.baseUrl,
      term.login,
      term.password,
      imgPath
    );
    if (!dl.ok || !dl.buffer) {
      failed += 1;
      return;
    }
    const saved = saveFaceImageFile(term.id, { serialNo: "batch" }, dl.buffer, dl.ext);
    if (!saved) {
      failed += 1;
      return;
    }
    await pool.query(`UPDATE employee_attendance SET ${safeCol} = $1 WHERE id = $2`, [saved.publicPath, rowId]);
    downloaded += 1;
  }

  for (const row of attR.rows) {
    const id = Number(row.id);
    const cin = row.check_in_snapshot;
    const cout = row.check_out_snapshot;
    if (cin && /^https?:\/\//i.test(String(cin))) await processOne(id, "check_in_snapshot", cin);
    if (cout && /^https?:\/\//i.test(String(cout))) await processOne(id, "check_out_snapshot", cout);
  }

  return { downloaded, failed, skipped, scanned: attR.rows.length };
}
