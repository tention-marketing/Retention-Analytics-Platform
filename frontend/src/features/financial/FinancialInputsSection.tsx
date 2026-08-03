import type { ReactNode } from 'react';
import { AdSpendControl } from './AdSpendControl';
import { CogsControl } from './CogsControl';
import { CurrencyControl } from './CurrencyControl';
import { OcasControl } from './OcasControl';
import { useAccountAdSpend, useAccountCosts, useAccountCurrency } from './useFinancial';

// Financial inputs, inside the account workspace.
//
// FOUR SUBSECTIONS, THREE QUERIES, AND EVERY SUBSECTION FAILS ALONE. Cost of goods
// and monthly operating costs share one query because the backend returns them in
// one response — but currency and ad spend are separate, so a failing ad-spend
// window leaves the currency and cost controls fully usable. A single combined
// query would mean any one failure blanking the whole section, and the ad-spend
// coverage window is the most expensive of the three to compute.
//
// THESE ARE NOT PROVIDER ERRORS. A failure loading a cost figure is a failure of
// this platform's own endpoint, and it is never described as a Shopify, Klaviyo or
// Recharge problem — the platform sections above own that language.
//
// AND THESE CONTROLS ARE NOT MANDATORY. A brand can finish onboarding with Klaviyo
// alone; the backend's completion gate deliberately never consults costs, currency
// or spend. What these inputs unlock is RCM, which needs Shopify. That distinction
// is stated neutrally below rather than by disabling anything: the values are
// perfectly enterable in advance, and an agency preparing a brand should be able
// to enter them.

function Subsection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="rounded-lg border border-[var(--color-border-subtle)]
                 bg-[var(--color-surface)] p-4"
    >
      <h3 id={`${id}-heading`} className="text-sm font-semibold">
        {title}
      </h3>
      <p className="mt-0.5 max-w-prose text-sm text-[var(--color-ink-muted)]">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

interface FinancialInputsSectionProps {
  accountId: number;
  /**
   * Whether Shopify is connected, read from the onboarding status this page
   * already fetches. Used ONLY for a neutral explanatory line — never to disable a
   * control, because these values are legitimate to enter before Shopify is
   * connected and the server has no such rule either.
   */
  shopifyConnected?: boolean | undefined;
}

export function FinancialInputsSection({
  accountId,
  shopifyConnected,
}: FinancialInputsSectionProps) {
  const currency = useAccountCurrency(accountId);
  // One request, two subsections: GET /accounts/:id/costs returns the cost method,
  // the blended margin, OCAS and the SKU coverage together.
  const costs = useAccountCosts(accountId);
  const adSpend = useAccountAdSpend(accountId);

  return (
    <section aria-labelledby="financial-inputs-heading" className="mt-8">
      <h2 id="financial-inputs-heading" className="text-base font-semibold">
        Financial inputs
      </h2>
      <p className="mt-1 max-w-prose text-sm text-[var(--color-ink-muted)]">
        The costs and spend behind this brand&rsquo;s Retention Contribution Margin. Every
        amount is entered by your team and nothing is estimated.
      </p>

      {shopifyConnected === false ? (
        <p className="mt-2 max-w-prose text-sm text-[var(--color-ink-muted)]">
          Shopify is required before RCM can be calculated. These figures can still be
          entered now, and limited onboarding can be completed without them.
        </p>
      ) : null}

      <div className="mt-4 space-y-4">
        <Subsection
          id="financial-currency"
          title="Currency"
          description="The single currency every amount on this page is recorded in. Nothing is converted."
        >
          <CurrencyControl accountId={accountId} resource={currency} />
        </Subsection>

        <Subsection
          id="financial-cogs"
          title="Cost of goods"
          description="Per-product costs, or one blended gross margin. One method is active at a time."
        >
          <CogsControl accountId={accountId} resource={costs} currency={currency.data} />
        </Subsection>

        <Subsection
          id="financial-ocas"
          title="Monthly operating costs"
          description="The share of monthly operating costs allocated to this brand."
        >
          <OcasControl accountId={accountId} resource={costs} currency={currency.data} />
        </Subsection>

        <Subsection
          id="financial-ad-spend"
          title="Advertising spend"
          description="Manual monthly amounts per channel. No advertising platform is connected."
        >
          <AdSpendControl accountId={accountId} resource={adSpend} currency={currency.data} />
        </Subsection>
      </div>
    </section>
  );
}
