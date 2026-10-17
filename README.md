# acuStore (Express + EJS)

A general store with a built-in CMS — products, categories, orders and store
settings, all editable from `/admin`. Now backed by **Neon Postgres**.

## Stack

Express 4 · EJS · Neon Postgres (`pg`) · express-session · bcrypt · helmet · multer

## Setup

```bash
npm install

cp .env.example .env      # if you do not already have one
# set SESSION_SECRET, ADMIN_*, and the Neon connection strings

npm run db:bootstrap      # one-time: create the `acustore` database + write .env
npm run db:migrate        # create tables, indexes, pg_trgm
npm run db:import         # one-time: copy existing SQLite data (if any)
npm run setup             # or: seed settings + a starter admin on an empty DB

npm start                 # http://localhost:3000
```

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** connection (host contains `-pooler`) — used at runtime |
| `DIRECT_URL` | Neon **direct** connection — used by `db:migrate` and `db:import` only |
| `DATABASE_SSL` | `true` for Neon (TLS). Set `false` only for a local Postgres. |
| `SESSION_SECRET` | Signs the session cookie |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | First admin, created only when the table is empty |
| `PORT`, `SITE_URL`, `PG_POOL_MAX` | Optional |

Why two URLs: every serverless-style request opens and closes a connection, so
application traffic must go through PgBouncer (`-pooler`) or Postgres runs out of
connections. But migrations take advisory locks and run DDL, which transaction
pooling breaks — so they use the direct host.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start with `--watch` |
| `npm run db:bootstrap` | Create the Neon database and write the URLs into `.env` |
| `npm run db:migrate` | Apply `src/schema.sql` (idempotent) |
| `npm run db:import` | Copy the old SQLite data in, preserving ids/timestamps/hashes |
| `npm run setup` | Ensure settings + admin (and sample catalog if empty) |
| `npm run admin:reset -- email newpassword` | Reset an admin password |
| `npm run images` | Fetch placeholder product images |

## Migrating a SQLite database

The original `data/store.db` is still on disk and was copied across with
`db:import`, which:

- preserves primary keys, so order references and product links stay valid;
- converts SQLite's `INTEGER 0/1` flags to real booleans;
- converts its UTC wall-clock timestamp strings to `timestamptz`;
- carries the bcrypt password hash over unchanged, so existing admin sign-ins
  keep working;
- skips sessions (everyone signs in once more);
- advances each sequence past the imported ids.

The import is guarded: it refuses to run against a non-empty database unless you
pass `--force`.

## Notes for future work

- **Handlers are async.** Express 4 does not forward rejected promises, so every
  route file calls `wrapRouter(router)` from `src/lib/async.js`. If you add a
  router, do the same — otherwise a thrown error hangs the request.
- **Settings are cached.** `await settings.load()` runs once at boot, which is why
  `settings.get()` can stay synchronous everywhere else. Anything that reads
  settings in a script must `await settings.load()` first.
- **`better-sqlite3` is a devDependency**, used only by the one-off import script.
  It is no longer part of the runtime.
- **`COUNT`/`SUM` need casting.** `pg` returns `bigint` as a string, so aggregates
  are cast (`::int`, `::bigint`) at the query. Watch for this in new queries.
- Uploaded product images still live in `public/uploads/` on local disk. That is
  fine for a single VPS; a serverless host needs object storage instead.
