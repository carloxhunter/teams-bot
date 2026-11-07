# Teams daily rotation

A small Node.js 20.12+ app that posts a daily Adaptive Card to a Teams chat using
a **Teams Workflow webhook**. It does not join meetings or speak aloud.
No npm dependencies, Azure bot registration, or database server are required.

This repository is public: it holds **no keys, webhook URLs or real names**. The webhook URL lives in `.env`
(gitignored), and the team's names, rotation history and vacations live in `config.js` and `data/` (gitignored).
Never commit them.

Development uses Node 22 (`.nvmrc`) and pnpm 10: `pnpm install`, `pnpm test`, `pnpm lint`. The `npm run …`
commands below work the same with `pnpm`.

Roadmap: run it as a Cloudflare Worker with a cron trigger and D1 storage, then an admin page (Auth0, invite-only)
to manage vacations, the rotation log and manual sends.

## Setup

1. Copy [config.example.js](./config.example.js) to `config.js` (gitignored: it holds the real team's
   names, keep it out of the repo) and set the participant IDs, display names, timezone and announcement time.
   IDs are stable internal identifiers (they are not Microsoft Teams IDs); keep
   them unchanged if someone changes their display name. Add planned time away
   to [data/vacations.json](./data/vacations.json), using one JSON object per
   date range; dates are inclusive `YYYY-MM-DD` values, for example:

   ```json
   [{ "personId": "bruno", "start": "2026-11-02", "end": "2026-11-06" }]
   ```

2. In Teams, open **Workflows** and choose the template for posting to a chat when
   a webhook request is received (or build a flow with **When a Teams webhook
   request is received**, followed by posting the received Adaptive Card).
   Choose the target group/meeting chat if available in your tenant.
3. This app sends no Microsoft identity token: the webhook trigger must allow
   **Anyone**. Only use that setting if permitted by your organization. If your
   tenant requires authenticated callers, this implementation needs OAuth
   integration before use. Keep the generated URL secret; possession permits posting.
4. Copy `.env.example` to `.env` and set `TEAMS_WEBHOOK_URL` locally. Do not paste
   the URL into chat or commit it. Add a co-owner to the Workflow for continuity.
5. Run:

   ```sh
   npm test
   npm run show
   npm run preview
   npm run send
   npm run test-message
   npm run once
   npm start
   ```

`show` prints the Spanish message as readable text in the console. `preview`
prints a fresh sample of the webhook JSON. Both use the current participant/
vacation config and presenter history, without posting or modifying saved history;
the preview order is a sample, not a reserved assignment.
`test-message` posts a clearly marked test card to Teams immediately, at any
time, and does not change daily send status or rotation history. It requires the
configured webhook and sends a real message to the target chat. Use it to verify
the connection even if today's regular announcement was already sent.
`send` posts today's normal daily card immediately, at any time, using the saved
rotation for the day. Unlike `once`, it can resend even if today's card is already
marked sent; repeated runs post duplicate messages with the same saved order. It
records today's rotation and sent status in `data/state.json`; subsequent runs
reuse that same order. Use this development command to check the actual channel
rendering.
`once` posts immediately, including before 09:00 or on weekends. It is a real
message, not a dry run. It posts today's regular announcement only if it has not
already been sent; use `send` to deliberately resend the regular card or
`test-message` to post a separately marked test card.

`start` runs continuously. Defaults: Monday-Friday at 09:00, `America/Santiago`,
including local daylight-saving changes. It checks every 30 seconds and catches
up **only today's** announcement if started after the scheduled time. Holidays
are not excluded. Keep the process on an awake, always-on machine for unattended
operation; running this command once does not install a system service.

Cards are written in Spanish, with dates formatted `DD-MM-YYYY`. Add each
vacation to `data/vacations.json`; on each weekday during those
dates, the same daily card in the configured Teams chat will include a line such
as `Bruno está de vacaciones hasta el 06-11-2026 🍹🌴`. The end date is inclusive.
The vacation list is separate from `data/state.json`, so clearing or replacing
the monthly rotation history does not remove vacation entries. Keep the
`data/vacations.json` file and its backup when cleaning `state.json`. If a
vacation is added after that day's message was already sent, it will show in the
next scheduled announcement while the person is still on vacation; the app will
not post a second daily message automatically.

## Rotation rules

- A screen-sharing person is selected independently for each announcement day.
- Anyone actively on vacation that day is excluded from both the sharer draw and
  that day's speaking order. If a saved presenter becomes unavailable before the
  announcement is sent, the next run selects an available replacement. Pending
  speaking orders are adjusted too; already-sent messages are left unchanged. A
  vacation covering everyone's availability on a day stops delivery with a clear error.
  The presenter is selected randomly from eligible participants with the fewest
  recorded presentations. Participants with more historical presentations have
  zero chance until the least-selected group catches up; ties are equally likely.
  This balances the full recorded history rather than only excluding yesterday's
  presenter. Only completed sharing turns count: a day with
  `sharingCompleted: false` remains in the state for auditing but is omitted from
  future rotation history. Older entries without this field count as completed.
- Each day uses an independent Fisher-Yates shuffle: everyone available that day
  appears exactly once in the speaking order. Repeating an order or first speaker
  on different days is allowed.
- Historical daily plans are used as presenter history. Existing weekly history
  is retained and used as a fallback where no daily plan exists for that week.

## Persistence and failures

Keep and back up `data/state.json`: it holds legacy weekly history, daily plans and send
status. `rotationStartDate` can reset fairness history from a given date without
deleting daily plans or duplicate protection. Deleting the file loses both, but does not
remove vacations. `data/vacations.json` is loaded separately and must be kept
when cleaning the monthly state. Do not edit either file while the app runs.
Vacation notices are derived from `data/vacations.json` and are not copied into
`state.json`.
Invalid/corrupt state stops the app instead of silently resetting it. Existing
saved state without a `week` field on daily plans remains supported.

One instance may use a data folder at a time. A lock prevents overlapping runs;
stop the scheduler before using `once`. After a hard crash a stale
`data/rotation.lock` can remain: check the recorded PID and remove **only that
lock file** after confirming the process is gone.

Assignments are saved **before** posting. If the webhook answers with a non-2xx
HTTP status, the day returns to `pending` and the same plan is retried
automatically on the next run. Network errors and timeouts stop the process with
a nonzero exit code and leave the day `sending` (blocked): a crash or timeout can
happen after Teams accepted a message, and exactly-once delivery cannot be
guaranteed by this webhook. The app blocks automatic resend of an uncertain attempt. Inspect the chat and
Workflow run history, then, **only if no message was posted**, run:

```sh
npm run once -- --retry
```

This retries today's saved plan without rerolling it. If the card was posted,
do not retry; wait until the next day and restart the scheduler. No historical
catch-up or automatic network retries are performed. A 2xx response only confirms
webhook acceptance, not successful completion of the Workflow; monitor its run
history for downstream failures.

Microsoft's [webhook documentation](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
links to Workflow creation and explains why new integrations should use Workflows
rather than the retiring Microsoft 365 connectors.

## Cloudflare Worker

The same rotation also runs as a Cloudflare Worker (`src/worker/index.js`) driven
by a cron trigger; the Node CLI above keeps working unchanged.

- **Cron:** `0,15,30 12,13 * * 1-5` (UTC). Cron is UTC-only, so it fires at both
  12:xx and 13:xx to cover Chile's DST changes. On each run the Worker converts the
  time to `TIME_ZONE` (`America/Santiago`) and only acts on a weekday at or after
  `ANNOUNCEMENT_TIME` (`09:00`) and before one hour later. The extra triggers retry
  a rejected post within that window; a day already sent is never posted twice.
- **Holidays:** Chilean public holidays live in the `holidays` D1 table (seeded by
  `migrations/0002_holidays_cl.sql`, 2026-2027; verify against an official source
  and add later years with a new migration). Holidays are skipped.
- **D1 tables:** `participants`, `vacations`, `days`, `weeks`, `meta`, `holidays`.
- **No HTTP endpoints:** every request returns 404 and never touches the database.
- **Secrets:** `TEAMS_WEBHOOK_URL` is a secret, never a var.

### First deploy / data migration

1. `npx wrangler login`
2. `npx wrangler d1 migrations apply teams-bot --remote`
3. `pnpm migrate:d1 <path outside the repo>.sql`, then
   `npx wrangler d1 execute teams-bot --remote --file <that file>`, then delete the file.
4. `npx wrangler secret put TEAMS_WEBHOOK_URL`
5. `pnpm deploy`
6. Stop the old local scheduler so it does not post twice.
7. Verify the holidays: `npx wrangler d1 execute teams-bot --remote --command "SELECT * FROM holidays"`.
