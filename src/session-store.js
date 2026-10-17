'use strict';

const session = require('express-session');

/**
 * Postgres-backed session store.
 *
 * The interface express-session expects is callback-based, so each method wraps
 * the pool's promise. Unlike the previous SQLite store there are no prepared
 * statements to keep — pg handles parameterisation per call.
 *
 * `expires_at` is epoch milliseconds (bigint), matching the original schema.
 */
class PostgresSessionStore extends session.Store {
  constructor(pool, options = {}) {
    super(options);
    this.pool = pool;
    this.ttlMs = options.ttlMs || 1000 * 60 * 60 * 24 * 7;

    this.sweepTimer = setInterval(() => {
      this.pool
        .query('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()])
        .catch(() => {
          /* a failed sweep is harmless; the next one will retry */
        });
    }, 1000 * 60 * 60);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  expiry(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    const ms = expires ? new Date(expires).getTime() : Date.now() + this.ttlMs;
    return Number.isFinite(ms) ? ms : Date.now() + this.ttlMs;
  }

  get(sid, callback) {
    this.pool
      .query('SELECT data, expires_at FROM sessions WHERE sid = $1', [sid])
      .then((result) => {
        const row = result.rows[0];
        if (!row) return callback(null, null);

        // pg returns bigint as a string.
        if (Number(row.expires_at) <= Date.now()) {
          return this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid]).then(
            () => callback(null, null),
            () => callback(null, null),
          );
        }

        return callback(null, JSON.parse(row.data));
      })
      .catch((error) => callback(error));
  }

  set(sid, sess, callback) {
    const data = JSON.stringify(sess);
    this.pool
      .query(
        `INSERT INTO sessions (sid, data, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
        [sid, data, this.expiry(sess)],
      )
      .then(
        () => callback && callback(null),
        (error) => callback && callback(error),
      );
  }

  touch(sid, sess, callback) {
    this.pool
      .query('UPDATE sessions SET expires_at = $1 WHERE sid = $2', [this.expiry(sess), sid])
      .then(
        () => callback && callback(null),
        (error) => callback && callback(error),
      );
  }

  destroy(sid, callback) {
    this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid]).then(
      () => callback && callback(null),
      (error) => callback && callback(error),
    );
  }

  clear(callback) {
    this.pool.query('DELETE FROM sessions').then(
      () => callback && callback(null),
      (error) => callback && callback(error),
    );
  }

  length(callback) {
    this.pool.query('SELECT count(*)::int AS n FROM sessions').then(
      (result) => callback(null, result.rows[0].n),
      (error) => callback(error),
    );
  }
}

module.exports = { PostgresSessionStore };
