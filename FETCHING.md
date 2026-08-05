# Retrieving recipes from source sites

Most recipe sites do not serve their recipe in the initial HTML, and several
block automated fetchers outright. This records what works per site, discovered
while converting ~100 recipes. Try the methods in the order given.

## Order of attack

1. **Plain fetch.** Works on HelloFresh, Serious Eats, Nigella, most blogs.
2. **JSON-LD.** Fetch with curl and a browser user-agent, then read the
   `<script type="application/ld+json">` block. Nearly every recipe site that
   cares about search ranking publishes a complete `Recipe` object there
   (`recipeIngredient`, `recipeInstructions`, `totalTime`, `recipeYield`).
3. **The site's own JSON API.** SPAs fetch their content from somewhere — find
   it in the network tab or the JS bundle. See Gousto below.
4. **Framework data blob.** Next.js sites embed state in `__NEXT_DATA__`, Nuxt
   in `__NUXT__`. Often richer than the JSON-LD.
5. **Text extraction proxy.** `https://r.jina.ai/<url>` renders the page and
   returns readable text. Last resort — it is rate-limited, occasionally
   returns the unrendered shell, and needs a cache-busting retry when it does.

## Per site

### Gousto — JSON API

Cookbook pages are a client-rendered React shell with no recipe in the HTML.
Two endpoints work; the first is preferred:

```
https://production-api.gousto.co.uk/cmsreadbroker/v1/recipe/<slug>
  header: x-gousto-request-source: content-webclient

https://production-api.gousto.co.uk/cookbook/v1/recipes/<slug>
```

`<slug>` is the last path segment of the cookbook URL. Returns full ingredients,
store-cupboard "basics", prep times and verbatim numbered method steps.

Three quirks:

- **Portion variants.** Ingredient arrays interleave the 2- and 4-portion
  versions of each item. On the `cmsreadbroker` endpoint the 4-portion entries
  are tagged `x0`; on the `cookbook` endpoint per-portion quantities are under
  `relationships.ingredients[].labels.for2`. Take one set consistently.
- **Incomplete relationships.** On the `cookbook` endpoint, sachet and spice
  items (soy sauce, vinegar, tomato paste, ground spices) are missing from the
  `relationships` list and appear only in the `included` block. Check both or
  ingredients silently go missing.
- **Double-encoded UTF-8.** Text comes back as mojibake and needs repairing.

Direct requests to the cookbook page itself return 403.

### BBC Good Food, BBC Food — `__NEXT_DATA__`, then JSON-LD

Blocked to some fetchers; curl with a browser user-agent works. The complete
data is in the `__NEXT_DATA__` script block at
`props.pageProps.ingredients` and `props.pageProps.methodSteps`. The JSON-LD on
these pages is sometimes truncated to a few keys, so prefer `__NEXT_DATA__` and
fall back to JSON-LD.

### Guardian — structured API (use this, not the article HTML)

The Feast app is driven by a public, unauthenticated backend that serves
**fully structured** recipes. Prefer it over scraping the article prose.

```
https://recipes.guardianapis.com/index.json        # every recipe: checksum, uid, article path
https://recipes.guardianapis.com/content/<checksum>  # one recipe, structured JSON
```

`index.json` is ~2MB and lists around 7,800 recipes. It carries **no titles** —
only `capiArticleId` (the article path, whose slug is a usable search key),
`recipeUID` and `checksum`. Fetch content by checksum to get the title.

Content includes `title`, `description`, `serves`, `timings` (separate
`prep-time` / `cook-time` / `chill-time` entries with numeric minutes),
`ingredients` grouped into `recipeSection`s with each item parsed into
`amount`/`unit`/`name`/`prefix`/`suffix` alongside the display `text`, and
`instructions` as an ordered list of `description` strings.

**Multi-recipe columns are already split.** An Ottolenghi or Nigel Slater piece
carrying five recipes appears as five separate index entries sharing one
`capiArticleId` — so the "which recipe in this article" problem disappears.

`guardian.go` in this repo wraps it:

```
go run guardian.go -search "soy chicken biryani"   # find candidates, with titles
go run guardian.go -get <checksum|uid|article-path>  # print structured JSON
go run guardian.go -refresh                        # re-download the index
```

The index is cached in the user cache directory after first use.

Recipes saved in the Feast app are a different matter: that list lives behind a
Guardian account with no public endpoint and no bulk export in the app. The
titles have to come out by hand (screenshots or shares); once you have them,
match against the index and fetch structurally as above.

### Good Housekeeping, Jamie Oliver, deliciouslyella — JSON-LD

Standard JSON-LD extraction after a curl with a browser user-agent. Jamie
Oliver also works with a plain fetch.

### Allrecipes — proxy

Returns HTTP 402 to direct fetches and 460 to a Googlebot user-agent. Use the
text extraction proxy.

### Serious Eats — plain fetch or proxy

Server-rendered and usually fine directly; the proxy works when it is not.

## Reading the result

- **Stated total times are marketing.** They routinely assume overlaps one cook
  cannot perform — a 15-minute simmer and a 15-minute bake counted as 15
  minutes. Trust the individual step times and schedule honestly; expect your
  total to come out longer, sometimes by half again.
- **Prep is usually uncounted.** "10 minutes" often excludes the chopping.
- **Sub-recipes.** Some recipes link out to a component (a sauce, a spice
  paste). Fetch it too and give it its own lane.
- **Missing steps.** Ingredients occasionally appear in a method with no step
  that produces them (roasted garlic that is never roasted). Add the step.
