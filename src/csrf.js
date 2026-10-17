'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Issues a per-session token that templates render into forms, then verifies it
// on every mutating request (body field, query string, or X-CSRF-Token header).
function csrfProtection(req, res, next) {
  if (!req.session) return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  const expected = req.session.csrfToken;
  res.locals.csrfToken = expected;

  if (SAFE_METHODS.has(req.method)) return next();

  const provided = String(
    (req.body && (req.body._csrf || req.body.csrf)) ||
      (req.query && req.query._csrf) ||
      req.get('x-csrf-token') ||
      ''
  );

  const valid =
    provided.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (valid) return next();

  res.status(403);
  if (req.path.startsWith('/api') || req.accepts(['html', 'json']) === 'json') {
    return res.json({ error: 'Invalid or missing CSRF token.' });
  }
  return res.render('error', {
    title: 'Request blocked',
    status: 403,
    message: 'Your form was stale or your session expired. Go back, refresh the page and try again.'
  });
}

module.exports = { csrfProtection };
