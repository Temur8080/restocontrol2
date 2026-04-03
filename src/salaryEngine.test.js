import { describe, expect, it } from "vitest";
import { summarizeRemaining } from "./salaryEngine.js";

describe("salary engine", () => {
  it("keeps 3 days after paying 7 of 10", () => {
    const entries = [];
    for (let d = 1; d <= 10; d++) {
      entries.push({ date: `2026-03-${String(d).padStart(2, "0")}`, amount: 120000 });
    }
    const paymentsByDate = {};
    for (let d = 1; d <= 7; d++) {
      paymentsByDate[`2026-03-${String(d).padStart(2, "0")}`] = 120000;
    }
    const res = summarizeRemaining(entries, paymentsByDate);
    expect(res.days).toBe(3);
    expect(res.total).toBe(360000);
  });

  it("handles partial payment in a day", () => {
    const entries = [{ date: "2026-03-02", amount: 120000 }];
    const res = summarizeRemaining(entries, { "2026-03-02": 20000 });
    expect(res.days).toBe(1);
    expect(res.total).toBe(100000);
  });
});
