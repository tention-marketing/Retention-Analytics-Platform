-- Phase 5A — onboarding foundation.
--
-- STRICTLY ADDITIVE, following 003's precedent: nothing from §3 is dropped,
-- renamed, or redefined; no synced Shopify/Klaviyo/Recharge data is touched; no
-- credential or cost row is erased. Every statement is IF NOT EXISTS / OR
-- REPLACE so a manual re-run is a no-op even outside the schema_migrations
-- bookkeeping in db/migrate.ts.

-- ---------------------------------------------------------------------------
-- 1. Scoped onboarding links (D2)
-- ---------------------------------------------------------------------------
-- Only a SHA-256 hash of the token is stored, so the raw token is
-- unrecoverable from a database dump or a compromised read replica. It is
-- returned exactly once, at creation.
--
-- expires_at / revoked_at are re-read on EVERY onboarding request (not just at
-- token exchange) so a revocation takes effect inside an already-open client
-- session.
CREATE TABLE IF NOT EXISTS onboarding_links (
  id            SERIAL PRIMARY KEY,
  account_id    INT NOT NULL REFERENCES accounts(id),
  token_hash    TEXT NOT NULL UNIQUE,       -- sha256(raw token), hex
  created_by    INT REFERENCES users(id),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  first_used_at TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now());

CREATE INDEX IF NOT EXISTS idx_onb_links_account ON onboarding_links (account_id);

-- ---------------------------------------------------------------------------
-- 2. Per-provider onboarding intent (D1 / D20)
-- ---------------------------------------------------------------------------
-- A skipped or agency-assist-requested platform must NOT become a row in
-- `connections`: credentials_encrypted is NOT NULL (so a placeholder would need
-- a fake credential), and every worker in queue/workers.ts fans out over
-- `connections WHERE status='connected'`, so a placeholder row there would be
-- picked up by real sync jobs.
--
-- 'connected' is deliberately NOT a value here. Connected state is ALWAYS
-- derived from `connections`, keeping exactly one source of truth. When a
-- provider is connected, its choice row is moved back to 'pending' so the row
-- stops occupying the active-request index below (Correction 3).
CREATE TABLE IF NOT EXISTS onboarding_provider_choices (
  account_id       INT NOT NULL REFERENCES accounts(id),
  provider         TEXT NOT NULL CHECK (provider IN ('shopify','klaviyo','recharge')),
  choice           TEXT NOT NULL CHECK (choice IN ('pending','skipped','requested')),
  requested_domain TEXT,        -- shopify only: client-confirmed *.myshopify.com
  decided_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account_id, provider));

-- Correction 3: the unique index on connections.shop_domain (item 6 below) only
-- protects domains that are ALREADY connected. Two accounts could otherwise
-- request the same store simultaneously and both wait for agency setup. This
-- index makes an ACTIVE request exclusive at the database level, so a race
-- loses in Postgres rather than producing two pending claims on one store.
CREATE UNIQUE INDEX IF NOT EXISTS idx_onb_choice_requested_domain_unique
  ON onboarding_provider_choices (lower(requested_domain))
  WHERE provider = 'shopify' AND choice = 'requested' AND requested_domain IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Explicitly confirmed zero-spend months (D3 / Correction 4)
-- ---------------------------------------------------------------------------
-- Presence of a row = the client explicitly confirmed genuinely zero ad spend
-- for that month. Absence = the month has not been answered. This is what makes
-- "an empty field is never read as zero" enforceable, and why no ad_spend row
-- is ever fabricated for an unconfirmed month.
--
-- Correction 4: for one account+month this state and real ad_spend rows are
-- mutually exclusive. The exclusion is enforced transactionally in
-- onboarding/adspend.ts (a cross-table constraint cannot express it), and
-- getRcmReadiness() additionally reports `contradictory_ad_spend_state` if data
-- ever violates it.
CREATE TABLE IF NOT EXISTS ad_spend_zero_months (
  account_id   INT NOT NULL REFERENCES accounts(id),
  month        DATE NOT NULL,
  confirmed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (account_id, month));

-- ---------------------------------------------------------------------------
-- 4. Currency (D7 / E6 / Correction 1)
-- ---------------------------------------------------------------------------
-- No currency existed anywhere in the schema before this migration.
--
-- Three columns, not two, so a conflict can be represented WITHOUT losing
-- either value (Correction 1):
--   currency                  — the currency the account's stored money values
--                               are actually expressed in
--   currency_source           — where that value came from
--   shopify_currency_detected — what Shopify reports, recorded independently
--
-- The `currency_mismatch` readiness blocker is DERIVED from these
-- (shopify_currency_detected IS NOT NULL AND currency <> shopify_currency_detected),
-- never from a manually controlled boolean, so resolving the conflict in the
-- data clears the blocker automatically.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS currency                  TEXT,
  ADD COLUMN IF NOT EXISTS currency_source           TEXT,
  ADD COLUMN IF NOT EXISTS shopify_currency_detected TEXT;

DO $$ BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_currency_source_check
    CHECK (currency_source IS NULL OR currency_source IN ('shopify','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 5. COGS method + explicit zero confirmations (D4 / D5 / E3)
-- ---------------------------------------------------------------------------
-- cogs_method is required because §5 offers per-SKU OR blended: without
-- recording which the account chose, neither the readiness check nor Phase 6's
-- completeness figure can distinguish "chose blended" from "started per-SKU and
-- abandoned it".
--
-- E3: switching method RETAINS the inactive method's values (so 20 SKUs of work
-- is never silently destroyed) and cogs_method alone decides which is active.
-- The views in item 7 are the single safe read path that enforces this.
ALTER TABLE account_costs
  ADD COLUMN IF NOT EXISTS cogs_method         TEXT,
  ADD COLUMN IF NOT EXISTS ocas_zero_confirmed BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE account_costs ADD CONSTRAINT account_costs_cogs_method_check
    CHECK (cogs_method IS NULL OR cogs_method IN ('per_sku','blended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A per-SKU cost of 0 is only accepted when the client explicitly confirms it,
-- so a tabbed-through empty field can never masquerade as a real zero cost.
ALTER TABLE sku_costs
  ADD COLUMN IF NOT EXISTS zero_confirmed BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 6. One Shopify domain, one account (D11 / D16)
-- ---------------------------------------------------------------------------
-- db/connections.ts:getAccountIdByShopDomain() routes incoming webhooks by
-- shop_domain and had no constraint behind it. Two accounts on one domain would
-- silently deliver one store's webhooks into the other store's data. Applied
-- case-insensitively so differing casing cannot evade it.
--
-- This index FAILS LOUDLY if duplicates already exist. That is intended: a
-- silent skip would leave the ambiguity in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_shopify_domain_unique
  ON connections (lower(shop_domain))
  WHERE provider = 'shopify' AND shop_domain IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Active-cost views (E3)
-- ---------------------------------------------------------------------------
-- Phase 6 reads costs from raw SQL in metrics/sql/. These views make it
-- structurally impossible for that SQL to read the INACTIVE method's values, so
-- retained values can never leak into an RCM calculation and blended margin can
-- never be combined with per-SKU COGS. Every cost read — readiness, coverage,
-- and Phase 6 — goes through them.
CREATE OR REPLACE VIEW v_active_sku_costs AS
  SELECT s.account_id, s.sku, s.cogs, s.zero_confirmed
    FROM sku_costs s
    JOIN account_costs c ON c.account_id = s.account_id
   WHERE c.cogs_method = 'per_sku';

CREATE OR REPLACE VIEW v_active_blended_margin AS
  SELECT account_id, blended_margin_pct
    FROM account_costs
   WHERE cogs_method = 'blended' AND blended_margin_pct IS NOT NULL;
