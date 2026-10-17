'use strict';

const db = require('./db');
const { slugify } = require('./lib/slugify');

const SORTS = {
  newest: 'p.created_at DESC, p.id DESC',
  oldest: 'p.created_at ASC, p.id ASC',
  'price-asc': 'p.price_cents ASC, p.name ASC',
  'price-desc': 'p.price_cents DESC, p.name ASC',
  name: 'p.name ASC',
  featured: 'p.featured DESC, p.created_at DESC, p.id DESC'
};

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest' },
  { value: 'price-asc', label: 'Price: low to high' },
  { value: 'price-desc', label: 'Price: high to low' },
  { value: 'name', label: 'Name A–Z' }
];

async function productSlugTaken(slug, ignoreId = null) {
  const row = ignoreId
    ? await db.one('SELECT id FROM products WHERE slug = $1 AND id <> $2', [slug, ignoreId])
    : await db.one('SELECT id FROM products WHERE slug = $1', [slug]);
  return Boolean(row);
}

async function categorySlugTaken(slug, ignoreId = null) {
  const row = ignoreId
    ? await db.one('SELECT id FROM categories WHERE slug = $1 AND id <> $2', [slug, ignoreId])
    : await db.one('SELECT id FROM categories WHERE slug = $1', [slug]);
  return Boolean(row);
}

/**
 * The shared `uniqueSlug` helper takes a synchronous predicate, which no longer
 * works now that slug checks are database round-trips. Same suffixing policy,
 * awaited.
 */
async function uniqueSlugFor(base, isTaken) {
  const root = slugify(base) || 'item';
  let candidate = root;
  let n = 2;
  while (await isTaken(candidate)) {
    candidate = `${root}-${n}`;
    if (++n > 200) {
      candidate = `${root}-${Date.now().toString(36)}`;
      break;
    }
  }
  return candidate;
}

async function listProducts(options = {}) {
  const {
    q = '',
    categoryId = null,
    featured = false,
    sort = 'newest',
    page = 1,
    perPage = 12,
    includeInactive = false
  } = options;

  const where = [];
  const params = [];

  if (!includeInactive) where.push('p.active = true');
  if (categoryId) {
    params.push(categoryId);
    where.push(`p.category_id = $${params.length}`);
  }
  if (featured) where.push('p.featured = true');

  const term = String(q || '').trim();
  if (term) {
    params.push(`%${term}%`);
    // ILIKE restores the case-insensitive matching SQLite's LIKE gave us for free.
    where.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await db.one(`SELECT count(*)::int AS n FROM products p ${whereSql}`, params);
  const total = totalRow ? totalRow.n : 0;

  const perPageSafe = Math.min(Math.max(parseInt(perPage, 10) || 12, 1), 60);
  const totalPages = Math.max(1, Math.ceil(total / perPageSafe));
  const currentPage = Math.min(Math.max(parseInt(page, 10) || 1, 1), totalPages);
  const offset = (currentPage - 1) * perPageSafe;

  const items = await db.many(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     ${whereSql}
     ORDER BY ${SORTS[sort] || SORTS.newest}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPageSafe, offset],
  );

  return { items, total, page: currentPage, perPage: perPageSafe, totalPages };
}

async function getProductBySlug(slug, includeInactive = false) {
  const sql = `SELECT p.*, c.name AS category_name, c.slug AS category_slug
               FROM products p
               LEFT JOIN categories c ON c.id = p.category_id
               WHERE p.slug = $1${includeInactive ? '' : ' AND p.active = true'}`;
  return db.one(sql, [slug]);
}

async function getProductById(id) {
  return db.one('SELECT * FROM products WHERE id = $1', [id]);
}

async function relatedProducts(product, limit = 4) {
  const base = `SELECT p.*, c.name AS category_name, c.slug AS category_slug
                FROM products p
                LEFT JOIN categories c ON c.id = p.category_id
                WHERE p.active = true AND p.id <> $1`;

  let rows = [];
  if (product.category_id) {
    rows = await db.many(
      `${base} AND p.category_id = $2 ORDER BY p.featured DESC, p.created_at DESC LIMIT $3`,
      [product.id, product.category_id, limit],
    );
  }

  if (rows.length >= limit) return rows;

  const fallback = await db.many(
    `${base} ORDER BY p.featured DESC, p.created_at DESC LIMIT $2`,
    [product.id, limit + 1],
  );

  const seen = new Set(rows.map((row) => row.id));
  for (const row of fallback) {
    if (rows.length >= limit) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

async function listCategories({ includeEmpty = true } = {}) {
  const rows = await db.many(
    `SELECT c.*,
            (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.active = true) AS product_count
     FROM categories c
     ORDER BY c.position ASC, c.name ASC`,
  );
  return includeEmpty ? rows : rows.filter((row) => row.product_count > 0);
}

async function getCategoryBySlug(slug) {
  return db.one('SELECT * FROM categories WHERE slug = $1', [slug]);
}

async function getCategoryById(id) {
  return db.one('SELECT * FROM categories WHERE id = $1', [id]);
}

async function createProduct(input) {
  const slug = await uniqueSlugFor(input.slug || input.name, (candidate) => productSlugTaken(candidate));
  const row = await db.one(
    `INSERT INTO products
       (name, slug, description, price_cents, compare_at_cents, sku, stock, category_id, image, featured, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.name,
      slug,
      input.description ?? '',
      input.price_cents ?? 0,
      input.compare_at_cents ?? null,
      input.sku ?? '',
      input.stock ?? 0,
      input.category_id ?? null,
      input.image ?? '',
      Boolean(input.featured),
      input.active === undefined ? true : Boolean(input.active),
    ],
  );
  return getProductById(row.id);
}

async function updateProduct(id, input) {
  const slug = await uniqueSlugFor(input.slug || input.name, (candidate) => productSlugTaken(candidate, id));
  await db.query(
    `UPDATE products SET
       name = $1,
       slug = $2,
       description = $3,
       price_cents = $4,
       compare_at_cents = $5,
       sku = $6,
       stock = $7,
       category_id = $8,
       image = $9,
       featured = $10,
       active = $11,
       updated_at = now()
     WHERE id = $12`,
    [
      input.name,
      slug,
      input.description ?? '',
      input.price_cents ?? 0,
      input.compare_at_cents ?? null,
      input.sku ?? '',
      input.stock ?? 0,
      input.category_id ?? null,
      input.image ?? '',
      Boolean(input.featured),
      input.active === undefined ? true : Boolean(input.active),
      id,
    ],
  );
  return getProductById(id);
}

async function deleteProduct(id) {
  const result = await db.query('DELETE FROM products WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function createCategory(input) {
  const slug = await uniqueSlugFor(input.slug || input.name, (candidate) => categorySlugTaken(candidate));
  const row = await db.one(
    'INSERT INTO categories (name, slug, description, position) VALUES ($1, $2, $3, $4) RETURNING id',
    [input.name, slug, input.description || '', input.position || 0],
  );
  return getCategoryById(row.id);
}

async function updateCategory(id, input) {
  const slug = await uniqueSlugFor(input.slug || input.name, (candidate) => categorySlugTaken(candidate, id));
  await db.query('UPDATE categories SET name = $1, slug = $2, description = $3, position = $4 WHERE id = $5', [
    input.name,
    slug,
    input.description || '',
    input.position || 0,
    id,
  ]);
  return getCategoryById(id);
}

async function deleteCategory(id) {
  const result = await db.query('DELETE FROM categories WHERE id = $1', [id]);
  return result.rowCount > 0;
}

async function lowStockProducts(limit = 5) {
  return db.many(
    `SELECT p.*, c.name AS category_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.active = true AND p.stock <= 5
     ORDER BY p.stock ASC, p.name ASC
     LIMIT $1`,
    [limit],
  );
}

async function counts() {
  return db.one(
    `SELECT
       (SELECT count(*)::int FROM products) AS products,
       (SELECT count(*)::int FROM products WHERE active = true) AS active_products,
       (SELECT count(*)::int FROM categories) AS categories,
       (SELECT count(*)::int FROM orders) AS orders`,
  );
}

module.exports = {
  SORTS,
  SORT_OPTIONS,
  productSlugTaken,
  categorySlugTaken,
  listProducts,
  getProductBySlug,
  getProductById,
  relatedProducts,
  listCategories,
  getCategoryBySlug,
  getCategoryById,
  createProduct,
  updateProduct,
  deleteProduct,
  createCategory,
  updateCategory,
  deleteCategory,
  lowStockProducts,
  counts
};
