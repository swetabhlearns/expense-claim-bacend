const awaitingPaymentStatuses = new Set(["APPROVED_L3"]);
const paidStatuses = new Set(["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"]);

const analyticsStatusKeys = [
  "SUBMITTED",
  "APPROVED_L1",
  "APPROVED_L2",
  "APPROVED_L3",
  "PARTIALLY_DISBURSED",
  "RETURNED_TO_EMPLOYEE",
  "RETURNED_TO_L1",
  "RETURNED_TO_L2",
  "RETURNED_TO_L3",
  "DISBURSED",
  "COMPLETED",
  "REJECTED",
];

function normalizeFinanceSearch(value) {
  return String(value || "").trim().toLowerCase();
}

export function isHistoricalImportClaim(claim) {
  return Boolean(claim?.isHistoricalImport || claim?.sourceType === "historical_import" || claim?.importSource === "historical_import");
}

function normalizeDateRange(startDate, endDate, defaultRecent = true) {
  const fallbackStart = defaultRecent
    ? (() => {
        const date = new Date();
        date.setDate(date.getDate() - 90);
        return date.toISOString().split("T")[0];
      })()
    : "0000-01-01";
  const effectiveStart = startDate ?? fallbackStart;
  const effectiveEnd = endDate ?? "9999-12-31";
  return effectiveStart > effectiveEnd
    ? { startDate: effectiveEnd, endDate: effectiveStart }
    : { startDate: effectiveStart, endDate: effectiveEnd };
}

function normalizeFinancials(claim) {
  const totalRequestedAmount = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
  const totalDisbursedAmount = Number(
    claim.totalDisbursedAmount
    ?? ((claim.status === "DISBURSED" || claim.status === "COMPLETED") ? totalRequestedAmount : 0)
    ?? 0,
  );
  const pendingAmount = Number(claim.pendingAmount ?? Math.max(0, totalRequestedAmount - totalDisbursedAmount));
  return { totalRequestedAmount, totalDisbursedAmount, pendingAmount };
}

function emptyStatusBreakdown() {
  return Object.fromEntries(analyticsStatusKeys.map((status) => [status, 0]));
}

function addStatusBreakdown(base, delta, direction) {
  const next = emptyStatusBreakdown();
  for (const status of analyticsStatusKeys) {
    next[status] = Math.max(0, Number(base?.[status] ?? 0) + (Number(delta?.[status] ?? 0) * direction));
  }
  return next;
}

function applyNumberDelta(current, delta, direction) {
  return Math.max(0, Number(current || 0) + (Number(delta || 0) * direction));
}

export function matchesFinanceSearch(claim, rawSearch) {
  const search = normalizeFinanceSearch(rawSearch);
  if (!search) return true;
  return [
    claim?._id,
    claim?.userName,
    claim?.projectTitle,
    claim?.title,
    claim?.purpose,
    claim?.vendorCode,
    claim?.vendorName,
    claim?.vendorOfficialEmail,
    claim?.vendorContactPersonName,
    claim?.vendorContactEmail,
    claim?.companyVertical,
    claim?.category,
    claim?.status,
    claim?.paymentMode,
    claim?.date,
    claim?.amount != null ? String(claim.amount) : null,
    claim?.totalRequestedAmount != null ? String(claim.totalRequestedAmount) : null,
    claim?.totalDisbursedAmount != null ? String(claim.totalDisbursedAmount) : null,
    claim?.pendingAmount != null ? String(claim.pendingAmount) : null,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(search));
}

export function matchesFinanceStatusFilter(claim, statusFilter) {
  if (!statusFilter) return true;
  if (statusFilter === "ACTION_REQUIRED") {
    return claim?.status === "DISBURSED" && Boolean(claim?.proofSubmittedAt) && !claim?.isClosedByL4;
  }
  return claim?.status === statusFilter;
}

export function matchesPaymentsFilter(claim, startDate, endDate) {
  if (isHistoricalImportClaim(claim)) return false;
  if (startDate && String(claim?.date || "") < startDate) return false;
  if (endDate && String(claim?.date || "") > endDate) return false;
  return true;
}

export function matchesFinanceDashboardFilters(claim, filters = {}) {
  if (isHistoricalImportClaim(claim)) return false;
  if (!matchesPaymentsFilter(claim, filters.paymentStartDate, filters.paymentEndDate)) return false;
  if (filters.companyVertical && claim.companyVertical !== filters.companyVertical) return false;
  if (filters.category && claim.category !== filters.category) return false;
  if (filters.paymentModeFilter && claim.paymentMode !== filters.paymentModeFilter) return false;
  if (!matchesFinanceStatusFilter(claim, filters.statusFilter)) return false;
  if (!matchesFinanceSearch(claim, filters.searchQuery)) return false;
  return true;
}

export function hasActiveFinanceDashboardFilters(filters = {}) {
  return Boolean(
    filters.searchQuery?.trim()
    || filters.companyVertical
    || filters.category
    || filters.statusFilter
    || filters.paymentModeFilter
    || filters.paymentStartDate
    || filters.paymentEndDate,
  );
}

export function filterFinanceDashboardClaims(claims, filters = {}) {
  return (claims || []).filter((claim) => matchesFinanceDashboardFilters(claim, filters));
}

export function getFinanceCandidateClaims(claims) {
  return (claims || []).filter((claim) => !isHistoricalImportClaim(claim) && ["PARTIALLY_DISBURSED", "DISBURSED", "COMPLETED"].includes(claim.status));
}

export function buildPaymentModeTotals(claims) {
  return (claims || []).reduce((acc, claim) => {
    if (isHistoricalImportClaim(claim)) return acc;
    const requested = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
    const paid = Number(
      claim.totalDisbursedAmount
      ?? ((claim.status === "DISBURSED" || claim.status === "COMPLETED") ? requested : 0)
      ?? 0,
    );
    if (claim.paymentMode === "CASH") {
      acc.cashCount += 1;
      acc.cashAmount += paid;
    } else if (claim.paymentMode === "ACCOUNT_TRANSFER") {
      acc.accountTransferCount += 1;
      acc.accountTransferAmount += paid;
    }
    return acc;
  }, {
    cashAmount: 0,
    cashCount: 0,
    accountTransferAmount: 0,
    accountTransferCount: 0,
  });
}

export function summarizeFinanceDashboardClaims(claims) {
  const filteredClaims = (claims || []).filter((claim) => !isHistoricalImportClaim(claim));
  const paymentModeTotals = buildPaymentModeTotals(filteredClaims);
  return {
    total: filteredClaims.length,
    totalPaid: filteredClaims.reduce((sum, claim) => {
      const requested = Number(claim.totalRequestedAmount ?? claim.amount ?? 0);
      const paid = Number(
        claim.totalDisbursedAmount
        ?? ((claim.status === "DISBURSED" || claim.status === "COMPLETED") ? requested : 0)
        ?? 0,
      );
      return sum + paid;
    }, 0),
    totalPending: filteredClaims.reduce((sum, claim) => sum + Math.max(0, Number(claim.pendingAmount ?? 0)), 0),
    actionRequired: filteredClaims.filter((claim) => claim.status === "DISBURSED" && Boolean(claim.proofSubmittedAt) && !claim.isClosedByL4).length,
    paymentModeTotals,
  };
}

function getDefaultAnalyticsStartDate() {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().split("T")[0];
}

export async function loadAnalyticsClaimsByDateRange(ctx, startDate, endDate, opts = {}) {
  const { startDate: effectiveStartDate, endDate: effectiveEndDate } = normalizeDateRange(
    startDate,
    endDate,
    opts.defaultRecent !== false,
  );
  return await ctx.db.collection("claims").find({
    date: {
      $gte: effectiveStartDate,
      $lte: effectiveEndDate,
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

export function buildAnalyticsDailyContribution(claim) {
  const approvedClaims = paidStatuses.has(claim.status) || awaitingPaymentStatuses.has(claim.status);
  const pendingClaims = !paidStatuses.has(claim.status) && claim.status !== "REJECTED";
  if (isHistoricalImportClaim(claim)) {
    return {
      key: buildAnalyticsDailyKey({
        date: claim.date,
        companyVertical: claim.companyVertical,
        paymentMode: claim.paymentMode,
        costType: claim.costType,
      }),
      date: claim.date,
      companyVertical: claim.companyVertical,
      paymentMode: claim.paymentMode,
      costType: claim.costType,
      totalClaims: 0,
      totalAmount: 0,
      totalRequestedAmount: 0,
      pendingCount: 0,
      pendingAmount: 0,
      approvedCount: 0,
      approvedAmount: 0,
      rejectedCount: 0,
      rejectedAmount: 0,
      awaitingPaymentCount: 0,
      awaitingPaymentAmount: 0,
      paidCount: 0,
      paidAmount: 0,
      advancePaidAmount: 0,
      remainingBalancePendingAmount: 0,
      statusCounts: emptyStatusBreakdown(),
      statusAmounts: emptyStatusBreakdown(),
    };
  }
  const financial = normalizeFinancials(claim);
  const statusCounts = emptyStatusBreakdown();
  const statusAmounts = emptyStatusBreakdown();
  statusCounts[claim.status] = 1;
  statusAmounts[claim.status] = claim.amount;

  return {
    key: buildAnalyticsDailyKey({
      date: claim.date,
      companyVertical: claim.companyVertical,
      paymentMode: claim.paymentMode,
      costType: claim.costType,
    }),
    date: claim.date,
    companyVertical: claim.companyVertical,
    paymentMode: claim.paymentMode,
    costType: claim.costType,
    totalClaims: 1,
    totalAmount: claim.amount,
    totalRequestedAmount: financial.totalRequestedAmount,
    pendingCount: pendingClaims ? 1 : 0,
    pendingAmount: pendingClaims ? financial.pendingAmount : 0,
    approvedCount: approvedClaims ? 1 : 0,
    approvedAmount:
      approvedClaims
        ? (awaitingPaymentStatuses.has(claim.status)
          ? (financial.pendingAmount > 0 ? financial.pendingAmount : financial.totalRequestedAmount)
          : financial.totalDisbursedAmount)
        : 0,
    rejectedCount: claim.status === "REJECTED" ? 1 : 0,
    rejectedAmount: claim.status === "REJECTED" ? claim.amount : 0,
    awaitingPaymentCount: awaitingPaymentStatuses.has(claim.status) ? 1 : 0,
    awaitingPaymentAmount:
      awaitingPaymentStatuses.has(claim.status)
        ? (financial.pendingAmount > 0 ? financial.pendingAmount : financial.totalRequestedAmount)
        : 0,
    paidCount: paidStatuses.has(claim.status) ? 1 : 0,
    paidAmount: paidStatuses.has(claim.status) ? financial.totalDisbursedAmount : 0,
    advancePaidAmount: financial.totalDisbursedAmount,
    remainingBalancePendingAmount: financial.pendingAmount,
    statusCounts,
    statusAmounts,
  };
}

export function buildAnalyticsUserDailyContribution(claim) {
  if (isHistoricalImportClaim(claim)) {
    return {
      key: buildAnalyticsUserDailyKey(claim.date, claim.userId),
      date: claim.date,
      userId: claim.userId,
      userName: claim.userName,
      totalClaims: 0,
      totalAmount: 0,
      totalRequestedAmount: 0,
      totalDisbursedAmount: 0,
      approvedClaims: 0,
      rejectedClaims: 0,
      pendingClaims: 0,
      processedCount: 0,
    };
  }
  const financial = normalizeFinancials(claim);
  const approvedClaims = paidStatuses.has(claim.status);
  const pendingClaims = !paidStatuses.has(claim.status) && claim.status !== "REJECTED";
  return {
    key: buildAnalyticsUserDailyKey(claim.date, claim.userId),
    date: claim.date,
    userId: claim.userId,
    userName: claim.userName,
    totalClaims: 1,
    totalAmount: claim.amount,
    totalRequestedAmount: financial.totalRequestedAmount,
    totalDisbursedAmount: financial.totalDisbursedAmount,
    approvedClaims: approvedClaims ? 1 : 0,
    rejectedClaims: claim.status === "REJECTED" ? 1 : 0,
    pendingClaims: pendingClaims ? 1 : 0,
    processedCount: 0,
  };
}

function buildAnalyticsDailyKey(snapshot) {
  return [
    snapshot.date,
    snapshot.companyVertical ?? "ALL_VERTICALS",
    snapshot.paymentMode ?? "ALL_PAYMENT_MODES",
    snapshot.costType ?? "ALL_COST_TYPES",
  ].join("|");
}

function buildAnalyticsUserDailyKey(date, userId) {
  return `${date}|${userId}`;
}

function buildAnalyticsAdminDailyKey(date, adminUserId) {
  return `${date}|${adminUserId}`;
}

async function resolveUsersForRole(ctx, role) {
  return await ctx.db.collection("users").find({ role }).toArray();
}

async function resolveAdminActorForLog(ctx, claim, log) {
  if (log.stage === "L1 - Admin" && claim.l1ApproverId) {
    const user = await ctx.db.collection("users").findOne({ _id: claim.l1ApproverId });
    if (user) return { adminUserId: user._id, adminName: user.name, role: "L1_ADMIN" };
  }
  if (log.stage === "L2 - General Manager" && claim.l2ApproverId) {
    const user = await ctx.db.collection("users").findOne({ _id: claim.l2ApproverId });
    if (user) return { adminUserId: user._id, adminName: user.name, role: "L2_ADMIN" };
  }
  if (log.stage === "L3 - CEO") {
    const l3Admins = await resolveUsersForRole(ctx, "L3_ADMIN");
    const matched = l3Admins.find((user) => user.name === log.actor);
    if (matched) return { adminUserId: matched._id, adminName: matched.name, role: "L3_ADMIN" };
  }
  if (log.stage === "CEO Admin (Override)") {
    const ceoAdmins = await resolveUsersForRole(ctx, "CEO_ADMIN");
    const matched = ceoAdmins.find((user) => user.name === log.actor);
    if (matched) return { adminUserId: matched._id, adminName: matched.name, role: "CEO_ADMIN" };
  }
  if (log.stage?.startsWith("L4 -")) {
    if (claim.l4ApproverId) {
      const user = await ctx.db.collection("users").findOne({ _id: claim.l4ApproverId });
      if (user) return { adminUserId: user._id, adminName: user.name, role: "L4_ADMIN" };
    }
    const l4Admins = await resolveUsersForRole(ctx, "L4_ADMIN");
    const matched = l4Admins.find((user) => user.name === log.actor);
    if (matched) return { adminUserId: matched._id, adminName: matched.name, role: "L4_ADMIN" };
  }
  return null;
}

export async function buildAnalyticsAdminDailyContributions(ctx, claim) {
  if (isHistoricalImportClaim(claim)) return [];
  const contributions = new Map();

  for (const log of claim.logs || []) {
    if (log.action !== "APPROVE" && log.action !== "REJECT") continue;
    const actor = await resolveAdminActorForLog(ctx, claim, log);
    if (!actor) continue;
    const key = buildAnalyticsAdminDailyKey(claim.date, actor.adminUserId);
    const existing = contributions.get(key) ?? {
      key,
      date: claim.date,
      adminUserId: actor.adminUserId,
      adminName: actor.adminName,
      role: actor.role,
      approvedCount: 0,
      rejectedCount: 0,
      processedCount: 0,
    };
    if (log.action === "APPROVE" && existing.approvedCount === 0) {
      existing.approvedCount = 1;
      existing.processedCount += 1;
    }
    if (log.action === "REJECT" && existing.rejectedCount === 0) {
      existing.rejectedCount = 1;
      existing.processedCount += 1;
    }
    contributions.set(key, existing);
  }

  return Array.from(contributions.values());
}

async function getAnalyticsDailyDoc(ctx, key) {
  return await ctx.db.collection("analyticsDailySummaries").findOne({ key });
}

async function getAnalyticsUserDailyDoc(ctx, key) {
  return await ctx.db.collection("analyticsUserDailySummaries").findOne({ key });
}

async function getAnalyticsAdminDailyDoc(ctx, key) {
  return await ctx.db.collection("analyticsAdminDailySummaries").findOne({ key });
}

async function applyAnalyticsDailySnapshotDelta(ctx, snapshot, direction, now) {
  const existing = await getAnalyticsDailyDoc(ctx, snapshot.key);
  if (!existing && direction === -1) return;
  if (!existing) {
    await ctx.db.collection("analyticsDailySummaries").insertOne({ ...snapshot, updatedAt: now });
    return;
  }

  const next = {
    totalClaims: applyNumberDelta(existing.totalClaims, snapshot.totalClaims, direction),
    totalAmount: applyNumberDelta(existing.totalAmount, snapshot.totalAmount, direction),
    totalRequestedAmount: applyNumberDelta(existing.totalRequestedAmount, snapshot.totalRequestedAmount, direction),
    pendingCount: applyNumberDelta(existing.pendingCount, snapshot.pendingCount, direction),
    pendingAmount: applyNumberDelta(existing.pendingAmount, snapshot.pendingAmount, direction),
    approvedCount: applyNumberDelta(existing.approvedCount, snapshot.approvedCount, direction),
    approvedAmount: applyNumberDelta(existing.approvedAmount, snapshot.approvedAmount, direction),
    rejectedCount: applyNumberDelta(existing.rejectedCount, snapshot.rejectedCount, direction),
    rejectedAmount: applyNumberDelta(existing.rejectedAmount, snapshot.rejectedAmount, direction),
    awaitingPaymentCount: applyNumberDelta(existing.awaitingPaymentCount, snapshot.awaitingPaymentCount, direction),
    awaitingPaymentAmount: applyNumberDelta(existing.awaitingPaymentAmount, snapshot.awaitingPaymentAmount, direction),
    paidCount: applyNumberDelta(existing.paidCount, snapshot.paidCount, direction),
    paidAmount: applyNumberDelta(existing.paidAmount, snapshot.paidAmount, direction),
    advancePaidAmount: applyNumberDelta(existing.advancePaidAmount, snapshot.advancePaidAmount, direction),
    remainingBalancePendingAmount: applyNumberDelta(existing.remainingBalancePendingAmount, snapshot.remainingBalancePendingAmount, direction),
    statusCounts: addStatusBreakdown(existing.statusCounts, snapshot.statusCounts, direction),
    statusAmounts: addStatusBreakdown(existing.statusAmounts, snapshot.statusAmounts, direction),
  };

  if (next.totalClaims === 0 && next.totalAmount === 0 && next.totalRequestedAmount === 0 && next.paidAmount === 0) {
    await ctx.db.collection("analyticsDailySummaries").deleteOne({ _id: existing._id });
    return;
  }

  await ctx.db.collection("analyticsDailySummaries").updateOne(
    { _id: existing._id },
    { $set: { ...next, updatedAt: now } },
  );
}

async function applyAnalyticsUserDailySnapshotDelta(ctx, snapshot, direction, now) {
  const existing = await getAnalyticsUserDailyDoc(ctx, snapshot.key);
  if (!existing && direction === -1) return;
  if (!existing) {
    await ctx.db.collection("analyticsUserDailySummaries").insertOne({ ...snapshot, updatedAt: now });
    return;
  }

  const next = {
    userName: snapshot.userName,
    totalClaims: applyNumberDelta(existing.totalClaims, snapshot.totalClaims, direction),
    totalAmount: applyNumberDelta(existing.totalAmount, snapshot.totalAmount, direction),
    totalRequestedAmount: applyNumberDelta(existing.totalRequestedAmount, snapshot.totalRequestedAmount, direction),
    totalDisbursedAmount: applyNumberDelta(existing.totalDisbursedAmount, snapshot.totalDisbursedAmount, direction),
    approvedClaims: applyNumberDelta(existing.approvedClaims, snapshot.approvedClaims, direction),
    rejectedClaims: applyNumberDelta(existing.rejectedClaims, snapshot.rejectedClaims, direction),
    pendingClaims: applyNumberDelta(existing.pendingClaims, snapshot.pendingClaims, direction),
    processedCount: applyNumberDelta(existing.processedCount, snapshot.processedCount, direction),
  };

  if (next.totalClaims === 0 && next.totalAmount === 0 && next.totalRequestedAmount === 0) {
    await ctx.db.collection("analyticsUserDailySummaries").deleteOne({ _id: existing._id });
    return;
  }

  await ctx.db.collection("analyticsUserDailySummaries").updateOne(
    { _id: existing._id },
    { $set: { ...next, updatedAt: now } },
  );
}

async function applyAnalyticsAdminDailySnapshotDelta(ctx, snapshot, direction, now) {
  const existing = await getAnalyticsAdminDailyDoc(ctx, snapshot.key);
  if (!existing && direction === -1) return;
  if (!existing) {
    await ctx.db.collection("analyticsAdminDailySummaries").insertOne({ ...snapshot, updatedAt: now });
    return;
  }

  const next = {
    adminName: snapshot.adminName,
    role: snapshot.role,
    approvedCount: applyNumberDelta(existing.approvedCount, snapshot.approvedCount, direction),
    rejectedCount: applyNumberDelta(existing.rejectedCount, snapshot.rejectedCount, direction),
    processedCount: applyNumberDelta(existing.processedCount, snapshot.processedCount, direction),
  };

  if (next.approvedCount === 0 && next.rejectedCount === 0 && next.processedCount === 0) {
    await ctx.db.collection("analyticsAdminDailySummaries").deleteOne({ _id: existing._id });
    return;
  }

  await ctx.db.collection("analyticsAdminDailySummaries").updateOne(
    { _id: existing._id },
    { $set: { ...next, updatedAt: now } },
  );
}

export async function syncAnalyticsSummariesForClaimChange(ctx, previousClaim, nextClaim) {
  const now = new Date().toISOString();

  if (previousClaim) {
    if (isHistoricalImportClaim(previousClaim)) return;
    await applyAnalyticsDailySnapshotDelta(ctx, buildAnalyticsDailyContribution(previousClaim), -1, now);
    await applyAnalyticsUserDailySnapshotDelta(ctx, buildAnalyticsUserDailyContribution(previousClaim), -1, now);
    const previousAdminSnapshots = await buildAnalyticsAdminDailyContributions(ctx, previousClaim);
    for (const snapshot of previousAdminSnapshots) {
      await applyAnalyticsAdminDailySnapshotDelta(ctx, snapshot, -1, now);
    }
  }

  if (nextClaim) {
    if (isHistoricalImportClaim(nextClaim)) return;
    await applyAnalyticsDailySnapshotDelta(ctx, buildAnalyticsDailyContribution(nextClaim), 1, now);
    await applyAnalyticsUserDailySnapshotDelta(ctx, buildAnalyticsUserDailyContribution(nextClaim), 1, now);
    const nextAdminSnapshots = await buildAnalyticsAdminDailyContributions(ctx, nextClaim);
    for (const snapshot of nextAdminSnapshots) {
      await applyAnalyticsAdminDailySnapshotDelta(ctx, snapshot, 1, now);
    }
  }
}

export const normalizeAndSyncDashboardState = syncAnalyticsSummariesForClaimChange;

export async function rebuildAnalyticsSummaryState(ctx, startDate, endDate) {
  const { startDate: effectiveStart, endDate: effectiveEnd } = normalizeDateRange(startDate, endDate, false);
  const claims = (await ctx.db.collection("claims").find({
    date: { $gte: effectiveStart, $lte: effectiveEnd },
  }).sort({ date: 1, createdAt: 1, _creationTime: 1 }).toArray()).filter((claim) => !isHistoricalImportClaim(claim));

  const inRange = (date) => {
    if (date < effectiveStart) return false;
    if (date > effectiveEnd) return false;
    return true;
  };

  const analyticsRows = await ctx.db.collection("analyticsDailySummaries").find({ date: { $gte: effectiveStart, $lte: effectiveEnd } }).toArray();
  const userRows = await ctx.db.collection("analyticsUserDailySummaries").find({ date: { $gte: effectiveStart, $lte: effectiveEnd } }).toArray();
  const adminRows = await ctx.db.collection("analyticsAdminDailySummaries").find({ date: { $gte: effectiveStart, $lte: effectiveEnd } }).toArray();

  for (const row of analyticsRows) {
    if (inRange(row.date)) await ctx.db.collection("analyticsDailySummaries").deleteOne({ _id: row._id });
  }
  for (const row of userRows) {
    if (inRange(row.date)) await ctx.db.collection("analyticsUserDailySummaries").deleteOne({ _id: row._id });
  }
  for (const row of adminRows) {
    if (inRange(row.date)) await ctx.db.collection("analyticsAdminDailySummaries").deleteOne({ _id: row._id });
  }

  const dailySnapshots = new Map();
  const userSnapshots = new Map();
  const adminSnapshots = new Map();

  for (const claim of claims) {
    const daily = buildAnalyticsDailyContribution(claim);
    dailySnapshots.set(daily.key, {
      ...(dailySnapshots.get(daily.key) ?? {
        ...daily,
        totalClaims: 0,
        totalAmount: 0,
        totalRequestedAmount: 0,
        pendingCount: 0,
        pendingAmount: 0,
        approvedCount: 0,
        approvedAmount: 0,
        rejectedCount: 0,
        rejectedAmount: 0,
        awaitingPaymentCount: 0,
        awaitingPaymentAmount: 0,
        paidCount: 0,
        paidAmount: 0,
        advancePaidAmount: 0,
        remainingBalancePendingAmount: 0,
        statusCounts: emptyStatusBreakdown(),
        statusAmounts: emptyStatusBreakdown(),
      }),
      totalClaims: (dailySnapshots.get(daily.key)?.totalClaims ?? 0) + daily.totalClaims,
      totalAmount: (dailySnapshots.get(daily.key)?.totalAmount ?? 0) + daily.totalAmount,
      totalRequestedAmount: (dailySnapshots.get(daily.key)?.totalRequestedAmount ?? 0) + daily.totalRequestedAmount,
      pendingCount: (dailySnapshots.get(daily.key)?.pendingCount ?? 0) + daily.pendingCount,
      pendingAmount: (dailySnapshots.get(daily.key)?.pendingAmount ?? 0) + daily.pendingAmount,
      approvedCount: (dailySnapshots.get(daily.key)?.approvedCount ?? 0) + daily.approvedCount,
      approvedAmount: (dailySnapshots.get(daily.key)?.approvedAmount ?? 0) + daily.approvedAmount,
      rejectedCount: (dailySnapshots.get(daily.key)?.rejectedCount ?? 0) + daily.rejectedCount,
      rejectedAmount: (dailySnapshots.get(daily.key)?.rejectedAmount ?? 0) + daily.rejectedAmount,
      awaitingPaymentCount: (dailySnapshots.get(daily.key)?.awaitingPaymentCount ?? 0) + daily.awaitingPaymentCount,
      awaitingPaymentAmount: (dailySnapshots.get(daily.key)?.awaitingPaymentAmount ?? 0) + daily.awaitingPaymentAmount,
      paidCount: (dailySnapshots.get(daily.key)?.paidCount ?? 0) + daily.paidCount,
      paidAmount: (dailySnapshots.get(daily.key)?.paidAmount ?? 0) + daily.paidAmount,
      advancePaidAmount: (dailySnapshots.get(daily.key)?.advancePaidAmount ?? 0) + daily.advancePaidAmount,
      remainingBalancePendingAmount: (dailySnapshots.get(daily.key)?.remainingBalancePendingAmount ?? 0) + daily.remainingBalancePendingAmount,
      statusCounts: addStatusBreakdown(dailySnapshots.get(daily.key)?.statusCounts ?? emptyStatusBreakdown(), daily.statusCounts, 1),
      statusAmounts: addStatusBreakdown(dailySnapshots.get(daily.key)?.statusAmounts ?? emptyStatusBreakdown(), daily.statusAmounts, 1),
    });

    const userDaily = buildAnalyticsUserDailyContribution(claim);
    userSnapshots.set(userDaily.key, {
      ...(userSnapshots.get(userDaily.key) ?? {
        ...userDaily,
        totalClaims: 0,
        totalAmount: 0,
        totalRequestedAmount: 0,
        totalDisbursedAmount: 0,
        approvedClaims: 0,
        rejectedClaims: 0,
        pendingClaims: 0,
        processedCount: 0,
      }),
      totalClaims: (userSnapshots.get(userDaily.key)?.totalClaims ?? 0) + userDaily.totalClaims,
      totalAmount: (userSnapshots.get(userDaily.key)?.totalAmount ?? 0) + userDaily.totalAmount,
      totalRequestedAmount: (userSnapshots.get(userDaily.key)?.totalRequestedAmount ?? 0) + userDaily.totalRequestedAmount,
      totalDisbursedAmount: (userSnapshots.get(userDaily.key)?.totalDisbursedAmount ?? 0) + userDaily.totalDisbursedAmount,
      approvedClaims: (userSnapshots.get(userDaily.key)?.approvedClaims ?? 0) + userDaily.approvedClaims,
      rejectedClaims: (userSnapshots.get(userDaily.key)?.rejectedClaims ?? 0) + userDaily.rejectedClaims,
      pendingClaims: (userSnapshots.get(userDaily.key)?.pendingClaims ?? 0) + userDaily.pendingClaims,
      processedCount: 0,
    });

    const adminDailySnapshots = await buildAnalyticsAdminDailyContributions(ctx, claim);
    for (const adminDaily of adminDailySnapshots) {
      adminSnapshots.set(adminDaily.key, {
        ...(adminSnapshots.get(adminDaily.key) ?? {
          ...adminDaily,
          approvedCount: 0,
          rejectedCount: 0,
          processedCount: 0,
        }),
        approvedCount: (adminSnapshots.get(adminDaily.key)?.approvedCount ?? 0) + adminDaily.approvedCount,
        rejectedCount: (adminSnapshots.get(adminDaily.key)?.rejectedCount ?? 0) + adminDaily.rejectedCount,
        processedCount: (adminSnapshots.get(adminDaily.key)?.processedCount ?? 0) + adminDaily.processedCount,
      });
    }
  }

  const now = new Date().toISOString();
  for (const snapshot of dailySnapshots.values()) {
    await ctx.db.collection("analyticsDailySummaries").insertOne({ ...snapshot, updatedAt: now });
  }
  for (const snapshot of userSnapshots.values()) {
    await ctx.db.collection("analyticsUserDailySummaries").insertOne({ ...snapshot, updatedAt: now });
  }
  for (const snapshot of adminSnapshots.values()) {
    await ctx.db.collection("analyticsAdminDailySummaries").insertOne({ ...snapshot, updatedAt: now });
  }

  return {
    claimCount: claims.length,
    analyticsRowCount: dailySnapshots.size,
    userRowCount: userSnapshots.size,
    adminRowCount: adminSnapshots.size,
  };
}

export function aggregateAnalyticsDailySnapshots(rows) {
  const total = {
    totalClaims: 0,
    totalAmount: 0,
    totalRequestedAmount: 0,
    pendingCount: 0,
    pendingAmount: 0,
    approvedCount: 0,
    approvedAmount: 0,
    rejectedCount: 0,
    rejectedAmount: 0,
    awaitingPaymentCount: 0,
    awaitingPaymentAmount: 0,
    paidCount: 0,
    paidAmount: 0,
    advancePaidAmount: 0,
    remainingBalancePendingAmount: 0,
    statusCounts: emptyStatusBreakdown(),
    statusAmounts: emptyStatusBreakdown(),
  };

  for (const row of rows || []) {
    total.totalClaims += Number(row.totalClaims || 0);
    total.totalAmount += Number(row.totalAmount || 0);
    total.totalRequestedAmount += Number(row.totalRequestedAmount || 0);
    total.pendingCount += Number(row.pendingCount || 0);
    total.pendingAmount += Number(row.pendingAmount || 0);
    total.approvedCount += Number(row.approvedCount || 0);
    total.approvedAmount += Number(row.approvedAmount || 0);
    total.rejectedCount += Number(row.rejectedCount || 0);
    total.rejectedAmount += Number(row.rejectedAmount || 0);
    total.awaitingPaymentCount += Number(row.awaitingPaymentCount || 0);
    total.awaitingPaymentAmount += Number(row.awaitingPaymentAmount || 0);
    total.paidCount += Number(row.paidCount || 0);
    total.paidAmount += Number(row.paidAmount || 0);
    total.advancePaidAmount += Number(row.advancePaidAmount || 0);
    total.remainingBalancePendingAmount += Number(row.remainingBalancePendingAmount || 0);
    total.statusCounts = addStatusBreakdown(total.statusCounts, row.statusCounts, 1);
    total.statusAmounts = addStatusBreakdown(total.statusAmounts, row.statusAmounts, 1);
  }

  return total;
}

export function aggregateAnalyticsUserDailySnapshots(rows) {
  const byUser = new Map();
  for (const row of rows || []) {
    const existing = byUser.get(String(row.userId)) ?? {
      ...row,
      totalClaims: 0,
      totalAmount: 0,
      totalRequestedAmount: 0,
      totalDisbursedAmount: 0,
      approvedClaims: 0,
      rejectedClaims: 0,
      pendingClaims: 0,
      processedCount: 0,
    };
    existing.totalClaims += Number(row.totalClaims || 0);
    existing.totalAmount += Number(row.totalAmount || 0);
    existing.totalRequestedAmount += Number(row.totalRequestedAmount || 0);
    existing.totalDisbursedAmount += Number(row.totalDisbursedAmount || 0);
    existing.approvedClaims += Number(row.approvedClaims || 0);
    existing.rejectedClaims += Number(row.rejectedClaims || 0);
    existing.pendingClaims += Number(row.pendingClaims || 0);
    byUser.set(String(row.userId), existing);
  }
  return Array.from(byUser.values());
}

export function aggregateAnalyticsAdminDailySnapshots(rows) {
  const byAdmin = new Map();
  for (const row of rows || []) {
    const existing = byAdmin.get(String(row.adminUserId)) ?? {
      ...row,
      approvedCount: 0,
      rejectedCount: 0,
      processedCount: 0,
    };
    existing.approvedCount += Number(row.approvedCount || 0);
    existing.rejectedCount += Number(row.rejectedCount || 0);
    existing.processedCount += Number(row.processedCount || 0);
    byAdmin.set(String(row.adminUserId), existing);
  }
  return Array.from(byAdmin.values());
}

export function getRoleReachabilityCountsFromDailyAggregate(role, aggregate) {
  if (role === "L1_ADMIN") {
    return {
      totalReached: aggregate.totalClaims,
      pending: aggregate.statusCounts.SUBMITTED,
    };
  }
  if (role === "L2_ADMIN") {
    return {
      totalReached:
        aggregate.statusCounts.APPROVED_L1
        + aggregate.statusCounts.APPROVED_L2
        + aggregate.statusCounts.APPROVED_L3
        + aggregate.statusCounts.PARTIALLY_DISBURSED
        + aggregate.statusCounts.RETURNED_TO_L2
        + aggregate.statusCounts.RETURNED_TO_L3
        + aggregate.statusCounts.DISBURSED
        + aggregate.statusCounts.COMPLETED,
      pending: aggregate.statusCounts.APPROVED_L1 + aggregate.statusCounts.RETURNED_TO_L2,
    };
  }
  if (role === "L3_ADMIN") {
    return {
      totalReached:
        aggregate.statusCounts.APPROVED_L2
        + aggregate.statusCounts.APPROVED_L3
        + aggregate.statusCounts.PARTIALLY_DISBURSED
        + aggregate.statusCounts.RETURNED_TO_L3
        + aggregate.statusCounts.DISBURSED
        + aggregate.statusCounts.COMPLETED,
      pending: aggregate.statusCounts.APPROVED_L2 + aggregate.statusCounts.RETURNED_TO_L3,
    };
  }
  if (role === "CEO_ADMIN") {
    return {
      totalReached:
        aggregate.statusCounts.SUBMITTED
        + aggregate.statusCounts.APPROVED_L1
        + aggregate.statusCounts.APPROVED_L2
        + aggregate.statusCounts.APPROVED_L3
        + aggregate.statusCounts.RETURNED_TO_L1
        + aggregate.statusCounts.RETURNED_TO_L2
        + aggregate.statusCounts.RETURNED_TO_L3
        + aggregate.statusCounts.PARTIALLY_DISBURSED
        + aggregate.statusCounts.DISBURSED
        + aggregate.statusCounts.COMPLETED,
      pending:
        aggregate.statusCounts.SUBMITTED
        + aggregate.statusCounts.APPROVED_L1
        + aggregate.statusCounts.APPROVED_L2
        + aggregate.statusCounts.APPROVED_L3
        + aggregate.statusCounts.RETURNED_TO_L1
        + aggregate.statusCounts.RETURNED_TO_L2
        + aggregate.statusCounts.RETURNED_TO_L3,
    };
  }
  return {
    totalReached:
      aggregate.statusCounts.APPROVED_L3
      + aggregate.statusCounts.PARTIALLY_DISBURSED
      + aggregate.statusCounts.DISBURSED
      + aggregate.statusCounts.COMPLETED,
    pending: aggregate.statusCounts.APPROVED_L3,
  };
}

async function loadAnalyticsRows(ctx, collectionName, startDate, endDate) {
  const { startDate: effectiveStart, endDate: effectiveEnd } = normalizeDateRange(startDate, endDate, true);
  return await ctx.db.collection(collectionName).find({ date: { $gte: effectiveStart, $lte: effectiveEnd } }).toArray();
}

async function countAnalyticsEligibleClaimsInRange(ctx, startDate, endDate) {
  const { startDate: effectiveStart, endDate: effectiveEnd } = normalizeDateRange(startDate, endDate, true);
  return await ctx.db.collection("claims").countDocuments({
    date: { $gte: effectiveStart, $lte: effectiveEnd },
    $nor: [
      { isHistoricalImport: true },
      { sourceType: "historical_import" },
      { importSource: "historical_import" },
    ],
  });
}

async function loadAnalyticsAdminUsers(ctx) {
  return await ctx.db.collection("users").find({
    role: { $in: ["L1_ADMIN", "L2_ADMIN", "L3_ADMIN", "L4_ADMIN", "CEO_ADMIN"] },
    status: { $ne: "inactive" },
  }).toArray();
}

export async function computeClaimsOverview(ctx, args = {}) {
  const startedAt = Date.now();
  const rollupRows = await loadAnalyticsRows(
    ctx,
    "analyticsDailySummaries",
    args.startDate ?? getDefaultAnalyticsStartDate(),
    args.endDate,
  );
  const claimCount = await countAnalyticsEligibleClaimsInRange(ctx, args.startDate ?? getDefaultAnalyticsStartDate(), args.endDate);
  if (rollupRows.length > 0 && rollupRows.reduce((sum, row) => sum + Number(row.totalClaims || 0), 0) === claimCount) {
    const aggregate = aggregateAnalyticsDailySnapshots(rollupRows);
    const byStatus = Object.fromEntries(
      Object.keys(aggregate.statusCounts).map((status) => [
        status,
        {
          count: aggregate.statusCounts[status],
          amount: aggregate.statusAmounts[status],
        },
      ]),
    );
    return {
      source: "rollup",
      rowCount: rollupRows.length,
      durationMs: Date.now() - startedAt,
      result: {
        totalClaims: aggregate.totalClaims,
        totalAmount: aggregate.totalAmount,
        averageAmount: aggregate.totalClaims > 0 ? aggregate.totalAmount / aggregate.totalClaims : 0,
        byStatus,
        claims: aggregate.totalClaims,
      },
    };
  }

  const claims = await loadAnalyticsClaimsByDateRange(ctx, args.startDate, args.endDate);
  return {
    source: "scan",
    rowCount: claims.length,
    durationMs: Date.now() - startedAt,
    result: summarizeClaimsOverview(claims),
  };
}

function summarizePaymentBifurcationFromClaims(claims, filters) {
  const summary = {
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

  for (const claim of claims) {
    const financials = normalizeFinancials(claim);
    summary.totalRequests.count += 1;
    summary.totalRequests.amount += financials.totalRequestedAmount;
    summary.advancePaid.amount += financials.totalDisbursedAmount;
    summary.remainingBalancePending.amount += financials.pendingAmount;
    summary.advanceAndRemaining.advancePaidAmount += financials.totalDisbursedAmount;
    summary.advanceAndRemaining.remainingBalancePendingAmount += financials.pendingAmount;
    if (["SUBMITTED", "APPROVED_L1", "APPROVED_L2", "RETURNED_TO_EMPLOYEE", "RETURNED_TO_L1", "RETURNED_TO_L2", "RETURNED_TO_L3"].includes(claim.status)) {
      summary.underReview.count += 1;
      summary.underReview.amount += financials.pendingAmount > 0 ? financials.pendingAmount : financials.totalRequestedAmount;
    }
    if (awaitingPaymentStatuses.has(claim.status)) {
      summary.approved.awaitingPayment.count += 1;
      summary.approved.awaitingPayment.amount += financials.pendingAmount > 0 ? financials.pendingAmount : financials.totalRequestedAmount;
    }
    if (paidStatuses.has(claim.status)) {
      summary.approved.paid.count += 1;
      summary.approved.paid.amount += financials.totalDisbursedAmount;
    }
    const modeKey = claim.paymentMode === "ACCOUNT_TRANSFER" ? "accountTransfer" : claim.paymentMode === "CASH" ? "cash" : null;
    if (!modeKey) continue;
    const modeStats = summary.byPaymentMode[modeKey];
    modeStats.totalRequests.count += 1;
    modeStats.totalRequests.amount += financials.totalRequestedAmount;
    modeStats.advancePaid.amount += financials.totalDisbursedAmount;
    modeStats.remainingBalancePending.amount += financials.pendingAmount;
    if (["SUBMITTED", "APPROVED_L1", "APPROVED_L2", "RETURNED_TO_EMPLOYEE", "RETURNED_TO_L1", "RETURNED_TO_L2", "RETURNED_TO_L3"].includes(claim.status)) {
      modeStats.underReview.count += 1;
      modeStats.underReview.amount += financials.pendingAmount > 0 ? financials.pendingAmount : financials.totalRequestedAmount;
    }
    if (awaitingPaymentStatuses.has(claim.status)) {
      modeStats.approved.awaitingPayment.count += 1;
      modeStats.approved.awaitingPayment.amount += financials.pendingAmount > 0 ? financials.pendingAmount : financials.totalRequestedAmount;
    }
    if (paidStatuses.has(claim.status)) {
      modeStats.approved.paid.count += 1;
      modeStats.approved.paid.amount += financials.totalDisbursedAmount;
    }
  }

  summary.approved.count = summary.approved.awaitingPayment.count + summary.approved.paid.count;
  summary.approved.amount = summary.approved.awaitingPayment.amount + summary.approved.paid.amount;
  summary.byPaymentMode.cash.approved.count = summary.byPaymentMode.cash.approved.awaitingPayment.count + summary.byPaymentMode.cash.approved.paid.count;
  summary.byPaymentMode.cash.approved.amount = summary.byPaymentMode.cash.approved.awaitingPayment.amount + summary.byPaymentMode.cash.approved.paid.amount;
  summary.byPaymentMode.accountTransfer.approved.count = summary.byPaymentMode.accountTransfer.approved.awaitingPayment.count + summary.byPaymentMode.accountTransfer.approved.paid.count;
  summary.byPaymentMode.accountTransfer.approved.amount = summary.byPaymentMode.accountTransfer.approved.awaitingPayment.amount + summary.byPaymentMode.accountTransfer.approved.paid.amount;
  summary.advanceAndRemaining.totalTrackedAmount = summary.advanceAndRemaining.advancePaidAmount + summary.advanceAndRemaining.remainingBalancePendingAmount;
  return summary;
}

export async function computePaymentBifurcationSummary(ctx, args = {}) {
  const startedAt = Date.now();
  const filters = {
    startDate: args.startDate ?? null,
    endDate: args.endDate ?? null,
    companyVertical: args.companyVertical ?? null,
    paymentType: args.paymentType ?? null,
  };

  const rollupRows = await loadAnalyticsRows(ctx, "analyticsDailySummaries", args.startDate ?? getDefaultAnalyticsStartDate(), args.endDate);
  const claimCount = await countAnalyticsEligibleClaimsInRange(ctx, args.startDate ?? getDefaultAnalyticsStartDate(), args.endDate);
  if (rollupRows.length > 0 && rollupRows.reduce((sum, row) => sum + Number(row.totalClaims || 0), 0) === claimCount) {
    const filteredRows = rollupRows.filter((row) => {
      if (args.companyVertical && row.companyVertical !== args.companyVertical) return false;
      if (args.paymentType && row.costType !== args.paymentType) return false;
      return true;
    });
    const aggregate = aggregateAnalyticsDailySnapshots(filteredRows);
    const cashRows = filteredRows.filter((row) => row.paymentMode === "CASH");
    const transferRows = filteredRows.filter((row) => row.paymentMode === "ACCOUNT_TRANSFER");
    const cashAggregate = aggregateAnalyticsDailySnapshots(cashRows);
    const transferAggregate = aggregateAnalyticsDailySnapshots(transferRows);
    return {
      source: "rollup",
      rowCount: filteredRows.length,
      durationMs: Date.now() - startedAt,
      result: {
        filters,
        totalRequests: { count: aggregate.totalClaims, amount: aggregate.totalRequestedAmount },
        underReview: {
          count: aggregate.pendingCount - aggregate.awaitingPaymentCount,
          amount: aggregate.pendingAmount - aggregate.awaitingPaymentAmount,
        },
        approved: {
          count: aggregate.awaitingPaymentCount + aggregate.paidCount,
          amount: aggregate.awaitingPaymentAmount + aggregate.paidAmount,
          awaitingPayment: {
            count: aggregate.awaitingPaymentCount,
            amount: aggregate.awaitingPaymentAmount,
          },
          paid: {
            count: aggregate.paidCount,
            amount: aggregate.paidAmount,
          },
        },
        advanceAndRemaining: {
          advancePaidAmount: aggregate.advancePaidAmount,
          remainingBalancePendingAmount: aggregate.remainingBalancePendingAmount,
          totalTrackedAmount: aggregate.advancePaidAmount + aggregate.remainingBalancePendingAmount,
        },
        advancePaid: { amount: aggregate.advancePaidAmount },
        remainingBalancePending: { amount: aggregate.remainingBalancePendingAmount },
        byPaymentMode: {
          cash: {
            totalRequests: { count: cashAggregate.totalClaims, amount: cashAggregate.totalRequestedAmount },
            underReview: {
              count: cashAggregate.pendingCount - cashAggregate.awaitingPaymentCount,
              amount: cashAggregate.pendingAmount - cashAggregate.awaitingPaymentAmount,
            },
            approved: {
              count: cashAggregate.awaitingPaymentCount + cashAggregate.paidCount,
              amount: cashAggregate.awaitingPaymentAmount + cashAggregate.paidAmount,
              awaitingPayment: {
                count: cashAggregate.awaitingPaymentCount,
                amount: cashAggregate.awaitingPaymentAmount,
              },
              paid: {
                count: cashAggregate.paidCount,
                amount: cashAggregate.paidAmount,
              },
            },
            advancePaid: { amount: cashAggregate.advancePaidAmount },
            remainingBalancePending: { amount: cashAggregate.remainingBalancePendingAmount },
          },
          accountTransfer: {
            totalRequests: { count: transferAggregate.totalClaims, amount: transferAggregate.totalRequestedAmount },
            underReview: {
              count: transferAggregate.pendingCount - transferAggregate.awaitingPaymentCount,
              amount: transferAggregate.pendingAmount - transferAggregate.awaitingPaymentAmount,
            },
            approved: {
              count: transferAggregate.awaitingPaymentCount + transferAggregate.paidCount,
              amount: transferAggregate.awaitingPaymentAmount + transferAggregate.paidAmount,
              awaitingPayment: {
                count: transferAggregate.awaitingPaymentCount,
                amount: transferAggregate.awaitingPaymentAmount,
              },
              paid: {
                count: transferAggregate.paidCount,
                amount: transferAggregate.paidAmount,
              },
            },
            advancePaid: { amount: transferAggregate.advancePaidAmount },
            remainingBalancePending: { amount: transferAggregate.remainingBalancePendingAmount },
          },
        },
      },
    };
  }

  const claims = (await loadAnalyticsClaimsByDateRange(ctx, args.startDate, args.endDate)).filter((claim) => {
    if (args.companyVertical && claim.companyVertical !== args.companyVertical) return false;
    if (args.paymentType && claim.costType !== args.paymentType) return false;
    return true;
  });

  return {
    source: "scan",
    rowCount: claims.length,
    durationMs: Date.now() - startedAt,
    result: summarizePaymentBifurcationFromClaims(claims, filters),
  };
}

export async function computeEmployeeStatisticsRows(ctx, startDate, endDate) {
  const startedAt = Date.now();
  const { startDate: effectiveStart, endDate: effectiveEnd } = normalizeDateRange(startDate, endDate, true);
  const rollupRows = await ctx.db.collection("analyticsUserDailySummaries").find({ date: { $gte: effectiveStart, $lte: effectiveEnd } }).toArray();
  const claimCount = await countAnalyticsEligibleClaimsInRange(ctx, startDate, endDate);
  if (rollupRows.length > 0 && rollupRows.reduce((sum, row) => sum + Number(row.totalClaims || 0), 0) === claimCount) {
    const items = aggregateAnalyticsUserDailySnapshots(rollupRows).map((row) => ({
      userId: row.userId,
      userName: row.userName,
      totalClaims: row.totalClaims,
      totalAmount: row.totalAmount,
      approvedClaims: row.approvedClaims,
      rejectedClaims: row.rejectedClaims,
      pendingClaims: row.pendingClaims,
    })).sort((a, b) => b.totalAmount - a.totalAmount);
    return { source: "rollup", items, rowCount: rollupRows.length, durationMs: Date.now() - startedAt };
  }

  const claims = await loadAnalyticsClaimsByDateRange(ctx, startDate, endDate);
  const byUser = new Map();
  for (const claim of claims) {
    const key = String(claim.userId || "");
    if (!byUser.has(key)) {
      byUser.set(key, {
        userId: claim.userId,
        userName: claim.userName,
        totalClaims: 0,
        totalAmount: 0,
        approvedClaims: 0,
        rejectedClaims: 0,
        pendingClaims: 0,
      });
    }
    const row = byUser.get(key);
    row.totalClaims += 1;
    row.totalAmount += Number(claim.amount ?? claim.totalRequestedAmount ?? 0);
    if (paidStatuses.has(claim.status)) row.approvedClaims += 1;
    else if (claim.status === "REJECTED") row.rejectedClaims += 1;
    else row.pendingClaims += 1;
  }
  return {
    source: "scan",
    items: Array.from(byUser.values()).sort((a, b) => b.totalAmount - a.totalAmount),
    rowCount: claims.length,
    durationMs: Date.now() - startedAt,
  };
}

export async function computeAdminPerformanceRows(ctx, startDate, endDate) {
  const startedAt = Date.now();
  const { startDate: effectiveStart, endDate: effectiveEnd } = normalizeDateRange(startDate, endDate, true);
  const [adminRows, globalRows, rollupRows] = await Promise.all([
    loadAnalyticsAdminUsers(ctx),
    ctx.db.collection("analyticsDailySummaries").find({ date: { $gte: effectiveStart, $lte: effectiveEnd } }).toArray(),
    ctx.db.collection("analyticsAdminDailySummaries").find({ date: { $gte: effectiveStart, $lte: effectiveEnd } }).toArray(),
  ]);
  const claimCount = await countAnalyticsEligibleClaimsInRange(ctx, startDate, endDate);
  if (
    globalRows.length > 0
    && rollupRows.length > 0
    && globalRows.reduce((sum, row) => sum + Number(row.totalClaims || 0), 0) === claimCount
  ) {
    const globalAggregate = aggregateAnalyticsDailySnapshots(globalRows);
    const grouped = aggregateAnalyticsAdminDailySnapshots(rollupRows);
    const byAdmin = new Map(grouped.map((row) => [String(row.adminUserId), row]));
    const items = adminRows.map((admin) => {
      const stats = byAdmin.get(String(admin._id)) ?? {
        approvedCount: 0,
        rejectedCount: 0,
        processedCount: 0,
      };
      const reachability = getRoleReachabilityCountsFromDailyAggregate(admin.role, globalAggregate);
      const totalProcessed = stats.processedCount;
      return {
        userId: admin._id,
        name: admin.name,
        level: admin.role,
        levelName: String(admin.role || "").replace("_", " "),
        approved: stats.approvedCount,
        rejected: stats.rejectedCount,
        pending: reachability.pending,
        totalProcessed,
        approvalRate: totalProcessed > 0 ? Math.round((stats.approvedCount / totalProcessed) * 1000) / 10 : 0,
        totalReached: reachability.totalReached,
      };
    }).sort((a, b) => b.totalProcessed - a.totalProcessed);

    return {
      source: "rollup",
      items,
      rowCount: globalRows.length,
      durationMs: Date.now() - startedAt,
    };
  }

  const claims = await loadAnalyticsClaimsByDateRange(ctx, startDate, endDate);
  const rows = adminRows.map((admin) => {
    const stageLabel = String(admin.role || "").replace("_", " ");
    const actedClaims = claims.filter((claim) => Array.isArray(claim.logs) && claim.logs.some((log) => String(log.stage || "").includes(stageLabel)));
    const approved = actedClaims.filter((claim) => Array.isArray(claim.logs) && claim.logs.some((log) => log.action === "APPROVE" && String(log.stage || "").includes(stageLabel))).length;
    const rejected = actedClaims.filter((claim) => Array.isArray(claim.logs) && claim.logs.some((log) => log.action === "REJECT" && String(log.stage || "").includes(stageLabel))).length;
    const pending = claims.filter((claim) => {
      if (claim.status === "REJECTED") return false;
      if (admin.role === "L1_ADMIN") return claim.status === "SUBMITTED" || claim.status === "RETURNED_TO_L1";
      if (admin.role === "L2_ADMIN") return claim.status === "APPROVED_L1" || claim.status === "RETURNED_TO_L2" || claim.status === "SUBMITTED";
      if (admin.role === "L3_ADMIN") return claim.status === "APPROVED_L2" || claim.status === "RETURNED_TO_L3";
      if (admin.role === "L4_ADMIN") return claim.status === "APPROVED_L3" || (claim.status === "DISBURSED" && !claim.isClosedByL4);
      if (admin.role === "CEO_ADMIN") {
        return ["SUBMITTED", "APPROVED_L1", "APPROVED_L2", "APPROVED_L3", "RETURNED_TO_L1", "RETURNED_TO_L2", "RETURNED_TO_L3"].includes(claim.status)
          || (claim.status === "DISBURSED" && !claim.isClosedByL4);
      }
      return false;
    }).length;
    const totalProcessed = approved + rejected;
    return {
      userId: admin._id,
      name: admin.name,
      level: admin.role,
      levelName: String(admin.role || "").replace("_", " "),
      approved,
      rejected,
      pending,
      totalProcessed,
      approvalRate: totalProcessed > 0 ? Math.round((approved / totalProcessed) * 1000) / 10 : 0,
      totalReached: actedClaims.length,
    };
  }).sort((a, b) => b.totalProcessed - a.totalProcessed);

  return {
    source: "scan",
    items: rows,
    rowCount: claims.length,
    durationMs: Date.now() - startedAt,
  };
}

export async function computeClaimsTimeSeries(ctx, args = {}) {
  const startedAt = Date.now();
  const granularity = args.granularity || "day";
  const rollupRows = await loadAnalyticsRows(
    ctx,
    "analyticsDailySummaries",
    args.startDate ?? getDefaultAnalyticsStartDate(),
    args.endDate,
  );
  const claimCount = await countAnalyticsEligibleClaimsInRange(ctx, args.startDate ?? getDefaultAnalyticsStartDate(), args.endDate);
  if (rollupRows.length > 0 && rollupRows.reduce((sum, row) => sum + Number(row.totalClaims || 0), 0) === claimCount) {
    const grouped = rollupRows.reduce((acc, row) => {
      const key = getAnalyticsTimeSeriesKey(row.date, granularity);
      if (!acc[key]) acc[key] = { date: key, count: 0, amount: 0 };
      acc[key].count += Number(row.totalClaims || 0);
      acc[key].amount += Number(row.totalAmount || 0);
      return acc;
    }, {});
    return {
      source: "rollup",
      rowCount: rollupRows.length,
      durationMs: Date.now() - startedAt,
      result: Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  const claims = await loadAnalyticsClaimsByDateRange(ctx, args.startDate, args.endDate);
  const grouped = claims.reduce((acc, claim) => {
    const key = getAnalyticsTimeSeriesKey(claim.date, granularity);
    if (!acc[key]) acc[key] = { date: key, count: 0, amount: 0 };
    acc[key].count += 1;
    acc[key].amount += Number(claim.amount ?? claim.totalRequestedAmount ?? 0);
    return acc;
  }, {});
  return {
    source: "scan",
    rowCount: claims.length,
    durationMs: Date.now() - startedAt,
    result: Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
