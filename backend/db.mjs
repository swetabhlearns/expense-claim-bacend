import { MongoClient } from "mongodb";
import { ensureIndexes } from "./schema.mjs";

let cached;

export async function connectMongo(config) {
  if (cached) return cached;
  const client = new MongoClient(config.mongodbUri);
  await client.connect();
  const db = client.db(config.databaseName);
  cached = { client, db };
  return cached;
}

export async function connectAndEnsureIndexes(config) {
  const mongo = await connectMongo(config);
  await ensureIndexes(mongo.db);
  return mongo;
}

