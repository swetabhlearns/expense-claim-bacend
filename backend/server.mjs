import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { readConfig } from "./config.mjs";
import { connectAndEnsureIndexes } from "./db.mjs";
import { sendError, badRequest } from "./errors.mjs";
import { handlers } from "./handlers.mjs";
import { callConvexStorageFunction, isConvexStorageFunction } from "./convexStorageBridge.mjs";

function withCors(res) {
  res.setHeader("access-control-allow-origin", process.env.BACKEND_CORS_ORIGIN || "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-demo-user-id,x-user-id,x-user-email,x-file-name");
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw badRequest("Request body must be valid JSON", { rawLength: raw.length });
  }
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

function storageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

const storageCacheDir = path.resolve("/private/tmp", "expenseclaim-storage-cache");

async function readBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function storageCachePaths(storageId) {
  return {
    dataPath: path.join(storageCacheDir, `${storageId}.bin`),
    metaPath: path.join(storageCacheDir, `${storageId}.json`),
  };
}

async function writeCachedStorage(storageId, body, contentType, fileName) {
  await fs.mkdir(storageCacheDir, { recursive: true });
  const { dataPath, metaPath } = storageCachePaths(storageId);
  await fs.writeFile(dataPath, body);
  await fs.writeFile(metaPath, JSON.stringify({
    storageId,
    fileName,
    contentType,
    size: body.length,
    storedAt: new Date().toISOString(),
  }, null, 2));
}

async function tryServeCachedStorage(res, storageId) {
  const { dataPath, metaPath } = storageCachePaths(storageId);
  try {
    const [data, metaRaw] = await Promise.all([
      fs.readFile(dataPath),
      fs.readFile(metaPath, "utf8"),
    ]);
    const meta = JSON.parse(metaRaw);
    res.writeHead(200, {
      "content-type": meta.contentType || "application/octet-stream",
      "content-length": String(data.length),
      "cache-control": "public, max-age=300",
      "x-storage-cache-source": "local",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function handleStorageUpload(ctx, req, res, storageId) {
  const body = await readBodyBuffer(req);
  if (!body.length) {
    throw badRequest("Upload body cannot be empty");
  }

  const contentType = String(req.headers["content-type"] || "application/octet-stream");
  const fileName = String(req.headers["x-file-name"] || storageId);
  await writeCachedStorage(storageId, body, contentType, fileName);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    storageId,
    fileName,
    contentType,
    size: body.length,
  }));
}

async function handleStorageRoute(ctx, req, res, storageId) {
  if (req.method === "POST") {
    await handleStorageUpload(ctx, req, res, storageId);
    return;
  }

  if (await tryServeCachedStorage(res, storageId)) {
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: "NOT_FOUND", message: `Storage object ${storageId} was not found` }));
}

async function handleStorageUploadProxy(ctx, req, res, url) {
  const target = url.searchParams.get("target") || "claims.generateAttachmentUploadUrl";
  const encodedArgs = url.searchParams.get("args") || "";
  const [namespace, name] = target.split(".");
  if (!namespace || !name) {
    throw badRequest("Missing storage upload target");
  }

  const body = await readBodyBuffer(req);
  if (!body.length) {
    throw badRequest("Upload body cannot be empty");
  }

  let args = {};
  if (encodedArgs) {
    try {
      args = JSON.parse(Buffer.from(encodedArgs, "base64url").toString("utf8"));
    } catch {
      throw badRequest("Invalid upload proxy args");
    }
  }

  const uploadTarget = await callConvexStorageFunction(ctx, namespace, name, args);
  const contentType = String(req.headers["content-type"] || "application/octet-stream");
  const fileName = String(req.headers["x-file-name"] || req.headers["x-fileName"] || "upload.bin");
  const uploadResponse = await fetch(uploadTarget, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const rawText = await uploadResponse.text();
  let parsed = {};
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { rawText };
    }
  }
  if (!uploadResponse.ok) {
    throw badRequest("Convex upload proxy failed", {
      status: uploadResponse.status,
      body: parsed,
    });
  }

  const storageId = parsed.storageId || parsed.id || parsed.value?.storageId || parsed.result?.storageId;
  if (!storageId) {
    throw badRequest("Convex upload proxy did not return a storageId", { body: parsed });
  }

  await writeCachedStorage(String(storageId), body, contentType, fileName);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    storageId,
    fileName,
    contentType,
    size: body.length,
  }));
}

function parseFunctionPath(pathname) {
  const match = pathname.match(/^\/api\/functions\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { namespace: match[1], name: match[2], key: `${match[1]}.${match[2]}` };
}

async function handleFunctionCall(ctx, namespace, name, args) {
  const key = `${namespace}.${name}`;
  const handler = handlers[key];
  if (!handler) {
    if (isConvexStorageFunction(namespace, name)) {
      return await callConvexStorageFunction(ctx, namespace, name, args);
    }
    throw badRequest(`No Mongo backend handler is registered for ${key}`);
  }
  return await handler(ctx, args);
}

async function handleDomainRoute(ctx, pathname, method, args) {
  const storageMatch = pathname.match(/^\/api\/storage\/([^/]+)$/);
  if (method === "GET" && storageMatch) {
    return { __streamStorage: storageMatch[1] };
  }

  if (method === "GET" && pathname === "/api/health") {
    return {
      ok: true,
      backend: "mongo-test",
      storage: "test-convex",
      database: ctx.config.databaseName,
      releaseVersion: ctx.config.releaseVersion,
      checkedAt: new Date().toISOString(),
    };
  }

  if (method === "GET" && pathname === "/api/app/release-info") {
    return await handlers["app.getReleaseInfo"](ctx, args);
  }

  if (method === "GET" && pathname === "/api/auth/me") {
    return await handlers["users.getCurrentUser"](ctx, args);
  }

  if (method === "GET" && pathname === "/api/users") {
    return await handlers["users.listAllUsers"](ctx, args);
  }

  if (method === "POST" && pathname === "/api/users") {
    return await handlers["users.createUser"](ctx, args);
  }

  if (method === "GET" && pathname === "/api/claims") {
    return await handlers["claims.getAdminClaimsPage"](ctx, args);
  }

  if (method === "POST" && pathname === "/api/claims") {
    return await handlers["claims.createClaim"](ctx, args);
  }

  const claimMatch = pathname.match(/^\/api\/claims\/([^/]+)$/);
  if (method === "GET" && claimMatch) {
    return await handlers["claims.getClaim"](ctx, { ...args, claimId: claimMatch[1] });
  }

  if (method === "GET" && pathname === "/api/vendors") {
    return await handlers["vendors.listVendors"](ctx, args);
  }

  if (method === "POST" && pathname === "/api/vendors") {
    return await handlers["vendors.createVendor"](ctx, args);
  }

  if (method === "GET" && pathname === "/api/analytics/claims-overview") {
    return await handlers["analytics.getClaimsOverview"](ctx, args);
  }

  throw badRequest(`Unsupported route ${method} ${pathname}`);
}

async function main() {
  const config = readConfig();
  const { db } = await connectAndEnsureIndexes(config);

  const server = http.createServer(async (req, res) => {
    withCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const queryArgs = Object.fromEntries(url.searchParams.entries());
      const ctx = { req, config, db, origin: getRequestOrigin(req) };

      if (req.method === "POST" && url.pathname === "/api/storage/upload") {
        await handleStorageUploadProxy(ctx, req, res, url);
        return;
      }

      const storageMatch = url.pathname.match(/^\/api\/storage\/([^/]+)$/);
      if (storageMatch && (req.method === "GET" || req.method === "POST")) {
        await handleStorageRoute(ctx, req, res, storageMatch[1]);
        return;
      }

      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method || "") ? await readJson(req) : {};
      const args = { ...queryArgs, ...(body.args && Object.keys(body).length === 1 ? body.args : body) };

      const functionPath = parseFunctionPath(url.pathname);
      const result = functionPath
        ? await handleFunctionCall(ctx, functionPath.namespace, functionPath.name, args)
        : await handleDomainRoute(ctx, url.pathname, req.method || "GET", args);

      sendJson(res, { result });
    } catch (error) {
      sendError(res, error);
    }
  });

  server.listen(config.port, () => {
    console.log(`Mongo test backend listening on http://localhost:${config.port}`);
    console.log(`Database: ${config.databaseName}; storage bridge: ${config.testConvexUrl ? "enabled" : "disabled"}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
