import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { toSql } from "../../scripts/migrate-to-d1.js";
import { loadConfigD1, loadStateD1 } from "../../src/d1-store.js";
import { count, resetDb } from "./helpers.js";

const config = {
  participants: [
    { id: "ohiggins", name: "O'Higgins" },
    { id: "ines", name: "Inés" },
    { id: "bruno", name: "Bruno" },
  ],
  timeZone: "America/Santiago",
  announcementTime: "09:00",
};
const state = {
  version: 1,
  rotationStartDate: "2026-10-05",
  weeks: { "2026-10-12": "bruno", "2026-10-19": "ines" },
  days: {
    "2026-10-19": { presenter: "ines", week: "2026-10-19", order: ["ines", "ohiggins", "bruno"], status: "sent", sharingCompleted: false },
    "2026-10-20": { presenter: "ohiggins", order: ["ohiggins", "bruno"], status: "pending" },
  },
};
const vacations = [{ personId: "bruno", start: "2026-11-02", end: "2026-11-06" }];

beforeEach(async () => {
  await resetDb();
});

describe("migration SQL", () => {
  test("M1: toSql output loads through exec and round-trips state, participants and vacations", async () => {
    const sql = toSql({ config, state, vacations });
    const lines = sql.split("\n").filter((line) => line.trim());
    expect(lines.every((line) => line.trim().endsWith(";"))).toBe(true);
    expect(sql).not.toMatch(/OR\s+(REPLACE|IGNORE)/i);
    expect(sql).toContain("O''Higgins");
    await env.DB.exec(sql);
    expect(await loadStateD1(env.DB)).toStrictEqual(state);
    const loaded = await loadConfigD1(env.DB, { timeZone: "America/Santiago", announcementTime: "09:00" });
    expect(loaded.participants).toStrictEqual(config.participants);
    expect(loaded.vacations).toStrictEqual(vacations);
  });

  test("M2: running the same SQL twice fails and leaves row counts unchanged", async () => {
    const sql = toSql({ config, state, vacations });
    await env.DB.exec(sql);
    const tables = ["participants", "vacations", "days", "weeks", "meta"];
    const before = {};
    for (const t of tables) before[t] = await count(t);
    await expect(env.DB.exec(sql)).rejects.toThrow();
    for (const t of tables) expect(await count(t), t).toBe(before[t]);
  });
});
