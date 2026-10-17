'use strict';

/**
 * Express 4 does not understand async handlers: a rejected promise from an
 * `async` route is an unhandled rejection, not a 500. `asyncHandler` forwards the
 * rejection to the error middleware.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const WRAPPABLE = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

/**
 * Patches every handler registered on `router` from this point on, so route files
 * can stay idiomatic (`router.get('/x', async (req,res) => …)`) without each one
 * being individually wrapped — and without a single missed wrapper silently
 * turning a bug into a hung request.
 */
function wrapRouter(router) {
  for (const method of WRAPPABLE) {
    const original = router[method].bind(router);
    router[method] = (...args) => {
      const wrapped = args.map((arg) => (typeof arg === 'function' ? asyncHandler(arg) : arg));
      return original(...wrapped);
    };
  }
  return router;
}

module.exports = { asyncHandler, wrapRouter };
