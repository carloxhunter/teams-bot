import { describe, expect, test } from "vitest";
import wranglerText from "../../wrangler.jsonc?raw";

// Strips // comments that are outside of string literals.
function parseJsonc(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : "")));
}

function expandField(field, min, max) {
  const values = new Set();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let from;
    let to;
    if (range === "*") [from, to] = [min, max];
    else if (range.includes("-")) [from, to] = range.split("-").map(Number);
    else [from, to] = stepText ? [Number(range), max] : [Number(range), Number(range)];
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

function parseCron(cron) {
  const [minute, hour, , , dow] = cron.trim().split(/\s+/);
  return {
    minutes: expandField(minute, 0, 59),
    hours: expandField(hour, 0, 23),
    dows: new Set([...expandField(dow, 0, 7)].map((d) => d % 7)),
  };
}

function offsetMinutes(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, Number(p.value)]),
  );
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs) / 60000;
}

function localToUtc(date, hh, mm, timeZone) {
  const [y, m, d] = date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  let utc = asUtc - offsetMinutes(asUtc, timeZone) * 60000;
  utc = asUtc - offsetMinutes(utc, timeZone) * 60000;
  return new Date(utc);
}

const wrangler = parseJsonc(wranglerText);

describe("wrangler config", () => {
  test("C1: cron, announcement window and time zone are configured", () => {
    expect(wrangler.triggers.crons).toEqual(["*/5 11,12,13 * * 1-5"]);
    expect(wrangler.vars.ANNOUNCEMENT_TIME).toBe("08:30");
    expect(wrangler.vars.ANNOUNCEMENT_LAST_TRY).toBe("09:25");
    expect(wrangler.vars.TIME_ZONE).toBe("America/Santiago");
  });

  test("C2: the cron fires on every 5-minute local slot 08:30-09:25 in summer and winter, Mon-Fri only", () => {
    const { minutes, hours, dows } = parseCron(wrangler.triggers.crons[0]);
    expect([...dows].sort()).toEqual([1, 2, 3, 4, 5]);
    const tz = wrangler.vars.TIME_ZONE;
    const missing = [];
    for (const date of ["2026-11-10", "2026-07-15"]) {
      expect(dows.has(new Date(`${date}T12:00:00Z`).getUTCDay())).toBe(true);
      for (let total = 8 * 60 + 30; total <= 9 * 60 + 25; total += 5) {
        const utc = localToUtc(date, Math.floor(total / 60), total % 60, tz);
        if (!hours.has(utc.getUTCHours()) || !minutes.has(utc.getUTCMinutes())) missing.push(`${date} ${utc.toISOString()}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
