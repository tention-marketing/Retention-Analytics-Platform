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
