'use strict';

/**
 * End-to-end smoke test for the Neon-backed Express app.
 *
 *   node src/scripts/smoke-neon.js
 *
 * Registers a throwaway admin, signs in through the real login form (CSRF token
 * included), walks the authenticated admin pages, then deletes that account.
 * Your own admin account is never touched.
 */

const origin = `http://localhost:${process.env.PORT || 3000}`;
const cookies = new Map();
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail || ''}`}`);
}

function storeCookies(response) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

async function request(path, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (cookies.size) headers.Cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  const response = await fetch(origin + path, {
    method: options.method,
    redirect: options.redirect || 'manual',
    headers,
    body: options.body
  });
  storeCookies(response);
  return { status: response.status, location: response.headers.get('location'), text: await response.text() };
}

const form = (object) => new URLSearchParams(object).toString();
const csrfFrom = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function main() {
  const db = require('../db');
  const auth = require('../auth');

  const TEMP_EMAIL = 'smoke-test-admin@acustore.local';
  const TEMP_PASSWORD = 'TempSmokePass123!';

  // Clean up anything left by a previous failed run.
  await db.query('DELETE FROM admins WHERE email = $1', [TEMP_EMAIL]);
  await auth.createAdmin({ name: 'Smoke Test', email: TEMP_EMAIL, password: TEMP_PASSWORD });

  try {
    const home = await request('/', { redirect: 'follow' });
    check('GET / returns 200', home.status === 200, `status ${home.status}`);
    check('home renders the catalog', /Stoneware Coffee Mug|Wireless Earbuds/.test(home.text));
    check('home shows the Naira symbol', home.text.includes('₦'));

    const products = await request('/products', { redirect: 'follow' });
    check('GET /products returns 200', products.status === 200, `status ${products.status}`);

    const api = await request('/api/products');
    let payload = null;
    try {
      payload = JSON.parse(api.text);
    } catch {
      /* asserted below */
    }
    check('GET /api/products returns JSON', api.status === 200 && Array.isArray(payload?.data), `status ${api.status}`);
    check('API exposes all 22 products', payload?.data?.length === 22, `got ${payload?.data?.length}`);

    const slug = payload?.data?.[0]?.slug;
    const product = await request(`/product/${slug}`, { redirect: 'follow' });
    check('GET /product/:slug returns 200', product.status === 200, `status ${product.status}`);

    const cart = await request('/cart', { redirect: 'follow' });
    check('GET /cart returns 200', cart.status === 200, `status ${cart.status}`);

    // ── Write path: cart → checkout → order (transaction + stock) ────────────
    const homeToken = csrfFrom(home.text);
    const firstProductId = payload?.data?.[0]?.id;

    const added = await request('/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ _csrf: homeToken, productId: firstProductId, quantity: '2', redirect: '/cart' }),
    });
    check('add to cart succeeds', added.status === 302, `status ${added.status}`);

    const checkoutPage = await request('/checkout', { redirect: 'follow' });
    check('checkout renders with the item', checkoutPage.status === 200 && /Place order/.test(checkoutPage.text), `status ${checkoutPage.status}`);

    const checkoutToken = csrfFrom(checkoutPage.text);
    const placed = await request('/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        _csrf: checkoutToken,
        name: 'Neon Migration Test',
        email: 'neon-test@acustore.local',
        phone: '5550000',
        address: '1 Test Street, Lagos',
        payment_method: 'pay_on_delivery',
      }),
    });
    check('checkout creates an order', placed.status === 302 && /\/order\//.test(placed.location || ''), `status ${placed.status} loc ${placed.location}`);

    const reference = String(placed.location || '').split('/order/')[1];
    const orderPage = await request(`/order/${reference}`, { redirect: 'follow' });
    check('order confirmation renders', orderPage.status === 200 && orderPage.text.includes(reference), `status ${orderPage.status}`);

    // Remove the test order so the database is left exactly as we found it.
    await db.query('DELETE FROM orders WHERE reference = $1', [reference]);
    const remaining = await db.one('SELECT count(*)::int AS n FROM orders WHERE reference = $1', [reference]);
    check('test order cleaned up', remaining.n === 0);

    const guarded = await request('/admin');
    check('/admin redirects when signed out', guarded.status === 302, `status ${guarded.status}`);

    const loginPage = await request('/admin/login', { redirect: 'follow' });
    const csrf = csrfFrom(loginPage.text);
    check('admin login page renders', loginPage.status === 200 && Boolean(csrf));

    const login = await request('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ _csrf: csrf, email: TEMP_EMAIL, password: TEMP_PASSWORD })
    });
    check('admin login succeeds', login.status === 302 && (login.location || '') === '/admin', `status ${login.status} loc ${login.location}`);

    const dashboard = await request('/admin', { redirect: 'follow' });
    check('admin dashboard renders', dashboard.status === 200 && /Revenue/.test(dashboard.text), `status ${dashboard.status}`);
    check('dashboard reads live order data', /Orders/.test(dashboard.text));

    const adminProducts = await request('/admin/products', { redirect: 'follow' });
    check(
      'admin products list renders',
      adminProducts.status === 200 &&
        /New product/.test(adminProducts.text) &&
        /\/admin\/products\/\d+\/edit/.test(adminProducts.text),
      `status ${adminProducts.status}`,
    );

    const adminOrders = await request('/admin/orders', { redirect: 'follow' });
    check('admin orders list renders', adminOrders.status === 200 && /ACU-/.test(adminOrders.text), `status ${adminOrders.status}`);

    const adminSettings = await request('/admin/settings', { redirect: 'follow' });
    check('admin settings renders', adminSettings.status === 200 && /Store identity/.test(adminSettings.text), `status ${adminSettings.status}`);

    const adminCategories = await request('/admin/categories', { redirect: 'follow' });
    check('admin categories renders', adminCategories.status === 200 && /Home &amp; Kitchen|Home & Kitchen/.test(adminCategories.text), `status ${adminCategories.status}`);
  } finally {
    await db.query('DELETE FROM admins WHERE email = $1', [TEMP_EMAIL]);
    await db.close();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exitCode = 1;
});
