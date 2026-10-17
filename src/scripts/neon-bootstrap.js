'use strict';

/**
 * One-time Neon bootstrap for the Express app.
 *
 *  1. Creates a dedicated `acustore` database on the linked Neon project.
 *  2. Writes DATABASE_URL (pooled) and DIRECT_URL (unpooled) into this project's .env.
 *
 * It reads the Neon connections from the sibling Next.js project's .env the first
 * time, so no secret ever has to be pasted on a command line. After this runs,
 * acuStore/.env is self-contained and the sibling is no longer consulted.
 *
 * Safe to re-run: the database creation is guarded, and the env writes replace
 * existing lines rather than appending duplicates.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, '.env');
const SIBLING_ENV = path.join(ROOT, '..', 'acustore-next', '.env');
const TARGET_DB = process.env.NEON_DATABASE || 'acustore';

function readEnvFile(file) {
  const map = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[match[1]] = value;
  }
  return map;
}

function withDatabase(connectionString, database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function setVar(text, key, value) {
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.trimEnd()}\n${line}\n`;
}

async function main() {
  const own = readEnvFile(ENV_FILE);
  const sibling = readEnvFile(SIBLING_ENV);

  // Prefer a real Neon URL already present; otherwise borrow the sibling's.
  const pooled = [own.DATABASE_URL, sibling.DATABASE_URL].find((u) => u && u.includes('neon.tech'));
  const direct = [own.DIRECT_URL, sibling.DATABASE_URL_UNPOOLED, sibling.DIRECT_URL].find(
    (u) => u && u.includes('neon.tech'),
  );

  if (!pooled || !direct) {
    console.error('No Neon connection strings found. Set DATABASE_URL and DIRECT_URL in .env first.');
    process.exit(1);
  }

  const adminUrl = direct;
  console.log(`Creating database "${TARGET_DB}" if needed…`);

  const client = new Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: true } });
  try {
    await client.connect();
  } catch (error) {
    // Neon presents a valid chain, but corporate proxies sometimes intercept it.
    console.error(`TLS/connect failed with certificate verification: ${error.message}`);
    console.error('Retrying without certificate verification (traffic is still encrypted).');
    await client.end().catch(() => {});
    const insecure = new Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: false } });
    await insecure.connect();
    await ensureDatabase(insecure);
    await insecure.end();
    await writeEnv(pooled, direct);
    return;
  }

  await ensureDatabase(client);
  await client.end();
  await writeEnv(pooled, direct);
}

async function ensureDatabase(client) {
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TARGET_DB]);
  if (existing.rowCount > 0) {
    console.log(`  database "${TARGET_DB}" already exists`);
    return;
  }
  // CREATE DATABASE cannot run inside a transaction, so run it on its own.
  await client.query(`CREATE DATABASE "${TARGET_DB}"`);
  console.log(`  database "${TARGET_DB}" created`);
}

async function writeEnv(pooled, direct) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  text = setVar(text, 'DATABASE_URL', withDatabase(pooled, TARGET_DB));
  text = setVar(text, 'DIRECT_URL', withDatabase(direct, TARGET_DB));
  text = setVar(text, 'DATABASE_SSL', 'true');
  fs.writeFileSync(ENV_FILE, text);

  const target = new URL(withDatabase(pooled, TARGET_DB));
  console.log('\n.env updated:');
  console.log(`  DATABASE_URL  → ${target.hostname}${target.pathname} (pooled=${target.hostname.includes('-pooler')})`);
  console.log('  DIRECT_URL    → direct host (migrations/imports)');
  console.log('  DATABASE_SSL  → true');
}

main().catch((error) => {
  console.error('Bootstrap failed:', error.message);
  process.exitCode = 1;
});
