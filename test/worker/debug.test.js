import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "../../config.example.js";
import { cardFor } from "../../src/rotation.js";
import worker from "../../src/worker/index.js";
import { count, dayRow, loggedText, mockFetch, resetDb, seedParticipants, SECRET, WEBHOOK, workerEnv } from "./helpers.js";

const TOKEN = "debug-token-0123456789abcdef";
const PATH = "/debug/resend-last";

async function call({ method = "POST", path = PATH, token = TOKEN, environment = workerEnv({ DEBUG_TOKEN: TOKEN }) } = {}) {
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` };
  const response = await worker.fetch(
    new Request(`https://bot.example${path}`, { method, headers }),
    environment,
    createExecutionContext(),
  );
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

const posts = (calls) => calls.filter((c) => c.url === WEBHOOK && c.method === "POST");

async function saveDay(date, { presenter, order, status = "sent", week = null }) {
  await env.DB.prepare(
    "INSERT INTO days (date, week, presenter, speaking_order, status, sharing_completed) VALUES (?, ?, ?, ?, ?, NULL)",
  ).bind(date, week, presenter, JSON.stringify(order), status).run();
}

const ORDER = ["ines", "bruno", "gaspar", "ximena", "ulises", "fabio"];

const untouchedDb = () => {
  const touched = { value: false };
  const DB = new Proxy({}, {
    get() {
      touched.value = true;
      throw new Error("env.DB must not be accessed");
    },
  });
  return { DB, touched };
};

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

describe("debug resend-last", () => {
  test("D1: without DEBUG_TOKEN configured answers 404 for any token and touches neither DB nor fetch", async () => {
    const calls = mockFetch();
    const { DB, touched } = untouchedDb();
    for (const environment of [workerEnv({ DB }), workerEnv({ DB, DEBUG_TOKEN: "" })]) {
      for (const token of [null, "", TOKEN, "undefined"]) {
        const { status } = await call({ token, environment });
        expect(status, `token=${token}`).toBe(404);
      }
    }
    expect(touched.value).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("D2: a missing or wrong token answers 404 and touches neither DB nor fetch", async () => {
    const calls = mockFetch();
    const { DB, touched } = untouchedDb();
    const environment = workerEnv({ DB, DEBUG_TOKEN: TOKEN });
    for (const token of [null, "", "wrong", `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const { status } = await call({ token, environment });
      expect(status, `token=${token}`).toBe(404);
    }
    const noBearer = await worker.fetch(
      new Request(`https://bot.example${PATH}`, { method: "POST", headers: { Authorization: TOKEN } }),
      environment,
      createExecutionContext(),
    );
    expect(noBearer.status).toBe(404);
    expect(touched.value).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("D3: other methods or paths answer 404 even with the right token", async () => {
    const calls = mockFetch();
    const { DB, touched } = untouchedDb();
    const environment = workerEnv({ DB, DEBUG_TOKEN: TOKEN });
    for (const [method, path] of [["GET", PATH], ["PUT", PATH], ["POST", "/"], ["POST", "/debug"], ["POST", `${PATH}/x`]]) {
      const { status } = await call({ method, path, environment });
      expect(status, `${method} ${path}`).toBe(404);
    }
    expect(touched.value).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test.each(["sent", "sending", "pending"])(
    "D4: the right token resends the latest saved day's card and leaves its status (%s) unchanged",
    async (dayStatus) => {
      await saveDay("2026-11-06", { presenter: "bruno", order: [...ORDER].reverse() });
      await saveDay("2026-11-09", { presenter: "ximena", order: ORDER, status: dayStatus });
      const calls = mockFetch();
      const { status, body } = await call();
      expect(status).toBe(200);
      expect(body).toMatchObject({ date: "2026-11-09", outcome: "accepted", httpStatus: 200 });
      expect(typeof body.ms).toBe("number");
      expect(posts(calls)).toHaveLength(1);
      expect(posts(calls)[0].body).toEqual(
        cardFor("2026-11-09", { presenter: "ximena", order: ORDER, vacations: [] }, config.participants),
      );
      expect((await dayRow("2026-11-09")).status).toBe(dayStatus);
      expect(await count("days")).toBe(2);
    },
  );

  test("D5: without saved days answers 409 no-days and posts nothing", async () => {
    const calls = mockFetch();
    const { status, body } = await call();
    expect(status).toBe(409);
    expect(body).toMatchObject({ outcome: "no-days" });
    expect(calls).toHaveLength(0);
  });

  test("D6: a Teams rejection (HTTP 500) answers 502 rejected and leaves the status unchanged", async () => {
    await saveDay("2026-11-09", { presenter: "ximena", order: ORDER, status: "sent" });
    mockFetch(() => new Response("err", { status: 500 }));
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(body).toMatchObject({ date: "2026-11-09", outcome: "rejected", httpStatus: 500 });
    expect((await dayRow("2026-11-09")).status).toBe("sent");
  });

  test.each([
    ["timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError"), "TimeoutError"],
    ["network-error", () => new TypeError(`fetch failed for ${WEBHOOK}`), "TypeError"],
  ])("D7: %s answers 502 with the error name and never exposes the webhook URL", async (outcome, makeError, errorName) => {
    await saveDay("2026-11-09", { presenter: "ximena", order: ORDER, status: "sent" });
    mockFetch(() => {
      throw makeError();
    });
    const { status, body, text } = await call();
    expect(status).toBe(502);
    expect(body).toMatchObject({ date: "2026-11-09", outcome, errorName });
    expect(typeof body.ms).toBe("number");
    expect((await dayRow("2026-11-09")).status).toBe("sent");
    const everything = `${text}\n${loggedText(errorLog)}\n${loggedText(infoLog)}`;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("webhook.test/hook");
  });

  test("D8: vacations active on the resent date appear in the card", async () => {
    await env.DB.exec("INSERT INTO vacations (person_id, start_date, end_date) VALUES ('fabio', '2026-11-09', '2026-11-13');");
    const order = ORDER.filter((id) => id !== "fabio");
    await saveDay("2026-11-10", { presenter: "ximena", order });
    const calls = mockFetch();
    const { status } = await call();
    expect(status).toBe(200);
    const text = JSON.stringify(posts(calls)[0].body);
    expect(text).toContain("Fabio está de vacaciones hasta el 13-11-2026");
  });
});
