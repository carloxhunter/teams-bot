import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../../src/worker/index.js";
import { addHoliday, at, dayRow, count, loggedText, mockFetch, resetDb, seedParticipants, SECRET, WEBHOOK, workerEnv } from "./helpers.js";

async function trigger(iso, environment = workerEnv()) {
  const ctx = createExecutionContext();
  await worker.scheduled(at(iso), environment, ctx);
  await waitOnExecutionContext(ctx);
}

const posts = (calls) => calls.filter((c) => c.url === WEBHOOK && c.method === "POST");

const originalConsoleError = console.error;
let errorLog;

beforeEach(async () => {
  await resetDb();
  await seedParticipants();
  // vi.spyOn(console, ...) does not yield a spy in the workerd pool: assign directly.
  // Keep our own reference: reading console.error back returns a bound wrapper, not the mock.
  errorLog = vi.fn();
  console.error = errorLog;
});

afterEach(() => {
  console.error = originalConsoleError;
});

describe("scheduled", () => {
  test("S1: summer weekday 09:00 local posts one Adaptive Card and saves the day as sent", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T12:00:00Z");
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].body.type).toBe("message");
    expect((await dayRow("2026-11-10")).status).toBe("sent");
  });

  test("S2: winter weekday posts at 13:00 UTC, not at 12:00 UTC", async () => {
    const calls = mockFetch();
    await trigger("2026-07-15T12:00:00Z");
    expect(posts(calls)).toHaveLength(0);
    await trigger("2026-07-15T13:00:00Z");
    expect(posts(calls)).toHaveLength(1);
  });

  test("S3: a later trigger the same day does not post again", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T12:00:00Z");
    await trigger("2026-11-10T12:15:00Z");
    expect(posts(calls)).toHaveLength(1);
  });

  test("S4: after the last try (09:30 local) nothing is posted or saved", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T12:30:00Z");
    expect(posts(calls)).toHaveLength(0);
    expect(await count("days")).toBe(0);
  });

  test("S5: Saturday does not post", async () => {
    const calls = mockFetch();
    await trigger("2026-11-14T12:00:00Z");
    expect(posts(calls)).toHaveLength(0);
  });

  test("S6: a holiday does not post and creates no day row", async () => {
    await addHoliday("2026-12-08", "Inmaculada Concepcion");
    const calls = mockFetch();
    await trigger("2026-12-08T12:00:00Z");
    expect(posts(calls)).toHaveLength(0);
    expect(await dayRow("2026-12-08")).toBeNull();
  });

  test("S7: a participant on vacation is mentioned and excluded from the order", async () => {
    await env.DB.exec("INSERT INTO vacations (person_id, start_date, end_date) VALUES ('ximena', '2026-11-09', '2026-11-13');");
    const calls = mockFetch();
    await trigger("2026-11-10T12:00:00Z");
    expect(posts(calls)).toHaveLength(1);
    const text = JSON.stringify(posts(calls)[0].body);
    expect(text).toContain("de vacaciones");
    expect(text).toContain("Ximena");
    const row = await dayRow("2026-11-10");
    expect(JSON.parse(row.speaking_order)).not.toContain("ximena");
  });

  test("S8: a rejected webhook (HTTP 500) leaves the day pending and the next trigger reuses the plan", async () => {
    let status = 500;
    const calls = mockFetch(() => new Response("err", { status }));
    await trigger("2026-11-10T12:00:00Z");
    const first = await dayRow("2026-11-10");
    expect(first.status).toBe("pending");
    status = 200;
    await trigger("2026-11-10T12:15:00Z");
    expect(posts(calls)).toHaveLength(2);
    const second = await dayRow("2026-11-10");
    expect(second.status).toBe("sent");
    expect(second.presenter).toBe(first.presenter);
    expect(second.speaking_order).toBe(first.speaking_order);
  });

  test("S9: a network failure leaves the day sending, blocks the next trigger and never logs the webhook URL", async () => {
    const calls = mockFetch(() => {
      throw new TypeError(`fetch failed for ${WEBHOOK}`);
    });
    await trigger("2026-11-10T12:00:00Z");
    expect((await dayRow("2026-11-10")).status).toBe("sending");
    await trigger("2026-11-10T12:15:00Z");
    expect(posts(calls)).toHaveLength(1);
    expect(errorLog).toHaveBeenCalled();
    const logged = loggedText(errorLog);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(WEBHOOK);
    expect(logged).not.toContain("webhook.test/hook");
  });

  test("S10: a missing webhook secret posts nothing, saves nothing and logs", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T12:00:00Z", workerEnv({ TEAMS_WEBHOOK_URL: undefined }));
    expect(posts(calls)).toHaveLength(0);
    expect(await dayRow("2026-11-10")).toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });

  test("N1: summer 08:30 local (11:30Z) posts and saves the day as sent", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T11:30:00Z");
    expect(posts(calls)).toHaveLength(1);
    expect((await dayRow("2026-11-10")).status).toBe("sent");
  });

  test("N2: summer 08:25 local (11:25Z), before the start, posts nothing and saves nothing (characterization)", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T11:25:00Z");
    expect(posts(calls)).toHaveLength(0);
    expect(await dayRow("2026-11-10")).toBeNull();
  });

  test("N3: winter 08:25 local (12:25Z) posts nothing, 08:30 local (12:30Z) posts", async () => {
    const calls = mockFetch();
    await trigger("2026-07-15T12:25:00Z");
    expect(posts(calls)).toHaveLength(0);
    await trigger("2026-07-15T12:30:00Z");
    expect(posts(calls)).toHaveLength(1);
  });

  test("N4: summer boundary: pending at 08:30 is retried and sent at 09:25 local (12:25Z)", async () => {
    let status = 500;
    const calls = mockFetch(() => new Response("err", { status }));
    await trigger("2026-11-10T11:30:00Z");
    expect((await dayRow("2026-11-10"))?.status).toBe("pending");
    status = 200;
    await trigger("2026-11-10T12:25:00Z");
    expect(posts(calls)).toHaveLength(2);
    expect((await dayRow("2026-11-10")).status).toBe("sent");
  });

  test("N5: winter: retry at 09:25 local (13:25Z) is sent", async () => {
    let status = 500;
    const calls = mockFetch(() => new Response("err", { status }));
    await trigger("2026-07-15T12:30:00Z");
    expect((await dayRow("2026-07-15"))?.status).toBe("pending");
    status = 200;
    await trigger("2026-07-15T13:25:00Z");
    expect(posts(calls)).toHaveLength(2);
    expect((await dayRow("2026-07-15")).status).toBe("sent");
  });

  test("N5: winter: 09:30 local (13:30Z) posts nothing and saves nothing", async () => {
    const calls = mockFetch();
    await trigger("2026-07-16T13:30:00Z");
    expect(posts(calls)).toHaveLength(0);
    expect(await dayRow("2026-07-16")).toBeNull();
  });

  test("N6: summer retries every 5 minutes reuse the same plan until sent", async () => {
    let status = 500;
    const calls = mockFetch(() => new Response("err", { status }));
    await trigger("2026-11-10T11:30:00Z");
    const first = await dayRow("2026-11-10");
    expect(first?.status).toBe("pending");
    await trigger("2026-11-10T11:35:00Z");
    status = 200;
    await trigger("2026-11-10T11:40:00Z");
    expect(posts(calls)).toHaveLength(3);
    const last = await dayRow("2026-11-10");
    expect(last.status).toBe("sent");
    expect(last.presenter).toBe(first.presenter);
    expect(last.speaking_order).toBe(first.speaking_order);
  });

  test("N7: a missing ANNOUNCEMENT_LAST_TRY posts nothing, saves nothing and logs an error", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T11:30:00Z", workerEnv({ ANNOUNCEMENT_LAST_TRY: undefined }));
    expect(posts(calls)).toHaveLength(0);
    expect(await dayRow("2026-11-10")).toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });

  test.each([
    ["malformed 9:25x", "9:25x"],
    ["earlier than the start 08:00", "08:00"],
  ])("N8: an invalid ANNOUNCEMENT_LAST_TRY (%s) posts nothing, saves nothing and logs an error", async (_label, value) => {
    const calls = mockFetch();
    await trigger("2026-11-10T11:30:00Z", workerEnv({ ANNOUNCEMENT_LAST_TRY: value }));
    expect(posts(calls)).toHaveLength(0);
    expect(await dayRow("2026-11-10")).toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });

  test("N9: ANNOUNCEMENT_LAST_TRY governs the window (09:15 local is after a 09:00 last try)", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T12:15:00Z", workerEnv({ ANNOUNCEMENT_LAST_TRY: "09:00" }));
    expect(posts(calls)).toHaveLength(0);
    expect(await dayRow("2026-11-10")).toBeNull();
  });
});
