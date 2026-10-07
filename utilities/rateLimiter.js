const setRateLimit = require("express-rate-limit");

// Global rate limit middleware (applied to all routes)
const rateLimitMiddleware = setRateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter limit for the scraping endpoints. Each cold hit is a short HTTP fetch
// of a static page (no Chromium any more) and results are cached, so this only
// bites a single IP hammering many uncached artists at once.
const heavyRateLimitMiddleware = setRateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many heavy requests from this IP, please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { rateLimitMiddleware, heavyRateLimitMiddleware };
