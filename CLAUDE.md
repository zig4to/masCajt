# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Garaža Klub Koledar" (`masCajt`) — a shared availability calendar / event planner for a small group of
friends, in Slovenian. Static, no-build PWA: `index.html` fetches `skupni-koledar.jsx` at runtime and
transforms it in-browser with Babel Standalone (`@babel/standalone` from unpkg), then renders it via an
import map that resolves `react`, `lucide-react`, `@supabase/supabase-js`, and the local `styles` module
straight from esm.sh/relative paths. There is no bundler, no dev server config, and no build step for the
app itself — editing `skupni-koledar.jsx` or `styles.js` and reloading the page is the entire dev loop.

Data is stored in Supabase Postgres (a single generic `kv_store` key/value table, see
`supabase-schema.sql`) plus Supabase Storage for photos, with realtime subscriptions so one person's save
appears live for everyone else. `index.html` also defines `window.storage` (routes to `localStorage` for
per-device settings like a person's own name, or to the shared Supabase-backed store for `avail:*` data)
and `window.photos` (Storage upload/URL helpers) — these are the only two globals the app module talks to
for persistence.

## Commands

```
npm install          # only devDependencies: @babel/core, playwright, etc. — for the test suite, not the app
npm test             # runs both suites below
npm run test:unit    # node --test over tests/unit/**/*.test.js — pure-function tests, fast
npm run test:e2e     # tests/e2e/event-edit.test.js — Playwright against the real app, network mocked
```

There's no lint/build/typecheck script — the app has no toolchain beyond the in-browser Babel transform.
To manually sanity-check a change in a real browser, serve the repo root over HTTP (not `file://`, the
`type="module"` script and import map need it) and open `index.html`.

Run a single unit test with node's built-in filter, e.g.:
```
node --test --test-name-pattern="splitDuration" "tests/unit/**/*.test.js"
```

## Testing architecture

- **Unit tests** (`tests/unit/`) exercise pure helper functions (key encode/decode, color assignment,
  date math, sorting) exported from the top of `skupni-koledar.jsx`. They load the *real* source file
  through `tests/support/load-calendar-module.js`, which Babel-transforms it to CommonJS and `require`s it
  with stubbed `react`/`lucide-react`/`styles` modules — no copy of the logic is duplicated into the test
  tree. This only works because those helpers are plain functions that never call React; the module is
  never rendered in this harness.
- **E2E tests** (`tests/e2e/`) drive the real `index.html` + `skupni-koledar.jsx` in headless Chromium via
  Playwright, served locally by `tests/e2e/static-server.js`. Supabase REST calls are intercepted with
  `page.route()` and answered from fixed fixtures — tests never touch the live production calendar.
  `event-edit.test.js` is a plain script with its own pass/fail tally (not `node --test`) because
  Playwright needs an async browser lifecycle around the whole suite.
- When fixing a data-format bug, prefer adding a regression case using the *exact* legacy shape that broke
  (e.g. events created before per-day ids existed have an empty id suffix; durations were once stored with
  a plain hyphen instead of an en dash) — see existing tests for the pattern.

## Code architecture

`skupni-koledar.jsx` is one file (~7000 lines): a block of exported pure helpers (date/key formatting,
encode/decode for every stored record type, color assignment, sorting) followed by a handful of small
presentational components, and then `export default function App()` — a single large component holding
essentially all state (dozens of `useState`s) and UI logic, with most "sub-views" implemented as inner
functions (`renderEventSection`, `renderCommentPanel`, `renderPhotoStrip`, `renderNeedsPanel`, etc.) rather
than separate components. There is intentionally no router: `view` is a plain string (`"calendar"` |
`"archive"`).

**Storage is a key/value store, not a schema.** Every piece of shared data — availability entries, events,
comments, photo metadata, "kva rabmo" (needs/checklist) items, category tabs, month cover images, push
subscriptions — is one row in `kv_store` (`key text primary key, value text`), addressed by a
colon-delimited key built by a matching `xKey()` helper and read back by a matching `decodeX()` helper. The
key convention is `avail:<iso-date>:<person>` for a plain availability entry, and
`avail:<iso-date>:__<marker>__<id>[:...]` for everything else (`__event__`, `__comment__`, `__recap__`,
`__photo__`, `__need__`, `__cat__`); `personFromKey`/`isoFromKey`/`parseXPerson` parse these back apart.
Because the person segment can itself contain a colon (a name) or further-nested ids, parsers generally
split on the *last* colon or rejoin `parts.slice(n)`, not the first — see `parseCommentPerson` for the
canonical example. RLS policies in `supabase-schema.sql` are scoped by these same key prefixes (e.g. only
`avail:%` is publicly writable), so a new record type needs both a key convention here and a matching
policy there.

Photos are the one exception: binary data goes to Supabase Storage (bucket `arhiv`), and the `kv_store` row
for a photo holds only its path — keeping large blobs out of the window queries and out of the realtime
replication stream that every client subscribes to.

**Realtime and windowing.** The visible date range is fetched with `range(fromKey, toKey)` (a lexicographic
key range works because dates are ISO-formatted and sort correctly as strings), and live updates arrive
over a single `postgres_changes` subscription on the whole table, filtered client-side to the current
window. There's no per-query subscription API.

**Theming** is CSS custom properties: `THEME_CSS` (top of `skupni-koledar.jsx`) defines
`:root[data-theme="dark"|"light"]` blocks, and every color in `styles.js` is a `var(--...)` reference
rather than a literal, so switching themes needs no per-render recomputation.

**Push notifications**: `sw.js` handles only `push`/`notificationclick` — deliberately no `fetch` handler,
so it never caches or intercepts page loads (this app has no build step, so a caching SW would pin a stale
version to a device and stop future deploys from reaching it). Sending a push is server-side: a Postgres
trigger (`notify_new_event_trigger` in `supabase-schema.sql`) fires on insert into `kv_store`, filters to
`avail:%:__event__%` keys, and calls the `notify-event` Edge Function (`supabase/functions/notify-event/`)
via `pg_net`, which re-reads the event (never trusts the trigger payload alone), then sends web-push to
every `push:*` subscription row except the event's creator.

## Conventions worth knowing before editing

- Comments throughout the codebase explain *why*, often citing a specific past bug or a rejected
  alternative and why it didn't work — match that style rather than restating what the code does.
- The UI text is Slovenian; keep new user-facing strings in Slovenian and consistent with the existing
  tone (informal/friendly).
- `ADMIN_NAME`/`AUTH_CODE` (top of `skupni-koledar.jsx`) gate admin-only actions; there is no real
  authentication system, just a shared PIN.
- Never put a Supabase `service_role` key in client code (`index.html`, `skupni-koledar.jsx`, or
  `supabase-schema.sql`) — only the `anon`/publishable key belongs there. The service_role key exists only
  in the Edge Function's environment (Supabase dashboard secrets).
