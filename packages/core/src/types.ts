export type CurrencyCode = "USD" | "EUR" | "GBP" | "CAD" | "AUD" | string;

export type Redundancy = "LRS" | "ZRS" | "GRS" | "RA-GRS" | "GZRS" | "RA-GZRS";

export type AccessTier = "Hot" | "Cool" | "Cold" | "Archive";

export type Confidence = "Exact match" | "Strong match" | "Needs review" | "Unmatched";

export type UsageSource = "manual" | "csv";
export type StorageAccountKind = "Storage" | "StorageV2";

export interface UsageLineItem {
  id: string;
  source: UsageSource;
  billingPeriod?: string;
  serviceName: string;
  product: string;
  meterCategory: string;
  meterSubcategory?: string;
  meterName: string;
  skuName: string;
  meterId?: string;
  region: string;
  quantity: number;
  unit: string;
  unitPrice?: number;
  cost?: number;
  currency: CurrencyCode;
  storageAccountName?: string;
  sourceAccountKind?: StorageAccountKind;
  targetAccountKind?: StorageAccountKind;
  redundancy?: Redundancy;
  accessTier?: AccessTier;
  included: boolean;
  modeled: boolean;
  notes: string[];
}

export interface ManualUsageInput {
  region: string;
  currency: CurrencyCode;
  redundancy: Redundancy;
  accessTier: AccessTier;
  capacityGb: number;
  writeOperations: number;
  readOperations: number;
  listContainerOperations: number;
  retrievalGb: number;
  writeGb: number;
  geoReplicationGb: number;
  allOtherOperations: number;
  deleteOperations: number;
  deletedDataGb: number;
  averageDaysRetainedBeforeDelete: number;
  dataGeoPriorityReplicationGb: number;
}

export interface PriceMeter {
  currencyCode: string;
  tierMinimumUnits: number;
  retailPrice: number;
  unitPrice: number;
  armRegionName: string;
  location?: string;
  effectiveStartDate?: string;
  meterId: string;
  meterName: string;
  productId?: string;
  skuId?: string;
  productName: string;
  skuName: string;
  serviceName: string;
  serviceFamily?: string;
  unitOfMeasure: string;
  type?: string;
  isPrimaryMeterRegion?: boolean;
  armSkuName?: string;
}

export interface PricingSearchRequest {
  region: string;
  currency: CurrencyCode;
  product?: string;
  skuName?: string;
  meterName?: string;
  meterId?: string;
  unit?: string;
  redundancy?: Redundancy;
  accessTier?: AccessTier;
  priceType?: "Consumption";
}

export interface PricingSearchResponse {
  requestedAt: string;
  refreshedAt: string;
  cacheHit: boolean;
  candidates: PriceMeter[];
}

export interface MeterMatch {
  confidence: Confidence;
  score: number;
  meter?: PriceMeter;
  candidates: PriceMeter[];
  notes: string[];
}

export interface ResultLineItem {
  usage: UsageLineItem;
  gpV1: MeterMatch;
  gpV2: MeterMatch;
  includeInTotals: boolean;
  quantity: number;
  gpV1ListUnitPrice: number;
  gpV1DiscountedUnitPrice: number;
  gpV2ListUnitPrice: number;
  gpV2DiscountedUnitPrice: number;
  gpV1ListCost: number;
  gpV2ListCost: number;
  gpV1DiscountedCost: number;
  gpV2DiscountedCost: number;
  delta: number;
  confidence: Confidence;
  notes: string[];
}

export interface DiscountSettings {
  globalDiscountPercent: number;
  gpV1DiscountPercent: number;
  gpV2DiscountPercent: number;
  sameDiscountForBoth: boolean;
}

export interface CostSummary {
  gpV1ListTotal: number;
  gpV2ListTotal: number;
  listDelta: number;
  listDeltaPercent: number;
  gpV1DiscountedTotal: number;
  gpV2DiscountedTotal: number;
  discountedDelta: number;
  discountedDeltaPercent: number;
  annualizedDelta: number;
}

export type UsageClassificationStatus = "Included" | "Excluded" | "Requires Review";

export type UsageClassificationCategory =
  | "Blob Capacity"
  | "Read Operations"
  | "Write Operations"
  | "List Operations"
  | "Retrieval"
  | "Replication"
  | "Early Deletion"
  | "Unsupported"
  | "Other";

export interface UsageClassification {
  status: UsageClassificationStatus;
  category: UsageClassificationCategory;
  reason: string;
}

export type PortfolioPriority = "High" | "Medium" | "Low";
export type PortfolioRisk = "High" | "Medium" | "Low";
export type PortfolioStatus = "Active" | "Archived";

export interface CustomerProfile {
  customerName: string;
  industry: string;
  opportunityId: string;
  accountTeamNotes: string;
  engagementStatus: string;
  assessmentOwner: string;
}

export interface PortfolioAssessmentInput {
  id: string;
  name: string;
  storageAccountName: string;
  region: string;
  redundancy?: Redundancy;
  accessTier?: AccessTier;
  currency: CurrencyCode;
  capacityGb: number;
  results: ResultLineItem[];
  notes?: string[];
  createdAt: string;
  updatedAt: string;
  status: PortfolioStatus;
}

export interface PortfolioAssessmentSummary extends PortfolioAssessmentInput {
  gpV1MonthlyCost: number;
  gpV2MonthlyCost: number;
  monthlyDelta: number;
  annualImpact: number;
  confidenceScore: number;
  complexityScore: number;
  complexity: MigrationComplexity;
  priorityScore: number;
  priority: PortfolioPriority;
  riskScore: number;
  risk: PortfolioRisk;
  recommendations: string[];
  riskIndicators: string[];
}

export type MigrationComplexity = "Low" | "Medium" | "High";

export interface PortfolioSummary {
  assessments: PortfolioAssessmentSummary[];
  activeAssessments: PortfolioAssessmentSummary[];
  archivedAssessments: PortfolioAssessmentSummary[];
  totalAccounts: number;
  activeAccounts: number;
  totalCapacityGb: number;
  gpV1MonthlyCost: number;
  gpV2MonthlyCost: number;
  monthlyDelta: number;
  annualImpact: number;
  highPriorityCount: number;
  highRiskCount: number;
  averageConfidence: number;
  complexityDistribution: Record<MigrationComplexity, number>;
  confidenceDistribution: Record<"High" | "Medium" | "Low", number>;
  priorityDistribution: Record<PortfolioPriority, number>;
  riskDistribution: Record<PortfolioRisk, number>;
}
