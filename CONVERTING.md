# Converting a traditional recipe

How to turn a prose recipe into teatime's JSON format. One file per recipe in
`data/`, filename is the recipe id, all times in seconds from recipe start.

## Method

1. **Ingredients** — copy the list as-is, one string per item, keeping
   quantities.

2. **Break the method into steps.** Each step gets a short imperative name
   (it has to fit on a timeline block), fuller instructions (temperatures,
   cues like "until golden"), and a duration. Use stated times where given;
   estimate hands-on tasks realistically (chopping an onion: 3–5m). Round
   to 30s.

3. **Mark each step active or passive.** Passive time (oven, simmering,
   resting, marinating) runs unattended. The word "meanwhile" almost always
   marks an active step that belongs inside someone else's passive window.

4. **Choose lanes.** A lane is an independent workstream — usually one per
   component (Chicken, Potatoes, Gravy), sometimes per station (Oven, Hob).
   Steps in a lane cannot overlap, so anything simultaneous needs its own
   lane. 2–5 lanes is typical.

5. **Schedule backwards from serving.** Everything served hot ends at total
   time T; resting steps end at T by design. Chain each lane backwards:
   step start = next step's start − duration. Slot "meanwhile" steps into
   the passive windows they run during. Then shift the whole recipe so the
   earliest step starts at 0.

6. **Sanity-check the cook.** One person is cooking: avoid two active steps
   at the same moment in different lanes — move one into a passive window.
   Passive overlap is the whole point; active overlap is a mistake.

## Checks

- No overlapping steps within a lane.
- Every "meanwhile" from the original has its own lane and sits inside the
  window it was meant for.
- Hot components all end at (or within a couple of minutes of) T.
- Durations ≥ 30s; ids prefixed `l-` / `s-`; steps reference an existing
  lane id.

## Worked example

Original: "Fry the sausages for 25 minutes, turning. Meanwhile, boil the
potatoes for 20 minutes, then mash with butter. For the gravy, slowly
caramelise sliced onions, stir in flour and stock and simmer until thick."

| Lane     | Step                 | Start | Duration |
|----------|----------------------|-------|----------|
| Sausages | Fry sausages         | 15m   | 25m      |
| Mash     | Peel and chop        | 5m    | 10m      |
| Mash     | Boil potatoes        | 15m   | 20m      |
| Mash     | Drain and mash       | 35m   | 5m       |
| Gravy    | Slice onions         | 0     | 5m       |
| Gravy    | Caramelise onions    | 5m    | 20m      |
| Gravy    | Flour, stock, simmer | 25m   | 15m      |

All three lanes end at 40m. The onions caramelise (passive) while the
potatoes are peeled; the sausages need only turning while the mash and
gravy finish. Full version: `data/bangers-and-mash.json`.

## Fetching source pages

Several recipe sites don't serve their recipe in the initial HTML, and some
block automated fetchers. Per-site methods, endpoints and quirks are in
[FETCHING.md](FETCHING.md). Note that stated total times are marketing figures
and usually assume overlaps a single cook can't perform — trust the step times.

## Publishing to the remote instance

The deployed site sits behind Caddy basic auth. Connection details live in
`.teatime-remote` at the repo root (untracked):

```
TEATIME_URL=https://tea.example.com
TEATIME_AUTH=user:password
```

Push a converted recipe with:

```
curl -u "$TEATIME_AUTH" -X POST -H "Content-Type: application/json" \
  --data-binary @recipe.json "$TEATIME_URL/api/recipes"
```

The server assigns the id from the recipe name. Without `.teatime-remote`,
save converted recipes locally under `data/` instead.
