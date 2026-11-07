import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import baseConfig from "../config.example.js";
import {
  activeVacations,
  availableParticipants,
  cardFor,
  choose,
  isDue,
  localDay,
  messageText,
  planDay,
  presenterHistory,
  selectionWeights,
  shuffle,
  testCardFor,
  validateConfig,
} from "../src/rotation.js";
import { WebhookRejectedError, announce, postCard, validateWebhook } from "../src/delivery.js";
import {
  loadState,
  loadVacations,
  lockStore,
  saveState,
} from "../src/store.js";

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "teams-rotation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const monday = { date: "2026-10-19", week: "2026-10-19" };
const tuesday = { date: "2026-10-20", week: "2026-10-19" };
const empty = () => ({ version: 1, weeks: {}, days: {} });
const config = {
  ...baseConfig,
  vacations: [
    { personId: "ulises", start: "2026-10-22", end: "2026-11-08" },
  ],
};

test("validates configuration and rejects invalid participant pools and times", () => {
  validateConfig(config);
  for (const participants of [[], ["Alex", "Alex"], [""], [" Alex"], [42]]) {
    assert.throws(() => validateConfig({ ...config, participants }));
  }
  assert.throws(() =>
    validateConfig({
      ...config,
      participants: [
        { id: "bruno", name: "Bruno" },
        { id: "bruno", name: "Brun" },
      ],
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...config,
      participants: [
        { id: "one", name: "Bruno" },
        { id: "two", name: "Bruno" },
      ],
    }),
  );
  for (const announcementTime of ["24:00", "9:00", "12:60"]) {
    assert.throws(() => validateConfig({ ...config, announcementTime }));
  }
  assert.throws(() => validateConfig({ ...config, timeZone: "not-a-zone" }));
  assert.throws(() =>
    validateConfig({
      ...config,
      vacations: [
        { personId: "unknown", start: "2026-10-19", end: "2026-10-20" },
      ],
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...config,
      vacations: [
        { personId: "bruno", start: "2026-02-30", end: "2026-03-01" },
      ],
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...config,
      vacations: [
        { personId: "bruno", start: "2026-10-20", end: "2026-10-19" },
      ],
    }),
  );
});

test("vacations exclude a person only from weeks with a weekday overlap", () => {
  const vacations = [
    { name: "Alex", start: "2026-10-23", end: "2026-10-26" },
    { name: "Blair", start: "2026-10-24", end: "2026-10-25" },
  ];
  assert.deepEqual(
    availableParticipants(["Alex", "Blair", "Casey"], vacations, "2026-10-19"),
    ["Blair", "Casey"],
  );
  assert.deepEqual(
    availableParticipants(["Alex", "Blair", "Casey"], vacations, "2026-10-26"),
    ["Blair", "Casey"],
  );
  assert.deepEqual(
    availableParticipants(["Alex", "Blair", "Casey"], vacations, "2026-10-12"),
    ["Alex", "Blair", "Casey"],
  );
  assert.deepEqual(
    availableParticipants(
      ["Alex"],
      [{ name: "Alex", start: "2026-10-19", end: "2026-10-23" }],
      "2026-10-19",
    ),
    [],
  );
});

test("active vacation notices are unique and include the inclusive end date", () => {
  assert.deepEqual(
    activeVacations(
      [
        { personId: "ines", start: "2026-10-20", end: "2026-10-24" },
        { personId: "ines", start: "2026-10-22", end: "2026-10-27" },
        { personId: "gaspar", start: "2026-10-23", end: "2026-10-30" },
      ],
      "2026-10-22",
    ),
    [{ id: "ines", end: "2026-10-27" }],
  );
  assert.deepEqual(
    activeVacations(
      [{ personId: "ines", start: "2026-10-20", end: "2026-10-24" }],
      "2026-10-25",
    ),
    [],
  );
});

test("local dates, Monday week boundaries, weekends and Santiago DST", () => {
  assert.deepEqual(
    localDay(new Date("2026-10-19T02:00:00Z"), config.timeZone),
    {
      date: "2026-10-18",
      time: "23:00",
      weekday: 0,
      week: "2026-10-12",
    },
  );
  assert.equal(
    localDay(new Date("2026-10-19T12:00:00Z"), config.timeZone).time,
    "09:00",
  );
  assert.equal(
    localDay(new Date("2026-07-20T13:00:00Z"), config.timeZone).time,
    "09:00",
  );
});

test("schedule fires at the threshold, catches up today, and skips weekends", () => {
  assert.equal(isDue({ weekday: 1, time: "08:59" }, "09:00"), false);
  assert.equal(isDue({ weekday: 1, time: "09:00" }, "09:00"), true);
  assert.equal(isDue({ weekday: 5, time: "23:59" }, "09:00"), true);
  assert.equal(isDue({ weekday: 0, time: "10:00" }, "09:00"), false);
  assert.equal(isDue({ weekday: 6, time: "10:00" }, "09:00"), false);
});

test("historical weights select only the least frequent eligible presenters", () => {
  const history = {
    "2026-10-19": "Alex",
    "2026-10-20": "Blair",
    "2026-10-21": "Casey",
  };
  const names = ["Alex", "Blair", "Casey", "Drew"];
  const weights = selectionWeights(names, history, "2026-10-22");
  assert.deepEqual(weights, [0, 0, 0, 1]);
  assert.deepEqual(selectionWeights(["Alex"], history, "2026-10-22"), [1]);
  assert.deepEqual(selectionWeights(names, {}, "2026-10-22"), [1, 1, 1, 1]);
  assert.deepEqual(
    selectionWeights(
      names,
      {
        ...history,
        "2026-10-22": "Alex",
        "2026-10-23": "Alex",
      },
      "2026-10-26",
    ),
    [0, 0, 0, 1],
  );
  const tiedWeights = selectionWeights(
    names,
    {
      "2026-10-21": "Alex",
      "2026-10-22": "Blair",
    },
    "2026-10-23",
  );
  assert.deepEqual(tiedWeights, [0, 0, 1, 1]);
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  for (let i = 0; i < 1100; i++) {
    counts[choose(names, tiedWeights, () => (i + 0.5) / 1100)]++;
  }
  assert.deepEqual(counts, { Alex: 0, Blair: 0, Casey: 550, Drew: 550 });
});

test("shuffle keeps each person exactly once, preserves input, permits all permutations", () => {
  const input = ["A", "B", "C"];
  const results = new Set();
  for (let first = 0; first < 3; first++) {
    for (let second = 0; second < 2; second++) {
      const choices = [first, second];
      const result = shuffle(input, () => choices.shift());
      assert.deepEqual([...result].sort(), input);
      results.add(result.join(""));
    }
  }
  assert.equal(results.size, 6);
  assert.deepEqual(input, ["A", "B", "C"]);
  assert.deepEqual(shuffle(["A"]), ["A"]);
});

test("daily presenter plans remain stable when restored", () => {
  const state = empty();
  const first = planDay(state, config, monday);
  assert.ok(config.participants.some(({ id }) => id === first.presenter));
  assert.equal(planDay(state, config, monday), first);
  assert.deepEqual(
    [...first.order].sort(),
    config.participants.map(({ id }) => id).sort(),
  );
});

test("a missed share remains recorded but is excluded from presenter history", () => {
  const state = empty();
  state.days["2026-11-02"] = {
    presenter: "ines",
    week: "2026-11-02",
    order: ["ines"],
    status: "sent",
    sharingCompleted: false,
  };
  state.days["2026-11-03"] = {
    presenter: "bruno",
    week: "2026-11-02",
    order: ["bruno"],
    status: "sent",
  };

  assert.equal(state.days["2026-11-02"].presenter, "ines");
  assert.deepEqual(presenterHistory(state, config.participants), {
    "2026-11-03": "bruno",
  });
});

test("rotation can restart on a date without deleting send records", () => {
  const state = empty();
  state.rotationStartDate = "2026-11-09";
  state.weeks["2026-10-19"] = "ines";
  state.days["2026-11-06"] = {
    presenter: "ines",
    week: "2026-11-02",
    order: ["bruno", "ines"],
    status: "sent",
  };

  assert.deepEqual(presenterHistory(state, config.participants), {});
  assert.deepEqual(
    selectionWeights(
      config.participants,
      presenterHistory(state, config.participants),
      "2026-11-09",
    ),
    [1, 1, 1, 1, 1, 1],
  );
  const plan = planDay(state, config, {
    date: "2026-11-09",
    week: "2026-11-09",
  });
  assert.ok(config.participants.some(({ id }) => id === plan.presenter));
  assert.equal(state.days["2026-11-06"].status, "sent");
});

test("next draw catches up participants with fewer historical presentations", () => {
  const state = empty();
  state.days = {
    "2026-10-22": { presenter: "ines", status: "sent" },
    "2026-10-26": { presenter: "ximena", status: "sent" },
    "2026-10-27": { presenter: "fabio", status: "sent" },
    "2026-10-28": { presenter: "fabio", status: "sent" },
    "2026-10-29": { presenter: "ximena", status: "sent" },
  };
  const plan = planDay(state, config, {
    date: "2026-10-30",
    week: "2026-10-26",
  });
  assert.ok(["bruno", "gaspar"].includes(plan.presenter));
});

test("rotation stores stable IDs and maps legacy display names from history", () => {
  const state = empty();
  state.weeks["2026-10-12"] = "Inés";
  const plan = planDay(state, config, {
    date: "2026-10-19",
    week: "2026-10-19",
  });
  assert.equal(state.weeks["2026-10-12"], "ines");
  assert.ok(config.participants.some(({ id }) => id === plan.presenter));
  assert.ok(
    plan.order.every((id) =>
      config.participants.some((participant) => participant.id === id),
    ),
  );
  const card = cardFor("2026-10-19", plan, config.participants);
  const text = card.attachments[0].content.body
    .map((block) => block.text)
    .join("\n");
  assert.match(text, /Inés|Bruno|Ximena|Fabio|Ulises|Gaspar/);
  assert.doesNotMatch(text, /ines|bruno|ximena|ulises|gaspar/);
});

test("single-person pools remain usable even when the previous presenter cannot be excluded", () => {
  const state = empty();
  const single = { ...config, participants: ["Alex"] };
  assert.equal(planDay(state, single, monday).presenter, "Alex");
  assert.equal(planDay(state, single, tuesday).presenter, "Alex");
});

test("a vacation change replaces only the unavailable day's pending presenter", () => {
  const state = empty();
  const original = planDay(state, config, monday);
  const originalPresenter = original.presenter;
  const updatedConfig = {
    ...config,
    vacations: [
      { personId: originalPresenter, start: "2026-10-19", end: "2026-10-23" },
    ],
  };
  const updated = planDay(state, updatedConfig, tuesday);
  assert.notEqual(updated.presenter, originalPresenter);
  assert.equal(state.days[monday.date].presenter, originalPresenter);

  state.days[tuesday.date].status = "sent";
  const originalSentPresenter = state.days[tuesday.date].presenter;
  const replacement = planDay(
    state,
    {
      ...config,
      vacations: [
        {
          personId: originalSentPresenter,
          start: "2026-10-20",
          end: "2026-10-23",
        },
      ],
    },
    { date: "2026-10-21", week: monday.week },
  );
  assert.notEqual(replacement.presenter, originalSentPresenter);
  assert.equal(state.days[tuesday.date].presenter, originalSentPresenter);
});

test("people on vacation are absent from that day's sharing choice and speaking order", () => {
  const state = empty();
  const vacationConfig = {
    ...config,
    vacations: [
      { personId: "ulises", start: monday.date, end: "2026-11-08" },
    ],
  };
  const plan = planDay(state, vacationConfig, monday);
  assert.notEqual(plan.presenter, "ulises");
  assert.ok(!plan.order.includes("ulises"));
  assert.equal(plan.order.length, config.participants.length - 1);
  const afterVacation = planDay(state, config, {
    date: "2026-11-09",
    week: "2026-11-09",
  });
  assert.ok(afterVacation.order.includes("ulises"));
});

test("pending saved order is adjusted when vacation dates change", () => {
  const state = empty();
  const vacationDay = { date: "2026-10-22", week: monday.week };
  const initial = planDay(state, { ...config, vacations: [] }, vacationDay);
  assert.ok(initial.order.includes("ulises"));
  const updated = planDay(state, config, vacationDay);
  assert.ok(!updated.order.includes("ulises"));
  assert.equal(updated.order.length, config.participants.length - 1);
  state.days[vacationDay.date].status = "sent";
  const sentOrder = [...state.days[vacationDay.date].order];
  planDay(state, { ...config, vacations: [] }, vacationDay);
  assert.deepEqual(state.days[vacationDay.date].order, sentOrder);
});

test("no eligible sharer fails clearly instead of selecting someone on vacation", () => {
  const vacations = config.participants.map(({ id }) => ({
    personId: id,
    start: "2026-10-19",
    end: "2026-10-23",
  }));
  assert.throws(
    () => planDay(empty(), { ...config, vacations }, monday),
    /No participants are available/,
  );
});

test("Adaptive Card is in Spanish and includes the vacation notice and Chilean date", () => {
  const card = cardFor(
    "2026-11-02",
    {
      presenter: "Ximena",
      order: ["Bruno", "Inés"],
      vacations: [{ name: "Gaspar", end: "2026-11-06" }],
    },
    config.participants,
  );
  const body = card.attachments[0].content.body;
  assert.equal(body[0].text, "Reunión diaria - 02-11-2026");
  assert.equal(body[1].text, "Comparte pantalla hoy: Ximena");
  assert.equal(
    body[2].text,
    "Gaspar está de vacaciones hasta el 06-11-2026 🍹🌴",
  );
  assert.equal(body[3].text, "Orden para hablar hoy");
});

test("console message text matches the Adaptive Card, and test cards are clearly marked", () => {
  const plan = {
    presenter: "Ximena",
    order: ["Bruno", "Inés"],
    vacations: [{ id: "gaspar", end: "2026-11-06" }],
  };
  assert.equal(
    messageText("2026-11-02", plan, config.participants),
    [
      "Reunión diaria - 02-11-2026",
      "Comparte pantalla hoy: Ximena",
      "Gaspar está de vacaciones hasta el 06-11-2026 🍹🌴",
      "Orden para hablar hoy",
      "1. Bruno",
      "2. Inés",
    ].join("\n"),
  );
  const testCard = testCardFor("2026-11-02", plan, config.participants);
  assert.equal(
    testCard.attachments[0].content.body[0].text,
    "🧪 MENSAJE DE PRUEBA",
  );
  assert.deepEqual(
    testCard.attachments[0].content.body.slice(1),
    cardFor("2026-11-02", plan, config.participants).attachments[0].content
      .body,
  );
});

test("delivery persists before posting, skips duplicate days and uses daily presenter history", async (t) => {
  const directory = await temporary(t);
  let calls = 0;
  const send = async (_url, card) => {
    calls++;
    const saved = await loadState(directory);
    assert.equal(saved.days[monday.date].status, "sending");
    assert.deepEqual(
      card,
      cardFor(monday.date, saved.days[monday.date], config.participants),
    );
  };
  const input = { directory, config, day: monday, send };
  assert.equal(await announce(input), "accepted");
  assert.equal(await announce(input), "already-sent");
  assert.equal(calls, 1);
  const state = await loadState(directory);
  assert.equal(state.days[monday.date].status, "sent");
  await announce({ ...input, day: tuesday, send: async () => {} });
  const updated = await loadState(directory);
  assert.notEqual(
    updated.days[tuesday.date].presenter,
    state.days[monday.date].presenter,
  );
});

test("forced send reuses today's plan and can post repeatedly without changing rotation", async (t) => {
  const directory = await temporary(t);
  const sentCards = [];
  const input = {
    directory,
    config,
    day: monday,
    send: async (_url, card) => {
      sentCards.push(card);
    },
  };
  assert.equal(await announce(input), "accepted");
  const before = await loadState(directory);
  assert.equal(await announce({ ...input, force: true }), "accepted");
  assert.equal(await announce({ ...input, force: true }), "accepted");
  const after = await loadState(directory);
  assert.equal(sentCards.length, 3);
  assert.deepEqual(sentCards[0], sentCards[1]);
  assert.deepEqual(sentCards[1], sentCards[2]);
  assert.deepEqual(after, before);
  assert.equal(await announce(input), "already-sent");
});

test("rejected delivery returns to pending; interrupted delivery blocks automatic retries; explicit retry reuses the plan", async (t) => {
  const url = "https://webhook.test/hook";
  const posted = [];
  let behavior;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    posted.push(JSON.parse(init.body));
    return behavior();
  });

  // HTTP 500: rejected -> pending, retried automatically with the same plan.
  const rejectedDirectory = await temporary(t);
  const rejected = { directory: rejectedDirectory, config, day: monday, url };
  behavior = () => new Response("err", { status: 500 });
  await assert.rejects(announce({ ...rejected, send: postCard }), (error) => {
    assert.ok(error instanceof WebhookRejectedError);
    assert.equal(error.status, 500);
    assert.match(error.message, /Webhook returned HTTP 500\. Check the Workflow run history/);
    return true;
  });
  const pending = (await loadState(rejectedDirectory)).days[monday.date];
  assert.equal(pending.status, "pending");
  behavior = () => new Response("ok", { status: 200 });
  assert.equal(await announce({ ...rejected, send: postCard }), "accepted");
  const sent = (await loadState(rejectedDirectory)).days[monday.date];
  assert.equal(sent.status, "sent");
  assert.equal(sent.presenter, pending.presenter);
  assert.deepEqual(sent.order, pending.order);
  assert.equal(posted.length, 2);

  // Network failure / timeout: uncertain -> sending, blocks automatic retries.
  const directory = await temporary(t);
  const input = { directory, config, day: monday, url };
  behavior = () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    announce({ ...input, send: postCard }),
    (error) => !(error instanceof WebhookRejectedError) && /network error or timeout/.test(error.message),
  );
  const before = await loadState(directory);
  assert.equal(before.days[monday.date].status, "sending");
  let calls = 0;
  const send = async () => {
    calls++;
  };
  await assert.rejects(announce({ ...input, send }), /Delivery is uncertain/);
  assert.equal(calls, 0);
  await announce({ ...input, send, retry: true });
  const after = await loadState(directory);
  assert.deepEqual(after.days[monday.date], {
    ...before.days[monday.date],
    status: "sent",
  });
  assert.equal(calls, 1);
});

test("locks exclude a second instance and release cleanly", async (t) => {
  const directory = await temporary(t);
  const release = await lockStore(directory);
  await assert.rejects(lockStore(directory), /Another instance/);
  assert.equal(
    (await readFile(path.join(directory, "rotation.lock"), "utf8")).trim(),
    `${process.pid}`,
  );
  await release();
  const again = await lockStore(directory);
  await again();
});

test("corrupt and structurally invalid state fail loudly without resetting data", async (t) => {
  const directory = await temporary(t);
  for (const invalid of [
    "{",
    '{"version":2,"weeks":{},"days":{}}',
    '{"version":1,"weeks":{"2026-02-30":"Alex"},"days":{}}',
    '{"version":1,"weeks":{},"days":{"2026-10-19":{"status":"sent"}}}',
  ]) {
    await writeFile(path.join(directory, "state.json"), invalid);
    await assert.rejects(loadState(directory));
    assert.equal(
      await readFile(path.join(directory, "state.json"), "utf8"),
      invalid,
    );
  }
});

test("vacations are loaded separately and survive clearing monthly rotation state", async (t) => {
  const directory = await temporary(t);
  const vacations = [
    { personId: "bruno", start: "2026-11-02", end: "2026-11-06" },
  ];
  await writeFile(
    path.join(directory, "vacations.json"),
    JSON.stringify(vacations),
  );
  await writeFile(path.join(directory, "state.json"), JSON.stringify(empty()));
  assert.deepEqual(await loadVacations(directory), vacations);
  await rm(path.join(directory, "state.json"));
  assert.deepEqual(await loadVacations(directory), vacations);
  await assert.rejects(
    loadVacations(path.join(directory, "missing")),
    /Missing .*vacations\.json/,
  );
});

test("state persistence omits vacation snapshots while loaded plans rebuild notices", async (t) => {
  const directory = await temporary(t);
  const state = empty();
  const plan = planDay(state, config, {
    date: "2026-10-22",
    week: "2026-10-19",
  });
  assert.deepEqual(plan.vacations, [{ id: "ulises", end: "2026-11-08" }]);
  await saveState(directory, state);

  const persisted = JSON.parse(
    await readFile(path.join(directory, "state.json"), "utf8"),
  );
  assert.equal("vacations" in persisted.days["2026-10-22"], false);
  const reloaded = await loadState(directory);
  const rebuilt = planDay(reloaded, config, {
    date: "2026-10-22",
    week: "2026-10-19",
  });
  assert.deepEqual(rebuilt.vacations, [{ id: "ulises", end: "2026-11-08" }]);
});

test("loads daily plans from earlier versions that did not store their week", async (t) => {
  const directory = await temporary(t);
  const legacy = {
    version: 1,
    weeks: { "2026-10-19": "Alex" },
    days: {
      "2026-10-19": {
        presenter: "Alex",
        order: ["Alex", "Blair"],
        status: "sent",
      },
    },
  };
  await writeFile(path.join(directory, "state.json"), JSON.stringify(legacy));
  assert.deepEqual(await loadState(directory), legacy);
});

test("webhook URL validation requires HTTPS and never leaks the secret", () => {
  for (const value of [
    undefined,
    "secret",
    "http://example.com/secret",
    "https://u:p@example.com",
  ]) {
    assert.throws(
      () => validateWebhook(value),
      (error) => !error.message.includes("secret"),
    );
  }
  assert.equal(
    validateWebhook("https://example.com/path?sig=secret").protocol,
    "https:",
  );
});

test("HTTP boundary posts an Adaptive Card, accepts 202, rejects failures and redirects", async (t) => {
  let status = 202;
  let captured;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = {
      method: request.method,
      type: request.headers["content-type"],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    response.writeHead(
      status,
      status === 302 ? { Location: "/redirected" } : {},
    );
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}/secret`;
  const card = cardFor(monday.date, {
    presenter: "Alex",
    order: ["Blair", "Alex"],
  });
  await postCard(url, card);
  assert.deepEqual(captured, {
    method: "POST",
    type: "application/json",
    body: card,
  });
  assert.equal(
    card.attachments[0].contentType,
    "application/vnd.microsoft.card.adaptive",
  );
  status = 429;
  await assert.rejects(postCard(url, card), /HTTP 429/);
  status = 302;
  await assert.rejects(postCard(url, card), /network error/);
});

test("CLI preview commands do not need a webhook; posting commands report missing configuration", async (t) => {
  // A throwaway data directory: the real data/ is local and gitignored, so it doesn't exist in CI.
  const dataDir = await mkdtemp(path.join(tmpdir(), "teams-bot-cli-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  // One participant is always away, so the "one fewer speaker" checks below don't depend on today's date.
  await writeFile(
    path.join(dataDir, "vacations.json"),
    JSON.stringify([{ personId: config.participants.at(-1).id, start: "2000-01-01", end: "2999-12-31" }]),
  );
  const run = (args) =>
    spawnSync(process.execPath, ["src/cli.js", ...args], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        TEAMS_WEBHOOK_URL: "",
        TEAMS_BOT_DATA_DIR: dataDir,
        // config.js (real names) is gitignored; the CLI runs on the example, like the rest of the tests.
        TEAMS_BOT_CONFIG: "config.example.js",
      },
      encoding: "utf8",
    });
  const preview = run(["--preview"]);
  assert.equal(preview.status, 0, preview.stderr);
  const previewCard = JSON.parse(preview.stdout).attachments[0].content;
  assert.equal(previewCard.type, "AdaptiveCard");
  assert.match(
    previewCard.body[0].text,
    /^Reunión diaria - \d{2}-\d{2}-\d{4}$/,
  );
  assert.ok(
    previewCard.body.some((item) => item.text === "Orden para hablar hoy"),
  );
  assert.equal(
    previewCard.body.filter((item) =>
      config.participants.some(
        ({ name }) =>
          item.text.match(/^\d+\. /)?.[0] && item.text.endsWith(name),
      ),
    ).length,
    config.participants.length - 1,
  );
  const show = run(["--show"]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /^Reunión diaria - \d{2}-\d{2}-\d{4}\n/);
  assert.match(show.stdout, /Comparte pantalla hoy: \S+/);
  assert.match(show.stdout, /Orden para hablar hoy/);
  assert.equal(
    show.stdout
      .trim()
      .split("\n")
      .filter((line) => /^\d+\. /.test(line)).length,
    config.participants.length - 1,
  );
  const missing = run(["--once"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Set TEAMS_WEBHOOK_URL/);
  const missingTestWebhook = run(["--test-message"]);
  assert.equal(missingTestWebhook.status, 1);
  assert.match(missingTestWebhook.stderr, /Set TEAMS_WEBHOOK_URL/);
  const missingSendWebhook = run(["--send"]);
  assert.equal(missingSendWebhook.status, 1);
  assert.match(missingSendWebhook.stderr, /Set TEAMS_WEBHOOK_URL/);
  const bad = run(["--retry"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage/);
});
