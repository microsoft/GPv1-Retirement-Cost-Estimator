import type { AccessTier, Confidence, MeterMatch, PriceMeter, Redundancy, UsageLineItem } from "./types";

const blobHints = ["blob", "block blob", "page blob", "data stored", "hot", "cool", "cold", "archive", "replication", "data replicated"];
const excludedHints = ["file", "disk", "queue", "table", "managed disk", "premium files"];
const excludedProductHints = ["hierarchical namespace", "data lake", "premium", "file", "queue", "table", "page blob", "backup"];
function normalize(value: string | undefined): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isBlobStorageLine(item: Pick<UsageLineItem, "serviceName" | "product" | "meterCategory" | "meterSubcategory" | "meterName" | "skuName">): boolean {
  const haystack = normalize(`${item.serviceName} ${item.product} ${item.meterCategory} ${item.meterSubcategory || ""} ${item.meterName} ${item.skuName}`);
  if (excludedHints.some((hint) => haystack.includes(hint))) {
    return false;
  }
  return blobHints.some((hint) => haystack.includes(hint));
}

export function inferRedundancy(value: string): Redundancy | undefined {
  const upper = value.toUpperCase();
  const redundancies: Redundancy[] = ["RA-GZRS", "RA-GRS", "GZRS", "ZRS", "GRS", "LRS"];
  return redundancies.find((redundancy) => upper.includes(redundancy));
}

export function inferAccessTier(value: string): AccessTier | undefined {
  const lowered = value.toLowerCase();
  if (lowered.includes("archive")) return "Archive";
  if (lowered.includes("cold")) return "Cold";
  if (lowered.includes("cool")) return "Cool";
  if (lowered.includes("hot")) return "Hot";
  return undefined;
}

export function isStorageV2OnlyUsage(item: Pick<UsageLineItem, "meterName" | "product" | "skuName" | "meterSubcategory">): boolean {
  const text = normalize(`${item.product} ${item.meterSubcategory || ""} ${item.skuName} ${item.meterName}`);
  return [
    "replication",
    "data replicated",
    "early delete",
    "index tags",
    "blob inventory",
    "named encryption scopes",
    "point in time restore",
    "smart tier",
    "ssh file transfer protocol",
    "sftp"
  ].some((hint) => text.includes(hint));
}

function candidateTier(meter: PriceMeter): AccessTier | undefined {
  return inferAccessTier(`${meter.skuName} ${meter.meterName}`);
}

function usageIsTierSpecific(item: UsageLineItem): boolean {
  const text = normalize(item.meterName);
  return [
    "data stored",
    "write operations",
    "read operations",
    "data retrieval",
    "data write",
    "early delete",
    "index tags",
    "blob inventory"
  ].some((hint) => text.includes(hint));
}

function scoreCandidate(item: UsageLineItem, meter: PriceMeter, target: "gpv1" | "gpv2"): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;
  const candidateText = normalize(`${meter.productName} ${meter.skuName} ${meter.meterName} ${meter.unitOfMeasure}`);
  const sourceText = normalize(`${item.product} ${item.skuName} ${item.meterName} ${item.unit}`);
  const productName = normalize(meter.productName);

  const storageV2Only = isStorageV2OnlyUsage(item);

  if (excludedProductHints.some((hint) => productName.includes(hint))) {
    return { score: -1000, notes: [`Excluded ${meter.productName}; not a standard block blob meter for this model.`] };
  }

  if (target === "gpv1") {
    if (storageV2Only) {
      return { score: -1000, notes: ["No GPv1 meter expected; this is modeled as a StorageV2-only meter."] };
    }
    if (productName === "general block blob") score += 60;
    else return { score: -1000, notes: [`Expected GPv1 product General Block Blob, received ${meter.productName}.`] };
  }

  if (target === "gpv2") {
    const selectedTier = item.accessTier;
    const tier = candidateTier(meter);
    if (selectedTier && usageIsTierSpecific(item) && tier && tier !== selectedTier) {
      return { score: -1000, notes: [`Excluded ${meter.meterName}; selected StorageV2 tier is ${selectedTier}.`] };
    }

    if (storageV2Only && productName === "blob features") score += 75;
    else if (productName === "general block blob v2") score += 60;
    else if (productName === "blob storage") score += 45;
    else return { score: -1000, notes: [`Expected GPv2 block blob product, received ${meter.productName}.`] };
  }

  if (normalize(meter.armRegionName) === normalize(item.region)) score += 25;
  else notes.push("Region differs from usage row.");

  if (normalize(meter.currencyCode) === normalize(item.currency)) score += 15;
  else notes.push("Currency differs from usage row.");

  if (normalize(meter.unitOfMeasure) === normalize(item.unit)) score += 15;
  else if (normalize(meter.unitOfMeasure).includes(normalize(item.unit)) || normalize(item.unit).includes(normalize(meter.unitOfMeasure))) score += 8;
  else notes.push("Unit of measure needs review.");

  const redundancy = item.redundancy || inferRedundancy(sourceText);
  const redundancyText = target === "gpv1" ? `standard ${normalize(redundancy)}` : normalize(redundancy);
  if (redundancy && candidateText.includes(redundancyText)) score += 15;
  else if (redundancy && candidateText.includes(normalize(redundancy))) score += 10;
  else if (redundancy) notes.push(`Could not confirm ${redundancy} redundancy.`);

  const tier = target === "gpv1" ? "Hot" : item.accessTier || inferAccessTier(sourceText);
  if (target === "gpv1") {
    score += 10;
    notes.push("GPv1 is modeled from General Block Blob meters; GPv1 accounts do not expose access tiers.");
  } else if (tier && candidateText.includes(normalize(tier))) {
    score += 10;
  }

  if (sourceText && candidateText.includes(normalize(item.meterName))) score += 15;
  else if (storageV2Only) {
    const sourceTokens = sourceText.split(" ").filter((token) => token.length > 3);
    const matchedTokens = sourceTokens.filter((token) => candidateText.includes(token)).length;
    score += Math.min(20, matchedTokens * 4);
  }
  if (candidateText.includes("blob")) score += 10;

  return { score, notes };
}

export function classifyConfidence(score: number, candidateCount: number): Confidence {
  if (score >= 95 && candidateCount === 1) return "Exact match";
  if (score >= 75) return "Strong match";
  if (score >= 45) return "Needs review";
  return "Unmatched";
}

export function matchMeter(item: UsageLineItem, candidates: PriceMeter[], target: "gpv1" | "gpv2"): MeterMatch {
  if (!item.modeled || !item.included || candidates.length === 0) {
    return { confidence: "Unmatched", score: 0, candidates: [], notes: ["No candidate public price meters were available."] };
  }

  // The usage export's MeterId is the GUID of the meter that was actually billed,
  // i.e. the current/GPv1 meter. When it is present and the public price list
  // returns that exact meter, pin the GPv1 price to it directly instead of relying
  // on fuzzy text scoring. (The GPv2 target is a modeled conversion to a different
  // StorageV2 meter that never appears in the export, so it keeps using inference.)
  if (target === "gpv1" && item.meterId) {
    const wantedMeterId = item.meterId.trim().toLowerCase();
    const exactTiers = candidates.filter((candidate) => candidate.meterId.trim().toLowerCase() === wantedMeterId);
    if (exactTiers.length > 0) {
      const primary = [...exactTiers].sort((a, b) => a.tierMinimumUnits - b.tierMinimumUnits)[0];
      return {
        confidence: "Exact match",
        score: 100,
        meter: primary,
        candidates: exactTiers,
        notes: [`Matched the billed meter by ID ${primary.meterId} from the usage export.`]
      };
    }
  }

  const scored = candidates
    .map((candidate) => ({ candidate, ...scoreCandidate(item, candidate, target) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    if (target === "gpv2" && item.accessTier === "Hot" && ["data retrieval", "data write", "early delete"].some((hint) => normalize(item.meterName).includes(hint))) {
      return {
        confidence: "Strong match",
        score: 75,
        candidates: [],
        notes: [`No Hot-tier StorageV2 public meter found for ${item.meterName}; modeled as $0 instead of borrowing a Cool/Cold/Archive meter.`]
      };
    }

    return { confidence: "Unmatched", score: 0, candidates: [], notes: [`No ${target === "gpv1" ? "GPv1 General Block Blob" : "GPv2 Block Blob"} public price meter matched.`] };
  }

  const best = scored[0];
  const sameMeterTiers = scored.filter((entry) => entry.candidate.meterId === best.candidate.meterId).map((entry) => entry.candidate);
  const closeCandidates = scored.filter((entry) => best.score - entry.score <= 10).map((entry) => entry.candidate);
  const distinctMeterIds = new Set(closeCandidates.map((candidate) => candidate.meterId));
  const confidence = classifyConfidence(best.score, distinctMeterIds.size);
  const ambiguityNote = distinctMeterIds.size > 1 ? ["Multiple plausible meters require review."] : [];

  return {
    confidence,
    score: best.score,
    meter: confidence === "Unmatched" ? undefined : best.candidate,
    candidates: sameMeterTiers.length > 0 ? sameMeterTiers : closeCandidates,
    notes: [...best.notes, ...ambiguityNote]
  };
}
