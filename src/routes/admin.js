'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const catalog = require('../catalog');
const commerce = require('../commerce');
const settings = require('../settings');
const { wrapRouter } = require('../lib/async');
const { parseMoneyToCents } = require('../lib/format');
const { str, isEmail, toBool } = require('../lib/validate');

const router = express.Router();

// Admin handlers are async now that they query Postgres.
wrapRouter(router);

/* ── Image uploads ──────────────────────────────────────── */

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif']
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = MIME_EXTENSIONS.get(file.mimetype) || '.img';
    cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (MIME_EXTENSIONS.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WebP, GIF or AVIF images are supported.'));
  }
});

function uploadSingle(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'That image is too large (max 5MB).' : err.message);
    const back = req.get('referer') || '/admin/products';
    return res.redirect(back);
  });
}

function removeUploadedImage(imagePath) {
  if (!imagePath || !imagePath.startsWith('/uploads/')) return;
  const file = path.join(config.uploadsDir, path.basename(imagePath));
  fs.promises.unlink(file).catch(() => {});
}

/* ── Authentication ─────────────────────────────────────── */

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('admin/login', {
      title: 'Sign in',
      error: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
      email: str(req.body.email, 160)
    });
  }
});

router.get('/login', (req, res) => {
  if (req.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Sign in', error: null, email: '' });
});

router.post('/login', loginLimiter, async (req, res, next) => {
  const email = str(req.body.email, 160);
  const password = String(req.body.password || '');
  const admin = await auth.findByEmail(email);

  if (!admin || !auth.verifyPassword(password, admin.password_hash)) {
    req.flash('error', 'Incorrect email or password.');
    return res.redirect('/admin/login');
  }

  const returnTo = req.session.returnTo && req.session.returnTo.startsWith('/admin')
    ? req.session.returnTo
    : '/admin';

  return req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.adminId = admin.id;
    return req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect(returnTo);
    });
  });
});

router.post('/logout', (req, res) => {
  if (!req.session) return res.redirect('/admin/login');
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Everything past this point requires a signed-in admin.
router.use(auth.requireAdmin);

/* ── Dashboard ──────────────────────────────────────────── */

router.get('/', async (req, res) => {
  // Three independent reads — issue them together.
  const [stats, recentOrders, lowStock] = await Promise.all([
    commerce.dashboardStats(),
    commerce.recentOrders(6),
    catalog.lowStockProducts(5)
  ]);

  res.render('admin/dashboard', {
    title: 'Dashboard',
    active: 'dashboard',
    stats,
    recentOrders,
    lowStock
  });
});

/* ── Products ───────────────────────────────────────────── */

router.get('/products', async (req, res) => {
  const q = str(req.query.q, 120);
  const page = parseInt(req.query.page, 10) || 1;
  const result = await catalog.listProducts({
    q,
    page,
    perPage: 20,
    sort: 'newest',
    includeInactive: true
  });

  res.render('admin/products', {
    title: 'Products',
    active: 'products',
    result,
    q
  });
});

router.get('/products/new', async (req, res) => {
  res.render('admin/product-form', {
    title: 'New product',
    active: 'products',
    product: null,
    categories: await catalog.listCategories(),
    errors: {},
    form: { active: true }
  });
});

function readProductForm(req) {
  const name = str(req.body.name, 160);
  const priceCents = parseMoneyToCents(req.body.price);
  const compareRaw = str(req.body.compare_at_price, 20);
  const compareCents = compareRaw ? parseMoneyToCents(compareRaw) : null;
  const stock = parseInt(req.body.stock, 10);

  const errors = {};
  if (name.length < 2) errors.name = 'Please enter a product name.';
  if (!Number.isFinite(priceCents)) errors.price = 'Enter a valid price, e.g. 19.99';
  if (compareCents !== null && !Number.isFinite(compareCents)) {
    errors.compareAtPrice = 'Enter a valid compare-at price.';
  }
  if (!Number.isFinite(stock) || stock < 0) errors.stock = 'Stock must be zero or more.';

  const categoryId = req.body.category_id ? parseInt(req.body.category_id, 10) : null;

  const form = {
    name,
    slug: str(req.body.slug, 120),
    description: str(req.body.description, 20000),
    price: str(req.body.price, 20),
    compareAtPrice: compareRaw,
    sku: str(req.body.sku, 60),
    stock: Number.isFinite(stock) ? stock : 0,
    categoryId: Number.isInteger(categoryId) ? categoryId : null,
    imageUrl: str(req.body.image_url, 500),
    removeImage: toBool(req.body.remove_image),
    featured: toBool(req.body.featured),
    active: toBool(req.body.active)
  };

  const data = {
    name,
    slug: form.slug,
    description: form.description,
    price_cents: Number.isFinite(priceCents) ? priceCents : 0,
    compare_at_cents: compareCents !== null && Number.isFinite(compareCents) ? compareCents : null,
    sku: form.sku,
    stock: form.stock,
    category_id: form.categoryId,
    featured: form.featured,
    active: form.active
  };

  return { errors, form, data };
}

function resolveImage(req, form, existing) {
  if (req.file) return `/uploads/${req.file.filename}`;
  if (form.removeImage) return '';
  if (form.imageUrl) return form.imageUrl;
  return existing || '';
}

router.post('/products', uploadSingle, async (req, res) => {
  const { errors, form, data } = readProductForm(req);
  const image = resolveImage(req, form, '');

  if (Object.keys(errors).length > 0) {
    if (req.file) removeUploadedImage(`/uploads/${req.file.filename}`);
    res.status(422);
    return res.render('admin/product-form', {
      title: 'New product',
      active: 'products',
      product: null,
      categories: await catalog.listCategories(),
      errors,
      form
    });
  }

  const product = await catalog.createProduct({ ...data, image });
  req.flash('success', `Created “${product.name}”.`);
  res.redirect('/admin/products');
});

router.get('/products/:id/edit', async (req, res, next) => {
  const product = await catalog.getProductById(parseInt(req.params.id, 10));
  if (!product) return next();

  res.render('admin/product-form', {
    title: `Edit ${product.name}`,
    active: 'products',
    product,
    categories: await catalog.listCategories(),
    errors: {},
    form: {
      name: product.name,
      slug: product.slug,
      description: product.description,
      price: (product.price_cents / 100).toFixed(2),
      compareAtPrice: product.compare_at_cents ? (product.compare_at_cents / 100).toFixed(2) : '',
      sku: product.sku,
      stock: product.stock,
      categoryId: product.category_id,
      imageUrl: product.image && !product.image.startsWith('/uploads/') ? product.image : '',
      removeImage: false,
      featured: Boolean(product.featured),
      active: Boolean(product.active)
    }
  });
});

router.post('/products/:id', uploadSingle, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const existing = await catalog.getProductById(id);
  if (!existing) return next();

  const { errors, form, data } = readProductForm(req);
  const image = resolveImage(req, form, existing.image);

  if (Object.keys(errors).length > 0) {
    if (req.file) removeUploadedImage(`/uploads/${req.file.filename}`);
    res.status(422);
    return res.render('admin/product-form', {
      title: `Edit ${existing.name}`,
      active: 'products',
      product: existing,
      categories: await catalog.listCategories(),
      errors,
      form
    });
  }

  if (image !== existing.image) removeUploadedImage(existing.image);

  const product = await catalog.updateProduct(id, { ...data, image });
  req.flash('success', `Saved “${product.name}”.`);
  res.redirect('/admin/products');
});

router.post('/products/:id/delete', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const product = await catalog.getProductById(id);
  if (!product) return next();

  await catalog.deleteProduct(id);
  removeUploadedImage(product.image);
  req.flash('success', `Deleted “${product.name}”.`);
  res.redirect('/admin/products');
});

/* ── Categories ─────────────────────────────────────────── */

router.get('/categories', async (req, res) => {
  res.render('admin/categories', {
    title: 'Categories',
    active: 'categories',
    categories: await catalog.listCategories(),
    errors: {},
    form: {}
  });
});

router.post('/categories', async (req, res) => {
  const name = str(req.body.name, 120);
  const errors = {};
  if (name.length < 2) errors.name = 'Please enter a category name.';

  if (Object.keys(errors).length > 0) {
    res.status(422);
    return res.render('admin/categories', {
      title: 'Categories',
      active: 'categories',
      categories: await catalog.listCategories(),
      errors,
      form: { name }
    });
  }

  const category = await catalog.createCategory({
    name,
    slug: str(req.body.slug, 120),
    description: str(req.body.description, 1000),
    position: parseInt(req.body.position, 10) || 0
  });
  req.flash('success', `Created category “${category.name}”.`);
  res.redirect('/admin/categories');
});

router.post('/categories/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const existing = await catalog.getCategoryById(id);
  if (!existing) return next();

  const name = str(req.body.name, 120);
  if (name.length < 2) {
    req.flash('error', 'Category name is required.');
    return res.redirect('/admin/categories');
  }

  const category = await catalog.updateCategory(id, {
    name,
    slug: str(req.body.slug, 120),
    description: str(req.body.description, 1000),
    position: parseInt(req.body.position, 10) || 0
  });
  req.flash('success', `Saved category “${category.name}”.`);
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const category = await catalog.getCategoryById(id);
  if (!category) return next();

  await catalog.deleteCategory(id);
  req.flash('success', `Deleted category “${category.name}”. Its products are now uncategorised.`);
  res.redirect('/admin/categories');
});

/* ── Orders ─────────────────────────────────────────────── */

router.get('/orders', async (req, res) => {
  const status = str(req.query.status, 30);
  const q = str(req.query.q, 120);
  const result = await commerce.listOrders({
    status,
    page: parseInt(req.query.page, 10) || 1,
    perPage: 20,
    q
  });

  res.render('admin/orders', {
    title: 'Orders',
    active: 'orders',
    result,
    status,
    q,
    statuses: commerce.ORDER_STATUSES
  });
});

router.get('/orders/:id', async (req, res, next) => {
  const order = await commerce.getOrderById(parseInt(req.params.id, 10));
  if (!order) return next();

  const items = await commerce.getOrderItems(order.id);

  res.render('admin/order', {
    title: `Order ${order.reference}`,
    active: 'orders',
    order,
    items,
    statuses: commerce.ORDER_STATUSES
  });
});

router.post('/orders/:id/status', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const order = await commerce.getOrderById(id);
  if (!order) return next();

  const status = str(req.body.status, 30);
  const updated = await commerce.updateOrderStatus(id, status);

  if (!updated) {
    req.flash('error', 'That order status is not valid.');
  } else {
    req.flash('success', `Order ${order.reference} marked as ${commerce.statusLabel(status).toLowerCase()}.`);
  }
  res.redirect(`/admin/orders/${id}`);
});

router.post('/orders/:id/delete', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const order = await commerce.getOrderById(id);
  if (!order) return next();

  await db.query('DELETE FROM orders WHERE id = $1', [id]);
  req.flash('success', `Deleted order ${order.reference}.`);
  res.redirect('/admin/orders');
});

/* ── Settings ───────────────────────────────────────────── */

const TEXT_SETTING_KEYS = [
  'store_name',
  'tagline',
  'announcement',
  'hero_title',
  'hero_subtitle',
  'hero_cta_label',
  'hero_cta_href',
  'hero_image',
  'currency_symbol',
  'currency_code',
  'products_per_page',
  'contact_email',
  'contact_phone',
  'address',
  'about_text',
  'payment_instructions',
  'footer_text',
  'social_instagram',
  'social_twitter',
  'social_facebook'
];

function settingsViewValues() {
  const values = settings.all();
  return {
    ...values,
    shipping_fee: (settings.getInt('shipping_fee_cents', 0) / 100).toFixed(2),
    free_shipping_threshold: (settings.getInt('free_shipping_threshold_cents', 0) / 100).toFixed(2)
  };
}

router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    title: 'Store settings',
    active: 'settings',
    s: settingsViewValues(),
    errors: {}
  });
});

router.post('/settings', async (req, res) => {
  const errors = {};
  const values = {};

  for (const key of TEXT_SETTING_KEYS) values[key] = str(req.body[key], 20000);

  const submitted = { ...values };

  const shipping = parseMoneyToCents(str(req.body.shipping_fee, 20) || '0');
  if (!Number.isFinite(shipping)) errors.shipping_fee = 'Enter a valid amount.';
  else values.shipping_fee_cents = String(shipping);

  const threshold = parseMoneyToCents(str(req.body.free_shipping_threshold, 20) || '0');
  if (!Number.isFinite(threshold)) errors.free_shipping_threshold = 'Enter a valid amount.';
  else values.free_shipping_threshold_cents = String(threshold);

  const perPage = parseInt(values.products_per_page, 10);
  if (!Number.isFinite(perPage) || perPage < 1 || perPage > 60) {
    errors.products_per_page = 'Choose a number between 1 and 60.';
  }

  if (!values.store_name) errors.store_name = 'Your store needs a name.';
  if (values.contact_email && !isEmail(values.contact_email)) {
    errors.contact_email = 'Enter a valid email address.';
  }
  if (!values.currency_symbol) errors.currency_symbol = 'Enter a currency symbol, e.g. $';

  values.manage_stock = toBool(req.body.manage_stock) ? '1' : '0';

  if (Object.keys(errors).length > 0) {
    res.status(422);
    return res.render('admin/settings', {
      title: 'Store settings',
      active: 'settings',
      s: { ...settingsViewValues(), ...submitted, manage_stock: values.manage_stock },
      errors
    });
  }

  await settings.setMany(values);
  req.flash('success', 'Store settings saved.');
  res.redirect('/admin/settings');
});

/* ── Account ────────────────────────────────────────────── */

router.get('/account', (req, res) => {
  res.render('admin/account', {
    title: 'Your account',
    active: 'account',
    errors: {},
    form: { name: req.admin.name, email: req.admin.email }
  });
});

router.post('/account', async (req, res) => {
  const name = str(req.body.name, 120);
  const email = str(req.body.email, 160);
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  const wantsPasswordChange = Boolean(currentPassword || newPassword || confirmPassword);

  const errors = {};
  if (name.length < 2) errors.name = 'Please enter your name.';
  if (!isEmail(email)) errors.email = 'Please enter a valid email address.';
  if (wantsPasswordChange) {
    if (!auth.verifyPassword(currentPassword, req.admin.password_hash)) {
      errors.currentPassword = 'Your current password is incorrect.';
    } else if (newPassword.length < 8) {
      errors.newPassword = 'Your new password must be at least 8 characters.';
    } else if (newPassword !== confirmPassword) {
      errors.confirmPassword = 'The new passwords do not match.';
    }
  }

  if (Object.keys(errors).length > 0) {
    res.status(422);
    return res.render('admin/account', {
      title: 'Your account',
      active: 'account',
      errors,
      form: { name, email }
    });
  }

  await auth.updateProfile(req.admin.id, { name, email });
  if (wantsPasswordChange) await auth.updatePassword(req.admin.id, newPassword);

  req.flash('success', wantsPasswordChange ? 'Profile and password updated.' : 'Profile updated.');
  res.redirect('/admin/account');
});

module.exports = router;
