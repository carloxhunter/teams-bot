import { env } from "cloudflare:test";
import { vi } from "vitest";
import config from "../../config.example.js";

export const WEBHOOK = "https://webhook.test/hook?sig=SECRET-SIG-123";
export const SECRET = "SECRET-SIG-123";

// Clears mutable tables (holidays are left as seeded by migrations unless a test clears them).
export async function resetDb() {
  for (const table of ["days", "weeks", "meta", "vacations", "participants"]) {
    try {
      await env.DB.exec(`DELETE FROM ${table};`);
    } catch (error) {
      if (!/no such table/i.test(String(error.message) + String(error.cause?.message))) throw error;
    }
  }
}

export async function seedParticipants(participants = config.participants) {
  for (const [position, { id, name }] of participants.entries()) {
    await env.DB.prepare("INSERT INTO participants (id, name, position, active) VALUES (?, ?, ?, 1)")
      .bind(id, name, position)
      .run();
  }
}

export async function addHoliday(date, name = "Test holiday") {
  await env.DB.prepare("INSERT OR REPLACE INTO holidays (date, name) VALUES (?, ?)").bind(date, name).run();
}

export async function dayRow(date) {
  return env.DB.prepare("SELECT * FROM days WHERE date = ?").bind(date).first();
}

export async function count(table) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
}

// Replaces globalThis.fetch with a recorder. `respond(call)` returns a Response or throws.
export function mockFetch(respond = () => new Response("ok", { status: 200 })) {
  const calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body;
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {}
    calls.push({ url, method: init?.method ?? "GET", body });
    return respond({ url, body });
  });
  return calls;
}

export const at = (iso) => ({ scheduledTime: Date.parse(iso), cron: "0 12 * * 1-5" });

export function workerEnv(overrides = {}) {
  return {
    DB: env.DB,
    TEAMS_WEBHOOK_URL: env.TEAMS_WEBHOOK_URL,
    TIME_ZONE: env.TIME_ZONE,
    ANNOUNCEMENT_TIME: env.ANNOUNCEMENT_TIME,
    ANNOUNCEMENT_LAST_TRY: env.ANNOUNCEMENT_LAST_TRY,
    ...overrides,
  };
}

export function loggedText(spy) {
  return spy.mock.calls
    .flat()
    .map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack} ${a.cause ?? ""}` : typeof a === "string" ? a : JSON.stringify(a)))
    .join("\n");
}
