/**
 * Hikvision AccessControl hodisasida kirish/chiqish bo'yicha yumshoq aniqlash
 * (terminal turi HTTP da noto'g'ri tanlangan yoki bir xil IP bilan ikki qurilma).
 */

export function isCheckoutTerminalType(terminalType) {
  return String(terminalType || "").trim().toLowerCase() === "chiqish";
}

function collectEventText(ev) {
  if (!ev || typeof ev !== "object") return "";
  const keys = [
    "attendanceState",
    "AttendanceState",
    "accessType",
    "AccessType",
    "direction",
    "eventType",
    "subEventType",
    "currentEventType",
    "accessChannel",
    "label",
    "name",
    "description",
  ];
  const parts = [];
  for (const k of keys) {
    const v = ev[k];
    if (v != null && String(v).trim()) parts.push(String(v));
  }
  return parts.join(" ").toLowerCase();
}

/** Muhit: HIKVISION_EXIT_MINORS=102,103 */
function exitMinorSet() {
  const raw = String(process.env.HIKVISION_EXIT_MINORS || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const exitMinors = exitMinorSet();

export function isExitLikeAccessEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  const min = String(ev.minor ?? ev.Minor ?? "").trim();
  if (min && exitMinors.has(min)) return true;

  const s = collectEventText(ev);
  if (!s.trim()) return false;
  if (/(checkout|check-out|check_out|chiqish|ketish|leave|goout|go-out|outdoor|exit|\bout\b)/i.test(s))
    return true;
  return false;
}

export function isInLikeAccessEvent(ev) {
  if (!ev || typeof ev !== "object") return false;
  const s = collectEventText(ev);
  if (!s.trim()) return false;
  if (/(checkin|check-in|check_in|kirish|entry|enter|\bin\b)/i.test(s)) return true;
  return false;
}

/** HTTP so'rovda birinchi hodisadan yo'nalish (bir nechta terminalni ajratish uchun). */
export function directionHintFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return "";
  for (const ev of events) {
    if (isExitLikeAccessEvent(ev)) return "out";
  }
  for (const ev of events) {
    if (isInLikeAccessEvent(ev)) return "in";
  }
  return "";
}
