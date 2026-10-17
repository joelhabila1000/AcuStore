'use strict';

function slugify(input) {
  const base = String(input == null ? '' : input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return base || 'item';
}

// `exists(candidate, currentId)` should return true when the slug is already
// taken by a different record, so we can append a numeric suffix.
function uniqueSlug(input, exists, currentId) {
  const base = slugify(input);
  let candidate = base;
  let n = 2;
  while (exists(candidate, currentId)) {
    candidate = `${base}-${n}`;
    if (++n > 200) {
      candidate = `${base}-${Date.now().toString(36)}`;
      break;
    }
  }
  return candidate;
}

module.exports = { slugify, uniqueSlug };
