/**
 * Normalizatsiyalangan ism bo‘yicha hodim (hodim-nazorati: birinchi hodisa bilan ro‘yxatga tushish).
 * $1 = admin_id, $2 = normalizeEmployeeEventName() dan o‘tgan ism.
 */
export const employeeMatchByNormalizedNameSql = `
  e.admin_id = $1::int
  AND LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(e.name, '')), E'\\\\s+', ' ', 'g'))) = LOWER($2::text)
`;

/**
 * Normalizatsiyalangan ism bo‘yicha hodim (admin + filial kesimida).
 * $1 = admin_id, $2 = normalizeEmployeeEventName() dan o‘tgan ism, $3 = filial.
 */
export const employeeMatchByNormalizedNameAndFilialSql = `
  e.admin_id = $1::int
  AND (
    COALESCE(NULLIF(TRIM(e.filial), ''), 'Asosiy filial') = COALESCE(NULLIF(TRIM($3::text), ''), 'Asosiy filial')
    OR COALESCE(NULLIF(TRIM(e.filial), ''), 'Asosiy filial') = '*'
  )
  AND LOWER(TRIM(REGEXP_REPLACE(TRIM(COALESCE(e.name, '')), E'\\\\s+', ' ', 'g'))) = LOWER($2::text)
`;

/**
 * Terminal hodisa kaliti (employeeNoString / cardNo) ↔ employees.access_card_no.
 * $1 = admin_id, $2 = terminaldan kelgan qator (trim). Raqamli bo‘lsa bosh nol farqi yo‘q.
 */
export const employeeMatchByAccessCardSql = `
  e.admin_id = $1::int
  AND COALESCE(NULLIF(TRIM(e.access_card_no), ''), '') <> ''
  AND (
    LOWER(TRIM(COALESCE(e.access_card_no, ''))) = LOWER(TRIM($2::text))
    OR (
      TRIM(COALESCE(e.access_card_no, '')) ~ '^[0-9]+$'
      AND TRIM($2::text) ~ '^[0-9]+$'
      AND TRIM(COALESCE(e.access_card_no, ''))::bigint = TRIM($2::text)::bigint
    )
  )
`;
