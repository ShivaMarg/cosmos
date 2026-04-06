/**
 * Lightweight rate limiter — no external packages needed.
 * Uses a sliding-window counter keyed by IP.
 *
 * For production you'd swap this for redis-backed rate limiting
 * (e.g. rate-limiter-flexible) to handle horizontal scaling.
 */

const requestCounts = new Map(); // ip -> { count, windowStart }

/**
 * Express middleware factory.
 * @param {object} opts
 * @param {number} opts.windowMs   Time window in ms (default 60 000)
 * @param {number} opts.max        Max requests per window (default 100)
 */
function rateLimiter({ windowMs = 60_000, max = 100 } = {}) {
  return (req, res, next) => {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const now = Date.now();
    const entry = requestCounts.get(ip);

    if (!entry || now - entry.windowStart > windowMs) {
      // New window
      requestCounts.set(ip, { count: 1, windowStart: now });
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({
        error: "Too many requests. Please slow down.",
        retryAfter: Math.ceil((entry.windowStart + windowMs - now) / 1000),
      });
    }

    next();
  };
}

/**
 * Clean up stale entries every 5 minutes to prevent memory leaks.
 */
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [ip, entry] of requestCounts) {
    if (entry.windowStart < cutoff) requestCounts.delete(ip);
  }
}, 300_000);

/**
 * Validate that required fields are present on the request body.
 * Usage: validateBody(['name', 'color'])
 */
function validateBody(fields) {
  return (req, res, next) => {
    const missing = fields.filter((f) => req.body[f] === undefined);
    if (missing.length) {
      return res
        .status(400)
        .json({ error: `Missing required fields: ${missing.join(", ")}` });
    }
    next();
  };
}

module.exports = { rateLimiter, validateBody };