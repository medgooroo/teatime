# teatime

Timeline-based recipe site. Recipes are laid out on a timeline with parallel
lanes so all the "meanwhile" steps in a recipe become visible, schedulable
blocks. The eventual goal: load one or more recipes onto a live timeline and
have everything finish at the same time.

## Run

```
go run .
```

Then open http://localhost:8080. Flags: `-addr :8080`, `-data data`, `-static static`.

The server logs the address it actually bound. If another process already holds
IPv4 on that port, Go will bind IPv6 only and the server answers on `[::1]` but
not `127.0.0.1` — the log warns when this happens. Use `-addr :8090` to avoid it.

## Guardian recipes

The Guardian's Feast backend is public and serves structured recipes (parsed
ingredients, ordered steps, timings), so they can be imported directly.

- **Check for new recipes** on the home page fetches the index and imports
  anything not already held, up to 200 at a time.
- `./teatime -import-guardian` does the same with no limit, then exits. Use it
  for the first bulk import.

Imported recipes carry a `source` block recording the Guardian id and article
URL; that id is what a later sync checks against, so nothing is imported twice.
It also backs `GET /api/recipes/{id}/source`, which returns the recipe as
published — the editor shows it in an **Original** panel so you can rework the
timeline against the real method.

**Deleting an imported recipe makes it stay deleted.** Its Guardian id is
recorded in `data/.guardian-deleted.json` and skipped by every later check,
which reports how many it left out. To undo, press "Bring back N deleted" in
that report, or `POST /api/guardian/sync?forget=1`. Recipes the Guardian
indexes but won't serve are tracked the same way in
`data/.guardian-unavailable.json`.

Conversion is mechanical: step durations are read out of the prose where stated
("simmer for 25 minutes"), unattended stretches get an end alarm, and a step
beginning "meanwhile" moves into a parallel lane if it fits inside the passive
window before it. It does **not** schedule backwards from serving so components
land together — that still needs a person. See [CONVERTING.md](CONVERTING.md)
for the method and [FETCHING.md](FETCHING.md) for the API.

## Search

The home page has two boxes. The first matches names, descriptions and
ingredients; the second takes a comma-separated ingredient list and returns
only recipes containing **all** of them. Matching is substring-based, so
`chicken` also matches `chicken stock`.

## Stars

Star a recipe to shortlist it for the week ahead — the star sits in the corner
of each card, and starred recipes get a "This week" section at the top of the
home page. Stars live on the recipe (`"starred": true`), not in the browser, so
they are the same on every device.

`POST /api/recipes/{id}/star?on=1` sets it, `?on=0` clears it, and
`GET /api/recipes?starred=1` lists them.

## Check the data

```
go run validate.go
```

Verifies every recipe in `data/`: steps start at 0, no two steps overlap within a
lane, every step references a real lane, durations are positive and alarm values
are valid.

## Storage

One JSON file per recipe in `data/`, filename is the recipe id. Times are
seconds from recipe start. Saved meals (combinations of recipes cooked to
finish together) live in `data/meals/`.

To convert a traditional prose recipe into this format, see
[CONVERTING.md](CONVERTING.md).

## API

| Method | Path              | Purpose                           |
|--------|-------------------|-----------------------------------|
| GET    | /api/recipes      | List summaries, `?q=` to search   |
| POST   | /api/recipes      | Create, id generated from name    |
| GET    | /api/recipes/{id} | Fetch full recipe                 |
| PUT    | /api/recipes/{id} | Save                              |
| DELETE | /api/recipes/{id} | Delete                            |
