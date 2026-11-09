import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import worker from "../../src/worker/index.js";
import { at, dayRow, loggedText, mockFetch, resetDb, seedParticipants, SECRET, WEBHOOK, workerEnv } from "./helpers.js";

async function trigger(iso) {
  const ctx = createExecutionContext();
  await worker.scheduled(at(iso), workerEnv(), ctx);
  await waitOnExecutionContext(ctx);
}

const originalConsoleError = console.error;
const originalConsoleLog = console.log;
let errorLog;
let infoLog;

beforeEach(async () => {
  await resetDb();
  await seedParticipants();
  errorLog = vi.fn();
  infoLog = vi.fn();
  console.error = errorLog;
  console.log = infoLog;
});

afterEach(() => {
  console.error = originalConsoleError;
  console.log = originalConsoleLog;
});

const allLogs = () => `${loggedText(infoLog)}\n${loggedText(errorLog)}`;

function expectNoSecret() {
  const logged = allLogs();
  expect(logged).not.toContain(SECRET);
  expect(logged).not.toContain(WEBHOOK);
  expect(logged).not.toContain("webhook.test/hook");
}

describe("scheduled logs", () => {
  test("L1: an accepted post logs the date, accepted, the HTTP status and the elapsed ms", async () => {
    mockFetch();
    await trigger("2026-11-10T11:30:00Z");
    const logged = loggedText(infoLog);
    expect(logged).toContain("2026-11-10");
    expect(logged).toContain("accepted");
    expect(logged).toContain("200");
    expect(logged).toMatch(/\d+ ?ms/);
    expectNoSecret();
  });

  test.each([
    ["timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"), "TimeoutError"],
    ["network-error", () => new TypeError(`fetch failed for ${WEBHOOK}`), "TypeError"],
  ])("L2: %s logs its kind and the error name, never the webhook URL", async (kind, makeError, errorName) => {
    mockFetch(() => {
      throw makeError();
    });
    await trigger("2026-11-10T11:30:00Z");
    expect((await dayRow("2026-11-10")).status).toBe("sending");
    const logged = loggedText(errorLog);
    expect(logged).toContain("2026-11-10");
    expect(logged).toContain(kind);
    expect(logged).toContain(errorName);
    expectNoSecret();
  });

  test("L3: a rejected post logs rejected with the HTTP status", async () => {
    mockFetch(() => new Response("err", { status: 500 }));
    await trigger("2026-11-10T11:30:00Z");
    const logged = loggedText(errorLog);
    expect(logged).toContain("2026-11-10");
    expect(logged).toContain("rejected");
    expect(logged).toContain("500");
    expectNoSecret();
  });

  test("L4: a day stuck in sending logs that the attempt was skipped because delivery is uncertain", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await trigger("2026-11-10T11:30:00Z");
    errorLog.mockClear();
    infoLog.mockClear();
    await trigger("2026-11-10T11:35:00Z");
    const logged = allLogs();
    expect(logged).toContain("2026-11-10");
    expect(logged).toMatch(/skipped/i);
    expect(logged).toMatch(/delivery uncertain/i);
  });
});
