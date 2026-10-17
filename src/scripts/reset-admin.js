'use strict';

// Resets an admin password when you are locked out.
// Usage: node src/scripts/reset-admin.js <email> <new-password>
//    or: ADMIN_EMAIL=... ADMIN_PASSWORD=... node src/scripts/reset-admin.js
const auth = require('../auth');
const db = require('../db');
const config = require('../config');

const email = process.argv[2] || config.admin.email;
const password = process.argv[3] || config.admin.password;

async function main() {
  if (!email || !password) {
    console.error('Usage: node src/scripts/reset-admin.js <email> <new-password>');
    process.exitCode = 1;
    return;
  }

  if (String(password).length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }

  const admin = await auth.findByEmail(email);
  if (!admin) {
    console.error(`No admin account found for ${email}.`);
    process.exitCode = 1;
    return;
  }

  await auth.updatePassword(admin.id, password);
  console.log(`Password updated for ${admin.email}.`);
}

main()
  .catch((error) => {
    console.error('Reset failed:', error);
    process.exitCode = 1;
  })
  .finally(() => db.close().catch(() => {}));
