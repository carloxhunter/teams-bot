import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const migrationsPath = path.join(root, "migrations");
// Until the implementer creates migrations/, skip applying so the harness itself still works.
const migrations = existsSync(migrationsPath) ? await readD1Migrations(migrationsPath) : [];

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: {
          TIME_ZONE: "America/Santiago",
          ANNOUNCEMENT_TIME: "09:00",
          TEAMS_WEBHOOK_URL: "https://webhook.test/hook?sig=SECRET-SIG-123",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["test/worker/**/*.test.js"],
    setupFiles: ["./test/worker/setup.js"],
    restoreMocks: true,
  },
});
