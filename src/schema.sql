-- acuStore — Postgres schema
--
-- Same logical model as the previous SQLite database, with the differences the
-- dialect requires:
--   • AUTOINCREMENT        → SERIAL
--   • TEXT timestamps      → TIMESTAMPTZ (real instants, not strings)
--   • INTEGER 0/1 flags    → BOOLEAN
--   • datetime('now')      → now()
--
-- Every statement is idempotent so this file can be applied repeatedly.

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL DEFAULT 'Administrator',
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL UNIQUE,
  description TEXT        NOT NULL DEFAULT '',
  position    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id               SERIAL PRIMARY KEY,
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL UNIQUE,
  description      TEXT        NOT NULL DEFAULT '',
  price_cents      INTEGER     NOT NULL DEFAULT 0,
  compare_at_cents INTEGER,
  sku              TEXT        NOT NULL DEFAULT '',
  stock            INTEGER     NOT NULL DEFAULT 0,
  category_id      INTEGER     REFERENCES categories(id) ON DELETE SET NULL,
  image            TEXT        NOT NULL DEFAULT '',
  featured         BOOLEAN     NOT NULL DEFAULT FALSE,
  active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id               SERIAL PRIMARY KEY,
  reference        TEXT        NOT NULL UNIQUE,
  customer_name    TEXT        NOT NULL,
  customer_email   TEXT        NOT NULL,
  customer_phone   TEXT        NOT NULL DEFAULT '',
  shipping_address TEXT        NOT NULL,
  note             TEXT        NOT NULL DEFAULT '',
  payment_method   TEXT        NOT NULL DEFAULT 'pay_on_delivery',
  subtotal_cents   INTEGER     NOT NULL DEFAULT 0,
  shipping_cents   INTEGER     NOT NULL DEFAULT 0,
  total_cents      INTEGER     NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'pending',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id               SERIAL PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name             TEXT    NOT NULL,
  image            TEXT    NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- expires_at stays a bigint epoch (milliseconds): the session store already works
-- in epoch ms and there is nothing to gain from a timestamptz round-trip here.
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT   NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);
CREATE INDEX IF NOT EXISTS idx_products_created  ON products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);

-- Typo-tolerant search: the app does ILIKE '%term%', which a trigram GIN index
-- can answer without a sequential scan once the catalog grows.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_desc_trgm ON products USING GIN (description gin_trgm_ops);
