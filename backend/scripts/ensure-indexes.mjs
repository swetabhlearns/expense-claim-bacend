import { readConfig } from "../config.mjs";
import { connectAndEnsureIndexes } from "../db.mjs";

const config = readConfig();
const { client, db } = await connectAndEnsureIndexes(config);
console.log(`Ensured Mongo indexes for ${db.databaseName}`);
await client.close();

