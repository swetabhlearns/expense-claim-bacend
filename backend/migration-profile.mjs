function normalizeEmail(value) {
  return value?.trim().toLowerCase() || "";
}

function normalizeText(value) {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "";
}

function normalizeTax(value) {
  return value?.trim().toUpperCase().replace(/\s+/g, "") || "";
}

function deriveEmployeeBucket(claim) {
  if (claim.employeeBucket) return claim.employeeBucket;
  if (claim.status === "REJECTED") return "rejected";
  if (claim.status === "DISBURSED" || claim.status === "COMPLETED") return "accepted";
  if (claim.status === "RETURNED_TO_EMPLOYEE") return "action_required";
  return "pending";
}

function baseTransform(doc) {
  const legacyConvexId = doc.legacyConvexId || doc._id;
  return {
    ...doc,
    legacyConvexId,
  };
}

function transformUser(doc) {
  const normalized = baseTransform(doc);
  normalized.email = normalizeEmail(normalized.email);
  normalized.status = normalized.status || "active";
  if (!Array.isArray(normalized.verticals)) normalized.verticals = normalized.verticals ? [normalized.verticals] : [];
  return normalized;
}

function transformVendor(doc) {
  const normalized = baseTransform(doc);
  normalized.normalizedCode ||= normalizeText(normalized.code);
  normalized.normalizedName ||= normalizeText(normalized.name);
  normalized.normalizedOfficialEmail ||= normalizeEmail(normalized.officialEmail);
  normalized.normalizedGstNumber ||= normalizeTax(normalized.gstNumber);
  normalized.normalizedPanNumber ||= normalizeTax(normalized.panNumber);
  normalized.normalizedContactPersonName ||= normalizeText(normalized.contactPersonName);
  normalized.normalizedMobileNumber ||= normalizeText(normalized.mobileNumber);
  normalized.normalizedContactEmail ||= normalizeEmail(normalized.contactEmail);
  normalized.status = normalized.status || "active";
  return normalized;
}

function transformClaim(doc) {
  const normalized = baseTransform(doc);
  const requested = Number(normalized.totalRequestedAmount ?? normalized.amount ?? 0);
  const disbursed = Number(normalized.totalDisbursedAmount ?? 0);
  normalized.amount = Number(normalized.amount ?? requested);
  normalized.totalRequestedAmount = requested;
  normalized.totalDisbursedAmount = disbursed;
  normalized.pendingAmount = Number(normalized.pendingAmount ?? Math.max(0, requested - disbursed));
  normalized.currentCycleNumber = Number(normalized.currentCycleNumber ?? 1);
  normalized.employeeBucket = deriveEmployeeBucket(normalized);
  normalized.createdAt = normalized.createdAt || new Date(Number(normalized._creationTime || Date.now())).toISOString();
  normalized.logs = Array.isArray(normalized.logs) ? normalized.logs : [];
  normalized.proofDocuments = Array.isArray(normalized.proofDocuments) ? normalized.proofDocuments : [];
  return normalized;
}

function transformClaimCycle(doc) {
  const normalized = baseTransform(doc);
  normalized.cycleNumber = Number(normalized.cycleNumber ?? 1);
  normalized.openingPendingAmount = Number(normalized.openingPendingAmount ?? 0);
  normalized.requestedAmount = Number(normalized.requestedAmount ?? 0);
  normalized.status = normalized.status || "UNDER_REVIEW";
  return normalized;
}

function transformCounterDoc(doc) {
  return baseTransform(doc);
}

function transformAnalyticsDoc(doc) {
  return baseTransform(doc);
}

function transformAuditDoc(doc) {
  return baseTransform(doc);
}

function transformPushSubscription(doc) {
  return baseTransform(doc);
}

function transformVendorDocument(doc) {
  const normalized = baseTransform(doc);
  normalized.status = normalized.status || "CURRENT";
  return normalized;
}

function transformLedgerEntry(doc) {
  return baseTransform(doc);
}

export const migrationProfile = [
  { name: "users", transform: transformUser },
  { name: "vendors", transform: transformVendor },
  { name: "vendorDocuments", transform: transformVendorDocument },
  { name: "vendorLedgerEntries", transform: transformLedgerEntry },
  { name: "claims", transform: transformClaim },
  { name: "vendorSequenceCounters", transform: transformCounterDoc },
  { name: "claimCycles", transform: transformClaimCycle },
  { name: "roleAuditLog", transform: transformAuditDoc },
  { name: "claimDeleteAuditLog", transform: transformAuditDoc },
  { name: "adminDashboardCounters", transform: transformCounterDoc },
  { name: "employeeDashboardCounters", transform: transformCounterDoc },
  { name: "paymentDashboardCounters", transform: transformCounterDoc },
  { name: "analyticsDailySummaries", transform: transformAnalyticsDoc },
  { name: "analyticsUserDailySummaries", transform: transformAnalyticsDoc },
  { name: "analyticsAdminDailySummaries", transform: transformAnalyticsDoc },
  { name: "pushSubscriptions", transform: transformPushSubscription },
  { name: "l3KnowledgeDocuments", transform: transformAnalyticsDoc, optional: true },
  { name: "l3KnowledgeIndexState", transform: transformAnalyticsDoc, optional: true },
];

