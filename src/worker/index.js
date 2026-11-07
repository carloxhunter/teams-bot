import { announceWith, validateWebhook } from "../delivery.js";
import { loadConfigD1, loadStateD1, saveStateD1 } from "../d1-store.js";
import { isDue, localDay, validateConfig } from "../rotation.js";

const WINDOW_MINUTES = 60;

const minutes = time => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

async function run(controller, env) {
  const day = localDay(new Date(controller.scheduledTime), env.TIME_ZONE);
  if (!isDue(day, env.ANNOUNCEMENT_TIME)) return;
  if (minutes(day.time) >= minutes(env.ANNOUNCEMENT_TIME) + WINDOW_MINUTES) return;
  const url = validateWebhook(env.TEAMS_WEBHOOK_URL).href;
  const loaded = await loadConfigD1(env.DB, {
    timeZone: env.TIME_ZONE,
    announcementTime: env.ANNOUNCEMENT_TIME,
  });
  const { holidays, ...config } = loaded;
  validateConfig(config);
  await announceWith({
    store: { load: () => loadStateD1(env.DB), save: state => saveStateD1(env.DB, state) },
    config, day, url, holidays,
  });
}

export default {
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
  async scheduled(controller, env) {
    try {
      await run(controller, env);
    } catch (error) {
      console.error(`Scheduled announcement failed: ${error?.message ?? "unknown error"}`);
    }
  },
};
