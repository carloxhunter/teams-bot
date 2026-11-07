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

  test("S4: after the one-hour window nothing is posted or saved", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T13:00:00Z");
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
});
