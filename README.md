# Tention Pulse

Retention analytics platform. Build spec and phase plan live in [CLAUDE.md](CLAUDE.md).

## Repository layout

One repository, two top-level application folders:

```
backend/            Fastify API, Postgres migrations, BullMQ queues/workers,
                    Shopify + Klaviyo + Recharge integrations, onboarding
                    backend, verification scripts
frontend/           React + Vite + Tailwind (created at Phase 5B — does not
                    exist yet)
docker-compose.yml  Postgres 16 + Redis 7 for local development
```

`backend/` is an npm workspace. Root `package.json` holds only workspace-level
command aliases; all runtime dependencies live in `backend/package.json`.

## Local development

```bash
docker compose up -d          # Postgres 16 + Redis 7
cp backend/.env.example backend/.env   # then fill in provider credentials
npm install
npm run migrate               # apply backend/src/db/migrations/*.sql in order
npm run seed                  # 1 fake brand: 2yrs orders + subs + campaigns
npm run dev                   # API on :3000
npm run worker                # BullMQ workers (separate process)
```

Environment variables are read from `backend/.env` (npm workspace scripts run
with `backend/` as their working directory).

## Commands

Every command below can be run from the repo root, or from `backend/` without
the `-w` indirection.

| Command | Purpose |
|---|---|
| `npm run dev` | API with watch reload |
| `npm run worker` | BullMQ workers |
| `npm run migrate` | Apply pending SQL migrations (idempotent) |
| `npm run seed` | Reseed the demo brand (**destructive** to that brand's rows) |
| `npm run build` | Type-check and emit to `backend/dist/` |
| `npm run typecheck` | Type-check only, no emit |
| `npm run verify:recharge` | Phase 3 fixture verification (offline) |
| `npm run verify:klaviyo` | Phase 4 fixture verification (offline) |
| `npm run verify:identity` | Identity graph at seed scale |

### Scripts that need live credentials or mutate data

Not part of routine verification — run deliberately:

- `backend/scripts/verify-klaviyo-live.ts` — live Klaviyo reconciliation
- `backend/scripts/connect-shopify.ts`, `connect-shopify-db.ts` — live Shopify
- `backend/scripts/seed.ts` — deletes and recreates the demo brand
