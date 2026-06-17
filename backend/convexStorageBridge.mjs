import { badRequest } from "./errors.mjs";

const storageFunctions = {
  "claims.generateAttachmentUploadUrl": { type: "mutation", path: "claims:generateAttachmentUploadUrl" },
  "claims.getAttachmentUrl": { type: "query", path: "claims:getAttachmentUrl" },
  "r2Storage.getUploadUrl": { type: "action", path: "r2Storage:getUploadUrl" },
  "r2Storage.getDownloadUrl": { type: "action", path: "r2Storage:getDownloadUrl" },
  "r2Storage.getProofUploadUrl": { type: "action", path: "r2Storage:getProofUploadUrl" },
};

const storageFunctionsAcceptingDemoUserId = new Set([
]);

const convexDemoUserIdCache = new Map();

async function resolveConvexDemoUserId(testConvexUrl, email) {
  const cacheKey = `${testConvexUrl}::${email}`;
  if (convexDemoUserIdCache.has(cacheKey)) {
    return convexDemoUserIdCache.get(cacheKey);
  }

  const response = await fetch(`${testConvexUrl.replace(/\/$/, "")}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "users:listUsers",
      args: {},
      format: "json",
    }),
  });

  if (!response.ok) {
    return null;
  }

  const rawText = await response.text();
  const parsed = rawText ? JSON.parse(rawText) : {};
  const users = Array.isArray(parsed.value) ? parsed.value : [];
  const user = users.find((entry) => String(entry.email || "").trim().toLowerCase() === email);
  const userId = user?._id || null;
  if (userId) {
    convexDemoUserIdCache.set(cacheKey, userId);
  }
  return userId;
}

async function fetchConvexQuery(testConvexUrl, path, args) {
  const response = await fetch(`${testConvexUrl.replace(/\/$/, "")}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      args,
      format: "json",
    }),
  });

  const rawText = await response.text();
  const parsed = rawText ? JSON.parse(rawText) : {};
  if (!response.ok) {
    throw badRequest(`Convex query failed for ${path}`, {
      status: response.status,
      body: parsed,
    });
  }
  return parsed.value ?? parsed.result ?? parsed;
}

export async function resolveConvexAttachmentUrl(testConvexUrl, storageId, authEmail) {
  if (!testConvexUrl || !storageId) return null;
  const normalizedEmail = authEmail?.trim().toLowerCase();
  const demoUserId = normalizedEmail ? await resolveConvexDemoUserId(testConvexUrl, normalizedEmail) : null;
  const args = demoUserId ? { storageId, demoUserId } : { storageId };
  try {
    return await fetchConvexQuery(testConvexUrl, "claims:getAttachmentUrl", args);
  } catch (error) {
    if (process.env.DEBUG_CONVEX_STORAGE_BRIDGE === "true") {
      console.log("convex attachment url lookup failed", { storageId, authEmail, error: String(error) });
    }
    return null;
  }
}

export function isConvexStorageFunction(namespace, name) {
  return Boolean(storageFunctions[`${namespace}.${name}`]);
}

export async function callConvexStorageFunction(ctx, namespace, name, args) {
  if (!ctx.config.testConvexUrl) {
    throw badRequest("TEST_CONVEX_URL or VITE_CONVEX_URL must be set for Convex storage bridge calls");
  }
  const entry = storageFunctions[`${namespace}.${name}`];
  if (!entry) throw badRequest(`Unsupported Convex storage bridge function: ${namespace}.${name}`);
  let bridgedArgs = args;
  const authHeader = ctx.req.headers.authorization || "";
  if (authHeader.startsWith("Bearer test:")) {
    const email = authHeader.slice("Bearer test:".length).trim().toLowerCase();
    if (email && storageFunctionsAcceptingDemoUserId.has(`${namespace}.${name}`)) {
      const convexDemoUserId = await resolveConvexDemoUserId(ctx.config.testConvexUrl, email);
      if (convexDemoUserId) {
        bridgedArgs = { ...args, demoUserId: convexDemoUserId };
      }
    }
  }
  if (process.env.DEBUG_CONVEX_STORAGE_BRIDGE === "true") {
    console.log("convex storage bridge call", {
      function: `${namespace}.${name}`,
      authHeader,
      bridgedDemoUserId: bridgedArgs.demoUserId || null,
    });
  }

  const endpoint = `${ctx.config.testConvexUrl.replace(/\/$/, "")}/api/${entry.type}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      path: entry.path,
      args: bridgedArgs,
      format: "json",
    }),
  });

  const rawText = await response.text();
  const parsed = rawText ? JSON.parse(rawText) : {};
  if (!response.ok) {
    throw badRequest(`Convex storage bridge request failed for ${namespace}.${name}`, {
      status: response.status,
      body: parsed,
    });
  }
  return parsed.value ?? parsed.result ?? parsed;
}
