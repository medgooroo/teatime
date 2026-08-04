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
