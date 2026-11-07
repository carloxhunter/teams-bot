import { cardFor, planDay } from "./rotation.js";
import { loadState, saveState } from "./store.js";

export function validateWebhook(value) {
  if (!value) throw new Error("Set TEAMS_WEBHOOK_URL in .env to your Teams Workflow URL.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TEAMS_WEBHOOK_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("TEAMS_WEBHOOK_URL must use HTTPS without user credentials or a fragment.");
  }
  return url;
}

export async function postCard(url, card) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    // Never include fetch's cause: it can contain the secret webhook URL.
    throw new Error("Webhook network error or timeout. Check Teams and Workflow run history before retrying.");
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Webhook returned HTTP ${response.status}. Check the Workflow run history before retrying.`);
  }
}

export async function announce({
  directory, config, day, url, retry = false, force = false, send = postCard,
}) {
  const state = await loadState(directory);
  let plan = planDay(state, config, day);
  if (plan.status === "sent" && !force) return "already-sent";
  if (plan.status === "sending" && !retry) {
    throw new Error("Delivery is uncertain. Check Teams and Workflow run history, then use --once --retry only if no message was posted.");
  }
  const participantIds = config.participants.map(participant =>
    typeof participant === "string" ? participant : participant.id);
  const availableToday = participantIds.filter(id =>
    !(plan.vacations ?? []).some(vacation => vacation.id === id));
  if (plan.order.some(id => !participantIds.includes(id)) ||
      [...plan.order].sort().join("\0") !== [...availableToday].sort().join("\0")) {
    delete state.days[day.date];
    plan = planDay(state, config, day);
  }
  plan.status = "sending";
  await saveState(directory, state);
  await send(url, cardFor(day.date, plan, config.participants));
  plan.status = "sent";
  await saveState(directory, state);
  return "accepted";
}
