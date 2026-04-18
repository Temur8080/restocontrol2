import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const pool = new pg.Pool({
  user: process.env.DATABASE_USER || "restouser",
  password: process.env.DATABASE_PASSWORD,
  host: process.env.DATABASE_HOST || "localhost",
  port: Number(process.env.DATABASE_PORT) || 5432,
  database: process.env.DATABASE_NAME || "restocontrol_db",
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      filial TEXT NOT NULL DEFAULT 'Asosiy filial',
      shift_start TEXT NOT NULL DEFAULT '09:00',
      shift_end TEXT NOT NULL DEFAULT '18:00',
      weekly_schedule JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS employee_attendance (
      id BIGSERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      record_date DATE NOT NULL,
      check_in TEXT NOT NULL,
      check_out TEXT,
      late BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_employee_attendance_emp_date ON employee_attendance(employee_id, record_date);

    CREATE TABLE IF NOT EXISTS role_salaries (
      admin_id INTEGER NOT NULL DEFAULT 0,
      role_name TEXT PRIMARY KEY,
      amount INTEGER NOT NULL DEFAULT 0,
      salary_type TEXT NOT NULL DEFAULT 'oy'
    );

    CREATE TABLE IF NOT EXISTS employee_salary_overrides (
      admin_id INTEGER REFERENCES users(id),
      employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      salary_type TEXT NOT NULL DEFAULT 'oy'
    );

    CREATE TABLE IF NOT EXISTS employee_salary_payments (
      id BIGSERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      pay_date DATE NOT NULL,
      amount INTEGER NOT NULL,
      batch_id TEXT,
      created_by INTEGER REFERENCES users(id),
      paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note TEXT,
      UNIQUE (employee_id, pay_date)
    );

    CREATE TABLE IF NOT EXISTS employee_salary_adjustments (
      id BIGSERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      adj_date DATE NOT NULL,
      kind TEXT NOT NULL,
      amount INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_by INTEGER REFERENCES users(id),
      note TEXT,
      updated_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_salary_calc_configs (
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filial TEXT NOT NULL,
      week_mode TEXT NOT NULL DEFAULT 'workdays',
      week_fixed INTEGER NOT NULL DEFAULT 5,
      month_mode TEXT NOT NULL DEFAULT 'workdays',
      month_fixed INTEGER NOT NULL DEFAULT 30,
      attendance_mode TEXT NOT NULL DEFAULT 'first_last',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (admin_id, filial)
    );

    CREATE TABLE IF NOT EXISTS admin_filial_map (
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filial TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (admin_id, filial)
    );

    CREATE TABLE IF NOT EXISTS terminals (
      id SERIAL PRIMARY KEY,
      terminal_name TEXT NOT NULL,
      admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      terminal_type TEXT NOT NULL DEFAULT 'Kirish',
      ip_address TEXT NOT NULL,
      login TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_kv (
      admin_id INTEGER REFERENCES users(id),
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      employee_id INTEGER REFERENCES employees(id),
      subscription_end TIMESTAMPTZ,
      subscription_amount INTEGER,
      subscription_notice_template TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_id INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_amount INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_notice_template TEXT;
    ALTER TABLE employees ADD COLUMN IF NOT EXISTS admin_id INTEGER;
    ALTER TABLE employee_attendance ADD COLUMN IF NOT EXISTS admin_id INTEGER;

    ALTER TABLE role_salaries ADD COLUMN IF NOT EXISTS salary_type TEXT NOT NULL DEFAULT 'oy';
    ALTER TABLE role_salaries ADD COLUMN IF NOT EXISTS admin_id INTEGER NOT NULL DEFAULT 0;
    UPDATE role_salaries SET admin_id = 0 WHERE admin_id IS NULL;
    ALTER TABLE role_salaries DROP CONSTRAINT IF EXISTS role_salaries_pkey;
    ALTER TABLE role_salaries ADD CONSTRAINT role_salaries_pkey PRIMARY KEY (admin_id, role_name);
    ALTER TABLE employee_salary_overrides ADD COLUMN IF NOT EXISTS salary_type TEXT NOT NULL DEFAULT 'oy';
    ALTER TABLE employee_salary_overrides ADD COLUMN IF NOT EXISTS admin_id INTEGER;
    ALTER TABLE employee_salary_payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE employee_salary_payments ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE employee_salary_payments ADD COLUMN IF NOT EXISTS batch_id TEXT;
    ALTER TABLE employee_salary_payments ADD COLUMN IF NOT EXISTS admin_id INTEGER;
    ALTER TABLE employee_salary_payments ADD COLUMN IF NOT EXISTS created_by INTEGER;
    ALTER TABLE employee_salary_adjustments ADD COLUMN IF NOT EXISTS admin_id INTEGER;
    ALTER TABLE employee_salary_adjustments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE employee_salary_adjustments ADD COLUMN IF NOT EXISTS created_by INTEGER;
    ALTER TABLE employee_salary_adjustments ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE employee_salary_adjustments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
    ALTER TABLE employee_salary_adjustments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE employee_salary_adjustments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE app_kv ADD COLUMN IF NOT EXISTS admin_id INTEGER;
    ALTER TABLE admin_salary_calc_configs ADD COLUMN IF NOT EXISTS attendance_mode TEXT NOT NULL DEFAULT 'first_last';

    CREATE INDEX IF NOT EXISTS idx_admin_salary_calc_configs_admin_id ON admin_salary_calc_configs(admin_id);
    CREATE INDEX IF NOT EXISTS idx_admin_filial_map_admin_id ON admin_filial_map(admin_id);
    CREATE INDEX IF NOT EXISTS idx_terminals_admin_id ON terminals(admin_id);
    ALTER TABLE terminals ADD COLUMN IF NOT EXISTS filial TEXT;
    CREATE INDEX IF NOT EXISTS idx_employees_admin_id ON employees(admin_id);
    CREATE INDEX IF NOT EXISTS idx_employee_attendance_admin_id ON employee_attendance(admin_id);
    CREATE INDEX IF NOT EXISTS idx_employee_salary_overrides_admin_id ON employee_salary_overrides(admin_id);
    CREATE INDEX IF NOT EXISTS idx_employee_salary_payments_admin_id ON employee_salary_payments(admin_id);
    CREATE INDEX IF NOT EXISTS idx_employee_salary_adjustments_admin_id ON employee_salary_adjustments(admin_id);
    CREATE INDEX IF NOT EXISTS idx_users_admin_id ON users(admin_id);
    CREATE INDEX IF NOT EXISTS idx_employee_salary_payments_emp_date ON employee_salary_payments(employee_id, pay_date);
    CREATE INDEX IF NOT EXISTS idx_employee_salary_adjustments_emp_date ON employee_salary_adjustments(employee_id, adj_date);

    ALTER TABLE employees ADD COLUMN IF NOT EXISTS access_card_no TEXT;
    ALTER TABLE employee_attendance ADD COLUMN IF NOT EXISTS check_in_snapshot TEXT;
    ALTER TABLE employee_attendance ADD COLUMN IF NOT EXISTS check_out_snapshot TEXT;
    ALTER TABLE employee_attendance ADD COLUMN IF NOT EXISTS check_in_filial TEXT;
    ALTER TABLE employee_attendance ADD COLUMN IF NOT EXISTS check_out_filial TEXT;

    CREATE TABLE IF NOT EXISTS terminal_poll_cursors (
      terminal_id INTEGER PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
      last_event_time TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS terminal_event_dedupe (
      terminal_id INTEGER NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (terminal_id, dedupe_key)
    );

    CREATE TABLE IF NOT EXISTS employee_terminal_keys (
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      terminal_id INTEGER NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
      terminal_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (terminal_id, terminal_key)
    );

    CREATE INDEX IF NOT EXISTS idx_employee_terminal_keys_employee_id
      ON employee_terminal_keys(employee_id);

    CREATE INDEX IF NOT EXISTS idx_terminal_event_dedupe_created ON terminal_event_dedupe (created_at);
  `);

  // admin + filial kesimida bir xil normalizatsiyalangan ism takrorlanmasin.
  // Oldindan dublikatlar bo'lsa migratsiya yiqilmasligi uchun avval tekshiramiz.
  const dupEmpName = await pool.query(
    `SELECT
       admin_id,
       COALESCE(NULLIF(TRIM(filial), ''), 'Asosiy filial') AS filial_norm,
       LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(name, '')), E'\\s+', ' ', 'g'))) AS name_norm,
       COUNT(*)::int AS cnt
     FROM employees
     GROUP BY admin_id, COALESCE(NULLIF(TRIM(filial), ''), 'Asosiy filial'),
              LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(name, '')), E'\\s+', ' ', 'g')))
     HAVING COUNT(*) > 1
     LIMIT 1`
  );
  if (dupEmpName.rows.length === 0) {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_admin_filial_normname
       ON employees (
         admin_id,
         COALESCE(NULLIF(TRIM(filial), ''), 'Asosiy filial'),
         LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(name, '')), E'\\s+', ' ', 'g')))
       )`
    );
  } else {
    console.warn(
      "[db] uq_employees_admin_filial_normname yaratilmadi: employees jadvalida admin+filial bo'yicha bir xil ism dublikatlari bor"
    );
  }

  const pkInfo = await pool.query(
    `SELECT array_agg(a.attname ORDER BY ord.n) AS cols
     FROM pg_constraint c
     JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS ord(attnum, n) ON TRUE
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ord.attnum
     WHERE c.conrelid = 'role_salaries'::regclass
       AND c.contype = 'p'
       AND c.conname = 'role_salaries_pkey'`
  );
  const cols = pkInfo.rows?.[0]?.cols || [];
  if (!(Array.isArray(cols) && cols.length === 2 && cols[0] === "admin_id" && cols[1] === "role_name")) {
    await pool.query(`ALTER TABLE role_salaries DROP CONSTRAINT IF EXISTS role_salaries_pkey`);
    await pool.query(`ALTER TABLE role_salaries ADD CONSTRAINT role_salaries_pkey PRIMARY KEY (admin_id, role_name)`);
  }
}

/**
 * app_kv: avvalgi global (faqat key PK) holatni har bir admin/superadmin uchun (admin_id, key) ga o‘tkazadi.
 * ensureDefaultAdmin() dan keyin chaqirilishi kerak — users jadvalida kamida bitta foydalanuvchi bo‘lganda.
 */
export async function migrateAppKvPerAdmin(pool) {
  console.log("[db] app_kv: server ishga tushishi bilan migratsiya tekshirilmoqda…");
  const client = await pool.connect();
  try {
    const pkCols = await client.query(`
      SELECT a.attname AS column_name
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON TRUE
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
      WHERE c.conrelid = 'app_kv'::regclass AND c.contype = 'p'
      ORDER BY u.ord
    `);
    const cols = pkCols.rows.map((r) => r.column_name);
    const pkSig = cols.join(",");
    if (cols.length === 0) {
      console.warn("[db] app_kv: primary key topilmadi — migratsiya o‘tkazilmadi.");
      return;
    }
    if (pkSig === "admin_id,key" || pkSig === "key,admin_id") {
      console.log("[db] app_kv: migratsiya kerak emas (har bir admin uchun PK allaqachon mavjud).");
      return;
    }
    if (pkSig !== "key") {
      console.warn("[db] app_kv: kutilmagan primary key:", cols);
      return;
    }

    console.log("[db] app_kv: eski global sxema (faqat key) topildi — avtomatik migratsiya boshlandi…");
    await client.query("BEGIN");

    const pkr = await client.query(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'app_kv' AND c.contype = 'p'
      LIMIT 1
    `);
    const pkeyName = pkr.rows[0]?.conname;
    if (pkeyName) {
      await client.query(`ALTER TABLE app_kv DROP CONSTRAINT ${quoteIdentPg(pkeyName)}`);
    }

    await client.query(`
      INSERT INTO app_kv (admin_id, key, value)
      SELECT u.id, g.key, g.value
      FROM users u
      CROSS JOIN (SELECT key, value FROM app_kv WHERE admin_id IS NULL) AS g
      WHERE u.role IN ('admin', 'superadmin')
        AND NOT EXISTS (
          SELECT 1 FROM app_kv e WHERE e.admin_id = u.id AND e.key = g.key
        )
    `);

    await client.query(`DELETE FROM app_kv WHERE admin_id IS NULL`);

    await client.query(`ALTER TABLE app_kv ALTER COLUMN admin_id SET NOT NULL`);

    await client.query(`
      ALTER TABLE app_kv
      ADD CONSTRAINT app_kv_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
    `).catch(() => {});

    await client.query(`ALTER TABLE app_kv ADD PRIMARY KEY (admin_id, key)`);

    await client.query("COMMIT");
    console.log("[db] app_kv: har bir admin uchun (admin_id, key) ga migratsiya qilindi");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[db] migrateAppKvPerAdmin:", e?.message || e);
  } finally {
    client.release();
  }
}

function quoteIdentPg(name) {
  const s = String(name || "").replace(/"/g, '""');
  return `"${s}"`;
}

/**
 * app_kv yozuvi: avvalo (admin_id, key), keyin global qoldiq (admin_id NULL, eski sxema).
 * INSERT duplicate (app_kv_pkey) bo‘lsa — bir xil key bo‘yicha mavjud qatorni yangilaymiz.
 */
export async function upsertAppKvRow(pool, adminId, key, value) {
  const aid = Number(adminId);
  if (!Number.isFinite(aid)) {
    throw new Error("app_kv: admin_id noto'g'ri");
  }
  const v = String(value);
  let r = await pool.query(`UPDATE app_kv SET value = $3 WHERE admin_id = $1 AND key = $2`, [aid, key, v]);
  if (r.rowCount > 0) return;

  r = await pool.query(
    `UPDATE app_kv SET admin_id = $1, value = $3 WHERE key = $2 AND admin_id IS NULL`,
    [aid, key, v]
  );
  if (r.rowCount > 0) return;

  try {
    await pool.query(`INSERT INTO app_kv (admin_id, key, value) VALUES ($1, $2, $3)`, [aid, key, v]);
  } catch (e) {
    if (e && e.code === "23505") {
      r = await pool.query(`UPDATE app_kv SET value = $3 WHERE admin_id = $1 AND key = $2`, [aid, key, v]);
      if (r.rowCount > 0) return;
      r = await pool.query(
        `UPDATE app_kv SET admin_id = $1, value = $3 WHERE key = $2 AND admin_id IS NULL`,
        [aid, key, v]
      );
      if (r.rowCount > 0) return;
    }
    throw e;
  }
}

export { pool };
