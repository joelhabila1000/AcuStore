'use strict';

const db = require('./db');

const DEFAULTS = {
  store_name: 'acuStore',
  tagline: 'Everyday essentials, honestly priced.',
  announcement: 'Free shipping on orders over ₦75',
  hero_title: 'Everything you need, in one place.',
  hero_subtitle:
    'Thoughtfully selected products for your home, work and adventures — with fair prices and fast delivery.',
  hero_cta_label: 'Shop all products',
  hero_cta_href: '/products',
  hero_image: '',
  currency_symbol: '₦',
  currency_code: 'NGN',
  shipping_fee_cents: '599',
  free_shipping_threshold_cents: '7500',
  manage_stock: '0',
  products_per_page: '12',
  contact_email: 'hello@acustore.local',
  contact_phone: '',
  address: '123 Market Street, Suite 200\nSpringfield, USA',
  about_text:
    'acuStore is an independent shop built on a simple idea: good products, clearly described, at a price that makes sense. Every item is chosen by our small team and shipped from our own warehouse.',
  footer_text: '',
  payment_instructions:
    'This store collects orders and confirms payment separately. After you place an order, we will email you the payment details and delivery estimate.',
  social_instagram: '',
  social_twitter: '',
  social_facebook: ''
};

const UPSERT = `INSERT INTO settings (key, value) VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
const INSERT_IGNORE = `INSERT INTO settings (key, value) VALUES ($1, $2)
                       ON CONFLICT (key) DO NOTHING`;

/**
 * Settings are read on nearly every request (store name, currency, shipping), so
 * they are loaded once into memory and served synchronously.
 *
 * `load()` must be awaited during startup, before the server accepts requests.
 * Writes update the cache in place rather than re-reading — a single process owns
 * the cache, exactly as before the migration.
 */
let cache = null;

async function load() {
  const rows = await db.many('SELECT key, value FROM settings');
  const map = { ...DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  cache = map;
  return map;
}

function all() {
  if (!cache) {
    throw new Error('Settings were read before load(). Await settings.load() during startup.');
  }
  return cache;
}

function get(key) {
  return all()[key];
}

function getInt(key, fallback = 0) {
  const n = parseInt(all()[key], 10);
  return Number.isFinite(n) ? n : fallback;
}

function getBool(key) {
  const v = String(all()[key] ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

async function set(key, value) {
  const text = value == null ? '' : String(value);
  await db.query(UPSERT, [String(key), text]);
  if (cache) cache[key] = text;
}

async function setMany(values) {
  const entries = Object.entries(values);
  await db.withTransaction(async (client) => {
    for (const [key, value] of entries) {
      await client.query(UPSERT, [String(key), value == null ? '' : String(value)]);
    }
  });
  if (cache) {
    for (const [key, value] of entries) cache[key] = value == null ? '' : String(value);
  }
}

async function ensureDefaults() {
  await db.withTransaction(async (client) => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      await client.query(INSERT_IGNORE, [key, String(value)]);
    }
  });
  if (cache) {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (cache[key] === undefined) cache[key] = String(value);
    }
  }
}

module.exports = { DEFAULTS, load, all, get, getInt, getBool, set, setMany, ensureDefaults };
