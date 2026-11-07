import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

function validDate(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function validateState(state) {
  const record = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const name = (value) => typeof value === "string" && value.trim().length > 0;
  if (
    !record(state) ||
    state.version !== 1 ||
    !record(state.weeks) ||
    !record(state.days) ||
    (state.rotationStartDate !== undefined &&
      !validDate(state.rotationStartDate)) ||
    !Object.entries(state.weeks).every(
      ([week, presenter]) =>
        validDate(week) && new Date(week).getUTCDay() === 1 && name(presenter),
    ) ||
    !Object.entries(state.days).every(
      ([date, plan]) =>
        validDate(date) &&
        record(plan) &&
        name(plan.presenter) &&
        validDate(plan.week ?? weekOf(date)) &&
        new Date(plan.week ?? weekOf(date)).getUTCDay() === 1 &&
        (plan.week ?? weekOf(date)) <= date &&
        new Date(plan.week ?? weekOf(date)).getTime() + 6 * 86_400_000 >=
          Date.parse(`${date}T00:00:00Z`) &&
        Array.isArray(plan.order) &&
        plan.order.length > 0 &&
        plan.order.every(name) &&
        new Set(plan.order).size === plan.order.length &&
        plan.order.includes(plan.presenter) &&
        (plan.sharingCompleted === undefined ||
          typeof plan.sharingCompleted === "boolean") &&
        ["pending", "sending", "sent"].includes(plan.status),
    )
  ) {
    throw new Error(
      "Invalid rotation state. Restore data/state.json from a backup; it will not be reset automatically.",
    );
  }
  return state;
}

function weekOf(date) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

export async function loadState(directory) {
  let content;
  try {
    content = await readFile(path.join(directory, "state.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, weeks: {}, days: {} };
    throw error;
  }
  return validateState(JSON.parse(content));
}

export async function loadVacations(directory) {
  const filePath = path.join(directory, "vacations.json");
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Missing ${filePath}. Restore data/vacations.json; vacation data is not stored in state.json.`,
      );
    }
    throw error;
  }
  let vacations;
  try {
    vacations = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid ${filePath}: ${error.message}`);
  }
  if (!Array.isArray(vacations)) {
    throw new Error(
      `Invalid ${filePath}: expected a JSON array of vacation date ranges.`,
    );
  }
  return vacations;
}

export async function saveState(directory, state) {
  validateState(state);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, "state.json.tmp");
  const file = await open(temporary, "w", 0o600);
  try {
    const persistedState = {
      ...state,
      days: Object.fromEntries(
        Object.entries(state.days).map(([date, plan]) => {
          const { vacations, ...persistedPlan } = plan;
          return [date, persistedPlan];
        }),
      ),
    };
    await file.writeFile(`${JSON.stringify(persistedState, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path.join(directory, "state.json"));
}

export async function lockStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, "rotation.lock");
  let file;
  try {
    file = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Another instance may be running. Check ${lockPath}; remove it only after confirming its PID is no longer running.`,
      );
    }
    throw error;
  }
  try {
    await file.writeFile(`${process.pid}\n`);
  } catch (error) {
    await file.close();
    await unlink(lockPath);
    throw error;
  }
  return async () => {
    await file.close();
    await unlink(lockPath);
  };
}
