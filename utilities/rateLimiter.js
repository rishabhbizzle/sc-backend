const setRateLimit = require("express-rate-limit");
const { positiveIntEnv } = require("./semaphore");

// Global rate limit middleware (applied to all routes)
const rateLimitMiddleware = setRateLimit({
  windowMs: 60 * 1000,
  max: positiveIntEnv(process.env.RATE_LIMIT_MAX, 300),
  message: { status: "error", message: "Too many requests from this IP, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter limit for the scraping endpoints. Each cold hit is a short HTTP fetch
// of a static page (no Chromium any more) and results are cached, so this only
// bites a single IP hammering many uncached artists at once.
const heavyRateLimitMiddleware = setRateLimit({
  windowMs: 60 * 1000,
  max: positiveIntEnv(process.env.HEAVY_RATE_LIMIT_MAX, 60),
  message: { status: "error", message: "Too many heavy requests from this IP, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// The AI roast costs real money per call, so it gets a small per-IP budget.
const roastRateLimitMiddleware = setRateLimit({
  windowMs: 60 * 60 * 1000,
  max: positiveIntEnv(process.env.ROAST_RATE_LIMIT_MAX, 5),
  message: { status: "error", message: "You've been roasted enough for now, try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { rateLimitMiddleware, heavyRateLimitMiddleware, roastRateLimitMiddleware };
