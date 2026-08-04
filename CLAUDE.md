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

### 5.4 Deferred to Phase 5C — DO NOT LOCK HERE
Client-side completion and setup-link lifecycle semantics remain open product decisions. Each must be inspected and locked during Phase 5C, not assumed now:
- whether client completion immediately stamps `onboarding_links.completed_at`
- whether a completed link becomes unusable
- whether a completed link enters a restricted manage mode
- whether a client may keep editing their setup until the link expires

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

