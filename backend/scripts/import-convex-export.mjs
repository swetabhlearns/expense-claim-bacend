import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readConfig } from "../config.mjs";
import { connectAndEnsureIndexes } from "../db.mjs";
import { collectionNames } from "../schema.mjs";

const exportDir = process.argv[2] || process.env.CONVEX_EXPORT_DIR;
if (!exportDir) {
  console.error("Usage: npm run backend:import-convex-export -- exports/<convex-export-dir>");
  process.exit(1);
}

function normalizeDocument(doc) {
  if (doc && typeof doc === "object" && typeof doc._id === "string") {
    return { ...doc, legacyConvexId: doc.legacyConvexId || doc._id };
  }
  return doc;
}

async function importJsonl(collection, filePath) {
  if (!fs.existsSync(filePath)) return { inserted: 0, skipped: true };
  const input = fs.createReadStream(filePath, "utf8");
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let inserted = 0;
  let batch = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    batch.push(normalizeDocument(JSON.parse(line)));
    if (batch.length >= 1000) {
      await collection.bulkWrite(batch.map((doc) => ({
        replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
      })), { ordered: false });
      inserted += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await collection.bulkWrite(batch.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    })), { ordered: false });
    inserted += batch.length;
  }

  return { inserted, skipped: false };
}

const config = readConfig();
const { client, db } = await connectAndEnsureIndexes(config);
const resolvedExportDir = path.resolve(exportDir);
const manifestPath = path.join(resolvedExportDir, "manifest.json");
const collectionsToImport = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).collections.map((entry) => entry.name)
  : collectionNames;
const results = [];

for (const collectionName of collectionsToImport) {
  const filePath = path.join(resolvedExportDir, collectionName, "documents.jsonl");
  const result = await importJsonl(db.collection(collectionName), filePath);
  results.push({ collectionName, ...result });
}

for (const result of results) {
  if (result.skipped) {
    console.log(`Skipped ${result.collectionName}: no documents.jsonl`);
  } else {
    console.log(`Imported ${result.collectionName}: ${result.inserted}`);
  }
}

await client.close();
