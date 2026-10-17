'use strict';

const path = require('path');

// The .env file is the single source of truth for local configuration, so it
// overrides anything already exported by the shell. Without this a stray
// NODE_ENV=production in the environment silently turns on template caching,
// HSTS and hidden error output during local development.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const ROOT = path.join(__dirname, '..');
const port = parseInt(process.env.PORT, 10) || 3000;

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  port,
  siteUrl: (process.env.SITE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'insecure-development-secret-change-me',
  sessionMaxAgeMs: 1000 * 60 * 60 * 24 * 7,
  admin: {
    name: process.env.ADMIN_NAME || 'Store Owner',
    email: process.env.ADMIN_EMAIL || 'admin@acustore.local',
    password: process.env.ADMIN_PASSWORD || 'admin12345'
  },
  seedSampleData: String(process.env.SEED_SAMPLE_DATA || 'true').toLowerCase() !== 'false',
  // The SQLite path is kept only so the one-off import script can read the old file.
  dbFile: process.env.DB_FILE
    ? path.resolve(ROOT, process.env.DB_FILE)
    : path.join(ROOT, 'data', 'store.db'),

  // Neon Postgres. DATABASE_URL is the pooled string used by the app at runtime;
  // DIRECT_URL is the unpooled string used by migrations and the one-off import.
  databaseUrl: process.env.DATABASE_URL || '',
  databaseDirectUrl: process.env.DIRECT_URL || process.env.DATABASE_URL || '',
  databaseSsl: String(process.env.DATABASE_SSL || 'true').toLowerCase() !== 'false',
  // Neon's pooler fans out connections, so a small client pool is plenty.
  pgPoolMax: parseInt(process.env.PG_POOL_MAX, 10) || 10,

  uploadsDir: path.join(ROOT, 'public', 'uploads'),
  maxUploadBytes: 5 * 1024 * 1024
};

config.isProduction = config.env === 'production';

module.exports = config;
