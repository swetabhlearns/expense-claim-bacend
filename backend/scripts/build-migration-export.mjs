import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { migrationProfile } from "../migration-profile.mjs";

const sourceDir = process.argv[2] || process.env.CONVEX_EXPORT_DIR;
const targetDir = process.argv[3] || process.env.MIGRATION_EXPORT_DIR || path.join("exports", `mongo-migration-${new Date().toISOString().slice(0, 10)}`);

if (!sourceDir) {
  console.error("Usage: npm run backend:build-migration-export -- exports/<convex-export-dir> [exports/<target-dir>]");
  process.exit(1);
}

async function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const input = fs.createReadStream(filePath, "utf8");
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const docs = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    docs.push(JSON.parse(line));
  }
  return docs;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonl(filePath, docs) {
  ensureDir(path.dirname(filePath));
  const output = docs.map((doc) => JSON.stringify(doc)).join("\n");
  fs.writeFileSync(filePath, output ? `${output}\n` : "");
}

const sourceRoot = path.resolve(sourceDir);
const targetRoot = path.resolve(targetDir);
ensureDir(targetRoot);

const manifest = {
  sourceDir: sourceRoot,
  generatedAt: new Date().toISOString(),
  collections: [],
};

for (const entry of migrationProfile) {
  const sourcePath = path.join(sourceRoot, entry.name, "documents.jsonl");
  const docs = await readJsonl(sourcePath);
  if (docs.length === 0 && entry.optional) continue;
  const transformed = docs.map((doc) => entry.transform(doc));
  writeJsonl(path.join(targetRoot, entry.name, "documents.jsonl"), transformed);
  manifest.collections.push({
    name: entry.name,
    count: transformed.length,
    optional: Boolean(entry.optional),
  });
  console.log(`Exported ${entry.name}: ${transformed.length}`);
}

fs.writeFileSync(path.join(targetRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(
  path.join(targetRoot, "README.md"),
  `# Mongo Migration Export\n\nSource: ${sourceRoot}\nGenerated: ${manifest.generatedAt}\n\nThis export is shaped for the Mongo backend contract, not a raw Convex snapshot.\n`,
);

console.log(`Wrote tailored migration export to ${targetRoot}`);

