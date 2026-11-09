import {
  announceWith, DeliveryUncertainError, postCard, validateWebhook, WebhookRejectedError, WebhookUncertainError,
} from "../delivery.js";
import { loadConfigD1, loadStateD1, saveStateD1 } from "../d1-store.js";
import { activeVacations, cardFor, isDue, localDay, validateConfig } from "../rotation.js";

const minutes = time => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEBUG_PATH = "/debug/resend-last";

function describeFailure(date, error) {
  if (error instanceof WebhookRejectedError) {
    return `Announcement ${date}: rejected (HTTP ${error.status}) after ${error.ms} ms; the day stays pending and is retried.`;
  }
  if (error instanceof WebhookUncertainError) {
    return `Announcement ${date}: ${error.kind} (${error.errorName}${error.detail ? `: ${error.detail}` : ""}) ` +
      `after ${error.ms} ms; delivery uncertain, the day stays sending and is not retried.`;
  }
  if (error instanceof DeliveryUncertainError) {
    return `Announcement ${date}: skipped: delivery uncertain (day is sending). ` +
      "Check Teams and the Workflow run history; set the day to pending only if nothing was posted.";
  }
  return null;
}

async function run(controller, env) {
  const lastTry = env.ANNOUNCEMENT_LAST_TRY;
  if (typeof lastTry !== "string" || !HHMM.test(lastTry)) {
    throw new Error("ANNOUNCEMENT_LAST_TRY must be a valid HH:MM time");
  }
  if (HHMM.test(env.ANNOUNCEMENT_TIME) && minutes(lastTry) < minutes(env.ANNOUNCEMENT_TIME)) {
    throw new Error("ANNOUNCEMENT_LAST_TRY must not be earlier than ANNOUNCEMENT_TIME");
  }
  const day = localDay(new Date(controller.scheduledTime), env.TIME_ZONE);
  if (!isDue(day, env.ANNOUNCEMENT_TIME)) return;
  if (minutes(day.time) > minutes(lastTry)) return;
  const url = validateWebhook(env.TEAMS_WEBHOOK_URL).href;
  const loaded = await loadConfigD1(env.DB, {
    timeZone: env.TIME_ZONE,
    announcementTime: env.ANNOUNCEMENT_TIME,
  });
  const { holidays, ...config } = loaded;
  validateConfig(config);
  let delivery;
  try {
    await announceWith({
      store: { load: () => loadStateD1(env.DB), save: state => saveStateD1(env.DB, state) },
      config, day, url, holidays,
      send: async (target, card) => {
        delivery = await postCard(target, card);
      },
    });
  } catch (error) {
    const message = describeFailure(day.date, error);
    if (!message) throw error;
    console.error(message);
    return;
  }
  if (delivery) {
    console.log(`Announcement ${day.date}: accepted (HTTP ${delivery.httpStatus}) in ${delivery.ms} ms.`);
  }
}

const notFound = () => new Response("Not found", { status: 404 });

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

async function authorized(request, expected) {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const given = header.slice("Bearer ".length);
  if (!given) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map(value =>
    crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(a, b);
}

// Resends the latest saved day's card without touching its status, to test the Cloudflare -> Teams path.
async function resendLast(env) {
  const url = validateWebhook(env.TEAMS_WEBHOOK_URL).href;
  const state = await loadStateD1(env.DB);
  const date = Object.keys(state.days).sort().at(-1);
  if (!date) return json(409, { outcome: "no-days" });
  const config = await loadConfigD1(env.DB, { timeZone: env.TIME_ZONE, announcementTime: env.ANNOUNCEMENT_TIME });
  const { presenter, order } = state.days[date];
  const card = cardFor(date, { presenter, order, vacations: activeVacations(config.vacations, date) }, config.participants);
  try {
    const { httpStatus, ms } = await postCard(url, card);
    console.log(`Debug resend ${date}: accepted (HTTP ${httpStatus}) in ${ms} ms.`);
    return json(200, { date, outcome: "accepted", httpStatus, ms });
  } catch (error) {
    if (error instanceof WebhookRejectedError) {
      console.error(`Debug resend ${date}: rejected (HTTP ${error.status}) after ${error.ms} ms.`);
      return json(502, { date, outcome: "rejected", httpStatus: error.status, ms: error.ms });
    }
    if (error instanceof WebhookUncertainError) {
      console.error(`Debug resend ${date}: ${error.kind} (${error.errorName}) after ${error.ms} ms.`);
      return json(502, { date, outcome: error.kind, errorName: error.errorName, detail: error.detail, ms: error.ms });
    }
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== DEBUG_PATH) return notFound();
    if (typeof env.DEBUG_TOKEN !== "string" || !env.DEBUG_TOKEN) return notFound();
    if (!(await authorized(request, env.DEBUG_TOKEN))) return notFound();
    try {
      return await resendLast(env);
    } catch (error) {
      console.error(`Debug resend failed: ${error?.message ?? "unknown error"}`);
      return json(500, { outcome: "error" });
    }
  },
  async scheduled(controller, env) {
    try {
      await run(controller, env);
    } catch (error) {
      console.error(`Scheduled announcement failed: ${error?.message ?? "unknown error"}`);
    }
  },
};
