import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import bcrypt from "bcryptjs";
import { pool, initSchema } from "./db.js";

const rl = readline.createInterface({ input, output });

async function main() {
  console.log("Ma'lumotlar bazasi sxemasi tekshirilmoqda (jadval yo‘q bo‘lsa yaratiladi)...");
  await initSchema();
  console.log("OK.\n");

  const userIn = (await rl.question("Login [admin]: ")).trim();
  const username = userIn || "admin";

  const roleIn = (await rl
    .question('Role kiriting (superadmin/admin/hodim) [admin]: ')
    )
    .trim();
  const role =
    roleIn === "superadmin" || roleIn === "admin" || roleIn === "hodim" ? roleIn : "admin";

  let employeeId = null;
  if (role === "hodim") {
    const eidIn = (await rl.question("Employee ID (hodim jadvalidagi id): ")).trim();
    const eid = Number.parseInt(eidIn, 10);
    if (!Number.isFinite(eid)) {
      console.error("Employee ID raqam bo‘lishi kerak.");
      process.exitCode = 1;
      await rl.close();
      await pool.end();
      return;
    }
    const emp = await pool.query(`SELECT id FROM employees WHERE id = $1`, [eid]);
    if (emp.rows.length === 0) {
      console.error("Employee ID topilmadi. Avval hodimni yaratib oling.");
      process.exitCode = 1;
      await rl.close();
      await pool.end();
      return;
    }
    employeeId = eid;
  }

  const pass1 = await rl.question("Parol: ");
  const password = String(pass1).trim();
  if (!password) {
    console.error("Parol bo'sh bo'lmasin.");
    process.exitCode = 1;
    await rl.close();
    await pool.end();
    return;
  }

  const pass2 = await rl.question("Parolni qayta kiriting: ");
  if (String(pass2).trim() !== password) {
    console.error("Parollar mos kelmadi.");
    process.exitCode = 1;
    await rl.close();
    await pool.end();
    return;
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (username, password_hash, role, employee_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       employee_id = EXCLUDED.employee_id`,
    [username, hash, role, employeeId]
  );

  console.log(`\nTayyor: "${username}" (${role}) bilan brauzerdan kirishingiz mumkin.`);
  console.log("API ni ishga tushiring: npm run server yoki npm run dev:full\n");

  await rl.close();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await rl.close();
  try {
    await pool.end();
  } catch {
  }
  process.exit(1);
});
