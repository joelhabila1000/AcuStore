'use strict';

/**
 * Applies schema.sql to the Neon database. Idempotent — every statement is
 * CREATE ... IF NOT EXISTS, so running it again is a no-op.
 *
 * Uses DIRECT_URL: DDL and CREATE EXTENSION want a real session, not a
 * transaction-pooled connection.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require('../config');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');

  const client = new Client({
    connectionString: config.databaseDirectUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  });

  await client.connect();
  console.log('Applying schema…');

  try {
    await client.query(sql);
  } finally {
    const tables = await client.query(
      `SELECT table_name::text AS name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    console.log('Tables now present:', tables.rows.map((row) => row.name).join(', '));
    await client.end();
  }

  console.log('Schema applied.');
}

main().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
