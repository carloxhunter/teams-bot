import { env } from "cloudflare:test";
import { expect, test } from "vitest";

test("H1: seeded Chilean holidays are valid, unique, 2026-2027 and include key dates", async () => {
  const { results } = await env.DB.prepare("SELECT date, name FROM holidays ORDER BY date").all();
  const dates = results.map((r) => r.date);
  expect(dates.length).toBeGreaterThan(0);
  for (const date of dates) {
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(date).toISOString().slice(0, 10)).toBe(date);
    expect(["2026", "2027"]).toContain(date.slice(0, 4));
  }
  expect(new Set(dates).size).toBe(dates.length);
  for (const key of ["2026-12-08", "2026-12-25", "2027-01-01"]) expect(dates).toContain(key);
});
