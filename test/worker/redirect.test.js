import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../../src/worker/index.js";
import { at, dayRow, loggedText, mockFetch, resetDb, seedParticipants, WEBHOOK, workerEnv } from "./helpers.js";

const TOKEN = "debug-token-0123456789abcdef";

async function trigger(iso) {
  const ctx = createExecutionContext();
  await worker.scheduled(at(iso), workerEnv(), ctx);
  await waitOnExecutionContext(ctx);
}

const posts = (calls) => calls.filter((c) => c.url === WEBHOOK && c.method === "POST");

const originalConsoleError = console.error;
const originalConsoleLog = console.log;
let errorLog;

beforeEach(async () => {
  await resetDb();
  await seedParticipants();
  errorLog = vi.fn();
  console.error = errorLog;
  console.log = vi.fn();
});

afterEach(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

describe("redirects", () => {
  test("R1: the webhook request uses a redirect mode workerd accepts and is actually sent", async () => {
    const calls = mockFetch();
    await trigger("2026-11-10T11:30:00Z");
    expect(posts(calls)).toHaveLength(1);
    // "manual": a redirect is never followed (the card is only posted to the configured URL).
    expect(posts(calls)[0].redirect).toBe("manual");
    expect((await dayRow("2026-11-10")).status).toBe("sent");
  });

  test("R2: a 302 from the webhook is a rejection: the day stays pending and the log says rejected (HTTP 302)", async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }));
    await trigger("2026-11-10T11:30:00Z");
    expect((await dayRow("2026-11-10")).status).toBe("pending");
    expect(loggedText(errorLog)).toContain("rejected (HTTP 302)");
  });

  test("R3: the debug resend reports a 302 as 502 rejected", async () => {
    await env.DB.prepare(
      "INSERT INTO days (date, week, presenter, speaking_order, status, sharing_completed) VALUES (?, NULL, ?, ?, 'sent', NULL)",
    ).bind("2026-11-09", "ximena", JSON.stringify(["ines", "bruno", "gaspar", "ximena", "ulises", "fabio"])).run();
    mockFetch(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }));
    const response = await worker.fetch(
      new Request("https://bot.example/debug/resend-last", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }),
      workerEnv({ DEBUG_TOKEN: TOKEN }),
      createExecutionContext(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ outcome: "rejected", httpStatus: 302 });
  });
});
