import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  Tab,
  TabList,
  Textarea
} from "@fluentui/react-components";
import {
  calculateResultLine,
  classifyUsage,
  createSampleCsv,
  azureArmRegions,
  MAX_CSV_CHARACTERS,
  manualInputToUsage,
  extractStorageAccountName,
  groupByAccountAndRegion,
  inferAccessTier,
  inferRedundancy,
  matchMeter,
  parseUsageCsv,
  resultsToCsv,
  summarizePortfolio,
  summarizeCosts,
  type AccessTier,
  type AccountRegionGroup,
  type CustomerProfile,
  type DiscountSettings,
  type ManualUsageInput,
  type PortfolioAssessmentInput,
  type PortfolioAssessmentSummary,
  type PriceMeter,
  type PricingSearchResponse,
  type Redundancy,
  type ResultLineItem,
  type UsageLineItem
} from "@gpv2-estimator/core";
import jsPDF from "jspdf";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const defaultManual: ManualUsageInput = {
  region: "eastus",
  currency: "USD",
  redundancy: "LRS",
  accessTier: "Hot",
  capacityGb: 1024,
  writeOperations: 250000,
  readOperations: 1000000,
  listContainerOperations: 20000,
  retrievalGb: 50,
  writeGb: 25,
  geoReplicationGb: 0,
  allOtherOperations: 0,
  deleteOperations: 0,
  deletedDataGb: 0,
  averageDaysRetainedBeforeDelete: 0,
  dataGeoPriorityReplicationGb: 0
};

const defaultDiscounts: DiscountSettings = {
  globalDiscountPercent: 0,
  gpV1DiscountPercent: 0,
  gpV2DiscountPercent: 0,
  sameDiscountForBoth: true
};

const defaultCustomerProfile: CustomerProfile = {
  customerName: "",
  industry: "",
  opportunityId: "",
  accountTeamNotes: "",
  engagementStatus: "Planning",
  assessmentOwner: ""
};

type Step = "input" | "usage" | "pricing" | "results" | "portfolio" | "methodology";
type RegionAvailability = Record<Redundancy, AccessTier[]>;
type CapacityUnit = "GB" | "TB" | "TiB";
type ExperienceMode = "simple" | "advanced";

interface WorkloadTemplate {
  name: string;
  description: string;
  values: Partial<ManualUsageInput>;
  mode: ExperienceMode;
}

interface MigrationAssessment {
  complexity: "Low" | "Medium" | "High";
  score: number;
  notes: string[];
  actions: string[];
  recommendations: string[];
}

interface ScenarioSummary {
  name: string;
  tier: AccessTier;
  redundancy: Redundancy;
  monthlyCost: number;
  annualCost: number;
  monthlyDelta: number;
  replicationImpact: number;
  earlyDeletionImpact: number;
}

interface SavedEstimate {
  version: "1.2" | "1.3";
  savedAt: string;
  manual: ManualUsageInput;
  discounts: DiscountSettings;
  usageRows: UsageLineItem[];
  results: ResultLineItem[];
  pricingRefreshedAt: string;
  experienceMode: ExperienceMode;
  capacityUnit: CapacityUnit;
}

interface SavedPortfolio {
  version: "1.3";
  savedAt: string;
  customerProfile: CustomerProfile;
  assessments: PortfolioAssessmentInput[];
}

const portfolioStorageKey = "gpv1-gpv2-portfolio";
const allRedundancies: Redundancy[] = ["LRS", "ZRS", "GRS", "RA-GRS", "GZRS", "RA-GZRS"];
const accessTierSortOrder: AccessTier[] = ["Hot", "Cool", "Cold", "Archive"];
const conversionAccessTiers: AccessTier[] = ["Hot", "Cool"];
const capacityUnits: CapacityUnit[] = ["GB", "TB", "TiB"];
const azureRetailCurrencies = [
  { code: "AUD", name: "Australian Dollar" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "DKK", name: "Danish Krone" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "INR", name: "Indian Rupee" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "KRW", name: "Korean Won" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "RUB", name: "Russian Ruble" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "TWD", name: "Taiwan Dollar" },
  { code: "USD", name: "US Dollar" }
] as const;
const pricingDisclaimer =
  "Prices are estimates only and are not intended as actual price quotes. Actual pricing may vary depending on the type of agreement entered with Microsoft, date of purchase, and the currency exchange rate. Prices are calculated based on US dollars and converted using London closing spot rates that are captured in the two business days prior to the last business day of the previous month end. If the two business days prior to the end of the month fall on a bank holiday in major markets, the rate setting day is generally the day immediately preceding the two business days. This rate applies to all transactions during the upcoming month. Sign in to the Azure pricing calculator to see pricing based on your current program/offer with Microsoft. Contact an Azure sales specialist for more information on pricing or to request a price quote. See frequently asked questions about Azure pricing.";
const workloadTemplates: WorkloadTemplate[] = [
  {
    name: "Backup Repository",
    description: "Large capacity, moderate writes, low retrieval.",
    mode: "advanced",
    values: { capacityGb: 51200, writeGb: 750, retrievalGb: 50, writeOperations: 200000, readOperations: 100000, accessTier: "Cool" }
  },
  {
    name: "Media Archive",
    description: "High capacity with infrequent reads; modeled as Cool for account conversion.",
    mode: "advanced",
    values: { capacityGb: 102400, writeGb: 250, retrievalGb: 10, readOperations: 25000, writeOperations: 50000, accessTier: "Cool" }
  },
  {
    name: "Analytics Platform",
    description: "Hot data with heavy read and list operations.",
    mode: "advanced",
    values: { capacityGb: 20480, readOperations: 6000000, listContainerOperations: 500000, writeOperations: 800000, retrievalGb: 200, writeGb: 500, accessTier: "Hot" }
  },
  {
    name: "Enterprise File Repository",
    description: "Balanced capacity, reads, writes, and deletes.",
    mode: "advanced",
    values: { capacityGb: 15360, readOperations: 1200000, writeOperations: 600000, deleteOperations: 100000, writeGb: 200, retrievalGb: 150, accessTier: "Hot" }
  },
  {
    name: "Data Lake",
    description: "Large data estate with high list/read activity.",
    mode: "advanced",
    values: { capacityGb: 76800, readOperations: 3500000, listContainerOperations: 1200000, writeOperations: 900000, writeGb: 1000, retrievalGb: 500, accessTier: "Hot" }
  }
];
const fullAvailability: RegionAvailability = allRedundancies.reduce(
  (availability, redundancy) => ({ ...availability, [redundancy]: conversionAccessTiers }),
  {} as RegionAvailability
);
const pricingLookupCache = new Map<string, Promise<PricingSearchResponse>>();
const MAX_JSON_IMPORT_BYTES = 2_000_000;
const MAX_PORTFOLIO_ASSESSMENTS = 500;

function money(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number.isFinite(value) ? value : 0);
}

function compactMoney(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    compactDisplay: "short",
    currency,
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency"
  }).format(Number.isFinite(value) ? value : 0);
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function pricePair(list: number, discounted: number, currency = "USD"): string {
  return `${money(list, currency)} list / ${money(discounted, currency)} discounted`;
}

function sortConversionTiers(tiers: AccessTier[]): AccessTier[] {
  return accessTierSortOrder.filter((tier) => conversionAccessTiers.includes(tier) && tiers.includes(tier));
}

function getAvailabilityLookupKey(region: string, currency: string): string {
  return `${region}:${currency}`;
}

function chartLabel(value: string): string {
  return value.length > 34 ? `${value.slice(0, 31)}...` : value;
}

function numberFromInput(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toGb(value: number, unit: CapacityUnit): number {
  if (unit === "TB") return value * 1000;
  if (unit === "TiB") return value * 1024;
  return value;
}

function fromGb(value: number, unit: CapacityUnit): number {
  if (unit === "TB") return value / 1000;
  if (unit === "TiB") return value / 1024;
  return value;
}

function confidenceClass(confidence: ResultLineItem["confidence"]): string {
  if (confidence === "Exact match") return "exact";
  if (confidence === "Strong match") return "strong";
  if (confidence === "Needs review") return "warn";
  return "bad";
}

function confidenceScore(row: ResultLineItem): number {
  if (row.confidence === "Unmatched") return 0;
  const scores = [row.gpV1.score, row.gpV2.score].filter((score) => Number.isFinite(score) && score > 0);
  return Math.round(scores.length > 0 ? Math.min(...scores) : row.confidence === "Exact match" ? 100 : 90);
}

function usageCategory(row: ResultLineItem): "Capacity" | "Transactions" | "Retrieval" | "Replication" | "Other" {
  const text = `${row.usage.product} ${row.usage.meterName} ${row.usage.unit}`.toLowerCase();
  if (text.includes("data stored") || text.includes("gb/month")) return "Capacity";
  if (text.includes("operation") || text.includes("10k")) return "Transactions";
  if (text.includes("retrieval")) return "Retrieval";
  if (text.includes("replication") || text.includes("replicated")) return "Replication";
  return "Other";
}

function categoryCost(rows: ResultLineItem[], category: ReturnType<typeof usageCategory>): number {
  return rows.filter((row) => row.includeInTotals && usageCategory(row) === category).reduce((sum, row) => sum + row.gpV2DiscountedCost, 0);
}

function assessmentCapacityGb(rows: ResultLineItem[], manualFallback: number): number {
  const capacity = rows
    .filter((row) => row.includeInTotals && usageCategory(row) === "Capacity")
    .reduce((sum, row) => sum + row.quantity, 0);
  return capacity > 0 ? capacity : manualFallback;
}

function inferStorageAccountName(rows: UsageLineItem[], fallback: string): string {
  const modeledFirst = [...rows.filter((row) => row.modeled), ...rows.filter((row) => !row.modeled)];
  for (const row of modeledFirst) {
    const name = extractStorageAccountName(row.storageAccountName);
    if (name) return name;
  }
  return fallback;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function pickMostCommon<T extends string>(values: Array<T | undefined | null>): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function assessmentGroupLabel(
  group: AccountRegionGroup<ResultLineItem>,
  usageRows: UsageLineItem[],
  groups: AccountRegionGroup<ResultLineItem>[]
): string {
  const base = group.account || "Unassigned account";
  const sameAccountAcrossRegions =
    groups.filter((entry) => (entry.account ?? "") === (group.account ?? "")).length > 1;
  const billingPeriod = pickMostCommon(usageRows.map((row) => (row.billingPeriod?.trim() ? row.billingPeriod.trim() : undefined)));
  const qualifier = sameAccountAcrossRegions ? group.region || "unknown region" : billingPeriod;
  return qualifier ? `${base} (${qualifier})` : base;
}

interface BuildAssessmentsOptions {
  customName?: string;
  fallbackName: string;
}

/**
 * Turn a completed estimate into one portfolio assessment per storage account and
 * region. A single-account, single-region upload stays one assessment (named with
 * the user's estimate name); multi-account or multi-region uploads are split so
 * each account keeps its own region, currency, redundancy, tier, capacity, and
 * region-specific pricing rather than being collapsed into one account.
 */
function buildAssessmentsFromEstimate(saved: SavedEstimate, options: BuildAssessmentsOptions): PortfolioAssessmentInput[] {
  const now = new Date().toISOString();
  const groups = groupByAccountAndRegion(
    saved.results,
    (row) => row.usage.storageAccountName,
    (row) => row.usage.region
  );
  const customName = options.customName?.trim();
  const singleGroup = groups.length <= 1;

  return groups.map((group) => {
    const usageRows = group.items.map((row) => row.usage);
    const region = group.region || pickMostCommon(usageRows.map((row) => row.region)) || saved.manual.region;
    const currency = pickMostCommon(usageRows.map((row) => row.currency)) || saved.manual.currency;
    const redundancy = pickMostCommon(usageRows.map((row) => row.redundancy)) || saved.manual.redundancy;
    const accessTier = pickMostCommon(usageRows.map((row) => row.accessTier)) || saved.manual.accessTier;
    const label = assessmentGroupLabel(group, usageRows, groups);
    const name = singleGroup
      ? customName || options.fallbackName
      : customName
        ? `${customName} — ${label}`
        : label;
    const storageAccountName =
      group.account || (singleGroup ? inferStorageAccountName(saved.usageRows, "manual-assessment") : "Unassigned account");

    return {
      id: uid("assessment"),
      name,
      storageAccountName,
      region,
      redundancy,
      accessTier,
      currency,
      capacityGb: assessmentCapacityGb(group.items, singleGroup ? saved.manual.capacityGb : 0),
      results: group.items,
      notes: usageRows.flatMap((row) => row.notes).slice(0, 5),
      createdAt: saved.savedAt || now,
      updatedAt: now,
      status: "Active"
    } satisfies PortfolioAssessmentInput;
  });
}

function portfolioAccountRegionKey(assessment: { storageAccountName: string; region: string }): string {
  return `${(assessment.storageAccountName || "").trim().toLowerCase()}|${(assessment.region || "").trim().toLowerCase()}`;
}

function portfolioToCsv(rows: PortfolioAssessmentSummary[]): string {
  const headers = [
    "Assessment",
    "Storage account",
    "Status",
    "Region",
    "Redundancy",
    "Tier",
    "Capacity GB",
    "GPv1 monthly cost",
    "GPv2 monthly cost",
    "Monthly delta",
    "Annual impact",
    "Priority",
    "Priority score",
    "Risk",
    "Risk score",
    "Complexity",
    "Confidence",
    "Recommendations",
    "Risk indicators"
  ];
  const escape = (value: unknown) => {
    const rawText = String(value ?? "");
    const text = /^[=+\-@\t\r]/.test(rawText) ? `'${rawText}` : rawText;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    headers,
    ...rows.map((row) => [
      row.name,
      row.storageAccountName,
      row.status,
      row.region,
      row.redundancy || "",
      row.accessTier || "",
      row.capacityGb,
      row.gpV1MonthlyCost,
      row.gpV2MonthlyCost,
      row.monthlyDelta,
      row.annualImpact,
      row.priority,
      row.priorityScore,
      row.risk,
      row.riskScore,
      row.complexity,
      row.confidenceScore,
      row.recommendations.join("; "),
      row.riskIndicators.join("; ")
    ])
  ].map((line) => line.map(escape).join(",")).join("\n");
}

function buildMigrationAssessment(rows: ResultLineItem[], usageRows: UsageLineItem[], manual: ManualUsageInput, summaryDelta: number, experienceMode: ExperienceMode): MigrationAssessment {
  const included = rows.filter((row) => row.includeInTotals);
  const total = included.reduce((sum, row) => sum + row.gpV2DiscountedCost, 0);
  const capacityCost = categoryCost(rows, "Capacity");
  const replicationCost = categoryCost(rows, "Replication");
  const unsupportedRows = usageRows.filter((row) => !row.modeled).length;
  const transactionQuantity = usageRows
    .filter((row) => classifyUsage(row).category.includes("Operations"))
    .reduce((sum, row) => sum + row.quantity, 0);

  let score = 20;
  if (manual.capacityGb > 50_000) score += 15;
  if (manual.capacityGb > 100_000) score += 15;
  if (["GRS", "RA-GRS", "GZRS", "RA-GZRS"].includes(manual.redundancy)) score += 15;
  if (manual.accessTier === "Cool") score += 5;
  if (transactionQuantity > 500) score += 10;
  if (unsupportedRows > 0) score += Math.min(20, unsupportedRows * 5);
  if (experienceMode === "simple") score += 5;
  score = Math.min(100, score);

  const complexity: MigrationAssessment["complexity"] = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
  const notes = [
    `${manual.capacityGb.toLocaleString()} GB modeled capacity.`,
    `${manual.redundancy} redundancy and ${manual.accessTier} target tier selected.`,
    unsupportedRows > 0 ? `${unsupportedRows} unsupported or non-modeled rows detected.` : "No unsupported rows detected in the current estimate.",
    experienceMode === "simple" ? "Simple Mode may understate transaction-sensitive workloads." : "Advanced usage inputs are included."
  ];
  const actions = [
    "Review any Needs review or Unmatched pricing rows before sharing externally.",
    "Confirm customer discount assumptions before using the discounted view.",
    unsupportedRows > 0 ? "Validate excluded rows with the customer to confirm they are outside Blob Storage migration scope." : "Validate that the usage sample represents a normal billing period."
  ];
  const recommendations: string[] = [];

  if (total > 0 && capacityCost / total > 0.8) {
    recommendations.push(`Storage capacity represents ${Math.round((capacityCost / total) * 100)}% of modeled GPv2 monthly spend; tier selection should be reviewed carefully.`);
  }
  if (total > 0 && replicationCost / total > 0.25) {
    recommendations.push(`Replication accounts for ${Math.round((replicationCost / total) * 100)}% of modeled GPv2 monthly spend; validate redundancy requirements.`);
  }
  if (manual.retrievalGb < manual.capacityGb * 0.01 && manual.accessTier === "Hot") {
    recommendations.push("Retrieval volume is low relative to capacity; Cool tier may be worth comparing.");
  }
  if (summaryDelta > 0) {
    recommendations.push("The estimate shows a monthly increase; review StorageV2-only meters and discount assumptions with the customer.");
  } else if (summaryDelta < 0) {
    recommendations.push("The estimate shows monthly savings; use the annualized impact in the migration discussion.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Review the customer workload pattern against Hot and Cool conversion scenarios before finalizing migration guidance.");
  }

  return { complexity, score, notes, actions, recommendations };
}

type ManualNumericField = [keyof ManualUsageInput, string];

async function lookupRegionAvailability(region: string, currency: string): Promise<RegionAvailability> {
  const params = new URLSearchParams({
    region,
    currency,
    product: "General Block Blob v2",
    meterName: "Data Stored",
    unit: "1 GB/Month"
  });
  const response = await fetch(`/api/prices/search?${params.toString()}`);
  if (!response.ok && response.status !== 206) {
    throw new Error(`Availability lookup failed for ${region}`);
  }

  const pricing = (await response.json()) as PricingSearchResponse;
  const availability: RegionAvailability = allRedundancies.reduce(
    (current, redundancy) => ({ ...current, [redundancy]: [] }),
    {} as RegionAvailability
  );

  pricing.candidates.forEach((meter) => {
    const text = `${meter.productName} ${meter.skuName} ${meter.meterName}`;
    const redundancy = inferRedundancy(text);
    const tier = inferAccessTier(text);
    if (redundancy && tier && conversionAccessTiers.includes(tier) && !availability[redundancy].includes(tier)) {
      availability[redundancy] = sortConversionTiers([...availability[redundancy], tier]);
    }
  });

  return availability;
}

function pricingLookupKey(row: UsageLineItem): string {
  const meterName = row.meterName.includes("Replication") ? "Replication" : row.meterName;
  return JSON.stringify({
    region: row.region,
    currency: row.currency,
    product: "Blob",
    meterName
  });
}

function pricingFetch(
  params: URLSearchParams,
  key: string,
  meterNameForError: string,
  runCache: Map<string, Promise<PricingSearchResponse>>
): Promise<PricingSearchResponse> {
  const cached = runCache.get(key);
  if (cached) {
    return cached;
  }

  const request = fetch(`/api/prices/search?${params.toString()}`).then(async (response) => {
    if (!response.ok && response.status !== 206) {
      throw new Error(`Pricing lookup failed for ${meterNameForError}`);
    }
    return (await response.json()) as PricingSearchResponse;
  });
  runCache.set(key, request);
  return request;
}

const meterIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function lookupPrices(row: UsageLineItem, target: "gpv1" | "gpv2", refresh = false, runCache = pricingLookupCache): Promise<PricingSearchResponse> {
  // GPv1/current price: when the export carries the billed meter id, pin the
  // public price to that exact meter (scoped to the row's region) instead of the
  // fuzzy meterName text search. This catches meters like the GPv1 capacity meter
  // whose export meterName ("General Purpose Data Stored") does not appear in the
  // Retail Prices API. GPv2 stays inference-based (its target meter isn't billed).
  if (target === "gpv1" && row.meterId && meterIdPattern.test(row.meterId)) {
    const idParams = new URLSearchParams({
      region: row.region,
      currency: row.currency,
      meterId: row.meterId,
      refresh: String(refresh)
    });
    const idKey = `${JSON.stringify({ region: row.region, currency: row.currency, meterId: row.meterId })}:${refresh ? "refresh" : "cached"}`;
    const byId = await pricingFetch(idParams, idKey, row.meterName, runCache);
    if (byId.candidates.length > 0) {
      return byId;
    }
    // Meter id isn't in the public retail prices: fall back to the text lookup.
  }

  const params = new URLSearchParams({
    region: row.region,
    currency: row.currency,
    product: "Blob",
    meterName: row.meterName.includes("Replication") ? "Replication" : row.meterName,
    unit: row.unit,
    refresh: String(refresh)
  });
  if (row.redundancy) params.set("redundancy", row.redundancy);
  params.set("accessTier", target === "gpv1" ? "Hot" : row.accessTier || "Hot");

  const key = `${pricingLookupKey(row)}:${refresh ? "refresh" : "cached"}`;
  return pricingFetch(params, key, row.meterName, runCache);
}

function downloadFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readImportFile(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) {
    return Promise.reject(new Error(`File is too large. Maximum supported size is ${maxBytes.toLocaleString()} bytes.`));
  }
  return file.text();
}

function isSavedEstimate(value: unknown): value is SavedEstimate {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    isRecord(value.manual) &&
    isRecord(value.discounts) &&
    Array.isArray(value.usageRows) &&
    Array.isArray(value.results) &&
    typeof value.pricingRefreshedAt === "string"
  );
}

function isPortfolioAssessment(value: unknown): value is PortfolioAssessmentInput {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.storageAccountName === "string" &&
    typeof value.region === "string" &&
    typeof value.currency === "string" &&
    typeof value.capacityGb === "number" &&
    Array.isArray(value.results) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.status === "Active" || value.status === "Archived")
  );
}

function isSavedPortfolio(value: unknown): value is SavedPortfolio {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    typeof value.savedAt === "string" &&
    isRecord(value.customerProfile) &&
    Array.isArray(value.assessments) &&
    value.assessments.length <= MAX_PORTFOLIO_ASSESSMENTS &&
    value.assessments.every(isPortfolioAssessment)
  );
}

function loadSavedPortfolioState(): {
  customerProfile: CustomerProfile;
  assessments: PortfolioAssessmentInput[];
  status: string;
} {
  if (typeof window === "undefined") {
    return {
      customerProfile: defaultCustomerProfile,
      assessments: [],
      status: "Ready"
    };
  }

  const saved = window.localStorage.getItem(portfolioStorageKey);
  if (!saved) {
    return {
      customerProfile: defaultCustomerProfile,
      assessments: [],
      status: "Ready"
    };
  }

  try {
    const parsed = JSON.parse(saved) as unknown;
    if (!isSavedPortfolio(parsed)) {
      throw new Error("Invalid saved portfolio");
    }

    return {
      customerProfile: { ...defaultCustomerProfile, ...parsed.customerProfile },
      assessments: parsed.assessments || [],
      status: "Ready"
    };
  } catch {
    return {
      customerProfile: defaultCustomerProfile,
      assessments: [],
      status: "Portfolio repository could not be loaded from local storage."
    };
  }
}

export default function App() {
  const initialSavedPortfolio = useMemo(() => loadSavedPortfolioState(), []);
  const [step, setStep] = useState<Step>("input");
  const [mode, setMode] = useState<"manual" | "csv">("manual");
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>("simple");
  const [selectedTemplateName, setSelectedTemplateName] = useState<string>("custom");
  const [capacityUnit, setCapacityUnit] = useState<CapacityUnit>("GB");
  const [manual, setManual] = useState<ManualUsageInput>(defaultManual);
  const [csvText, setCsvText] = useState(createSampleCsv());
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [usageRows, setUsageRows] = useState<UsageLineItem[]>([]);
  const [discounts, setDiscounts] = useState<DiscountSettings>(defaultDiscounts);
  const [results, setResults] = useState<ResultLineItem[]>([]);
  const [pricingRefreshedAt, setPricingRefreshedAt] = useState<string>("Not refreshed yet");
  const [status, setStatus] = useState<string>(initialSavedPortfolio.status);
  const [pricingBusy, setPricingBusy] = useState<boolean>(false);
  const [regionAvailability, setRegionAvailability] = useState<RegionAvailability>(fullAvailability);
  const [availabilityStatusCache, setAvailabilityStatusCache] = useState<{ key: string; message: string }>({ key: "", message: "" });
  const [scenarioRows, setScenarioRows] = useState<ScenarioSummary[]>([]);
  const [scenarioStatus, setScenarioStatus] = useState<string>("Not compared yet");
  const [customerProfile, setCustomerProfile] = useState<CustomerProfile>(initialSavedPortfolio.customerProfile);
  const [portfolioAssessments, setPortfolioAssessments] = useState<PortfolioAssessmentInput[]>(initialSavedPortfolio.assessments);
  const [selectedPortfolioIds, setSelectedPortfolioIds] = useState<string[]>([]);
  const [portfolioEstimateName, setPortfolioEstimateName] = useState("");

  const summary = useMemo(() => summarizeCosts(results), [results]);
  const portfolioSummary = useMemo(() => summarizePortfolio(portfolioAssessments), [portfolioAssessments]);
  const currency = usageRows[0]?.currency || manual.currency || "USD";
  const ignoredUsageRows = useMemo(() => usageRows.filter((row) => !row.modeled).length, [usageRows]);
  const migrationAssessment = useMemo(
    () => buildMigrationAssessment(results, usageRows, manual, summary.discountedDelta, experienceMode),
    [experienceMode, manual, results, summary.discountedDelta, usageRows]
  );
  const chartRows = useMemo(
    () =>
      results
        .filter((row) => row.includeInTotals)
        .map((row) => ({
          delta: row.gpV2DiscountedCost - row.gpV1DiscountedCost,
          gpV1: row.gpV1DiscountedCost,
          gpV2: row.gpV2DiscountedCost,
          name: row.usage.meterName,
          shortName: chartLabel(row.usage.meterName)
        }))
        .sort((a, b) => Math.max(b.gpV1, b.gpV2) - Math.max(a.gpV1, a.gpV2))
        .slice(0, 8),
    [results]
  );
  const largestIncrease = useMemo(() => [...chartRows].sort((a, b) => b.delta - a.delta)[0], [chartRows]);
  const largestDecrease = useMemo(() => [...chartRows].sort((a, b) => a.delta - b.delta)[0], [chartRows]);
  const chartHeight = Math.max(280, chartRows.length * 58 + 80);
  const breakdownRows = useMemo(() => {
    const categories = ["Capacity", "Transactions", "Retrieval", "Replication", "Other"] as const;
    const base = {
      GPv1: Object.fromEntries(categories.map((category) => [category, 0])),
      GPv2: Object.fromEntries(categories.map((category) => [category, 0]))
    } as Record<"GPv1" | "GPv2", Record<(typeof categories)[number], number>>;

    results.filter((row) => row.includeInTotals).forEach((row) => {
      const category = usageCategory(row);
      base.GPv1[category] += row.gpV1DiscountedCost;
      base.GPv2[category] += row.gpV2DiscountedCost;
    });

    return [
      { name: "Current GPv1", ...base.GPv1 },
      { name: "Estimated GPv2", ...base.GPv2 }
    ];
  }, [results]);
  const portfolioCostRows = useMemo(
    () =>
      portfolioSummary.activeAssessments
        .slice()
        .sort((a, b) => Math.max(b.gpV1MonthlyCost, b.gpV2MonthlyCost) - Math.max(a.gpV1MonthlyCost, a.gpV2MonthlyCost))
        .slice(0, 8)
        .map((assessment) => ({
          name: chartLabel(assessment.name),
          fullName: assessment.name,
          gpV1: assessment.gpV1MonthlyCost,
          gpV2: assessment.gpV2MonthlyCost
        })),
    [portfolioSummary.activeAssessments]
  );
  const selectedPortfolioAssessments = useMemo(
    () => portfolioSummary.assessments.filter((assessment) => selectedPortfolioIds.includes(assessment.id)),
    [portfolioSummary.assessments, selectedPortfolioIds]
  );
  const currentEstimatePortfolioMatch = useMemo(() => {
    if (results.length === 0) return false;
    const priced = new Map<string, { gpV1DiscountedCost: number; gpV2DiscountedCost: number }>();
    for (const assessment of portfolioSummary.assessments) {
      for (const row of assessment.results) {
        priced.set(row.usage.id, { gpV1DiscountedCost: row.gpV1DiscountedCost, gpV2DiscountedCost: row.gpV2DiscountedCost });
      }
    }
    // The current estimate may have been split across several assessments (one per
    // account/region), so treat it as "in the portfolio" when every priced row is
    // already represented rather than requiring a single matching assessment.
    return results.every((row) => {
      const match = priced.get(row.usage.id);
      return Boolean(match) && match?.gpV1DiscountedCost === row.gpV1DiscountedCost && match?.gpV2DiscountedCost === row.gpV2DiscountedCost;
    });
  }, [portfolioSummary.assessments, results]);
  const currentEstimateAccountGroups = useMemo(
    () => groupByAccountAndRegion(results, (row) => row.usage.storageAccountName, (row) => row.usage.region),
    [results]
  );
  const currentEstimateAccountCount = useMemo(
    () => new Set(currentEstimateAccountGroups.map((group) => group.account ?? "")).size,
    [currentEstimateAccountGroups]
  );
  const currentEstimateRegionCount = useMemo(
    () => new Set(currentEstimateAccountGroups.map((group) => group.region)).size,
    [currentEstimateAccountGroups]
  );
  const accountSplitNote =
    currentEstimateAccountGroups.length > 1 ? (
      <div className="availability-note">
        {`Detected ${currentEstimateAccountCount} storage account${currentEstimateAccountCount === 1 ? "" : "s"}`}
        {currentEstimateRegionCount > 1 ? ` across ${currentEstimateRegionCount} regions` : ""}
        {". Each account and region is added to the portfolio as its own assessment so every one keeps its own region's pricing."}
      </div>
    ) : null;
  const suggestedPortfolioEstimateName = useMemo(() => {
    const isCsvUsage = usageRows.some((row) => row.source === "csv");
    if (!isCsvUsage) {
      return inferStorageAccountName(usageRows, `${manual.region}-${manual.redundancy}-${manual.accessTier}-estimate`);
    }
    const account = inferStorageAccountName(usageRows, "");
    const billingPeriod = usageRows.find((row) => row.billingPeriod?.trim())?.billingPeriod?.trim();
    if (account) {
      return billingPeriod ? `${account} (${billingPeriod})` : account;
    }
    const region = usageRows.find((row) => row.region?.trim())?.region?.trim();
    const descriptor = [region, billingPeriod].filter(Boolean).join(", ");
    return descriptor ? `Azure cost export (${descriptor})` : "Azure cost export estimate";
  }, [usageRows, manual.accessTier, manual.redundancy, manual.region]);
  const hasCustomerWorkspaceData = useMemo(
    () => portfolioAssessments.length > 0 || Object.entries(customerProfile).some(([key, value]) => key !== "engagementStatus" ? value.trim().length > 0 : value !== "Planning"),
    [customerProfile, portfolioAssessments.length]
  );
  const assumptionItems = useMemo(() => {
    const items = [
      "Pricing source is the public Azure Retail Prices API filtered to Storage consumption meters.",
      "GPv1 is modeled as Azure Storage account kind Storage; GPv2 is modeled as StorageV2.",
      "GPv1 accounts do not expose access tiers; the selected Hot or Cool tier applies only to the GPv2 conversion estimate.",
      "Rows marked Needs review, Unmatched, or Not modeled are excluded from totals by default unless explicitly included.",
      "Discounts are user-entered percentages and are shown separately from Azure public list pricing."
    ];
    if (experienceMode === "simple") {
      items.push("Simple Mode includes capacity only; transaction, retrieval, write, replication, and early deletion quantities default to zero unless Advanced Mode is used.");
    }
    if (["GRS", "RA-GRS", "GZRS", "RA-GZRS"].includes(manual.redundancy)) {
      items.push("Geo-replication data transfer is calculated from Data Write GB for geo-redundant redundancy selections.");
    }
    if (manual.accessTier !== "Hot") {
      items.push("Early deletion uses the selected tier minimum retention period and the entered average days retained before deletion.");
    }
    return items;
  }, [experienceMode, manual.accessTier, manual.redundancy]);
  const availableRedundancies = useMemo(
    () => allRedundancies.filter((redundancy) => regionAvailability[redundancy]?.length > 0),
    [regionAvailability]
  );
  const availableAccessTiers = regionAvailability[manual.redundancy]?.length ? sortConversionTiers(regionAvailability[manual.redundancy]) : conversionAccessTiers;
  const availabilityLookupKey = getAvailabilityLookupKey(manual.region, manual.currency);
  const availabilityStatus =
    availabilityStatusCache.key === availabilityLookupKey
      ? availabilityStatusCache.message
      : `Checking ${manual.region} StorageV2 availability...`;

  useEffect(() => {
    let active = true;
    const [region, currency] = availabilityLookupKey.split(":");
    lookupRegionAvailability(region, currency)
      .then((availability) => {
        if (!active) return;
        const hasAvailability = allRedundancies.some((redundancy) => availability[redundancy].length > 0);
        if (!hasAvailability) {
          setRegionAvailability(fullAvailability);
          setAvailabilityStatusCache({
            key: availabilityLookupKey,
            message: "Regional availability could not be determined; showing all options."
          });
          return;
        }
        setRegionAvailability(availability);
        setAvailabilityStatusCache({
          key: availabilityLookupKey,
          message: "Regional options reflect public StorageV2 Blob meters."
        });
      })
      .catch(() => {
        if (!active) return;
        setRegionAvailability(fullAvailability);
        setAvailabilityStatusCache({
          key: availabilityLookupKey,
          message: "Regional availability could not be determined; showing all options."
        });
      });

    return () => {
      active = false;
    };
  }, [availabilityLookupKey]);

  useEffect(() => {
    const firstRedundancy = availableRedundancies[0];
    if (firstRedundancy && !availableRedundancies.includes(manual.redundancy)) {
      updateManual("redundancy", firstRedundancy);
      return;
    }

    const tiersForRedundancy = regionAvailability[manual.redundancy] || [];
    const firstTier = tiersForRedundancy[0];
    if (firstTier && !tiersForRedundancy.includes(manual.accessTier)) {
      updateManual("accessTier", firstTier);
    }
  }, [availableRedundancies, manual.accessTier, manual.redundancy, regionAvailability]);

  useEffect(() => {
    const saved: SavedPortfolio = {
      version: "1.3",
      savedAt: new Date().toISOString(),
      customerProfile,
      assessments: portfolioAssessments
    };
    window.localStorage.setItem(portfolioStorageKey, JSON.stringify(saved));
  }, [customerProfile, portfolioAssessments]);

  function updateManual<K extends keyof ManualUsageInput>(key: K, value: ManualUsageInput[K]) {
    setManual((current) => ({ ...current, [key]: value }));
  }

  function updateDiscount<K extends keyof DiscountSettings>(key: K, value: DiscountSettings[K]) {
    setDiscounts((current) => {
      const next = { ...current, [key]: value };
      setResults((currentResults) =>
        currentResults.map((row) => ({
          ...calculateResultLine(row.usage, row.gpV1, row.gpV2, next),
          includeInTotals: row.includeInTotals
        }))
      );
      return next;
    });
  }

  function updateCustomerProfile<K extends keyof CustomerProfile>(key: K, value: CustomerProfile[K]) {
    setCustomerProfile((current) => ({ ...current, [key]: value }));
  }

  function updateCapacity(value: number, unit = capacityUnit) {
    setManual((current) => ({ ...current, capacityGb: toGb(value, unit) }));
  }

  function updateCapacityUnit(unit: CapacityUnit) {
    setCapacityUnit(unit);
  }

  function applyTemplate(template: WorkloadTemplate) {
    setManual((current) => ({ ...current, ...template.values }));
    setExperienceMode(template.mode);
    setSelectedTemplateName(template.name);
    setCapacityUnit("GB");
    setStatus(`Applied ${template.name} template`);
  }

  async function calculateRows(rows: UsageLineItem[]): Promise<ResultLineItem[]> {
    const runCache = new Map<string, Promise<PricingSearchResponse>>();
    return Promise.all(rows.map(async (row) => {
      if (!row.included || !row.modeled) {
        const unmatched = { confidence: "Unmatched" as const, score: 0, candidates: [], notes: row.notes };
        return calculateResultLine(row, unmatched, unmatched, discounts);
      }

      const [gpV1Pricing, gpV2Pricing] = await Promise.all([
        lookupPrices(row, "gpv1", false, runCache),
        lookupPrices(row, "gpv2", false, runCache)
      ]);
      return calculateResultLine(
        row,
        matchMeter(row, gpV1Pricing.candidates as PriceMeter[], "gpv1"),
        matchMeter(row, gpV2Pricing.candidates as PriceMeter[], "gpv2"),
        discounts
      );
    }));
  }

  async function runScenarioComparison() {
    setScenarioStatus("Comparing scenarios...");
    const alternateTier: AccessTier = manual.accessTier === "Cool" ? "Hot" : "Cool";
    const alternateRedundancy = availableRedundancies.find((redundancy) => redundancy !== manual.redundancy);
    const scenarios = [
      { name: "Current recommendation", input: manual },
      { name: `${alternateTier} tier`, input: { ...manual, accessTier: alternateTier } }
    ];
    if (alternateRedundancy) {
      scenarios.push({ name: `${alternateRedundancy} redundancy`, input: { ...manual, redundancy: alternateRedundancy } });
    }

    try {
      const nextRows: ScenarioSummary[] = [];
      for (const scenario of scenarios) {
        const scenarioUsage = manualInputToUsage(scenario.input);
        const scenarioResults = await calculateRows(scenarioUsage);
        const scenarioSummary = summarizeCosts(scenarioResults);
        nextRows.push({
          name: scenario.name,
          tier: scenario.input.accessTier,
          redundancy: scenario.input.redundancy,
          monthlyCost: scenarioSummary.gpV2DiscountedTotal,
          annualCost: scenarioSummary.gpV2DiscountedTotal * 12,
          monthlyDelta: scenarioSummary.discountedDelta,
          replicationImpact: categoryCost(scenarioResults, "Replication"),
          earlyDeletionImpact: scenarioResults
            .filter((row) => row.includeInTotals && row.usage.meterName.toLowerCase().includes("early delete"))
            .reduce((sum, row) => sum + row.gpV2DiscountedCost, 0)
        });
      }
      setScenarioRows(nextRows);
      setScenarioStatus("Scenario comparison complete");
    } catch (error) {
      setScenarioStatus(error instanceof Error ? error.message : "Scenario comparison failed");
    }
  }

  function currentSavedEstimate(): SavedEstimate {
    return {
      version: "1.3",
      savedAt: new Date().toISOString(),
      manual,
      discounts,
      usageRows,
      results,
      pricingRefreshedAt,
      experienceMode,
      capacityUnit
    };
  }

  function addCurrentEstimateToPortfolio() {
    if (results.length === 0) {
      setStatus("Calculate an estimate before adding it to the portfolio.");
      return;
    }
    const remaining = MAX_PORTFOLIO_ASSESSMENTS - portfolioAssessments.length;
    if (remaining <= 0) {
      setStatus(`Portfolio already has the maximum of ${MAX_PORTFOLIO_ASSESSMENTS} assessments. Remove some before adding more.`);
      return;
    }
    const assessments = buildAssessmentsFromEstimate(currentSavedEstimate(), {
      customName: portfolioEstimateName,
      fallbackName: portfolioEstimateName.trim() || suggestedPortfolioEstimateName
    });
    const toAdd = assessments.slice(0, remaining);
    const skipped = assessments.length - toAdd.length;
    setPortfolioAssessments((current) => [...toAdd, ...current]);
    setSelectedPortfolioIds(toAdd.map((assessment) => assessment.id));
    setPortfolioEstimateName("");
    if (toAdd.length > 1) {
      const regionCount = new Set(toAdd.map((assessment) => assessment.region)).size;
      const regionNote = regionCount > 1 ? ` across ${regionCount} regions` : "";
      const skippedNote = skipped > 0 ? ` (${skipped} skipped — portfolio limit reached)` : "";
      setStatus(`Added ${toAdd.length} storage accounts${regionNote} to portfolio${skippedNote}.`);
    } else {
      setStatus(`Added ${toAdd[0].name} to portfolio.`);
    }
    setStep("portfolio");
  }

  // A raw cost export can contain many storage accounts. When more than one is
  // detected we build the per-account/region assessments and jump straight to a
  // populated portfolio (deduping by account+region so re-uploads update in place)
  // instead of leaving the user on the single-estimate Pricing Review page.
  function maybeAutoBuildPortfolio(rows: UsageLineItem[], priced: ResultLineItem[]) {
    if (priced.length === 0) return;
    const groups = groupByAccountAndRegion(priced, (row) => row.usage.storageAccountName, (row) => row.usage.region);
    const accountCount = new Set(groups.map((group) => group.account ?? "")).size;
    if (accountCount <= 1) return;

    const saved: SavedEstimate = { ...currentSavedEstimate(), usageRows: rows, results: priced };
    const assessments = buildAssessmentsFromEstimate(saved, {
      customName: "",
      fallbackName: inferStorageAccountName(rows, "Azure cost export estimate")
    });
    if (assessments.length === 0) return;

    setPortfolioAssessments((current) => {
      const incomingKeys = new Set(assessments.map(portfolioAccountRegionKey));
      const kept = current.filter((assessment) => !incomingKeys.has(portfolioAccountRegionKey(assessment)));
      return [...assessments, ...kept].slice(0, MAX_PORTFOLIO_ASSESSMENTS);
    });
    setSelectedPortfolioIds(assessments.map((assessment) => assessment.id));

    const regionCount = new Set(assessments.map((assessment) => assessment.region)).size;
    const regionNote = regionCount > 1 ? ` across ${regionCount} regions` : "";
    setStatus(`Imported ${accountCount} storage accounts${regionNote} into your portfolio from the CSV.`);
    setStep("portfolio");
  }

  function exportEstimateJson() {
    const saved = currentSavedEstimate();
    window.localStorage.setItem("gpv1-gpv2-last-estimate", JSON.stringify(saved));
    downloadFile("gpv1-gpv2-estimate.json", JSON.stringify(saved, null, 2), "application/json;charset=utf-8");
  }

  function exportPortfolioJson() {
    const saved: SavedPortfolio = {
      version: "1.3",
      savedAt: new Date().toISOString(),
      customerProfile,
      assessments: portfolioAssessments
    };
    downloadFile("gpv1-gpv2-portfolio.json", JSON.stringify(saved, null, 2), "application/json;charset=utf-8");
  }

  function exportPortfolioCsv() {
    downloadFile("gpv1-gpv2-portfolio.csv", portfolioToCsv(portfolioSummary.activeAssessments), "text/csv;charset=utf-8");
  }

  function recalculateResults(nextResults: ResultLineItem[], nextDiscounts: DiscountSettings) {
    return nextResults.map((row) => ({
      ...calculateResultLine(row.usage, row.gpV1, row.gpV2, nextDiscounts),
      includeInTotals: row.includeInTotals
    }));
  }

  function loadEstimate(saved: SavedEstimate) {
    setManual(saved.manual);
    setDiscounts(saved.discounts);
    setUsageRows(saved.usageRows || []);
    setResults(recalculateResults(saved.results || [], saved.discounts));
    setPricingRefreshedAt(saved.pricingRefreshedAt || "Not refreshed yet");
    setExperienceMode(saved.experienceMode || "advanced");
    setSelectedTemplateName("custom");
    setCapacityUnit(saved.capacityUnit || "GB");
    setStep(saved.results?.length ? "results" : saved.usageRows?.length ? "usage" : "input");
    setStatus(`Loaded estimate from ${saved.savedAt}`);
  }

  function loadPortfolioAssessment(assessment: PortfolioAssessmentInput) {
    setManual((current) => ({
      ...current,
      region: assessment.region,
      currency: assessment.currency,
      redundancy: assessment.redundancy || current.redundancy,
      accessTier: assessment.accessTier || current.accessTier,
      capacityGb: assessment.capacityGb
    }));
    setResults(assessment.results);
    setUsageRows(assessment.results.map((row) => row.usage));
    setPricingRefreshedAt(assessment.updatedAt);
    setStep("results");
    setStatus(`Loaded ${assessment.name} from portfolio.`);
  }

  function clonePortfolioAssessment(assessment: PortfolioAssessmentInput) {
    const clone = {
      ...assessment,
      id: uid("assessment"),
      name: `${assessment.name} copy`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "Active" as const
    };
    setPortfolioAssessments((current) => [clone, ...current]);
    setSelectedPortfolioIds([clone.id]);
    setStatus(`Cloned ${assessment.name}.`);
  }

  function renamePortfolioAssessment(assessment: PortfolioAssessmentInput) {
    const nextName = window.prompt("Rename portfolio estimate", assessment.name)?.trim();
    if (!nextName || nextName === assessment.name) {
      return;
    }
    setPortfolioAssessments((current) =>
      current.map((item) =>
        item.id === assessment.id
          ? { ...item, name: nextName, updatedAt: new Date().toISOString() }
          : item
      )
    );
    setStatus(`Renamed ${assessment.name} to ${nextName}.`);
  }

  function archivePortfolioAssessment(id: string) {
    setPortfolioAssessments((current) =>
      current.map((assessment) =>
        assessment.id === id
          ? { ...assessment, status: assessment.status === "Archived" ? "Active" : "Archived", updatedAt: new Date().toISOString() }
          : assessment
      )
    );
  }

  function removePortfolioAssessment(id: string) {
    setPortfolioAssessments((current) => current.filter((assessment) => assessment.id !== id));
    setSelectedPortfolioIds((current) => current.filter((selectedId) => selectedId !== id));
  }

  function clearPortfolioAssessments() {
    if (portfolioAssessments.length === 0) {
      return;
    }
    const shouldClear = window.confirm("Clear all saved portfolio assessments from this browser?");
    if (!shouldClear) {
      return;
    }
    setPortfolioAssessments([]);
    setSelectedPortfolioIds([]);
    setStatus("Cleared saved portfolio assessments from this browser.");
  }

  function clearCustomerWorkspace() {
    if (!hasCustomerWorkspaceData) {
      return;
    }
    const shouldClear = window.confirm("Clear the customer workspace, including customer details and saved portfolio assessments from this browser?");
    if (!shouldClear) {
      return;
    }
    setCustomerProfile(defaultCustomerProfile);
    setPortfolioAssessments([]);
    setSelectedPortfolioIds([]);
    setStatus("Cleared the customer workspace from this browser.");
  }

  function togglePortfolioSelection(id: string, selected: boolean) {
    setSelectedPortfolioIds((current) => (selected ? [...new Set([...current, id])] : current.filter((selectedId) => selectedId !== id)));
  }

  function importEstimateFile(file: File) {
    void readImportFile(file, MAX_JSON_IMPORT_BYTES)
      .then((text) => {
        const parsed = JSON.parse(text) as unknown;
        if (isSavedPortfolio(parsed)) {
          setCustomerProfile({ ...defaultCustomerProfile, ...parsed.customerProfile });
          setPortfolioAssessments(parsed.assessments || []);
          setSelectedPortfolioIds([]);
          setStep("portfolio");
          setStatus(`Loaded portfolio from ${parsed.savedAt}`);
          return;
        }
        if (!isSavedEstimate(parsed)) {
          throw new Error("JSON file is not a supported estimate or portfolio export.");
        }
        loadEstimate(parsed);
      })
      .catch((error) => {
        setStatus(error instanceof Error ? error.message : "Could not import JSON file.");
      });
  }

  async function createUsage() {
    setPricingBusy(true);
    try {
      if (mode === "manual") {
        const rows = manualInputToUsage(manual);
        setUsageRows(rows);
        setCsvErrors([]);
        await priceUsageRows(rows, false, "results");
        return;
      }

      const parsed = parseUsageCsv(csvText);
      setCsvErrors(parsed.errors);
      setUsageRows(parsed.rows);
      if (parsed.errors.length > 0 || parsed.rows.length === 0) {
        setStatus(parsed.errors.length > 0 ? "CSV validation needs review" : "No CSV usage rows found");
        setStep("usage");
        return;
      }
      if (!parsed.rows.some((row) => row.modeled)) {
        setStatus("No Blob Storage usage found. All uploaded line items were ignored as non-GPv1/GPv2 usage.");
        setStep("usage");
        return;
      }
      const priced = await priceUsageRows(parsed.rows, false, "results");
      maybeAutoBuildPortfolio(parsed.rows, priced);
    } finally {
      setPricingBusy(false);
    }
  }

  function toggleRow(id: string, included: boolean) {
    setUsageRows((rows) => rows.map((row) => (row.id === id ? { ...row, included } : row)));
  }

  async function priceUsageRows(rows: UsageLineItem[], refresh = false, nextStep: Step = "pricing"): Promise<ResultLineItem[]> {
    setStatus(refresh ? "Refreshing public Azure prices..." : "Matching public Azure prices...");
    const runCache = new Map<string, Promise<PricingSearchResponse>>();
    let latestRefresh = pricingRefreshedAt;

    // Only Blob Storage usage relevant to a GPv1/GPv2 estimate is priced. Line items from
    // raw Azure cost exports that are not Blob Storage (VMs, networking, SQL, Files, etc.)
    // are ignored here so they never surface on the Pricing Review page or in exports.
    const priceableRows = rows.filter((row) => row.modeled);

    const nextResults = await Promise.all(priceableRows.map(async (row) => {
      if (!row.included || !row.modeled) {
        const unmatched = { confidence: "Unmatched" as const, score: 0, candidates: [], notes: row.notes };
        return calculateResultLine(row, unmatched, unmatched, discounts);
      }

      try {
        const [gpV1Pricing, gpV2Pricing] = await Promise.all([
          lookupPrices(row, "gpv1", refresh, runCache),
          lookupPrices(row, "gpv2", refresh, runCache)
        ]);
        latestRefresh = gpV2Pricing.refreshedAt;
        window.sessionStorage.setItem("pricingRefreshedAt", gpV2Pricing.refreshedAt);
        return calculateResultLine(
          row,
          matchMeter(row, gpV1Pricing.candidates as PriceMeter[], "gpv1"),
          matchMeter(row, gpV2Pricing.candidates as PriceMeter[], "gpv2"),
          discounts
        );
      } catch (error) {
        const fallback = { confidence: "Unmatched" as const, score: 0, candidates: [], notes: [error instanceof Error ? error.message : "Pricing lookup failed."] };
        return calculateResultLine(row, fallback, fallback, discounts);
      }
    }));

    setPricingRefreshedAt(latestRefresh);
    setResults(nextResults);
    setStatus("Pricing match complete");
    setStep(nextStep);
    return nextResults;
  }

  async function runPricing(refresh = false, nextStep: Step = "pricing") {
    setPricingBusy(true);
    try {
      await priceUsageRows(usageRows, refresh, nextStep);
    } finally {
      setPricingBusy(false);
    }
  }

  function includeAmbiguous(id: string, includeInTotals: boolean) {
    setResults((rows) => rows.map((row) => (row.usage.id === id ? { ...row, includeInTotals } : row)));
  }

  function exportCsv() {
    downloadFile("gpv1-gpv2-estimate.csv", resultsToCsv(results), "text/csv;charset=utf-8");
  }

  function exportPdf() {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("GPv1 to GPv2 Billing Impact Estimate", 14, 18);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toISOString()}`, 14, 28);
    doc.text(`Pricing refreshed: ${pricingRefreshedAt}`, 14, 34);
    doc.text("Estimate only. Uses public Azure Retail Prices API meters and user-entered discounts.", 14, 42);
    doc.text(`Currency: ${currency}`, 14, 48);
    doc.setFontSize(12);
    doc.text(`Current GPv1 monthly cost: ${pricePair(summary.gpV1ListTotal, summary.gpV1DiscountedTotal, currency)}`, 14, 60);
    doc.text(`Estimated GPv2 monthly cost: ${pricePair(summary.gpV2ListTotal, summary.gpV2DiscountedTotal, currency)}`, 14, 68);
    doc.text(`Monthly delta: ${money(summary.discountedDelta, currency)} (${pct(summary.discountedDeltaPercent)})`, 14, 76);
    doc.text(`Annualized delta: ${money(summary.annualizedDelta, currency)}`, 14, 84);
    doc.setFontSize(10);
    doc.text(`Migration readiness: ${migrationAssessment.complexity} (${migrationAssessment.score}/100)`, 14, 98);
    doc.text("Recommendations", 14, 106);
    let y = 114;
    migrationAssessment.recommendations.slice(0, 3).forEach((recommendation) => {
      doc.text(`- ${recommendation}`, 14, y, { maxWidth: 180 });
      y += 10;
    });
    doc.text("Assumptions", 14, y + 2);
    y += 10;
    assumptionItems.slice(0, 5).forEach((assumption) => {
      doc.text(`- ${assumption}`, 14, y, { maxWidth: 180 });
      y += 10;
    });
    doc.text("Methodology: discountedUnitPrice = listUnitPrice * (1 - discountPercent / 100). Annualized impact = monthly discounted delta * 12.", 14, y + 4, { maxWidth: 180 });
    y += 20;
    results.slice(0, 12).forEach((row) => {
      doc.text(`${row.usage.meterName}: ${row.confidence}, ${money(row.delta, currency)} delta`, 14, y);
      y += 8;
    });
    doc.save("gpv1-gpv2-estimate.pdf");
  }

  function exportPortfolioPdf() {
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text("GPv1 to GPv2 Portfolio Assessment", 14, 18);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toISOString()}`, 14, 28);
    doc.text(`Customer: ${customerProfile.customerName || "Not specified"}`, 14, 34);
    doc.text(`Opportunity: ${customerProfile.opportunityId || "Not specified"} · Owner: ${customerProfile.assessmentOwner || "Not specified"}`, 14, 40);
    doc.text("Estimate only. Uses public Azure Retail Prices API meters and user-entered discounts.", 14, 48);
    doc.setFontSize(12);
    doc.text(`Accounts assessed: ${portfolioSummary.activeAccounts}`, 14, 62);
    doc.text(`Total capacity: ${portfolioSummary.totalCapacityGb.toLocaleString()} GB`, 14, 70);
    doc.text(`Current GPv1 monthly: ${money(portfolioSummary.gpV1MonthlyCost, currency)}`, 14, 78);
    doc.text(`Estimated GPv2 monthly: ${money(portfolioSummary.gpV2MonthlyCost, currency)}`, 14, 86);
    doc.text(`Annual impact: ${money(portfolioSummary.annualImpact, currency)}`, 14, 94);
    doc.text(`High priority: ${portfolioSummary.highPriorityCount} · High risk: ${portfolioSummary.highRiskCount}`, 14, 102);
    doc.setFontSize(10);
    doc.text("Top migration priorities", 14, 116);
    let y = 124;
    portfolioSummary.activeAssessments
      .slice()
      .sort((a, b) => b.priorityScore - a.priorityScore)
      .slice(0, 8)
      .forEach((assessment) => {
        doc.text(
          `${assessment.name}: ${assessment.priority} priority, ${assessment.risk} risk, ${money(assessment.annualImpact, assessment.currency)} annual impact`,
          14,
          y,
          { maxWidth: 180 }
        );
        y += 8;
      });
    doc.text("Assumptions: public pricing, no private discounts beyond user-entered percentages, no taxes/credits/reservations/support.", 14, y + 8, { maxWidth: 180 });
    doc.save("gpv1-gpv2-portfolio.pdf");
  }

  const manualNumericFields: ManualNumericField[] = [
    ["writeOperations", "Monthly write operations"],
    ["readOperations", "Monthly read operations"],
    ["listContainerOperations", "List/create container operations"],
    ["retrievalGb", "Data retrieval GB"],
    ["writeGb", "Data write GB"],
    ["allOtherOperations", "All other operations"],
    ["deleteOperations", "Delete operations"],
    ...(manual.accessTier === "Hot"
      ? []
      : ([
          ["deletedDataGb", "StorageV2 deleted GB"],
          ["averageDaysRetainedBeforeDelete", "Deleted after X days (average)"]
        ] as ManualNumericField[]))
  ];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Azure Storage</p>
          <h1>GPv1 to GPv2 Billing Impact Estimator</h1>
        </div>
        <div className="status-pill">{status}</div>
      </header>

      <section className="intro-band">
        <div>
          <p className="eyebrow">Version 1.3 portfolio assessment</p>
          <h2>Estimate the financial impact of upgrading Azure Storage GPv1 accounts to GPv2.</h2>
          <p>This tool uses publicly available Azure list pricing, user-provided usage, and optional discounts to create a transparent migration estimate.</p>
        </div>
        <div className="pricing-source-card">
          <span>Pricing source</span>
          <strong>Azure Retail Prices API</strong>
          <small>Currency {currency} · {pricingRefreshedAt}</small>
        </div>
      </section>

      <TabList selectedValue={step} onTabSelect={(_, data) => setStep(data.value as Step)} className="tabs">
        <Tab value="input">1 Input</Tab>
        <Tab value="usage">2 Usage Review</Tab>
        <Tab value="pricing">3 Pricing Review</Tab>
        <Tab value="results">4 Results</Tab>
        <Tab value="portfolio">Portfolio</Tab>
        <Tab value="methodology">Methodology</Tab>
      </TabList>

      <div className="disclaimer">{pricingDisclaimer}</div>

      {step === "input" && (
        <section className="layout-two">
          <div className="panel">
            <h2>Usage Input</h2>
            <div className="account-kind-row">
              <span>Current kind: <strong>Storage</strong></span>
              <span>Target kind: <strong>StorageV2</strong></span>
            </div>
            <div className="segmented">
              <Button appearance={mode === "manual" ? "primary" : "secondary"} onClick={() => setMode("manual")}>Manual entry</Button>
              <Button appearance={mode === "csv" ? "primary" : "secondary"} onClick={() => setMode("csv")}>CSV upload</Button>
            </div>

            {mode === "manual" ? (
              <div className="stack">
                <div className="template-grid">
                  {workloadTemplates.map((template) => (
                    <button
                      className={`template-card ${selectedTemplateName === template.name ? "selected" : ""}`}
                      key={template.name}
                      type="button"
                      onClick={() => applyTemplate(template)}
                    >
                      <strong>{template.name}</strong>
                      <span>{template.description}</span>
                    </button>
                  ))}
                </div>
                <Field label="Workload template">
                  <Select
                    value={selectedTemplateName}
                    onChange={(event) => {
                      const template = workloadTemplates.find((item) => item.name === event.target.value);
                      if (template) applyTemplate(template);
                      else setSelectedTemplateName("custom");
                    }}
                  >
                    <option value="custom">Custom workload</option>
                    {workloadTemplates.map((template) => (
                      <option key={template.name} value={template.name}>
                        {template.name} - {template.description}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="form-grid">
                  <Field label="Region">
                    <Select value={manual.region} onChange={(event) => updateManual("region", event.target.value)}>
                      {azureArmRegions.map((region) => (
                        <option key={region.armRegionName} value={region.armRegionName}>
                          {region.name} ({region.armRegionName})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Currency">
                    <Select value={manual.currency} onChange={(event) => updateManual("currency", event.target.value)}>
                      {azureRetailCurrencies.map((currencyOption) => (
                        <option key={currencyOption.code} value={currencyOption.code}>
                          {currencyOption.code} - {currencyOption.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Redundancy">
                    <Select value={manual.redundancy} onChange={(event) => updateManual("redundancy", event.target.value as Redundancy)}>
                      {availableRedundancies.map((value) => <option key={value}>{value}</option>)}
                    </Select>
                  </Field>
                  <Field label="Target GPv2 tier">
                    <Select value={manual.accessTier} onChange={(event) => updateManual("accessTier", event.target.value as AccessTier)}>
                      {availableAccessTiers.map((value) => <option key={value}>{value}</option>)}
                    </Select>
                  </Field>
                  <Field label="Monthly capacity">
                    <div className="input-pair">
                      <Input type="number" value={String(Number(fromGb(manual.capacityGb, capacityUnit).toFixed(4)))} onChange={(_, data) => updateCapacity(numberFromInput(data.value))} />
                      <Select value={capacityUnit} onChange={(event) => updateCapacityUnit(event.target.value as CapacityUnit)}>
                        {capacityUnits.map((value) => <option key={value}>{value}</option>)}
                      </Select>
                    </div>
                  </Field>
                  <div className="mode-card">
                    <Field label="Estimate detail">
                      <Select value={experienceMode} onChange={(event) => setExperienceMode(event.target.value as ExperienceMode)}>
                        <option value="simple">Simple Mode - capacity only</option>
                        <option value="advanced">Advanced Mode - include transactions and lifecycle signals</option>
                      </Select>
                    </Field>
                  </div>
                  {experienceMode === "advanced" && manualNumericFields.map(([key, label]) => (
                      <Field key={key} label={label}>
                        <Input type="number" value={String(manual[key])} onChange={(_, data) => updateManual(key, numberFromInput(data.value))} />
                      </Field>
                    ))}
                </div>
              </div>
            ) : (
              <div className="stack">
                <div className="wizard-steps">
                  {["Upload", "Validate", "Preview rows", "Classify usage", "Map categories", "Estimate"].map((label, index) => (
                    <span key={label}>{index + 1}. {label}</span>
                  ))}
                </div>
                <div className="availability-note">CSV upload accepts the app template and raw Azure Cost Management usage exports. Column headers are matched case-insensitively (e.g. meterName, meterCategory, resourceLocation, unitOfMeasure, quantity, costInBillingCurrency), and a SKU name column is optional.</div>
                <input type="file" accept=".csv,text/csv" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void readImportFile(file, MAX_CSV_CHARACTERS)
                      .then(setCsvText)
                      .catch((error) => setStatus(error instanceof Error ? error.message : "Could not read CSV file."));
                  }
                }} />
                <Textarea value={csvText} onChange={(_, data) => setCsvText(data.value)} resize="vertical" className="csv-box" />
                <Button onClick={() => downloadFile("sample-usage.csv", createSampleCsv(), "text/csv;charset=utf-8")}>Download sample CSV</Button>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Discounts</h2>
            <Checkbox checked={discounts.sameDiscountForBoth} onChange={(_, data) => updateDiscount("sameDiscountForBoth", Boolean(data.checked))} label="Use the same discount for GPv1 and GPv2" />
            {discounts.sameDiscountForBoth ? (
              <Field label="Global discount %"><Input type="number" min={0} max={100} value={String(discounts.globalDiscountPercent)} onChange={(_, data) => updateDiscount("globalDiscountPercent", numberFromInput(data.value))} /></Field>
            ) : (
              <div className="form-grid single">
                <Field label="GPv1 discount %"><Input type="number" min={0} max={100} value={String(discounts.gpV1DiscountPercent)} onChange={(_, data) => updateDiscount("gpV1DiscountPercent", numberFromInput(data.value))} /></Field>
                <Field label="GPv2 discount %"><Input type="number" min={0} max={100} value={String(discounts.gpV2DiscountPercent)} onChange={(_, data) => updateDiscount("gpV2DiscountPercent", numberFromInput(data.value))} /></Field>
              </div>
            )}
            <div className="warning">GPv1 is Azure Storage account kind Storage, which has no access tiers. GPv2 account conversion supports Hot and Cool target access tiers in this estimator. Cold and Archive are optimization scenarios, not direct conversion targets.</div>
            <div className="availability-note">{availabilityStatus}</div>
            {["GRS", "RA-GRS", "GZRS", "RA-GZRS"].includes(manual.redundancy) && (
              <div className="warning">Geo-replication data transfer is calculated automatically from Data write GB because this redundancy option replicates writes to a second region.</div>
            )}
            <Button appearance="primary" size="large" onClick={() => void createUsage()} disabled={pricingBusy}>
              {pricingBusy ? "Calculating estimate..." : "Calculate estimate"}
            </Button>
          </div>
        </section>
      )}

      {step === "usage" && (
        <section className="panel">
          <div className="panel-header">
            <h2>Usage Review</h2>
            <Button appearance="primary" onClick={() => void runPricing(false, "results")} disabled={usageRows.length === 0 || pricingBusy}>
              {pricingBusy ? "Matching prices..." : "Update estimate"}
            </Button>
          </div>
          {csvErrors.length > 0 && <div className="error">{csvErrors.join(" ")}</div>}
          {ignoredUsageRows > 0 && (
            <div className="availability-note">
              {ignoredUsageRows} of {usageRows.length} uploaded line {usageRows.length === 1 ? "item" : "items"} {ignoredUsageRows === 1 ? "is" : "are"} not Blob Storage usage. {ignoredUsageRows === 1 ? "It is" : "They are"} ignored for GPv1/GPv2 estimation and excluded from the Pricing Review and the estimate totals.
            </div>
          )}
          <UsageTable rows={usageRows} onToggle={toggleRow} />
        </section>
      )}

      {step === "pricing" && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Pricing Match Review</h2>
              <p className="muted">Pricing refreshed: {pricingRefreshedAt}</p>
            </div>
            <div className="button-row">
              <Button onClick={() => void runPricing(true)} disabled={pricingBusy}>{pricingBusy ? "Refreshing..." : "Refresh pricing"}</Button>
              <Button appearance="primary" onClick={() => setStep("results")} disabled={results.length === 0}>View results</Button>
            </div>
          </div>
          {ignoredUsageRows > 0 && (
            <div className="availability-note">
              {ignoredUsageRows} non-Blob-Storage line {ignoredUsageRows === 1 ? "item was" : "items were"} ignored from the uploaded file and {ignoredUsageRows === 1 ? "is" : "are"} not shown below. Only GPv1/GPv2 Blob Storage usage is priced.
            </div>
          )}
          {results.length === 0 ? (
            <div className="chart-empty">
              No Blob Storage usage was found to price.{ignoredUsageRows > 0 ? ` ${ignoredUsageRows} uploaded line ${ignoredUsageRows === 1 ? "item was" : "items were"} ignored as non-Blob-Storage usage.` : ""}
            </div>
          ) : (
            <PricingTable rows={results} onInclude={includeAmbiguous} />
          )}
        </section>
      )}

      {step === "results" && (
        <section className="stack">
          <div className="next-step-panel">
            <div>
              <p className="chart-kicker">Next step</p>
              <h2>{currentEstimatePortfolioMatch ? "This estimate is in the portfolio" : "Add this estimate to your portfolio"}</h2>
              <p className="chart-subtitle">
                {currentEstimatePortfolioMatch
                  ? "Use the Portfolio workspace to compare this assessment with other accounts, priorities, risks, and executive reporting."
                  : "Save this completed assessment into the portfolio workspace for prioritization, risk scoring, comparison, and executive reporting."}
              </p>
              {!currentEstimatePortfolioMatch && (
                <div className="next-step-form">
                  <Field label="Estimate name">
                    <Input value={portfolioEstimateName} placeholder={suggestedPortfolioEstimateName} onChange={(_, data) => setPortfolioEstimateName(data.value)} />
                  </Field>
                  {accountSplitNote}
                </div>
              )}
            </div>
            <div className="button-row">
              {currentEstimatePortfolioMatch ? (
                <Button appearance="primary" onClick={() => setStep("portfolio")}>View in portfolio</Button>
              ) : (
                <Button appearance="primary" onClick={addCurrentEstimateToPortfolio} disabled={results.length === 0}>Add to portfolio</Button>
              )}
              <Button onClick={() => setStep("pricing")}>Review pricing</Button>
            </div>
          </div>
          <div className="summary-grid">
            <Metric title="Current GPv1 monthly cost" value={money(summary.gpV1DiscountedTotal, currency)} detail={`List ${money(summary.gpV1ListTotal, currency)}`} />
            <Metric title="Estimated GPv2 monthly cost" value={money(summary.gpV2DiscountedTotal, currency)} detail={`List ${money(summary.gpV2ListTotal, currency)}`} />
            <Metric title="Monthly delta" value={`${money(summary.discountedDelta, currency)} ${pct(summary.discountedDeltaPercent)}`} detail={`List delta ${money(summary.listDelta, currency)} ${pct(summary.listDeltaPercent)}`} tone={summary.discountedDelta > 0 ? "bad" : "good"} />
            <Metric title="Discount impact" value={money(summary.gpV2ListTotal - summary.gpV2DiscountedTotal, currency)} detail={`GPv1 impact ${money(summary.gpV1ListTotal - summary.gpV1DiscountedTotal, currency)}`} />
            <Metric title="Annualized delta" value={money(summary.annualizedDelta, currency)} detail="Based on discounted monthly delta" tone={summary.annualizedDelta > 0 ? "bad" : "good"} />
          </div>
          <div className="panel readiness-panel">
            <div>
              <p className="chart-kicker">Migration readiness</p>
              <h2>{migrationAssessment.complexity} complexity · {migrationAssessment.score}/100</h2>
              <p className="chart-subtitle">Based on modeled volume, redundancy, tier, transaction signal, unsupported rows, and input completeness.</p>
            </div>
            <div className="readiness-grid">
              <div>
                <h3>Notes</h3>
                <ul>{migrationAssessment.notes.map((note) => <li key={note}>{note}</li>)}</ul>
              </div>
              <div>
                <h3>Recommended actions</h3>
                <ul>{migrationAssessment.actions.map((action) => <li key={action}>{action}</li>)}</ul>
              </div>
              <div>
                <h3>Recommendations</h3>
                <ul>{migrationAssessment.recommendations.map((recommendation) => <li key={recommendation}>{recommendation}</li>)}</ul>
              </div>
            </div>
          </div>
          <div className="panel chart-panel">
            <div className="chart-header">
              <div>
                <p className="chart-kicker">Included rows only</p>
                <h2>Monthly Cost Drivers</h2>
                <p className="chart-subtitle">Sorted by the larger of current GPv1 or estimated GPv2 cost.</p>
                <div className="chart-legend">
                  <span><i className="legend-swatch gpv1" />Current GPv1</span>
                  <span><i className="legend-swatch gpv2" />Estimated GPv2</span>
                </div>
              </div>
              <div className={`delta-chip ${summary.discountedDelta > 0 ? "up" : "down"}`}>
                {summary.discountedDelta > 0 ? "Increase" : "Savings"} {money(Math.abs(summary.discountedDelta), currency)}
              </div>
            </div>
            {chartRows.length > 0 ? (
              <>
                <div className="chart-insights">
                  <div className="insight">
                    <span>Total GPv1</span>
                    <strong>{money(summary.gpV1DiscountedTotal, currency)}</strong>
                  </div>
                  <div className="insight">
                    <span>Total GPv2</span>
                    <strong>{money(summary.gpV2DiscountedTotal, currency)}</strong>
                  </div>
                  {largestIncrease && largestIncrease.delta > 0 && (
                    <div className="insight">
                      <span>Largest increase</span>
                      <strong>{largestIncrease.shortName}: {money(largestIncrease.delta, currency)}</strong>
                    </div>
                  )}
                  {largestDecrease && largestDecrease.delta < 0 && (
                    <div className="insight">
                      <span>Largest savings</span>
                      <strong>{largestDecrease.shortName}: {money(Math.abs(largestDecrease.delta), currency)}</strong>
                    </div>
                  )}
                </div>
                <div className="chart-shell">
                  <ResponsiveContainer width="100%" height={chartHeight}>
                    <BarChart data={chartRows} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 8 }} barCategoryGap={14}>
                      <CartesianGrid horizontal={false} stroke="#e5e7eb" />
                      <XAxis axisLine={false} tickLine={false} tickFormatter={(value) => compactMoney(Number(value), currency)} type="number" />
                      <YAxis axisLine={false} dataKey="shortName" tickLine={false} type="category" width={220} />
                      <Tooltip
                        cursor={{ fill: "#f3f6fb" }}
                        formatter={(value, name) => [money(Number(value), currency), name]}
                        labelFormatter={(label) => chartRows.find((row) => row.shortName === label)?.name || label}
                      />
                      <Bar dataKey="gpV1" fill="#2563eb" name="Current GPv1" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="gpV2" fill="#15803d" name="Estimated GPv2" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            ) : (
              <div className="chart-empty">Calculate an estimate and include matched rows to see the cost-driver breakdown.</div>
            )}
          </div>
          <div className="panel chart-panel">
            <div className="chart-header">
              <div>
                <p className="chart-kicker">Discounted monthly view</p>
                <h2>Cost Breakdown</h2>
                <p className="chart-subtitle">Capacity, transactions, retrieval, replication, and other modeled rows.</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={breakdownRows} margin={{ top: 12, right: 24, bottom: 8, left: 8 }}>
                <CartesianGrid vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="name" />
                <YAxis tickFormatter={(value) => compactMoney(Number(value), currency)} />
                <Tooltip formatter={(value, name) => [money(Number(value), currency), name]} />
                <Legend />
                <Bar dataKey="Capacity" stackId="cost" fill="#2563eb" />
                <Bar dataKey="Transactions" stackId="cost" fill="#0f766e" />
                <Bar dataKey="Retrieval" stackId="cost" fill="#7c3aed" />
                <Bar dataKey="Replication" stackId="cost" fill="#ea580c" />
                <Bar dataKey="Other" stackId="cost" fill="#64748b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="panel">
            <h2>Assumptions</h2>
            <ul className="assumption-list">
              {assumptionItems.map((assumption) => <li key={assumption}>{assumption}</li>)}
            </ul>
          </div>
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Scenario Comparison</h2>
                <p className="muted">{scenarioStatus}</p>
              </div>
              <Button onClick={() => void runScenarioComparison()} disabled={mode !== "manual" || usageRows.length === 0}>Compare scenarios</Button>
            </div>
            {scenarioRows.length > 0 ? (
              <div className="scenario-grid">
                {scenarioRows.map((scenario) => (
                  <div className="scenario-card" key={scenario.name}>
                    <span>{scenario.name}</span>
                    <strong>{money(scenario.monthlyCost, currency)}</strong>
                    <small>{scenario.tier} · {scenario.redundancy}</small>
                    <small>Annual {money(scenario.annualCost, currency)}</small>
                    <small>Monthly delta {money(scenario.monthlyDelta, currency)}</small>
                    <small>Replication {money(scenario.replicationImpact, currency)} · Early delete {money(scenario.earlyDeletionImpact, currency)}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="chart-empty">Calculate the current manual estimate, then compare alternate Hot/Cool and redundancy scenarios.</div>
            )}
          </div>
          <div className="panel">
            <div className="panel-header">
              <h2>Customer-ready Breakdown</h2>
              <div className="button-row">
                <Button onClick={exportCsv} disabled={results.length === 0}>Export CSV</Button>
                <Button onClick={exportPdf} disabled={results.length === 0}>Export PDF</Button>
                {currentEstimatePortfolioMatch ? (
                  <Button onClick={() => setStep("portfolio")}>View portfolio</Button>
                ) : (
                  <Button onClick={addCurrentEstimateToPortfolio} disabled={results.length === 0}>Add to portfolio</Button>
                )}
                <Button onClick={exportEstimateJson} disabled={results.length === 0}>Save JSON</Button>
                <label className="file-button">
                  Load JSON
                  <input type="file" accept="application/json,.json" onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) importEstimateFile(file);
                  }} />
                </label>
              </div>
            </div>
            <PricingTable rows={results} onInclude={includeAmbiguous} />
          </div>
        </section>
      )}

      {step === "portfolio" && (
        <section className="stack">
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Customer Engagement Workspace</h2>
                <p className="muted">Organize portfolio assessments by customer, opportunity, owner, and engagement status.</p>
              </div>
              <div className="button-row">
                <Button onClick={exportPortfolioCsv} disabled={portfolioSummary.activeAccounts === 0}>Export CSV</Button>
                <Button onClick={exportPortfolioPdf} disabled={portfolioSummary.activeAccounts === 0}>Export PDF</Button>
                <Button onClick={exportPortfolioJson}>Export JSON</Button>
                <Button onClick={clearPortfolioAssessments} disabled={portfolioAssessments.length === 0}>Clear portfolio</Button>
                <Button onClick={clearCustomerWorkspace} disabled={!hasCustomerWorkspaceData}>Clear workspace</Button>
                <label className="file-button">
                  Import JSON
                  <input type="file" accept="application/json,.json" onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) importEstimateFile(file);
                  }} />
                </label>
              </div>
            </div>
            <div className="privacy-note">
              Customer workspace data is stored in this browser only and persists after refresh. It is not uploaded to an app database. Exported JSON can contain customer-identifying data; use Clear portfolio or Clear workspace when you are done.
            </div>
            <div className="form-grid">
              <Field label="Customer name"><Input value={customerProfile.customerName} onChange={(_, data) => updateCustomerProfile("customerName", data.value)} /></Field>
              <Field label="Industry"><Input value={customerProfile.industry} onChange={(_, data) => updateCustomerProfile("industry", data.value)} /></Field>
              <Field label="Opportunity ID"><Input value={customerProfile.opportunityId} onChange={(_, data) => updateCustomerProfile("opportunityId", data.value)} /></Field>
              <Field label="Assessment owner"><Input value={customerProfile.assessmentOwner} onChange={(_, data) => updateCustomerProfile("assessmentOwner", data.value)} /></Field>
              <Field label="Engagement status">
                <Select value={customerProfile.engagementStatus} onChange={(event) => updateCustomerProfile("engagementStatus", event.target.value)}>
                  <option>Planning</option>
                  <option>In review</option>
                  <option>Customer ready</option>
                  <option>Archived</option>
                </Select>
              </Field>
              <Field label="Account team notes">
                <Textarea value={customerProfile.accountTeamNotes} onChange={(_, data) => updateCustomerProfile("accountTeamNotes", data.value)} resize="vertical" />
              </Field>
            </div>
          </div>

          <div className="summary-grid">
            <Metric title="Storage accounts assessed" value={String(portfolioSummary.activeAccounts)} detail={`${portfolioSummary.archivedAssessments.length} archived`} />
            <Metric title="Total capacity" value={`${portfolioSummary.totalCapacityGb.toLocaleString()} GB`} detail="Active assessments only" />
            <Metric title="Portfolio GPv1 monthly" value={money(portfolioSummary.gpV1MonthlyCost, currency)} detail="Discount-adjusted" />
            <Metric title="Portfolio GPv2 monthly" value={money(portfolioSummary.gpV2MonthlyCost, currency)} detail="Discount-adjusted" />
            <Metric title="Annual impact" value={money(portfolioSummary.annualImpact, currency)} detail={`Monthly delta ${money(portfolioSummary.monthlyDelta, currency)}`} tone={portfolioSummary.annualImpact > 0 ? "bad" : "good"} />
          </div>

          {portfolioSummary.activeAccounts === 0 && (
            <div className="next-step-panel">
              <div>
                <p className="chart-kicker">Portfolio is empty</p>
                <h2>Add an assessment to start portfolio analysis</h2>
                <p className="chart-subtitle">Calculate an estimate, then save it here to unlock dashboard totals, migration priorities, risk scoring, comparisons, and executive exports.</p>
                {results.length > 0 && (
                  <div className="next-step-form">
                    <Field label="Estimate name">
                      <Input value={portfolioEstimateName} placeholder={suggestedPortfolioEstimateName} onChange={(_, data) => setPortfolioEstimateName(data.value)} />
                    </Field>
                    {accountSplitNote}
                  </div>
                )}
              </div>
              <div className="button-row">
                <Button appearance="primary" onClick={addCurrentEstimateToPortfolio} disabled={results.length === 0}>Add current estimate</Button>
                <Button onClick={() => setStep("input")}>Create estimate</Button>
              </div>
            </div>
          )}

          <div className="portfolio-grid">
            <div className="panel chart-panel">
              <div className="chart-header">
                <div>
                  <p className="chart-kicker">Portfolio dashboard</p>
                  <h2>Cost Distribution</h2>
                  <p className="chart-subtitle">Top accounts by current or estimated monthly cost.</p>
                </div>
              </div>
              {portfolioCostRows.length > 0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={portfolioCostRows} layout="vertical" margin={{ top: 12, right: 24, bottom: 8, left: 8 }}>
                    <CartesianGrid horizontal={false} stroke="#e5e7eb" />
                    <XAxis axisLine={false} tickLine={false} tickFormatter={(value) => compactMoney(Number(value), currency)} type="number" />
                    <YAxis axisLine={false} dataKey="name" tickLine={false} type="category" width={180} />
                    <Tooltip formatter={(value, name) => [money(Number(value), currency), name]} labelFormatter={(label) => portfolioCostRows.find((row) => row.name === label)?.fullName || label} />
                    <Bar dataKey="gpV1" fill="#2563eb" name="Current GPv1" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="gpV2" fill="#15803d" name="Estimated GPv2" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="chart-empty">Add completed estimates to the portfolio to see portfolio-level cost distribution.</div>
              )}
            </div>
            <div className="panel">
              <h2>Portfolio Signals</h2>
              <div className="signal-grid">
                <Signal title="High priority" value={portfolioSummary.highPriorityCount} />
                <Signal title="High risk" value={portfolioSummary.highRiskCount} />
                <Signal title="Avg confidence" value={`${portfolioSummary.averageConfidence}%`} />
                <Signal title="Medium/High complexity" value={portfolioSummary.complexityDistribution.Medium + portfolioSummary.complexityDistribution.High} />
              </div>
              <Distribution title="Priority" values={portfolioSummary.priorityDistribution} />
              <Distribution title="Risk" values={portfolioSummary.riskDistribution} />
              <Distribution title="Complexity" values={portfolioSummary.complexityDistribution} />
              <Distribution title="Confidence" values={portfolioSummary.confidenceDistribution} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Migration Priorities and Risk</h2>
                <p className="muted">Every active assessment receives priority, complexity, confidence, recommendations, and risk indicators.</p>
              </div>
              <div className="portfolio-add-inline">
                <Field label="Estimate name">
                  <Input value={portfolioEstimateName} placeholder={suggestedPortfolioEstimateName} onChange={(_, data) => setPortfolioEstimateName(data.value)} disabled={results.length === 0} />
                </Field>
                <Button onClick={addCurrentEstimateToPortfolio} disabled={results.length === 0}>Add current estimate</Button>
              </div>
            </div>
            <PortfolioTable
              rows={portfolioSummary.assessments}
              selectedIds={selectedPortfolioIds}
              onSelect={togglePortfolioSelection}
              onLoad={loadPortfolioAssessment}
              onClone={clonePortfolioAssessment}
              onRename={renamePortfolioAssessment}
              onArchive={archivePortfolioAssessment}
              onRemove={removePortfolioAssessment}
            />
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <h2>Estimate Comparison</h2>
                <p className="muted">Select assessments in the repository to compare capacity, cost, redundancy, tier, complexity, and recommendations.</p>
              </div>
            </div>
            {selectedPortfolioAssessments.length > 0 ? (
              <ComparisonTable rows={selectedPortfolioAssessments} />
            ) : (
              <div className="chart-empty">Select two or more portfolio assessments to compare scenarios side-by-side.</div>
            )}
          </div>
        </section>
      )}

      {step === "methodology" && (
        <section className="panel readable">
          <h2>Assumptions and Methodology</h2>
          <p>{pricingDisclaimer}</p>
          <p>This estimator uses public Azure list pricing from the Azure Retail Prices API. It does not require Azure sign-in and does not use customer-specific billing APIs.</p>
          <p>Only Blob Storage usage is modeled in v1. GPv1 means Azure account kind Storage; GPv2 means account kind StorageV2. GPv1 accounts have no access tier concept, so current usage is matched against General Block Blob meters. The GPv2 conversion target is Hot or Cool; colder tiers are optimization scenarios rather than direct conversion targets in this release.</p>
          <p>Rows with exact or strong public meter matches are included by default. Rows marked needs review or unmatched are excluded from final totals unless explicitly included during pricing review.</p>
          <p>Portfolio scoring is derived from saved assessment results. Priority considers annual impact, capacity, confidence, risk, and complexity. Risk considers large capacity, cost increases, low confidence, unmatched rows, review rows, unsupported rows, retrieval signals, and replication dependence.</p>
          <p>The assessment repository is browser-local in v1.3. Portfolio JSON export/import is the portable record; no Azure sign-in, database, or subscription discovery is used.</p>
          <p>Discount-adjusted prices use: discountedUnitPrice = listUnitPrice * (1 - discountPercent / 100). Taxes, credits, reservations, support plans, marketplace charges, and negotiated pricing are outside scope.</p>
        </section>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <Label>{label}</Label>
      {children}
    </label>
  );
}

function Metric({ title, value, detail, tone }: { title: string; value: string; detail?: string; tone?: "good" | "bad" }) {
  return (
    <div className={`metric ${tone || ""}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Signal({ title, value }: { title: string; value: string | number }) {
  return (
    <div className="signal">
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Distribution<T extends string>({ title, values }: { title: string; values: Record<T, number> }) {
  return (
    <div className="distribution">
      <strong>{title}</strong>
      <div>
        {Object.entries(values).map(([key, value]) => (
          <span key={key}>{key}: {String(value)}</span>
        ))}
      </div>
    </div>
  );
}

function PortfolioTable({
  rows,
  selectedIds,
  onSelect,
  onLoad,
  onClone,
  onRename,
  onArchive,
  onRemove
}: {
  rows: PortfolioAssessmentSummary[];
  selectedIds: string[];
  onSelect: (id: string, selected: boolean) => void;
  onLoad: (assessment: PortfolioAssessmentSummary) => void;
  onClone: (assessment: PortfolioAssessmentSummary) => void;
  onRename: (assessment: PortfolioAssessmentSummary) => void;
  onArchive: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Compare</th>
            <th>Assessment</th>
            <th>Account</th>
            <th>Status</th>
            <th>Capacity</th>
            <th>GPv1</th>
            <th>GPv2</th>
            <th>Annual impact</th>
            <th>Priority</th>
            <th>Risk</th>
            <th>Complexity</th>
            <th>Confidence</th>
            <th>Recommendations</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><Checkbox checked={selectedIds.includes(row.id)} onChange={(_, data) => onSelect(row.id, Boolean(data.checked))} /></td>
              <td>
                <strong>{row.name}</strong>
                <small className="meter-detail">{row.region} · {row.redundancy || "n/a"} · {row.accessTier || "n/a"}</small>
              </td>
              <td>{row.storageAccountName}</td>
              <td><span className={`badge ${row.status === "Archived" ? "warn" : "ok"}`}>{row.status}</span></td>
              <td>{row.capacityGb.toLocaleString()} GB</td>
              <td>{money(row.gpV1MonthlyCost, row.currency)}</td>
              <td>{money(row.gpV2MonthlyCost, row.currency)}</td>
              <td>{money(row.annualImpact, row.currency)}</td>
              <td><span className={`badge ${row.priority === "High" ? "bad" : row.priority === "Medium" ? "warn" : "ok"}`}>{row.priority} · {Math.round(row.priorityScore)}</span></td>
              <td><span className={`badge ${row.risk === "High" ? "bad" : row.risk === "Medium" ? "warn" : "ok"}`}>{row.risk} · {Math.round(row.riskScore)}</span></td>
              <td>{row.complexity} · {Math.round(row.complexityScore)}</td>
              <td>{row.confidenceScore}%</td>
              <td>{row.recommendations.join("; ")}</td>
              <td>
                <div className="button-row compact">
                  <Button size="small" onClick={() => onLoad(row)}>Load</Button>
                  <Button size="small" onClick={() => onClone(row)}>Clone</Button>
                  <Button size="small" onClick={() => onRename(row)}>Rename</Button>
                  <Button size="small" onClick={() => onArchive(row.id)}>{row.status === "Archived" ? "Restore" : "Archive"}</Button>
                  <Button size="small" onClick={() => onRemove(row.id)}>Remove</Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonTable({ rows }: { rows: PortfolioAssessmentSummary[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Assessment</th>
            <th>Capacity</th>
            <th>GPv1 monthly</th>
            <th>GPv2 monthly</th>
            <th>Monthly delta</th>
            <th>Annual impact</th>
            <th>Redundancy</th>
            <th>Tier</th>
            <th>Complexity</th>
            <th>Risk</th>
            <th>Priority</th>
            <th>Recommendations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><strong>{row.name}</strong></td>
              <td>{row.capacityGb.toLocaleString()} GB</td>
              <td>{money(row.gpV1MonthlyCost, row.currency)}</td>
              <td>{money(row.gpV2MonthlyCost, row.currency)}</td>
              <td>{money(row.monthlyDelta, row.currency)}</td>
              <td>{money(row.annualImpact, row.currency)}</td>
              <td>{row.redundancy || "n/a"}</td>
              <td>{row.accessTier || "n/a"}</td>
              <td>{row.complexity}</td>
              <td>{row.risk}</td>
              <td>{row.priority}</td>
              <td>{row.recommendations.join("; ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageTable({ rows, onToggle }: { rows: UsageLineItem[]; onToggle: (id: string, included: boolean) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Include</th>
            <th>Service</th>
            <th>Product</th>
            <th>Meter</th>
            <th>Region</th>
            <th>Quantity</th>
            <th>Unit</th>
            <th>Classification</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const classification = classifyUsage(row);
            return (
              <tr key={row.id}>
                <td><Checkbox checked={row.included} disabled={!row.modeled} onChange={(_, data) => onToggle(row.id, Boolean(data.checked))} /></td>
                <td>{row.serviceName}</td>
                <td>{row.product}</td>
                <td>{row.meterName}</td>
                <td>{row.region}</td>
                <td>{row.quantity.toLocaleString()}</td>
                <td>{row.unit}</td>
                <td>
                  <span className={`badge ${classification.status === "Included" ? "ok" : classification.status === "Requires Review" ? "warn" : "bad"}`}>{classification.status}</span>
                  <small className="meter-detail">{classification.category}: {classification.reason}</small>
                </td>
                <td><span className={`badge ${row.modeled ? "ok" : "warn"}`}>{row.modeled ? "Modeled" : "Not modeled"}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PricingTable({ rows, onInclude }: { rows: ResultLineItem[]; onInclude: (id: string, included: boolean) => void }) {
  const meterDetails = (meter: PriceMeter | undefined) =>
    meter ? `${meter.productName} / ${meter.skuName} / ${meter.armRegionName} / ${meter.unitOfMeasure}` : "No matched public meter";

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Totals</th>
            <th>Usage category</th>
            <th>Quantity</th>
            <th>GPv1 meter</th>
            <th>GPv1 list price</th>
            <th>GPv1 discounted price</th>
            <th>GPv2 meter</th>
            <th>GPv2 list price</th>
            <th>GPv2 discounted price</th>
            <th>GPv1 list cost</th>
            <th>GPv1 discounted cost</th>
            <th>GPv2 list cost</th>
            <th>GPv2 discounted cost</th>
            <th>Delta</th>
            <th>Confidence</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.usage.id}>
              <td><Checkbox checked={row.includeInTotals} onChange={(_, data) => onInclude(row.usage.id, Boolean(data.checked))} /></td>
              <td>{row.usage.meterName}</td>
              <td>{row.quantity.toLocaleString()} {row.usage.unit}</td>
              <td>
                <strong>{row.gpV1.meter?.meterName || "Unmatched"}</strong>
                <small className="meter-detail">{meterDetails(row.gpV1.meter)}</small>
              </td>
              <td>{row.gpV1ListUnitPrice.toFixed(6)}</td>
              <td>{row.gpV1DiscountedUnitPrice.toFixed(6)}</td>
              <td>
                <strong>{row.gpV2.meter?.meterName || "Unmatched"}</strong>
                <small className="meter-detail">{meterDetails(row.gpV2.meter)}</small>
              </td>
              <td>{row.gpV2ListUnitPrice.toFixed(6)}</td>
              <td>{row.gpV2DiscountedUnitPrice.toFixed(6)}</td>
              <td>{money(row.gpV1ListCost, row.usage.currency)}</td>
              <td>{money(row.gpV1DiscountedCost, row.usage.currency)}</td>
              <td>{money(row.gpV2ListCost, row.usage.currency)}</td>
              <td>{money(row.gpV2DiscountedCost, row.usage.currency)}</td>
              <td>{money(row.delta, row.usage.currency)}</td>
              <td><span className={`badge ${confidenceClass(row.confidence)}`}>{row.confidence} · {confidenceScore(row)}</span></td>
              <td>{row.notes.join("; ") || "No assumptions"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
