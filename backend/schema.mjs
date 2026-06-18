export const collectionNames = [
  "users",
  "vendors",
  "vendorDocuments",
  "vendorLedgerEntries",
  "claims",
  "vendorSequenceCounters",
  "claimCycles",
  "roleAuditLog",
  "claimDeleteAuditLog",
  "adminDashboardCounters",
  "employeeDashboardCounters",
  "paymentDashboardCounters",
  "analyticsDailySummaries",
  "analyticsUserDailySummaries",
  "analyticsAdminDailySummaries",
  "pushSubscriptions",
  "l3KnowledgeDocuments",
  "l3KnowledgeIndexState",
  "_storage",
  "_tables",
];

export const indexSpecs = {
  users: [
    [{ email: 1 }, { unique: true, sparse: true }],
    [{ role: 1 }],
    [{ status: 1 }],
  ],
  vendors: [
    [{ code: 1 }, { unique: true, sparse: true }],
    [{ normalizedCode: 1 }, { unique: true, sparse: true }],
    [{ normalizedGstNumber: 1 }, { unique: true, sparse: true }],
    [{ normalizedPanNumber: 1 }, { unique: true, sparse: true }],
    [{ status: 1 }],
    [{ status: 1, normalizedName: 1 }],
    [{ status: 1, normalizedOfficialEmail: 1 }],
    [{ status: 1, normalizedContactEmail: 1 }],
  ],
  vendorDocuments: [
    [{ vendorId: 1 }],
    [{ vendorId: 1, documentType: 1, status: 1 }],
    [{ vendorId: 1, uploadedAt: -1 }],
    [{ status: 1 }],
  ],
  vendorLedgerEntries: [
    [{ vendorId: 1 }],
    [{ paymentDate: -1 }],
    [{ createdAt: -1 }],
  ],
  claims: [
    [{ userId: 1 }],
    [{ userId: 1, employeeBucket: 1, date: -1 }],
    [{ userId: 1, status: 1, date: -1 }],
    [{ status: 1 }],
    [{ status: 1, date: -1 }],
    [{ vendorId: 1 }],
    [{ date: -1 }],
    [{ l1ApproverId: 1, status: 1, date: -1 }],
    [{ status: 1, l1ApproverId: 1, date: -1 }],
    [{ l2ApproverId: 1, status: 1, date: -1 }],
    [{ status: 1, l2ApproverId: 1, date: -1 }],
    [{ paymentMode: 1, status: 1 }],
    [{ importBatchId: 1 }],
    [{ importRowFingerprint: 1 }],
    [{ companyVertical: 1, status: 1, date: -1 }],
  ],
  vendorSequenceCounters: [[{ key: 1 }, { unique: true }]],
  claimCycles: [
    [{ claimId: 1 }],
    [{ claimId: 1, cycleNumber: 1 }, { unique: true, sparse: true }],
    [{ status: 1 }],
  ],
  roleAuditLog: [[{ userEmail: 1 }], [{ timestamp: -1 }]],
  claimDeleteAuditLog: [[{ claimId: 1 }], [{ deletedAt: -1 }], [{ deletedByUserId: 1 }]],
  adminDashboardCounters: [[{ userId: 1, role: 1 }, { unique: true, sparse: true }], [{ role: 1 }]],
  employeeDashboardCounters: [[{ userId: 1 }, { unique: true, sparse: true }]],
  paymentDashboardCounters: [[{ key: 1 }, { unique: true, sparse: true }]],
  analyticsDailySummaries: [
    [{ key: 1 }, { unique: true, sparse: true }],
    [{ date: -1 }],
    [{ date: -1, companyVertical: 1 }],
    [{ date: -1, paymentMode: 1 }],
    [{ date: -1, costType: 1 }],
  ],
  analyticsUserDailySummaries: [
    [{ key: 1 }, { unique: true, sparse: true }],
    [{ userId: 1, date: -1 }],
    [{ date: -1 }],
  ],
  analyticsAdminDailySummaries: [
    [{ key: 1 }, { unique: true, sparse: true }],
    [{ adminUserId: 1, date: -1 }],
    [{ date: -1 }],
  ],
  pushSubscriptions: [
    [{ userId: 1 }],
    [{ userId: 1, status: 1 }],
    [{ status: 1 }],
    [{ endpoint: 1 }, { unique: true, sparse: true }],
  ],
};

function buildIndexName(collectionName, keys, options = {}) {
  const keyPart = Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
  const flags = [];
  if (options.unique) flags.push("unique");
  if (options.sparse) flags.push("sparse");
  if (options.partialFilterExpression) flags.push("partial");
  return [collectionName, keyPart, ...flags].join("__").replace(/[^a-zA-Z0-9_]+/g, "_");
}

export async function ensureIndexes(db) {
  for (const collectionName of collectionNames) {
    await db.createCollection(collectionName).catch((error) => {
      if (error?.codeName !== "NamespaceExists") throw error;
    });
  }

  for (const [collectionName, specs] of Object.entries(indexSpecs)) {
    const collection = db.collection(collectionName);
    for (const [keys, options = {}] of specs) {
      const indexOptions = { ...options };
      if (!indexOptions.name) {
        indexOptions.name = buildIndexName(collectionName, keys, options);
      }
      await collection.createIndex(keys, indexOptions);
    }
  }
}
