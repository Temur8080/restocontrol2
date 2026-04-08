import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { pool, initSchema } from "./db.js";
import { authMiddleware, signToken, assertJwtConfigured } from "./auth.js";
import { ensureDefaultAdmin } from "./seed-admin.js";
import { probeHikvisionTerminal } from "./terminalProbe.js";
import { syncEmployeesFromTerminal, startTerminalEventPoller } from "./terminalIntegration.js";
import { createAttendanceBroadcaster } from "./realtime.js";
import { setAttendanceBroadcastHub } from "./attendanceBroadcastHub.js";
import { handleHikvisionHttpEvent } from "./hikvisionHttpIngest.js";
import {
  webhookIpAllowlistMiddleware,
  webhookRateLimitMiddleware,
} from "./webhookGuards.js";
import { computeCheckInLateFlag, fetchLateGraceForEmployee } from "./shiftUtils.js";
import { batchDownloadPendingAttendanceSnapshots } from "./attendanceFaceImages.js";
import {
  assertSafeSqlIdentifier,
  buildDynamicReadOnlyTableConfig,
  listPublicBaseTables,
  quoteIdent,
} from "./dbExplorer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8000;
const app = express();
const DAY_MS = 24 * 60 * 60 * 1000;

const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors(
    corsOrigins.length > 0
      ? { origin: corsOrigins, credentials: true }
      : { origin: true, credentials: true }
  )
);

if (String(process.env.TRUST_PROXY || "").trim() === "1") {
  app.set("trust proxy", 1);
}

/**
 * Hikvision «HTTP monitoring»: POST /api/hikvision/event (JWT emas).
 * Tanani express.raw bilan o‘qiyapmiz (multipart + noto‘g‘ri Content-Type uchun); bodyParser/multer ishlatilmaydi.
 * WEBHOOK_ALLOWED_IPS / WEBHOOK_MAX_PER_MINUTE — ixtiyoriy (.env.example).
 */
app.post(
  "/api/hikvision/event",
  webhookIpAllowlistMiddleware,
  webhookRateLimitMiddleware,
  express.raw({
    type: () => true,
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
  async (req, res) => {
    try {
      const { status, body } = await handleHikvisionHttpEvent(req, pool);
      res.status(status).type("text/plain").send(body);
    } catch (e) {
      console.error("[hikvision http]", e);
      res.status(200).type("text/plain").send("OK");
    }
  }
);

app.use(express.json({ limit: "2mb" }));

app.use(
  "/uploads",
  express.static(path.join(__dirname, "public", "uploads"), {
    maxAge: "7d",
    fallthrough: true,
  })
);

function rowToEmployee(row) {
  if (!row) return null;
  let weeklySchedule = row.weekly_schedule;
  if (weeklySchedule && typeof weeklySchedule === "string") {
    try {
      weeklySchedule = JSON.parse(weeklySchedule);
    } catch {}
  }
  const emp = {
    id: Number(row.id),
    adminId: row.admin_id == null ? null : Number(row.admin_id),
    name: row.name,
    role: row.role != null ? String(row.role).trim() : row.role,
    filial: row.filial != null && row.filial !== "" ? String(row.filial) : "Asosiy filial",
    shiftStart: row.shift_start,
    shiftEnd: row.shift_end,
    accessCardNo: "",
  };
  if (weeklySchedule && typeof weeklySchedule === "object") {
    emp.weeklySchedule = weeklySchedule;
  }
  return emp;
}

function rowToAttendance(row) {
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

function rowToSalaryPayment(row) {
  if (!row) return null;
  let d = row.pay_date;
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    d = `${y}-${m}-${day}`;
  } else if (typeof d === "string" && d.length > 10) d = d.slice(0, 10);
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    date: d,
    amount: Number.isFinite(Number(row.amount)) ? Math.trunc(Number(row.amount)) : 0,
    batchId: row.batch_id ?? "",
    createdBy: row.created_by == null ? null : Number(row.created_by),
    paidAt: row.paid_at ?? null,
    note: row.note ?? "",
  };
}

function rowToSalaryAdjustment(row) {
  if (!row) return null;
  let d = row.adj_date;
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    d = `${y}-${m}-${day}`;
  } else if (typeof d === "string" && d.length > 10) d = d.slice(0, 10);
  const rawKind = String(row.kind || "").toLowerCase().trim();
  const kind = rawKind === "fine" || rawKind === "advance" || rawKind === "kpi" ? rawKind : "bonus";
  return {
    id: Number(row.id),
    employeeId: Number(row.employee_id),
    date: d,
    kind,
    amount: Number.isFinite(Number(row.amount)) ? Math.max(0, Math.trunc(Number(row.amount))) : 0,
    source: row.source === "auto" ? "auto" : "manual",
    createdBy: row.created_by == null ? null : Number(row.created_by),
    note: row.note ?? "",
    updatedAt: row.updated_at ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const api = express.Router();

api.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "Login va parol kiriting" });
    }
    const u = String(username).trim();
    const { rows } = await pool.query(
      `SELECT id, username, password_hash, role, employee_id FROM users WHERE username = $1`,
      [u]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Noto'g'ri login yoki parol" });
    }
    const user = rows[0];
    const ok = await bcrypt.compare(String(password).trim(), user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Noto'g'ri login yoki parol" });
    }
    const token = signToken({
      sub: Number(user.id),
      u: user.username,
      role: user.role,
      employeeId: user.employee_id ?? null,
    });
    res.json({ token, username: user.username, role: user.role, employeeId: user.employee_id ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/auth/login", (_req, res) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({
      error:
        "Faqat POST. Brauzerda manzilga /api/auth/login yozib ochmang. API server: npm run server (8000-port).",
    });
});

api.use(authMiddleware);

function requireSuperadmin(req, res) {
  if (req.auth?.role !== "superadmin") {
    res.status(403).json({ error: "Faqat superadmin" });
    return false;
  }
  return true;
}

async function requireActiveAdminOrSuperadmin(req, res) {
  const role = req.auth?.role;
  if (role === "superadmin") return true;
  if (role !== "admin") {
    res.status(403).json({ error: "Ruxsat yo'q" });
    return false;
  }
  const userId = req.auth?.sub;
  if (!userId) {
    res.status(403).json({ error: "Sessiya xatosi" });
    return false;
  }
  const { rows } = await pool.query(`SELECT subscription_end FROM users WHERE id = $1`, [userId]);
  const end = rows[0]?.subscription_end;
  if (!end) {
    res.status(403).json({ error: "Admin obunasi yo'q" });
    return false;
  }
  const t = new Date(end).getTime();
  if (!Number.isFinite(t) || t <= Date.now()) {
    res.status(403).json({ error: "Admin obuna muddati tugagan" });
    return false;
  }
  return true;
}

async function runSyncEmployeesAcrossTerminals(terminalRows) {
  let created = 0;
  let updated = 0;
  let totalUsers = 0;
  let scannedTotal = 0;
  let pagesTotal = 0;
  let enrichedTotal = 0;
  const details = [];
  for (const t of terminalRows) {
    const r = await syncEmployeesFromTerminal(pool, t);
    details.push({
      terminalId: t.id,
      terminalName: t.terminal_name ?? null,
      ...r,
    });
    if (r.ok) {
      created += r.created;
      updated += r.updated;
      totalUsers += r.total;
      scannedTotal += Number(r.scanned) || 0;
      pagesTotal += Number(r.pages) || 0;
      enrichedTotal += Number(r.enriched) || 0;
    }
  }
  return {
    ok: true,
    terminalCount: terminalRows.length,
    created,
    updated,
    totalDeviceUsers: totalUsers,
    scannedTotal,
    pagesTotal,
    enrichedTotal,
    details,
  };
}

const DB_TABLE_CONFIG = {
  employees: {
    pk: { name: "id", type: "int" },
    columns: {
      id: { type: "int", editable: false, visible: true },
      admin_id: { type: "int", editable: true, visible: true },
      name: { type: "text", editable: true, visible: true },
      role: { type: "text", editable: true, visible: true },
      filial: { type: "text", editable: true, visible: true },
      shift_start: { type: "text", editable: true, visible: true },
      shift_end: { type: "text", editable: true, visible: true },
      weekly_schedule: { type: "jsonb", editable: true, visible: true },
      access_card_no: { type: "text", editable: false, visible: false },
      created_at: { type: "timestamptz", editable: false, visible: true },
    },
  },
  employee_attendance: {
    pk: { name: "id", type: "bigint" },
    columns: {
      id: { type: "bigint", editable: false, visible: true },
      employee_id: { type: "int", editable: true, visible: true },
      record_date: { type: "date", editable: true, visible: true },
      check_in: { type: "text", editable: true, visible: true },
      check_out: { type: "text", editable: true, visible: true },
      late: { type: "boolean", editable: true, visible: true },
      check_in_snapshot: { type: "text", editable: false, visible: false },
      check_out_snapshot: { type: "text", editable: false, visible: false },
      check_in_filial: { type: "text", editable: false, visible: false },
      check_out_filial: { type: "text", editable: false, visible: false },
    },
  },
  role_salaries: {
    compositePk: true,
    pk: null,
    orderBy: "admin_id",
    pkColumns: [
      { name: "admin_id", type: "int" },
      { name: "role_name", type: "text" },
    ],
    columns: {
      admin_id: { type: "int", editable: false, visible: true },
      role_name: { type: "text", editable: false, visible: true },
      amount: { type: "int", editable: true, visible: true },
      salary_type: { type: "text", editable: true, visible: true },
    },
  },
  employee_salary_overrides: {
    pk: { name: "employee_id", type: "int" },
    columns: {
      employee_id: { type: "int", editable: false, visible: true },
      amount: { type: "int", editable: true, visible: true },
      salary_type: { type: "text", editable: true, visible: true },
    },
  },
  employee_salary_payments: {
    pk: { name: "id", type: "bigint" },
    columns: {
      id: { type: "bigint", editable: false, visible: true },
      employee_id: { type: "int", editable: true, visible: true },
      pay_date: { type: "date", editable: true, visible: true },
      amount: { type: "int", editable: true, visible: true },
      batch_id: { type: "text", editable: true, visible: true },
      created_by: { type: "int", editable: true, visible: true },
      paid_at: { type: "timestamptz", editable: true, visible: true },
      note: { type: "text", editable: true, visible: true },
    },
  },
  employee_salary_adjustments: {
    pk: { name: "id", type: "bigint" },
    columns: {
      id: { type: "bigint", editable: false, visible: true },
      employee_id: { type: "int", editable: true, visible: true },
      adj_date: { type: "date", editable: true, visible: true },
      kind: { type: "text", editable: true, visible: true },
      amount: { type: "int", editable: true, visible: true },
      source: { type: "text", editable: true, visible: true },
      created_by: { type: "int", editable: true, visible: true },
      note: { type: "text", editable: true, visible: true },
      updated_at: { type: "timestamptz", editable: true, visible: true },
      deleted_at: { type: "timestamptz", editable: true, visible: true },
      created_at: { type: "timestamptz", editable: true, visible: true },
    },
  },
  users: {
    pk: { name: "id", type: "int" },
    columns: {
      id: { type: "int", editable: false, visible: true },
      admin_id: { type: "int", editable: true, visible: true },
      username: { type: "text", editable: true, visible: true },
      role: { type: "text", editable: true, visible: true },
      employee_id: { type: "int", editable: true, visible: true },
      subscription_end: { type: "timestamptz", editable: true, visible: true },
      subscription_amount: { type: "int", editable: true, visible: true },
      subscription_notice_template: { type: "text", editable: true, visible: true },
      created_at: { type: "timestamptz", editable: false, visible: true },
    },
  },
  terminals: {
    pk: { name: "id", type: "int" },
    columns: {
      id: { type: "int", editable: false, visible: true },
      terminal_name: { type: "text", editable: true, visible: true },
      admin_id: { type: "int", editable: true, visible: true },
      terminal_type: { type: "text", editable: true, visible: true },
      filial: { type: "text", editable: true, visible: true },
      ip_address: { type: "text", editable: true, visible: true },
      login: { type: "text", editable: true, visible: true },
      password: { type: "text", editable: true, visible: true },
      created_at: { type: "timestamptz", editable: false, visible: true },
    },
  },
  app_kv: {
    pk: { name: "key", type: "text" },
    columns: {
      key: { type: "text", editable: false, visible: true },
      value: { type: "text", editable: true, visible: true },
    },
  },
};

/** Baza explorer: ma'lum jadval uchun static yoki DB'dan o'qilgan config. */
const explorerDynamicConfigCache = new Map();

async function resolveExplorerTableConfig(pool, table) {
  let t;
  try {
    t = assertSafeSqlIdentifier(String(table || ""));
  } catch {
    return null;
  }
  if (DB_TABLE_CONFIG[t]) {
    const c = DB_TABLE_CONFIG[t];
    const readOnly = c.explorerReadOnly === true;
    const orderBy = c.orderBy || c.pk?.name;
    if (!orderBy) {
      return null;
    }
    const pkColumns =
      Array.isArray(c.pkColumns) && c.pkColumns.length > 0
        ? c.pkColumns
        : c.pk?.name
          ? [{ name: c.pk.name, type: c.pk.type }]
          : [];
    return {
      ...c,
      readOnly,
      orderBy,
      compositePk: !!c.compositePk,
      pkColumns,
    };
  }
  if (explorerDynamicConfigCache.has(t)) return explorerDynamicConfigCache.get(t);
  const dyn = await buildDynamicReadOnlyTableConfig(pool, t);
  if (!dyn) return null;
  explorerDynamicConfigCache.set(t, dyn);
  return dyn;
}

function castForType(type) {
  if (type === "int") return "int";
  if (type === "bigint") return "bigint";
  if (type === "boolean") return "boolean";
  if (type === "jsonb") return "jsonb";
  if (type === "date") return "date";
  if (type === "timestamptz") return "timestamptz";
  if (type === "float") return "double precision";
  if (type === "numeric") return "numeric";
  return "text";
}

function normalizeValueForType(type, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && value.trim() === "") {
    if (type === "boolean") return null;
    return null;
  }
  if (type === "int") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  }
  if (type === "float") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n;
  }
  if (type === "numeric") {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n;
  }
  if (type === "bigint") {
    const s = String(value).trim();
    if (!s) return null;
    return s;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const s = String(value).toLowerCase().trim();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
    return null;
  }
  if (type === "timestamptz") {
    const d = new Date(value);
    const t = d.getTime();
    if (!Number.isFinite(t)) return null;
    return d.toISOString();
  }
  if (type === "date") {
    const d = new Date(value);
    const t = d.getTime();
    if (!Number.isFinite(t)) return null;
    return d.toISOString().slice(0, 10);
  }
  if (type === "jsonb") {
    if (typeof value === "string") return value.trim();
    return JSON.stringify(value);
  }
  if (type === "text") return String(value);
  return String(value);
}

/** Baza explorer: kompozit PK URL segment — JSON obyekt (fetch bir marta encodeURIComponent qiladi). */
function parseCompositePkObject(pkValRaw) {
  const s = String(pkValRaw ?? "").trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    /* keyingi urinish */
  }
  try {
    const obj = JSON.parse(decodeURIComponent(s));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {
    /* ignore */
  }
  return null;
}

function pkWhereClauseAndParams(cfg, pkValRaw) {
  const hasComposite = cfg.compositePk && Array.isArray(cfg.pkColumns) && cfg.pkColumns.length > 0;
  const hasSingle = cfg.pk?.name;
  if (hasComposite) {
    const obj = parseCompositePkObject(pkValRaw);
    if (!obj) return { error: "Noto'g'ri yoki noto'liq primary key" };
    const parts = [];
    for (const { name, type } of cfg.pkColumns) {
      if (!Object.prototype.hasOwnProperty.call(obj, name)) {
        return { error: `PK maydoni yetishmayapti: ${name}` };
      }
      const normalized = normalizeValueForType(type, obj[name]);
      parts.push({ name, type, normalized });
    }
    return { composite: true, parts };
  }
  if (hasSingle) {
    const normalized = normalizeValueForType(cfg.pk.type, pkValRaw);
    return {
      composite: false,
      parts: [{ name: cfg.pk.name, type: cfg.pk.type, normalized }],
    };
  }
  return { error: "PK aniqlanmadi" };
}

api.get("/db/meta", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    let pub = [];
    try {
      pub = await listPublicBaseTables(pool);
    } catch (e) {
      console.warn("[db/meta] public jadvallarni olishda xato, faqat statik ro'yxat:", e);
      pub = [];
    }
    const staticKeys = Object.keys(DB_TABLE_CONFIG);
    const names = [...new Set([...pub, ...staticKeys])].sort((a, b) => a.localeCompare(b));
    const tables = [];
    for (const name of names) {
      try {
        const cfg = await resolveExplorerTableConfig(pool, name);
        if (!cfg) continue;
        tables.push({
          name,
          readOnly: !!cfg.readOnly,
          compositePk: !!cfg.compositePk,
          pk: cfg.pk,
          pkColumns: Array.isArray(cfg.pkColumns) ? cfg.pkColumns : [],
          columns: Object.entries(cfg.columns)
            .map(([colName, col]) => ({ name: colName, ...col }))
            .filter((c) => c.visible),
        });
      } catch (e) {
        console.warn(`[db/meta] jadval "${name}" o'tkazib yuborildi:`, e);
      }
    }
    res.json({ tables });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/db/table/:table", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const table = String(req.params.table);
    const cfg = await resolveExplorerTableConfig(pool, table);
    if (!cfg) return res.status(404).json({ error: "Bunday jadval yo'q" });

    const adminIdIn = req.query.adminId ? String(req.query.adminId) : "";
    const employeeIdIn = req.query.employeeId ? String(req.query.employeeId) : "";
    const adminId = adminIdIn ? Number.parseInt(adminIdIn, 10) : null;
    const employeeId = employeeIdIn ? Number.parseInt(employeeIdIn, 10) : null;
    const adminIdOk = adminId != null && Number.isFinite(adminId);
    const employeeIdOk = employeeId != null && Number.isFinite(employeeId);

    /** `public` jadvalda `admin_id` bor-yo‘qligini static ro‘yxat va metadata orqali aniqlash */
    const TABLES_WITH_ADMIN_ID = new Set([
      "employees",
      "employee_attendance",
      "terminals",
      "employee_salary_payments",
      "employee_salary_adjustments",
      "admin_filial_map",
      "admin_salary_calc_configs",
      "role_salaries",
      "employee_salary_overrides",
      "app_kv",
    ]);

    const visibleCols = Object.entries(cfg.columns)
      .filter(([, c]) => c.visible)
      .map(([name]) => name);

    const selects = visibleCols.map((c) => quoteIdent(c)).join(", ");
    const orderCol = cfg.orderBy || cfg.pk?.name;
    if (!orderCol) {
      return res.status(500).json({ error: "Jadval uchun tartib ustuni aniqlanmadi" });
    }

    const conditions = [];
    const params = [];
    let p = 1;

    if (adminIdOk) {
      if (table === "users") {
        /* Tanlangan adminning o‘zi (id) va unga biriktirilgan foydalanuvchilar (admin_id) */
        conditions.push(
          `(${quoteIdent("id")} = $${p} OR ${quoteIdent("admin_id")} = $${p})`
        );
        params.push(adminId);
        p++;
      } else if (cfg.columns && Object.prototype.hasOwnProperty.call(cfg.columns, "admin_id")) {
        conditions.push(`${quoteIdent("admin_id")} = $${p++}`);
        params.push(adminId);
      } else if (TABLES_WITH_ADMIN_ID.has(table)) {
        conditions.push(`${quoteIdent("admin_id")} = $${p++}`);
        params.push(adminId);
      }
    }

    if (employeeIdOk) {
      if (table === "employees") {
        conditions.push(`${quoteIdent("id")} = $${p++}`);
        params.push(employeeId);
      } else if (cfg.columns && Object.prototype.hasOwnProperty.call(cfg.columns, "employee_id")) {
        conditions.push(`${quoteIdent("employee_id")} = $${p++}`);
        params.push(employeeId);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const q = `SELECT ${selects} FROM ${quoteIdent(table)} ${where} ORDER BY ${quoteIdent(orderCol)} ASC`;
    const r = await pool.query(q, params);
    res.json({ columns: visibleCols, rows: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.patch("/db/table/:table/:pkVal", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const table = String(req.params.table);
    const cfg = await resolveExplorerTableConfig(pool, table);
    if (!cfg) return res.status(404).json({ error: "Bunday jadval yo'q" });
    if (cfg.readOnly) {
      return res.status(403).json({ error: "Bu jadval faqat ko'rish rejimida" });
    }
    const pkValRaw = req.params.pkVal;
    const pkBits = pkWhereClauseAndParams(cfg, pkValRaw);
    if (pkBits.error) {
      return res.status(400).json({ error: pkBits.error });
    }
    const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : req.body || {};

    const editable = Object.entries(cfg.columns)
      .filter(([, c]) => c.editable)
      .map(([name]) => name);

    const updates = [];
    const params = [];

    for (const col of editable) {
      if (!(col in data)) continue;
      const colCfg = cfg.columns[col];
      const type = colCfg.type;
      const normalized = normalizeValueForType(type, data[col]);
      updates.push(`${quoteIdent(col)} = $${params.length + 1}::${castForType(type)}`);
      params.push(normalized);
    }

    if (updates.length === 0) return res.status(400).json({ error: "Hech narsa o'zgarmadi" });

    const whParts = pkBits.parts.map((part) => {
      params.push(part.normalized);
      return `${quoteIdent(part.name)} = $${params.length}::${castForType(part.type)}`;
    });
    const q = `UPDATE ${quoteIdent(table)} SET ${updates.join(", ")} WHERE ${whParts.join(" AND ")}`;

    await pool.query(q, params);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.delete("/db/table/:table/:pkVal", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const table = String(req.params.table);
    const cfg = await resolveExplorerTableConfig(pool, table);
    if (!cfg) return res.status(404).json({ error: "Bunday jadval yo'q" });
    if (cfg.readOnly) {
      return res.status(403).json({ error: "Bu jadval faqat ko'rish rejimida" });
    }
    const pkValRaw = req.params.pkVal;
    const pkBits = pkWhereClauseAndParams(cfg, pkValRaw);
    if (pkBits.error) {
      return res.status(400).json({ error: pkBits.error });
    }
    const params = [];
    const whParts = pkBits.parts.map((part) => {
      params.push(part.normalized);
      return `${quoteIdent(part.name)} = $${params.length}::${castForType(part.type)}`;
    });
    const q = `DELETE FROM ${quoteIdent(table)} WHERE ${whParts.join(" AND ")}`;
    const r = await pool.query(q, params);
    if (r.rowCount === 0) return res.status(404).json({ error: "Topilmadi" });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/db/table/:table/bulk-delete", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const table = String(req.params.table);
    const cfg = await resolveExplorerTableConfig(pool, table);
    if (!cfg) return res.status(404).json({ error: "Bunday jadval yo'q" });
    if (cfg.readOnly) {
      return res.status(403).json({ error: "Bu jadval faqat ko'rish rejimida" });
    }
    const pks = req.body?.pks;
    const list = Array.isArray(pks) ? pks.map((x) => String(x)).filter((x) => x) : [];
    if (list.length === 0) return res.status(400).json({ error: "pks bo'sh" });

    if (cfg.compositePk && Array.isArray(cfg.pkColumns) && cfg.pkColumns.length > 0) {
      const ors = [];
      const params = [];
      for (const enc of list) {
        const pkBits = pkWhereClauseAndParams(cfg, enc);
        if (pkBits.error) return res.status(400).json({ error: pkBits.error });
        const ands = pkBits.parts.map((part) => {
          params.push(part.normalized);
          return `${quoteIdent(part.name)} = $${params.length}::${castForType(part.type)}`;
        });
        ors.push(`(${ands.join(" AND ")})`);
      }
      const q = `DELETE FROM ${quoteIdent(table)} WHERE ${ors.join(" OR ")}`;
      await pool.query(q, params);
    } else if (cfg.pk?.name) {
      const pkTypeCast = castForType(cfg.pk.type);
      const q = `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(cfg.pk.name)} = ANY($1::${pkTypeCast}[])`;
      await pool.query(q, [list]);
    } else {
      return res.status(403).json({ error: "Bu jadval uchun PK aniqlanmadi" });
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/users", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role, u.employee_id, u.subscription_end, u.subscription_amount, u.subscription_notice_template,
              COALESCE(
                (SELECT json_agg(m.filial ORDER BY m.filial) FROM admin_filial_map m WHERE m.admin_id = u.id),
                '[]'::json
              ) AS admin_filials
       FROM users u ORDER BY u.id ASC`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/users", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { username, password, role = "admin", employeeId = null, filials } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username va password majburiy" });
    }
    const u = String(username).trim();
    const r = String(role).trim();
    if (!["superadmin", "admin", "hodim"].includes(r)) {
      return res.status(400).json({ error: "role noto'g'ri" });
    }

    let eid = null;
    if (r === "hodim") {
      eid = Number(employeeId);
      if (!Number.isFinite(eid)) return res.status(400).json({ error: "employeeId majburiy" });
      const emp = await pool.query(`SELECT id FROM employees WHERE id = $1`, [eid]);
      if (emp.rows.length === 0) return res.status(400).json({ error: "employeeId topilmadi" });
    }

    const hash = await bcrypt.hash(String(password).trim(), 10);
    const ins = await pool.query(
      `INSERT INTO users (username, password_hash, role, employee_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           employee_id = EXCLUDED.employee_id
       RETURNING id`,
      [u, hash, r, eid]
    );
    const createdId = ins?.rows?.[0]?.id ?? null;
    if (r === "admin" && createdId != null && Array.isArray(filials)) {
      const cleaned = [...new Set(filials.map((x) => String(x).trim()).filter(Boolean))];
      await pool.query(`DELETE FROM admin_filial_map WHERE admin_id = $1`, [createdId]);
      for (const f of cleaned) {
        await pool.query(
          `INSERT INTO admin_filial_map (admin_id, filial) VALUES ($1, $2) ON CONFLICT (admin_id, filial) DO NOTHING`,
          [createdId, f]
        );
      }
    }
    res.status(201).json({ id: createdId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/users/:id/filials", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Noto'g'ri id" });
    const ur = await pool.query(`SELECT id, role FROM users WHERE id = $1`, [targetId]);
    if (ur.rows.length === 0) return res.status(404).json({ error: "Topilmadi" });
    if (ur.rows[0].role !== "admin") return res.json({ filials: [] });
    const { rows } = await pool.query(
      `SELECT filial FROM admin_filial_map WHERE admin_id = $1 ORDER BY filial ASC`,
      [targetId]
    );
    res.json({ filials: rows.map((x) => x.filial) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.put("/users/:id/filials", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Noto'g'ri id" });
    const ur = await pool.query(`SELECT id, role FROM users WHERE id = $1`, [targetId]);
    if (ur.rows.length === 0) return res.status(404).json({ error: "Topilmadi" });
    if (ur.rows[0].role !== "admin") return res.status(400).json({ error: "Faqat admin uchun" });
    const filials = req.body?.filials;
    if (!Array.isArray(filials)) return res.status(400).json({ error: "filials massiv bo'lishi kerak" });
    const cleaned = [...new Set(filials.map((x) => String(x).trim()).filter(Boolean))];
    await pool.query(`DELETE FROM admin_filial_map WHERE admin_id = $1`, [targetId]);
    for (const f of cleaned) {
      await pool.query(
        `INSERT INTO admin_filial_map (admin_id, filial) VALUES ($1, $2) ON CONFLICT (admin_id, filial) DO NOTHING`,
        [targetId, f]
      );
    }
    res.json({ filials: cleaned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.patch("/users/:id", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Noto'g'ri id" });
    const { username, password, role, employeeId } = req.body || {};

    const updates = [];
    const params = [];
    let pi = 1;
    const nextPh = () => `$${pi++}`;

    if (username != null) {
      const u = String(username).trim();
      if (!u) return res.status(400).json({ error: "username bo'sh" });
      updates.push(`username = ${nextPh()}`);
      params.push(u);
    }

    if (role != null) {
      const r = String(role).trim();
      if (!["superadmin", "admin", "hodim"].includes(r)) return res.status(400).json({ error: "role noto'g'ri" });
      updates.push(`role = ${nextPh()}`);
      params.push(r);
    }

    if (role === "hodim" || (role == null && employeeId != null)) {
      const eid = employeeId == null ? null : Number(employeeId);
      if (!Number.isFinite(eid)) return res.status(400).json({ error: "employeeId noto'g'ri" });
      const emp = await pool.query(`SELECT id FROM employees WHERE id = $1`, [eid]);
      if (emp.rows.length === 0) return res.status(400).json({ error: "employeeId topilmadi" });
      updates.push(`employee_id = ${nextPh()}`);
      params.push(eid);
    } else if (role != null && role !== "hodim") {
      updates.push(`employee_id = NULL`);
    }

    if (role != null && role !== "admin") {
      updates.push(`subscription_end = NULL`);
      updates.push(`subscription_amount = NULL`);
      updates.push(`subscription_notice_template = NULL`);
    }

    if (password != null) {
      const p = String(password).trim();
      if (!p) return res.status(400).json({ error: "password bo'sh" });
      const hash = await bcrypt.hash(p, 10);
      updates.push(`password_hash = ${nextPh()}`);
      params.push(hash);
    }

    if (updates.length === 0) return res.status(400).json({ error: "Hech narsa o'zgarmadi" });

    const idPlaceholder = nextPh();
    params.push(targetId);
    const sql = `UPDATE users SET ${updates.join(", ")} WHERE id = ${idPlaceholder}`;

    const r = await pool.query(sql, params);
    if (r.rowCount === 0) return res.status(404).json({ error: "Topilmadi" });
    const ur = await pool.query(`SELECT role FROM users WHERE id = $1`, [targetId]);
    const finalRole = ur.rows[0]?.role;
    if (finalRole !== "admin") {
      await pool.query(`DELETE FROM admin_filial_map WHERE admin_id = $1`, [targetId]);
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.patch("/users/:id/subscription", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Noto'g'ri id" });
    const { endAt, amount, text } = req.body || {};
    if (!endAt) return res.status(400).json({ error: "endAt majburiy" });
    const end = new Date(endAt);
    const endTime = end.getTime();
    if (!Number.isFinite(endTime)) return res.status(400).json({ error: "endAt noto'g'ri" });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "summa noto'g'ri" });
    const defaultTemplate =
      "Sizning obuna muddatingiz {{sana}} kunida tugaydi. Platformadan foydalanishni davom ettirish uchun to'lovni amalga oshiring (Obuna narxi: {{narxi}}) va Superadmin bilan bog'laning.Telegram:@temur_8080";
    const t = text == null ? "" : String(text).trim();
    let template = t ? t : defaultTemplate;
    template = template.replace(/tugagan/g, "tugaydi");

    await pool.query(
      `UPDATE users
       SET subscription_end = $1,
           subscription_amount = $2,
           subscription_notice_template = $3,
           role = CASE WHEN role IN ('admin','superadmin') THEN role ELSE 'admin' END
       WHERE id = $4`,
      [end.toISOString(), Math.trunc(amt), template, targetId]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.delete("/users/:id/subscription", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Noto'g'ri id" });
    await pool.query(
      `UPDATE users
       SET subscription_end = NULL,
           subscription_amount = NULL,
           subscription_notice_template = NULL
       WHERE id = $1`,
      [targetId]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.delete("/users/:id", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const targetId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: "Noto'g'ri id" });

    const cur = await pool.query(`SELECT id, role FROM users WHERE id = $1`, [targetId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: "Topilmadi" });
    const role = cur.rows[0].role;

    if (role === "superadmin") return res.status(403).json({ error: "Superadminni o'chirib bo'lmaydi" });
    await pool.query(`DELETE FROM users WHERE id = $1`, [targetId]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

async function resolveTerminalFilialForSave(pool, adminId, rawFilial) {
  const adminIdNum = Number(adminId);
  if (!Number.isFinite(adminIdNum)) return null;
  const s = String(rawFilial ?? "").trim();
  const { rows: mapRows } = await pool.query(
    `SELECT filial FROM admin_filial_map WHERE admin_id = $1 ORDER BY filial ASC`,
    [adminIdNum]
  );
  if (s === "") {
    if (mapRows.length === 0) return "Asosiy filial";
    return String(mapRows[0].filial).trim();
  }
  const allowed = new Set(mapRows.map((r) => String(r.filial).trim()));
  if (allowed.has(s)) return s;
  if (mapRows.length === 0 && s === "Asosiy filial") return s;
  return null;
}

api.get("/terminals", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const { rows } = await pool.query(
      `SELECT t.id, t.terminal_name, t.admin_id, t.terminal_type, t.filial, t.ip_address, t.login, t.password, t.created_at,
              u.username AS admin_username
       FROM terminals t
       JOIN users u ON u.id = t.admin_id
       ORDER BY t.id DESC`
    );
    res.json({ terminals: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/terminals", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const terminalName = String(req.body?.terminalName || "").trim();
    const adminId = Number.parseInt(String(req.body?.adminId || ""), 10);
    const terminalTypeIn = String(req.body?.terminalType || "").trim();
    const ipAddress = String(req.body?.ipAddress || "").trim();
    const login = String(req.body?.login || "").trim();
    const password = String(req.body?.password || "").trim();
    const filialRaw = req.body?.filial;
    const terminalType = terminalTypeIn === "Chiqish" ? "Chiqish" : "Kirish";
    if (!terminalName || !Number.isFinite(adminId) || !ipAddress || !login || !password) {
      return res.status(400).json({ error: "Barcha maydonlar majburiy" });
    }
    const adminR = await pool.query(`SELECT id FROM users WHERE id = $1 AND role = 'admin'`, [adminId]);
    if (adminR.rows.length === 0) return res.status(400).json({ error: "Admin topilmadi" });
    const filialVal = await resolveTerminalFilialForSave(pool, adminId, filialRaw);
    if (filialVal == null) return res.status(400).json({ error: "Filial admin ro‘yxatida yo‘q yoki noto‘g‘ri" });
    const { rows } = await pool.query(
      `INSERT INTO terminals (terminal_name, admin_id, terminal_type, filial, ip_address, login, password)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, terminal_name, admin_id, terminal_type, filial, ip_address, login, password, created_at`,
      [terminalName, adminId, terminalType, filialVal, ipAddress, login, password]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.patch("/terminals/:id", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    const terminalName = String(req.body?.terminalName || "").trim();
    const adminId = Number.parseInt(String(req.body?.adminId || ""), 10);
    const terminalTypeIn = String(req.body?.terminalType || "").trim();
    const ipAddress = String(req.body?.ipAddress || "").trim();
    const login = String(req.body?.login || "").trim();
    const password = String(req.body?.password || "").trim();
    const filialRaw = req.body?.filial;
    const terminalType = terminalTypeIn === "Chiqish" ? "Chiqish" : "Kirish";
    if (!terminalName || !Number.isFinite(adminId) || !ipAddress || !login || !password) {
      return res.status(400).json({ error: "Barcha maydonlar majburiy" });
    }
    const adminR = await pool.query(`SELECT id FROM users WHERE id = $1 AND role = 'admin'`, [adminId]);
    if (adminR.rows.length === 0) return res.status(400).json({ error: "Admin topilmadi" });
    const filialVal = await resolveTerminalFilialForSave(pool, adminId, filialRaw);
    if (filialVal == null) return res.status(400).json({ error: "Filial admin ro‘yxatida yo‘q yoki noto‘g‘ri" });
    const upd = await pool.query(
      `UPDATE terminals SET terminal_name = $1, admin_id = $2, terminal_type = $3, filial = $4, ip_address = $5, login = $6, password = $7
       WHERE id = $8
       RETURNING id, terminal_name, admin_id, terminal_type, filial, ip_address, login, password, created_at`,
      [terminalName, adminId, terminalType, filialVal, ipAddress, login, password, id]
    );
    if (upd.rows.length === 0) return res.status(404).json({ error: "Terminal topilmadi" });
    const row = upd.rows[0];
    const u = await pool.query(`SELECT username AS admin_username FROM users WHERE id = $1`, [row.admin_id]);
    res.json({ ...row, admin_username: u.rows[0]?.admin_username ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.delete("/terminals/:id", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    const r = await pool.query(`DELETE FROM terminals WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Terminal topilmadi" });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/terminals/:id/test-connection", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    const { rows } = await pool.query(
      `SELECT id, terminal_name, ip_address, login, password FROM terminals WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Terminal topilmadi" });
    const row = rows[0];
    const result = await probeHikvisionTerminal({
      ipAddress: row.ip_address,
      login: row.login,
      password: row.password,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/terminals/:id/sync-employees", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    const { rows } = await pool.query(
      `SELECT id, admin_id, terminal_type, ip_address, login, password, filial FROM terminals WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Terminal topilmadi" });
    const row = rows[0];
    if (req.auth?.role === "admin" && Number(row.admin_id) !== Number(req.auth?.sub)) {
      return res.status(403).json({ error: "Bu terminal sizga tegishli emas" });
    }
    const result = await syncEmployeesFromTerminal(pool, row);
    // 422: terminalga ISAPI ulanmadi (502 nginx bilan adashmasin)
    if (!result.ok) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/terminals/sync-all-my-employees", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Faqat admin" });
      return;
    }
    const adminId = req.auth.sub;
    const { rows } = await pool.query(
      `SELECT id, terminal_name, admin_id, terminal_type, ip_address, login, password, filial FROM terminals WHERE admin_id = $1 ORDER BY id`,
      [adminId]
    );
    const result = await runSyncEmployeesAcrossTerminals(rows);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** Admin: o‘z terminallari; superadmin: barcha terminallar (Hikvision ISAPI orqali import). */
api.post("/employees/generate-from-terminals", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    let rows;
    if (req.auth?.role === "superadmin") {
      const r = await pool.query(
        `SELECT id, terminal_name, admin_id, terminal_type, ip_address, login, password, filial FROM terminals ORDER BY id`
      );
      rows = r.rows;
    } else {
      const r = await pool.query(
        `SELECT id, terminal_name, admin_id, terminal_type, ip_address, login, password, filial FROM terminals WHERE admin_id = $1 ORDER BY id`,
        [req.auth.sub]
      );
      rows = r.rows;
    }
    const result = await runSyncEmployeesAcrossTerminals(rows);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.get("/bootstrap", async (req, res) => {
  try {
    const userRole = req.auth?.role || "admin";
    const myEmployeeId = req.auth?.employeeId ?? null;
    const authSub = req.auth?.sub ?? null;

    let scopedAdminId = null;
    if (userRole === "admin") scopedAdminId = authSub;
    let roleSalariesQ;
    const themeQ = pool.query(`SELECT value FROM app_kv WHERE key = 'theme'`);
    const salaryCalcQ = pool.query(
      `SELECT key, value FROM app_kv WHERE key IN
       ('salary_calc_week_mode','salary_calc_week_fixed','salary_calc_month_mode','salary_calc_month_fixed',
        'salary_calc_attendance_mode',
        'terminal_event_timezone_offset_hours',
        'salary_policy_enabled',
        'salary_policy_late_per_minute','salary_policy_bonus_per_minute','salary_policy_bonus_grace_minutes',
        'salary_policy_late_grace_minutes','salary_policy_max_daily_fine',
        'salary_policy_employee_overrides')`
    );
    const adminSalaryCalcQ = pool.query(
      `SELECT filial, week_mode, week_fixed, month_mode, month_fixed, attendance_mode
       FROM admin_salary_calc_configs
       WHERE admin_id = $1`,
      [authSub]
    );
    const adminFilialsQ = pool.query(
      `SELECT filial FROM admin_filial_map WHERE admin_id = $1 ORDER BY filial ASC`,
      [authSub]
    );

    let adminSubscription = null;
    let adminSubscriptionMessage = "";
    if (userRole === "admin") {
      const userId = req.auth?.sub;
      const subQ = pool.query(
        `SELECT subscription_end, subscription_amount, subscription_notice_template FROM users WHERE id = $1`,
        [userId]
      );
      const subR = await subQ;
      const end = subR.rows[0]?.subscription_end ?? null;
      const amount = subR.rows[0]?.subscription_amount ?? null;
      const storedTemplate = subR.rows[0]?.subscription_notice_template ?? null;
      const endMs = end ? new Date(end).getTime() : null;
      const now = Date.now();
      const locked = endMs == null || !Number.isFinite(endMs) || endMs <= now;
      const nearEnd = endMs != null && Number.isFinite(endMs) && endMs > now && endMs <= now + 5 * DAY_MS;
      const daysLeft =
        endMs != null && Number.isFinite(endMs) && endMs > now ? Math.max(1, Math.ceil((endMs - now) / DAY_MS)) : 0;
      const noticeDateKey = new Date(now).toISOString().slice(0, 10);
      const noticeKey = nearEnd ? `${noticeDateKey}:${daysLeft}` : null;
      adminSubscription = { locked, nearEnd, daysLeft, noticeKey, subscription_end: end, subscription_amount: amount };
      const defaultTemplate =
        "Sizning obuna muddatingiz {{sana}} kunida tugaydi. Platformadan foydalanishni davom ettirish uchun to'lovni amalga oshiring (Obuna narxi: {{narxi}}) va Superadmin bilan bog'laning.Telegram:@temur_8080";
      let template = storedTemplate && String(storedTemplate).trim() ? String(storedTemplate) : defaultTemplate;
      template = template.replace(/tugagan/g, "tugaydi");
      const sana = endMs ? String(new Date(end).getDate()) : "";
      const narxi = amount != null ? String(Number(amount).toLocaleString("uz-UZ")) : "";
      adminSubscriptionMessage = template.split("{{sana}}").join(sana).split("{{narxi}}").join(narxi);
    }

    let empR;
    let attR;
    let ovR;
    let payR;
    let adjR;

    if (userRole === "hodim") {
      if (!myEmployeeId) {
        return res.status(400).json({ error: "Hodim uchun employee_id bog'lanmagan" });
      }
      empR = await pool.query(
        `SELECT id, admin_id, name, role, filial, shift_start, shift_end, weekly_schedule, access_card_no FROM employees WHERE id = $1`,
        [myEmployeeId]
      );
      scopedAdminId = empR.rows[0]?.admin_id ?? null;
      attR = await pool.query(
        `SELECT id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot,
                check_in_filial, check_out_filial
         FROM employee_attendance WHERE employee_id = $1 ORDER BY id ASC`,
        [myEmployeeId]
      );
      ovR = await pool.query(
        `SELECT employee_id, amount, salary_type FROM employee_salary_overrides WHERE employee_id = $1`,
        [myEmployeeId]
      );
      payR = await pool.query(
        `SELECT id, employee_id, pay_date, amount, batch_id, created_by, paid_at, note
         FROM employee_salary_payments
         WHERE employee_id = $1
         ORDER BY pay_date ASC, id ASC`,
        [myEmployeeId]
      );
      adjR = await pool.query(
        `SELECT id, employee_id, adj_date, kind, amount, source, created_by, note, updated_at, deleted_at, created_at
         FROM employee_salary_adjustments
         WHERE employee_id = $1 AND deleted_at IS NULL
         ORDER BY adj_date ASC, id ASC`,
        [myEmployeeId]
      );
    } else {
      const isAdmin = userRole === "admin" && scopedAdminId != null;
      const [allEmpR, allAttR, allOvR, allPayR, allAdjR] = await Promise.all([
        isAdmin
          ? pool.query(
              `SELECT id, admin_id, name, role, filial, shift_start, shift_end, weekly_schedule, access_card_no
               FROM employees WHERE admin_id = $1 ORDER BY id ASC`,
              [scopedAdminId]
            )
          : pool.query(
              `SELECT id, admin_id, name, role, filial, shift_start, shift_end, weekly_schedule, access_card_no
               FROM employees ORDER BY id ASC`
            ),
        isAdmin
          ? pool.query(
              `SELECT a.id, a.employee_id, a.record_date, a.check_in, a.check_out, a.late,
                      a.check_in_snapshot, a.check_out_snapshot, a.check_in_filial, a.check_out_filial
               FROM employee_attendance a
               JOIN employees e ON e.id = a.employee_id
               WHERE e.admin_id = $1
               ORDER BY a.id ASC`,
              [scopedAdminId]
            )
          : pool.query(
              `SELECT id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot,
                      check_in_filial, check_out_filial
               FROM employee_attendance ORDER BY id ASC`
            ),
        isAdmin
          ? pool.query(
              `SELECT o.employee_id, o.amount, o.salary_type
               FROM employee_salary_overrides o
               JOIN employees e ON e.id = o.employee_id
               WHERE e.admin_id = $1`,
              [scopedAdminId]
            )
          : pool.query(`SELECT employee_id, amount, salary_type FROM employee_salary_overrides`),
        isAdmin
          ? pool.query(
              `SELECT p.id, p.employee_id, p.pay_date, p.amount, p.batch_id, p.created_by, p.paid_at, p.note
               FROM employee_salary_payments p
               JOIN employees e ON e.id = p.employee_id
               WHERE e.admin_id = $1
               ORDER BY p.pay_date ASC, p.id ASC`,
              [scopedAdminId]
            )
          : pool.query(
              `SELECT id, employee_id, pay_date, amount, batch_id, created_by, paid_at, note
               FROM employee_salary_payments
               ORDER BY pay_date ASC, id ASC`
            ),
        isAdmin
          ? pool.query(
              `SELECT s.id, s.employee_id, s.adj_date, s.kind, s.amount, s.source, s.created_by, s.note, s.updated_at, s.deleted_at, s.created_at
               FROM employee_salary_adjustments s
               JOIN employees e ON e.id = s.employee_id
               WHERE e.admin_id = $1 AND s.deleted_at IS NULL
               ORDER BY s.adj_date ASC, s.id ASC`,
              [scopedAdminId]
            )
          : pool.query(
              `SELECT id, employee_id, adj_date, kind, amount, source, created_by, note, updated_at, deleted_at, created_at
               FROM employee_salary_adjustments
               WHERE deleted_at IS NULL
               ORDER BY adj_date ASC, id ASC`
            ),
      ]);
      empR = allEmpR;
      attR = allAttR;
      ovR = allOvR;
      payR = allPayR;
      adjR = allAdjR;
    }

    if (scopedAdminId != null) {
      roleSalariesQ = pool.query(
        `SELECT role_name, amount, salary_type FROM role_salaries WHERE admin_id = $1`,
        [scopedAdminId]
      );
    } else {
      roleSalariesQ = pool.query(`SELECT role_name, amount, salary_type FROM role_salaries WHERE admin_id = 0`);
    }

    const [roleR, themeR, salaryCalcR, adminSalaryCalcR, adminFilialsR] = await Promise.all([
      roleSalariesQ,
      themeQ,
      salaryCalcQ,
      adminSalaryCalcQ,
      adminFilialsQ,
    ]);

    const roleSalaries = {};
    for (const row of roleR.rows) {
      const amount = Number(row.amount);
      const type = row.salary_type || "oy";
      const key = row.role_name == null ? "" : String(row.role_name).trim();
      if (!key) continue;
      roleSalaries[key] = { amount: Number.isFinite(amount) ? amount : 0, type };
    }

    const employeeSalaryOverrides = {};
    for (const row of ovR.rows) {
      const amount = Number(row.amount);
      const type = row.salary_type || "oy";
      employeeSalaryOverrides[String(row.employee_id)] = { amount: Number.isFinite(amount) ? amount : 0, type };
    }

    const themeRow = themeR.rows[0];
    const theme = themeRow?.value === "dark" ? "dark" : "light";

    const kvMap = {};
    for (const row of salaryCalcR.rows || []) kvMap[row.key] = row.value;
    const weekMode = String(kvMap.salary_calc_week_mode || "").trim() === "fixed" ? "fixed" : "workdays";
    const weekFixed = Number.isFinite(Number(kvMap.salary_calc_week_fixed)) ? Math.trunc(Number(kvMap.salary_calc_week_fixed)) : 5;
    const monthMode = String(kvMap.salary_calc_month_mode || "").trim() === "fixed" ? "fixed" : "workdays";
    const monthFixed = Number.isFinite(Number(kvMap.salary_calc_month_fixed)) ? Math.trunc(Number(kvMap.salary_calc_month_fixed)) : 30;
    const attendanceMode = String(kvMap.salary_calc_attendance_mode || "").trim() === "all_segments" ? "all_segments" : "first_last";
    const salaryCalcDefaultConfig = { weekMode, weekFixed, monthMode, monthFixed, attendanceMode };
    const terminalEventTimezoneOffsetHoursRaw = Number(kvMap.terminal_event_timezone_offset_hours);
    const terminalEventTimezoneOffsetHours = Number.isFinite(terminalEventTimezoneOffsetHoursRaw)
      ? Math.max(-12, Math.min(14, terminalEventTimezoneOffsetHoursRaw))
      : 5;
    const salaryPolicy = {
      enabled: String(kvMap.salary_policy_enabled || "1").trim() !== "0",
      latePerMinute: Number.isFinite(Number(kvMap.salary_policy_late_per_minute))
        ? Math.max(0, Math.trunc(Number(kvMap.salary_policy_late_per_minute)))
        : 1000,
      bonusPerMinute: Number.isFinite(Number(kvMap.salary_policy_bonus_per_minute))
        ? Math.max(0, Math.trunc(Number(kvMap.salary_policy_bonus_per_minute)))
        : 500,
      bonusGraceMinutes: Number.isFinite(Number(kvMap.salary_policy_bonus_grace_minutes))
        ? Math.max(0, Math.trunc(Number(kvMap.salary_policy_bonus_grace_minutes)))
        : 30,
      lateGraceMinutes: Number.isFinite(Number(kvMap.salary_policy_late_grace_minutes))
        ? Math.max(0, Math.trunc(Number(kvMap.salary_policy_late_grace_minutes)))
        : 5,
      maxDailyFine: Number.isFinite(Number(kvMap.salary_policy_max_daily_fine))
        ? Math.max(0, Math.trunc(Number(kvMap.salary_policy_max_daily_fine)))
        : 50000,
    };
    let salaryPolicyEmployeeOverrides = {};
    try {
      const raw = String(kvMap.salary_policy_employee_overrides || "").trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") salaryPolicyEmployeeOverrides = parsed;
      }
    } catch {}

    const salaryCalcConfigsByFilial = {};
    for (const row of adminSalaryCalcR.rows || []) {
      const wMode = String(row.week_mode || "").trim() === "fixed" ? "fixed" : "workdays";
      const wFixed = Number.isFinite(Number(row.week_fixed)) ? Math.trunc(Number(row.week_fixed)) : weekFixed;
      const mMode = String(row.month_mode || "").trim() === "fixed" ? "fixed" : "workdays";
      const mFixed = Number.isFinite(Number(row.month_fixed)) ? Math.trunc(Number(row.month_fixed)) : monthFixed;
      const aMode = String(row.attendance_mode || "").trim() === "all_segments" ? "all_segments" : attendanceMode;
      salaryCalcConfigsByFilial[row.filial] = {
        weekMode: wMode,
        weekFixed: wFixed,
        monthMode: mMode,
        monthFixed: mFixed,
        attendanceMode: aMode,
      };
    }

    let adminFilials = [];
    if (userRole === "admin") {
      adminFilials = (adminFilialsR.rows || []).map((r) => r.filial).filter((x) => x != null);
    }

    res.json({
      userRole,
      me: { employeeId: myEmployeeId },
      adminSubscription,
      adminSubscriptionMessage: adminSubscriptionMessage || "",
      salaryCalcDefaultConfig,
      terminalEventTimezoneOffsetHours,
      salaryPolicy,
      salaryPolicyEmployeeOverrides,
      salaryCalcConfigsByFilial,
      adminFilials,
      employees: empR.rows.map(rowToEmployee),
      attendanceRecords: attR.rows.map(rowToAttendance),
      salaryPayments: (payR?.rows || []).map(rowToSalaryPayment),
      salaryAdjustments: (adjR?.rows || []).map(rowToSalaryAdjustment),
      roleSalaries,
      employeeSalaryOverrides,
      theme,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/employees", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    if (req.auth?.role === "admin") {
      return res.status(403).json({ error: "Hodimlar faqat terminaldan yuklanadi" });
    }
    const {
      name,
      role,
      filial = "Asosiy filial",
      shiftStart = "09:00",
      shiftEnd = "18:00",
      weeklySchedule = null,
    } = req.body || {};
    if (!name || !role) {
      return res.status(400).json({ error: "name va role majburiy" });
    }
    const filialVal = String(filial).trim() || "Asosiy filial";
    const wsJson = weeklySchedule != null ? JSON.stringify(weeklySchedule) : null;
    const ownerAdminId = req.auth?.role === "admin" ? req.auth?.sub : null;
    const { rows } = await pool.query(
      `INSERT INTO employees (admin_id, name, role, filial, shift_start, shift_end, weekly_schedule)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, admin_id, name, role, filial, shift_start, shift_end, weekly_schedule`,
      [ownerAdminId, String(name).trim(), String(role).trim(), filialVal, shiftStart, shiftEnd, wsJson]
    );
    res.status(201).json(rowToEmployee(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.patch("/employees/:id", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });

    const body = req.body || {};
    const scopeWhere = req.auth?.role === "admin" ? "AND admin_id = $2" : "";
    const params = req.auth?.role === "admin" ? [id, req.auth?.sub] : [id];
    const cur = await pool.query(
      `SELECT id, admin_id, name, role, filial, shift_start, shift_end, weekly_schedule, access_card_no FROM employees WHERE id = $1 ${scopeWhere}`,
      params
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: "Topilmadi" });

    const prev = cur.rows[0];
    const name = body.name != null ? String(body.name).trim() : prev.name;
    const role = body.role != null ? String(body.role).trim() : prev.role;
    const filial =
      body.filial != null ? String(body.filial).trim() || "Asosiy filial" : String(prev.filial || "Asosiy filial");
    const shiftStart = body.shiftStart != null ? body.shiftStart : prev.shift_start;
    const shiftEnd = body.shiftEnd != null ? body.shiftEnd : prev.shift_end;
    let weeklySchedule = prev.weekly_schedule;
    if (body.weeklySchedule != null) {
      weeklySchedule = body.weeklySchedule;
    }

    const wsJson =
      weeklySchedule != null && typeof weeklySchedule === "object"
        ? JSON.stringify(weeklySchedule)
        : weeklySchedule;

    const { rows } = await pool.query(
      `UPDATE employees SET
        name = $1, role = $2, filial = $3, shift_start = $4, shift_end = $5,
        weekly_schedule = $6::jsonb, access_card_no = NULL
       WHERE id = $7 ${req.auth?.role === "admin" ? "AND admin_id = $8" : ""}
       RETURNING id, admin_id, name, role, filial, shift_start, shift_end, weekly_schedule, access_card_no`,
      req.auth?.role === "admin"
        ? [name, role, filial, shiftStart, shiftEnd, wsJson, id, req.auth?.sub]
        : [name, role, filial, shiftStart, shiftEnd, wsJson, id]
    );
    res.json(rowToEmployee(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.delete("/employees/:id", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    const r = await pool.query(
      `DELETE FROM employees WHERE id = $1 ${req.auth?.role === "admin" ? "AND admin_id = $2" : ""}`,
      req.auth?.role === "admin" ? [id, req.auth?.sub] : [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Topilmadi" });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/attendance", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const { employeeId, date, checkIn } = req.body || {};
    const eid = Number(employeeId);
    if (!Number.isFinite(eid) || !date || !checkIn) {
      return res.status(400).json({ error: "employeeId, date, checkIn majburiy" });
    }
    let empShift;
    if (req.auth?.role === "admin") {
      empShift = await pool.query(
        `SELECT admin_id, shift_start, shift_end, weekly_schedule FROM employees WHERE id = $1 AND admin_id = $2`,
        [eid, req.auth?.sub]
      );
      if (empShift.rows.length === 0) return res.status(403).json({ error: "Ruxsat yo'q" });
    } else {
      empShift = await pool.query(
        `SELECT admin_id, shift_start, shift_end, weekly_schedule FROM employees WHERE id = $1`,
        [eid]
      );
      if (empShift.rows.length === 0) return res.status(404).json({ error: "Topilmadi" });
    }
    const checkOutVal = req.body.checkOut;
    const co =
      checkOutVal == null || String(checkOutVal).trim() === "" ? null : String(checkOutVal).trim();

    const adm = empShift.rows[0]?.admin_id ?? null;
    const grace = await fetchLateGraceForEmployee(pool, eid);
    const lateComputed = computeCheckInLateFlag(empShift.rows[0], date, String(checkIn).trim(), grace);

    const { rows } = await pool.query(
      `INSERT INTO employee_attendance (admin_id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot, check_in_filial, check_out_filial)
       VALUES ($1, $2, $3::date, $4, $5, $6, NULL, NULL, NULL, NULL)
       RETURNING id, employee_id, record_date, check_in, check_out, late, check_in_snapshot, check_out_snapshot, check_in_filial, check_out_filial`,
      [adm, eid, date, String(checkIn).trim(), co, lateComputed]
    );
    res.status(201).json(rowToAttendance(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.patch("/attendance/:id", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    const { checkOut } = req.body || {};
    if (checkOut == null) return res.status(400).json({ error: "checkOut majburiy" });
    const co = String(checkOut).trim();

    const { rows } = await pool.query(
      `UPDATE employee_attendance a
       SET check_out = $1
       FROM employees e
       WHERE a.id = $2 AND e.id = a.employee_id ${
         req.auth?.role === "admin" ? "AND e.admin_id = $3" : ""
       }
       RETURNING a.id, a.employee_id, a.record_date, a.check_in, a.check_out, a.late, a.check_in_snapshot, a.check_out_snapshot,
         a.check_in_filial, a.check_out_filial`,
      req.auth?.role === "admin" ? [co, id, req.auth?.sub] : [co, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Topilmadi" });
    res.json(rowToAttendance(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.post("/attendance/download-images", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const result = await batchDownloadPendingAttendanceSnapshots(pool, {
      role: req.auth?.role,
      adminSub: req.auth?.sub,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.put("/salary/roles", async (req, res) => {
  const client = await pool.connect();
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) {
      client.release();
      return;
    }
    const obj = req.body;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return res.status(400).json({ error: "JSON obyekt kutildi" });
    }
    await client.query("BEGIN");
    const scopeAdminId = req.auth?.role === "admin" ? req.auth?.sub : 0;
    await client.query(`DELETE FROM role_salaries WHERE admin_id = $1`, [scopeAdminId]);
    for (const [roleName, value] of Object.entries(obj)) {
      const r = String(roleName).trim();
      if (!r) continue;
      let type = "oy";
      let amt = 0;
      if (value != null && typeof value === "object" && !Array.isArray(value)) {
        const rawAmt = value.amount ?? value.salary ?? 0;
        const rawType = value.type ?? value.salary_type ?? "oy";
        const n = Number(rawAmt);
        amt = Number.isFinite(n) ? Math.trunc(n) : 0;
        const allowed = ["soat", "kun", "hafta", "oy"];
        type = allowed.includes(String(rawType).trim()) ? String(rawType).trim() : "oy";
      } else {
        const n = Number(value);
        amt = Number.isFinite(n) ? Math.trunc(n) : 0;
        type = "oy";
      }
      await client.query(
        `INSERT INTO role_salaries (admin_id, role_name, amount, salary_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT role_salaries_pkey
         DO UPDATE SET amount = EXCLUDED.amount, salary_type = EXCLUDED.salary_type`,
        [scopeAdminId, r, amt, type]
      );
    }
    await client.query("COMMIT");
    res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    client.release();
  }
});

api.put("/salary/overrides", async (req, res) => {
  const client = await pool.connect();
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) {
      client.release();
      return;
    }
    const obj = req.body;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return res.status(400).json({ error: "JSON obyekt kutildi" });
    }
    await client.query("BEGIN");
    const scopeAdminId = req.auth?.role === "admin" ? req.auth?.sub : null;
    if (scopeAdminId != null) {
      await client.query(
        `DELETE FROM employee_salary_overrides o USING employees e WHERE e.id = o.employee_id AND e.admin_id = $1`,
        [scopeAdminId]
      );
    } else {
      await client.query("DELETE FROM employee_salary_overrides");
    }
    for (const [key, value] of Object.entries(obj)) {
      const eid = Number.parseInt(key, 10);
      if (!Number.isFinite(eid)) continue;
      if (scopeAdminId != null) {
        const emp = await client.query(`SELECT id FROM employees WHERE id = $1 AND admin_id = $2`, [eid, scopeAdminId]);
        if (emp.rows.length === 0) continue;
      }
      let type = "oy";
      let n = 0;
      if (value != null && typeof value === "object" && !Array.isArray(value)) {
        const rawAmt = value.amount ?? value.salary ?? null;
        const rawType = value.type ?? value.salary_type ?? "oy";
        const nn = Number(rawAmt);
        n = Number.isFinite(nn) ? nn : NaN;
        const allowed = ["soat", "kun", "hafta", "oy"];
        type = allowed.includes(String(rawType).trim()) ? String(rawType).trim() : "oy";
      } else {
        const nn = Number(value);
        n = Number.isFinite(nn) ? nn : NaN;
      }
      if (!Number.isFinite(n)) continue;
      await client.query(
        `INSERT INTO employee_salary_overrides (employee_id, amount, salary_type) VALUES ($1, $2, $3)`,
        [eid, Math.trunc(n), type]
      );
    }
    await client.query("COMMIT");
    res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    client.release();
  }
});

api.post("/salary/payments", async (req, res) => {
  const client = await pool.connect();
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) {
      client.release();
      return;
    }
    const entriesIn = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (entriesIn.length === 0) return res.status(400).json({ error: "JSON obyekt kutildi" });
    const paidAtIn = req.body?.paidAt;
    const paidAt =
      paidAtIn && Number.isFinite(new Date(paidAtIn).getTime()) ? new Date(paidAtIn).toISOString() : new Date().toISOString();

    const inserted = [];
    const batchId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    await client.query("BEGIN");
    for (const item of entriesIn) {
      const eid = Number.parseInt(String(item?.employeeId ?? ""), 10);
      const date = String(item?.date ?? "").trim();
      const amount = Number(item?.amount);
      const note = item?.note == null ? "" : String(item.note);
      if (!Number.isFinite(eid) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0) {
        continue;
      }
      if (req.auth?.role === "admin") {
        const emp = await client.query(`SELECT id FROM employees WHERE id = $1 AND admin_id = $2`, [eid, req.auth?.sub]);
        if (emp.rows.length === 0) continue;
      }
      const r = await client.query(
        `INSERT INTO employee_salary_payments (employee_id, pay_date, amount, batch_id, created_by, paid_at, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (employee_id, pay_date) DO NOTHING
         RETURNING id, employee_id, pay_date, amount, batch_id, created_by, paid_at, note`,
        [eid, date, Math.trunc(amount), batchId, req.auth?.sub ?? null, paidAt, note]
      );
      if (r.rows.length > 0) inserted.push(rowToSalaryPayment(r.rows[0]));
    }
    await client.query("COMMIT");
    res.json({ inserted });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    client.release();
  }
});

api.post("/salary/adjustments", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const employeeId = Number.parseInt(String(req.body?.employeeId ?? ""), 10);
    const date = String(req.body?.date ?? "").trim();
    const rawKind = String(req.body?.kind ?? "").trim().toLowerCase();
    const kind = rawKind === "fine" || rawKind === "advance" || rawKind === "kpi" ? rawKind : "bonus";
    const source = String(req.body?.source ?? "").trim().toLowerCase() === "auto" ? "auto" : "manual";
    const amount = Number(req.body?.amount);
    const note = req.body?.note == null ? "" : String(req.body.note);
    if (!Number.isFinite(employeeId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Noto'g'ri qiymatlar" });
    }
    if (req.auth?.role === "admin") {
      const emp = await pool.query(`SELECT id FROM employees WHERE id = $1 AND admin_id = $2`, [employeeId, req.auth?.sub]);
      if (emp.rows.length === 0) return res.status(403).json({ error: "Ruxsat yo'q" });
    }
    const { rows } = await pool.query(
      `INSERT INTO employee_salary_adjustments (employee_id, adj_date, kind, amount, source, created_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, employee_id, adj_date, kind, amount, source, created_by, note, updated_at, deleted_at, created_at`,
      [employeeId, date, kind, Math.trunc(amount), source, req.auth?.sub ?? null, note]
    );
    res.status(201).json(rowToSalaryAdjustment(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.patch("/salary/adjustments/:id", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const id = Number.parseInt(String(req.params.id ?? ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    const amount = Number(req.body?.amount);
    const note = req.body?.note == null ? "" : String(req.body.note);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Noto'g'ri amount" });
    const { rows } = await pool.query(
      `UPDATE employee_salary_adjustments
       SET amount = $2, note = $3, updated_at = NOW()
       WHERE id = $1 ${
         req.auth?.role === "admin"
           ? "AND employee_id IN (SELECT id FROM employees WHERE admin_id = $4)"
           : ""
       }
       RETURNING id, employee_id, adj_date, kind, amount, source, created_by, note, updated_at, deleted_at, created_at`,
      req.auth?.role === "admin" ? [id, Math.trunc(amount), note, req.auth?.sub] : [id, Math.trunc(amount), note]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Topilmadi" });
    res.json(rowToSalaryAdjustment(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.delete("/salary/adjustments/:id", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const id = Number.parseInt(String(req.params.id ?? ""), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Noto'g'ri id" });
    await pool.query(
      `UPDATE employee_salary_adjustments
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 ${
         req.auth?.role === "admin"
           ? "AND employee_id IN (SELECT id FROM employees WHERE admin_id = $2)"
           : ""
       }`,
      req.auth?.role === "admin" ? [id, req.auth?.sub] : [id]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.put("/settings/theme", async (req, res) => {
  try {
    const theme = req.body?.theme;
    if (theme !== "light" && theme !== "dark") {
      return res.status(400).json({ error: "theme: light yoki dark" });
    }
    await pool.query(
      `INSERT INTO app_kv (key, value) VALUES ('theme', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [theme]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.put("/settings/salary-policy", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const latePerMinuteIn = Number(req.body?.latePerMinute);
    const bonusPerMinuteIn = Number(req.body?.bonusPerMinute);
    const bonusGraceMinutesIn = Number(req.body?.bonusGraceMinutes);
    const lateGraceMinutesIn = Number(req.body?.lateGraceMinutes);
    const maxDailyFineIn = Number(req.body?.maxDailyFine);
    const enabled = req.body?.enabled !== false;
    const latePerMinute = Number.isFinite(latePerMinuteIn) ? Math.max(0, Math.trunc(latePerMinuteIn)) : 1000;
    const bonusPerMinute = Number.isFinite(bonusPerMinuteIn) ? Math.max(0, Math.trunc(bonusPerMinuteIn)) : 500;
    const bonusGraceMinutes = Number.isFinite(bonusGraceMinutesIn) ? Math.max(0, Math.trunc(bonusGraceMinutesIn)) : 30;
    const lateGraceMinutes = Number.isFinite(lateGraceMinutesIn) ? Math.max(0, Math.trunc(lateGraceMinutesIn)) : 5;
    const maxDailyFine = Number.isFinite(maxDailyFineIn) ? Math.max(0, Math.trunc(maxDailyFineIn)) : 50000;
    const rawOverrides = req.body?.employeeOverrides;
    const employeeOverridesObj = rawOverrides && typeof rawOverrides === "object" ? rawOverrides : {};
    const employeeOverrides = {};
    for (const [k, v] of Object.entries(employeeOverridesObj)) {
      const key = String(k).trim();
      if (!key) continue;
      const lateGrace = Number.isFinite(Number(v?.lateGraceMinutes)) ? Math.max(0, Math.trunc(Number(v.lateGraceMinutes))) : lateGraceMinutes;
      const perMin = Number.isFinite(Number(v?.latePerMinute)) ? Math.max(0, Math.trunc(Number(v.latePerMinute))) : latePerMinute;
      const maxFine = Number.isFinite(Number(v?.maxDailyFine)) ? Math.max(0, Math.trunc(Number(v.maxDailyFine))) : maxDailyFine;
      employeeOverrides[key] = { lateGraceMinutes: lateGrace, latePerMinute: perMin, maxDailyFine: maxFine };
    }
    const items = [
      ["salary_policy_enabled", enabled ? "1" : "0"],
      ["salary_policy_late_per_minute", String(latePerMinute)],
      ["salary_policy_bonus_per_minute", String(bonusPerMinute)],
      ["salary_policy_bonus_grace_minutes", String(bonusGraceMinutes)],
      ["salary_policy_late_grace_minutes", String(lateGraceMinutes)],
      ["salary_policy_max_daily_fine", String(maxDailyFine)],
      ["salary_policy_employee_overrides", JSON.stringify(employeeOverrides)],
    ];
    for (const [key, value] of items) {
      await pool.query(
        `INSERT INTO app_kv (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.put("/settings/salary-calc", async (req, res) => {
  try {
    if (!requireSuperadmin(req, res)) return;
    const weekModeIn = req.body?.weekMode;
    const weekFixedIn = req.body?.weekFixed;
    const monthModeIn = req.body?.monthMode;
    const monthFixedIn = req.body?.monthFixed;
    const attendanceModeIn = req.body?.attendanceMode;

    const allowedModes = ["workdays", "fixed"];
    const weekMode = allowedModes.includes(String(weekModeIn)) ? String(weekModeIn) : "workdays";
    const monthMode = allowedModes.includes(String(monthModeIn)) ? String(monthModeIn) : "workdays";
    const attendanceMode = String(attendanceModeIn) === "all_segments" ? "all_segments" : "first_last";

    const weekFixed = Number.isFinite(Number(weekFixedIn)) ? Math.trunc(Number(weekFixedIn)) : 5;
    const monthFixed = Number.isFinite(Number(monthFixedIn)) ? Math.trunc(Number(monthFixedIn)) : 30;
    const safeWeekFixed = weekFixed > 0 ? weekFixed : 5;
    const safeMonthFixed = monthFixed > 0 ? monthFixed : 30;

    const items = [
      ["salary_calc_week_mode", weekMode],
      ["salary_calc_week_fixed", String(safeWeekFixed)],
      ["salary_calc_month_mode", monthMode],
      ["salary_calc_month_fixed", String(safeMonthFixed)],
      ["salary_calc_attendance_mode", attendanceMode],
    ];

    for (const [key, value] of items) {
      await pool.query(
        `INSERT INTO app_kv (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.put("/settings/salary-calc/filial", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const adminId = req.auth?.sub;
    if (!adminId) return res.status(403).json({ error: "Sessiya xatosi" });

    const filial = req.body?.filial;
    const weekModeIn = req.body?.weekMode;
    const weekFixedIn = req.body?.weekFixed;
    const monthModeIn = req.body?.monthMode;
    const monthFixedIn = req.body?.monthFixed;
    const attendanceModeIn = req.body?.attendanceMode;

    if (!filial) return res.status(400).json({ error: "filial majburiy" });
    const allowedModes = ["workdays", "fixed"];
    const weekMode = allowedModes.includes(String(weekModeIn)) ? String(weekModeIn) : "workdays";
    const monthMode = allowedModes.includes(String(monthModeIn)) ? String(monthModeIn) : "workdays";
    const attendanceMode = String(attendanceModeIn) === "all_segments" ? "all_segments" : "first_last";

    const weekFixed = Number.isFinite(Number(weekFixedIn)) ? Math.trunc(Number(weekFixedIn)) : 5;
    const monthFixed = Number.isFinite(Number(monthFixedIn)) ? Math.trunc(Number(monthFixedIn)) : 30;
    const safeWeekFixed = weekFixed > 0 ? weekFixed : 5;
    const safeMonthFixed = monthFixed > 0 ? monthFixed : 30;

    await pool.query(
      `INSERT INTO admin_salary_calc_configs (admin_id, filial, week_mode, week_fixed, month_mode, month_fixed, attendance_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (admin_id, filial) DO UPDATE SET
         week_mode = EXCLUDED.week_mode,
         week_fixed = EXCLUDED.week_fixed,
         month_mode = EXCLUDED.month_mode,
         month_fixed = EXCLUDED.month_fixed,
         attendance_mode = EXCLUDED.attendance_mode,
         updated_at = NOW()`,
      [adminId, String(filial), weekMode, safeWeekFixed, monthMode, safeMonthFixed, attendanceMode]
    );

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.put("/settings/terminal-timezone", async (req, res) => {
  try {
    const ok = await requireActiveAdminOrSuperadmin(req, res);
    if (!ok) return;
    const raw = Number(req.body?.offsetHours);
    const safe = Number.isFinite(raw) ? Math.max(-12, Math.min(14, raw)) : 5;
    await pool.query(
      `INSERT INTO app_kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ["terminal_event_timezone_offset_hours", String(safe)]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.use("/api", api);

const distDir = path.join(__dirname, "..", "dist");
const distIndexPath = path.join(distDir, "index.html");
if (fs.existsSync(distIndexPath)) {
  app.use(express.static(distDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(distIndexPath, (err) => next(err));
  });
} else {
  console.warn(
    "[frontend] dist/index.html yo‘q — loyihada `npm run build` ni ishga tushiring. Hozircha faqat /api va /uploads ishlaydi (sahifalar 404)."
  );
}

async function main() {
  await initSchema();
  assertJwtConfigured();
  await ensureDefaultAdmin();

  const { broadcast, attachToHttpServer } = createAttendanceBroadcaster(pool);
  setAttendanceBroadcastHub(broadcast);
  const server = http.createServer(app);
  attachToHttpServer(server);

  if (process.env.ENABLE_TERMINAL_POLL !== "0") {
    startTerminalEventPoller(pool, broadcast);
    console.log("[terminal] hodisalar sinxroni yoqilgan (TERMINAL_POLL_MS, ENABLE_TERMINAL_POLL=0 bilan o‘chirish)");
  }

  server.listen(PORT, () => {
    console.log(`Keldi API http://localhost:${PORT} (WebSocket /ws)`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
