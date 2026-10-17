'use strict';

/**
 * One-off copy of the existing SQLite data into Neon Postgres.
 *
 *   node src/scripts/import-sqlite.js [--force]
 *
 * Preserves primary keys, timestamps and the bcrypt password hash, so the admin
 * account you already changed (email + password) keeps working. Sessions are NOT
 * copied — they are short-lived and everyone simply signs in again.
 *
 * Refuses to run if the target already has products, unless --force is passed
 * (in which case the target tables are truncated first).
 */

const Database = require('better-sqlite3');
const { Client } = require('pg');
const config = require('../config');

const FORCE = process.argv.includes('--force');

/** SQLite stored `datetime('now')` — a UTC wall-clock string with no zone. */
function toDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function main() {
  let sqlite;
  try {
    sqlite = new Database(config.dbFile, { readonly: true, fileMustExist: true });
  } catch (error) {
    console.error(`Cannot open the SQLite file at ${config.dbFile}: ${error.message}`);
    console.error('Nothing to import. Run `npm run seed` to create sample data instead.');
    process.exitCode = 1;
    return;
  }

  const read = (table, order = 'id') => {
    try {
      return sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    } catch {
      return [];
    }
  };

  const admins = read('admins');
  const categories = read('categories');
  const products = read('products');
  const orders = read('orders');
  const orderItems = read('order_items');
  const settings = read('settings', 'key');

  console.log('Read from SQLite:');
  console.log(
    `  admins ${admins.length} · categories ${categories.length} · products ${products.length} ` +
      `· orders ${orders.length} · order_items ${orderItems.length} · settings ${settings.length}`,
  );

  const client = new Client({
    connectionString: config.databaseDirectUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();

  try {
    const existing = await client.query('SELECT count(*)::int AS n FROM products');
    if (existing.rows[0].n > 0 && !FORCE) {
      console.log('\nTarget already contains products — refusing to overwrite. Re-run with --force to replace.');
      return;
    }

    console.log('\nWriting to Postgres…');
    await client.query('BEGIN');

    await client.query('TRUNCATE order_items, orders, products, categories, admins, settings RESTART IDENTITY CASCADE');

    for (const row of admins) {
      await client.query(
        `INSERT INTO admins (id, name, email, password_hash, created_at)
         VALUES ($1, $2, $3, $4, COALESCE($5, now()))
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.name, row.email, row.password_hash, toDate(row.created_at)],
      );
    }

    for (const row of categories) {
      await client.query(
        `INSERT INTO categories (id, name, slug, description, position, created_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
         ON CONFLICT (id) DO NOTHING`,
        [row.id, row.name, row.slug, row.description ?? '', row.position ?? 0, toDate(row.created_at)],
      );
    }

    for (const row of products) {
      await client.query(
        `INSERT INTO products
           (id, name, slug, description, price_cents, compare_at_cents, sku, stock,
            category_id, image, featured, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 COALESCE($13, now()), COALESCE($14, now()))
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          row.name,
          row.slug,
          row.description ?? '',
          row.price_cents ?? 0,
          row.compare_at_cents ?? null,
          row.sku ?? '',
          row.stock ?? 0,
          row.category_id ?? null,
          row.image ?? '',
          Boolean(row.featured),
          Boolean(row.active),
          toDate(row.created_at),
          toDate(row.updated_at),
        ],
      );
    }

    for (const row of orders) {
      await client.query(
        `INSERT INTO orders
           (id, reference, customer_name, customer_email, customer_phone, shipping_address,
            note, payment_method, subtotal_cents, shipping_cents, total_cents, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, now()))
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          row.reference,
          row.customer_name,
          row.customer_email,
          row.customer_phone ?? '',
          row.shipping_address,
          row.note ?? '',
          row.payment_method ?? 'pay_on_delivery',
          row.subtotal_cents ?? 0,
          row.shipping_cents ?? 0,
          row.total_cents ?? 0,
          row.status ?? 'pending',
          toDate(row.created_at),
        ],
      );
    }

    for (const row of orderItems) {
      await client.query(
        `INSERT INTO order_items (id, order_id, product_id, name, image, unit_price_cents, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          row.order_id,
          row.product_id ?? null,
          row.name,
          row.image ?? '',
          row.unit_price_cents ?? 0,
          row.quantity ?? 1,
        ],
      );
    }

    for (const row of settings) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [row.key, row.value ?? ''],
      );
    }

    // Explicit ids were inserted, so advance each sequence past the highest id.
    for (const table of ['admins', 'categories', 'products', 'orders', 'order_items']) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       COALESCE((SELECT max(id) FROM ${table}), 1))`,
      );
    }

    await client.query('COMMIT');

    const counts = await client.query(`
      SELECT
        (SELECT count(*)::int FROM admins) AS admins,
        (SELECT count(*)::int FROM categories) AS categories,
        (SELECT count(*)::int FROM products) AS products,
        (SELECT count(*)::int FROM orders) AS orders,
        (SELECT count(*)::int FROM order_items) AS order_items,
        (SELECT count(*)::int FROM settings) AS settings
    `);
    console.log('\nNow stored in Neon:', counts.rows[0]);

    const admin = await client.query('SELECT email, name FROM admins ORDER BY id LIMIT 1');
    if (admin.rowCount) {
      console.log(`Admin account preserved: ${admin.rows[0].email}`);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
    sqlite.close();
  }
}

main().catch((error) => {
  console.error('Import failed:', error.message);
  process.exitCode = 1;
});
