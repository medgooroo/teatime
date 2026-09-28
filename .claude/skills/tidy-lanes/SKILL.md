---
name: tidy-lanes
description: Tidy Guardian-converted recipe timelines on the live teatime server in small batches — rebuild lanes, overlaps, durations and alarms against the original published method, validate, PUT back, mark tidied. Use when asked to tidy/curate recipe lanes or "do another batch".
---

# Tidy recipe lanes

The Guardian importer converts prose mechanically (see CONVERTING.md): one
"Main" lane, a second "Alongside" lane only when a "meanwhile" step happens to
fit, 2-minute filler durations where the prose states none, and no backward
scheduling. Tidying is the judgment pass the converter can't do. The owner has
said the live server is theirs and can be hammered freely.

**Server: https://tea.nominallysafe.org** — no auth, plain JSON API.

## Batch flow (5–10 recipes per batch)

1. **Backup first, every session** (not every batch):
   `curl -s https://tea.nominallysafe.org/api/backup -o "$TEMP/teatime-backup-<date>.tar.gz"`
   Tell the owner where it landed.

2. **Pick the batch.** Untidied pool: `GET /api/recipes?tidied=0&limit=0`
   (`X-Total-Count` is the progress denominator). Priority order:
   - starred first: `GET /api/recipes?starred=1&tidied=0`
   - then worst conversions. Fetch full recipes and prefer: a single lane
     whose instructions contain "meanwhile"/"while the"; totalSeconds far above
     the stated timings in the description; runs of identical 120s steps.

3. **Per recipe, fetch both views:**
   - `GET /api/recipes/{id}` — current timeline (and fields to preserve)
   - `GET /api/recipes/{id}/source` — the method as published: ingredients,
     numbered instructions, stated serves/timings. This is ground truth.

4. **Rebuild the timeline** to the criteria below. Edit the JSON, don't start
   from scratch: preserve `name`, `description`, `ingredients`, `source`,
   `starred`, `hidden` exactly; replace `lanes` and `steps`; add
   `"tidied": true`.

5. **Validate the whole batch before writing anything:** save the candidate
   JSONs to a temp dir and run
   `go run validate.go -data <tempdir>`
   (checks: steps start at 0, no overlap within a lane, real lane refs,
   positive durations, valid alarms). Fix anything it flags.

6. **PUT each recipe back:**
   `curl -X PUT https://tea.nominallysafe.org/api/recipes/{id} -H 'Content-Type: application/json' --data-binary @file.json`
   The response echoes the saved recipe — confirm `"tidied": true` survived.
   If it doesn't, the server predates the tidied field: stop and tell the
   owner a deploy is needed.

7. **Report the batch** for review: per recipe — lanes before → after, total
   before → after vs the stated timing, what was parallelised, alarms added.
   The owner reviews in the editor (`/editor.html?id=…`) or by cooking.

## What a good timeline looks like

- **Lanes are stations, not "Main"**: Oven, Hob, Prep, Grill, Rest — a lane is
  occupied when that appliance or the cook's hands are. 2–4 lanes; the phone
  lane column is narrow, keep names short.
- **The cook exists once.** Hands-on steps must never overlap each other, even
  across lanes. Only genuinely unattended stretches (oven, simmer, chill,
  rest, prove, marinate) run under other work.
- **Honest durations.** Replace 2m fillers with a real estimate of the work
  described; prose ranges take the upper end; rounding to 30s is plenty.
- **Alarms where the cook isn't looking**: `end` on every unattended stretch
  ("take it out"), `start` when something must begin dead on time while
  attention is elsewhere. Attended steps need no alarm.
- **Finish together.** The last steps should converge; no dead time at the
  front (validate enforces start at 0); total should be within ~15% of the
  Guardian's stated timing unless the prose is clearly wrong.
- **Step text**: `name` is a short imperative ("Crisp the guanciale");
  `instructions` stay faithful to the published wording — cooks read them
  mid-cook on the step card. Ids: lanes `l-oven`-style, steps `s-01`… in
  cooking order.

## Bookkeeping

- `"tidied": true` in the PUT body is the only marker; progress is
  `X-Total-Count` on `GET /api/recipes?tidied=0` vs `/api/recipes`.
- Never mark a recipe tidied without actually reworking or explicitly
  confirming its timeline was already sound (that also counts — some convert
  fine; say so in the report).
- Skip hidden recipes entirely (`?tidied=0` already excludes them).
