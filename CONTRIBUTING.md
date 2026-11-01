# Contributing

Thanks for considering it. This is a small, opinionated codebase; the fastest way
in is to read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (10 minutes) and
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) (conventions, testing, extension
recipes).

---

## The two most useful contributions

1. **Verify the scraper against live markup.** It is the only unproven path in
   the project — see [Roadmap P0](docs/ROADMAP.md#p0--prove-the-scraper). A
   single successful run against a real product page, pasted into an issue, is
   genuinely valuable.
2. **Implement the `__PRELOADED_STATE__` extraction layer.** Well-scoped, no
   design decisions needed, clear acceptance criteria.

---

## Ground rules

These are not style preferences; each one exists because breaking it caused a bug.

**Never store a price you are not sure about.** If an adapter cannot read a
price, it throws. It does not return `null`, `0`, or the list price. The poller
has a second guard (`snap.price == null`) and the alert engine has a third
(`price <= 0`). Do not remove any of them.

**Keep `evaluate()` pure.** No I/O, no `fetch`, no notifications inside
`lib/alerts.mjs`. It is the only reason alert behaviour is testable.

**`evaluate()` runs before `addSnapshot()`.** This ordering is load-bearing for
`new_low`; it compares the new price against history *excluding* itself. There is
a comment; please keep it.

**Do not reduce the politeness delays.** The 2.5 s challenge window, the 4–9 s
inter-item gap and the cycle jitter are the reason this works at all. If you need
throughput, use the official API.

**No new runtime dependencies without a reason in the PR.** The zero-build,
one-dependency design is the product's main practical advantage.

**Portuguese for anything a user reads.** Code, comments, docs and commits in
English; UI strings, alert text, CLI output and API error messages in Portuguese.

**Test against a throwaway database.** `MT_DB=/tmp/test.db`. Never
`data/mercado.db` — that history cannot be recovered.

---

## Workflow

```bash
git checkout -b chatbox/your-change
npm install && npm run setup
# ... change ...
npm start
```

Before opening a PR, the checklist in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#before-opening-a-pull-request):

- [ ] all six smoke-test routes return `200`
- [ ] `npm run seed` renders a chart with visible points
- [ ] `parsePrice` / `parseTarget` / `evaluate` checks still pass
- [ ] docs updated if you touched routes, config or schema
- [ ] no new runtime dependency, or a stated reason

### Commit messages

```
<area>: <imperative summary>

Why, not what.
```

Areas: `db`, `poller`, `alerts`, `sources`, `server`, `ui`, `cli`, `docs`,
`config`.

---

## Reporting a scraper failure

The error message ends with the page `<title>`, which is the diagnostic that
matters. Please include:

1. The full error text, including `(title: ...)`.
2. The product URL (or note that it is private).
3. Your `source`, `pollMinutes` and `timeoutSeconds`.
4. Whether `node --no-warnings -e "import('./lib/sources/browser.mjs').then(m => m.fetchProduct('<url>')).then(console.log, console.error)"`
   reproduces it outside the app.

With those four, a selector fix is usually a two-line change.

---

## Security

This app holds no secrets beyond your own `config.json` tokens, and binds to
`127.0.0.1`. If you find something that would expose a token (for example, a
route that echoes config, or a path traversal in the static handler), please open
an issue describing the class of problem rather than a working exploit.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
