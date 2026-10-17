'use strict';

const db = require('./db');
const config = require('./config');
const settings = require('./settings');
const auth = require('./auth');
const { slugify } = require('./lib/slugify');

const SAMPLE_CATEGORIES = [
  { name: 'Home & Kitchen', description: 'Everyday tools and comforts for the home.' },
  { name: 'Electronics', description: 'Gadgets and accessories that just work.' },
  { name: 'Apparel', description: 'Wearables made for daily use.' },
  { name: 'Stationery', description: 'Paper, pens and desk essentials.' },
  { name: 'Outdoors', description: 'Gear for weekends outside.' }
];

const SAMPLE_PRODUCTS = [
  { name: 'Stoneware Coffee Mug', category: 'Home & Kitchen', price: 18, compareAt: 24, sku: 'HK-MUG-01', stock: 42, featured: true, description: 'A weighty 12oz mug with a matte glaze. Dishwasher and microwave safe.' },
  { name: 'Cast Iron Skillet, 10"', category: 'Home & Kitchen', price: 39.5, compareAt: null, sku: 'HK-PAN-10', stock: 18, featured: true, description: 'Pre-seasoned cast iron that only gets better with use. Oven safe to 500°F.' },
  { name: 'Linen Tea Towel Set', category: 'Home & Kitchen', price: 22, compareAt: 28, sku: 'HK-TOW-04', stock: 60, description: 'Three absorbent stonewashed linen towels that soften with every wash.' },
  { name: 'Bamboo Cutting Board', category: 'Home & Kitchen', price: 26, sku: 'HK-CUT-02', stock: 31, description: 'Reversible board with a juice groove and a built-in hand grip.' },
  { name: 'Glass Storage Set', category: 'Home & Kitchen', price: 44, sku: 'HK-GLS-06', stock: 12, description: 'Six leakproof containers with bamboo lids for fridge and pantry.' },

  { name: 'Wireless Earbuds', category: 'Electronics', price: 79, compareAt: 99, sku: 'EL-BUD-01', stock: 25, featured: true, description: 'Compact true-wireless earbuds with 24 hours of total battery life.' },
  { name: 'USB-C Fast Charger', category: 'Electronics', price: 29, sku: 'EL-CHG-30', stock: 55, description: '30W GaN charger that powers a laptop or phone from a single port.' },
  { name: 'Braided Charging Cable', category: 'Electronics', price: 14, compareAt: 19, sku: 'EL-CBL-02', stock: 120, description: 'Two-metre USB-C to USB-C cable rated for 100W and 10Gbps.' },
  { name: 'Bluetooth Speaker', category: 'Electronics', price: 59, sku: 'EL-SPK-01', stock: 20, featured: true, description: 'Pocketable speaker with a 12-hour battery and IPX7 water resistance.' },
  { name: 'Desk Power Strip', category: 'Electronics', price: 34, sku: 'EL-STR-04', stock: 40, description: 'Four outlets, three USB ports and a 6ft cord with surge protection.' },

  { name: 'Organic Cotton T-Shirt', category: 'Apparel', price: 24, compareAt: 30, sku: 'AP-TEE-01', stock: 80, featured: true, description: 'Mid-weight organic cotton tee with a classic fit and reinforced collar.' },
  { name: 'Canvas Tote Bag', category: 'Apparel', price: 19, sku: 'AP-TOT-01', stock: 95, description: 'Heavyweight canvas tote with an interior pocket and reinforced handles.' },
  { name: 'Merino Wool Socks', category: 'Apparel', price: 16, sku: 'AP-SOC-03', stock: 150, description: 'Cushioned merino socks that stay warm when wet and resist odour.' },
  { name: 'Packable Rain Jacket', category: 'Apparel', price: 68, compareAt: 85, sku: 'AP-JKT-02', stock: 14, description: 'Fully seam-sealed shell that folds into its own pocket.' },

  { name: 'Hardcover Notebook', category: 'Stationery', price: 15, sku: 'ST-NBK-01', stock: 70, featured: true, description: 'A5 dotted notebook with 180 pages of thick, fountain-pen-friendly paper.' },
  { name: 'Gel Pen Set', category: 'Stationery', price: 12, sku: 'ST-PEN-05', stock: 110, description: 'Five quick-dry gel pens in a 0.5mm tip with a soft grip.' },
  { name: 'Desk Planner Pad', category: 'Stationery', price: 18, compareAt: 22, sku: 'ST-PLN-01', stock: 45, description: 'Undated weekly planner pad with tear-off sheets and a rigid backing.' },
  { name: 'Kraft Sticky Notes', category: 'Stationery', price: 9, sku: 'ST-NOT-03', stock: 200, description: 'Six recycled pads in assorted sizes and natural kraft tones.' },

  { name: 'Insulated Water Bottle', category: 'Outdoors', price: 32, compareAt: 40, sku: 'OD-BTL-01', stock: 65, featured: true, description: 'Double-wall stainless bottle that keeps drinks cold for 24 hours.' },
  { name: 'Compact Camp Lantern', category: 'Outdoors', price: 27, sku: 'OD-LTN-01', stock: 35, description: 'Collapsible lantern with four brightness modes and a USB-C port.' },
  { name: 'Picnic Blanket', category: 'Outdoors', price: 45, sku: 'OD-BLK-01', stock: 22, description: 'Water-resistant roll-up blanket with a carry strap for four people.' },
  { name: 'Trail Daypack 20L', category: 'Outdoors', price: 74, compareAt: 90, sku: 'OD-PAK-20', stock: 16, description: 'Lightweight daypack with a ventilated back panel and rain cover.' }
];

async function ensureDefaultAdmin() {
  if ((await auth.count()) > 0) return { created: false };

  await auth.createAdmin({
    name: config.admin.name,
    email: config.admin.email,
    password: config.admin.password
  });
  return { created: true, email: config.admin.email };
}

/**
 * Only runs against an empty catalog. Slugs are generated up-front and the inserts
 * use ON CONFLICT DO NOTHING, so a partially-seeded database cannot fail here on
 * a duplicate slug.
 */
async function ensureSeedData() {
  if (!config.seedSampleData) return { created: false, reason: 'sample data disabled' };

  const existing = await db.one('SELECT count(*)::int AS n FROM products');
  if (!existing || existing.n > 0) return { created: false, reason: 'catalog not empty' };

  await db.withTransaction(async (client) => {
    const categoryIds = {};

    for (const [index, category] of SAMPLE_CATEGORIES.entries()) {
      const inserted = await client.query(
        `INSERT INTO categories (name, slug, description, position)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
        [category.name, slugify(category.name), category.description || '', index],
      );

      if (inserted.rows[0]) {
        categoryIds[category.name] = inserted.rows[0].id;
      } else {
        const found = await client.query('SELECT id FROM categories WHERE slug = $1', [slugify(category.name)]);
        categoryIds[category.name] = found.rows[0] ? found.rows[0].id : null;
      }
    }

    for (const product of SAMPLE_PRODUCTS) {
      await client.query(
        `INSERT INTO products
           (name, slug, description, price_cents, compare_at_cents, sku, stock, category_id, image, featured, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', $9, TRUE)
         ON CONFLICT (slug) DO NOTHING`,
        [
          product.name,
          slugify(product.name),
          product.description || '',
          Math.round(product.price * 100),
          product.compareAt ? Math.round(product.compareAt * 100) : null,
          product.sku || '',
          Number.isFinite(product.stock) ? product.stock : 25,
          categoryIds[product.category] || null,
          Boolean(product.featured),
        ],
      );
    }
  });

  return { created: true, categories: SAMPLE_CATEGORIES.length, products: SAMPLE_PRODUCTS.length };
}

async function run() {
  await settings.ensureDefaults();
  return { admin: await ensureDefaultAdmin(), sample: await ensureSeedData() };
}

module.exports = {
  run,
  ensureDefaultAdmin,
  ensureSeedData,
  SAMPLE_CATEGORIES,
  SAMPLE_PRODUCTS
};
