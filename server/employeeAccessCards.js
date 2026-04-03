/**
 * Terminal hodisalarini bazadagi hodim bilan faqat ism (normalizatsiya qilingan) bo'yicha bog'lash.
 * $1 = admin_id, $2 = normalizeEmployeeEventName() dan o'tkazilgan ism.
 */
export const employeeMatchByNormalizedNameSql = `
  e.admin_id = $1::int
  AND LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(e.name, '')), E'\\\\s+', ' ', 'g'))) = LOWER($2::text)
`;
