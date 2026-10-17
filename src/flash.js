'use strict';

function addFlash(req, type, message) {
  if (!req.session) return;
  if (!Array.isArray(req.session.flash)) req.session.flash = [];
  req.session.flash.push({ type, message });
}

// Exposes the flash queued by the previous request, then clears it.
function flashMiddleware(req, res, next) {
  const queued = (req.session && req.session.flash) || [];
  res.locals.flash = queued;
  if (req.session) req.session.flash = [];
  req.flash = (type, message) => addFlash(req, type, message);
  next();
}

module.exports = { addFlash, flashMiddleware };
