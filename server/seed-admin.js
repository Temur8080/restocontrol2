import bcrypt from "bcryptjs";
import { pool } from "./db.js";

export async function ensureDefaultAdmin() {
  const username = String(process.env.ADMIN_USERNAME || "admin").trim() || "admin";
  const password = String(process.env.ADMIN_PASSWORD || "admin123").trim();

  const force =
    process.env.ADMIN_FORCE_RESET === "1" ||
    process.env.ADMIN_FORCE_RESET === "true" ||
    process.env.ADMIN_FORCE_RESET === "yes";

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);

  const hash = await bcrypt.hash(password, 10);

  if (rows[0].c > 0) {
    if (!force) return;
    const upd = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           role = 'superadmin',
           employee_id = NULL
       WHERE username = $2`,
      [hash, username]
    );
    if (upd.rowCount === 0) {
      await pool.query(
        `INSERT INTO users (username, password_hash, role, employee_id) VALUES ($1, $2, 'superadmin', NULL)`,
        [username, hash]
      );
    }
    return;
  }

  await pool.query(
    `INSERT INTO users (username, password_hash, role, employee_id)
     VALUES ($1, $2, 'superadmin', NULL)`,
    [username, hash]
  );

  console.warn(
    `Birinchi superadmin yaratildi: login="${username}". ADMIN_FORCE_RESET ni keyin olib tashlang.`
  );
}
