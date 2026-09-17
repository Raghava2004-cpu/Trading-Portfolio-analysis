// src/controllers/portfolio.controller.js
// Port of backend/api.py — everything except the auth and prices routers.

const crypto = require("crypto");
const { Op } = require("sequelize");

const { sequelize, Portfolio, Stock } = require("../models");
const { HttpError, asyncHandler } = require("../middleware/errorHandler");
const { round, safeNumber } = require("../utils/math");
const { LTCG_EXEMPTION, LTCG_TAX_RATE, STCG_TAX_RATE } = require("../config");

const { ingest } = require("../pipeline/ingestor");
const { clean } = require("../pipeline/cleaner");
const { runAnalytics } = require("../pipeline/analytics");

// ── Helpers ───────────────────────────────────────────

/** Serialise a Stock row for the API, turning NaN/Infinity into null. */
function stockToRecord(s) {
  return {
    symbol: s.symbol,
    total_invested: safeNumber(s.total_invested),
    current_value: safeNumber(s.current_value),
    total_pnl: safeNumber(s.total_pnl),
    total_pnl_pct: safeNumber(s.total_pnl_pct),
    realized_pnl: safeNumber(s.realized_pnl),
    unrealized_pnl: safeNumber(s.unrealized_pnl),
    xirr_pct: safeNumber(s.xirr_pct),
    avg_buy_price: safeNumber(s.avg_buy_price),
    last_price: safeNumber(s.last_price),
    current_qty: safeNumber(s.current_qty),
    conviction_score: safeNumber(s.conviction_score),
    tax_classification: s.tax_classification,
    avg_holding_days: safeNumber(s.avg_holding_days),
    total_buy_trades: safeNumber(s.total_buy_trades),
    total_sell_trades: safeNumber(s.total_sell_trades),
    first_buy_date: s.first_buy_date ? String(s.first_buy_date) : null,
    volatility_pct: safeNumber(s.volatility_pct),
    max_drawdown_pct: safeNumber(s.max_drawdown_pct),
    beta: safeNumber(s.beta),
  };
}

/** The user's single active portfolio, or a 404 the frontend already handles. */
async function getActivePortfolio(user) {
  const portfolio = await Portfolio.findOne({
    where: { user_id: user.id, is_active: true },
    order: [["uploaded_at", "DESC"]],
    include: [{ model: Stock, as: "stocks" }],
  });

  if (!portfolio) {
    throw new HttpError(404, "No portfolio data found. Please upload your CSV files first.");
  }
  return portfolio;
}

/** Format a stored UTC timestamp in IST, e.g. "2026-09-17 14:05". */
function formatIst(date, style) {
  // en-US gives the 3-letter month ("Sep") that Python's %b produced;
  // en-GB would render "Sept".
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: style === "label" ? "short" : "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});

  return style === "label"
    ? `${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`
    : `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// ══════════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════════

const root = (req, res) => {
  res.json({
    status: "running",
    message: "StockSage API is live 🚀",
    version: "2.0.0",
  });
};

const status = asyncHandler(async (req, res) => {
  const found = await Portfolio.findOne({
    where: { user_id: req.user.id, is_active: true },
  });
  res.json({ scorecard_ready: found !== null });
});

// ══════════════════════════════════════════════════════
// UPLOAD
// ══════════════════════════════════════════════════════

const uploadAndRun = asyncHandler(async (req, res) => {
  const files = req.files || {};
  for (const field of ["equity", "fno", "holdings"]) {
    if (!files[field] || !files[field][0]) {
      throw new HttpError(422, `Missing required file field: ${field}`);
    }
  }

  // Multer already wrote the three CSVs into data/raw under the names the
  // ingestor expects, so the pipeline reads them exactly as before.
  let scorecard;
  try {
    const rawData = ingest();
    const cleaned = clean(rawData);
    const analytics = await runAnalytics(cleaned, false);   // offline risk metrics
    scorecard = analytics.scorecard;
  } catch (e) {
    throw new HttpError(500, `Pipeline failed: ${e.message}`);
  }

  const totalInvested = scorecard.reduce((a, r) => a + (r.total_invested || 0), 0);
  const totalCurrentValue = scorecard.reduce((a, r) => a + (r.current_value || 0), 0);
  const totalPnl = scorecard.reduce((a, r) => a + (r.total_pnl || 0), 0);

  const portfolioId = crypto.randomUUID();

  await sequelize.transaction(async (t) => {
    // Retire the previous snapshot — history rows are kept
    await Portfolio.update(
      { is_active: false },
      { where: { user_id: req.user.id, is_active: true }, transaction: t }
    );

    await Portfolio.create(
      {
        id: portfolioId,
        user_id: req.user.id,
        uploaded_at: new Date(),
        is_active: true,
        total_invested: round(totalInvested, 2),
        total_current_value: round(totalCurrentValue, 2),
        total_pnl: round(totalPnl, 2),
        total_pnl_pct: totalInvested ? round((totalPnl / totalInvested) * 100, 2) : 0,
      },
      { transaction: t }
    );

    const int = (v) => Math.trunc(Number(v) || 0);

    const rows = scorecard.map((row) => ({
      id: crypto.randomUUID(),
      portfolio_id: portfolioId,
      symbol: row.symbol || "",
      total_invested: safeNumber(row.total_invested) ?? 0,
      current_value: safeNumber(row.current_value) ?? 0,
      total_pnl: safeNumber(row.total_pnl) ?? 0,
      total_pnl_pct: safeNumber(row.total_pnl_pct) ?? 0,
      realized_pnl: safeNumber(row.realized_pnl) ?? 0,
      unrealized_pnl: safeNumber(row.unrealized_pnl) ?? 0,
      xirr_pct: safeNumber(row.xirr_pct),
      avg_buy_price: safeNumber(row.avg_buy_price) ?? 0,
      last_price: safeNumber(row.last_price) ?? 0,
      current_qty: int(row.current_qty),
      conviction_score: int(row.conviction_score),
      tax_classification: row.tax_classification ?? null,
      avg_holding_days: safeNumber(row.avg_holding_days) ?? 0,
      total_buy_trades: int(row.total_buy_trades),
      total_sell_trades: int(row.total_sell_trades),
      first_buy_date: row.first_buy_date ? String(row.first_buy_date) : null,
      volatility_pct: safeNumber(row.volatility_pct),
      max_drawdown_pct: safeNumber(row.max_drawdown_pct),
      beta: safeNumber(row.beta),
    }));

    await Stock.bulkCreate(rows, { transaction: t });
  });

  res.json({
    status: "success",
    message: "Portfolio saved ✓",
    total_stocks: scorecard.length,
    total_invested: round(totalInvested, 2),
    total_pnl: round(totalPnl, 2),
    snapshot_id: portfolioId,
  });
});

// ══════════════════════════════════════════════════════
// PORTFOLIO SUMMARY
// ══════════════════════════════════════════════════════

const portfolioSummary = asyncHandler(async (req, res) => {
  const portfolio = await getActivePortfolio(req.user);
  const stocks = portfolio.stocks || [];

  if (!stocks.length) throw new HttpError(404, "No stock data in portfolio.");

  const fnoPnl = stocks
    .filter((s) => s.tax_classification === "FNO")
    .reduce((a, s) => a + (s.total_pnl || 0), 0);

  const withXirr = stocks.filter((s) => Number.isFinite(s.xirr_pct));

  const best = withXirr.length
    ? withXirr.reduce((a, b) => (b.xirr_pct > a.xirr_pct ? b : a))
    : stocks[0];
  const worst = withXirr.length
    ? withXirr.reduce((a, b) => (b.xirr_pct < a.xirr_pct ? b : a))
    : stocks[stocks.length - 1];

  res.json({
    total_invested: portfolio.total_invested,
    total_current_value: portfolio.total_current_value,
    total_pnl: portfolio.total_pnl,
    total_pnl_pct: portfolio.total_pnl_pct,
    total_stocks: stocks.length,
    best_stock: {
      symbol: best.symbol,
      xirr_pct: safeNumber(best.xirr_pct),
      total_pnl_pct: safeNumber(best.total_pnl_pct),
    },
    worst_stock: {
      symbol: worst.symbol,
      xirr_pct: safeNumber(worst.xirr_pct),
      total_pnl_pct: safeNumber(worst.total_pnl_pct),
    },
    ltcg_stocks: stocks.filter((s) => s.tax_classification === "LTCG").length,
    stcg_stocks: stocks.filter((s) => s.tax_classification === "STCG").length,
    fno_net_pnl: round(fnoPnl, 2),
    fno_win_rate_pct: 0,
    high_conviction_count: stocks.filter((s) => (s.conviction_score || 0) >= 75).length,
  });
});

// ══════════════════════════════════════════════════════
// ALL STOCKS
// ══════════════════════════════════════════════════════

const getAllStocks = asyncHandler(async (req, res) => {
  const sortBy = req.query.sort_by || "total_pnl";
  const order = String(req.query.order || "desc").toLowerCase();
  const segment = req.query.segment;

  const portfolio = await getActivePortfolio(req.user);
  let records = (portfolio.stocks || []).map(stockToRecord);

  if (segment) {
    records = records.filter(
      (r) => String(r.tax_classification || "").toUpperCase() === String(segment).toUpperCase()
    );
  }

  if (records.length && sortBy in records[0]) {
    const dir = order === "desc" ? -1 : 1;
    records.sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      // nulls always sink to the bottom, whichever direction is asked for
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (av - bv) * dir;
    });
  }

  res.json({ count: records.length, stocks: records });
});

// ══════════════════════════════════════════════════════
// PORTFOLIO HISTORY
// ══════════════════════════════════════════════════════

const portfolioHistory = asyncHandler(async (req, res) => {
  const portfolios = await Portfolio.findAll({
    where: { user_id: req.user.id },
    order: [["uploaded_at", "ASC"]],
  });

  res.json(
    portfolios.map((p) => {
      const at = new Date(p.uploaded_at);
      return {
        date: formatIst(at, "date"),
        label: formatIst(at, "label"),
        total_invested: p.total_invested,
        total_current_value: p.total_current_value,
        total_pnl: p.total_pnl,
        total_pnl_pct: p.total_pnl_pct,
        is_active: p.is_active,
      };
    })
  );
});

// ══════════════════════════════════════════════════════
// TAX HARVESTING
// ══════════════════════════════════════════════════════

const taxHarvestSuggestions = asyncHandler(async (req, res) => {
  const portfolio = await getActivePortfolio(req.user);
  const stocks = portfolio.stocks || [];

  const lossStocks = stocks.filter(
    (s) => (s.current_qty || 0) > 0 && (s.unrealized_pnl || 0) < 0
  );

  const ltcgGains = stocks
    .filter((s) => s.tax_classification === "LTCG" && (s.realized_pnl || 0) > 0)
    .reduce((a, s) => a + (s.realized_pnl || 0), 0);

  const stcgGains = stocks
    .filter((s) => s.tax_classification === "STCG" && (s.realized_pnl || 0) > 0)
    .reduce((a, s) => a + (s.realized_pnl || 0), 0);

  const taxableLtcg = Math.max(0, ltcgGains - LTCG_EXEMPTION);
  const currentLtcgTax = round(taxableLtcg * LTCG_TAX_RATE, 2);
  const currentStcgTax = round(stcgGains * STCG_TAX_RATE, 2);

  const suggestions = [];
  let remainingLtcgOffset = taxableLtcg;
  let remainingStcgOffset = stcgGains;

  const sorted = [...lossStocks].sort(
    (a, b) => (a.unrealized_pnl || 0) - (b.unrealized_pnl || 0)
  );

  for (const s of sorted) {
    const loss = Math.abs(s.unrealized_pnl || 0);
    if (loss < 500) continue;

    let offsetFrom;
    let offsetAmt;
    let taxSaved;

    if (remainingLtcgOffset > 0) {
      offsetFrom = "LTCG";
      offsetAmt = Math.min(loss, remainingLtcgOffset);
      taxSaved = round(offsetAmt * LTCG_TAX_RATE, 2);
      remainingLtcgOffset -= offsetAmt;
    } else if (remainingStcgOffset > 0) {
      offsetFrom = "STCG";
      offsetAmt = Math.min(loss, remainingStcgOffset);
      taxSaved = round(offsetAmt * STCG_TAX_RATE, 2);
      remainingStcgOffset -= offsetAmt;
    } else {
      offsetFrom = "Carry Forward";
      offsetAmt = loss;
      taxSaved = 0;
    }

    const priceLabel = Number(s.last_price || 0).toLocaleString("en-IN", {
      maximumFractionDigits: 0,
    });

    suggestions.push({
      symbol: s.symbol,
      unrealized_pnl: round(s.unrealized_pnl || 0, 2),
      current_qty: s.current_qty,
      last_price: s.last_price,
      tax_classification: s.tax_classification,
      offset_from: offsetFrom,
      loss_to_book: round(loss, 2),
      tax_saved: taxSaved,
      action: `Sell ${s.current_qty} shares of ${s.symbol} at ~₹${priceLabel}`,
    });
  }

  const totalTaxSaved = suggestions.reduce((a, s) => a + s.tax_saved, 0);

  res.json({
    summary: {
      ltcg_gains: round(ltcgGains, 2),
      stcg_gains: round(stcgGains, 2),
      taxable_ltcg: round(taxableLtcg, 2),
      current_ltcg_tax: currentLtcgTax,
      current_stcg_tax: currentStcgTax,
      total_current_tax: round(currentLtcgTax + currentStcgTax, 2),
      total_tax_saved: round(totalTaxSaved, 2),
      tax_after_harvest: round(currentLtcgTax + currentStcgTax - totalTaxSaved, 2),
      ltcg_exemption: LTCG_EXEMPTION,
    },
    suggestions,
    note: "Tax calculations are estimates. Consult a CA before executing trades.",
  });
});

module.exports = {
  root,
  status,
  uploadAndRun,
  portfolioSummary,
  getAllStocks,
  portfolioHistory,
  taxHarvestSuggestions,
};
