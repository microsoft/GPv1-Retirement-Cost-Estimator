import Papa from "papaparse";
import { classifyUsage } from "./classification";
import { inferAccessTier, inferRedundancy, isBlobStorageLine } from "./mapping";
import type { UsageLineItem } from "./types";

export const requiredCsvColumns = [
  "Billing period",
  "Service name",
  "Product",
  "Meter category",
  "Meter subcategory",
  "Meter name",
  "SKU name",
  "Region",
  "Quantity",
  "Unit",
  "Unit price",
  "Cost",
  "Currency",
  "Tags or storage account name"
];
// Columns that are part of the canonical template but not strictly required for
// an estimate. Real Azure Cost Management / usage exports do not include a
// dedicated SKU name column (the SKU is embedded in the product/meter names),
// so uploads must not be rejected when it is absent.
export const optionalCsvColumns = new Set<string>(["SKU name"]);
export const MAX_CSV_CHARACTERS = 5_000_000;
export const MAX_CSV_ROWS = 5_000;

export interface CsvParseResult {
  rows: UsageLineItem[];
  errors: string[];
}

const columnAliases: Record<string, string[]> = {
  "Billing period": ["Billing period", "BillingPeriod", "Date", "UsageDate", "Usage date"],
  "Service name": ["Service name", "ServiceName", "ConsumedService", "Service"],
  Product: ["Product", "ProductName", "Product name"],
  "Meter category": ["Meter category", "MeterCategory", "Meter category name"],
  "Meter subcategory": ["Meter subcategory", "MeterSubCategory", "Meter subcategory", "MeterSubcategory"],
  "Meter name": ["Meter name", "MeterName"],
  "Meter id": ["Meter id", "MeterId", "Meter ID", "MeterID", "MeterGuid"],
  "SKU name": ["SKU name", "SkuName", "SKUName", "Sku", "SKU"],
  Region: ["Region", "ResourceLocation", "Resource location", "ResourceLocationNormalized", "MeterRegion"],
  Quantity: ["Quantity", "UsageQuantity", "Usage quantity"],
  Unit: ["Unit", "UnitOfMeasure", "Unit of measure", "PricingUnitOfMeasure"],
  "Unit price": ["Unit price", "UnitPrice", "EffectivePrice", "PayGPrice"],
  Cost: ["Cost", "CostInBillingCurrency", "PreTaxCost", "CostInPricingCurrency"],
  Currency: ["Currency", "BillingCurrency", "BillingCurrencyCode", "PricingCurrency"],
  // The ARM resource id/name identify the actual storage account and take priority
  // over tags when deriving an account, since tags are frequently governance blobs
  // (owner, cost centre, "Do Not Delete") that contain no account name.
  "Resource id": ["Resource id", "ResourceId", "Resource ID", "InstanceId", "Instance id"],
  "Resource name": ["Resource name", "ResourceName", "InstanceName", "Instance name"],
  // Kept broad so the account-identity requirement is satisfied by any of these
  // columns; the resource id/name above are preferred when present.
  "Tags or storage account name": ["Tags or storage account name", "Tags", "ResourceId", "ResourceName", "InstanceId", "InstanceName"]
};

// Azure exports vary in header casing and punctuation (e.g. "MeterSubCategory",
// "meterSubCategory", "Meter subcategory"). Normalize to a lowercase,
// alphanumeric-only key so aliases match regardless of casing or separators.
function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveHeader(headers: string[], canonical: string): string | undefined {
  const aliases = columnAliases[canonical] || [canonical];
  for (const alias of aliases) {
    const target = normalizeHeader(alias);
    const match = headers.find((header) => normalizeHeader(header) === target);
    if (match) return match;
  }
  return undefined;
}

function read(row: Record<string, string>, headers: string[], key: string): string {
  const resolved = resolveHeader(headers, key);
  return (resolved ? row[resolved] || "" : "").trim();
}

// Pick the best raw value to derive a storage account from. The ARM resource id
// (e.g. ".../storageAccounts/<name>") and resource/instance name are authoritative,
// so they win over the tags column, which is often governance metadata with no
// account name. Falls back to the first non-empty source, then "".
function deriveAccountSource(row: Record<string, string>, headers: string[]): string {
  const sources = [
    read(row, headers, "Resource id"),
    read(row, headers, "Resource name"),
    read(row, headers, "Tags or storage account name")
  ];
  return sources.find((source) => extractStorageAccountName(source)) ?? sources.find((source) => source) ?? "";
}

function toNumber(value: string): number {
  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseUsageCsv(csvText: string): CsvParseResult {
  if (csvText.length > MAX_CSV_CHARACTERS) {
    return { rows: [], errors: [`CSV content is too large. Maximum supported size is ${MAX_CSV_CHARACTERS.toLocaleString()} characters.`] };
  }

  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim()
  });

  const headers = parsed.meta.fields || [];
  const errors = requiredCsvColumns
    .filter((column) => !optionalCsvColumns.has(column) && !resolveHeader(headers, column))
    .map((column) => `Missing required column: ${column}`);

  parsed.errors.forEach((error) => errors.push(`CSV parse error on row ${error.row ?? "unknown"}: ${error.message}`));
  if (parsed.data.length > MAX_CSV_ROWS) {
    errors.push(`CSV has ${parsed.data.length.toLocaleString()} rows. Only the first ${MAX_CSV_ROWS.toLocaleString()} rows were imported.`);
  }

  const rows = parsed.data.slice(0, MAX_CSV_ROWS).map((row, index) => {
    const serviceName = read(row, headers, "Service name");
    const product = read(row, headers, "Product");
    const meterCategory = read(row, headers, "Meter category");
    const meterSubcategory = read(row, headers, "Meter subcategory");
    const meterName = read(row, headers, "Meter name");
    const skuName = read(row, headers, "SKU name");
    const modeled = isBlobStorageLine({ serviceName, product, meterCategory, meterSubcategory, meterName, skuName });
    const text = `${product} ${meterSubcategory} ${meterName} ${skuName}`;
    const classification = classifyUsage({ serviceName, product, meterCategory, meterSubcategory, meterName, skuName, quantity: 0, modeled });

    return {
      id: `csv-${index + 1}`,
      source: "csv",
      billingPeriod: read(row, headers, "Billing period"),
      serviceName,
      product,
      meterCategory,
      meterSubcategory,
      meterName,
      skuName,
      meterId: read(row, headers, "Meter id") || undefined,
      region: read(row, headers, "Region"),
      quantity: toNumber(read(row, headers, "Quantity")),
      unit: read(row, headers, "Unit"),
      unitPrice: toNumber(read(row, headers, "Unit price")),
      cost: toNumber(read(row, headers, "Cost")),
      currency: read(row, headers, "Currency") || "USD",
      storageAccountName: deriveAccountSource(row, headers),
      sourceAccountKind: "Storage",
      targetAccountKind: "StorageV2",
      redundancy: inferRedundancy(text),
      accessTier: inferAccessTier(text),
      included: modeled,
      modeled,
      notes: modeled ? [`${classification.status}: ${classification.category}. ${classification.reason}`] : [classification.reason]
    } satisfies UsageLineItem;
  });

  return { rows, errors };
}

export function createSampleCsv(): string {
  const rows = [
    requiredCsvColumns.join(","),
    [
      "2026-05",
      "Storage",
      "General Block Blob v1",
      "Storage",
      "Blob Storage",
      "GRS Data Stored",
      "Standard GRS",
      "eastus",
      "1024",
      "1 GB/Month",
      "0.0528",
      "54.07",
      "USD",
      "account=prodgpv1;scenario=capacity"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "General Block Blob v1",
      "Storage",
      "Blob Storage",
      "Write Operations",
      "Standard GRS",
      "eastus",
      "25",
      "10K",
      "0.00036",
      "0.01",
      "USD",
      "account=prodgpv1;scenario=transactions"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "General Block Blob v1",
      "Storage",
      "Blob Storage",
      "Read Operations",
      "Standard GRS",
      "eastus",
      "100",
      "10K",
      "0.00036",
      "0.04",
      "USD",
      "account=prodgpv1;scenario=transactions"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "General Block Blob v1",
      "Storage",
      "Blob Storage",
      "List and Create Container Operations",
      "Standard GRS",
      "eastus",
      "2",
      "10K",
      "0.00036",
      "0.00",
      "USD",
      "account=prodgpv1;scenario=list"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "General Block Blob v1",
      "Storage",
      "Blob Storage",
      "Data Retrieval",
      "Standard GRS",
      "eastus",
      "50",
      "1 GB",
      "0",
      "0",
      "USD",
      "account=prodgpv1;scenario=retrieval"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "General Block Blob v1",
      "Storage",
      "Blob Storage",
      "Data Write",
      "Standard GRS",
      "eastus",
      "25",
      "1 GB",
      "0",
      "0",
      "USD",
      "account=prodgpv1;scenario=write"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "Blob Features",
      "Storage",
      "Blob Storage",
      "Data Geo Priority Replication GRS Data Replicated",
      "Data Geo Priority Replication GRS",
      "eastus",
      "25",
      "1 GB",
      "0",
      "0",
      "USD",
      "account=prodgpv1;scenario=gpv2-only-replication"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "Blob Features",
      "Storage",
      "Blob Storage",
      "Blob Inventory",
      "Blob Inventory",
      "eastus",
      "1",
      "1M",
      "0",
      "0",
      "USD",
      "account=prodgpv1;scenario=requires-review"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "Azure Files",
      "Storage",
      "Files",
      "LRS Data Stored",
      "Standard LRS",
      "eastus",
      "500",
      "1 GB/Month",
      "0.06",
      "30",
      "USD",
      "account=fileacct;scenario=excluded-files"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "Queue Storage",
      "Storage",
      "Queues",
      "Queue Operations",
      "Standard LRS",
      "eastus",
      "10",
      "10K",
      "0.004",
      "0.04",
      "USD",
      "account=queueacct;scenario=excluded-queues"
    ].join(","),
    [
      "2026-05",
      "Storage",
      "Table Storage",
      "Storage",
      "Tables",
      "Table Operations",
      "Standard LRS",
      "eastus",
      "8",
      "10K",
      "0.004",
      "0.03",
      "USD",
      "account=tableacct;scenario=excluded-tables"
    ].join(",")
  ];
  return rows.join("\n");
}

const accountTagKeys = ["storageaccountname", "storageaccount", "accountname", "account", "resourcename", "name"];

function cleanAccountToken(value: string): string {
  return value.trim().replace(/^["']+|["']+$/g, "").trim();
}

function pickAccountFromEntries(entries: Array<[string, string]>): string | undefined {
  const normalized = entries
    .map(([key, value]) => ({ key: key.toLowerCase().replace(/[^a-z0-9]/g, ""), value: cleanAccountToken(value) }))
    .filter((entry) => entry.value.length > 0);
  for (const wanted of accountTagKeys) {
    const hit = normalized.find((entry) => entry.key === wanted);
    if (hit) return hit.value;
  }
  return undefined;
}

/**
 * Derive a clean Azure Storage account name from the free-form value found in the
 * "Tags or storage account name" column of a usage export. Handles ARM resource IDs
 * (`/.../storageAccounts/<name>`), JSON tag blobs, delimited `key=value` tag strings,
 * resource paths, and plain account names. Returns undefined when no confident account
 * name can be extracted, so callers can fall back to another descriptor.
 */
export function extractStorageAccountName(raw: string | null | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;

  const armMatch = value.match(/storageaccounts\/([^/\s]+)/i);
  if (armMatch?.[1]) return cleanAccountToken(armMatch[1]);

  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const entries = Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      );
      return pickAccountFromEntries(entries);
    } catch {
      return undefined;
    }
  }

  if (/[=:]/.test(value)) {
    const entries = value
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.search(/[=:]/);
        return separator === -1
          ? undefined
          : ([part.slice(0, separator), part.slice(separator + 1)] as [string, string]);
      })
      .filter((entry): entry is [string, string] => Boolean(entry));
    return pickAccountFromEntries(entries);
  }

  if (value.includes("/")) {
    const last = value.split("/").map((part) => part.trim()).filter(Boolean).pop();
    return last && !/\s/.test(last) ? cleanAccountToken(last) : undefined;
  }

  return cleanAccountToken(value);
}

export interface AccountRegionGroup<T> {
  /** Cleaned storage account name, or undefined when none could be derived. */
  account?: string;
  /** Region shared by every item in the group (may be "" when unknown). */
  region: string;
  /** Stable identity for the group, unique per (account, region). */
  key: string;
  items: T[];
}

/**
 * Split usage or priced result items into groups that each represent a single
 * storage account in a single region. Multiple accounts in one upload become
 * separate groups so they can be imported as individual portfolio assessments,
 * and an account that appears in more than one region is split per region so
 * each group is priced and labelled with that region's own data. Items whose
 * region is blank are absorbed into their account's most common region so data
 * gaps do not create noise groups. Input order is preserved by first appearance.
 */
export function groupByAccountAndRegion<T>(
  items: T[],
  getRawAccount: (item: T) => string | null | undefined,
  getRegion: (item: T) => string | null | undefined
): AccountRegionGroup<T>[] {
  const accountOf = new Map<T, string | undefined>();
  const regionOf = new Map<T, string>();
  for (const item of items) {
    accountOf.set(item, extractStorageAccountName(getRawAccount(item)));
    regionOf.set(item, (getRegion(item) ?? "").trim());
  }

  // First pass: most common non-empty region per account.
  const regionCounts = new Map<string, Map<string, number>>();
  for (const item of items) {
    const region = regionOf.get(item) ?? "";
    if (!region) continue;
    const accountKey = accountOf.get(item) ?? "";
    const counts = regionCounts.get(accountKey) ?? new Map<string, number>();
    counts.set(region, (counts.get(region) ?? 0) + 1);
    regionCounts.set(accountKey, counts);
  }
  const dominantRegion = new Map<string, string>();
  for (const [accountKey, counts] of regionCounts) {
    let best = "";
    let bestCount = 0;
    for (const [region, count] of counts) {
      if (count > bestCount) {
        best = region;
        bestCount = count;
      }
    }
    dominantRegion.set(accountKey, best);
  }

  // Second pass: bucket by (account, resolved region), preserving first-seen order.
  const groups = new Map<string, AccountRegionGroup<T>>();
  const order: string[] = [];
  for (const item of items) {
    const account = accountOf.get(item);
    const accountKey = account ?? "";
    const region = (regionOf.get(item) || dominantRegion.get(accountKey)) ?? "";
    const key = `${accountKey}|${region}`;
    let group = groups.get(key);
    if (!group) {
      group = { account, region, key, items: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.items.push(item);
  }
  return order.map((key) => groups.get(key) as AccountRegionGroup<T>);
}
