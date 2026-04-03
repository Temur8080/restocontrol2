export function computeRemainingDaily(entries, paymentsByDate = {}) {
  const out = [];
  for (const item of entries || []) {
    const date = String(item?.date || "");
    const amount = Number(item?.amount);
    if (!date || !Number.isFinite(amount) || amount <= 0) continue;
    const paid = Number(paymentsByDate[date] || 0);
    const remaining = Math.max(0, Math.trunc(amount) - Math.max(0, Math.trunc(paid)));
    out.push({ date, amount: Math.trunc(amount), paid: Math.max(0, Math.trunc(paid)), remaining });
  }
  return out;
}

export function summarizeRemaining(entries, paymentsByDate = {}) {
  const daily = computeRemainingDaily(entries, paymentsByDate);
  let total = 0;
  let days = 0;
  for (const d of daily) {
    if (d.remaining > 0) {
      total += d.remaining;
      days += 1;
    }
  }
  return { total, days, daily };
}
