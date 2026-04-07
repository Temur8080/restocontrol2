import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { localeToBcp47, translate, capitalizeLocaleFirst } from "./i18n/index.js";

function parseYearMonth(ym) {
  const parts = String(ym || "").split("-");
  const y = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return { y, m };
}

function formatYearMonth(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

function localYearMonth() {
  const d = new Date();
  return formatYearMonth(d.getFullYear(), d.getMonth() + 1);
}

function localTodayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addMonthsYm(ym, delta) {
  const p = parseYearMonth(ym);
  if (!p) return localYearMonth();
  const d = new Date(p.y, p.m - 1 + delta, 1);
  return formatYearMonth(d.getFullYear(), d.getMonth() + 1);
}

function formatMonthLabel(ym, localeCode) {
  const p = parseYearMonth(ym);
  if (!p) return String(ym || "");
  const d = new Date(p.y, p.m - 1, 1);
  const raw = d.toLocaleDateString(localeToBcp47(localeCode), { month: "long", year: "numeric" });
  return capitalizeLocaleFirst(raw, localeCode);
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

/** Monday = 0 … Sunday = 6 */
function weekdayMon0(y, m, day) {
  const w = new Date(y, m - 1, day).getDay();
  return (w + 6) % 7;
}

function splitWeekdays(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function eachDateStrInMonth(yearMonth) {
  const parts = String(yearMonth).split("-");
  const y = Number.parseInt(parts[0], 10);
  const m = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    out.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return out;
}

function clampRangeToMonth(ym, fromYmd, toYmd) {
  const days = eachDateStrInMonth(ym);
  if (days.length === 0) return { from: `${ym}-01`, to: `${ym}-01` };
  const first = days[0];
  const last = days[days.length - 1];
  let from =
    fromYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(fromYmd)) ? String(fromYmd).slice(0, 10) : first;
  let to = toYmd && /^\d{4}-\d{2}-\d{2}$/.test(String(toYmd)) ? String(toYmd).slice(0, 10) : last;
  if (from < first || from > last) from = first;
  if (to < first || to > last) to = last;
  if (from > to) {
    const s = from;
    from = to;
    to = s;
  }
  return { from, to };
}

/**
 * @param {object} props
 * @param {"month" | "range"} [props.variant]
 * @param {string} props.value YYYY-MM
 * @param {(ym: string) => void} [props.onChange] variant month
 * @param {string} [props.rangeFrom] YYYY-MM-DD
 * @param {string} [props.rangeTo] YYYY-MM-DD
 * @param {(p: { month: string, from: string, to: string }) => void} [props.onRangeCommit]
 */
export function ReportMonthPicker({
  variant = "month",
  value,
  onChange,
  rangeFrom,
  rangeTo,
  onRangeCommit,
  locale,
  ariaLabel,
  dayAmounts,
  className = "",
  formatDayAmount,
}) {
  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => (parseYearMonth(value) ? value : localYearMonth()));
  const [popoverBox, setPopoverBox] = useState({ top: 0, left: 0, width: 320 });
  const [selFrom, setSelFrom] = useState("");
  const [selTo, setSelTo] = useState("");
  const [rangeAnchor, setRangeAnchor] = useState(null);

  const loc = locale || "uz";
  const labels = useMemo(
    () => ({
      apply: translate(loc, "report.calendarApply"),
      clear: translate(loc, "report.calendarClear"),
      prev: translate(loc, "report.prevMonthAria"),
      next: translate(loc, "report.nextMonthAria"),
      monthSelect: translate(loc, "report.calendarMonthAria"),
      yearSelect: translate(loc, "report.calendarYearAria"),
      weekdays: splitWeekdays(translate(loc, "report.calendarWeekdays")),
      rangeHint: translate(loc, "report.calendarRangeHint"),
    }),
    [loc]
  );

  useEffect(() => {
    if (open) {
      setDraft(parseYearMonth(value) ? value : localYearMonth());
    }
  }, [open, value]);

  useEffect(() => {
    if (!open || variant !== "range") return;
    const days = eachDateStrInMonth(draft);
    if (!days.length) return;
    const first = days[0];
    const last = days[days.length - 1];
    if (draft === value) {
      const c = clampRangeToMonth(draft, rangeFrom, rangeTo);
      setSelFrom(c.from);
      setSelTo(c.to);
    } else {
      setSelFrom(first);
      setSelTo(last);
    }
    setRangeAnchor(null);
  }, [open, draft, variant, value, rangeFrom, rangeTo]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const repositionPopover = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 10;
    const maxW = Math.min(320, window.innerWidth - margin * 2);
    let left = rect.right - maxW;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - maxW));
    let top = rect.bottom + margin;
    const pop = popoverRef.current;
    const h = pop?.offsetHeight ?? 400;
    if (top + h > window.innerHeight - margin) {
      top = rect.top - h - margin;
    }
    if (top < margin) top = margin;
    setPopoverBox({ top, left, width: maxW });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    repositionPopover();
    const rafId = requestAnimationFrame(() => repositionPopover());
    window.addEventListener("resize", repositionPopover);
    window.addEventListener("scroll", repositionPopover, true);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", repositionPopover);
      window.removeEventListener("scroll", repositionPopover, true);
    };
  }, [open, draft, repositionPopover, selFrom, selTo, rangeAnchor]);

  const parsed = parseYearMonth(draft) || parseYearMonth(localYearMonth());
  const viewY = parsed.y;
  const viewM = parsed.m;
  const dim = daysInMonth(viewY, viewM);
  const lead = weekdayMon0(viewY, viewM, 1);

  const monthNames = useMemo(() => {
    const lc = locale || "uz";
    const l = localeToBcp47(lc);
    return Array.from({ length: 12 }, (_, i) => {
      const raw = new Date(2020, i, 1).toLocaleDateString(l, { month: "long" });
      return capitalizeLocaleFirst(raw, lc);
    });
  }, [locale]);

  const years = useMemo(() => {
    const cy = new Date().getFullYear();
    const list = [];
    for (let y = cy - 10; y <= cy + 8; y++) list.push(y);
    return list;
  }, []);

  const fmtSub = useCallback(
    (n) => {
      if (typeof formatDayAmount === "function") return formatDayAmount(n);
      const l = localeToBcp47(locale || "uz");
      return `${Math.trunc(n).toLocaleString(l)}so'm`;
    },
    [formatDayAmount, locale]
  );

  const apply = () => {
    if (variant === "range") {
      const days = eachDateStrInMonth(draft);
      if (!days.length) {
        setOpen(false);
        return;
      }
      const from = selFrom || days[0];
      const to = selTo || days[days.length - 1];
      onRangeCommit?.({ month: draft, from, to });
    } else {
      onChange?.(draft);
    }
    setOpen(false);
  };

  const clear = () => {
    const ym = parseYearMonth(value) ? value : localYearMonth();
    setDraft(ym);
    if (variant === "range") {
      const c = clampRangeToMonth(ym, rangeFrom, rangeTo);
      setSelFrom(c.from);
      setSelTo(c.to);
      setRangeAnchor(null);
    }
    setOpen(false);
  };

  const handleDayPointerDown = (dateStr) => {
    if (variant !== "range") return;
    if (!rangeAnchor) {
      setRangeAnchor(dateStr);
      setSelFrom(dateStr);
      setSelTo(dateStr);
    } else {
      const a = rangeAnchor <= dateStr ? rangeAnchor : dateStr;
      const b = rangeAnchor <= dateStr ? dateStr : rangeAnchor;
      setSelFrom(a);
      setSelTo(b);
      setRangeAnchor(null);
    }
  };

  const setMonth = (m) => {
    setDraft(formatYearMonth(viewY, m));
  };

  const setYear = (y) => {
    setDraft(formatYearMonth(y, viewM));
  };

  const weekdays =
    labels.weekdays.length === 7 ? labels.weekdays : ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];

  return (
    <div className={`report-month-picker ${open ? "report-month-picker--open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`report-month-picker-trigger ${className}`.trim()}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="report-month-picker-trigger-label">
          {formatMonthLabel(parseYearMonth(value) ? value : localYearMonth(), locale)}
        </span>
        <span className="report-month-picker-trigger-chevron" aria-hidden />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          className="report-month-picker-popover"
          role="dialog"
          aria-label={ariaLabel}
          style={{
            position: "fixed",
            top: popoverBox.top,
            left: popoverBox.left,
            width: popoverBox.width,
            zIndex: 6000,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="report-month-picker-head">
            <button
              type="button"
              className="report-month-picker-nav"
              aria-label={labels.prev}
              onClick={() => setDraft((d) => addMonthsYm(d, -1))}
            >
              <ChevronLeft size={18} strokeWidth={2} />
            </button>
            <div className="report-month-picker-selects">
              <select
                className="report-month-picker-select"
                aria-label={labels.monthSelect}
                value={viewM}
                onChange={(e) => setMonth(Number(e.target.value))}
              >
                {monthNames.map((name, i) => (
                  <option key={i} value={i + 1}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                className="report-month-picker-select"
                aria-label={labels.yearSelect}
                value={viewY}
                onChange={(e) => setYear(Number(e.target.value))}
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="report-month-picker-nav"
              aria-label={labels.next}
              onClick={() => setDraft((d) => addMonthsYm(d, 1))}
            >
              <ChevronRight size={18} strokeWidth={2} />
            </button>
          </div>

          {variant === "range" ? (
            <p className="report-month-picker-range-hint">{labels.rangeHint}</p>
          ) : null}

          <div className="report-month-picker-weekdays">
            {weekdays.map((w) => (
              <span key={w} className="report-month-picker-wd">
                {w}
              </span>
            ))}
          </div>
          <div className="report-month-picker-grid">
            {Array.from({ length: lead }, (_, i) => (
              <div key={`pad-${i}`} className="report-month-picker-cell report-month-picker-cell--pad" />
            ))}
            {Array.from({ length: dim }, (_, i) => {
              const day = i + 1;
              const dateStr = `${viewY}-${String(viewM).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const amt = dayAmounts?.[dateStr];
              const showAmt = amt != null && Number(amt) > 0;
              const isToday = dateStr === localTodayYmd();
              const inRange =
                variant === "range" &&
                selFrom &&
                selTo &&
                dateStr >= selFrom &&
                dateStr <= selTo;
              const isRangeStart = variant === "range" && dateStr === selFrom;
              const isRangeEnd = variant === "range" && dateStr === selTo && selFrom !== selTo;
              const isSinglePick =
                variant === "range" && selFrom && selTo && selFrom === selTo && dateStr === selFrom;
              const inner = (
                <>
                  <span className="report-month-picker-daynum">{day}</span>
                  {showAmt ? (
                    <span className="report-month-picker-amount" title={fmtSub(amt)}>
                      {fmtSub(amt)}
                    </span>
                  ) : null}
                </>
              );
              return (
                <div
                  key={dateStr}
                  className={`report-month-picker-cell${isToday ? " report-month-picker-cell--today" : ""}${
                    inRange ? " report-month-picker-cell--in-range" : ""
                  }${isRangeStart || isSinglePick ? " report-month-picker-cell--range-from" : ""}${
                    isRangeEnd ? " report-month-picker-cell--range-to" : ""
                  }${variant === "range" ? " report-month-picker-cell--clickable" : ""}`}
                >
                  {variant === "range" ? (
                    <button
                      type="button"
                      className="report-month-picker-daybtn"
                      aria-pressed={inRange}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDayPointerDown(dateStr);
                      }}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="report-month-picker-day-static">{inner}</div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="report-month-picker-footer">
            <button type="button" className="report-month-picker-btn report-month-picker-btn--secondary" onClick={clear}>
              {labels.clear}
            </button>
            <button type="button" className="report-month-picker-btn report-month-picker-btn--primary" onClick={apply}>
              {labels.apply}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
