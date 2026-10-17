'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');

const config = require('./src/config');
const db = require('./src/db');
const settings = require('./src/settings');
const catalog = require('./src/catalog');
const auth = require('./src/auth');
const seed = require('./src/seed');
const { PostgresSessionStore } = require('./src/session-store');
const { asyncHandler } = require('./src/lib/async');
const { csrfProtection } = require('./src/csrf');
const { flashMiddleware } = require('./src/flash');
const {
  formatMoney,
  formatDate,
  formatDateTime,
  formatRelative,
  truncate,
  pluralize
} = require('./src/lib/format');

const app = express();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Templates are re-read on every request in development, compiled once in production.
app.set('view cache', config.isProduction);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: config.isProduction ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  })
);

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
    etag: true
  })
);

app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

app.use(
  session({
    name: 'acustore.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    // Sessions now live in Postgres, so they survive a restart and are shared
    // across instances.
    store: new PostgresSessionStore(db.pool, { ttlMs: config.sessionMaxAgeMs }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: config.sessionMaxAgeMs
    }
  })
);

app.use(auth.attachAdmin);
app.use(flashMiddleware);

app.use(
  asyncHandler(async (req, res, next) => {
    const store = settings.all();
    res.locals.store = store;
    res.locals.siteUrl = config.siteUrl;
    res.locals.currentPath = req.path;
    res.locals.currentUrl = req.originalUrl;
    res.locals.query = req.query;
    res.locals.manageStock = store.manage_stock === '1';
    res.locals.navCategories = (await catalog.listCategories({ includeEmpty: false })).slice(0, 6);
    res.locals.money = (cents) => formatMoney(cents, store.currency_symbol || '$');
    res.locals.formatDate = formatDate;
    res.locals.formatDateTime = formatDateTime;
    res.locals.formatRelative = formatRelative;
    res.locals.truncate = truncate;
    res.locals.pluralize = pluralize;
    res.locals.cartCount = (() => {
      const cart = (req.session && req.session.cart) || {};
      return Object.values(cart).reduce((sum, qty) => sum + (parseInt(qty, 10) || 0), 0);
    })();
    next();
  })
);

app.use(csrfProtection);

app.use('/api', require('./src/routes/api'));
app.use('/admin', require('./src/routes/admin'));
app.use('/', require('./src/routes/shop'));

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((req, res) => {
  res.status(404);
  if (req.path.startsWith('/api')) return res.json({ error: 'Not found.' });
  return res.render('error', {
    title: 'Page not found',
    status: 404,
    message: 'We could not find the page you were looking for.'
  });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status);
  if (req.path.startsWith('/api')) return res.json({ error: 'Something went wrong.' });
  return res.render('error', {
    title: 'Something went wrong',
    status,
    message: config.isProduction
      ? 'Something went wrong on our end. Please try again in a moment.'
      : err.message
  });
});

function databaseLabel() {
  try {
    const url = new URL(config.databaseUrl);
    return `${url.hostname}${url.pathname}${url.hostname.includes('-pooler') ? ' (pooled)' : ''}`;
  } catch {
    return '(unconfigured)';
  }
}

/**
 * Boot order matters: settings are cached in memory and must be loaded before the
 * first request, and the seed check needs the schema to exist.
 */
async function start() {
  await settings.load();
  const result = await seed.run();

  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, () => {
      console.log('');
      console.log(`  ${settings.get('store_name')} is running`);
      console.log(`  Mode      ${config.env}${config.isProduction ? ' (templates cached)' : ''}`);
      console.log(`  Database  ${databaseLabel()}`);
      console.log(`  Store     http://localhost:${config.port}`);
      console.log(`  Admin     http://localhost:${config.port}/admin`);
      if (result.admin.created) {
        console.log(`  Admin account created: ${result.admin.email}`);
      }
      if (result.sample.created) {
        console.log(`  Loaded sample catalog: ${result.sample.categories} categories, ${result.sample.products} products`);
      }
      console.log('');
      resolve(server);
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, start };
