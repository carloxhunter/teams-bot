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

export class WebhookRejectedError extends Error {
  constructor(status, ms) {
    super(`Webhook returned HTTP ${status}. Check the Workflow run history before retrying.`);
    this.name = "WebhookRejectedError";
    this.status = status;
    this.ms = ms;
  }
}

// Network error or timeout: Teams may or may not have posted the card.
export class WebhookUncertainError extends Error {
  constructor({ kind, errorName, detail, ms }) {
    super(`Webhook ${kind} (${errorName}${detail ? `: ${detail}` : ""}) after ${ms} ms: network error or timeout, ` +
      "delivery uncertain. Check Teams and Workflow run history before retrying.");
    this.name = "WebhookUncertainError";
    this.kind = kind;
    this.errorName = errorName;
    this.detail = detail;
    this.ms = ms;
  }
}

export class DeliveryUncertainError extends Error {
  constructor() {
    super("Delivery is uncertain. Check Teams and Workflow run history, then use --once --retry only if no message was posted.");
    this.name = "DeliveryUncertainError";
  }
}

// Error messages may echo the secret webhook URL: strip it and any other URL.
function redact(text, url) {
  const parsed = new URL(url);
  return String(text ?? "")
    .split(url).join("<url>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .split(`${parsed.host}${parsed.pathname}`).join("<url>")
    .split(parsed.search || "\0").join("")
    .slice(0, 200);
}

export async function postCard(url, card) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (error) {
    // Never include fetch's cause: it can contain the secret webhook URL.
    const errorName = typeof error?.name === "string" ? error.name : "Error";
    throw new WebhookUncertainError({
      kind: ["TimeoutError", "AbortError"].includes(errorName) ? "timeout" : "network-error",
      errorName,
      detail: redact(error?.message, url),
      ms: Date.now() - started,
    });
  }
  await response.body?.cancel();
  const ms = Date.now() - started;
  if (!response.ok) {
    throw new WebhookRejectedError(response.status, ms);
  }
  return { httpStatus: response.status, ms };
}

export async function announceWith({
  store: { load, save }, config, day, url, retry = false, force = false, send = postCard, holidays = [],
}) {
  if (holidays.includes(day.date)) return "holiday";
  const state = await load();
  let plan = planDay(state, config, day);
  if (plan.status === "sent" && !force) return "already-sent";
  if (plan.status === "sending" && !retry) {
    throw new DeliveryUncertainError();
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
  await save(state);
  try {
    await send(url, cardFor(day.date, plan, config.participants));
  } catch (error) {
    if (error instanceof WebhookRejectedError) {
      plan.status = "pending";
      await save(state);
    }
    throw error;
  }
  plan.status = "sent";
  await save(state);
  return "accepted";
}

export function announce({
  directory, config, day, url, retry = false, force = false, send = postCard,
}) {
  return announceWith({
    store: { load: () => loadState(directory), save: state => saveState(directory, state) },
    config, day, url, retry, force, send,
  });
}
