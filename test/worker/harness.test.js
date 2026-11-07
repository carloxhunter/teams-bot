import { env } from "cloudflare:test";
import { expect, test } from "vitest";

// T0 characterization of the harness.
test("T0: env.DB exists and SELECT 1 works", async () => {
  expect(env.DB).toBeDefined();
  const row = await env.DB.prepare("SELECT 1 AS one").first();
  expect(row.one).toBe(1);
});
