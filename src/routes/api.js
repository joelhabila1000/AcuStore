'use strict';

const express = require('express');
const catalog = require('../catalog');
const settings = require('../settings');
const { wrapRouter } = require('../lib/async');
const { formatMoney } = require('../lib/format');
const { str } = require('../lib/validate');

const router = express.Router();
wrapRouter(router);

// Public, read-only JSON API. Handy for a future headless front end or for
// integrating the catalog with other tools.
router.get('/', (req, res) => {
  res.json({
    name: settings.get('store_name'),
    description: settings.get('tagline'),
    currency: settings.get('currency_code'),
    currency_symbol: settings.get('currency_symbol'),
    endpoints: {
      products: '/api/products',
      product: '/api/products/:slug',
      categories: '/api/categories'
    }
  });
});

function serialize(product) {
  const symbol = settings.get('currency_symbol');
  const manageStock = settings.getBool('manage_stock');
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    url: `/product/${product.slug}`,
    price: product.price_cents / 100,
    price_cents: product.price_cents,
    price_formatted: formatMoney(product.price_cents, symbol),
    compare_at_price: product.compare_at_cents ? product.compare_at_cents / 100 : null,
    currency: settings.get('currency_code'),
    sku: product.sku || null,
    stock: product.stock,
    in_stock: !manageStock || product.stock > 0,
    featured: Boolean(product.featured),
    image: product.image || null,
    category: product.category_name
      ? { id: product.category_id, name: product.category_name, slug: product.category_slug }
      : null,
    created_at: product.created_at,
    updated_at: product.updated_at
  };
}

router.get('/products', async (req, res) => {
  const result = await catalog.listProducts({
    q: str(req.query.q, 120),
    sort: str(req.query.sort, 20) || 'newest',
    page: parseInt(req.query.page, 10) || 1,
    perPage: parseInt(req.query.per_page, 10) || 24,
    categoryId: req.query.category_id ? parseInt(req.query.category_id, 10) : null,
    featured: String(req.query.featured || '') === 'true'
  });

  res.json({
    data: result.items.map(serialize),
    meta: {
      page: result.page,
      per_page: result.perPage,
      total: result.total,
      total_pages: result.totalPages
    }
  });
});

router.get('/products/:slug', async (req, res) => {
  const product = await catalog.getProductBySlug(str(req.params.slug, 120));
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  res.json({ data: serialize(product) });
});

router.get('/categories', async (req, res) => {
  const categories = (await catalog.listCategories({ includeEmpty: false })).map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    product_count: category.product_count,
    url: `/category/${category.slug}`
  }));
  res.json({ data: categories });
});

module.exports = router;
