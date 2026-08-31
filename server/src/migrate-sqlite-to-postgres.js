import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";

const { Client } = pg;
const sqlitePath = path.resolve(process.env.SQLITE_PATH || "data/image-rating.sqlite");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const client = new Client({ connectionString });

function quoteIdentifier(value) {
  return `"${String(value).toLowerCase().replaceAll('"', '""')}"`;
}

function sqliteTables() {
  return sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

async function migrateTable(table) {
  const columns = sqlite
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((column) => column.name);
  const rows = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
  if (!rows.length) return { table, rows: 0 };

  const names = columns.map(quoteIdentifier).join(", ");
  for (const row of rows) {
    const values = columns.map((column) => row[column]);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    await client.query(
      `INSERT INTO ${quoteIdentifier(table)} (${names}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values,
    );
  }
  return { table, rows: rows.length };
}

await client.connect();
try {
  const schemaPath = new URL("./postgres-schema.sql", import.meta.url);
  await client.query(await fs.readFile(schemaPath, "utf8"));
  await client.query("BEGIN");
  await client.query("SET CONSTRAINTS ALL DEFERRED").catch(() => {});
  await client.query("SET session_replication_role = replica");
  const results = [];
  for (const table of sqliteTables()) results.push(await migrateTable(table));
  await client.query("COMMIT");
  await client.query("SET session_replication_role = origin");
  for (const result of results) console.log(`${result.table}: ${result.rows}`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
  sqlite.close();
}
