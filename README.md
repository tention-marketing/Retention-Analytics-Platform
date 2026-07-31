# Tention Pulse

Retention analytics platform. Build spec and phase plan live in [CLAUDE.md](CLAUDE.md).

## Repository layout

One repository, two top-level application folders:

```
backend/            Fastify API, Postgres migrations, BullMQ queues/workers,
                    Shopify + Klaviyo + Recharge integrations, onboarding
                    backend, verification scripts
frontend/           Internal agency web interface: React + Vite + Tailwind.
                    Phase 5B-2A foundation only — see frontend/README.md for
                    what is and is not built yet
docker-compose.yml  Postgres 16 + Redis 7 for local development
```

`backend/` and `frontend/` are npm workspaces. Root `package.json` holds only
workspace-level command aliases; runtime dependencies live in each workspace's
own `package.json`.

Unprefixed root commands (`npm run dev`, `build`, `typecheck`) still mean the
**backend**, exactly as before the frontend existed. Use the `:backend` and
`:frontend` variants when you need to be explicit.

## Node version

Full monorepo development requires **one of** the following:

- **Node 22.22.2 or newer** on the Node 22 release line
- **Node 24.15.0 or newer** on the Node 24 release line
- **Node 26 or newer**

Verify with:

```bash
node --version
```

The currently verified local version is **Node 22.22.3**. CI, deployment, and
frontend build environments must use one of the supported versions above.

This is a range rather than a simple minimum, and the gaps are deliberate:

- **Node 20 is no longer supported.** Not only by the frontend — the *backend*
  dependency tree dropped it too. `@fastify/cookie@11` depends on `cookie@2`, a
  production dependency that requires Node >= 22. That happened with the Fastify 5
  upgrade, independently of the frontend existing.
- **Node 23 and Node 25 are not supported.** The frontend test toolchain
  (`jsdom@30`, via Vitest) declares `^22.22.2 || ^24.15.0 || >=26.0.0`, which
  excludes the odd-numbered non-LTS lines. Stay on an even-numbered LTS release.

Per-workspace, so the figures can be re-derived rather than trusted:

| Workspace | `engines.node` | Driven by |
|---|---|---|
| root (whole install) | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | the intersection of both workspaces |
| `frontend/` | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` | `jsdom@30` (binding) and `react-router@8` (`>=22.22.0`) |
| `backend/` | `>=22` | `cookie@2` (`>=22`) via `@fastify/cookie@11` |

The backend alone does not need 22.22.2 or the odd-line exclusions — those are
frontend test-toolchain constraints. A root `npm install` covers both workspaces
and therefore takes the narrower range.

## Local development

```bash
docker compose up -d          # Postgres 16 + Redis 7
cp backend/.env.example backend/.env   # then fill in provider credentials
npm install
npm run migrate               # apply backend/src/db/migrations/*.sql in order
npm run seed                  # 1 fake brand: 2yrs orders + subs + campaigns
npm run dev                   # API on :3000
npm run worker                # BullMQ workers (separate process)
npm run dev:frontend          # agency UI on :5173 (needs the API running)
```

The frontend calls the API through a same-origin `/api` prefix that the Vite dev
server proxies to `:3000`, stripping the prefix. Nothing is cross-origin, so the
backend needs no CORS configuration. See [frontend/README.md](frontend/README.md).

Environment variables are read from `backend/.env` (npm workspace scripts run
with `backend/` as their working directory).

## Commands

### Backend

Every command below can be run from the repo root, or from `backend/` without
the `-w` indirection. Each also has an explicit `:backend` alias
(`dev:backend`, `build:backend`, `typecheck:backend`).

| Command | Purpose |
|---|---|
| `npm run dev` | API with watch reload |
| `npm run worker` | BullMQ workers |
| `npm run migrate` | Apply pending SQL migrations (idempotent) |
| `npm run seed` | Reseed the demo brand (**destructive** to that brand's rows) |
| `npm run bootstrap:user` | Create an agency staff user (`-- you@agency.com`) |
| `npm run build` | Type-check and emit to `backend/dist/` |
| `npm run typecheck` | Type-check only, no emit |
| `npm run verify:recharge` | Phase 3 fixture verification (offline) |
| `npm run verify:klaviyo` | Phase 4 fixture verification (offline) |
| `npm run verify:identity` | Identity graph at seed scale |
| `npm run verify:onboarding` | Phase 5A onboarding + agency hardening (offline) |
| `npm run verify:shutdown` | Graceful shutdown verification |

### Frontend

| Command | Purpose |
|---|---|
| `npm run dev:frontend` | Vite dev server on :5173 (proxies `/api` to :3000) |
| `npm run build:frontend` | Type-check and build to `frontend/dist/` |
| `npm run typecheck:frontend` | Type-check only, no emit |
| `npm run test:frontend` | Vitest unit and component tests |

### Scripts that need live credentials or mutate data

Not part of routine verification — run deliberately:

- `backend/scripts/verify-klaviyo-live.ts` — live Klaviyo reconciliation
- `backend/scripts/connect-shopify.ts`, `connect-shopify-db.ts` — live Shopify
- `backend/scripts/seed.ts` — deletes and recreates the demo brand
