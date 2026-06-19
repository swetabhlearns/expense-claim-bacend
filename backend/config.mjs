import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const loadedEnvFiles = new Set();

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const quoted = trimmed.slice(1, -1);
    return quoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function loadEnvFile(filePath) {
  if (loadedEnvFiles.has(filePath) || !fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  loadedEnvFiles.add(filePath);

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) continue;
    const value = parseEnvValue(normalized.slice(equalsIndex + 1));
    process.env[key] = value;
  }
}

function loadLocalEnv() {
  const backendDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(backendDir, "..");
  loadEnvFile(path.join(repoRoot, ".env.local"));
  loadEnvFile(path.join(repoRoot, ".env"));
}

loadLocalEnv();

export function readConfig() {
  const port = Number(process.env.PORT || process.env.BACKEND_PORT || 8081);
  const mongodbUri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB_NAME || "expenseclaim_test";
  const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || "expense-bktcorp";
  const testConvexUrl = process.env.TEST_CONVEX_URL || process.env.VITE_CONVEX_URL;
  const allowUnverifiedAuth = process.env.MONGO_BACKEND_ALLOW_UNVERIFIED_AUTH === "true";
  const releaseVersion = process.env.APP_RELEASE_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || "mongo-test-local";
  const buildId =
    process.env.APP_BUILD_ID ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    releaseVersion;

  if (!mongodbUri) {
    throw new Error("Missing MONGODB_URI. Set it before starting the Mongo backend.");
  }

  return {
    port,
    mongodbUri,
    databaseName,
    firebaseProjectId,
    testConvexUrl,
    allowUnverifiedAuth,
    releaseVersion,
    buildId,
  };
}
