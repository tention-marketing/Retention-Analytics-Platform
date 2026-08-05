# TENTION PULSE — Build Spec (CLAUDE.md) — V1: RCM + Churn Curve
> Supersedes all previous specs. Aligned to the approved "V1 Build Scope" (July 2026).
> Paste this file as `CLAUDE.md` in the repo root. Build ONE phase per instruction. Never build ahead.

---

## 0. LOCKED DECISIONS — DO NOT CHANGE

| Decision | Locked choice |
|---|---|
| V1 objective | **A trustworthy RCM tier + daily churn curve for a SINGLE brand. Nothing else.** |
| Language / stack | TypeScript using **the Node.js versions supported by the root `package.json` engines field for the full monorepo, currently `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`** — a disjoint set of ranges, not an open-ended minimum, so an intermediate major such as 23 or 25 is NOT supported. Fastify, PostgreSQL 16, BullMQ + Redis, React + Vite + Tailwind, Recharts |
| Hosting | Railway (local dev: docker-compose Postgres + Redis) |
| Integrations (V1) | Shopify (incl. **inventory levels**), Klaviyo (campaign/flow aggregates + send timestamps ONLY), **Recharge** |
| Ad spend (V1) | **Manual monthly entry per channel only.** No ad APIs, no aggregators. Normalized into a source-agnostic spend model so APIs slot in at V3 without touching RCM logic. |
| Klaviyo events | **DO NOT build event-level open/click storage in V1** (explicitly deferred to V2) |
| Tenancy | Single-brand operation, **multi-account-ready architecture**: every table carries `account_id`, every query filters by it. No hard-coded single-account assumptions. |
| Timezones | Store UTC; convert to store timezone at query time |
| Data handling | Read-only everywhere; credentials encrypted (AES-256-GCM); **full provable deletion on disconnect** |
| Auth | Session email+password, agency staff only. **Every authenticated staff member currently has agency-wide access to every account.** Per-account staff roles, scoped client dashboard accounts and client permissions are NOT implemented (V4 — §10). |
| Onboarding completion | **TWO SEPARATE GATES, never merged (§5.1).** Basic onboarding completion = every provider answered + at least one genuinely connected. Analytics/RCM readiness is derived independently and may stay blocked afterwards. |
| Financial inputs | Currency, COGS, blended margin, per-SKU costs, OCAS and ad spend are **optional for basic onboarding completion** and required only for RCM/full analytics readiness (§5.2). |

## 0.1 EXPLICITLY CUT FROM V1 — DO NOT BUILD
Hourly engagement tab · Ask AI query layer · agency portfolio view · white-labeling · roles/permissions · aggregator integrations · direct ad platform APIs · SMS markers · subject-line analysis · Klaviyo event-level opens/clicks · RFM segments · send-hour dashboard · campaigns dashboard page · Skio/Stay.
All deferred to V2–V4 (section 10). Anyone proposing them mid-build: the answer is no.

## 0.2 BLOCKER (product owner, not dev)
The **exact RCM formula and tier thresholds** must be locked from the *Retention Economics* source material before the RCM job is coded. Until then: build everything else; implement RCM as a config-driven calculation (`rcm_config` JSON: formula weights + tier thresholds) so locking the numbers is a config change, not a code change.

---

## 1. WHAT V1 IS
One brand answers for Shopify, Klaviyo and Recharge through an onboarding wizard that also collects COGS, OCAS and monthly ad spend. Each platform is either **connected**, **requested** (agency assistance pending) or **skipped** (not used by the brand); setup finishes once every platform has an answer and **at least one is genuinely connected**. The financial inputs are collected in the same wizard but do **not** gate that completion — they gate RCM (§5.2). The platform backfills full history, syncs continuously, and produces: (a) an auto-calculated **RCM tier** with a data-completeness indicator, and (b) a **daily churn curve** with auto-annotated lifecycle spikes — plus a retention snapshot, cohort-LTV-by-first-product, and a combined repurchase-behavior view.
**Success = RCM tier and churn curve match hand-calculated values, onboarding takes under one hour, and disconnect provably deletes everything.**
A brand connected to Klaviyo alone therefore reaches a valid finished setup with **no RCM figure at all**, and that combination must read as normal rather than as a fault.

---

## 2. REPO STRUCTURE
```
tention-pulse/
├── CLAUDE.md
├── docker-compose.yml            # Postgres 16 + Redis
├── server/src/
│   ├── index.ts  config.ts
│   ├── db/{pool.ts, migrations/} # plain numbered SQL, no ORM
│   ├── routes/{auth,accounts,onboarding,metrics,webhooks}.ts
│   ├── sync/
│   │   ├── shopify/{backfill,webhookWorker,reconcile,inventory}.ts
│   │   ├── klaviyo/poller.ts     # campaigns+flows aggregates + send timestamps ONLY
│   │   └── recharge/{backfill,poller}.ts
│   ├── identity/graph.ts         # Shopify customer ↔ Recharge sub ↔ Klaviyo email
│   ├── metrics/{refresh.ts, sql/}
│   ├── rcm/{calc.ts, config.ts}  # config-driven formula + tiers
│   └── queue/{queues,workers}.ts
├── web/src/pages/{Onboarding,Snapshot,CohortLTV,ChurnCurve,Repurchase}.tsx
└── scripts/seed.ts               # 1 fake brand: 2yrs orders + subs + campaigns + costs
```
Conventions: idempotent upserts everywhere (`ON CONFLICT DO UPDATE`); every job try/catch → `sync_errors` table; env: DATABASE_URL, REDIS_URL, SESSION_SECRET, ENCRYPTION_KEY.

---

## 3. DATABASE SCHEMA (001_init.sql — migrate exactly this)
```sql
CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE accounts (              -- "brand"; multi-account-ready from day one
  id SERIAL PRIMARY KEY, name TEXT NOT NULL,
  store_timezone TEXT DEFAULT 'America/Los_Angeles',
  onboarding_complete BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now());

CREATE TABLE connections (
  id SERIAL PRIMARY KEY, account_id INT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK (provider IN ('shopify','klaviyo','recharge')),
  credentials_encrypted TEXT NOT NULL, shop_domain TEXT,
  status TEXT DEFAULT 'pending', last_sync_at TIMESTAMPTZ,
  UNIQUE (account_id, provider));

CREATE TABLE customers (account_id INT NOT NULL, id BIGINT NOT NULL,
  email TEXT, first_order_at TIMESTAMPTZ, created_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, id));
CREATE INDEX idx_cust_email ON customers (account_id, lower(email));

CREATE TABLE orders (account_id INT NOT NULL, id BIGINT NOT NULL,
  customer_id BIGINT, created_at TIMESTAMPTZ NOT NULL,
  total_net NUMERIC(12,2) NOT NULL DEFAULT 0,      -- net of discounts AND refunds
  refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_first_order BOOLEAN, order_number_for_customer INT,
  cancelled BOOLEAN DEFAULT false, test BOOLEAN DEFAULT false,
  PRIMARY KEY (account_id, id));
CREATE INDEX idx_orders_cust ON orders (account_id, customer_id, created_at);
CREATE INDEX idx_orders_time ON orders (account_id, created_at);

CREATE TABLE line_items (account_id INT NOT NULL, order_id BIGINT NOT NULL,
  product_id BIGINT, product_title TEXT, sku TEXT, quantity INT,
  price NUMERIC(12,2), PRIMARY KEY (account_id, order_id, product_id));

CREATE TABLE products (account_id INT NOT NULL, id BIGINT NOT NULL,
  title TEXT, PRIMARY KEY (account_id, id));

CREATE TABLE inventory_levels (                     -- tier's stock-position input
  account_id INT NOT NULL, product_id BIGINT NOT NULL,
  snapshot_date DATE NOT NULL, available INT,
  PRIMARY KEY (account_id, product_id, snapshot_date));

CREATE TABLE campaigns (account_id INT NOT NULL, id TEXT NOT NULL,
  name TEXT, channel TEXT, kind TEXT CHECK (kind IN ('campaign','flow')),
  sent_at TIMESTAMPTZ, recipients INT, PRIMARY KEY (account_id, id));

CREATE TABLE campaign_stats (account_id INT NOT NULL, campaign_id TEXT NOT NULL,
  opens INT DEFAULT 0, clicks INT DEFAULT 0, conversions INT DEFAULT 0,
  revenue NUMERIC(12,2) DEFAULT 0, PRIMARY KEY (account_id, campaign_id));
-- NOTE: aggregates ONLY. No event-level table in V1 (deferred to V2 by design).

CREATE TABLE subscriptions (account_id INT NOT NULL, id TEXT NOT NULL,
  recharge_customer_id TEXT, shopify_customer_id BIGINT,   -- identity graph
  email TEXT, product_id BIGINT, plan_type TEXT,           -- monthly|quarterly|...
  status TEXT, started_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT, acquisition_channel TEXT,
  PRIMARY KEY (account_id, id));
CREATE INDEX idx_subs_cancel ON subscriptions (account_id, cancelled_at);

CREATE TABLE subscription_events (                  -- churn-curve annotations
  account_id INT NOT NULL, subscription_id TEXT NOT NULL,
  event_type TEXT NOT NULL,   -- charge|billing_reminder|delivered|created|cancelled
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, subscription_id, event_type, occurred_at));

CREATE TABLE ad_spend (                              -- source-agnostic spend model
  account_id INT NOT NULL, month DATE NOT NULL, channel TEXT NOT NULL,
  spend NUMERIC(12,2) NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',  -- manual now; aggregator|api later (V3)
  PRIMARY KEY (account_id, month, channel, source));

CREATE TABLE account_costs (
  account_id INT PRIMARY KEY,
  blended_margin_pct NUMERIC(5,2),        -- OR per-SKU below
  ocas_monthly NUMERIC(12,2));            -- operating cost allocation

CREATE TABLE sku_costs (                   -- COGS for top ~20 SKUs by revenue
  account_id INT NOT NULL, sku TEXT NOT NULL, cogs NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (account_id, sku));

CREATE TABLE rcm_config (account_id INT PRIMARY KEY, config JSONB NOT NULL);
-- formula weights + tier thresholds; placeholder until book values locked (§0.2)

CREATE TABLE sync_errors (id SERIAL PRIMARY KEY, account_id INT, job_type TEXT,
  payload JSONB, error TEXT, created_at TIMESTAMPTZ DEFAULT now());
```

```sql
-- 002_metrics.sql (nightly precomputed; dashboards read ONLY these)
CREATE TABLE m_snapshot (account_id INT NOT NULL, period_start DATE, period_end DATE,
  repeat_customers INT, repeat_net_sales NUMERIC(14,2), aov_net NUMERIC(12,2),
  repeat_customer_pct NUMERIC(5,2), repeat_net_sales_pct NUMERIC(5,2),
  PRIMARY KEY (account_id, period_start, period_end));

CREATE TABLE m_product_cohort_ltv (account_id INT NOT NULL,
  first_product_id BIGINT NOT NULL, first_product_title TEXT, customers INT,
  ltv_6m NUMERIC(12,2), ltv_12m NUMERIC(12,2),
  PRIMARY KEY (account_id, first_product_id));
-- min 30 customers/product; exclude customers with insufficient history per window

CREATE TABLE m_cohort_grid (account_id INT NOT NULL, cohort_month DATE NOT NULL,
  months_since INT NOT NULL, customers INT, ltv_per_customer NUMERIC(12,2),
  PRIMARY KEY (account_id, cohort_month, months_since));

CREATE TABLE m_repurchase (account_id INT NOT NULL,
  first_product_id BIGINT NOT NULL DEFAULT 0,   -- 0 = all
  subscriber_filter TEXT NOT NULL DEFAULT 'all',-- all|subscriber|non_subscriber
  window_days INT NOT NULL, cohort_month DATE NOT NULL,
  new_customers INT, repeated INT, repeat_rate NUMERIC(5,2),
  median_days_to_next INT,
  PRIMARY KEY (account_id, first_product_id, subscriber_filter, window_days, cohort_month));

CREATE TABLE m_churn_daily (account_id INT NOT NULL,
  cohort_month DATE NOT NULL DEFAULT '1970-01-01',  -- epoch = all cohorts
  product_id BIGINT NOT NULL DEFAULT 0, plan_type TEXT NOT NULL DEFAULT 'all',
  channel TEXT NOT NULL DEFAULT 'all',
  day_active INT NOT NULL, cancellations INT,
  lifecycle_label TEXT,   -- day0|delivered|billing_reminder|rebill|cycle2_...|null
  PRIMARY KEY (account_id, cohort_month, product_id, plan_type, channel, day_active));

CREATE TABLE m_churn_insight (account_id INT PRIMARY KEY,
  spike_day INT, lifecycle_label TEXT, pct_of_90d_churn NUMERIC(5,2),
  insight_text TEXT);   -- CORRELATIONAL wording only: "tied to", never "caused by"

CREATE TABLE m_rcm (account_id INT NOT NULL, month DATE NOT NULL,
  revenue NUMERIC(14,2), cogs NUMERIC(14,2), cac NUMERIC(12,2),
  refunds NUMERIC(12,2), ocas NUMERIC(12,2), rcm NUMERIC(14,2),
  tier TEXT,             -- gold|silver|bronze|below|partial
  completeness_pct NUMERIC(5,2),   -- e.g. COGS coverage of revenue
  PRIMARY KEY (account_id, month));
```
**Data honesty rules (all metrics):** exclude cancelled/test orders; total_net reflects refunds; never a confident tier on incomplete inputs — `tier='partial'` + warning state when COGS/OCAS/spend incomplete.

---

## 4. SYNC PIPELINE
**4.1 Shopify** — GraphQL Bulk Operations backfill (orders, customers, products, refunds) → batch upsert → compute order_number/is_first_order. Webhooks (orders/create|updated, refunds/create, customers/update): verify HMAC, queue, return 200. **Inventory:** daily snapshot of available quantity per product into inventory_levels. Nightly reconciliation: re-upsert everything updated in last 48h.
**4.2 Klaviyo (light)** — every 6h: campaign + flow lists with send timestamps; per-campaign aggregate stats. NOTHING event-level.
**4.3 Recharge** — backfill + daily poll: subscriptions (all fields incl. cancel_reason, plan_type), charges/rebills, billing-reminder and delivery events where exposed → subscription_events. On 429: backoff; all failures → sync_errors.
**4.4 Identity graph (WEEK 1 — churn annotations live or die on this)** — `identity/graph.ts`: link Recharge subscription → Shopify customer via recharge's shopify_customer_id when present, else case-insensitive email match against customers. Klaviyo profile ↔ email likewise. Log unmatched rate; surface it in the UI if >5%.
**4.5 Nightly metrics refresh** — per account: snapshot → cohort_grid → product_cohort_ltv → repurchase → churn_daily (join cancellations to subscription_events within ±1 day for labels) → churn_insight → rcm (CAC = month spend ÷ new customers that month; formula + tiers from rcm_config; completeness computed from SKU-cost coverage + spend/OCAS presence).

---

## 5. ONBOARDING WIZARD (`/onboarding`)
Steps, in order. Steps 1–3 must each be **answered** (connected, requested or skipped); steps 4–6 are collected here but do **not** block basic completion — see §5.1 and §5.2:
1. Shopify: connect (domain + credentials) → backfill starts · OR request agency setup · OR mark not used
2. Klaviyo: connect (API key) · OR request agency setup · OR mark not used
3. Recharge: connect (API token) · OR request agency setup · OR mark not used
4. COGS: top ~20 SKUs by revenue prefilled from backfill → enter per-SKU COGS, OR enter one blended gross-margin % *(RCM input)*
5. OCAS: monthly operating cost allocation *(RCM input)*
6. Ad spend: monthly amount per channel (rows: channel + amount; editable later) *(RCM input)*
7. Review → mark account onboarding_complete
Acceptance: an existing account onboards end-to-end in **under one hour** (backfill may continue in background after wizard completes).

### 5.1 Gate 1 — basic onboarding completion
Completion is permitted when **all** of these hold:
- the account exists
- **at least one provider is genuinely connected**
- **no provider remains undecided**
- every provider sits in exactly one of `connected` · `requested` · `skipped`
- every provider represented as connected has a **verified** connection row (an unverified row blocks completion)

**Currency, COGS, blended margin, per-SKU costs, OCAS and ad spend are never consulted by this gate.** That is structural, not conditional: there is no branch to get wrong, which is what makes limited onboarding safe.

**Shopify is not required.** Klaviyo-only completion is valid when Klaviyo is genuinely connected and Shopify and Recharge are each `requested` or `skipped`. The same holds with any other single provider as the connected one.

**The three answered states must stay visibly distinct — never collapsed into one:**

| State | Meaning | Is it "connected"? |
|---|---|---|
| `connected` | credentials verified; a real connected connection row exists | yes |
| `requested` | answered; connection or agency setup assistance still pending | **NO** |
| `skipped` | the brand does not use this platform | **NO** |
| `undecided` | not yet answered — **blocks completion** | no |

A requested platform must never be rendered, described or counted as a successful connection.

**`accounts.onboarding_complete` is a historical completion latch.** It records that the gate passed **at least once**. It does NOT mean the current provider configuration still satisfies the gate, that analytics or RCM are ready now, or that it reverts when provider state later changes — it never reverts by design. Current readiness is always derived separately.

### 5.2 Gate 2 — analytics / RCM readiness (DERIVED, never stored)
Recomputed from live table state on every read, and **deliberately stricter**. It may require: Shopify connected · sufficient eligible order and product data · a valid, non-conflicting currency state · adequate COGS coverage of revenue or a valid blended margin · OCAS · advertising-spend coverage · and every other already-implemented readiness requirement. None of these is relaxed by anything in §5.1.

A workspace may validly show all of the following **at the same time**, and the UI must present that as normal:
- Setup complete
- Limited analytics available
- Analytics not ready

**"Setup complete" must never be documented, labelled or implied as meaning:** RCM ready · all analytics ready · every integration connected · all imports finished · the client personally completed the work.

### 5.3 Agency completion route
`POST /accounts/:id/onboarding/complete`
- the account id comes from the **route path**; it is the only authority
- the frontend sends **no request body**
- a body account identifier is **inert — this route never reads the body**. It is not explicitly rejected here (client-facing `/onboarding/*` routes *do* reject one with `account_identifier_not_permitted`; this route simply has nothing to read it)
- the route **re-runs the whole gate server-side**; the caller's view of the world is irrelevant. A disabled button is never the control
- a refusal returns `409` with the **current onboarding blockers** and writes nothing
- a successful completion does **not** stamp `onboarding_links.completed_at`
- **active client setup links are left unchanged** — not revoked, not expired, not stamped

### 5.4 Client setup links — LOCKED lifecycle (Phase 5C, Option B: restricted manage mode)
Locked after full repository inspection. These are no longer open product decisions.

A client setup link **remains usable after completion**, until its original `expires_at` or agency revocation — but its permissions **narrow the moment the account passes Gate 1**, by either route. Client completion through a link stamps that link's `onboarding_links.completed_at` **once**. Completion does not extend `expires_at`. Re-exchanging the raw token does not extend `expires_at`. Agency revocation ends **every** existing browser session belonging to that link on its next request, because the link row is re-read on every onboarding request.

**Restricted manage mode must be a real permission boundary (§5.4.4).** A link that still behaves identically to first-time setup once its account is complete is not manage mode; it is the absence of one.

#### 5.4.1 Three distinct facts — never collapsed
| Fact | Source of truth | Means |
|---|---|---|
| `onboardingComplete` | `accounts.onboarding_complete` is true | the account passed Gate 1 **at least once**, through *either* the agency route *or* some client link |
| `completedByThisLink` | `onboarding_links.completed_at` is not null | **this specific link** performed a successful client completion |
| `manageMode` | `onboardingComplete` **OR** `completedByThisLink` | this client session is restricted to the §5.4.4 allowlist |

**`manageMode` is a permission state, and it is not a completion-attribution fact.** It answers only "what may this session do now" — never "who completed this account". Deriving it from `completedByThisLink` alone would leave a live link in unrestricted first-time setup mode on an account the agency had **already** completed, which is an open editing surface on a finished account. So the account-level fact restricts too, and the OR is what makes the restriction unconditional.

**Never use `manageMode` alone to display:**
- "this client completed setup"
- "this link completed setup"
- "`completed_at` exists"

Every one of those claims requires **`completedByThisLink`**. The two facts stay separately stored, separately exposed and separately rendered — a permission state and an audit fact are not interchangeable.

`completed_at` is the timestamp of the **first** successful client completion through that link. **Repeated completion must not update it.**

`GET /onboarding/me` must expose enough client-safe information to restore **all three** facts — `onboardingComplete`, `completedByThisLink` and the derived `manageMode` — after a browser reload carrying only the onboarding cookie. A reload cannot re-read the URL fragment, so anything knowable only at token exchange is lost on refresh.

#### 5.4.2 Agency-completed account, client link that has not completed
These three states are valid **together**, and the UI must present them as normal:
- `onboardingComplete` = true
- `completedByThisLink` = false
- `manageMode` = **true**

This is what an agency completing the account looks like from a live client link. In that state:
- the UI **may** truthfully say that setup is complete
- the UI **must not** claim that this client or this link completed it
- **this link immediately receives restricted manage-mode permissions**
- `onboarding_links.completed_at` remains **null**
- the link **may** still call the idempotent client completion endpoint
- a successful client completion stamps **this** link's `completed_at` once
- **`manageMode` stays true before and after that client completion** — the client completion changes the audit fact, not the permission mode

The agency route is unchanged from §5.3: `POST /accounts/:id/onboarding/complete` sets `accounts.onboarding_complete` when Gate 1 passes, does **not** stamp `onboarding_links.completed_at`, leaves the link **active**, and leaves `expires_at` and `revoked_at` untouched. It changes a client link's **permission mode** only because the account-level `onboardingComplete` fact is now true — not by writing anything to the link.

#### 5.4.3 Link expiry — the only access-expiry authority
`onboarding_links.expires_at` is the single access-expiry authority. There is **no** `manage_expires_at` and **no** separate manage-mode timer.

The current default, and the fixed value the agency UI requests, is **14 days**. The existing backend validation accepts a longer TTL (currently 1–90 days), so **14 days is the normal choice, not an enforced backend hard maximum**. Phase 5C does not change that validation.

- completion never extends access
- token re-exchange never extends access
- issuing another onboarding cookie never extends `expires_at`
- expired links are invalid; revoked links are invalid
- after expiry, the agency must issue a **fresh** link when later access is needed
- a cookie's lifetime stays **capped by the remaining lifetime of its link**

#### 5.4.4 Accepted bearer-link risk, and the manage-mode allowlist
Anyone holding the raw token may exchange it until `expires_at` or revocation. What that grants depends on the **account**, not on which link is in hand:

- **before the account has completed Gate 1** — an active link grants normal setup access
- **after the account has completed Gate 1, through either agency or client completion** — **every** active link for that account grants restricted manage-mode access only

A specific link's `completed_at` remains an **independent audit fact** and never widens or narrows this on its own.

This is an accepted, **bounded** bearer-link risk, held in place by: a cryptographically random token · hash-only token storage · the original `expires_at` · immediate agency revocation · tenant-scoped onboarding sessions · full separation from agency sessions · and the allowlist below.

A repeated token exchange **may** issue a new onboarding cookie, but must never extend `expires_at`, bypass revocation, change tenant scope, or **restore unrestricted setup access once `accounts.onboarding_complete` is true**.

The client UI must state plainly that anyone holding the active link may edit the allowed settings until the displayed expiry date or agency revocation. Shared access that is invisible is shared access nobody can decide about.

**ALLOWED when `manageMode` is true:**
- read its own client-safe onboarding status
- read its own safe sync progress and real row counts
- connect Klaviyo when Klaviyo is not already connected
- connect Recharge when Recharge is not already connected
- submit or update a Shopify **domain request** for agency setup when Shopify is not connected
- change `requested` → `skipped` for an **unconnected** provider
- change `skipped` → `requested` for an **unconnected** provider
- update manually editable currency when Shopify is not authoritative
- update blended-margin COGS
- update per-SKU COGS
- change the selected COGS method, retaining the inactive method's values
- update OCAS
- explicitly confirm zero OCAS
- update positive advertising spend
- explicitly confirm zero-spend months
- repeat client completion, idempotently
- log out by clearing its own onboarding cookie

**DENIED when `manageMode` is true:**
- mark a **connected** provider as `requested`
- mark a **connected** provider as `skipped`
- move any provider back to `undecided`
- submit Shopify app credentials directly
- disconnect a provider
- delete provider credentials or provider data
- view stored provider credentials
- regenerate or retrieve provider credentials
- resolve a currency mismatch
- override Shopify-authoritative currency
- see raw sync errors, stack traces, provider exception text or queue internals
- access analytics dashboards
- access agency navigation
- access agency account pages
- list accounts · create accounts · access another account
- create, list or revoke onboarding links
- extend link expiry
- change agency users, roles or permissions

**Every future client route is DENIED in manage mode unless it is explicitly added to this allowlist**, and enforcement must be **centralized** — one gate, one table — so a route added later cannot silently forget the restriction.

#### 5.4.5 Provider request routes
Phase 5C adds client-scoped **request** support for **Klaviyo** and **Recharge**. Shopify request support already exists and stays domain-based.

The four provider states remain exactly `connected` · `requested` · `skipped` · `undecided`, visibly and semantically distinct (§5.1, trap 9). Requesting a provider:
- must **not** create a `connections` row
- must **not** be rendered as connected
- must **not** be counted as a genuine connection
- **does** satisfy the "answered" half of Gate 1
- still leaves completion blocked while **no** provider is genuinely connected

A `requested` or `skipped` unconnected provider may become connected later; a real connection **supersedes** the stored choice for live state derivation. A **connected** provider cannot be moved back to `requested` or `skipped` without an explicit disconnect feature. **Disconnect remains outside Phase 5C.**

#### 5.4.6 Shopify on the client surface
Client users never submit Shopify application credentials. They submit only the **store domain** and request agency setup; direct Shopify credential connection stays agency-only. Client routes must not accept a Shopify client ID, client secret, access token, `useEnvCredentials`, or an account identifier. A Shopify request must not create a fake or placeholder `connections` row.

#### 5.4.7 Financial inputs in manage mode
Manage mode may update financial inputs through the existing client-scoped financial routes. **No existing financial guarantee may be weakened.** All of these stay locked:
- no automatic currency conversion
- both the manual and the Shopify-detected currency are preserved during a mismatch
- mismatch resolution is agency-only; Shopify-authoritative currency cannot be overwritten by a client
- no silent deletion of monetary values
- the inactive COGS method's values remain stored; only the selected method is active for readiness
- positive spend and zero-spend declarations stay mutually exclusive
- replacing positive spend with a zero declaration requires explicit confirmation
- blank, missing or invalid fields are **never** read as zero
- zero COGS, zero OCAS and zero ad spend each require explicit confirmation
- every read and write is scoped **only** through the onboarding session's account
- an account identifier in a request body, query string or path can never redirect a client write

Financial inputs stay outside Gate 1. They may remain incomplete after setup completion and continue blocking **only** analytics/RCM readiness (§5.2).

#### 5.4.8 Token and client-session behaviour
The raw token stays in the URL **fragment**: `/onboarding#token=…`. The client frontend must:
- read the fragment in **one** narrowly approved token-exchange module and nowhere else
- POST the token only in the **body** of `/onboarding/session`
- never place the token in a query string, browser storage, a query key, or application logs
- remove the fragment from the visible URL **immediately** after exchange
- use router **replacement**, so the token-bearing URL never enters browser history

The onboarding cookie stays separate from the agency cookie. Client sessions must never authenticate against agency routes; agency sessions must never authenticate against client onboarding routes. Invalid, malformed, unknown, expired and revoked links keep returning the **same neutral** client-facing failure, revealing neither the reason nor the account. A 401 on the client surface shows the client invalid-link / session-ended screen — it must **not** redirect a client to the agency login page.

#### 5.4.9 Browser acceptance (Phase 5C-6)
Playwright is approved as a **frontend development dependency** for Phase 5C-6 only. The browser suite must prove:
- the public `/onboarding` route exists **outside** ProtectedRoute
- the agency AppShell is never rendered on the client surface
- the token fragment is removed from the visible URL after exchange, and is absent from `document.location.href`
- the HttpOnly onboarding cookie is unreachable through `document.cookie`
- an account that is **not** complete, whose link has not completed, opens in **first-time setup mode**
- a client-completed link opens in **restricted manage mode**
- a **non-completed** link belonging to an **agency-completed** account **also** opens in restricted manage mode
- that last case shows `onboardingComplete` = true and is **already in `manageMode`**, while **not** falsely claiming `completedByThisLink` = true
- a reload carrying a valid onboarding cookie preserves **all three** facts correctly, restoring `onboardingComplete` and `completedByThisLink` **separately** from the derived `manageMode`
- Back does not re-trigger token exchange, does not repaint a submitted credential field, and forward/back navigation exposes no stale sensitive state
- expired or revoked sessions show the neutral client invalid-link screen
- no `/accounts/*` API URL is ever requested by the client wizard
- no horizontal body overflow at **390px · 768px · 1440px**, with wide tables and financial grids scrolling only inside their own container
- no raw provider errors, credentials, tokens, internal IDs or stack traces appear anywhere in the browser

#### 5.4.10 Schema and dependencies
**No Phase 5C migration is required.** The existing fields are sufficient: `onboarding_links.{account_id, token_hash, expires_at, revoked_at, first_used_at, completed_at}` · `accounts.onboarding_complete` · `onboarding_provider_choices.choice`.

**No new backend dependency is required.** Do not add speculative fields: `manage_expires_at`, `last_used_at`, an onboarding session nonce, an onboarding session table, a per-device session id, IP binding, user-agent binding, or a use counter. Each would convert a stateless, per-request-verified principal into stored state that revocation already handles.

#### 5.4.11 Phase 5C implementation sequence
Build one subphase per instruction and stop at its criteria.
| Sub | Deliverable |
|---|---|
| 5C-1 | Client session restore + the restricted manage-mode contract: expose `onboardingComplete`; expose `completedByThisLink`; derive `manageMode` from `onboardingComplete` **OR** `completedByThisLink`; keep every UI completion attribution based **only** on `completedByThisLink`; centralize manage-mode enforcement; prove agency completion restricts **every** active client link **without** stamping `completed_at`; prove a reload restores all three facts; preserve expiry and revocation behaviour |
| 5C-2 | Provider requested/skip/connect behaviour: add client request routes for Klaviyo and Recharge; allow `requested ↔ skipped` only while unconnected; keep all four states distinct; keep Shopify agency-operated |
| 5C-3 | Client financial route verification: prove every §5.4.7 guarantee through the `/onboarding/*` routes, including `/onboarding/ad-spend/zero`, its `requires_replace` conflict, and account-isolation proofs |
| 5C-4 | Completion and route hardening: preserve idempotent completion; rate-limit sensitive client write routes; keep raw provider exception text out of every rendered field; refuse token exchange when the linked account cannot be safely loaded |
| 5C-5 | Client onboarding frontend: public `/onboarding` route, token exchange, client-only shell, provider and financial steps, review/completion, invalid-link and manage-mode states — never any agency navigation |
| 5C-6 | Playwright browser/security acceptance (§5.4.9): fragment removal, history and reload behaviour, cookie behaviour, responsive widths — real frontend against the real backend with mocked provider APIs |

---

## 6. DASHBOARDS (exactly four)
1. **Retention Snapshot** — repeat customers (+trend), repeat net sales, AOV net, repeat %, repeat net sales %; custom range vs prior period. Plus the **RCM tile**: tier badge, core rule verdict ("RCM ≥ OCAS → self-funding" / "fix retention before scaling spend"), completeness indicator ("COGS covering 84% of revenue"), warning state when partial.
2. **Cohort LTV by First Product** — product table (customers, 6m/12m LTV) + cohort grid heatmap (signup month × months since).
3. **Daily Churn Curve (flagship)** — line chart cancellations vs day-active, Day 0–90 default (adjustable); auto-annotation markers with lifecycle labels; filters: cohort month, product, channel, plan type; overlay 2+ cohorts; insight banner from m_churn_insight (correlational wording).
4. **Repurchase Behavior** — repeat rate + time-between-orders combined, filterable by product, cohort, subscriber vs non-subscriber.

---

## 7. BUILD PHASES & ACCEPTANCE
| Phase | Deliverable | ✅ Done when |
|---|---|---|
| 1 | Skeleton: docker, migrations, auth, seed (1 brand: 2yrs orders + 800 subs + campaigns + costs) | Login works; seeded orders > 20,000; seeded cancellations spread across day 0–90 with rebill clustering |
| 2 | Shopify sync + inventory | Pilot store: order count exact vs admin; 12m net sales within 0.5%; live test order < 60s; inventory snapshot rows exist |
| 3 | Recharge sync + identity graph | Subscriber counts + active/cancelled match Recharge; unmatched-identity rate < 5% (or surfaced) |
| 4 | Klaviyo light poller | 3 campaigns within 1% of Klaviyo dashboard |
| 5 | Onboarding wizard | Fresh account onboards in < 1 hour; completion blocked while any provider is undecided or none is connected; **Klaviyo-only completion succeeds with no cost figures present**; COGS/OCAS/spend block only RCM readiness (§5.1–5.2) |
| 6 | Metrics + RCM (config-driven) | Snapshot + product LTV hand-checked vs spreadsheet; churn_daily day-30 count matches hand-count in Recharge; RCM matches hand calculation with placeholder config; partial-state shows when an input is removed |
| 7 | Four dashboards | Team member navigates unaided; churn spike labels sit on real lifecycle days; RCM tile shows completeness |
| 8 | Deletion + hardening | Disconnect provably removes ALL account rows (write a verification script that counts account rows across every table → 0); sync_errors clean for 72h |

**Timeline: full-time 2–3 weeks · part-time (15–20 h/wk) 6–9 weeks.**

---

## 8. KNOWN TRAPS
1. Refunds/edited orders mutate — orders/updated + refunds webhooks + reconciliation all update total_net.
2. Cancelled/test orders excluded everywhere or numbers won't match Shopify admin.
3. The identity graph is the #1 risk: email matching must be case-insensitive/trimmed; measure and surface the unmatched rate.
4. Churn day math: day_active = date(cancelled_at) − date(started_at) in the STORE timezone.
5. Never render a confident tier on incomplete inputs — partial + warning is a feature, not a fallback.
6. Insight wording: "tied to rebill", never "caused by rebill".
7. Recharge rate limits: backoff, never drop silently.
8. **Never merge the two gates.** A single combined blocker list is exactly what makes limited non-Shopify onboarding impossible, and it would tell an agency setup was unfinished when only cost inputs were missing. Two lists, always (§5.1/§5.2).
9. **Never collapse `connected` / `requested` / `skipped`.** A requested platform shown as connected is a fabricated integration — the one lie this surface must not tell.
10. **`onboarding_complete` is a latch, not a live status.** Read current readiness from the derived gate, never from the stored flag.

---

## 9. FIRST PROMPT (paste into Claude Code)
```
Read CLAUDE.md. Build Phase 1 ONLY: docker-compose, migrations 001+002
exactly as section 3, Fastify + session auth, and the seed script per the
Phase 1 acceptance criteria. Stop when Phase 1 criteria are met.
Do not build anything from later phases.
```
Then after each verified phase: `"Phase N verified. Build Phase N+1 only: [deliverable]. Stop at its acceptance criteria."`

---

## 10. ROADMAP (build only after V1 ships)
- **V2 — Agency layer + AI + hourly engagement:** multi-account activation + portfolio + rollout; Ask AI (tool-based, never writes SQL); NOW add Klaviyo event-level storage + hourly engagement tab with send markers.
- **V3 — Automated spend + full email + more subs:** aggregator Path A / direct APIs Path B (manual stays as bridge — apply for ad API approvals DURING V2, they take months); subject lines, flows pages, send-hour, list growth; Skio then Stay.
- **V4 — White-label client access + QBR automation:** roles enforced at API layer, scoped client dashboards, invitation flow, automated Retention Health summaries.

