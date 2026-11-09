// Asks the deployed Worker to resend the latest saved day's card (posts a duplicate in Teams).
const token = process.env.DEBUG_TOKEN;
if (!token) {
  console.error("Set DEBUG_TOKEN in .env (the same value as the Worker's DEBUG_TOKEN secret).");
  process.exit(1);
}
const base = process.env.DEBUG_URL || "https://teams-bot.team-bots.workers.dev";
const response = await fetch(new URL("/debug/resend-last", base), {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text);
if (!response.ok) process.exit(1);
