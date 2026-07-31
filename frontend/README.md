# Tention Pulse — Agency frontend

Internal web interface for Tention agency staff. Private tool, not a public product:
there is no signup, no marketing surface, and no client-facing page here. The
client onboarding wizard is a separate Phase 5C surface.

**Current checkpoint: Phase 5B-2A — workspace foundation.** See
[Checkpoint limitations](#checkpoint-limitations) for what is deliberately not built yet.

## Stack

| Concern | Choice |
|---|---|
| Language | TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| UI | React 19 |
| Build / dev server | Vite 8 |
| Styling | Tailwind CSS 4 |
| Routing | React Router 8 (`react-router`) |
| Server state | TanStack Query 5 |
| Forms | React Hook Form 7 + Zod 4 (installed for later checkpoints; no form exists yet) |
| Tests | Vitest 4, React Testing Library 16, user-event 14, jsdom 30 |

Deliberately **not** used: Next.js, Redux, Zustand, SSR, any component library, any
analytics or error-reporting SDK, any service worker.

### Two notes on versions

**Tailwind 4 has no JS config file.** v4 moved configuration into CSS, so there is no
`tailwind.config.js` and no `postcss.config.js`. The Vite plugin (`@tailwindcss/vite`)
replaces the PostCSS pipeline, and design tokens live in an `@theme` block in
[`src/styles/index.css`](src/styles/index.css). This is the supported v4 setup, not a
workaround.

**React Router 8 is the patched release.** React Router 7.12–8.2 carry a high-severity
advisory (RSC-mode CSRF bypass, GHSA-qwww-vcr4-c8h2); 8.3.0 sits above that range. v8 also
folded `react-router-dom` into `react-router`, so imports come from `react-router`.

## Node version

This workspace requires **one of**:

- **Node 22.22.2 or newer** on the Node 22 release line
- **Node 24.15.0 or newer** on the Node 24 release line
- **Node 26 or newer**

Verify with `node --version`. The currently verified local version is **Node 22.22.3**.
CI and frontend build environments must use a supported version.

Declared as `^22.22.2 || ^24.15.0 || >=26.0.0` rather than a bare minimum, because a
minimum would falsely advertise Node 23 and 25. Two packages set it:

- `jsdom@30` (dev, via Vitest) declares exactly this range — **the binding
  constraint**. It excludes the odd-numbered non-LTS lines 23.x and 25.x, so stay on
  an even-numbered LTS.
- `react-router@8.3.0` declares `>=22.22.0`, which the range above already satisfies.

Node 20 is not supported anywhere in this repository any more. That is not only a
frontend change: the backend's `@fastify/cookie@11` pulls in `cookie@2`, a production
dependency requiring Node >= 22. The backend therefore declares `>=22` on its own —
lower than this workspace, since 22.22.2 and the odd-line exclusions are frontend
test-toolchain constraints. A root `npm install` covers both and takes the narrower
range.

## Installation

Dependencies are managed from the repository root, which is an npm workspace.

```bash
npm install          # from the repo root, installs backend + frontend
```

## Commands

Run from the repository root:

| Command | What it does |
|---|---|
| `npm run dev:frontend` | Vite dev server on http://localhost:5173 |
| `npm run build:frontend` | Typecheck, then production build to `frontend/dist/` |
| `npm run typecheck:frontend` | Types only, no emit |
| `npm run test:frontend` | Vitest, single run |

Or from `frontend/`: `npm run dev`, `npm run build`, `npm run typecheck`, `npm run test`,
`npm run test:watch`, `npm run preview`.

The frontend needs the backend running to answer API calls:

```bash
npm run dev:backend   # terminal 1 — API on :3000
npm run dev:frontend  # terminal 2 — UI on :5173
```

## The `/api` proxy

Application code calls exactly one origin: its own. Every request goes through the
same-origin `/api` prefix, and the Vite dev server forwards it to the backend and strips
the prefix:

```
browser:   GET /api/auth/me          (http://localhost:5173)
backend:   GET /auth/me              (http://localhost:3000)
```

Two consequences worth stating, because they are the reason for the design:

- **The backend needs no CORS configuration.** Nothing is cross-origin, so no
  `Access-Control-Allow-Origin` header, no preflight, and no origin allowlist to keep
  correct. There is no CORS plugin registered on the backend and none is wanted.
- **The session cookie works unchanged.** The backend's `tention_sid` cookie is
  `HttpOnly; SameSite=Lax; Secure` only in production. Same-origin requests carry it in
  local development without loosening any of those attributes.

In production the same `/api` prefix is expected to be routed to the backend by the
reverse proxy. The backend origin is never compiled into the bundle — the dev target
lives in `vite.config.ts` and is read by the dev server, not by browser code.

## Public environment configuration

`frontend/.env.example` documents the only variable, and copying it is optional
(the default is identical):

```
VITE_API_BASE_URL=/api
```

**No secret may ever be added to a frontend `.env` file.** Everything `VITE_`-prefixed is
compiled into the bundle and readable by anyone who loads the page. Provider credentials,
the encryption key, database and Redis URLs, the session secret and onboarding tokens are
backend-only and have no frontend equivalent. `VITE_API_BASE_URL` must be a same-origin
absolute path; an absolute URL is rejected at startup, because pointing the base at
another origin would send the session cookie there.

## Authentication and storage rule

The agency session is the backend's **httpOnly `tention_sid` cookie**, and that is the
only authentication mechanism.

The API client sets `credentials: 'include'` and does nothing else about auth. It never
reads a cookie (it cannot — the cookie is httpOnly), never writes, modifies or deletes
one, and never mints a token. **No authentication state is ever placed in
`localStorage`, `sessionStorage`, or IndexedDB**, and the TanStack Query cache is
in-memory with no persister, so cached account data does not survive a closed tab.

`GET /auth/me` is the source of truth for whether a session exists. A hidden button, a
removed nav link, or a boolean in a React state is **not** authorization — the backend
enforces access, and the UI only reflects it.

A test in [`src/test/documentPolicy.test.ts`](src/test/documentPolicy.test.ts) scans every
source file and fails the build if any of these rules is broken.

## Structure

```
frontend/
├── public/favicon.svg
├── src/
│   ├── api/
│   │   ├── client.ts       one typed client; same-origin target restriction
│   │   ├── errors.ts       ApiError + normalization of the backend's error envelopes
│   │   └── types.ts        transport types and the documented wire envelopes
│   ├── app/
│   │   ├── App.tsx         root: providers + router
│   │   ├── providers.tsx   QueryClientProvider
│   │   └── queryClient.ts  shared QueryClient defaults and retry policy
│   ├── components/         Button, Alert, ErrorPanel, LoadingSkeleton, PageShell
│   ├── pages/              FoundationPage, NotFoundPage
│   ├── routes/router.tsx   route table
│   ├── styles/index.css    Tailwind entry + design tokens + base layer
│   ├── test/               setup, render helper, fetch stub
│   ├── types/domain.ts     backend-derived domain types
│   ├── main.tsx
│   └── vite-env.d.ts
├── .env.example
├── index.html              document security policy lives here
├── vite.config.ts          dev proxy + Vitest config
└── tsconfig.json / tsconfig.node.json
```

There are no empty feature directories. `src/features/` and the rest of the planned
layout appear when the checkpoints that need them do.

## API client behaviour

- Base `/api`, configurable, validated as a same-origin path.
- `credentials: 'include'` on every request; `cache: 'no-store'`; `redirect: 'error'`.
- `GET`, `POST`, `PUT`, `PATCH`, `DELETE`; JSON bodies; `AbortSignal` supported.
- Empty `200`/`204` responses resolve to `null` rather than throwing.
- Malformed JSON is handled without throwing a parse error.
- **Target restriction:** a resolved URL that leaves the API base or the current origin is
  refused before `fetch` is called. `credentials: 'include'` plus an attacker-influenced
  URL is how a session gets handed to a third party.
- **No logging.** The API layer contains no `console` call at all; a logged request body is
  a logged credential the first time somebody posts one.
- Never retries anything. Retry policy belongs to the query client.

### Error model

`ApiError` is the only error type the app throws, exposing `status`, `kind`, `code`,
`message`, `retryable`, `retryAfterSeconds`, `fieldErrors` and an allowlisted `details`.

The backend emits seven different error envelopes (catalogued in `src/api/types.ts`), which
is why normalization exists. A server-supplied string becomes the displayed message only if
it passes a safety check — not multiline, no stack frame, no `file:line:col`, no deploy
path, not an `Error:` prefix — and **never** for a `5xx`, which is exactly where an internal
exception surfaces. Everything else falls back to a fixed per-status sentence. `details` is
an allowlist of backend-documented client-safe keys, not a passthrough of the body.

## Checkpoint limitations

Phase 5B-2A is the foundation only. **Not implemented:**

- sign-in, sign-out, `/auth/me` bootstrap, protected routes, the agency shell
- the account list, account creation, and the account workspace
- onboarding-link generation, listing, copying and revocation
- provider connection forms, provider skip, sync progress
- currency, COGS, OCAS and advertising-spend interfaces
- onboarding completion controls

The two routes that exist (`/` and a catch-all 404) are temporary. `/accounts` and
`/login` intentionally render the 404 page today rather than a placeholder, because a
placeholder reads as progress.

This workspace also does not handle onboarding tokens in any form — no fragment parsing,
no token exchange, no link construction. That is Phase 5C.
