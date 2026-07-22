// Bulk Operation query bodies. `queryFilter` (a Shopify search query string) is
// injected for incremental reconcile; empty for a full backfill.

export function ordersBulkQuery(queryFilter = ''): string {
  const arg = queryFilter ? `(query: "${queryFilter}")` : '';
  return `
{
  orders${arg} {
    edges { node {
      id
      createdAt
      test
      cancelledAt
      currentSubtotalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      customer { id }
      lineItems {
        edges { node {
          id
          sku
          quantity
          title
          product { id title }
          discountedUnitPriceSet { shopMoney { amount } }
          originalUnitPriceSet { shopMoney { amount } }
        } }
      }
    } }
  }
}`;
}

export function customersBulkQuery(queryFilter = ''): string {
  const arg = queryFilter ? `(query: "${queryFilter}")` : '';
  return `
{
  customers${arg} {
    edges { node { id email createdAt } }
  }
}`;
}

export function productsBulkQuery(): string {
  return `
{
  products {
    edges { node { id title } }
  }
}`;
}
