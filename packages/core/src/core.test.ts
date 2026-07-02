import { describe, expect, it } from "vitest";
import {
  applyDiscount,
  buildRetailPricesUrl,
  calculateResultLine,
  classifyConfidence,
  createSampleCsv,
  extractStorageAccountName,
  fetchAllRetailPricePages,
  groupByAccountAndRegion,
  isBlobStorageLine,
  matchMeter,
  MAX_CSV_ROWS,
  manualInputToUsage,
  parseUsageCsv,
  resultsToCsv,
  summarizePortfolio,
  summarizePortfolioAssessment,
  summarizeCosts
} from "./index";
import type { DiscountSettings, PortfolioAssessmentInput, PriceMeter, UsageLineItem } from "./types";

const usage: UsageLineItem = {
  id: "u1",
  source: "csv",
  serviceName: "Storage",
  product: "General Purpose v1 Blob Storage",
  meterCategory: "Storage",
  meterSubcategory: "Blob Storage",
  meterName: "Hot LRS Data Stored",
  skuName: "LRS Hot",
  region: "eastus",
  quantity: 100,
  unit: "1 GB/Month",
  unitPrice: 0.02,
  cost: 2,
  currency: "USD",
  redundancy: "LRS",
  accessTier: "Hot",
  included: true,
  modeled: true,
  notes: []
};

const meter = (overrides: Partial<PriceMeter>): PriceMeter => ({
  currencyCode: "USD",
  tierMinimumUnits: 0,
  retailPrice: 0.018,
  unitPrice: 0.018,
  armRegionName: "eastus",
  meterId: "meter-1",
  meterName: "Hot LRS Data Stored",
  productName: "General Block Blob v2",
  skuName: "LRS Hot",
  serviceName: "Storage",
  serviceFamily: "Storage",
  unitOfMeasure: "1 GB/Month",
  type: "Consumption",
  ...overrides
});

const discounts: DiscountSettings = {
  globalDiscountPercent: 10,
  gpV1DiscountPercent: 5,
  gpV2DiscountPercent: 15,
  sameDiscountForBoth: false
};

const defaultManualInput = {
  region: "eastus",
  currency: "USD",
  redundancy: "LRS" as const,
  accessTier: "Hot" as const,
  capacityGb: 100,
  writeOperations: 0,
  readOperations: 0,
  listContainerOperations: 0,
  retrievalGb: 0,
  writeGb: 0,
  geoReplicationGb: 0,
  allOtherOperations: 0,
  deleteOperations: 0,
  deletedDataGb: 0,
  averageDaysRetainedBeforeDelete: 0,
  dataGeoPriorityReplicationGb: 0
};

describe("pricing API helpers", () => {
  it("builds a filtered Azure Retail Prices API URL", () => {
    const url = buildRetailPricesUrl({
      region: "eastus",
      currency: "USD",
      product: "Blob",
      meterName: "Data Stored"
    });

    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(url).toContain("api-version=2023-01-01-preview");
    expect(decoded).toContain("serviceFamily eq 'Storage'");
    expect(decoded).toContain("armRegionName eq 'eastus'");
    expect(decoded).toContain("contains(productName, 'Blob')");
  });

  it("pins to a meter id (region-scoped) and drops fuzzy text filters when provided", () => {
    const url = buildRetailPricesUrl({
      region: "westus2",
      currency: "USD",
      product: "Blob",
      meterName: "General Purpose Data Stored",
      meterId: "c1635534-1c1d-4fc4-b090-88fc2672ef87"
    });

    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).toContain("armRegionName eq 'westus2'");
    expect(decoded).toContain("meterId eq 'c1635534-1c1d-4fc4-b090-88fc2672ef87'");
    expect(decoded).not.toContain("contains(productName");
    expect(decoded).not.toContain("contains(meterName");
  });

  it("follows pagination", async () => {
    const pages: Record<string, { Items: number[]; NextPageLink?: string | null }> = {
      first: { Items: [1], NextPageLink: "second" },
      second: { Items: [2], NextPageLink: null }
    };

    await expect(fetchAllRetailPricePages("first", async (url) => pages[url])).resolves.toEqual([1, 2]);
  });
});

describe("classification and matching", () => {
  it("detects Blob Storage rows and excludes non-Blob services", () => {
    expect(isBlobStorageLine(usage)).toBe(true);
    expect(isBlobStorageLine({ ...usage, product: "Azure Files", meterSubcategory: "Files", meterName: "LRS Data Stored" })).toBe(false);
  });

  it("classifies ambiguous candidate sets as needing confirmation", () => {
    expect(classifyConfidence(98, 1)).toBe("Exact match");
    expect(classifyConfidence(88, 2)).toBe("Strong match");
    expect(classifyConfidence(50, 3)).toBe("Needs review");
    expect(classifyConfidence(10, 1)).toBe("Unmatched");
  });

  it("matches the closest GPv2 public meter", () => {
    const match = matchMeter(usage, [meter({}), meter({ armRegionName: "westus", meterId: "other" })], "gpv2");
    expect(match.confidence).toBe("Exact match");
    expect(match.meter?.meterId).toBe("meter-1");
  });

  it("models GPv1 as Storage kind and GPv2 as StorageV2 target tier", () => {
    const [capacity] = manualInputToUsage({ ...defaultManualInput, accessTier: "Cool" });
    const storageKindMeter = meter({ productName: "General Block Blob", meterName: "LRS Data Stored", skuName: "Standard LRS", meterId: "storage-kind" });
    const storageV2CoolMeter = meter({ productName: "General Block Blob v2", meterName: "Cool LRS Data Stored", skuName: "Cool LRS", meterId: "storage-v2-cool" });
    const storageV2HotMeter = meter({ productName: "General Block Blob v2", meterName: "Hot LRS Data Stored", skuName: "Hot LRS", meterId: "storage-v2-hot" });

    expect(capacity.meterName).toBe("LRS Data Stored");
    expect(capacity.accessTier).toBe("Cool");
    expect(capacity.sourceAccountKind).toBe("Storage");
    expect(capacity.targetAccountKind).toBe("StorageV2");
    expect(matchMeter(capacity, [storageV2CoolMeter, storageKindMeter], "gpv1").meter?.meterId).toBe("storage-kind");
    expect(matchMeter(capacity, [storageV2HotMeter, storageV2CoolMeter], "gpv2").meter?.meterId).toBe("storage-v2-cool");
  });

  it("pins the GPv1 price to the exact billed meter id from the export", () => {
    const billed = { ...usage, meterId: "abc-123" };
    const candidates = [
      meter({ meterId: "abc-123", productName: "General Block Blob", tierMinimumUnits: 0, retailPrice: 0.02 }),
      meter({ meterId: "abc-123", productName: "General Block Blob", tierMinimumUnits: 51200, retailPrice: 0.018 }),
      meter({ meterId: "zzz-999", productName: "General Block Blob" })
    ];
    const match = matchMeter(billed, candidates, "gpv1");

    expect(match.confidence).toBe("Exact match");
    expect(match.meter?.meterId).toBe("abc-123");
    expect(match.meter?.tierMinimumUnits).toBe(0);
    expect(match.candidates).toHaveLength(2);
  });

  it("trusts the billed meter id even when the product text would not score", () => {
    const billed = { ...usage, meterId: "id-match" };
    const match = matchMeter(billed, [meter({ meterId: "ID-Match", productName: "Tables" })], "gpv1");

    expect(match.confidence).toBe("Exact match");
    expect(match.meter?.meterId).toBe("ID-Match");
  });

  it("falls back to fuzzy GPv1 matching when the billed meter id is absent from the price list", () => {
    const billed = { ...usage, meterId: "not-present" };
    const match = matchMeter(
      billed,
      [meter({ productName: "General Block Blob", meterName: "Hot LRS Data Stored", skuName: "Standard LRS", meterId: "meter-1" })],
      "gpv1"
    );

    expect(match.meter?.meterId).toBe("meter-1");
    expect(match.confidence).not.toBe("Unmatched");
    expect(match.notes.join(" ")).not.toContain("Matched the billed meter by ID");
  });

  it("does not apply the export meter id to the GPv2 target", () => {
    const billed = { ...usage, meterId: "meter-1" };
    const match = matchMeter(billed, [meter({ meterId: "meter-1", productName: "General Block Blob" })], "gpv2");

    expect(match.confidence).toBe("Unmatched");
  });

  it("includes StorageV2-only meters with GPv1 cost set to zero", () => {
    const replication = manualInputToUsage({ ...defaultManualInput, writeGb: 25, redundancy: "GRS" }).find((item) => item.id === "manual-geo-transfer")!;
    const gpV1 = matchMeter(replication, [meter({ productName: "General Block Blob", meterName: "GRS Data Stored", skuName: "Standard GRS" })], "gpv1");
    const gpV2 = matchMeter(
      replication,
      [meter({ productName: "Blob Features", meterName: "Data Geo Priority Replication GRS Data Replicated", skuName: "Data Geo Priority Replication GRS", unitOfMeasure: "1 GB", unitPrice: 0.01 })],
      "gpv2"
    );
    const row = calculateResultLine(replication, gpV1, gpV2, { ...discounts, sameDiscountForBoth: true, globalDiscountPercent: 0 });

    expect(gpV1.confidence).toBe("Unmatched");
    expect(gpV2.confidence).toBe("Exact match");
    expect(row.includeInTotals).toBe(true);
    expect(row.gpV1ListCost).toBe(0);
    expect(row.gpV2ListCost).toBeCloseTo(0.25);
  });

  it("automatically derives geo-replication GB from uploaded data for geo-redundant accounts", () => {
    const rows = manualInputToUsage({ ...defaultManualInput, redundancy: "GRS", writeGb: 42 });
    const replication = rows.find((item) => item.id === "manual-geo-transfer");

    expect(replication?.quantity).toBe(42);
    expect(replication?.meterName).toBe("Data Geo Priority Replication GRS Data Replicated");
  });

  it("does not add geo-replication transfer for locally redundant accounts", () => {
    const rows = manualInputToUsage({ ...defaultManualInput, redundancy: "LRS", writeGb: 42 });

    expect(rows.find((item) => item.id === "manual-geo-transfer")).toBeUndefined();
  });

  it("does not add early deletion charges for Hot tier", () => {
    const rows = manualInputToUsage({ ...defaultManualInput, accessTier: "Hot", deletedDataGb: 100, averageDaysRetainedBeforeDelete: 1 });

    expect(rows.find((item) => item.id === "manual-early-delete")).toBeUndefined();
  });

  it("prorates early deletion quantity by remaining retention days", () => {
    const rows = manualInputToUsage({ ...defaultManualInput, accessTier: "Cool", deletedDataGb: 100, averageDaysRetainedBeforeDelete: 21 });
    const earlyDelete = rows.find((item) => item.id === "manual-early-delete");

    expect(earlyDelete?.quantity).toBe(30);
    expect(earlyDelete?.meterName).toBe("Cool LRS Early Delete");
  });

  it("does not borrow Cool or Cold meters when StorageV2 target tier is Hot", () => {
    const hotRetrieval: UsageLineItem = {
      ...usage,
      id: "hot-retrieval",
      meterName: "Data Retrieval",
      quantity: 50,
      unit: "1 GB",
      redundancy: "GRS",
      accessTier: "Hot",
      skuName: "GRS"
    };

    const match = matchMeter(
      hotRetrieval,
      [
        meter({ productName: "General Block Blob v2", meterName: "Cool Data Retrieval", skuName: "Cool GRS", unitOfMeasure: "1 GB", unitPrice: 0.01 }),
        meter({ productName: "General Block Blob v2", meterName: "Cold GRS Data Retrieval", skuName: "Cold GRS", unitOfMeasure: "1 GB", unitPrice: 0.03 })
      ],
      "gpv2"
    );
    const row = calculateResultLine(hotRetrieval, { confidence: "Unmatched", score: 0, candidates: [], notes: [] }, match, discounts);

    expect(match.meter).toBeUndefined();
    expect(match.confidence).toBe("Strong match");
    expect(row.gpV2ListCost).toBe(0);
    expect(row.notes.join(" ")).toContain("No Hot-tier StorageV2 public meter");
  });
});

describe("calculation behavior", () => {
  it("applies bounded discounts", () => {
    expect(applyDiscount(10, 15)).toBe(8.5);
    expect(applyDiscount(10, 150)).toBe(0);
    expect(applyDiscount(10, -20)).toBe(10);
  });

  it("calculates included rows and totals", () => {
    const gpV1 = matchMeter(usage, [meter({ productName: "General Block Blob", meterName: "LRS Data Stored", skuName: "Standard LRS", unitPrice: 0.02 })], "gpv1");
    const gpV2 = matchMeter(usage, [meter({ unitPrice: 0.018 })], "gpv2");
    const row = calculateResultLine(usage, gpV1, gpV2, discounts);
    const summary = summarizeCosts([row]);

    expect(row.includeInTotals).toBe(true);
    expect(summary.gpV1DiscountedTotal).toBeCloseTo(1.9);
    expect(summary.gpV2DiscountedTotal).toBeCloseTo(1.53);
    expect(summary.annualizedDelta).toBeCloseTo(-4.44);
  });

  it("keeps invalid numeric values out of summary totals", () => {
    const gpV1 = matchMeter(usage, [meter({ productName: "General Block Blob", meterName: "LRS Data Stored", skuName: "Standard LRS", unitPrice: 0.02 })], "gpv1");
    const gpV2 = matchMeter(usage, [meter({ unitPrice: 0.018 })], "gpv2");
    const row = calculateResultLine(usage, gpV1, gpV2, { ...discounts, globalDiscountPercent: Number.NaN });
    const summary = summarizeCosts([{ ...row, gpV1DiscountedCost: Number.NaN, gpV2DiscountedCost: 2 }]);

    expect(summary.gpV1DiscountedTotal).toBe(0);
    expect(summary.gpV2DiscountedTotal).toBe(2);
    expect(summary.discountedDeltaPercent).toBe(0);
  });
});

describe("CSV parsing", () => {
  it("parses the sample CSV and excludes non-Blob lines by default", () => {
    const result = parseUsageCsv(createSampleCsv());
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(11);
    expect(result.rows.filter((row) => row.modeled)).toHaveLength(8);
    expect(result.rows.filter((row) => !row.modeled)).toHaveLength(3);
    expect(result.rows.find((row) => row.meterName === "Data Geo Priority Replication GRS Data Replicated")?.modeled).toBe(true);
    expect(result.rows.find((row) => row.meterName === "Blob Inventory")?.notes.join(" ")).toContain("Requires Review");
    expect(result.rows.find((row) => row.product === "Azure Files")?.modeled).toBe(false);
    expect(result.rows.find((row) => row.product === "Queue Storage")?.modeled).toBe(false);
    expect(result.rows.find((row) => row.product === "Table Storage")?.modeled).toBe(false);
  });

  it("accepts common Azure Cost Management export column names", () => {
    const csv = [
      "UsageDate,ConsumedService,ProductName,MeterCategory,MeterSubCategory,MeterName,SkuName,ResourceLocation,UsageQuantity,UnitOfMeasure,EffectivePrice,CostInBillingCurrency,BillingCurrency,ResourceName",
      "2026-05-01,Storage,General Block Blob,Storage,Blob Storage,LRS Data Stored,Standard LRS,eastus,100,1 GB/Month,0.02,2,USD,prodgpv1"
    ].join("\n");
    const result = parseUsageCsv(csv);

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].product).toBe("General Block Blob");
    expect(result.rows[0].region).toBe("eastus");
    expect(result.rows[0].modeled).toBe(true);
  });

  it("accepts real Azure cost export camelCase headers without a SKU column", () => {
    const csv = [
      "date,consumedService,ProductName,meterCategory,meterSubCategory,meterName,resourceLocation,meterRegion,quantity,unitOfMeasure,unitPrice,costInBillingCurrency,billingCurrency,tags",
      "06/15/2026,Microsoft.Storage,General Block Blob,Storage,Blob Storage,Hot LRS Data Stored,eastus,US East,100,1 GB/Month,0.02,2,USD,account=prodgpv1"
    ].join("\n");
    const result = parseUsageCsv(csv);

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].product).toBe("General Block Blob");
    expect(result.rows[0].meterCategory).toBe("Storage");
    expect(result.rows[0].meterName).toBe("Hot LRS Data Stored");
    // resourceLocation (ARM region) is preferred over meterRegion for pricing lookups.
    expect(result.rows[0].region).toBe("eastus");
    expect(result.rows[0].quantity).toBe(100);
    expect(result.rows[0].cost).toBe(2);
    expect(result.rows[0].skuName).toBe("");
    expect(result.rows[0].modeled).toBe(true);
  });

  it("limits oversized CSV row counts", () => {
    const header = "UsageDate,ConsumedService,ProductName,MeterCategory,MeterSubCategory,MeterName,SkuName,ResourceLocation,UsageQuantity,UnitOfMeasure,EffectivePrice,CostInBillingCurrency,BillingCurrency,ResourceName";
    const row = "2026-05-01,Storage,General Block Blob,Storage,Blob Storage,LRS Data Stored,Standard LRS,eastus,100,1 GB/Month,0.02,2,USD,prodgpv1";
    const result = parseUsageCsv([header, ...Array.from({ length: MAX_CSV_ROWS + 1 }, () => row)].join("\n"));

    expect(result.rows).toHaveLength(MAX_CSV_ROWS);
    expect(result.errors.join(" ")).toContain("Only the first");
  });

  it("captures the billed meter id when the export includes one", () => {
    const csv = [
      "UsageDate,ConsumedService,ProductName,MeterCategory,MeterSubCategory,MeterName,SkuName,ResourceLocation,UsageQuantity,UnitOfMeasure,EffectivePrice,CostInBillingCurrency,BillingCurrency,MeterId,ResourceName",
      "2026-05-01,Storage,General Block Blob,Storage,Blob Storage,Hot LRS Data Stored,Standard LRS,eastus,100,1 GB/Month,0.02,2,USD,11111111-2222-3333-4444-555555555555,prodgpv1"
    ].join("\n");
    const result = parseUsageCsv(csv);

    expect(result.rows[0].meterId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("leaves the meter id undefined when the export omits it", () => {
    const csv = [
      "UsageDate,ConsumedService,ProductName,MeterCategory,MeterSubCategory,MeterName,SkuName,ResourceLocation,UsageQuantity,UnitOfMeasure,EffectivePrice,CostInBillingCurrency,BillingCurrency,ResourceName",
      "2026-05-01,Storage,General Block Blob,Storage,Blob Storage,LRS Data Stored,Standard LRS,eastus,100,1 GB/Month,0.02,2,USD,prodgpv1"
    ].join("\n");
    const result = parseUsageCsv(csv);

    expect(result.rows[0].meterId).toBeUndefined();
  });

  it("prefers the ARM resource id over tags when identifying the storage account", () => {
    const header = "date,consumedService,ProductName,meterCategory,meterSubCategory,meterName,resourceLocation,quantity,unitOfMeasure,effectivePrice,costInBillingCurrency,billingCurrency,ResourceId,tags";
    const row = "2026-06-01,Microsoft.Storage,General Block Blob,Storage,Blob Storage,Hot LRS Data Stored,eastus,100,1 GB/Month,0.02,2,USD,/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/realaccount,account=tagaccount";
    const result = parseUsageCsv([header, row].join("\n"));

    expect(result.errors).toEqual([]);
    expect(extractStorageAccountName(result.rows[0].storageAccountName)).toBe("realaccount");
  });

  it("splits multiple accounts from a raw cost export into separate groups", () => {
    const header = "date,consumedService,ProductName,meterCategory,meterSubCategory,meterName,resourceLocation,quantity,unitOfMeasure,effectivePrice,costInBillingCurrency,billingCurrency,ResourceId,tags";
    const mk = (acct: string, region: string) =>
      `2026-06-01,Microsoft.Storage,General Block Blob,Storage,Blob Storage,Hot LRS Data Stored,${region},100,1 GB/Month,0.02,2,USD,/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/${acct},{}`;
    const result = parseUsageCsv([header, mk("alpha", "eastus"), mk("beta", "westus2"), mk("alpha", "eastus")].join("\n"));
    const groups = groupByAccountAndRegion(
      result.rows.filter((row) => row.modeled),
      (row) => row.storageAccountName,
      (row) => row.region
    );

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.account).sort()).toEqual(["alpha", "beta"]);
  });

  it("escapes spreadsheet formula controls in CSV export", () => {
    const gpV1 = matchMeter(usage, [meter({ productName: "General Block Blob", meterName: "LRS Data Stored", skuName: "Standard LRS", unitPrice: 0.02 })], "gpv1");
    const gpV2 = matchMeter(usage, [meter({ unitPrice: 0.018 })], "gpv2");
    const row = calculateResultLine({ ...usage, meterName: "=HYPERLINK(\"https://example.com\")" }, gpV1, gpV2, discounts);
    const csv = resultsToCsv([row]);

    expect(csv).toContain("'=HYPERLINK");
  });
});

describe("extractStorageAccountName", () => {
  it("extracts the account name from an ARM resource id", () => {
    expect(
      extractStorageAccountName(
        "/subscriptions/0000/resourceGroups/rg-prod/providers/Microsoft.Storage/storageAccounts/prodgpv1"
      )
    ).toBe("prodgpv1");
    expect(
      extractStorageAccountName(
        "/subscriptions/0000/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/prodgpv1/blobServices/default"
      )
    ).toBe("prodgpv1");
  });

  it("extracts the account from delimited key=value tag strings", () => {
    expect(extractStorageAccountName("account=prodgpv1;scenario=capacity")).toBe("prodgpv1");
    expect(extractStorageAccountName("scenario=capacity, StorageAccountName=coolstore01")).toBe("coolstore01");
  });

  it("extracts the account from JSON-encoded tags", () => {
    expect(extractStorageAccountName('{"account":"prodgpv1","env":"prod"}')).toBe("prodgpv1");
  });

  it("returns a plain account name or friendly name unchanged", () => {
    expect(extractStorageAccountName("prodgpv1")).toBe("prodgpv1");
    expect(extractStorageAccountName("  Prod Storage  ")).toBe("Prod Storage");
  });

  it("returns undefined when no confident account name is present", () => {
    expect(extractStorageAccountName("")).toBeUndefined();
    expect(extractStorageAccountName(undefined)).toBeUndefined();
    expect(extractStorageAccountName("env=prod;team=storage")).toBeUndefined();
  });

  it("prefers the account tag value over the resource path in the sample CSV", () => {
    const result = parseUsageCsv(createSampleCsv());
    const firstModeled = result.rows.find((row) => row.modeled);

    expect(extractStorageAccountName(firstModeled?.storageAccountName)).toBe("prodgpv1");
  });
});

describe("groupByAccountAndRegion", () => {
  interface Row {
    id: string;
    account?: string;
    region?: string;
  }
  const group = (rows: Row[]) => groupByAccountAndRegion(rows, (row) => row.account, (row) => row.region);

  it("keeps one account in one region as a single group", () => {
    const groups = group([
      { id: "a", account: "prodgpv1", region: "eastus" },
      { id: "b", account: "prodgpv1", region: "eastus" }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].account).toBe("prodgpv1");
    expect(groups[0].region).toBe("eastus");
    expect(groups[0].items.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("splits distinct accounts into separate groups in first-seen order", () => {
    const groups = group([
      { id: "a", account: "prodgpv1", region: "eastus" },
      { id: "b", account: "coolstore01", region: "westus" },
      { id: "c", account: "prodgpv1", region: "eastus" }
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].account).toBe("prodgpv1");
    expect(groups[0].items.map((row) => row.id)).toEqual(["a", "c"]);
    expect(groups[1].account).toBe("coolstore01");
    expect(groups[1].region).toBe("westus");
  });

  it("splits one account across regions so each keeps its own region", () => {
    const groups = group([
      { id: "a", account: "prodgpv1", region: "eastus" },
      { id: "b", account: "prodgpv1", region: "westus" }
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((entry) => entry.region).sort()).toEqual(["eastus", "westus"]);
    expect(groups.every((entry) => entry.account === "prodgpv1")).toBe(true);
  });

  it("absorbs blank regions into the account's dominant region", () => {
    const groups = group([
      { id: "a", account: "prodgpv1", region: "eastus" },
      { id: "b", account: "prodgpv1", region: "eastus" },
      { id: "c", account: "prodgpv1", region: "" }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].region).toBe("eastus");
    expect(groups[0].items).toHaveLength(3);
  });

  it("cleans raw account tags before grouping", () => {
    const groups = group([
      { id: "a", account: "account=prodgpv1;scenario=capacity", region: "eastus" },
      { id: "b", account: "account=prodgpv2;scenario=capacity", region: "eastus" }
    ]);
    expect(groups.map((entry) => entry.account)).toEqual(["prodgpv1", "prodgpv2"]);
  });

  it("buckets rows without a recognizable account together", () => {
    const groups = group([
      { id: "a", account: "env=prod", region: "eastus" },
      { id: "b", region: "eastus" }
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].account).toBeUndefined();
    expect(groups[0].items).toHaveLength(2);
  });
});

describe("portfolio assessment", () => {
  const portfolioInput = (overrides: Partial<PortfolioAssessmentInput> = {}): PortfolioAssessmentInput => {
    const gpV1 = matchMeter(usage, [meter({ productName: "General Block Blob", meterName: "LRS Data Stored", skuName: "Standard LRS", unitPrice: 0.02 })], "gpv1");
    const gpV2 = matchMeter(usage, [meter({ unitPrice: 0.015 })], "gpv2");
    const result = calculateResultLine({ ...usage, quantity: 1000 }, gpV1, gpV2, { ...discounts, sameDiscountForBoth: true, globalDiscountPercent: 0 });

    return {
      id: "assessment-1",
      name: "Production GPv1",
      storageAccountName: "prodgpv1",
      region: "eastus",
      redundancy: "LRS",
      accessTier: "Hot",
      currency: "USD",
      capacityGb: 5000,
      results: [result],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      status: "Active",
      ...overrides
    };
  };

  it("summarizes an assessment with priority, risk, and recommendations", () => {
    const summary = summarizePortfolioAssessment(portfolioInput({ capacityGb: 120000, redundancy: "GRS" }));

    expect(summary.gpV1MonthlyCost).toBeCloseTo(20);
    expect(summary.gpV2MonthlyCost).toBeCloseTo(15);
    expect(summary.annualImpact).toBeCloseTo(-60);
    expect(summary.priority).not.toBeUndefined();
    expect(summary.risk).not.toBeUndefined();
    expect(summary.recommendations.join(" ")).toContain("geo-redundancy");
  });

  it("summarizes active portfolio totals and excludes archived assessments from totals", () => {
    const portfolio = summarizePortfolio([
      portfolioInput({ id: "a", capacityGb: 100 }),
      portfolioInput({ id: "b", capacityGb: 200, status: "Archived" })
    ]);

    expect(portfolio.totalAccounts).toBe(2);
    expect(portfolio.activeAccounts).toBe(1);
    expect(portfolio.archivedAssessments).toHaveLength(1);
    expect(portfolio.totalCapacityGb).toBe(100);
    expect(portfolio.gpV1MonthlyCost).toBeCloseTo(20);
  });
});
