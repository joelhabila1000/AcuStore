'use strict';

const express = require('express');
const config = require('../config');
const catalog = require('../catalog');
const commerce = require('../commerce');
const settings = require('../settings');
const { wrapRouter } = require('../lib/async');
const { formatMoney } = require('../lib/format');
const { str, isEmail, safeRedirectPath } = require('../lib/validate');

const router = express.Router();

// Every handler below is async once it touches Postgres; this makes a rejected
// promise reach the error middleware instead of hanging the request.
wrapRouter(router);

function wantsJson(req) {
  return req.accepts(['html', 'json']) === 'json';
}

function perPage() {
  return settings.getInt('products_per_page', 12) || 12;
}

async function categoryPayload() {
  return catalog.listCategories({ includeEmpty: false });
}

/* ── Storefront ─────────────────────────────────────────── */

router.get('/', async (req, res) => {
  // Three independent reads: run them together rather than serially.
  const [featured, latest, categories] = await Promise.all([
    catalog.listProducts({ featured: true, perPage: 8, sort: 'featured' }),
    catalog.listProducts({ perPage: 8, sort: 'newest' }),
    categoryPayload()
  ]);

  res.render('shop/home', {
    title: `${settings.get('store_name')} — ${settings.get('tagline')}`,
    metaDescription: settings.get('hero_subtitle'),
    featured: featured.items,
    latest: latest.items,
    categories
  });
});

router.get('/products', async (req, res) => {
  const q = str(req.query.q, 120);
  const sort = str(req.query.sort, 20) || 'newest';
  const page = parseInt(req.query.page, 10) || 1;
  const categorySlug = str(req.query.category, 80);

  const [category, categories] = await Promise.all([
    categorySlug ? catalog.getCategoryBySlug(categorySlug) : Promise.resolve(null),
    categoryPayload()
  ]);

  const result = await catalog.listProducts({
    q,
    sort,
    page,
    perPage: perPage(),
    categoryId: category ? category.id : null
  });

  res.render('shop/products', {
    title: q ? `Search: ${q}` : 'All products',
    metaDescription: `Browse ${result.total} products at ${settings.get('store_name')}.`,
    result,
    q,
    sort,
    category,
    sortOptions: catalog.SORT_OPTIONS,
    categories,
    baseUrl: '/products'
  });
});

router.get('/category/:slug', async (req, res, next) => {
  const category = await catalog.getCategoryBySlug(req.params.slug);
  if (!category) return next();

  const [result, categories] = await Promise.all([
    catalog.listProducts({
      categoryId: category.id,
      sort: str(req.query.sort, 20) || 'newest',
      page: parseInt(req.query.page, 10) || 1,
      perPage: perPage()
    }),
    categoryPayload()
  ]);

  res.render('shop/products', {
    title: category.name,
    metaDescription: category.description || `Shop ${category.name} at ${settings.get('store_name')}.`,
    result,
    q: '',
    sort: req.query.sort || 'newest',
    category,
    sortOptions: catalog.SORT_OPTIONS,
    categories,
    baseUrl: `/category/${category.slug}`
  });
});

router.get('/product/:slug', async (req, res, next) => {
  const product = await catalog.getProductBySlug(req.params.slug);
  if (!product) return next();

  const related = await catalog.relatedProducts(product, 4);
  const inStock = !settings.getBool('manage_stock') || product.stock > 0;

  res.render('shop/product', {
    title: product.name,
    metaDescription: product.description ? product.description.slice(0, 155) : product.name,
    product,
    related,
    inStock,
    breadcrumbCategory: product.category_slug
      ? { name: product.category_name, slug: product.category_slug }
      : null
  });
});

/* ── Cart ───────────────────────────────────────────────── */

async function cartJson(req, res) {
  const cart = await commerce.buildCart(req.session.cart);
  const symbol = settings.get('currency_symbol');
  return res.json({
    ok: true,
    count: cart.count,
    subtotal_cents: cart.subtotalCents,
    subtotal: formatMoney(cart.subtotalCents, symbol),
    total: formatMoney(cart.totalCents, symbol)
  });
}

router.get('/cart', async (req, res) => {
  const cart = await commerce.buildCart(req.session.cart);
  res.render('shop/cart', {
    title: 'Your cart',
    metaDescription: 'Review the items in your cart.',
    cart
  });
});

router.post('/cart/add', async (req, res) => {
  const productId = parseInt(req.body.productId, 10);
  const quantity = Math.max(1, parseInt(req.body.quantity, 10) || 1);
  const product = productId ? await catalog.getProductById(productId) : null;

  if (!product || !product.active) {
    if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'Product not available.' });
    req.flash('error', 'That product is no longer available.');
    return res.redirect(safeRedirectPath(req.body.redirect, '/cart'));
  }

  const manageStock = settings.getBool('manage_stock');
  if (manageStock && product.stock <= 0) {
    if (wantsJson(req)) return res.status(409).json({ ok: false, error: 'This product is out of stock.' });
    req.flash('error', `${product.name} is out of stock.`);
    return res.redirect(safeRedirectPath(req.body.redirect, '/cart'));
  }

  const cart = commerce.normalizeCart(req.session.cart);
  let next = (cart[productId] || 0) + quantity;
  if (manageStock) next = Math.min(next, Math.max(1, product.stock));
  req.session.cart = commerce.setQuantity(cart, productId, next);

  if (wantsJson(req)) return cartJson(req, res);
  req.flash('success', `Added ${product.name} to your cart.`);
  return res.redirect(safeRedirectPath(req.body.redirect, '/cart'));
});

router.post('/cart/update', async (req, res) => {
  const productId = parseInt(req.body.productId, 10);
  const quantity = parseInt(req.body.quantity, 10);
  if (!productId) return res.redirect('/cart');

  const cart = commerce.normalizeCart(req.session.cart);
  if (settings.getBool('manage_stock')) {
    const product = await catalog.getProductById(productId);
    if (product && quantity > product.stock) {
      req.flash('error', `Only ${product.stock} of ${product.name} available.`);
      req.session.cart = commerce.setQuantity(cart, productId, Math.max(product.stock, 0));
      return res.redirect('/cart');
    }
  }
  req.session.cart = commerce.setQuantity(cart, productId, quantity);

  if (wantsJson(req)) return cartJson(req, res);
  return res.redirect('/cart');
});

router.post('/cart/remove', async (req, res) => {
  const productId = parseInt(req.body.productId, 10);
  const cart = commerce.normalizeCart(req.session.cart);
  delete cart[productId];
  req.session.cart = cart;

  if (wantsJson(req)) return cartJson(req, res);
  req.flash('success', 'Item removed from your cart.');
  return res.redirect('/cart');
});

/* ── Checkout ───────────────────────────────────────────── */

router.get('/checkout', async (req, res) => {
  const cart = await commerce.buildCart(req.session.cart);
  if (cart.items.length === 0) {
    req.flash('error', 'Your cart is empty.');
    return res.redirect('/cart');
  }
  res.render('shop/checkout', {
    title: 'Checkout',
    metaDescription: 'Complete your order.',
    cart,
    paymentMethods: commerce.PAYMENT_METHODS,
    errors: {},
    form: {}
  });
});

router.post('/checkout', async (req, res) => {
  const cart = await commerce.buildCart(req.session.cart);
  const paymentMethods = commerce.PAYMENT_METHODS;

  if (cart.items.length === 0) {
    req.flash('error', 'Your cart is empty.');
    return res.redirect('/cart');
  }

  const form = {
    name: str(req.body.name, 120),
    email: str(req.body.email, 160),
    phone: str(req.body.phone, 40),
    address: str(req.body.address, 600),
    note: str(req.body.note, 600),
    paymentMethod: str(req.body.payment_method, 30) || 'pay_on_delivery'
  };

  const errors = {};
  if (form.name.length < 2) errors.name = 'Please enter your full name.';
  if (!isEmail(form.email)) errors.email = 'Please enter a valid email address.';
  if (form.address.length < 10) errors.address = 'Please enter a delivery address (at least 10 characters).';
  if (!paymentMethods.some((m) => m.value === form.paymentMethod)) {
    errors.paymentMethod = 'Please choose a payment method.';
  }

  if (Object.keys(errors).length > 0) {
    res.status(422);
    return res.render('shop/checkout', {
      title: 'Checkout',
      metaDescription: 'Complete your order.',
      cart,
      paymentMethods,
      errors,
      form
    });
  }

  const order = await commerce.createOrder({
    customer: {
      name: form.name,
      email: form.email,
      phone: form.phone,
      address: form.address,
      note: form.note
    },
    cart,
    paymentMethod: form.paymentMethod
  });

  delete req.session.cart;
  return res.redirect(`/order/${order.reference}`);
});

router.get('/order/:reference', async (req, res, next) => {
  const order = await commerce.getOrderByReference(str(req.params.reference, 40));
  if (!order) return next();

  const items = await commerce.getOrderItems(order.id);

  res.render('shop/order', {
    title: `Order ${order.reference}`,
    metaDescription: 'Your order confirmation.',
    order,
    items
  });
});

/* ── Static content ─────────────────────────────────────── */

router.get('/about', (req, res) => {
  res.render('shop/about', {
    title: 'About us',
    metaDescription: `About ${settings.get('store_name')}.`,
    body: settings.get('about_text')
  });
});

router.get('/contact', (req, res) => {
  res.render('shop/contact', {
    title: 'Contact',
    metaDescription: `Get in touch with ${settings.get('store_name')}.`
  });
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /cart',
      'Disallow: /checkout',
      '',
      `Sitemap: ${config.siteUrl}/sitemap.xml`,
      ''
    ].join('\n')
  );
});

router.get('/sitemap.xml', async (req, res) => {
  const [products, categories] = await Promise.all([
    catalog.listProducts({ perPage: 60, sort: 'newest' }),
    catalog.listCategories({ includeEmpty: false })
  ]);

  const urls = ['/', '/products', '/about', '/contact']
    .concat(categories.map((category) => `/category/${category.slug}`))
    .concat(products.items.map((product) => `/product/${product.slug}`));

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((url) => `  <url><loc>${config.siteUrl}${url}</loc></url>`).join('\n') +
    '\n</urlset>\n';

  res.type('application/xml').send(body);
});

module.exports = router;
