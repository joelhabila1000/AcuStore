'use strict';

function str(value, max = 5000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(str(value));
}

function toInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value) {
  const v = String(value).toLowerCase();
  return v === 'true' || v === 'on' || v === '1' || v === 'yes';
}

function isUrl(value) {
  const v = str(value);
  if (!v) return false;
  try {
    const url = new URL(v);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Only allow same-site absolute paths, so a `redirect` form field can never
// bounce a visitor to another origin.
function safeRedirectPath(value, fallback = '/') {
  const path = str(value, 500);
  if (!path || !path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}

module.exports = { str, isEmail, toInt, toBool, isUrl, safeRedirectPath };
