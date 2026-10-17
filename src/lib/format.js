'use strict';

function formatMoney(cents, symbol = '$') {
  const value = Number(cents) || 0;
  const sign = value < 0 ? '-' : '';
  const amount = Math.abs(value) / 100;
  return (
    sign +
    symbol +
    amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

function parseMoneyToCents(input) {
  if (input === null || input === undefined) return NaN;
  const cleaned = String(input).replace(/[^0-9.]/g, '');
  if (!cleaned) return NaN;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return NaN;
  return Math.round(value * 100);
}

function toUtcDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  if (!raw) return null;
  let iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = toUtcDate(value);
  if (!date) return '';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  const date = toUtcDate(value);
  if (!date) return '';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatRelative(value) {
  const date = toUtcDate(value);
  if (!date) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86400],
    ['month', 2592000],
    ['year', 31536000]
  ];
  let label = 'year';
  let size = 31536000;
  for (const [name, secs] of units) {
    if (seconds < secs * 2) {
      label = name;
      size = secs;
      break;
    }
  }
  const n = Math.max(1, Math.floor(seconds / size));
  return `${n} ${label}${n > 1 ? 's' : ''} ago`;
}

function pluralize(count, singular, plural) {
  return Number(count) === 1 ? singular : plural || `${singular}s`;
}

function truncate(text, length = 120) {
  const value = String(text == null ? '' : text).trim();
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

module.exports = {
  formatMoney,
  parseMoneyToCents,
  toUtcDate,
  formatDate,
  formatDateTime,
  formatRelative,
  pluralize,
  truncate
};
