import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { azureArmRegions, buildRetailPricesUrl, fetchAllRetailPricePages, type PriceMeter, type PricingSearchRequest, type PricingSearchResponse } from "@gpv2-estimator/core";

const cache = new Map<string, { refreshedAt: string; candidates: PriceMeter[] }>();
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_VALUE_LENGTH = 120;
const MAX_CANDIDATES = 500;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const allowedRegions = new Set<string>(azureArmRegions.map((region) => region.armRegionName));
const allowedRedundancies = new Set(["LRS", "ZRS", "GRS", "RA-GRS", "GZRS", "RA-GZRS"]);
const allowedAccessTiers = new Set(["Hot", "Cool", "Cold", "Archive"]);
const rateLimit = new Map<string, { windowStartedAt: number; count: number }>();

function stringParam(request: HttpRequest, name: string): string | undefined {
  const value = request.query.get(name)?.trim();
  return value ? value.slice(0, MAX_VALUE_LENGTH) : undefined;
}

function toSearchRequest(request: HttpRequest): PricingSearchRequest {
  return {
    region: stringParam(request, "region") || "eastus",
    currency: stringParam(request, "currency") || "USD",
    product: stringParam(request, "product"),
    skuName: stringParam(request, "skuName"),
    meterName: stringParam(request, "meterName"),
    meterId: stringParam(request, "meterId"),
    unit: stringParam(request, "unit"),
    redundancy: stringParam(request, "redundancy") as PricingSearchRequest["redundancy"],
    accessTier: stringParam(request, "accessTier") as PricingSearchRequest["accessTier"],
    priceType: "Consumption"
  };
}

function clientKey(request: HttpRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-client-ip") || "anonymous";
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  rateLimit.forEach((value, currentKey) => {
    if (now - value.windowStartedAt > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimit.delete(currentKey);
    }
  });
  const current = rateLimit.get(key);
  if (!current || now - current.windowStartedAt > RATE_LIMIT_WINDOW_MS) {
    rateLimit.set(key, { windowStartedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT_MAX_REQUESTS;
}

function validateSearchRequest(search: PricingSearchRequest): string[] {
  const errors: string[] = [];
  if (!allowedRegions.has(search.region)) errors.push("Unsupported region.");
  if (!/^[A-Z]{3}$/.test(search.currency)) errors.push("Currency must be a three-letter ISO code.");
  if (search.redundancy && !allowedRedundancies.has(search.redundancy)) errors.push("Unsupported redundancy.");
  if (search.accessTier && !allowedAccessTiers.has(search.accessTier)) errors.push("Unsupported access tier.");
  if (search.meterId && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(search.meterId)) {
    errors.push("Meter id must be a GUID.");
  }
  [search.product, search.skuName, search.meterName, search.unit].forEach((value) => {
    if (value && value.length > MAX_VALUE_LENGTH) errors.push("One or more query parameters are too long.");
  });
  return [...new Set(errors)];
}

function keyFor(request: PricingSearchRequest): string {
  return JSON.stringify({
    region: request.region,
    currency: request.currency,
    product: request.product,
    skuName: request.skuName,
    meterName: request.meterName,
    meterId: request.meterId,
    priceType: request.priceType
  });
}

function looksLikePriceMeter(value: unknown): value is PriceMeter {
  const item = value as Partial<PriceMeter>;
  return Boolean(item?.meterId && item?.meterName && item?.productName && item?.skuName && item?.unitOfMeasure);
}

async function fetchJson(url: string): Promise<{ Items: unknown[]; NextPageLink?: string | null }> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Azure Retail Prices API returned ${response.status}`);
  }
  return (await response.json()) as { Items: unknown[]; NextPageLink?: string | null };
}

export async function pricesSearch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const caller = clientKey(request);
  if (!checkRateLimit(caller)) {
    return {
      status: 429,
      jsonBody: {
        requestedAt: new Date().toISOString(),
        refreshedAt: new Date().toISOString(),
        cacheHit: false,
        candidates: [],
        error: "Too many pricing requests. Try again shortly."
      }
    };
  }

  const search = toSearchRequest(request);
  const validationErrors = validateSearchRequest(search);
  if (validationErrors.length > 0) {
    return {
      status: 400,
      jsonBody: {
        requestedAt: new Date().toISOString(),
        refreshedAt: new Date().toISOString(),
        cacheHit: false,
        candidates: [],
        error: validationErrors.join(" ")
      }
    };
  }

  const key = keyFor(search);
  const cached = cache.get(key);
  const requestedAt = new Date().toISOString();

  if (cached && Date.now() - Date.parse(cached.refreshedAt) < CACHE_TTL_MS && request.query.get("refresh") !== "true") {
    return {
      jsonBody: {
        requestedAt,
        refreshedAt: cached.refreshedAt,
        cacheHit: true,
        candidates: cached.candidates
      } satisfies PricingSearchResponse
    };
  }

  try {
    const url = buildRetailPricesUrl(search);
    const rawItems = await fetchAllRetailPricePages(url, fetchJson);
    const candidates = rawItems.filter(looksLikePriceMeter).slice(0, MAX_CANDIDATES);
    const refreshedAt = new Date().toISOString();
    cache.set(key, { refreshedAt, candidates });

    return {
      jsonBody: {
        requestedAt,
        refreshedAt,
        cacheHit: false,
        candidates
      } satisfies PricingSearchResponse
    };
  } catch (error) {
    context.error(error);
    if (cached) {
      return {
        status: 206,
        jsonBody: {
          requestedAt,
          refreshedAt: cached.refreshedAt,
          cacheHit: true,
          candidates: cached.candidates,
          warning: "Using cached pricing because the Azure Retail Prices API could not be reached."
        }
      };
    }

    return {
      status: 502,
      jsonBody: {
        requestedAt,
        refreshedAt: requestedAt,
        cacheHit: false,
        candidates: [],
        error: "Pricing lookup failed."
      }
    };
  }
}

app.http("pricesSearch", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "prices/search",
  handler: pricesSearch
});
