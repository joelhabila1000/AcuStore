'use strict';

// Creates any missing settings/admin and (optionally) the sample catalog.
// Safe to run repeatedly: it only fills in what is missing.
const settings = require('../settings');
const catalog = require('../catalog');
const seed = require('../seed');
const db = require('../db');
const config = require('../config');

async function main() {
  await settings.load();
  const result = await seed.run();
  const counts = await catalog.counts();

  const target = new URL(config.databaseUrl);

  console.log('');
  console.log('acuStore setup complete');
  console.log('───────────────────────');
  console.log(`Database:        ${target.hostname}${target.pathname}`);
  console.log(`Sample catalog:  ${result.sample.created ? 'loaded' : `skipped (${result.sample.reason})`}`);
  console.log(`Admin account:   ${result.admin.created ? `created (${result.admin.email})` : 'already exists'}`);
  console.log(`Products:        ${counts.products}`);
  console.log('');
  if (result.admin.created) {
    console.log('Sign in at /admin with the ADMIN_EMAIL and ADMIN_PASSWORD from your .env file.');
    console.log('Change that password from Account settings as soon as you can.');
    console.log('');
  }
}

main()
  .catch((error) => {
    console.error('Setup failed:', error);
    process.exitCode = 1;
  })
  .finally(() => db.close().catch(() => {}));
