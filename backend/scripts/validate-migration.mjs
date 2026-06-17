import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readConfig } from "../config.mjs";
import { connectMongo } from "../db.mjs";
import { collectionNames } from "../schema.mjs";

const exportDir = process.argv[2] || process.env.CONVEX_EXPORT_DIR;
if (!exportDir) {
  console.error("Usage: npm run backend:validate-migration -- exports/<convex-export-dir>");
  process.exit(1);
}

async function countJsonl(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, "utf8"), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (line.trim()) count += 1;
  }
  return count;
}

const config = readConfig();
const { client, db } = await connectMongo(config);
const resolvedExportDir = path.resolve(exportDir);
let failures = 0;

for (const collectionName of collectionNames) {
  const filePath = path.join(resolvedExportDir, collectionName, "documents.jsonl");
  const expected = await countJsonl(filePath);
  if (expected == null) continue;
  const actual = await db.collection(collectionName).countDocuments();
  const ok = actual >= expected;
  console.log(`${ok ? "OK" : "MISMATCH"} ${collectionName}: expected at least ${expected}, found ${actual}`);
  if (!ok) failures += 1;
}

const storageChecks = await db.collection("claims").countDocuments({
  $or: [
    { attachmentStorageId: { $exists: true } },
    { "proofDocuments.storageId": { $exists: true } },
    { "logs.attachments.storageId": { $exists: true } },
  ],
});
const vendorDocumentStorageChecks = await db.collection("vendorDocuments").countDocuments({ storageId: { $exists: true } });
console.log(`Storage references preserved: claims=${storageChecks}, vendorDocuments=${vendorDocumentStorageChecks}`);

await client.close();
if (failures > 0) process.exit(1);

