import { applyD1Migrations, env } from "cloudflare:test";

// Applies migrations/ (if it exists yet). Idempotent: safe to run per test file.
if (env.TEST_MIGRATIONS?.length) {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}
