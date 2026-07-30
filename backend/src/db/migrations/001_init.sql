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
