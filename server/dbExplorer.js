/**
 * Superadmin «Baza» bo‘limi: `public` sxemadagi barcha jadvallarni topish va umumiy SELECT uchun metadata.
 * SQL injection oldini olish uchun identifikatorlar tekshiriladi.
 * Bitta PK bo‘lsa — tahrirlash/o‘chirish; kompozit PK yoki PK yo‘q — faqat ko‘rish.
 */

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function assertSafeSqlIdentifier(name) {
  const s = String(name || "");
  if (!IDENT_RE.test(s)) {
    throw new Error("Noto'g'ri jadval yoki ustun nomi");
  }
  return s;
}

export function quoteIdent(name) {
  const s = assertSafeSqlIdentifier(name);
  return `"${s.replace(/"/g, '""')}"`;
}

function mapUdtToExplorerType(udt) {
  const u = String(udt || "").toLowerCase();
  if (u === "int2" || u === "int4") return "int";
  if (u === "int8") return "bigint";
  if (u === "float4" || u === "float8") return "float";
  if (u === "numeric") return "numeric";
  if (u === "bool") return "boolean";
  if (u === "jsonb" || u === "json") return "jsonb";
  if (u === "date") return "date";
  if (u === "timestamptz" || u === "timestamp") return "timestamptz";
  return "text";
}

/**
 * @param {import("pg").Pool} pool
 * @returns {Promise<string[]>}
 */
export async function listPublicBaseTables(pool) {
  const { rows } = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name ASC`
  );
  return rows.map((r) => String(r.table_name)).filter((n) => IDENT_RE.test(n));
}

/**
 * @param {import("pg").Pool} pool
 * @param {string} table
 * @returns {Promise<{ name: string, udt: string }[]>}
 */
export async function getPrimaryKeyColumns(pool, table) {
  assertSafeSqlIdentifier(table);
  const { rows } = await pool.query(
    `SELECT kcu.column_name, c.udt_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_schema = kcu.constraint_schema
       AND tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
     JOIN information_schema.columns c
       ON c.table_schema = tc.table_schema
       AND c.table_name = tc.table_name
       AND c.column_name = kcu.column_name
     WHERE tc.table_schema = 'public'
       AND tc.table_name = $1
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position ASC`,
    [table]
  );
  return rows.map((r) => ({
    name: String(r.column_name),
    udt: String(r.udt_name || ""),
  }));
}

/**
 * @param {import("pg").Pool} pool
 * @param {string} table
 */
export async function getTableColumnMeta(pool, table) {
  assertSafeSqlIdentifier(table);
  const { rows } = await pool.query(
    `SELECT column_name, udt_name, ordinal_position
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position ASC`,
    [table]
  );
  return rows.map((r) => ({
    name: String(r.column_name),
    udt: String(r.udt_name || ""),
  }));
}

/**
 * Static DB_TABLE_CONFIGda bo‘lmagan jadvallar uchun metadata.
 * Kamida bitta PK (yoki kompozit) bo‘lsa — readOnly: false, PK ustunlari editable emas.
 * PK umuman bo‘lmasa — readOnly: true.
 * @param {import("pg").Pool} pool
 * @param {string} table
 */
export async function buildDynamicReadOnlyTableConfig(pool, table) {
  assertSafeSqlIdentifier(table);
  const colsMeta = await getTableColumnMeta(pool, table);
  if (colsMeta.length === 0) return null;

  const pkCols = await getPrimaryKeyColumns(pool, table);
  const singlePk = pkCols.length === 1 ? pkCols[0] : null;
  const compositePk = pkCols.length > 1;
  const hasPk = pkCols.length > 0;
  const readOnly = !hasPk;
  const pkNameSet = new Set(pkCols.map((c) => c.name));

  const pkColumns = pkCols.map((col) => ({
    name: col.name,
    type: mapUdtToExplorerType(col.udt),
  }));

  const columns = {};
  for (const c of colsMeta) {
    assertSafeSqlIdentifier(c.name);
    const t = mapUdtToExplorerType(c.udt);
    const isPk = pkNameSet.has(c.name);
    columns[c.name] = {
      type: t,
      editable: !readOnly && !isPk,
      visible: true,
    };
  }

  const orderBy = pkCols[0]?.name || colsMeta[0].name;

  return {
    pk: singlePk ? { name: singlePk.name, type: mapUdtToExplorerType(singlePk.udt) } : null,
    pkColumns,
    orderBy,
    columns,
    readOnly,
    compositePk,
  };
}
