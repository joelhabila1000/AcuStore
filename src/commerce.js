'use strict';

const crypto = require('crypto');
const db = require('./db');
const settings = require('./settings');

const ORDER_STATUSES = [
  { value: 'pending', label: 'Pending', tone: 'warn' },
  { value: 'paid', label: 'Paid', tone: 'info' },
  { value: 'processing', label: 'Processing', tone: 'info' },
  { value: 'shipped', label: 'Shipped', tone: 'info' },
  { value: 'completed', label: 'Completed', tone: 'ok' },
  { value: 'cancelled', label: 'Cancelled', tone: 'danger' }
];

const PAYMENT_METHODS = [
  { value: 'pay_on_delivery', label: 'Pay on delivery' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'contact_me', label: 'Contact me to arrange payment' }
];

function statusLabel(status) {
  const found = ORDER_STATUSES.find((s) => s.value === status);
  return found ? found.label : status;
}

function statusTone(status) {
  const found = ORDER_STATUSES.find((s) => s.value === status);
  return found ? found.tone : 'info';
}

function paymentLabel(value) {
  const found = PAYMENT_METHODS.find((m) => m.value === value);
  return found ? found.label : value;
}

function normalizeCart(cart) {
  const out = {};
  if (!cart || typeof cart !== 'object') return out;
  for (const [key, value] of Object.entries(cart)) {
    const id = parseInt(key, 10);
    const qty = parseInt(value, 10);
    if (Number.isInteger(id) && id > 0 && Number.isInteger(qty) && qty > 0) {
      out[id] = Math.min(qty, 99);
    }
  }
  return out;
}

function maxQuantity(product) {
  return settings.getBool('manage_stock') ? Math.max(0, product.stock) : 99;
}

// Resolves a session cart map into line items plus totals, ignoring products
// that have since been deactivated or removed.
async function buildCart(cartMap) {
  const cart = normalizeCart(cartMap);
  const ids = Object.keys(cart).map(Number);
  const items = [];

  if (ids.length) {
    // A single query with an array parameter — no placeholder string building.
    const rows = await db.many(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = true AND p.id = ANY($1::int[])`,
      [ids],
    );
    const manageStock = settings.getBool('manage_stock');

    for (const product of rows) {
      let quantity = cart[product.id];
      if (manageStock && product.stock > 0) quantity = Math.min(quantity, product.stock);
      if (manageStock && product.stock <= 0) continue;
      items.push({
        product,
        quantity,
        unitPriceCents: product.price_cents,
        lineTotalCents: product.price_cents * quantity
      });
    }
  }

  const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const shippingFee = settings.getInt('shipping_fee_cents', 0);
  const freeThreshold = settings.getInt('free_shipping_threshold_cents', 0);

  let shippingCents = shippingFee;
  if (subtotalCents === 0) shippingCents = 0;
  else if (freeThreshold > 0 && subtotalCents >= freeThreshold) shippingCents = 0;

  return {
    items,
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    count: items.reduce((sum, item) => sum + item.quantity, 0),
    freeThreshold,
    shippingFee
  };
}

function setQuantity(cartMap, productId, quantity) {
  const cart = normalizeCart(cartMap);
  const id = parseInt(productId, 10);
  const qty = parseInt(quantity, 10);
  if (!Number.isInteger(id) || id <= 0) return cart;
  if (!Number.isInteger(qty) || qty <= 0) delete cart[id];
  else cart[id] = Math.min(qty, 99);
  return cart;
}

async function generateReference() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const reference = `ACU-${Date.now().toString(36).toUpperCase()}${crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;
    const existing = await db.one('SELECT 1 AS ok FROM orders WHERE reference = $1', [reference]);
    if (!existing) return reference;
  }
  return `ACU-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

/**
 * Creates the order, its items, and the stock decrement in one transaction.
 *
 * The whole unit of work runs on a single checked-out client, so a failure
 * anywhere rolls all of it back — an order is never left without its items, and
 * stock is never decremented for an order that did not commit.
 */
async function createOrder({ customer, cart, paymentMethod }) {
  const reference = await generateReference();
  const manageStock = settings.getBool('manage_stock');

  const orderId = await db.withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO orders
         (reference, customer_name, customer_email, customer_phone, shipping_address, note,
          payment_method, subtotal_cents, shipping_cents, total_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
       RETURNING id`,
      [
        reference,
        customer.name,
        customer.email,
        customer.phone || '',
        customer.address,
        customer.note || '',
        paymentMethod,
        cart.subtotalCents,
        cart.shippingCents,
        cart.totalCents
      ],
    );
    const id = inserted.rows[0].id;

    for (const item of cart.items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, image, unit_price_cents, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, item.product.id, item.product.name, item.product.image || '', item.unitPriceCents, item.quantity],
      );

      if (manageStock) {
        await client.query(
          'UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2',
          [item.quantity, item.product.id],
        );
      }
    }

    return id;
  });

  return getOrderById(orderId);
}

async function getOrderById(id) {
  return db.one('SELECT * FROM orders WHERE id = $1', [id]);
}

async function getOrderByReference(reference) {
  return db.one('SELECT * FROM orders WHERE reference = $1', [reference]);
}

async function getOrderItems(orderId) {
  return db.many('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [orderId]);
}

async function listOrders({ status = '', page = 1, perPage = 20, q = '' } = {}) {
  const where = [];
  const params = [];

  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  const term = String(q || '').trim();
  if (term) {
    params.push(`%${term}%`);
    const n = params.length;
    where.push(`(reference ILIKE $${n} OR customer_name ILIKE $${n} OR customer_email ILIKE $${n})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = await db.one(`SELECT count(*)::int AS n FROM orders ${whereSql}`, params);
  const total = totalRow ? totalRow.n : 0;

  const perPageSafe = Math.min(Math.max(parseInt(perPage, 10) || 20, 1), 100);
  const totalPages = Math.max(1, Math.ceil(total / perPageSafe));
  const currentPage = Math.min(Math.max(parseInt(page, 10) || 1, 1), totalPages);

  const items = await db.many(
    `SELECT o.*,
            (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items i WHERE i.order_id = o.id) AS item_count
     FROM orders o ${whereSql}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPageSafe, (currentPage - 1) * perPageSafe],
  );

  return { items, total, page: currentPage, perPage: perPageSafe, totalPages };
}

async function updateOrderStatus(id, status) {
  if (!ORDER_STATUSES.some((s) => s.value === status)) return false;
  const result = await db.query('UPDATE orders SET status = $1 WHERE id = $2', [status, id]);
  return result.rowCount > 0;
}

async function dashboardStats() {
  return db.one(
    `SELECT
       (SELECT count(*)::int FROM orders) AS order_count,
       (SELECT count(*)::int FROM orders WHERE status = 'pending') AS pending_orders,
       (SELECT COALESCE(SUM(total_cents), 0)::bigint FROM orders WHERE status <> 'cancelled') AS revenue_cents,
       (SELECT count(*)::int FROM products) AS product_count,
       (SELECT count(*)::int FROM products WHERE active = true) AS active_products,
       (SELECT count(*)::int FROM products WHERE stock <= 5 AND active = true) AS low_stock,
       (SELECT count(*)::int FROM categories) AS category_count`,
  );
}

async function recentOrders(limit = 6) {
  return db.many('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT $1', [limit]);
}

module.exports = {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  statusLabel,
  statusTone,
  paymentLabel,
  normalizeCart,
  buildCart,
  setQuantity,
  maxQuantity,
  createOrder,
  getOrderById,
  getOrderByReference,
  getOrderItems,
  listOrders,
  updateOrderStatus,
  dashboardStats,
  recentOrders
};
