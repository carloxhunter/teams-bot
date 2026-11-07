import { createExecutionContext } from "cloudflare:test";
import { expect, test } from "vitest";
import worker from "../../src/worker/index.js";

test("A1: fetch always answers 404 without touching env.DB", async () => {
  let touched = false;
  const DB = new Proxy({}, {
    get() {
      touched = true;
      throw new Error("env.DB must not be accessed");
    },
  });
  const env = { DB, TIME_ZONE: "America/Santiago", ANNOUNCEMENT_TIME: "09:00", TEAMS_WEBHOOK_URL: "https://webhook.test/hook?sig=X" };
  for (const [method, path] of [["GET", "/"], ["POST", "/mcp"], ["GET", "/admin"], ["DELETE", "/x/y"], ["PUT", "/"]]) {
    const response = await worker.fetch(new Request(`https://bot.example${path}`, { method }), env, createExecutionContext());
    expect(response.status, `${method} ${path}`).toBe(404);
  }
  expect(touched).toBe(false);
});
