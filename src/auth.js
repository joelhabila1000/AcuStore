'use strict';

const bcrypt = require('bcryptjs');
const db = require('./db');

const ROUNDS = 12;

// bcrypt is CPU-bound and synchronous by design here; hashing two or three rows
// per admin action is nowhere near worth offloading a thread for.
function hashPassword(password) {
  return bcrypt.hashSync(String(password), ROUNDS);
}

function verifyPassword(password, hash) {
  try {
    return bcrypt.compareSync(String(password), String(hash || ''));
  } catch {
    return false;
  }
}

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function findByEmail(email) {
  return db.one('SELECT * FROM admins WHERE lower(email) = lower($1)', [String(email || '').trim()]);
}

async function findById(id) {
  const parsed = parseId(id);
  if (!parsed) return null;
  return db.one('SELECT * FROM admins WHERE id = $1', [parsed]);
}

async function createAdmin({ name, email, password }) {
  return db.one(
    'INSERT INTO admins (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *',
    [String(name || 'Administrator').trim(), String(email).trim(), hashPassword(password)],
  );
}

async function updatePassword(id, password) {
  await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [
    hashPassword(password),
    parseId(id),
  ]);
}

async function updateProfile(id, { name, email }) {
  await db.query('UPDATE admins SET name = $1, email = $2 WHERE id = $3', [
    String(name).trim(),
    String(email).trim(),
    parseId(id),
  ]);
}

async function count() {
  const row = await db.one('SELECT count(*)::int AS n FROM admins');
  return row ? row.n : 0;
}

/**
 * Attaches the signed-in admin to the request. Async because it hits the
 * database; wrapped so a rejection reaches the error handler instead of hanging.
 */
async function attachAdmin(req, res, next) {
  try {
    req.admin = null;
    if (req.session && req.session.adminId) {
      const admin = await findById(req.session.adminId);
      if (admin) req.admin = admin;
      else delete req.session.adminId;
    }
    res.locals.currentAdmin = req.admin;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.admin) return next();
  if (req.session) req.session.returnTo = req.originalUrl;
  return res.redirect('/admin/login');
}

module.exports = {
  hashPassword,
  verifyPassword,
  findByEmail,
  findById,
  createAdmin,
  updatePassword,
  updateProfile,
  count,
  attachAdmin,
  requireAdmin
};
