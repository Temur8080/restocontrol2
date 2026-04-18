/**
 * app_kv: global defaultlar (admin_id NULL) + har bir foydalanuvchi (users.id) uchun alohida yozuvlar.
 * O‘qishda: avval shu user/admin ga tegishli, bo‘lmasa global.
 */

export async function appKvUpsertForUser(pool, userId, key, value) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) throw new Error("app_kv: userId noto‘g‘ri");
  const k = String(key || "").trim();
  if (!k) throw new Error("app_kv: key bo‘sh");
  await pool.query(`DELETE FROM app_kv WHERE admin_id = $1 AND key = $2`, [uid, k]);
  await pool.query(`INSERT INTO app_kv (admin_id, key, value) VALUES ($1, $2, $3)`, [uid, k, String(value)]);
}

export async function appKvSelectBestForUser(pool, userId, keys) {
  const uid = Number(userId);
  const arr = Array.isArray(keys) ? keys.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (arr.length === 0) return { rows: [] };
  if (!Number.isFinite(uid)) {
    const { rows } = await pool.query(`SELECT key, value FROM app_kv WHERE key = ANY($1::text[]) AND admin_id IS NULL`, [
      arr,
    ]);
    return { rows };
  }
  return pool.query(
    `SELECT DISTINCT ON (key) key, value
     FROM app_kv
     WHERE key = ANY($1::text[])
       AND (admin_id = $2 OR admin_id IS NULL)
     ORDER BY key, CASE WHEN admin_id = $2 THEN 0 ELSE 1 END`,
    [arr, uid]
  );
}

export async function appKvSelectSingleForUser(pool, userId, key) {
  const k = String(key || "").trim();
  if (!k) return { rows: [] };
  const uid = Number(userId);
  if (!Number.isFinite(uid)) {
    return pool.query(`SELECT value FROM app_kv WHERE key = $1 AND admin_id IS NULL LIMIT 1`, [k]);
  }
  return pool.query(
    `SELECT value FROM app_kv
     WHERE key = $1 AND (admin_id = $2 OR admin_id IS NULL)
     ORDER BY CASE WHEN admin_id = $2 THEN 0 ELSE 1 END
     LIMIT 1`,
    [k, uid]
  );
}
