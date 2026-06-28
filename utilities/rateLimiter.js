const setRateLimit = require("express-rate-limit");

// Global rate limit middleware (applied to all routes)
const rateLimitMiddleware = setRateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limit for the expensive Puppeteer-backed scraping endpoints.
// Cached hits are cheap; this only bites a single IP forcing many cold scrapes.
const heavyRateLimitMiddleware = setRateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: "Too many heavy requests from this IP, please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { rateLimitMiddleware, heavyRateLimitMiddleware };
