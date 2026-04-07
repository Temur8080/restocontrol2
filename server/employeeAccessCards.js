/**
 * Terminal hodisasi kaliti (Hikvision employeeNoString / cardNo) ↔ employees.access_card_no.
 * $1 = admin_id, $2 = terminaldan kelgan qator (trim). Raqamli bo'lsa bosh nol farqi yo'q.
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
