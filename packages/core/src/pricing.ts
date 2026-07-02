import type { PricingSearchRequest } from "./types";

const API_VERSION = "2023-01-01-preview";

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildRetailPricesUrl(request: PricingSearchRequest): string {
  const url = new URL("https://prices.azure.com/api/retail/prices");
  url.searchParams.set("api-version", API_VERSION);
  url.searchParams.set("currencyCode", quote(request.currency || "USD"));

  const filters = [
    "serviceFamily eq 'Storage'",
    "priceType eq 'Consumption'",
    `armRegionName eq ${quote(request.region)}`
  ];

  if (request.meterId) {
    // A meter id uniquely identifies the billed meter (per region), so pin to it
    // directly and skip the fuzzy product/sku/meterName text filters.
    filters.push(`meterId eq ${quote(request.meterId)}`);
    url.searchParams.set("$filter", filters.join(" and "));
    return url.toString();
  }

  if (request.product) {
    filters.push(`contains(productName, ${quote(request.product)})`);
  }

  if (request.skuName) {
    filters.push(`contains(skuName, ${quote(request.skuName)})`);
  }

  if (request.meterName) {
    filters.push(`contains(meterName, ${quote(request.meterName)})`);
  }

  url.searchParams.set("$filter", filters.join(" and "));
  return url.toString();
}

export async function fetchAllRetailPricePages<T extends { Items: unknown[]; NextPageLink?: string | null }>(
  initialUrl: string,
  fetcher: (url: string) => Promise<T>,
  maxPages = 20
): Promise<unknown[]> {
  const items: unknown[] = [];
  let nextUrl: string | null | undefined = initialUrl;
  let pages = 0;

  while (nextUrl) {
    pages += 1;
    if (pages > maxPages) {
      throw new Error(`Azure Retail Prices API pagination exceeded ${maxPages} pages.`);
    }
    const page = await fetcher(nextUrl);
    items.push(...page.Items);
    nextUrl = page.NextPageLink;
  }

  return items;
}
