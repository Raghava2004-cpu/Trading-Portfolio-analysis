// src/controllers/prices.controller.js
// Live price fetching via Yahoo Finance (15-min delayed, free).
// Port of backend/prices.py — yfinance is replaced by the yahoo-finance2 package.
// NSE symbols are suffixed with .NS for Yahoo Finance.

const yahooFinance = require("../utils/yahoo");
const { asyncHandler } = require("../middleware/errorHandler");
const { round } = require("../utils/math");

// Simple in-memory cache — prices are refreshed at most every 15 minutes
const cache = new Map();          // symbol -> { price, fetchedAt }
const CACHE_TTL_SECONDS = 900;    // 15 minutes

function getCachedPrice(symbol) {
  const entry = cache.get(symbol);
  if (entry && Date.now() / 1000 - entry.fetchedAt < CACHE_TTL_SECONDS) {
    return entry.price;
  }
  return null;
}

/** Latest close + previous close for a list of NSE symbols. */
async function fetchFromYahoo(symbols) {
  const prices = {};
  const prevCloses = {};

  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const q = await yahooFinance.quote(`${sym}.NS`);
        const price = q?.regularMarketPrice;
        const prev = q?.regularMarketPreviousClose;

        if (Number.isFinite(price)) {
          prices[sym] = round(price, 2);
          cache.set(sym, { price: round(price, 2), fetchedAt: Date.now() / 1000 });
        }
        if (Number.isFinite(prev)) {
          prevCloses[sym] = round(prev, 2);
        }
      } catch {
        // symbol not found — skip, exactly like the Python version
      }
    })
  );

  return { prices, prevCloses };
}

/**
 * GET /prices?symbols=RELIANCE,TCS,INFY
 * Returns latest prices + previous close. Cached for 15 minutes.
 */
const getPrices = asyncHandler(async (req, res) => {
  const raw = String(req.query.symbols || "");
  const symbolList = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!symbolList.length) {
    return res.status(422).json({ detail: "Query parameter 'symbols' is required." });
  }

  const prices = {};
  const toFetch = [];

  for (const sym of symbolList) {
    const cached = getCachedPrice(sym);
    if (cached !== null) prices[sym] = cached;
    else toFetch.push(sym);
  }

  let prevCloses = {};

  // Previous close is needed for every symbol on screen, not just uncached ones
  try {
    const fresh = await fetchFromYahoo(symbolList);
    Object.assign(prices, fresh.prices);
    prevCloses = fresh.prevCloses;
  } catch (e) {
    console.error(`[prices] Yahoo Finance fetch error: ${e.message}`);
  }

  res.json({
    prices,
    prev_closes: prevCloses,
    delayed_min: 15,
    note: "Prices are 15-minute delayed via Yahoo Finance",
    cached_until: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
  });
});

/** GET /prices/nifty — Nifty 50 index value for benchmark comparison. */
const getNifty = asyncHandler(async (req, res) => {
  try {
    const q = await yahooFinance.quote("^NSEI");
    const latest = q?.regularMarketPrice;
    const prev = q?.regularMarketPreviousClose;

    if (!Number.isFinite(latest)) {
      return res.json({ value: null, change_pct: null });
    }

    const changePct = Number.isFinite(prev) && prev !== 0
      ? round(((latest - prev) / prev) * 100, 2)
      : null;

    // 1-year return for benchmark comparison
    let oneYearReturn = null;
    try {
      const period1 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const chart = await yahooFinance.chart("^NSEI", { period1, interval: "1d" });
      const closes = (chart?.quotes || [])
        .map((c) => c.adjclose ?? c.close)
        .filter((c) => Number.isFinite(c));
      if (closes.length) {
        const yearAgo = closes[0];
        oneYearReturn = round(((latest - yearAgo) / yearAgo) * 100, 2);
      }
    } catch {
      oneYearReturn = null;
    }

    res.json({
      value: round(latest, 2),
      change_pct: changePct,
      one_year_return: oneYearReturn,
    });
  } catch (e) {
    res.json({ error: e.message, value: null });
  }
});

module.exports = { getPrices, getNifty };
