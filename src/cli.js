import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cardFor, isDue, localDay, messageText, planDay, testCardFor, validateConfig } from "./rotation.js";
import { announce, postCard, validateWebhook } from "./delivery.js";
import { loadState, loadVacations, lockStore } from "./store.js";

// TEAMS_BOT_DATA_DIR lets tests (and CI) use a throwaway data directory instead of the real one.
const directory = process.env.TEAMS_BOT_DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
// config.js holds the real team's names and is gitignored (copy config.example.js).
// TEAMS_BOT_CONFIG points at another file, e.g. the example in tests and CI.
const { default: baseConfig } = await import(
  process.env.TEAMS_BOT_CONFIG
    ? pathToFileURL(path.resolve(process.env.TEAMS_BOT_CONFIG)).href
    : new URL("../config.js", import.meta.url).href
);

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--once", "--preview", "--show", "--test-message", "--send", "--retry"].includes(arg)) ||
      (args.includes("--retry") && !args.includes("--once")) ||
      ["--preview", "--show", "--test-message", "--send"].some(option => args.includes(option) && args.length > 1)) {
    throw new Error("Usage: node src/cli.js [--show | --preview | --test-message | --send | --once [--retry]]");
  }
  const config = { ...baseConfig, vacations: await loadVacations(directory) };
  validateConfig(config);
  if (args.includes("--preview") || args.includes("--show") || args.includes("--test-message")) {
    const day = localDay(new Date(), config.timeZone);
    const state = structuredClone(await loadState(directory));
    delete state.days[day.date];
    const plan = planDay(state, config, day);
    if (args.includes("--test-message")) {
      await postCard(validateWebhook(process.env.TEAMS_WEBHOOK_URL),
        testCardFor(day.date, plan, config.participants));
      console.log(`${day.date}: test message accepted by the Teams webhook. Rotation history was not changed.`);
      return;
    }
    console.log(args.includes("--show")
      ? messageText(day.date, plan, config.participants)
      : JSON.stringify(cardFor(day.date, plan, config.participants), null, 2));
    return;
  }
  const url = validateWebhook(process.env.TEAMS_WEBHOOK_URL);
  const release = await lockStore(directory);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (args.includes("--send")) {
      const result = await announce({ directory, config, day: localDay(new Date(), config.timeZone), url, force: true });
      if (result === "accepted") console.log("Daily announcement accepted by the Teams webhook and saved in data/state.json.");
      return;
    }
    if (!args.includes("--once")) {
      console.log(`Scheduler ready: Monday-Friday ${config.announcementTime} (${config.timeZone}).`);
    }
    do {
      const day = localDay(new Date(), config.timeZone);
      if (args.includes("--once") || isDue(day, config.announcementTime)) {
        const result = await announce({
          directory, config, day, url, retry: args.includes("--retry"),
        });
        if (result === "accepted") console.log(`${day.date}: webhook accepted the daily announcement.`);
        else if (args.includes("--once")) console.log(`${day.date}: already sent; not posting twice.`);
      }
      if (args.includes("--once")) break;
      try {
        await sleep(30_000, undefined, { signal: controller.signal });
      } catch (error) {
        if (error.name !== "AbortError") throw error;
      }
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await release();
  }
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
