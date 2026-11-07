import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { validateConfig } from "../../src/rotation.js";
import { loadConfigD1, loadStateD1, saveStateD1 } from "../../src/d1-store.js";
import { count, resetDb } from "./helpers.js";

beforeEach(resetDb);

const fullState = () => ({
  version: 1,
  rotationStartDate: "2026-10-05",
  weeks: { "2026-10-12": "bruno", "2026-10-19": "ines" },
  days: {
    "2026-10-19": { presenter: "ines", week: "2026-10-19", order: ["ines", "bruno", "fabio"], status: "sent", sharingCompleted: true },
    "2026-10-20": { presenter: "bruno", order: ["fabio", "bruno"], status: "sending", sharingCompleted: false },
    "2026-10-21": { presenter: "fabio", week: "2026-10-19", order: ["fabio", "ines"], status: "pending" },
  },
});

describe("D1 store", () => {
  test("D1: empty DB loads an empty state", async () => {
    expect(await loadStateD1(env.DB)).toStrictEqual({ version: 1, weeks: {}, days: {} });
  });

  test("D1: save then load round-trips weeks, start date, optional fields and all statuses", async () => {
    const state = fullState();
    await saveStateD1(env.DB, state);
    expect(await loadStateD1(env.DB)).toStrictEqual(fullState());
    // Saving again (upsert) is stable.
    await saveStateD1(env.DB, state);
    expect(await loadStateD1(env.DB)).toStrictEqual(fullState());
  });

  test("D1: plan.vacations snapshots are not persisted", async () => {
    const state = fullState();
    state.days["2026-10-19"].vacations = [{ id: "ximena", end: "2026-10-30" }];
    await saveStateD1(env.DB, state);
    expect(await loadStateD1(env.DB)).toStrictEqual(fullState());
  });

  test("D2: an invalid state throws and writes nothing", async () => {
    const invalid = fullState();
    invalid.days["2026-10-20"].presenter = "nobody-in-order";
    await expect(saveStateD1(env.DB, invalid)).rejects.toThrow();
    expect(await count("days")).toBe(0);
    expect(await count("weeks")).toBe(0);
    expect(await count("meta")).toBe(0);
  });

  test("D2: an invalid save over existing data leaves the stored data intact", async () => {
    await saveStateD1(env.DB, fullState());
    const invalid = fullState();
    invalid.version = 2;
    invalid.days["2026-10-22"] = { presenter: "x", order: ["x"], status: "pending" };
    await expect(saveStateD1(env.DB, invalid)).rejects.toThrow();
    expect(await loadStateD1(env.DB)).toStrictEqual(fullState());
  });

  test.each([
    ["speaking_order is not JSON", "2026-10-19", "ines", "not json", "pending"],
    ["speaking_order is not an array", "2026-10-19", "ines", '{"a":1}', "pending"],
    ["presenter is not in the order", "2026-10-19", "ines", '["bruno"]', "pending"],
    ["date is invalid", "2026-02-30", "ines", '["ines"]', "pending"],
  ])("D2: corrupt row (%s) makes load throw and keeps the data", async (_label, date, presenter, order, status) => {
    await env.DB.prepare(
      "INSERT INTO days (date, week, presenter, speaking_order, status, sharing_completed) VALUES (?, NULL, ?, ?, ?, NULL)",
    ).bind(date, presenter, order, status).run();
    await expect(loadStateD1(env.DB)).rejects.toThrow();
    expect(await count("days")).toBe(1);
  });

  test("D3: loadConfigD1 returns active participants by position, vacations and holidays", async () => {
    await env.DB.exec("DELETE FROM holidays;");
    await env.DB.exec(
      [
        "INSERT INTO participants (id, name, position, active) VALUES ('c', 'Carla', 2, 1);",
        "INSERT INTO participants (id, name, position, active) VALUES ('a', 'Ana', 0, 1);",
        "INSERT INTO participants (id, name, position, active) VALUES ('x', 'Gone', 1, 0);",
        "INSERT INTO participants (id, name, position, active) VALUES ('b', 'Beto', 3, 1);",
        "INSERT INTO vacations (person_id, start_date, end_date) VALUES ('a', '2026-11-02', '2026-11-13');",
        "INSERT INTO vacations (person_id, start_date, end_date) VALUES ('b', '2026-12-01', '2026-12-01');",
        "INSERT INTO holidays (date, name) VALUES ('2026-12-08', 'Inmaculada');",
        "INSERT INTO holidays (date, name) VALUES ('2026-12-25', 'Navidad');",
      ].join("\n"),
    );
    const config = await loadConfigD1(env.DB, { timeZone: "America/Santiago", announcementTime: "09:00" });
    expect(config.participants).toStrictEqual([
      { id: "a", name: "Ana" },
      { id: "c", name: "Carla" },
      { id: "b", name: "Beto" },
    ]);
    expect(config.timeZone).toBe("America/Santiago");
    expect(config.announcementTime).toBe("09:00");
    expect(config.vacations).toStrictEqual([
      { personId: "a", start: "2026-11-02", end: "2026-11-13" },
      { personId: "b", start: "2026-12-01", end: "2026-12-01" },
    ]);
    expect([...config.holidays].sort()).toStrictEqual(["2026-12-08", "2026-12-25"]);
    const rest = { ...config };
    delete rest.holidays;
    expect(() => validateConfig(rest)).not.toThrow();
  });
});
