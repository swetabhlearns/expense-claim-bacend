import { ObjectId } from "mongodb";
import { assertCanAccessClaim, assertRoleManager, assertVendorManager, canViewAdmin, canViewAnalytics, canViewFinance, canViewVendorLedger, findUserByEmailPreferActive, getCurrentUser, requireCurrentUser } from "./auth.mjs";
import { callConvexStorageFunction, resolveConvexAttachmentUrl } from "./convexStorageBridge.mjs";
import * as dashboardEngine from "./dashboardEngine.mjs";
import { badRequest, forbidden, notFound } from "./errors.mjs";

const DEMO_USERS = [
  { name: "Rahul Sharma", email: "rahul.sharma@company.com", role: "USER" },
  { name: "Priya Patel", email: "priya.patel@company.com", role: "L1_ADMIN", verticals: ["M/S Birendra Kumar Tripathi"] },
  { name: "Amit Kumar", email: "amit.kumar@company.com", role: "L2_ADMIN", verticals: ["M/S Birendra Kumar Tripathi"] },
  { name: "Sneha Reddy", email: "sneha.reddy@company.com", role: "L3_ADMIN" },
  { name: "Vikram Singh", email: "vikram.singh@company.com", role: "L4_ADMIN" },
  { name: "Demo Role Manager", email: "role.manager@demo.company.com", role: "ROLE_MANAGER" },
  { name: "Monitoring Demo", email: "monitoring.demo@company.com", role: "MONITOR" },
];

const COMPANY_VERTICALS = [
  "M/S Birendra Kumar Tripathi",
  "BKT Minetech Solutions",
  "BKT Tactical Solutions",
  "BKT Infratech",
  "Samridhi Informatics",
  "Others (JV / Partnerships)",
];

const DEMO_CEO_EMAIL = "adamant.kiwi.ceo@company.com";
const DEMO_CEO_NAME = "Adamant Kiwi";

const terminalAcceptedStatuses = new Set(["DISBURSED", "COMPLETED"]);
const rejectedStatuses = new Set(["REJECTED"]);

function pageArgs(args) {
  const page = Math.max(1, Number(args.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(args.pageSize || 10)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function sortByDateDesc(a, b) {
  return String(b.date || b.createdAt || b._creationTime || "").localeCompare(String(a.date || a.createdAt || a._creationTime || ""));
}

function matchesSearch(doc, rawSearch) {
  const search = rawSearch?.trim().toLowerCase();
  if (!search) return true;
  return [
    doc._id,
    doc.userName,
    doc.projectTitle,
    doc.title,
    doc.purpose,
    doc.vendorCode,
    doc.vendorName,
    doc.vendorOfficialEmail,
    doc.vendorContactPersonName,
    doc.vendorContactEmail,
    doc.companyVertical,
    doc.status,
    doc.paymentMode,
    doc.code,
    doc.name,
    doc.email,
    doc.officialEmail,
    doc.gstNumber,
    doc.panNumber,
    doc.mobileNumber,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(search));
}

function employeeBucketForClaim(claim) {
  if (rejectedStatuses.has(claim.status)) return "rejected";
  if (claim.status === "RETURNED_TO_EMPLOYEE") return "action_required";
  if (claim.status === "DISBURSED" && !claim.employeeReceivedAt) return "action_required";
  if (claim.status === "DISBURSED" && claim.employeeReceivedAt && !claim.proofSubmittedAt) return "action_required";
  if (claim.status === "PARTIALLY_DISBURSED" && Math.max(0, Number(claim.pendingAmount ?? claim.amount ?? 0)) > 0) return "action_required";
  if (terminalAcceptedStatuses.has(claim.status)) return "accepted";
  if (claim.employeeBucket) return claim.employeeBucket;
  return "pending";
}

function isEmployeeActionRequiredClaim(claim) {
  if (claim.status === "DISBURSED" && !claim.employeeReceivedAt) return true;
  if (claim.status === "DISBURSED" && claim.employeeReceivedAt && !claim.proofSubmittedAt) return true;
  if (claim.status === "PARTIALLY_DISBURSED" && Math.max(0, Number(claim.pendingAmount ?? claim.amount ?? 0)) > 0) return true;
  return false;
}

function isEmployeeAcceptedClaim(claim) {
  if (claim.status === "COMPLETED") return true;
  if (claim.status === "DISBURSED" && claim.employeeReceivedAt && claim.proofSubmittedAt) return true;
  return false;
}

function deriveEmployeeBucket(claim) {
  if (rejectedStatuses.has(claim.status)) return "rejected";
  if (isEmployeeActionRequiredClaim(claim)) return "action_required";
  if (isEmployeeAcceptedClaim(claim)) return "accepted";
  return "pending";
}

function isFinanceActionRequiredClaim(claim) {
  return claim.status === "DISBURSED" && Boolean(claim.proofSubmittedAt) && !claim.isClosedByL4;
}

function isHistoricalImportClaim(claim) {
  return dashboardEngine.isHistoricalImportClaim(claim);
}

function matchesFinanceSearch(claim, rawSearch) {
  return dashboardEngine.matchesFinanceSearch(claim, rawSearch);
}

function matchesFinanceStatusFilter(claim, statusFilter) {
  return dashboardEngine.matchesFinanceStatusFilter(claim, statusFilter);
}

function matchesPaymentsFilter(claim, startDate, endDate) {
  return dashboardEngine.matchesPaymentsFilter(claim, startDate, endDate);
}

function matchesFinanceDashboardFilters(claim, filters = {}) {
  return dashboardEngine.matchesFinanceDashboardFilters(claim, filters);
}

function filterFinanceDashboardClaims(claims, filters = {}) {
  return dashboardEngine.filterFinanceDashboardClaims(claims, filters);
}

function getFinanceCandidateClaims(claims) {
  return dashboardEngine.getFinanceCandidateClaims(claims);
}

function buildPaymentModeTotals(claims) {
  return dashboardEngine.buildPaymentModeTotals(claims);
}

function summarizeFinanceDashboardClaims(claims) {
  return dashboardEngine.summarizeFinanceDashboardClaims(claims);
}

function getDefaultAnalyticsStartDate() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().split("T")[0];
}

async function loadAnalyticsClaimsByDateRange(ctx, startDate, endDate, opts = {}) {
  const effectiveStartDate = startDate ?? (opts.defaultRecent === false ? "0000-01-01" : getDefaultAnalyticsStartDate());
  const effectiveEndDate = endDate ?? "9999-12-31";
  const normalizedStartDate = effectiveStartDate > effectiveEndDate ? effectiveEndDate : effectiveStartDate;
  const normalizedEndDate = effectiveStartDate > effectiveEndDate ? effectiveStartDate : effectiveEndDate;
  return await ctx.db.collection("claims").find({
    date: {
      $gte: normalizedStartDate,
      $lte: normalizedEndDate,
    },
  }).sort({ date: 1, createdAt: 1, _creationTime: 1 }).toArray();
}

function getAnalyticsTimeSeriesKey(dateString, granularity) {
  const date = new Date(dateString);
  if (!Number.isFinite(date.getTime())) return dateString;
  if (granularity === "week") {
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    return weekStart.toISOString().split("T")[0];
  }
  if (granularity === "month") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }
  return dateString;
}

function summarizeClaimsOverview(claims) {
  const byStatus = {};
  let totalAmount = 0;
  for (const claim of claims) {
    const amount = Number(claim.amount ?? claim.totalRequestedAmount ?? 0);
    totalAmount += amount;
    if (!byStatus[claim.status]) {
      byStatus[claim.status] = { count: 0, amount: 0 };
    }
    byStatus[claim.status].count += 1;
    byStatus[claim.status].amount += amount;
  }
  return {
    totalClaims: claims.length,
    totalAmount,
    averageAmount: claims.length > 0 ? totalAmount / claims.length : 0,
    byStatus,
    claims: claims.length,
  };
}

function getAdminRoleStageLabel(role) {
  const labels = {
    L1_ADMIN: "L1 - Admin",
    L2_ADMIN: "L2 - General Manager",
    L3_ADMIN: "L3 - CEO",
    L4_ADMIN: "L4 - Finance Department",
    CEO_ADMIN: "CEO Admin as",
  };
  return labels[role] || String(role || "");
}

function getAdminRoleName(role) {
  const labels = {
    L1_ADMIN: "L1 Admin",
    L2_ADMIN: "L2 General Manager",
    L3_ADMIN: "L3 CEO",
    L4_ADMIN: "L4 Finance Department",
    CEO_ADMIN: "CEO Admin",
  };
  return labels[role] || String(role || "");
}

function getAdminCurrentPending(claim, role) {
  if (claim.status === "REJECTED") return false;
  if (role === "L1_ADMIN") return claim.status === "SUBMITTED" || claim.status === "RETURNED_TO_L1";
  if (role === "L2_ADMIN") return claim.status === "APPROVED_L1" || claim.status === "RETURNED_TO_L2" || claim.status === "SUBMITTED";
  if (role === "L3_ADMIN") return claim.status === "APPROVED_L2" || claim.status === "RETURNED_TO_L3";
  if (role === "L4_ADMIN") return claim.status === "APPROVED_L3" || (claim.status === "DISBURSED" && !claim.isClosedByL4);
  if (role === "CEO_ADMIN") {
    return ["SUBMITTED", "APPROVED_L1", "APPROVED_L2", "APPROVED_L3", "RETURNED_TO_L1", "RETURNED_TO_L2", "RETURNED_TO_L3"].includes(claim.status)
      || (claim.status === "DISBURSED" && !claim.isClosedByL4);
  }
  return false;
}

async function computeEmployeeStatisticsRows(ctx, startDate, endDate) {
  return await dashboardEngine.computeEmployeeStatisticsRows(ctx, startDate, endDate);
}

async function computeAdminPerformanceRows(ctx, startDate, endDate) {
  return await dashboardEngine.computeAdminPerformanceRows(ctx, startDate, endDate);
}

function getReviewerRoleForClaim(status, category) {
  if (status === "SUBMITTED" && (category === "EMERGENCY" || category === "ULTRA_EMERGENCY")) {
    return "L2_ADMIN";
  }

  const reviewerMap = {
    SUBMITTED: "L1_ADMIN",
    APPROVED_L1: "L2_ADMIN",
    APPROVED_L2: "L3_ADMIN",
    APPROVED_L3: "L4_ADMIN",
    PARTIALLY_DISBURSED: "USER",
    RETURNED_TO_EMPLOYEE: "USER",
    RETURNED_TO_L1: "L1_ADMIN",
    RETURNED_TO_L2: "L2_ADMIN",
    RETURNED_TO_L3: "L3_ADMIN",
    DISBURSED: null,
    COMPLETED: null,
    REJECTED: null,
  };

  return reviewerMap[status] || null;
}

function getPendingStatusesForRole(role) {
  const statusMap = {
    L1_ADMIN: ["SUBMITTED", "RETURNED_TO_L1"],
    L2_ADMIN: ["SUBMITTED", "APPROVED_L1", "RETURNED_TO_L2"],
    L3_ADMIN: ["APPROVED_L2", "RETURNED_TO_L3"],
    L4_ADMIN: ["APPROVED_L3", "DISBURSED"],
    CEO_ADMIN: ["SUBMITTED", "APPROVED_L1", "APPROVED_L2", "APPROVED_L3", "RETURNED_TO_L1", "RETURNED_TO_L2", "RETURNED_TO_L3", "DISBURSED"],
  };
  return statusMap[role] || [];
}

function buildStorageUploadProxyUrl(ctx, target, args = {}) {
  const encodedArgs = Buffer.from(JSON.stringify(args ?? {}), "utf8").toString("base64url");
  return `${ctx.origin.replace(/\/$/, "")}/api/storage/upload?target=${encodeURIComponent(target)}&args=${encodeURIComponent(encodedArgs)}`;
}

function getAcceptedStatusesForRole(role) {
  const statusMap = {
    L1_ADMIN: ["APPROVED_L1", "APPROVED_L2", "APPROVED_L3", "PARTIALLY_DISBURSED", "RETURNED_TO_L2", "RETURNED_TO_L3", "DISBURSED", "COMPLETED"],
    L2_ADMIN: ["APPROVED_L2", "APPROVED_L3", "PARTIALLY_DISBURSED", "RETURNED_TO_L3", "DISBURSED", "COMPLETED"],
    L3_ADMIN: ["APPROVED_L3", "PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"],
    L4_ADMIN: ["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"],
    CEO_ADMIN: ["APPROVED_L1", "APPROVED_L2", "APPROVED_L3", "PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"],
  };
  return statusMap[role] || [];
}

function isCurrentReviewerForClaim(claim, role, userId) {
  const reviewer = getReviewerRoleForClaim(claim.status, claim.category);
  if (reviewer !== role) return false;
  if (reviewer === "L1_ADMIN") {
    return !claim.l1ApproverId || Boolean(userId && claim.l1ApproverId === userId);
  }
  if (reviewer === "L2_ADMIN") {
    return !claim.l2ApproverId || Boolean(userId && claim.l2ApproverId === userId);
  }
  return true;
}

function didReviewerTakeAction(claim, role, userId, action) {
  const assignedToReviewer = role === "L1_ADMIN" ? claim.l1ApproverId === userId : claim.l2ApproverId === userId;
  if (!assignedToReviewer) return false;

  const stage = role === "L1_ADMIN" ? "L1 - Admin" : "L2 - General Manager";
  if (Array.isArray(claim.logs) && claim.logs.some((log) => log.action === action && log.stage === stage)) {
    return true;
  }

  return false;
}

function isPendingL4Closure(claim) {
  if (isHistoricalImportClaim(claim)) return false;
  return claim.status === "DISBURSED" && Boolean(claim.proofSubmittedAt) && !claim.isClosedByL4;
}

function getAdminClaimRelationship(claim, role, userId) {
  if (isHistoricalImportClaim(claim)) {
    return {
      workflowBucket: "none",
      isPaymentRelevant: false,
      currentReviewer: null,
      isCurrentReviewer: false,
      actedByReviewer: false,
      approvedByReviewer: false,
      rejectedByReviewer: false,
    };
  }

  const currentReviewer = getReviewerRoleForClaim(claim.status, claim.category);
  const isPaymentRelevant = ["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"].includes(claim.status);
  const approvedByReviewer =
    (role === "L1_ADMIN" || role === "L2_ADMIN") && userId
      ? didReviewerTakeAction(claim, role, userId, "APPROVE")
      : false;
  const rejectedByReviewer =
    (role === "L1_ADMIN" || role === "L2_ADMIN") && userId
      ? didReviewerTakeAction(claim, role, userId, "REJECT")
      : false;
  const actedByReviewer = approvedByReviewer || rejectedByReviewer;
  const isCurrentReviewer = isCurrentReviewerForClaim(claim, role, userId);
  const isCeoPendingReview =
    role === "CEO_ADMIN" &&
    ((currentReviewer !== null && currentReviewer !== "USER") || isPendingL4Closure(claim));

  let workflowBucket = "none";
  if (claim.status === "REJECTED") {
    if (role === "L1_ADMIN" || role === "L2_ADMIN") {
      workflowBucket = actedByReviewer ? "rejected" : "none";
    } else {
      workflowBucket = "rejected";
    }
  } else if (isCeoPendingReview) {
    workflowBucket = "pending";
  } else if (role === "L4_ADMIN" && isPendingL4Closure(claim)) {
    workflowBucket = "pending";
  } else if (isCurrentReviewer) {
    workflowBucket = "pending";
  } else if (getAcceptedStatusesForRole(role).includes(claim.status)) {
    if (role === "L1_ADMIN" || role === "L2_ADMIN") {
      workflowBucket = approvedByReviewer ? "accepted" : "none";
    } else {
      workflowBucket = "accepted";
    }
  }

  return {
    workflowBucket,
    isPaymentRelevant,
    currentReviewer,
    isCurrentReviewer,
    actedByReviewer,
    approvedByReviewer,
    rejectedByReviewer,
  };
}

function resolveBucketForRole(claim, role, userId) {
  if (isHistoricalImportClaim(claim)) return null;
  if (role === "USER") {
    if (claim.status === "REJECTED") return "rejected";
    if (["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"].includes(claim.status)) return "accepted";
    return "pending";
  }
  if (role === "MONITOR") {
    return "pending";
  }

  const workflowBucket = getAdminClaimRelationship(claim, role, userId).workflowBucket;
  return workflowBucket === "none" ? null : workflowBucket;
}

function filterClaimsForAdminRole(claims, role, userId, bucket) {
  return claims.filter((claim) => resolveBucketForRole(claim, role, userId) === bucket);
}

function buildClaimPatch(action, user, args) {
  const now = new Date().toISOString();
  const log = {
    stage: user.role || "USER",
    action,
    remarks: args.remarks || args.reason || args.note || "",
    timestamp: now,
    actor: user.name || user.email || "Unknown",
    target: args.target,
    attachments: args.attachments,
  };
  return { now, log };
}

function isEmergencyCategory(category) {
  return category === "EMERGENCY";
}

function getAllowedReturnTargets(actorRole, category) {
  if (isEmergencyCategory(category)) {
    const emergencyTargets = {
      L1_ADMIN: ["EMPLOYEE"],
      L2_ADMIN: ["EMPLOYEE"],
      L3_ADMIN: ["EMPLOYEE", "L2_ADMIN"],
      L4_ADMIN: ["L3_ADMIN"],
      CEO_ADMIN: ["EMPLOYEE", "L2_ADMIN"],
    };
    return emergencyTargets[actorRole] || [];
  }

  const defaultTargets = {
    L1_ADMIN: ["EMPLOYEE"],
    L2_ADMIN: ["L1_ADMIN"],
    L3_ADMIN: ["EMPLOYEE", "L1_ADMIN", "L2_ADMIN"],
    L4_ADMIN: ["L3_ADMIN"],
    CEO_ADMIN: ["EMPLOYEE", "L1_ADMIN", "L2_ADMIN"],
  };
  return defaultTargets[actorRole] || [];
}

function getReturnStatusForTarget(targetRole) {
  const targetMap = {
    EMPLOYEE: "RETURNED_TO_EMPLOYEE",
    L1_ADMIN: "RETURNED_TO_L1",
    L2_ADMIN: "RETURNED_TO_L2",
    L3_ADMIN: "RETURNED_TO_L3",
  };
  return targetMap[targetRole] || null;
}

function getReturnTargetLabel(targetRole) {
  const targetLabel = {
    EMPLOYEE: "Employee",
    L1_ADMIN: "L1 - Admin",
    L2_ADMIN: "L2 - General Manager",
    L3_ADMIN: "L3 - CEO",
  };
  return targetLabel[targetRole] || String(targetRole || "");
}

function getVendorDocumentTypeLabel(documentType, documentLabel) {
  if (documentType === "WORK_ORDER") return "Work Order";
  if (documentType === "AGREEMENT") return "Agreement";
  if (documentType === "OTHER") return documentLabel || "Other";
  return documentLabel || String(documentType || "Document");
}

function getVendorDocumentStatusLabel(status) {
  if (status === "CURRENT") return "Current";
  if (status === "REPLACED") return "Historical";
  if (status === "REMOVED") return "Removed";
  return String(status || "");
}

function describeClaimVendorSnapshotForAudit(claim) {
  const code = claim.vendorCode?.trim();
  const name = claim.vendorName?.trim();
  if (code && name) return `${code} · ${name}`;
  if (name) return name;
  if (code) return code;
  return null;
}

function describeVendorForAudit(vendor) {
  const code = vendor.code?.trim();
  const name = vendor.name?.trim();
  if (code && name) return `${code} · ${name}`;
  if (name) return name;
  if (code) return code;
  return null;
}

function buildClaimTransferAuditPayload({
  currentUser,
  fromVendor,
  fromClaimVendorSnapshot,
  toVendor,
  note,
  timestamp,
}) {
  const fromVendorLabel = fromVendor ? describeVendorForAudit(fromVendor) : fromClaimVendorSnapshot || "unassigned vendor";
  const transferNote =
    String(note || "").trim() ||
    `Transferred claim from ${fromVendorLabel} to ${describeVendorForAudit(toVendor)}`;

  return {
    action: "TRANSFERRED",
    note: `${transferNote}. Vendor changed from ${fromVendorLabel} to ${describeVendorForAudit(toVendor)}.`,
    timestamp,
    actor: currentUser.name,
    ...(fromVendor
      ? {
          fromVendorId: fromVendor._id,
          fromVendorCode: fromVendor.code,
          fromVendorName: fromVendor.name,
        }
      : fromClaimVendorSnapshot
        ? {
            fromVendorName: fromClaimVendorSnapshot,
          }
        : {}),
    toVendorId: toVendor._id,
    toVendorCode: toVendor.code,
    toVendorName: toVendor.name,
  };
}

function buildClaimVendorSnapshot(vendor) {
  return {
    vendorId: vendor._id,
    vendorCode: vendor.code,
    vendorName: vendor.name,
    vendorOfficialEmail: vendor.officialEmail,
    vendorPhone: vendor.mobileNumber || vendor.phone || null,
    vendorContactPersonName: vendor.contactPersonName || null,
    vendorContactEmail: vendor.contactEmail || null,
    vendorPan: vendor.panNumber || null,
    vendorAddress: vendor.address || null,
    vendorGstin: vendor.gstNumber || null,
    vendorStatus: vendor.status || null,
  };
}

function deriveVendorClaimFinancials(claim) {
  const totalRequestedAmount = Math.max(0, Number(claim.totalRequestedAmount ?? claim.amount ?? 0));
  const fallbackDisbursed =
    claim.status === "DISBURSED" || claim.status === "COMPLETED" ? totalRequestedAmount : 0;
  const totalDisbursedAmount = Math.max(0, Number(claim.totalDisbursedAmount ?? fallbackDisbursed ?? 0));
  const pendingAmount = Math.max(0, Number(claim.pendingAmount ?? (totalRequestedAmount - totalDisbursedAmount) ?? 0));
  return { totalRequestedAmount, totalDisbursedAmount, pendingAmount };
}

function buildVendorLedger(claims) {
  const sources = claims
    .filter((claim) => claim.status !== "REJECTED")
    .map((claim) => ({ id: claim._id, claim }))
    .sort((a, b) => {
      const leftDate = Number.isFinite(Date.parse(a.claim.date)) ? Date.parse(a.claim.date) : 0;
      const rightDate = Number.isFinite(Date.parse(b.claim.date)) ? Date.parse(b.claim.date) : 0;
      if (leftDate !== rightDate) return leftDate - rightDate;
      if (String(a.claim.createdAt || "") !== String(b.claim.createdAt || "")) {
        return String(a.claim.createdAt || "").localeCompare(String(b.claim.createdAt || ""));
      }
      return String(a.id).localeCompare(String(b.id));
    });

  let totalPreviousPaidToVendor = 0;
  let totalPreviousRequestedToVendor = 0;
  let runningOutstandingAmount = 0;
  let totalClaimInvoiceAmount = 0;
  let totalClaimPaidAmount = 0;
  let totalClaims = 0;
  const rows = [];

  for (const source of sources) {
    const claim = source.claim;
    const financial = deriveVendorClaimFinancials(claim);
    totalClaims += 1;
    totalClaimInvoiceAmount += financial.totalRequestedAmount;
    totalClaimPaidAmount += financial.totalDisbursedAmount;

    rows.push({
      rowId: String(claim._id),
      entryType: "CLAIM",
      claimId: claim._id,
      createdAt: claim.createdAt,
      date: claim.date,
      projectTitle: claim.projectTitle ?? claim.title ?? undefined,
      description: claim.description,
      status: claim.status,
      category: claim.category,
      paymentMode: claim.paymentMode,
      entryLabel: claim.projectTitle ?? claim.title ?? "Claim",
      currentInvoiceAmount: financial.totalRequestedAmount,
      amountPaid: financial.totalDisbursedAmount,
      pendingAmount: financial.pendingAmount,
      totalPreviousPaidToVendor,
      totalRequestedSoFar: totalPreviousRequestedToVendor + financial.totalRequestedAmount,
      totalPaidSoFar: totalPreviousPaidToVendor + financial.totalDisbursedAmount,
      totalPaidIncludingThisInvoice: totalPreviousPaidToVendor + financial.totalDisbursedAmount,
      outstandingAmount: runningOutstandingAmount + financial.pendingAmount,
      totalRequestedAmount: financial.totalRequestedAmount,
      totalDisbursedAmount: financial.totalDisbursedAmount,
    });

    totalPreviousRequestedToVendor += financial.totalRequestedAmount;
    totalPreviousPaidToVendor += financial.totalDisbursedAmount;
    runningOutstandingAmount += financial.pendingAmount;
  }

  return {
    rows,
    summary: {
      totalClaims,
      totalInvoiceAmount: totalClaimInvoiceAmount,
      totalPaidAmount: totalClaimPaidAmount,
      totalOutstandingAmount: rows[rows.length - 1]?.outstandingAmount ?? 0,
      firstActivityDate: rows[0]?.date ?? null,
      lastActivityDate: rows.length > 0 ? rows[rows.length - 1].date : null,
    },
  };
}

function normalizeLedgerSearch(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function filterVendorLedgerRowsByCriteria(rows, args = {}) {
  const search = normalizeLedgerSearch(args.searchQuery || "");
  const statusFilter = args.statusFilter && args.statusFilter !== "all" ? args.statusFilter : undefined;
  const categoryFilter = args.categoryFilter && args.categoryFilter !== "all" ? args.categoryFilter : undefined;
  const paymentModeFilter = args.paymentModeFilter && args.paymentModeFilter !== "all" ? args.paymentModeFilter : undefined;
  const startDateMs = args.startDate ? Date.parse(args.startDate) : null;
  const endDateMs = args.endDate ? Date.parse(args.endDate) : null;

  return rows.filter((row) => {
    const rowSearchText = [
      row.rowId,
      row.entryLabel,
      row.projectTitle,
      row.description,
      row.status,
      row.category,
      row.paymentMode,
      row.date,
    ]
      .filter(Boolean)
      .join(" ");
    if (search && !normalizeLedgerSearch(rowSearchText).includes(search)) return false;
    if (statusFilter && row.status !== statusFilter) return false;
    if (categoryFilter && row.category !== categoryFilter) return false;
    if (paymentModeFilter && row.paymentMode !== paymentModeFilter) return false;
    const rowDateMs = Date.parse(row.date);
    if (startDateMs != null && (!Number.isFinite(rowDateMs) || rowDateMs < startDateMs)) return false;
    if (endDateMs != null && (!Number.isFinite(rowDateMs) || rowDateMs > endDateMs)) return false;
    return true;
  });
}

function buildVendorLedgerPage(claims, args = {}) {
  const ledger = buildVendorLedger(claims);
  const filteredRows = filterVendorLedgerRowsByCriteria(ledger.rows, args);
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(args.pageSize ?? 10))));
  const totalRows = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(Number(args.page ?? 1))), totalPages);
  const start = (page - 1) * pageSize;
  return {
    ...ledger,
    rows: filteredRows.slice(start, start + pageSize),
    totalRows,
    page,
    pageSize,
  };
}

function shapeVendorTransferQueueClaim(claim) {
  return {
    _id: claim._id,
    claimId: claim._id,
    date: claim.date,
    amount: claim.amount,
    description: claim.description,
    projectTitle: claim.projectTitle ?? claim.title ?? null,
    vendorId: claim.vendorId ?? null,
    vendorCode: claim.vendorCode ?? null,
    vendorName: claim.vendorName ?? null,
    vendorOfficialEmail: claim.vendorOfficialEmail ?? null,
    vendorPhone: claim.vendorPhone ?? null,
    vendorContactPersonName: claim.vendorContactPersonName ?? null,
    vendorContactEmail: claim.vendorContactEmail ?? null,
    vendorPan: claim.vendorPan ?? null,
    vendorAddress: claim.vendorAddress ?? null,
    vendorGstin: claim.vendorGstin ?? null,
    status: claim.status,
    paymentMode: claim.paymentMode ?? null,
    transferStatus: claim.vendorId ? "TRANSFERRED" : "UNASSIGNED",
    transferStatusLabel: claim.vendorId ? "Linked to registered vendor" : "Awaiting vendor transfer",
    transferHistory: claim.vendorTransferAudit ?? [],
    createdAt: claim.createdAt,
  };
}

function getStageName(role) {
  const stageNames = {
    L1_ADMIN: "L1 - Admin",
    L2_ADMIN: "L2 - General Manager",
    L3_ADMIN: "L3 - CEO",
    L4_ADMIN: "L4 - Finance Department",
    CEO_ADMIN: "CEO Admin (Override)",
  };
  return stageNames[role] || role;
}

function getStageNameWithCeoOverride(actorRole, claim) {
  if (actorRole !== "CEO_ADMIN") return getStageName(actorRole);
  const reviewerRole = getReviewerRoleForClaim(claim.status, claim.category);
  const effectiveRole = reviewerRole && reviewerRole !== "USER" ? reviewerRole : null;
  if (!effectiveRole) return getStageName(actorRole);
  return `CEO Admin as ${getStageName(effectiveRole)}`;
}

function assertCanReviewClaim(user, claim) {
  const reviewerRole = getReviewerRoleForClaim(claim.status, claim.category);
  if (!reviewerRole || reviewerRole === "USER") throw forbidden("Claim cannot be reviewed in its current state");
  const allowedRoles = ["L1_ADMIN", "L2_ADMIN", "L3_ADMIN", "L4_ADMIN", "CEO_ADMIN"];
  if (!allowedRoles.includes(user.role)) throw forbidden("You do not have permission to review this claim");
}

function normalizeEmail(value) {
  return value?.trim().toLowerCase();
}

function normalizeText(value) {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "";
}

function buildDemoIdentity(role, vertical) {
  const slug = vertical
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  const prefixByRole = {
    L1_ADMIN: "l1",
    L2_ADMIN: "l2",
  };

  const roleLabelByRole = {
    L1_ADMIN: "L1 Admin",
    L2_ADMIN: "L2 Admin",
  };

  return {
    name: `${roleLabelByRole[role]} - ${vertical}`,
    email: `${prefixByRole[role]}.${slug}@demo.company.com`,
  };
}

async function syncDemoVerticalRolesInDb(ctx) {
  const now = Date.now();
  const allUsers = await ctx.db.collection("users").find({}).toArray();
  const updates = [];
  const consumedUserIds = new Set();

  for (const role of ["L1_ADMIN", "L2_ADMIN"]) {
    const roleUsers = allUsers.filter((user) => user.role === role);

    for (const vertical of COMPANY_VERTICALS) {
      const mappedActive = roleUsers.filter(
        (user) =>
          (user.status || "active") === "active" &&
          Array.isArray(user.verticals) &&
          user.verticals.includes(vertical),
      );

      if (mappedActive.length > 1) {
        const [keep, ...duplicates] = mappedActive;
        consumedUserIds.add(String(keep._id));
        for (const duplicate of duplicates) {
          await ctx.db.collection("users").updateOne(
            { _id: duplicate._id },
            {
              $set: {
                status: "inactive",
                assignedBy: "demo-migration",
                assignedAt: now,
              },
            },
          );
          updates.push(`Deactivated duplicate ${role} ${duplicate.email} for ${vertical}`);
        }
        continue;
      }

      if (mappedActive.length === 1) {
        consumedUserIds.add(String(mappedActive[0]._id));
        continue;
      }

      const reusable = roleUsers.find(
        (user) =>
          !consumedUserIds.has(String(user._id)) &&
          (user.status || "active") === "active" &&
          (!Array.isArray(user.verticals) || user.verticals.length === 0),
      );

      if (reusable) {
        await ctx.db.collection("users").updateOne(
          { _id: reusable._id },
          {
            $set: {
              verticals: [vertical],
              assignedBy: "demo-migration",
              assignedAt: now,
            },
          },
        );
        consumedUserIds.add(String(reusable._id));
        updates.push(`Assigned ${role} ${reusable.email} to ${vertical}`);
        continue;
      }

      const { name, email } = buildDemoIdentity(role, vertical);
      const normalizedEmail = normalizeEmail(email);
      const existingByEmail = await ctx.db.collection("users").findOne({ email: normalizedEmail });

      if (existingByEmail) {
        await ctx.db.collection("users").updateOne(
          { _id: existingByEmail._id },
          {
            $set: {
              name,
              email: normalizedEmail,
              role,
              verticals: [vertical],
              status: "active",
              assignedBy: "demo-migration",
              assignedAt: now,
            },
          },
        );
        consumedUserIds.add(String(existingByEmail._id));
        updates.push(`Reactivated existing ${email} as ${role} for ${vertical}`);
      } else {
        const createdUserId = new ObjectId().toHexString();
        await ctx.db.collection("users").insertOne({
          _id: createdUserId,
          name,
          email: normalizedEmail,
          role,
          verticals: [vertical],
          status: "active",
          assignedBy: "demo-migration",
          assignedAt: now,
        });
        consumedUserIds.add(String(createdUserId));
        updates.push(`Created ${role} ${email} for ${vertical}`);
      }
    }
  }

  return {
    ok: true,
    changes: updates,
  };
}

async function resolveAttachmentUrl(ctx, storageId, authEmail) {
  if (!ctx.origin || !storageId) return null;
  return `${ctx.origin.replace(/\/$/, "")}/api/storage/${storageId}`;
}

function normalizeTax(value) {
  return value?.trim().toUpperCase().replace(/\s+/g, "") || "";
}

async function syncDemoUsersInDb(ctx) {
  const now = Date.now();
  const allUsers = await ctx.db.collection("users").find({}).toArray();
  const usersByEmail = new Map(allUsers.map((user) => [normalizeEmail(user.email), user]));
  const changes = [];

  for (const demoUser of DEMO_USERS) {
    const email = normalizeEmail(demoUser.email);
    const existingUser = usersByEmail.get(email);
    const nextUser = {
      name: demoUser.name,
      email,
      role: demoUser.role,
      status: "active",
      assignedBy: "demo-migration",
      assignedAt: now,
      ...(demoUser.verticals ? { verticals: demoUser.verticals } : {}),
    };

    if (existingUser) {
      await ctx.db.collection("users").updateOne(
        { _id: existingUser._id },
        { $set: nextUser },
      );
      changes.push({ email, action: "updated" });
      continue;
    }

    await ctx.db.collection("users").insertOne({
      _id: new ObjectId().toHexString(),
      ...nextUser,
    });
    changes.push({ email, action: "created" });
  }

  const verticalRoleResult = await syncDemoVerticalRolesInDb(ctx);

  return {
    ok: true,
    created: changes.filter((change) => change.action === "created").length,
    updated: changes.filter((change) => change.action === "updated").length,
    changes,
    verticalRoleResult,
  };
}

async function ensureDemoCeoAdminInDb(ctx) {
  const now = Date.now();
  const allUsers = await ctx.db.collection("users").find({}).toArray();
  const normalize = (value) => normalizeEmail(value);
  const demoEmail = normalize(DEMO_CEO_EMAIL);

  const existingDemoUser = allUsers.find((user) => normalize(user.email) === demoEmail);
  const activeCeoUser = allUsers.find((user) => user.role === "CEO_ADMIN" && (user.status || "active") === "active");

  if (activeCeoUser && (!existingDemoUser || String(activeCeoUser._id) !== String(existingDemoUser._id))) {
    return {
      ok: true,
      created: false,
      usedExistingActiveCeo: true,
      userId: activeCeoUser._id,
    };
  }

  if (existingDemoUser) {
    await ctx.db.collection("users").updateOne(
      { _id: existingDemoUser._id },
      {
        $set: {
          name: DEMO_CEO_NAME,
          email: demoEmail,
          role: "CEO_ADMIN",
          status: "active",
          assignedBy: "system",
          assignedAt: now,
        },
      },
    );
    return {
      ok: true,
      created: false,
      usedExistingActiveCeo: false,
      userId: existingDemoUser._id,
    };
  }

  const createdUserId = new ObjectId().toHexString();
  await ctx.db.collection("users").insertOne({
    _id: createdUserId,
    name: DEMO_CEO_NAME,
    email: demoEmail,
    role: "CEO_ADMIN",
    status: "active",
    assignedBy: "system",
    assignedAt: now,
  });
  return {
    ok: true,
    created: true,
    usedExistingActiveCeo: false,
    userId: createdUserId,
  };
}

function buildDemoRequisitionFallback() {
  const drafts = [
    {
      projectTitle: "Office Electrical Repair",
      category: "WITHDRAWAL",
      companyVertical: "BKT Infratech",
      purpose: "Urgent electrical repair and replacement of damaged fittings at the site office.",
      vendorName: "Sharma Traders",
      vendorPhone: "9876543210",
      vendorPan: "ABCDE1234F",
      vendorAddress: "Sector 12, Ranchi, Jharkhand",
      billingAddress: "BKT Office, Ranchi, Jharkhand",
      shippingAddress: "Project Site, Ranchi, Jharkhand",
      vendorGstin: "20ABCDE1234F1Z5",
      costType: "OPEX",
      paymentMode: "ACCOUNT_TRANSFER",
      bankAccountHolderName: "Sharma Traders",
      bankAccountNumber: "123456789012",
      bankName: "State Bank of India",
      bankBranch: "Ranchi Main",
      bankIfscCode: "SBIN0000123",
      amount: 75000,
      description: "Advance requested for electrical repair and supporting site expenses.",
    },
    {
      projectTitle: "Safety Gear Procurement",
      category: "EMERGENCY",
      companyVertical: "BKT Tactical Solutions",
      purpose: "Immediate procurement of safety helmets, gloves, and reflective vests for field staff.",
      vendorName: "Apex Safety Solutions",
      vendorPhone: "9811223344",
      vendorPan: "PQRSX5678L",
      vendorAddress: "Industrial Area, Patna, Bihar",
      billingAddress: "BKT Tactical Office, Patna, Bihar",
      shippingAddress: "Warehouse, Patna, Bihar",
      vendorGstin: "10PQRSX5678L1Z4",
      costType: "CAPEX",
      paymentMode: "CASH",
      bankAccountHolderName: "",
      bankAccountNumber: "",
      bankName: "",
      bankBranch: "",
      bankIfscCode: "",
      amount: 42000,
      description: "Cash requisition for urgent safety gear procurement.",
    },
    {
      projectTitle: "Courier and Handling Support",
      category: "WITHDRAWAL",
      companyVertical: "Samridhi Informatics",
      purpose: "Courier charges and handling expenses for ongoing office dispatches.",
      vendorName: "FastMove Logistics",
      vendorPhone: "9898989898",
      vendorPan: "LMNOP1234Q",
      vendorAddress: "Old Airport Road, Bangalore, Karnataka",
      billingAddress: "Samridhi Office, Bangalore, Karnataka",
      shippingAddress: "Samridhi Office, Bangalore, Karnataka",
      vendorGstin: "29LMNOP1234Q1Z7",
      costType: "OPEX",
      paymentMode: "ACCOUNT_TRANSFER",
      bankAccountHolderName: "FastMove Logistics",
      bankAccountNumber: "987654321098",
      bankName: "HDFC Bank",
      bankBranch: "Bangalore Main",
      bankIfscCode: "HDFC0001234",
      amount: 28000,
      description: "Request for courier and handling charges linked to field dispatches.",
    },
  ];
  const index = Math.abs(new Date().getDate() + new Date().getMonth()) % drafts.length;
  return { ...drafts[index], date: new Date().toISOString().slice(0, 10) };
}

async function generateDemoRequisitionDraftFromGroq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Generate one realistic Indian business cash requisition draft as strict JSON.
Return only JSON with keys:
projectTitle, category, companyVertical, purpose, vendorName, vendorPhone, vendorPan, vendorAddress, billingAddress, shippingAddress, vendorGstin, costType, paymentMode, bankAccountHolderName, bankAccountNumber, bankName, bankBranch, bankIfscCode, amount, description, date

Rules:
- category must be WITHDRAWAL or EMERGENCY
- companyVertical must be exactly one of:
  "M/S Birendra Kumar Tripathi", "BKT Minetech Solutions", "BKT Tactical Solutions", "BKT Infratech", "Samridhi Informatics", "Others (JV / Partnerships)"
- costType must be CAPEX or OPEX
- paymentMode must be CASH or ACCOUNT_TRANSFER
- If paymentMode is CASH, keep bank fields as empty strings
- If paymentMode is ACCOUNT_TRANSFER, provide plausible bank details and IFSC format like ABCD0123456
- amount must be numeric between 15000 and 450000
- date must be "${today}"
- Keep text concise and professional`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You generate strict JSON objects for enterprise requisition forms." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 600,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI response was empty");
  }

  const parsed = JSON.parse(content);
  const paymentMode = parsed.paymentMode === "ACCOUNT_TRANSFER" ? "ACCOUNT_TRANSFER" : "CASH";
  const amount = Number(parsed.amount);

  return {
    projectTitle: String(parsed.projectTitle || "Field Operations Support"),
    category: parsed.category === "EMERGENCY" ? "EMERGENCY" : "WITHDRAWAL",
    companyVertical: ([
      "M/S Birendra Kumar Tripathi",
      "BKT Minetech Solutions",
      "BKT Tactical Solutions",
      "BKT Infratech",
      "Samridhi Informatics",
      "Others (JV / Partnerships)",
    ]).includes(parsed.companyVertical)
      ? parsed.companyVertical
      : "BKT Infratech",
    purpose: String(parsed.purpose || "Material procurement and on-site execution support."),
    vendorName: String(parsed.vendorName || "Sharma Traders"),
    vendorPhone: String(parsed.vendorPhone || "9876543210"),
    vendorPan: String(parsed.vendorPan || "ABCDE1234F"),
    vendorAddress: String(parsed.vendorAddress || "Sector 12, Ranchi, Jharkhand"),
    billingAddress: String(parsed.billingAddress || "BKT Office, Ranchi, Jharkhand"),
    shippingAddress: String(parsed.shippingAddress || "Project Site, Ranchi, Jharkhand"),
    vendorGstin: String(parsed.vendorGstin || "20ABCDE1234F1Z5"),
    costType: parsed.costType === "CAPEX" ? "CAPEX" : "OPEX",
    paymentMode,
    bankAccountHolderName: paymentMode === "ACCOUNT_TRANSFER" ? String(parsed.bankAccountHolderName || "Sharma Traders") : "",
    bankAccountNumber: paymentMode === "ACCOUNT_TRANSFER" ? String(parsed.bankAccountNumber || "123456789012") : "",
    bankName: paymentMode === "ACCOUNT_TRANSFER" ? String(parsed.bankName || "State Bank of India") : "",
    bankBranch: paymentMode === "ACCOUNT_TRANSFER" ? String(parsed.bankBranch || "Ranchi Main") : "",
    bankIfscCode: paymentMode === "ACCOUNT_TRANSFER" ? String(parsed.bankIfscCode || "SBIN0000123") : "",
    amount: Number.isFinite(amount) ? Math.max(15000, Math.min(450000, amount)) : 75000,
    description: String(parsed.description || "Advance requested for procurement and associated operational expenses."),
    date: today,
  };
}

async function listClaims(ctx, args, baseFilter = {}) {
  const { page, pageSize, skip } = pageArgs(args);
  const filter = { ...baseFilter };
  if (args.status) filter.status = args.status;
  if (args.companyVertical) filter.companyVertical = args.companyVertical;
  if (args.paymentModeFilter || args.paymentMode) filter.paymentMode = args.paymentModeFilter || args.paymentMode;
  if (args.vendorId) filter.vendorId = args.vendorId;
  if (args.paymentStartDate || args.startDate) filter.date = { ...(filter.date || {}), $gte: args.paymentStartDate || args.startDate };
  if (args.paymentEndDate || args.endDate) filter.date = { ...(filter.date || {}), $lte: args.paymentEndDate || args.endDate };

  let items = await ctx.db.collection("claims").find(filter).sort({ date: -1, createdAt: -1, _creationTime: -1 }).toArray();
  items = items.filter((claim) => matchesSearch(claim, args.searchQuery));
  if (args.bucket) items = items.filter((claim) => employeeBucketForClaim(claim) === args.bucket);
  if (args.statusFilter && args.statusFilter !== "ALL" && args.statusFilter !== "ACTION_REQUIRED") {
    items = items.filter((claim) => claim.status === args.statusFilter);
  }
  if (args.statusFilter === "ACTION_REQUIRED") {
    items = items.filter((claim) => claim.status === "APPROVED_L3" || claim.status === "PARTIALLY_DISBURSED");
  }

  return {
    items: items.slice(skip, skip + pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

async function getAdminClaimsPage(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  const role = user.role;
  if (!canViewAdmin(role) && !canViewFinance(role)) throw forbidden();

  const claims = await ctx.db.collection("claims").find({}).sort({ date: -1, createdAt: -1, _creationTime: -1 }).toArray();
  const bucket = args.bucket || "pending";
  const financeFilters = {
    searchQuery: args.searchQuery,
    companyVertical: args.companyVertical,
    category: args.category,
    statusFilter: args.statusFilter,
    paymentModeFilter: args.paymentModeFilter,
    paymentStartDate: args.paymentStartDate,
    paymentEndDate: args.paymentEndDate,
  };
  const filtered = bucket === "payments"
    ? filterFinanceDashboardClaims(getFinanceCandidateClaims(claims), financeFilters)
    : bucket === "action_required"
      ? filterFinanceDashboardClaims(claims.filter((claim) => isFinanceActionRequiredClaim(claim)), financeFilters)
      : filterClaimsForAdminRole(claims, role, user._id, bucket);
  const searched = bucket === "payments" || bucket === "action_required"
    ? filtered
    : filtered.filter((claim) => matchesSearch(claim, args.searchQuery));
  const { page, pageSize, skip } = pageArgs(args);
  const pageItems = searched.slice(skip, skip + pageSize);
  const financeSummary = bucket === "payments"
    ? summarizeFinanceDashboardClaims(searched)
    : null;
  return {
    items: pageItems,
    total: searched.length,
    page,
    pageSize,
    ...(financeSummary
      ? {
        totalPaid: financeSummary.totalPaid,
        totalPending: financeSummary.totalPending,
        paymentModeTotals: financeSummary.paymentModeTotals,
      }
      : {}),
  };
}

async function getAdminDashboardSummary(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAdmin(user.role)) throw forbidden();
  const claims = await ctx.db.collection("claims").find({}).toArray();
  const pending = filterClaimsForAdminRole(claims, user.role, user._id, "pending").length;
  const accepted = filterClaimsForAdminRole(claims, user.role, user._id, "accepted").length;
  const rejected = filterClaimsForAdminRole(claims, user.role, user._id, "rejected").length;
  return { pending, accepted, rejected };
}

async function getAdminActionRequiredSummary(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAdmin(user.role) && !canViewFinance(user.role)) throw forbidden();
  const claims = await ctx.db.collection("claims").find({}).toArray();
  const filtered = claims.filter((claim) => isFinanceActionRequiredClaim(claim));
  return { total: filtered.length, items: filtered.slice(0, 20) };
}

async function summarizeClaims(claims) {
  const summary = {
    total: claims.length,
    pending: 0,
    action_required: 0,
    accepted: 0,
    rejected: 0,
    totalAmount: 0,
    totalPaid: 0,
    totalPending: 0,
    cashAmount: 0,
    cashCount: 0,
    accountTransferAmount: 0,
    accountTransferCount: 0,
  };
  for (const claim of claims) {
    const bucket = employeeBucketForClaim(claim);
    summary[bucket] = (summary[bucket] || 0) + 1;
    const amount = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
    const paid = Number(claim.totalDisbursedAmount ?? (terminalAcceptedStatuses.has(claim.status) ? amount : 0));
    summary.totalAmount += amount;
    summary.totalPaid += paid;
    summary.totalPending += Math.max(0, Number(claim.pendingAmount ?? amount - paid));
    if (claim.paymentMode === "CASH") {
      summary.cashAmount += amount;
      summary.cashCount += 1;
    }
    if (claim.paymentMode === "ACCOUNT_TRANSFER") {
      summary.accountTransferAmount += amount;
      summary.accountTransferCount += 1;
    }
  }
  return summary;
}

async function buildFinanceExportItem(ctx, claim) {
  const claimCycles = await ctx.db.collection("claimCycles").find({ claimId: claim._id }).sort({ cycleNumber: 1, createdAt: 1 }).toArray();
  const quotationUrl = claim.attachmentR2Key
    ? await resolveAttachmentUrl(ctx, claim.attachmentR2Key, null)
    : claim.attachmentStorageId
      ? await resolveAttachmentUrl(ctx, claim.attachmentStorageId, null)
      : null;

  const proofs = Array.isArray(claim.proofDocuments)
    ? await Promise.all(claim.proofDocuments.map(async (doc) => ({
      fileName: doc.fileName,
      uploadedAt: doc.uploadedAt,
      url:
        doc.url
        || (doc.r2Key ? await resolveAttachmentUrl(ctx, doc.r2Key, null) : null)
        || (doc.storageId ? await resolveAttachmentUrl(ctx, doc.storageId, null) : null),
    })))
    : [];

  const requestedAmount = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
  const paidAmount = Number(claim.totalDisbursedAmount ?? ((claim.status === "DISBURSED" || claim.status === "COMPLETED") ? requestedAmount : 0) ?? 0);
  const pendingAmount = Math.max(0, Number(claim.pendingAmount ?? Math.max(0, requestedAmount - paidAmount) ?? 0));
  const submittedAt = claim.logs?.find((log) => log.action === "SUBMIT")?.timestamp || claim.createdAt || null;
  const l1ApprovedAt = claim.logs?.find((log) => log.action === "APPROVE" && String(log.stage || "").includes("L1 - Admin"))?.timestamp || null;
  const l2ApprovedAt = claim.logs?.find((log) => log.action === "APPROVE" && String(log.stage || "").includes("L2 - General Manager"))?.timestamp || null;
  const l3ApprovedAt = claim.logs?.find((log) => log.action === "APPROVE" && String(log.stage || "").includes("L3 - CEO"))?.timestamp || null;
  const l4ActionLog = claim.logs?.find((log) => log.action === "APPROVE" && String(log.stage || "").includes("L4 -"));
  const closureLog = claim.logs?.find((log) => log.action === "APPROVE" && String(log.stage || "").includes("L4 - Finance Department"));
  const paymentReference = closureLog?.remarks?.match(/Payment Ref:\s*([^.]+)/i)?.[1]?.trim() || null;
  const returnCount = Array.isArray(claim.logs) ? claim.logs.filter((log) => log.action === "RETURN").length : 0;
  const paymentHistory = claimCycles
    .filter((cycle) => Number(cycle.disbursedAmount || 0) > 0)
    .map((cycle) => ({
      cycleNumber: cycle.cycleNumber,
      disbursedAmount: Number(cycle.disbursedAmount || 0),
      disbursedAt: cycle.disbursedAt,
      closingPendingAmount: cycle.closingPendingAmount,
      status: cycle.status,
    }));

  return {
    _id: claim._id,
    userName: claim.userName,
    projectTitle: claim.projectTitle,
    vendorId: claim.vendorId,
    vendorCode: claim.vendorCode,
    category: claim.category,
    companyVertical: claim.companyVertical,
    suggestedByEmployee: claim.suggestedByEmployee,
    costType: claim.costType,
    paymentMode: claim.paymentMode,
    amount: claim.amount,
    totalRequestedAmount: requestedAmount,
    totalDisbursedAmount: paidAmount,
    pendingAmount,
    date: claim.date,
    status: claim.status,
    employeeReceivedAt: claim.employeeReceivedAt,
    disbursedAt: claim.disbursedAt,
    proofSubmittedAt: claim.proofSubmittedAt,
    closedAt: claim.closedAt,
    paymentHistory,
    paymentReference,
    approvalTimestamps: {
      l1ApprovedAt,
      l2ApprovedAt,
      l3ApprovedAt,
      l4ActionAt: l4ActionLog?.timestamp || null,
    },
    delayHoursByLevel: {
      l1: null,
      l2: null,
      l3: null,
      l4: null,
    },
    agingHours: null,
    budgetHead: claim.costType || null,
    costCenter: claim.companyVertical || null,
    vendorOfficialEmail: claim.vendorOfficialEmail,
    vendorContactPersonName: claim.vendorContactPersonName,
    vendorContactEmail: claim.vendorContactEmail,
    vendorPan: claim.vendorPan,
    vendorGstin: claim.vendorGstin,
    vendorAddress: claim.vendorAddress,
    billingAddress: claim.billingAddress,
    shippingAddress: claim.shippingAddress,
    vendorPhone: claim.vendorPhone,
    bankAccountHolderName: claim.bankAccountHolderName,
    bankAccountNumber: claim.bankAccountNumber,
    bankName: claim.bankName,
    bankBranch: claim.bankBranch,
    bankIfscCode: claim.bankIfscCode,
    closedBy: closureLog?.actor || null,
    returnCount,
    assets: {
      quotation: quotationUrl
        ? { fileName: claim.attachmentFileName || "Quotation", url: quotationUrl }
        : null,
      proofs,
    },
  };
}

function normalizeFinancialsForPaymentBifurcation(claim) {
  const totalRequestedAmount = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
  const totalDisbursedAmount =
    Number(
      claim.totalDisbursedAmount
      ?? ((claim.status === "DISBURSED" || claim.status === "COMPLETED") ? totalRequestedAmount : 0),
    );
  const pendingAmount = Number(claim.pendingAmount ?? Math.max(0, totalRequestedAmount - totalDisbursedAmount));
  return { totalRequestedAmount, totalDisbursedAmount, pendingAmount };
}

function emptyPaymentBifurcationSummary(filters) {
  return {
    filters,
    totalRequests: { count: 0, amount: 0 },
    underReview: { count: 0, amount: 0 },
    approved: {
      count: 0,
      amount: 0,
      awaitingPayment: { count: 0, amount: 0 },
      paid: { count: 0, amount: 0 },
    },
    advanceAndRemaining: {
      advancePaidAmount: 0,
      remainingBalancePendingAmount: 0,
      totalTrackedAmount: 0,
    },
    advancePaid: { amount: 0 },
    remainingBalancePending: { amount: 0 },
    byPaymentMode: {
      cash: {
        totalRequests: { count: 0, amount: 0 },
        underReview: { count: 0, amount: 0 },
        approved: {
          count: 0,
          amount: 0,
          awaitingPayment: { count: 0, amount: 0 },
          paid: { count: 0, amount: 0 },
        },
        advancePaid: { amount: 0 },
        remainingBalancePending: { amount: 0 },
      },
      accountTransfer: {
        totalRequests: { count: 0, amount: 0 },
        underReview: { count: 0, amount: 0 },
        approved: {
          count: 0,
          amount: 0,
          awaitingPayment: { count: 0, amount: 0 },
          paid: { count: 0, amount: 0 },
        },
        advancePaid: { amount: 0 },
        remainingBalancePending: { amount: 0 },
      },
    },
  };
}

async function getPaymentBifurcationSummary(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const result = await dashboardEngine.computePaymentBifurcationSummary(ctx, args);
  return result.result;
}

async function getAttachmentUrl(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  const storageId = args.storageId;
  if (!storageId) return null;

  const claim = await ctx.db.collection("claims").findOne({
    $or: [
      { attachmentStorageId: storageId },
      { "proofDocuments.storageId": storageId },
    ],
  });

  if (claim?.attachmentStorageId === storageId) {
    return claim.attachmentUrl || await resolveAttachmentUrl(ctx, storageId, user.email);
  }

  const proof = Array.isArray(claim?.proofDocuments)
    ? claim.proofDocuments.find((doc) => doc?.storageId === storageId)
    : null;
  if (proof?.storageId) {
    return proof.url || await resolveAttachmentUrl(ctx, storageId, user.email);
  }

  const vendorDocument = await ctx.db.collection("vendorDocuments").findOne({ storageId });
  if (vendorDocument?.storageId) {
    return await resolveAttachmentUrl(ctx, storageId, user.email);
  }

  return await resolveAttachmentUrl(ctx, storageId, user.email);
}

async function getClaimAssetUrls(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
  if (!claim) return null;
  assertCanAccessClaim(user, claim);

  const quotationUrl = claim.attachmentR2Key
    ? await resolveAttachmentUrl(ctx, claim.attachmentR2Key, user.email)
    : claim.attachmentStorageId
      ? (claim.attachmentUrl || await resolveAttachmentUrl(ctx, claim.attachmentStorageId, user.email))
      : null;

  const proofs = Array.isArray(claim.proofDocuments)
    ? await Promise.all(claim.proofDocuments.map(async (doc) => ({
      fileName: doc.fileName,
      uploadedAt: doc.uploadedAt,
      url: doc.url
        || (doc.r2Key ? await resolveAttachmentUrl(ctx, doc.r2Key, user.email) : null)
        || (doc.storageId ? await resolveAttachmentUrl(ctx, doc.storageId, user.email) : null),
    })))
    : [];

  return {
    quotation: quotationUrl
      ? { fileName: claim.attachmentFileName || "Quotation", url: quotationUrl }
      : null,
    proofs,
    proofDocuments: proofs,
  };
}

async function listVendorDocuments(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  assertVendorManager(user);
  const vendor = await ctx.db.collection("vendors").findOne({ _id: args.vendorId });
  if (!vendor) return null;

  const documents = await ctx.db.collection("vendorDocuments").find({ vendorId: args.vendorId }).toArray();
  documents.sort((a, b) => {
    const statusRank = { CURRENT: 0, REPLACED: 1, REMOVED: 2 };
    const left = statusRank[a.status] ?? 99;
    const right = statusRank[b.status] ?? 99;
    if (left !== right) return left - right;
    return String(b.uploadedAt || b.createdAt || "").localeCompare(String(a.uploadedAt || a.createdAt || ""));
  });

  const currentDocumentsByType = {};
  for (const doc of documents) {
    if (doc.status === "CURRENT") {
      currentDocumentsByType[doc.documentType] = (currentDocumentsByType[doc.documentType] || 0) + 1;
    }
  }

  const documentsWithUrls = await Promise.all(documents.map(async (doc) => ({
    _id: doc._id,
    vendorId: doc.vendorId,
    documentType: doc.documentType,
    documentTypeLabel: getVendorDocumentTypeLabel(doc.documentType, doc.documentLabel),
    documentLabel: doc.documentLabel,
    fileName: doc.fileName,
    storageId: doc.storageId,
    status: doc.status,
    statusLabel: getVendorDocumentStatusLabel(doc.status),
    uploadedByUserId: doc.uploadedByUserId,
    uploadedByUserName: doc.uploadedByUserName,
    uploadedAt: doc.uploadedAt,
    replacedByDocumentId: doc.replacedByDocumentId,
    replacedByUserId: doc.replacedByUserId,
    replacedByUserName: doc.replacedByUserName,
    replacedAt: doc.replacedAt,
    removedByUserId: doc.removedByUserId,
    removedByUserName: doc.removedByUserName,
    removedAt: doc.removedAt,
    downloadUrl: doc.url || (doc.r2Key ? await resolveAttachmentUrl(ctx, doc.r2Key, user.email) : null) || (doc.storageId ? await resolveAttachmentUrl(ctx, doc.storageId, user.email) : null),
  })));

  return {
    vendor: {
      _id: vendor._id,
      code: vendor.code,
      name: vendor.name,
    },
    documents: documentsWithUrls,
    currentDocumentsByType,
  };
}

async function getClaim(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
  if (!claim) return null;
  assertCanAccessClaim(user, claim);
  const activeCycle = await ctx.db.collection("claimCycles").findOne({ claimId: claim._id, cycleNumber: claim.currentCycleNumber });
  return {
    ...claim,
    currentCycleRequestedAmount: activeCycle?.requestedAmount ?? claim.pendingAmount ?? claim.amount,
    delayReason: activeCycle?.delayReason,
    disposalTimeframeHours: activeCycle?.disposalTimeframeHours,
  };
}

async function getClaimCycles(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
  if (!claim) return [];
  assertCanAccessClaim(user, claim);
  return await ctx.db.collection("claimCycles").find({ claimId: args.claimId }).sort({ cycleNumber: 1 }).toArray();
}

async function mutateClaim(ctx, args, patchBuilder) {
  const user = await requireCurrentUser(ctx, args);
  const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
  if (!claim) throw notFound("Claim not found");
  assertCanAccessClaim(user, claim);
  const patch = await patchBuilder(user, claim);
  await ctx.db.collection("claims").updateOne(
    { _id: args.claimId },
    {
      $set: { ...patch.set, updatedAt: new Date().toISOString() },
      ...(patch.pushLog ? { $push: { logs: patch.pushLog } } : {}),
    },
  );
  const updatedClaim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
  if (updatedClaim) {
    await dashboardEngine.normalizeAndSyncDashboardState(ctx, claim, updatedClaim);
  }
  return { success: true, claimId: args.claimId };
}

async function createClaim(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  const now = new Date().toISOString();
  const id = new ObjectId().toHexString();
  const claim = {
    _id: id,
    userId: user._id,
    userName: user.name,
    amount: Number(args.amount ?? args.totalRequestedAmount ?? 0),
    totalRequestedAmount: Number(args.totalRequestedAmount ?? args.amount ?? 0),
    totalDisbursedAmount: 0,
    pendingAmount: Number(args.totalRequestedAmount ?? args.amount ?? 0),
    currentCycleNumber: 1,
    employeeBucket: "pending",
    status: "SUBMITTED",
    logs: [{
      stage: "USER",
      action: "SUBMIT",
      remarks: args.description || "",
      timestamp: now,
      actor: user.name,
    }],
    createdAt: now,
    ...args,
    _id: id,
  };
  await ctx.db.collection("claims").insertOne(claim);
  await ctx.db.collection("claimCycles").insertOne({
    _id: new ObjectId().toHexString(),
    claimId: id,
    cycleNumber: 1,
    openingPendingAmount: claim.totalRequestedAmount,
    requestedAmount: Number(args.paymentRequestType === "ADVANCE" ? args.requestedCycleAmount ?? claim.totalRequestedAmount : claim.totalRequestedAmount),
    status: "UNDER_REVIEW",
    initiatedByUserId: user._id,
    initiatedByName: user.name,
    createdAt: now,
    updatedAt: now,
  });
  await dashboardEngine.normalizeAndSyncDashboardState(ctx, null, claim);
  return id;
}

async function listUsers(ctx, args) {
  const filter = {};
  if (args.roleFilter && args.roleFilter !== "ALL") filter.role = args.roleFilter;
  if (args.statusFilter && args.statusFilter !== "ALL") filter.status = args.statusFilter;
  let users = await ctx.db.collection("users").find(filter).sort({ name: 1 }).toArray();
  if (args.searchQuery) users = users.filter((user) => matchesSearch(user, args.searchQuery));
  if (args.verticalFilter && args.verticalFilter !== "ALL") {
    users = users.filter((user) => Array.isArray(user.verticals) && user.verticals.includes(args.verticalFilter));
  }
  if (args.page || args.pageSize) {
    const { page, pageSize, skip } = pageArgs(args);
    return { items: users.slice(skip, skip + pageSize), total: users.length, page, pageSize };
  }
  return users;
}

function requiresVertical(role) {
  return role === "L1_ADMIN" || role === "L2_ADMIN";
}

function isVerticalAdminRole(role) {
  return role === "L1_ADMIN" || role === "L2_ADMIN";
}

function resolveVerticalAssignments(vertical, verticals) {
  const selected = Array.isArray(verticals) && verticals.length > 0
    ? verticals
    : (vertical ? [vertical] : []);
  return Array.from(new Set(selected));
}

function validateRoleVerticalCombination(role, verticals) {
  if (requiresVertical(role) && verticals.length === 0) {
    throw new Error("Select at least one vertical for L1 and L2 admins");
  }
  if (!requiresVertical(role) && verticals.length > 0) {
    throw new Error("Verticals can only be assigned to L1 or L2 admins");
  }
}

async function assertVerticalRoleSlotsAvailable(ctx, role, verticals, excludingEmail) {
  if (verticals.length === 0) return;
  const users = await ctx.db.collection("users").find({ role }).toArray();
  const conflicts = [];
  for (const vertical of verticals) {
    const assigned = users.find((user) =>
      (user.status || "active") === "active" &&
      Array.isArray(user.verticals) &&
      user.verticals.includes(vertical) &&
      user.email !== excludingEmail
    );
    if (assigned) {
      conflicts.push({ vertical, email: assigned.email });
    }
  }
  if (conflicts.length > 0) {
    const details = conflicts.map((c) => `${c.vertical} (${c.email})`).join(", ");
    throw new Error(`These vertical(s) already have an active ${role}: ${details}`);
  }
}

async function assertSingleActiveL3(ctx, excludingEmail) {
  const users = await ctx.db.collection("users").find({ role: "L3_ADMIN" }).toArray();
  const existing = users.find((user) => (user.status || "active") === "active" && user.email !== excludingEmail);
  if (existing) {
    throw new Error(`Only one active L3 - CEO is allowed. Existing: ${existing.email}`);
  }
}

async function assertSingleActiveCeo(ctx, excludingEmail) {
  const users = await ctx.db.collection("users").find({ role: "CEO_ADMIN" }).toArray();
  const existing = users.find((user) => (user.status || "active") === "active" && user.email !== excludingEmail);
  if (existing) {
    throw new Error(`Only one active CEO Admin is allowed. Existing: ${existing.email}`);
  }
}

async function createUser(ctx, args) {
  const current = await requireCurrentUser(ctx, args);
  assertRoleManager(current);
  const now = Date.now();
  const normalizedEmail = normalizeEmail(args.email);
  const trimmedName = args.name?.trim?.() ?? "";
  if (!trimmedName) {
    throw new Error("Name cannot be empty");
  }
  const assignedVerticals = resolveVerticalAssignments(args.vertical, args.verticals);
  validateRoleVerticalCombination(args.role, assignedVerticals);
  if (args.role === "L3_ADMIN") {
    await assertSingleActiveL3(ctx);
  }
  if (args.role === "CEO_ADMIN") {
    await assertSingleActiveCeo(ctx);
  }
  if (isVerticalAdminRole(args.role)) {
    await assertVerticalRoleSlotsAvailable(ctx, args.role, assignedVerticals);
  }
  const id = new ObjectId().toHexString();
  const user = {
    _id: id,
    name: trimmedName,
    email: normalizedEmail,
    role: args.role || "USER",
    verticals: requiresVertical(args.role) ? assignedVerticals : undefined,
    canManageVendors: args.canManageVendors ?? false,
    canViewMonitoring: args.canViewMonitoring ?? false,
    status: args.status || "active",
    assignedBy: current.name,
    assignedAt: now,
  };
  await ctx.db.collection("users").insertOne(user);
  const reason = assignedVerticals.length > 0
    ? `New user created | Verticals: ${assignedVerticals.join(", ")}`
    : "New user created";
  await ctx.db.collection("roleAuditLog").insertOne({
    _id: new ObjectId().toHexString(),
    userEmail: normalizedEmail,
    userName: trimmedName,
    previousRole: "NONE",
    newRole: args.role,
    changeType: "CREATE",
    newName: trimmedName,
    changedBy: current.name,
    changedByEmail: current.email,
    reason,
    timestamp: now,
  });
  return id;
}

async function assignRole(ctx, args) {
  const current = await requireCurrentUser(ctx, args);
  assertRoleManager(current);
  const targetUserId = args.userId || null;
  const targetUserEmail = args.userEmail ? normalizeEmail(args.userEmail) : null;
  const user = targetUserId
    ? await ctx.db.collection("users").findOne({ _id: targetUserId })
    : await findUserByEmailPreferActive(ctx.db, targetUserEmail);
  if (!user) throw notFound("User not found");
  const nextRole = args.role || args.newRole || user.role;
  const nextNameInput = args.name ?? args.newName ?? user.name;
  const trimmedNextName = typeof nextNameInput === "string" ? nextNameInput.trim() : "";
  if ((args.name !== undefined || args.newName !== undefined) && trimmedNextName.length === 0) {
    throw new Error("Name cannot be empty");
  }
  const nextName = trimmedNextName || user.name;
  const nextVerticals = resolveVerticalAssignments(args.vertical, args.verticals);
  validateRoleVerticalCombination(nextRole, nextVerticals);
  if (nextRole === "L3_ADMIN") {
    await assertSingleActiveL3(ctx, user.email);
  }
  if (nextRole === "CEO_ADMIN") {
    await assertSingleActiveCeo(ctx, user.email);
  }
  if (isVerticalAdminRole(nextRole)) {
    await assertVerticalRoleSlotsAvailable(ctx, nextRole, nextVerticals, user.email);
  }
  const hasRoleChange = nextRole !== user.role;
  const hasNameChange = args.name !== undefined || args.newName !== undefined ? nextName !== user.name : false;
  const hasVendorAccessChange = args.canManageVendors !== undefined && Boolean(user.canManageVendors) !== args.canManageVendors;
  const hasMonitoringAccessChange = args.canViewMonitoring !== undefined && Boolean(user.canViewMonitoring) !== args.canViewMonitoring;
  const hasVerticalChange = args.vertical !== undefined || args.verticals !== undefined;
  const patch = {
    ...(hasRoleChange ? {
      role: nextRole,
      assignedBy: current.name,
      assignedAt: Date.now(),
      status: user.status || "active",
    } : {}),
    ...((hasRoleChange || hasVerticalChange) ? {
      verticals: requiresVertical(nextRole) ? nextVerticals : undefined,
    } : {}),
    ...(hasNameChange ? { name: nextName } : {}),
    ...(hasVendorAccessChange ? { canManageVendors: args.canManageVendors } : {}),
    ...(hasMonitoringAccessChange ? { canViewMonitoring: args.canViewMonitoring } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
  };
  if (Object.keys(patch).length > 0) {
    await ctx.db.collection("users").updateOne({ _id: user._id }, { $set: patch });
  }
  await ctx.db.collection("roleAuditLog").insertOne({
    _id: new ObjectId().toHexString(),
    userEmail: user.email,
    userName: nextName,
    previousRole: user.role,
    newRole: nextRole,
    changeType: hasRoleChange
      ? (hasNameChange ? "ROLE_AND_NAME_CHANGE" : "ROLE_CHANGE")
      : (hasNameChange ? "NAME_CHANGE" : undefined),
    previousName: hasNameChange ? user.name : undefined,
    newName: hasNameChange ? nextName : undefined,
    changedBy: current.name,
    changedByEmail: current.email,
    reason: args.reason
      ? `${args.reason}${nextVerticals.length > 0 ? ` | Verticals: ${nextVerticals.join(", ")}` : ""}`
      : nextVerticals.length > 0
        ? `Verticals: ${nextVerticals.join(", ")}`
        : undefined,
    timestamp: Date.now(),
  });
  return { success: true };
}

async function listVendors(ctx, args) {
  await requireCurrentUser(ctx, args);
  const filter = {};
  if (args.status && args.status !== "ALL") filter.status = args.status;
  let vendors = await ctx.db.collection("vendors").find(filter).sort({ normalizedName: 1, name: 1 }).toArray();
  vendors = vendors.filter((vendor) => matchesSearch(vendor, args.searchQuery || args.search));
  if (args.page || args.pageSize) {
    const { page, pageSize, skip } = pageArgs(args);
    return { items: vendors.slice(skip, skip + pageSize), total: vendors.length, page, pageSize };
  }
  return vendors.slice(0, Math.max(1, Math.min(50, Number(args.limit || 50))));
}

async function createVendor(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  assertVendorManager(user);
  const now = new Date().toISOString();
  const id = new ObjectId().toHexString();
  const sequence = await ctx.db.collection("vendorSequenceCounters").findOneAndUpdate(
    { key: "global" },
    { $inc: { nextSequence: 1 }, $set: { updatedAt: now } },
    { upsert: true, returnDocument: "before" },
  );
  const nextSequence = sequence?.nextSequence ?? 1;
  const code = args.code || `BKT/VND/${String(nextSequence).padStart(6, "0")}`;
  const vendor = {
    _id: id,
    ...args,
    code,
    normalizedCode: normalizeText(code),
    normalizedName: normalizeText(args.name),
    normalizedOfficialEmail: normalizeEmail(args.officialEmail),
    normalizedGstNumber: normalizeTax(args.gstNumber),
    normalizedPanNumber: normalizeTax(args.panNumber),
    normalizedContactPersonName: normalizeText(args.contactPersonName),
    normalizedMobileNumber: normalizeText(args.mobileNumber),
    normalizedContactEmail: normalizeEmail(args.contactEmail),
    status: args.status || "active",
    createdByUserId: user._id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.db.collection("vendors").insertOne(vendor);
  return id;
}

async function analyticsFromClaims(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const page = await listClaims(ctx, args);
  const summary = await summarizeClaims(page.items);
  return { ...summary, items: page.items, page: page.page, pageSize: page.pageSize, total: page.total };
}

async function getClaimsOverview(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const result = await dashboardEngine.computeClaimsOverview(ctx, args);
  return result.result;
}

async function getClaimsTimeSeries(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const result = await dashboardEngine.computeClaimsTimeSeries(ctx, args);
  return result.result;
}

async function getEmployeeStatistics(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const result = await computeEmployeeStatisticsRows(ctx, args.startDate, args.endDate);
  return result.items;
}

async function getEmployeeStatisticsPage(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const result = await computeEmployeeStatisticsRows(ctx, args.startDate, args.endDate);
  const { page, pageSize, skip } = pageArgs(args);
  return {
    items: result.items.slice(skip, skip + pageSize),
    total: result.items.length,
    page,
    pageSize,
  };
}

async function getAdminPerformance(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const result = await computeAdminPerformanceRows(ctx, args.startDate, args.endDate);
  return result.items;
}

async function getAdminPerformancePage(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const result = await computeAdminPerformanceRows(ctx, args.startDate, args.endDate);
  const { page, pageSize, skip } = pageArgs(args);
  return {
    items: result.items.slice(skip, skip + pageSize),
    total: result.items.length,
    page,
    pageSize,
  };
}

function mapDetailedClaimRow(claim) {
  return {
    id: claim._id,
    userId: claim.userId,
    userName: claim.userName,
    suggestedByEmployee: claim.suggestedByEmployee,
    title: claim.projectTitle,
    companyVertical: claim.companyVertical,
    category: claim.category,
    purpose: claim.purpose,
    amount: claim.amount,
    paymentMode: claim.paymentMode,
    description: claim.description,
    date: claim.date,
    status: claim.status,
    createdAt: claim.createdAt,
    currentCycleNumber: claim.currentCycleNumber ?? 1,
    totalRequestedAmount: Number(claim.totalRequestedAmount ?? claim.amount ?? 0),
    totalDisbursedAmount: Number(claim.totalDisbursedAmount ?? 0),
    pendingAmount: Number(claim.pendingAmount ?? Math.max(0, Number(claim.totalRequestedAmount ?? claim.amount ?? 0) - Number(claim.totalDisbursedAmount ?? 0))),
    attachmentStorageId: claim.attachmentStorageId,
    attachmentR2Key: claim.attachmentR2Key,
    attachmentFileName: claim.attachmentFileName,
    proofDocuments: claim.proofDocuments || [],
    vendorName: claim.vendorName,
    vendorCode: claim.vendorCode,
    vendorOfficialEmail: claim.vendorOfficialEmail,
    vendorPhone: claim.vendorPhone,
    vendorContactPersonName: claim.vendorContactPersonName,
    vendorContactEmail: claim.vendorContactEmail,
    vendorPan: claim.vendorPan,
    vendorAddress: claim.vendorAddress,
    billingAddress: claim.billingAddress,
    shippingAddress: claim.shippingAddress,
    vendorGstin: claim.vendorGstin,
    costType: claim.costType,
    bankAccountHolderName: claim.bankAccountHolderName,
    bankAccountNumber: claim.bankAccountNumber,
    bankName: claim.bankName,
    bankBranch: claim.bankBranch,
    bankIfscCode: claim.bankIfscCode,
    employeeReceivedAt: claim.employeeReceivedAt,
    proofSubmittedAt: claim.proofSubmittedAt,
  };
}

function getMonthlyBreakdownFromClaims(claims) {
  const buckets = new Map();
  for (const claim of claims) {
    const date = String(claim.date || claim.createdAt || "").slice(0, 7);
    if (!date) continue;
    const current = buckets.get(date) || { month: date, count: 0, amount: 0 };
    current.count += 1;
    current.amount += Number(claim.amount ?? claim.totalRequestedAmount ?? 0);
    buckets.set(date, current);
  }
  return Array.from(buckets.values()).sort((a, b) => a.month.localeCompare(b.month));
}

async function getUserDetailedStats(ctx, args) {
  const viewer = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(viewer)) throw forbidden("You do not have permission to view analytics");
  const user = await ctx.db.collection("users").findOne({ _id: args.userId });
  if (!user) return null;

  const claims = await ctx.db.collection("claims").find({ userId: args.userId }).toArray();
  const filteredClaims = claims.filter((claim) => {
    if (args.startDate && claim.date < args.startDate) return false;
    if (args.endDate && claim.date > args.endDate) return false;
    return true;
  }).sort((a, b) => String(b._creationTime || b.createdAt || "").localeCompare(String(a._creationTime || a.createdAt || "")));

  if (user.role === "USER") {
    const totalClaims = filteredClaims.length;
    const totalAmount = filteredClaims.reduce((sum, claim) => sum + Number(claim.amount ?? claim.totalRequestedAmount ?? 0), 0);
    const approvedClaims = filteredClaims.filter((claim) => ["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"].includes(claim.status)).length;
    const rejectedClaims = filteredClaims.filter((claim) => claim.status === "REJECTED").length;
    const pendingClaims = totalClaims - approvedClaims - rejectedClaims;
    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      totalClaims,
      totalAmount,
      approvedClaims,
      rejectedClaims,
      pendingClaims,
      claims: filteredClaims.map((claim) => ({
        id: claim._id,
        title: claim.projectTitle,
        amount: claim.amount,
        date: claim.date,
        status: claim.status,
        description: claim.description,
      })),
      monthlyBreakdown: getMonthlyBreakdownFromClaims(filteredClaims),
    };
  }

  const processedClaims = await ctx.db.collection("claims").find({
    logs: { $elemMatch: { actor: user.name } },
  }).toArray();
  const adminClaims = processedClaims.filter((claim) => {
    if (args.startDate && claim.date < args.startDate) return false;
    if (args.endDate && claim.date > args.endDate) return false;
    return true;
  });
  const totalProcessed = adminClaims.length;
  const approved = adminClaims.filter((claim) => ["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED", "APPROVED_L3", "APPROVED_L2", "APPROVED_L1"].includes(claim.status)).length;
  const rejected = adminClaims.filter((claim) => claim.status === "REJECTED").length;
  return {
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    totalProcessed,
    approved,
    rejected,
    approvalRate: totalProcessed > 0 ? (approved / totalProcessed) * 100 : 0,
    recentActivity: adminClaims.slice(0, 10).map((claim) => ({
      id: claim._id,
      title: claim.projectTitle,
      amount: claim.amount,
      userName: claim.userName,
      status: claim.status,
      action: claim.logs.find((log) => log.actor === user.name)?.action || "UNKNOWN",
      date: claim.logs.find((log) => log.actor === user.name)?.timestamp || claim.createdAt,
    })),
    monthlyBreakdown: getMonthlyBreakdownFromClaims(adminClaims),
  };
}

async function getUserDetailedClaimsPage(ctx, args) {
  const viewer = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(viewer)) throw forbidden("You do not have permission to view analytics");
  const user = await ctx.db.collection("users").findOne({ _id: args.userId });
  if (!user || user.role !== "USER") {
    return { items: [], total: 0, page: 1, pageSize: args.pageSize ?? 10 };
  }
  const allClaims = await ctx.db.collection("claims").find({ userId: args.userId }).toArray();
  const userClaims = allClaims.filter((claim) => {
    if (args.startDate && claim.date < args.startDate) return false;
    if (args.endDate && claim.date > args.endDate) return false;
    return true;
  }).sort((a, b) => String(b._creationTime || b.createdAt || "").localeCompare(String(a._creationTime || a.createdAt || "")));
  const page = Math.max(1, Number(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(args.pageSize ?? 10)));
  const start = (page - 1) * pageSize;
  return {
    items: userClaims.slice(start, start + pageSize).map((claim) => ({
      id: claim._id,
      title: claim.projectTitle,
      amount: claim.amount,
      date: claim.date,
      status: claim.status,
      description: claim.description,
    })),
    total: userClaims.length,
    page,
    pageSize,
  };
}

async function getUserDetailedActivityPage(ctx, args) {
  const viewer = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(viewer)) throw forbidden("You do not have permission to view analytics");
  const user = await ctx.db.collection("users").findOne({ _id: args.userId });
  if (!user || user.role === "USER") {
    return { items: [], total: 0, page: 1, pageSize: args.pageSize ?? 10 };
  }
  const allClaims = await ctx.db.collection("claims").find({}).toArray();
  const processedClaims = allClaims.filter((claim) => claim.logs?.some((log) => log.actor === user.name));
  const filteredClaims = processedClaims.filter((claim) => {
    if (args.startDate && claim.date < args.startDate) return false;
    if (args.endDate && claim.date > args.endDate) return false;
    return true;
  }).sort((a, b) => String(b._creationTime || b.createdAt || "").localeCompare(String(a._creationTime || a.createdAt || "")));
  const page = Math.max(1, Number(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(args.pageSize ?? 10)));
  const start = (page - 1) * pageSize;
  return {
    items: filteredClaims.slice(start, start + pageSize).map((claim) => ({
      id: claim._id,
      title: claim.projectTitle,
      amount: claim.amount,
      userName: claim.userName,
      status: claim.status,
      action: claim.logs.find((log) => log.actor === user.name)?.action || "UNKNOWN",
      date: claim.logs.find((log) => log.actor === user.name)?.timestamp || claim.createdAt,
    })),
    total: filteredClaims.length,
    page,
    pageSize,
  };
}

async function getAllClaimsDetailed(ctx, args) {
  const user = await requireCurrentUser(ctx, args);
  if (!canViewAnalytics(user)) throw forbidden("You do not have permission to view analytics");
  const statusFilter = args.statusFilter && args.statusFilter !== "all" ? args.statusFilter : undefined;
  const companyVertical = args.companyVertical && args.companyVertical !== "all" ? args.companyVertical : undefined;
  const claims = await ctx.db.collection("claims").find({}).toArray();
  const filtered = claims.filter((claim) => {
    if (args.startDate && claim.date < args.startDate) return false;
    if (args.endDate && claim.date > args.endDate) return false;
    if (statusFilter && claim.status !== statusFilter) return false;
    if (companyVertical && claim.companyVertical !== companyVertical) return false;
    return true;
  });
  const sorted = filtered.sort((a, b) => String(b._creationTime || b.createdAt || "").localeCompare(String(a._creationTime || a.createdAt || "")));
  const rows = sorted.map(mapDetailedClaimRow);
  const counts = {
    pending: sorted.filter((claim) => !["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED", "REJECTED"].includes(claim.status)).length,
    approved: sorted.filter((claim) => ["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"].includes(claim.status)).length,
    rejected: sorted.filter((claim) => claim.status === "REJECTED").length,
  };
  return { items: rows, total: rows.length, counts };
}

async function getAllClaimsDetailedPage(ctx, args) {
  const detailed = await getAllClaimsDetailed(ctx, args);
  const page = Math.max(1, Number(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(args.pageSize ?? 10)));
  const start = (page - 1) * pageSize;
  return {
    items: detailed.items.slice(start, start + pageSize),
    total: detailed.total,
    counts: detailed.counts,
    page,
    pageSize,
  };
}

export const handlers = {
  "app.getReleaseInfo": async (ctx) => ({
    backendVersion: ctx.config.releaseVersion,
    version: ctx.config.releaseVersion,
    backend: "mongo-test",
    storage: "test-convex",
    checkedAt: Date.now(),
  }),
  "users.getCurrentUser": getCurrentUser,
  "users.listUsers": listUsers,
  "users.listAllUsers": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertRoleManager(user);
    return await listUsers(ctx, args);
  },
  "users.checkEmailRegistration": async (ctx, args) => {
    const user = await findUserByEmailPreferActive(ctx.db, args.email);
    return { exists: Boolean(user), status: user ? user.status || "active" : null };
  },
  "users.searchEmployees": async (ctx, args) => {
    await requireCurrentUser(ctx, args);
    const users = await listUsers(ctx, { searchQuery: args.searchQuery });
    return users.filter((user) => user.role === "USER").slice(0, args.limit || 8).map((user) => ({ _id: user._id, name: user.name, email: user.email }));
  },
  "users.getUserById": async (ctx, args) => await ctx.db.collection("users").findOne({ _id: args.userId }),
  "users.getUserByEmail": async (ctx, args) => await findUserByEmailPreferActive(ctx.db, args.email),
  "users.getRoleAuditLog": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertRoleManager(user);
    return await ctx.db.collection("roleAuditLog").find({}).sort({ timestamp: -1 }).limit(args.limit || 100).toArray();
  },
  "users.createUser": createUser,
  "users.assignRole": assignRole,
  "users.deleteUser": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertRoleManager(user);
    const targetUser = args.userId
      ? await ctx.db.collection("users").findOne({ _id: args.userId })
      : await findUserByEmailPreferActive(ctx.db, args.userEmail);
    if (!targetUser) throw notFound("User not found");
    if (String(targetUser.email).toLowerCase() === user.email) {
      throw forbidden("Cannot delete your own account");
    }
    await ctx.db.collection("users").deleteOne({ _id: targetUser._id });
    return { success: true };
  },

  "claims.getClaim": getClaim,
  "claims.getClaimCycles": getClaimCycles,
  "claims.listClaims": async (ctx, args) => (await listClaims(ctx, args)).items,
  "claims.getAllClaims": async (ctx, args) => (await listClaims(ctx, { ...args, pageSize: 100 })).items,
  "claims.getEmployeeClaimsPage": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    return await listClaims(ctx, args, { userId: user._id });
  },
  "claims.getEmployeeDashboardSummary": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    const claims = await ctx.db.collection("claims").find({ userId: user._id }).toArray();
    return await summarizeClaims(claims);
  },
  "claims.getAdminClaimsPage": getAdminClaimsPage,
  "claims.getAdminDashboardSummary": getAdminDashboardSummary,
  "claims.getAdminPaymentsSummary": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    if (!canViewFinance(user.role)) throw forbidden();
    const claims = await ctx.db.collection("claims").find({}).sort({ date: -1, createdAt: -1, _creationTime: -1 }).toArray();
    const filtered = filterFinanceDashboardClaims(getFinanceCandidateClaims(claims), args);
    return summarizeFinanceDashboardClaims(filtered);
  },
  "claims.getAdminActionRequiredSummary": getAdminActionRequiredSummary,
  "claims.getDeleteClaimsPage": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertRoleManager(user);
    return await listClaims(ctx, args);
  },
  "claims.getFinanceExportData": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    if (!canViewFinance(user.role)) throw forbidden();
    const claims = await ctx.db.collection("claims").find({}).sort({ date: -1, createdAt: -1, _creationTime: -1 }).toArray();
    const filtered = filterFinanceDashboardClaims(getFinanceCandidateClaims(claims), args);
    return { items: await Promise.all(filtered.map((claim) => buildFinanceExportItem(ctx, claim))) };
  },
  "claims.getVendorFinancialSnapshot": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    if (!canViewVendorLedger(user)) throw forbidden();

    const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
    if (!claim || !claim.vendorId) return null;

    const vendorClaims = await ctx.db.collection("claims").find({ vendorId: claim.vendorId }).toArray();
    const currentInvoiceAmount = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
    const currentDisbursedAmount = Number(claim.totalDisbursedAmount ?? 0);

    let totalRequestedSoFar = 0;
    let totalPaidSoFar = 0;
    for (const vendorClaim of vendorClaims) {
      totalRequestedSoFar += Number(vendorClaim.totalRequestedAmount ?? vendorClaim.amount ?? 0);
      totalPaidSoFar += Number(vendorClaim.totalDisbursedAmount ?? 0);
    }

    return {
      currentInvoiceAmount,
      totalPreviousPaidToVendor: Math.max(0, totalPaidSoFar - currentDisbursedAmount),
      totalRequestedSoFar,
      totalPaidSoFar,
      totalPaidIncludingThisInvoice: totalPaidSoFar + currentInvoiceAmount,
      outstandingAmount: Math.max(0, totalRequestedSoFar - totalPaidSoFar),
    };
  },
  "claims.generateAttachmentUploadUrl": async (ctx, args) => buildStorageUploadProxyUrl(ctx, "claims.generateAttachmentUploadUrl", args),
  "claims.getAttachmentUrl": getAttachmentUrl,
  "claims.getClaimAssetUrls": getClaimAssetUrls,
  "claims.createClaim": createClaim,
  "claims.resubmitClaim": async (ctx, args) => await mutateClaim(ctx, args, (user, claim) => {
    const now = new Date().toISOString();
    const totalRequestedAmount = Number(args.totalRequestedAmount ?? args.amount ?? claim.totalRequestedAmount ?? claim.amount ?? 0);
    const pendingAmount = Math.max(0, totalRequestedAmount - Number(claim.totalDisbursedAmount || 0));
    return {
      set: {
        ...args,
        totalRequestedAmount,
        pendingAmount,
        employeeBucket: "pending",
        status: "SUBMITTED",
      },
      pushLog: {
        stage: user.role || "USER",
        action: "REPLY",
        remarks: args.remarks || args.reason || "",
        timestamp: now,
        actor: user.name || user.email || "Unknown",
        attachments: args.attachments,
      },
    };
  }),
  "claims.approveClaim": async (ctx, args) => await mutateClaim(ctx, args, (user, claim) => {
    const { log } = buildClaimPatch("APPROVE", user, args);
    const nextStatusMap = {
      SUBMITTED: user.role === "L2_ADMIN" && claim.category === "EMERGENCY" ? "APPROVED_L2" : "APPROVED_L1",
      APPROVED_L1: "APPROVED_L2",
      APPROVED_L2: "APPROVED_L3",
      APPROVED_L3: "DISBURSED",
      RETURNED_TO_EMPLOYEE: "SUBMITTED",
      RETURNED_TO_L1: "APPROVED_L1",
      RETURNED_TO_L2: "APPROVED_L2",
      RETURNED_TO_L3: "APPROVED_L3",
    };
    const nextStatus = args.status || nextStatusMap[claim.status] || (user.role === "L1_ADMIN" ? "APPROVED_L1" : user.role === "L2_ADMIN" ? "APPROVED_L2" : "APPROVED_L3");
    return { set: { status: nextStatus, employeeBucket: "pending" }, pushLog: log };
  }),
  "claims.rejectClaim": async (ctx, args) => await mutateClaim(ctx, args, (user) => ({ set: { status: "REJECTED", employeeBucket: "rejected" }, pushLog: buildClaimPatch("REJECT", user, args).log })),
  "claims.sendBackClaim": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
    if (!claim) throw notFound("Claim not found");
    assertCanAccessClaim(user, claim);

    const reviewerRole = getReviewerRoleForClaim(claim.status, claim.category);
    if (!reviewerRole || reviewerRole === "USER") {
      throw forbidden("Claim cannot be reviewed in its current state");
    }
    if (user.role !== reviewerRole && user.role !== "CEO_ADMIN") {
      throw forbidden("You do not have permission to review this claim");
    }

    const targetRole = args.targetRole || args.target;
    if (!targetRole) throw badRequest("targetRole is required");

    const effectiveActorRole = user.role === "CEO_ADMIN" ? reviewerRole : user.role;
    const allowedTargets = getAllowedReturnTargets(effectiveActorRole, claim.category);
    if (!allowedTargets.includes(targetRole)) {
      throw forbidden("Invalid send-back target for your role");
    }

    const nextStatus = args.targetStatus || getReturnStatusForTarget(targetRole);
    if (!nextStatus) throw badRequest("Invalid send-back target");

    const now = new Date().toISOString();
    const log = {
      stage: getStageNameWithCeoOverride(user.role, claim),
      action: "RETURN",
      remarks: args.remarks || args.reason || "",
      timestamp: now,
      actor: user.name || user.email || "Unknown",
      target: getReturnTargetLabel(targetRole),
      attachments: args.attachments,
    };

    const activeCycle = await ctx.db.collection("claimCycles").findOne({ claimId: claim._id, cycleNumber: claim.currentCycleNumber });
    const nextCycleStatus = "RETURNED";
    if (activeCycle) {
      await ctx.db.collection("claimCycles").updateOne(
        { _id: activeCycle._id },
        {
          $set: {
            status: nextCycleStatus,
            closingPendingAmount: Number(claim.pendingAmount ?? claim.amount ?? 0),
            remarks: args.remarks || "Returned for rework",
            updatedAt: now,
          },
        },
      );
    }

    await ctx.db.collection("claims").updateOne(
      { _id: claim._id },
      {
        $set: { status: nextStatus, employeeBucket: "action_required", updatedAt: now },
        $push: { logs: log },
      },
    );

    return { success: true, claimId: claim._id, status: nextStatus };
  },
  "claims.replyClaim": async (ctx, args) => await mutateClaim(ctx, args, (user) => ({ set: { status: args.status || "SUBMITTED", employeeBucket: "pending" }, pushLog: buildClaimPatch("REPLY", user, args).log })),
  "claims.setDelayActionPlan": async (ctx, args) => await mutateClaim(ctx, args, (user) => ({ set: { delayActionPlan: args.delayActionPlan }, pushLog: buildClaimPatch("DELAY_UPDATE", user, args).log })),
  "claims.markClaimReceived": async (ctx, args) => await mutateClaim(ctx, args, (user, claim) => {
    const nextClaim = { ...claim, employeeReceivedAt: new Date().toISOString() };
    return { set: { employeeReceivedAt: nextClaim.employeeReceivedAt, employeeBucket: deriveEmployeeBucket(nextClaim) }, pushLog: buildClaimPatch("MARK_RECEIVED", user, args).log };
  }),
  "claims.submitProofDocuments": async (ctx, args) => await mutateClaim(ctx, args, (user, claim) => {
    const nextClaim = {
      ...claim,
      proofSubmittedAt: new Date().toISOString(),
      proofDocuments: [...(claim.proofDocuments || []), ...(args.proofDocuments || args.documents || [])],
    };
    return { set: { proofSubmittedAt: nextClaim.proofSubmittedAt, proofDocuments: nextClaim.proofDocuments, employeeBucket: deriveEmployeeBucket(nextClaim) }, pushLog: buildClaimPatch("SUBMIT_PROOF", user, args).log };
  }),
  "claims.requestNextCyclePayment": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
    if (!claim) throw notFound("Claim not found");
    assertCanAccessClaim(user, claim);
    if (user.role !== "USER") throw forbidden("Only employees can request the next payment cycle");
    if (claim.userId !== user._id) throw forbidden("Only the claim owner can request the next payment cycle");
    if (claim.status !== "PARTIALLY_DISBURSED") throw badRequest("Next cycle can only be requested after partial disbursement");

    const financial = deriveVendorClaimFinancials(claim);
    const requestedAmount = Number(args.requestedAmount ?? 0);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      throw badRequest("Requested amount must be greater than zero");
    }
    if (requestedAmount > financial.pendingAmount) {
      throw badRequest("Requested amount cannot exceed pending balance");
    }

    const existingOpenCycle = await ctx.db.collection("claimCycles").findOne({
      claimId: claim._id,
      cycleNumber: claim.currentCycleNumber,
      status: "UNDER_REVIEW",
    });
    if (existingOpenCycle) {
      throw badRequest("Current cycle must be settled before requesting a new cycle");
    }

    const now = new Date().toISOString();
    const nextCycleNumber = (claim.currentCycleNumber || 1) + 1;
    await ctx.db.collection("claimCycles").insertOne({
      _id: new ObjectId().toHexString(),
      claimId: claim._id,
      cycleNumber: nextCycleNumber,
      openingPendingAmount: financial.pendingAmount,
      requestedAmount,
      approvedAmount: 0,
      disbursedAmount: 0,
      closingPendingAmount: financial.pendingAmount,
      status: "UNDER_REVIEW",
      initiatedByUserId: user._id,
      initiatedByName: user.name,
      remarks: args.remarks || "Employee requested next cycle payment",
      createdAt: now,
      updatedAt: now,
    });

    const patch = {
      set: {
        status: "SUBMITTED",
        currentCycleNumber: nextCycleNumber,
        employeeBucket: "pending",
      },
      pushLog: buildClaimPatch("SUBMIT", user, args).log,
    };

    await ctx.db.collection("claims").updateOne(
      { _id: claim._id },
      {
        $set: { ...patch.set, updatedAt: now },
        $push: { logs: patch.pushLog },
      },
    );

    const updatedClaim = await ctx.db.collection("claims").findOne({ _id: claim._id });
    if (!updatedClaim) throw notFound("Claim not found after next cycle request");
    await dashboardEngine.normalizeAndSyncDashboardState(ctx, claim, updatedClaim);

    return { success: true, claimId: claim._id, status: "SUBMITTED" };
  },
  "claims.disburseClaimAmount": async (ctx, args) => await mutateClaim(ctx, args, (user, claim) => {
    const paid = Number(
      args.disbursementAmount
      ?? args.disbursedAmount
      ?? args.amount
      ?? claim.pendingAmount
      ?? claim.amount
      ?? 0,
    );
    const totalPaid = Number(claim.totalDisbursedAmount || 0) + paid;
    const totalRequested = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
    const pending = Math.max(0, totalRequested - totalPaid);
    const nextStatus = pending > 0 ? "PARTIALLY_DISBURSED" : "DISBURSED";
    const nextClaim = {
      ...claim,
      totalDisbursedAmount: totalPaid,
      pendingAmount: pending,
      status: nextStatus,
      disbursedAt: new Date().toISOString(),
      employeeReceivedAt: claim.employeeReceivedAt,
      proofSubmittedAt: claim.proofSubmittedAt,
    };
    return { set: { totalDisbursedAmount: totalPaid, pendingAmount: pending, status: nextStatus, employeeBucket: deriveEmployeeBucket(nextClaim), disbursedAt: nextClaim.disbursedAt }, pushLog: buildClaimPatch("APPROVE", user, args).log };
  }),
  "claims.closeClaimByL4": async (ctx, args) => await mutateClaim(ctx, args, (user, claim) => {
    const nextClaim = {
      ...claim,
      status: "COMPLETED",
      isClosedByL4: true,
      closedAt: new Date().toISOString(),
    };
    return { set: { status: "COMPLETED", employeeBucket: deriveEmployeeBucket(nextClaim), isClosedByL4: true, closedAt: nextClaim.closedAt }, pushLog: buildClaimPatch("APPROVE", user, args).log };
  }),
  "claims.deleteClaim": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertRoleManager(user);
    const claim = await ctx.db.collection("claims").findOne({ _id: args.claimId });
    if (!claim) throw notFound("Claim not found");
    await ctx.db.collection("claimDeleteAuditLog").insertOne({ _id: new ObjectId().toHexString(), claimId: claim._id, claimSnapshot: claim, deletedByUserId: user._id, deletedByName: user.name, deletedByEmail: user.email, deletedAt: new Date().toISOString(), reason: args.reason });
    await dashboardEngine.normalizeAndSyncDashboardState(ctx, claim, null);
    await ctx.db.collection("claims").deleteOne({ _id: args.claimId });
    return { success: true };
  },

  "vendors.listVendors": listVendors,
  "vendors.searchVendors": listVendors,
  "vendors.searchRegisteredVendors": listVendors,
  "vendors.searchRegisteredVendorsPage": listVendors,
  "vendors.listVendorsForImport": listVendors,
  "vendors.generateVendorDocumentUploadUrl": async (ctx, args) => buildStorageUploadProxyUrl(ctx, "claims.generateAttachmentUploadUrl", args),
  "vendors.createVendor": createVendor,
  "vendors.updateVendor": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertVendorManager(user);
    const vendorId = args.vendorId || args.id;
    await ctx.db.collection("vendors").updateOne({ _id: vendorId }, { $set: { ...args, updatedByUserId: user._id, updatedAt: new Date().toISOString() } });
    return { success: true };
  },
  "vendors.setVendorStatus": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertVendorManager(user);
    await ctx.db.collection("vendors").updateOne({ _id: args.vendorId }, { $set: { status: args.status, updatedByUserId: user._id, updatedAt: new Date().toISOString() } });
    return { success: true };
  },
  "vendors.listVendorDocuments": listVendorDocuments,
  "vendors.createVendorDocument": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertVendorManager(user);
    const doc = { _id: new ObjectId().toHexString(), ...args, status: "CURRENT", uploadedByUserId: user._id, uploadedAt: new Date().toISOString() };
    await ctx.db.collection("vendorDocuments").insertOne(doc);
    return doc._id;
  },
  "vendors.deactivateVendorDocument": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    assertVendorManager(user);
    await ctx.db.collection("vendorDocuments").updateOne({ _id: args.documentId }, { $set: { status: args.status || "REMOVED", removedByUserId: user._id, removedAt: new Date().toISOString() } });
    return { success: true };
  },
  "vendors.getVendorLedger": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    if (!canViewVendorLedger(user)) throw forbidden();
    const vendor = await ctx.db.collection("vendors").findOne({ _id: args.vendorId });
    if (!vendor) return null;
    const claims = await ctx.db.collection("claims").find({ vendorId: args.vendorId }).toArray();
    const ledger = buildVendorLedgerPage(claims, args);
    return {
      vendor: {
        _id: vendor._id,
        code: vendor.code,
        name: vendor.name,
        officialEmail: vendor.officialEmail,
        status: vendor.status,
      },
      rows: ledger.rows,
      summary: ledger.summary,
      totalRows: ledger.totalRows,
      page: ledger.page,
      pageSize: ledger.pageSize,
    };
  },
  "vendors.listVendorTransferQueue": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    if (!canViewVendorLedger(user)) throw forbidden();
    const { page, pageSize, skip } = pageArgs(args);
    const claims = await ctx.db.collection("claims").find({
      $or: [{ vendorId: null }, { vendorId: { $exists: false } }],
    }).sort({ date: -1, createdAt: -1, _creationTime: -1 }).toArray();
    const search = String(args.searchQuery || "").trim().toLowerCase();
    const filtered = claims
      .filter((claim) => {
        if (!search) return true;
        const haystack = [
          claim._id,
          claim.projectTitle,
          claim.title,
          claim.description,
          claim.vendorName,
          claim.vendorCode,
          claim.vendorOfficialEmail,
          claim.vendorContactPersonName,
          claim.vendorContactEmail,
          claim.vendorPan,
          claim.vendorGstin,
          claim.status,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      })
      .map(shapeVendorTransferQueueClaim);
    return {
      items: filtered.slice(skip, skip + pageSize),
      total: filtered.length,
      page,
      pageSize,
    };
  },
  "vendors.transferClaimsToVendor": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    if (!canViewVendorLedger(user)) throw forbidden();
    const vendor = await ctx.db.collection("vendors").findOne({ _id: args.vendorId });
    if (!vendor) throw notFound("Vendor not found");
    const claimIds = Array.from(new Set((args.claimIds || []).map(String)));
    const updatedClaims = [];
    for (const claimId of claimIds) {
      const claim = await ctx.db.collection("claims").findOne({ _id: claimId });
      if (!claim) continue;
      const fromVendor = claim.vendorId ? await ctx.db.collection("vendors").findOne({ _id: claim.vendorId }) : null;
      const fromClaimVendorSnapshot = fromVendor ? null : describeClaimVendorSnapshotForAudit(claim);
      const transferHistory = Array.isArray(claim.vendorTransferAudit) ? [...claim.vendorTransferAudit] : [];
      transferHistory.push(
        buildClaimTransferAuditPayload({
          currentUser: user,
          fromVendor,
          fromClaimVendorSnapshot,
          toVendor: vendor,
          note: args.note,
          timestamp: new Date().toISOString(),
        })
      );
      await ctx.db.collection("claims").updateOne(
        { _id: claimId },
        { $set: { ...buildClaimVendorSnapshot(vendor), vendorTransferAudit: transferHistory, updatedAt: new Date().toISOString() } }
      );
      updatedClaims.push(claimId);
    }
    return { success: true, updatedCount: updatedClaims.length, vendor: { _id: vendor._id, code: vendor.code, name: vendor.name } };
  },
  "vendors.commitLegacyVendorPaymentsImport": async () => ({ success: true, imported: 0 }),

  "analytics.getClaimsOverview": getClaimsOverview,
  "analytics.getPaymentBifurcationSummary": getPaymentBifurcationSummary,
  "analytics.getClaimsTimeSeries": getClaimsTimeSeries,
  "analytics.getEmployeeStatistics": getEmployeeStatistics,
  "analytics.getEmployeeStatisticsPage": getEmployeeStatisticsPage,
  "analytics.getAdminPerformance": getAdminPerformance,
  "analytics.getAdminPerformancePage": getAdminPerformancePage,
  "analytics.getUserDetailedStats": getUserDetailedStats,
  "analytics.getUserDetailedClaimsPage": getUserDetailedClaimsPage,
  "analytics.getUserDetailedActivityPage": getUserDetailedActivityPage,
  "analytics.getAllClaimsDetailed": getAllClaimsDetailed,
  "analytics.getAllClaimsDetailedPage": getAllClaimsDetailedPage,
  "analytics.getMonitoringClaimsPage": analyticsFromClaims,
  "analytics.getMonitoringExportData": async (ctx, args) => ({ items: (await analyticsFromClaims(ctx, { ...args, pageSize: 10000 })).items }),
  "analytics.getMonitoringVerticalSummary": analyticsFromClaims,
  "analytics.getAnalyticsIntegrityAudit": async () => ({ ok: true, issues: [] }),

  "pushNotifications.getMyPushStatus": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    const active = await ctx.db.collection("pushSubscriptions").countDocuments({ userId: user._id, status: "active" });
    return { activeCount: active, isSubscribed: active > 0 };
  },
  "pushNotifications.upsertPushSubscription": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    await ctx.db.collection("pushSubscriptions").updateOne({ endpoint: args.endpoint }, { $set: { ...args, userId: user._id, status: "active", updatedAt: Date.now() }, $setOnInsert: { _id: new ObjectId().toHexString(), createdAt: Date.now() } }, { upsert: true });
    return { success: true };
  },
  "pushNotifications.deactivatePushSubscription": async (ctx, args) => {
    const user = await requireCurrentUser(ctx, args);
    await ctx.db.collection("pushSubscriptions").updateMany({ userId: user._id, endpoint: args.endpoint }, { $set: { status: "inactive", updatedAt: Date.now() } });
    return { success: true };
  },
  "pushNotifications.listActivePushRecipients": async (ctx, args) => {
    await requireCurrentUser(ctx, args);
    return await ctx.db.collection("pushSubscriptions").find({ status: "active" }).toArray();
  },
  "pushNotifications.sendTestPushToAllActive": async () => ({ success: true, sent: 0 }),
  "pushNotifications.sendTargetedPushByVertical": async () => ({ success: true, sent: 0 }),

  "seed.syncDemoUsers": async (ctx) => await syncDemoUsersInDb(ctx),
  "seed.ensureDemoCeoAdmin": async (ctx) => await ensureDemoCeoAdminInDb(ctx),
  "seed.ensureDemoVendorLedgerData": async () => ({ success: true }),
  "ai.generateDemoRequisitionDraft": async () => {
    try {
      const draft = await generateDemoRequisitionDraftFromGroq();
      return draft ?? buildDemoRequisitionFallback();
    } catch (error) {
      console.warn("AI draft generation fallback:", error?.message || error);
      return buildDemoRequisitionFallback();
    }
  },
};
