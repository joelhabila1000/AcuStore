'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');

fs.mkdirSync(config.uploadsDir, { recursive: true });

if (!config.databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Run `npm run db:bootstrap` to create the Neon database ' +
      'and write the connection strings into .env.',
  );
}

/**
 * One pool for the whole process.
 *
 * The app talks to Neon through the POOLED host, so each query is a short
 * checkout from PgBouncer. Keeping `max` small is deliberate: with a pooler in
 * front, a large client pool multiplies connections for no benefit.
 */
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
});

pool.on('error', (error) => {
  // An idle client dropping its connection must never take the process down.
  console.error('[db] idle client error:', error.message);
});

/** Runs a query and returns the full result (use when you need rowCount). */
function query(text, params) {
  return pool.query(text, params);
}

/** First row or null. */
async function one(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

/** All rows. */
async function many(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

/**
 * Runs `fn` inside a transaction on a single dedicated client.
 * Commits on resolve, rolls back on throw, always releases the client.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, one, many, withTransaction, close };
