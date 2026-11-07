const q = value => `'${String(value).replaceAll("'", "''")}'`;
const n = value => (value === undefined || value === null ? "NULL" : q(value));

export function toSql({ config, state, vacations }) {
  const lines = [];
  config.participants.forEach((p, index) => {
    lines.push(`INSERT INTO participants (id, name, position, active) VALUES (${q(p.id)}, ${q(p.name)}, ${index}, 1);`);
  });
  for (const v of vacations) {
    lines.push(`INSERT INTO vacations (person_id, start_date, end_date) VALUES (${q(v.personId)}, ${q(v.start)}, ${q(v.end)});`);
  }
  for (const [week, presenter] of Object.entries(state.weeks)) {
    lines.push(`INSERT INTO weeks (week, presenter) VALUES (${q(week)}, ${q(presenter)});`);
  }
  for (const [date, plan] of Object.entries(state.days)) {
    const sharing = plan.sharingCompleted === undefined ? "NULL" : plan.sharingCompleted ? "1" : "0";
    lines.push(
      `INSERT INTO days (date, week, presenter, speaking_order, status, sharing_completed) VALUES (${q(date)}, ${n(plan.week)}, ${q(plan.presenter)}, ${q(JSON.stringify(plan.order))}, ${q(plan.status)}, ${sharing});`,
    );
  }
  if (state.rotationStartDate !== undefined) {
    lines.push(`INSERT INTO meta (key, value) VALUES ('rotation_start_date', ${q(state.rotationStartDate)});`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(output) {
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { loadState, loadVacations } = await import("../src/store.js");
  const { validateConfig } = await import("../src/rotation.js");
  const configPath = path.resolve(process.env.TEAMS_BOT_CONFIG ?? "./config.js");
  const directory = path.resolve(process.env.TEAMS_BOT_DATA_DIR ?? "./data");
  const config = (await import(pathToFileURL(configPath).href)).default;
  validateConfig(config);
  const state = await loadState(directory);
  const vacations = await loadVacations(directory);
  await writeFile(output, toSql({ config, state, vacations }), { mode: 0o600 });
  console.log(`Wrote ${output}: ${config.participants.length} participants, ${vacations.length} vacations, ` +
    `${Object.keys(state.weeks).length} weeks, ${Object.keys(state.days).length} days.`);
}

const argv = globalThis.process?.argv;
if (argv?.[1] && import.meta.url.endsWith(argv[1].split("/").pop()) && argv[1].includes("migrate-to-d1")) {
  const output = argv[2];
  if (!output) {
    console.error("Usage: node scripts/migrate-to-d1.js <output.sql>");
    process.exitCode = 1;
  } else {
    main(output).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
