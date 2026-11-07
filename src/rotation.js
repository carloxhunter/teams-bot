import { randomInt } from "node:crypto";

const DAY = 86_400_000;

export function validateConfig(config) {
  if (
    !Array.isArray(config.participants) ||
    config.participants.length === 0 ||
    config.participants.some((participant) => {
      const id = participantId(participant);
      const name = participantName(participant);
      return (
        typeof id !== "string" ||
        !id.trim() ||
        id !== id.trim() ||
        typeof name !== "string" ||
        !name.trim() ||
        name !== name.trim()
      );
    }) ||
    new Set(config.participants.map(participantId)).size !==
      config.participants.length ||
    new Set(config.participants.map(participantName)).size !==
      config.participants.length
  ) {
    throw new Error(
      "participants must contain unique, nonempty, trimmed IDs and display names.",
    );
  }
  if (typeof config.timeZone !== "string" || !config.timeZone) {
    throw new Error("timeZone must be an IANA timezone.");
  }
  new Intl.DateTimeFormat("en", { timeZone: config.timeZone });
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.announcementTime)) {
    throw new Error("announcementTime must be HH:mm in 24-hour format.");
  }
  if (
    !Array.isArray(config.vacations) ||
    config.vacations.some(
      (vacation) =>
        !vacation ||
        typeof vacation !== "object" ||
        !config.participants.some(
          (participant) =>
            participantId(participant) === vacationId(vacation) ||
            participantName(participant) === vacationId(vacation),
        ) ||
        !isDate(vacation.start) ||
        !isDate(vacation.end) ||
        vacation.start > vacation.end,
    )
  ) {
    throw new Error(
      "vacations must contain a participant ID and valid start/end dates in YYYY-MM-DD format.",
    );
  }
}

function participantId(participant) {
  return typeof participant === "string" ? participant : participant?.id;
}

function participantName(participant) {
  return typeof participant === "string" ? participant : participant?.name;
}

function vacationId(vacation) {
  return vacation.personId ?? vacation.id ?? vacation.name;
}

function resolveId(value, participants) {
  const participant = participants.find(
    (item) => participantId(item) === value || participantName(item) === value,
  );
  return participant ? participantId(participant) : value;
}

function displayName(value, participants) {
  const participant = participants.find(
    (item) => participantId(item) === value || participantName(item) === value,
  );
  return participant ? participantName(participant) : value;
}

function isDate(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function localDay(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return {
    date,
    time: `${parts.hour}:${parts.minute}`,
    weekday,
    week: weekOf(date),
  };
}

export function weekOf(date) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

export function isDue(day, announcementTime) {
  return day.weekday !== 0 && day.weekday !== 6 && day.time >= announcementTime;
}

export function selectionWeights(participants, history, date) {
  const dates = Object.keys(history)
    .filter((key) => key < date)
    .sort();
  const counts = new Map(
    participants.map((participant) => [participantId(participant), 0]),
  );
  for (const key of dates) {
    const id = resolveId(history[key], participants);
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
  }
  const fewestPresentations = Math.min(...counts.values());
  return participants.map((participant) => {
    return counts.get(participantId(participant)) === fewestPresentations
      ? 1
      : 0;
  });
}

export function availableParticipants(participants, vacations, week) {
  const monday = Date.parse(`${week}T00:00:00Z`);
  const friday = monday + 4 * DAY;
  return participants.filter(
    (participant) =>
      !vacations.some(
        (vacation) =>
          vacationId(vacation) === participantId(participant) &&
          Date.parse(`${vacation.start}T00:00:00Z`) <= friday &&
          Date.parse(`${vacation.end}T00:00:00Z`) >= monday,
      ),
  );
}

export function choose(participants, weights, random = Math.random) {
  let ticket = random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < participants.length; i++) {
    ticket -= weights[i];
    if (ticket < 0) return participants[i];
  }
  throw new Error(
    "Unable to select participant: invalid weights or random source.",
  );
}

export function shuffle(participants, pick = randomInt) {
  const result = [...participants];
  for (let i = result.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function activeVacations(vacations, date) {
  const endByPerson = new Map();
  for (const vacation of vacations) {
    if (vacation.start <= date && date <= vacation.end) {
      const id = vacationId(vacation);
      const currentEnd = endByPerson.get(id);
      if (!currentEnd || vacation.end > currentEnd)
        endByPerson.set(id, vacation.end);
    }
  }
  return [...endByPerson].map(([id, end]) => ({ id, end }));
}

function availableSpeakers(order, participants, vacations) {
  const unavailable = new Set(vacations.map(({ id }) => id));
  const ids = participants.map(participantId);
  const speakers = new Set(
    order.filter((id) => ids.includes(id) && !unavailable.has(id)),
  );
  for (const id of ids) {
    if (!unavailable.has(id)) speakers.add(id);
  }
  return [...speakers];
}

export function presenterHistory(state, participants) {
  const history = {};
  const isInRotation = (date) =>
    !state.rotationStartDate || date >= state.rotationStartDate;
  for (const [date, plan] of Object.entries(state.days)) {
    if (isInRotation(date) && plan.sharingCompleted !== false) {
      history[date] = resolveId(plan.presenter, participants);
    }
  }
  for (const [week, presenter] of Object.entries(state.weeks)) {
    if (
      isInRotation(week) &&
      !Object.entries(state.days).some(
        ([date, plan]) =>
          weekOf(date) === week &&
          isInRotation(date) &&
          plan.sharingCompleted !== false,
      )
    ) {
      history[week] = resolveId(presenter, participants);
    }
  }
  return history;
}

export function planDay(state, config, day) {
  for (const [week, presenter] of Object.entries(state.weeks)) {
    state.weeks[week] = resolveId(presenter, config.participants);
  }
  const vacations = activeVacations(config.vacations, day.date);
  const unavailable = new Set(vacations.map(({ id }) => id));
  const eligible = config.participants.filter(
    (participant) => !unavailable.has(participantId(participant)),
  );
  if (eligible.length === 0) {
    throw new Error(
      `No participants are available to share screen on ${day.date}.`,
    );
  }

  if (state.days[day.date]) {
    const savedPlan = state.days[day.date];
    savedPlan.vacations = vacations;
    if (savedPlan.status === "pending") {
      savedPlan.presenter = resolveId(savedPlan.presenter, config.participants);
      savedPlan.order = savedPlan.order.map((id) =>
        resolveId(id, config.participants),
      );
      savedPlan.order = availableSpeakers(
        savedPlan.order,
        config.participants,
        vacations,
      );
      if (
        !eligible.some(
          (participant) => participantId(participant) === savedPlan.presenter,
        )
      ) {
        savedPlan.presenter = participantId(
          choose(
            eligible,
            selectionWeights(
              eligible,
              presenterHistory(state, config.participants),
              day.date,
            ),
          ),
        );
      }
    }
    return savedPlan;
  }
  const presenter = participantId(
    choose(
      eligible,
      selectionWeights(
        eligible,
        presenterHistory(state, config.participants),
        day.date,
      ),
    ),
  );
  const plan = {
    presenter,
    week: day.week,
    order: shuffle(
      config.participants.filter(
        (participant) =>
          !vacations.some(
            (vacation) => vacation.id === participantId(participant),
          ),
      ),
    ).map(participantId),
    vacations,
    status: "pending",
  };
  state.days[day.date] = plan;
  return plan;
}

export function cardFor(date, plan, participants = []) {
  const nameFor = (id) => displayName(id, participants);
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body: [
            {
              type: "TextBlock",
              text: `Reunión diaria - ${date.split("-").reverse().join("-")}`,
              weight: "Bolder",
              size: "Large",
              wrap: true,
            },
            {
              type: "TextBlock",
              text: `Comparte pantalla hoy: ${nameFor(plan.presenter)}`,
              wrap: true,
            },
            ...(plan.vacations ?? []).map(({ id, name, end }) => ({
              type: "TextBlock",
              text: `${nameFor(id ?? name)} está de vacaciones hasta el ${end.split("-").reverse().join("-")} 🍹🌴`,
              wrap: true,
            })),
            {
              type: "TextBlock",
              text: "Orden para hablar hoy",
              weight: "Bolder",
              wrap: true,
            },
            ...plan.order.map((id, i) => ({
              type: "TextBlock",
              text: `${i + 1}. ${nameFor(id)}`,
              wrap: true,
            })),
          ],
        },
      },
    ],
  };
}

export function testCardFor(date, plan, participants = []) {
  const card = cardFor(date, plan, participants);
  card.attachments[0].content.body.unshift({
    type: "TextBlock",
    text: "🧪 MENSAJE DE PRUEBA",
    weight: "Bolder",
    wrap: true,
  });
  return card;
}

export function messageText(date, plan, participants = []) {
  return cardFor(date, plan, participants)
    .attachments[0].content.body.map((block) => block.text)
    .join("\n");
}
