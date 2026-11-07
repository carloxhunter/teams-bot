import { validateState } from "./store.js";

export async function loadStateD1(db) {
  const [days, weeks, meta] = await Promise.all([
    db.prepare("SELECT date, week, presenter, speaking_order, status, sharing_completed FROM days ORDER BY date").all(),
    db.prepare("SELECT week, presenter FROM weeks ORDER BY week").all(),
    db.prepare("SELECT value FROM meta WHERE key = 'rotation_start_date'").first(),
  ]);
  const state = { version: 1, weeks: {}, days: {} };
  if (meta) state.rotationStartDate = meta.value;
  for (const row of weeks.results) state.weeks[row.week] = row.presenter;
  for (const row of days.results) {
    let order;
    try {
      order = JSON.parse(row.speaking_order);
    } catch {
      order = null;
    }
    const plan = { presenter: row.presenter, order, status: row.status };
    if (row.week !== null) plan.week = row.week;
    if (row.sharing_completed !== null) plan.sharingCompleted = row.sharing_completed === 1;
    state.days[row.date] = plan;
  }
  return validateState(state);
}

export async function saveStateD1(db, state) {
  validateState(state);
  const statements = [];
  if (state.rotationStartDate !== undefined) {
    statements.push(db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rotation_start_date', ?)")
      .bind(state.rotationStartDate));
  }
  for (const [week, presenter] of Object.entries(state.weeks)) {
    statements.push(db.prepare("INSERT OR REPLACE INTO weeks (week, presenter) VALUES (?, ?)").bind(week, presenter));
  }
  for (const [date, plan] of Object.entries(state.days)) {
    statements.push(db.prepare(
      "INSERT OR REPLACE INTO days (date, week, presenter, speaking_order, status, sharing_completed) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      date,
      plan.week ?? null,
      plan.presenter,
      JSON.stringify(plan.order),
      plan.status,
      plan.sharingCompleted === undefined ? null : plan.sharingCompleted ? 1 : 0,
    ));
  }
  if (statements.length) await db.batch(statements);
}

export async function loadConfigD1(db, { timeZone, announcementTime }) {
  const [participants, vacations, holidays] = await Promise.all([
    db.prepare("SELECT id, name FROM participants WHERE active = 1 ORDER BY position").all(),
    db.prepare("SELECT person_id, start_date, end_date FROM vacations ORDER BY id").all(),
    db.prepare("SELECT date FROM holidays ORDER BY date").all(),
  ]);
  return {
    participants: participants.results.map(({ id, name }) => ({ id, name })),
    timeZone,
    announcementTime,
    vacations: vacations.results.map(row => ({ personId: row.person_id, start: row.start_date, end: row.end_date })),
    holidays: holidays.results.map(row => row.date),
  };
}
