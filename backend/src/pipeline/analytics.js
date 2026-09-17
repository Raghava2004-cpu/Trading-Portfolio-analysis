// src/pipeline/analytics.js
// PHASE 3 — Analytics Engine
// Port of backend/pipeline/analytics.py
// 6 modules: P&L, XIRR, Holding Period, Volatility & Beta, Conviction Score, F&O P&L

const { getLogger } = require("../utils/logger");
const {
  round, sum, mean, std, covariance, pctChange, maxDrawdown,
  hashString, seededRandom, normalFrom, daysBetween, meanDate, toDateString, DAY_MS,
} = require("../utils/math");

const logger = getLogger("analytics");

/** Today at midnight UTC — the pd.Timestamp(date.today()) equivalent. */
function today() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** groupby(col) → Map<key, rows[]>, iterated in sorted key order like pandas. */
function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return new Map([...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function sortByDate(rows) {
  return [...rows].sort((a, b) => a.trade_date.getTime() - b.trade_date.getTime());
}

function isBuy(row) {
  return String(row.trade_type).trim().toLowerCase() === "buy";
}

/** Equity rows with a usable trade date, sorted oldest first. */
function equityRows(masterLedger) {
  return sortByDate(masterLedger.filter((r) => r.segment === "EQ" && r.trade_date));
}

// ═══════════════════════════════════════════════════════════
// MODULE 1 — P&L PER STOCK
// ═══════════════════════════════════════════════════════════

/**
 * Per stock P&L breakdown:
 *   total_invested  : total buy value ever
 *   total_sold      : total sell value ever
 *   realized_pnl    : profit/loss from completed sells (FIFO)
 *   current_qty     : shares still held
 *   avg_buy_price   : FIFO average cost of current holdings
 *   current_value   : current_qty × last_price from holdings
 *   unrealized_pnl  : current_value − (avg_buy_price × current_qty)
 *   total_pnl       : realized + unrealized
 *   total_pnl_pct   : total_pnl / total_invested × 100
 */
function computePnl(masterLedger, holdings) {
  logger.info("MODULE 1 — Computing P&L per stock...");

  const eq = equityRows(masterLedger);

  // Build the holdings last-price lookup
  const priceLookup = new Map();
  for (const row of holdings) {
    const lower = {};
    for (const [k, v] of Object.entries(row)) lower[k.toLowerCase()] = v;
    const symCol = "tradingsymbol" in lower ? "tradingsymbol" : "symbol";
    if (lower[symCol] !== undefined && lower.last_price !== undefined) {
      priceLookup.set(lower[symCol], Number(lower.last_price));
    }
  }

  const results = [];

  for (const [symbol, group] of groupBy(eq, "underlying")) {
    const trades = sortByDate(group);

    let totalInvested = 0;
    let totalSold = 0;
    let realizedPnl = 0;
    const fifoQueue = [];   // [qty, price] lots

    for (const row of trades) {
      const qty = Number(row.quantity) || 0;
      const price = Number(row.price) || 0;

      if (isBuy(row)) {
        totalInvested += qty * price;
        fifoQueue.push([qty, price]);
      } else {
        totalSold += qty * price;
        let sellQty = qty;
        let costOfSold = 0;

        // FIFO: eat through buy lots oldest first
        while (sellQty > 0 && fifoQueue.length) {
          const [lotQty, lotPrice] = fifoQueue[0];
          const used = Math.min(sellQty, lotQty);
          costOfSold += used * lotPrice;
          sellQty -= used;
          fifoQueue[0][0] -= used;
          if (fifoQueue[0][0] <= 0) fifoQueue.shift();
        }

        realizedPnl += qty * price - costOfSold;
      }
    }

    const currentQty = sum(fifoQueue.map((lot) => lot[0]));
    const avgBuyPrice =
      currentQty > 0 ? sum(fifoQueue.map((lot) => lot[0] * lot[1])) / currentQty : 0;

    const looked = priceLookup.get(symbol);
    const lastPrice = Number.isFinite(looked) ? looked : avgBuyPrice;
    const currentValue = currentQty * lastPrice;
    const unrealizedPnl = currentValue - avgBuyPrice * currentQty;
    const totalPnl = realizedPnl + unrealizedPnl;
    const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    results.push({
      symbol,
      total_invested: round(totalInvested, 2),
      total_sold: round(totalSold, 2),
      realized_pnl: round(realizedPnl, 2),
      current_qty: round(currentQty, 2),
      avg_buy_price: round(avgBuyPrice, 2),
      last_price: round(lastPrice, 2),
      current_value: round(currentValue, 2),
      unrealized_pnl: round(unrealizedPnl, 2),
      total_pnl: round(totalPnl, 2),
      total_pnl_pct: round(totalPnlPct, 2),
    });
  }

  results.sort((a, b) => (b.total_pnl || 0) - (a.total_pnl || 0));
  logger.info(`  P&L computed for ${results.length} stocks ✓`);
  return results;
}

// ═══════════════════════════════════════════════════════════
// MODULE 2 — XIRR PER STOCK
// ═══════════════════════════════════════════════════════════

/** Pure JS XIRR via Newton–Raphson — same algorithm as the Python version. */
function xirr(cashflows) {
  if (cashflows.length < 2) return null;

  try {
    const t0 = cashflows[0][0].getTime();
    const years = (d) => (d.getTime() - t0) / DAY_MS / 365.0;

    let rate = 0.1;

    for (let i = 0; i < 1000; i++) {
      let npv = 0;
      let dnpv = 0;

      for (const [d, cf] of cashflows) {
        const t = years(d);
        npv += cf / Math.pow(1 + rate, t);
        dnpv += -t * cf / Math.pow(1 + rate, t + 1);
      }

      if (dnpv === 0) break;

      const newRate = rate - npv / dnpv;
      if (!Number.isFinite(newRate)) break;

      if (Math.abs(newRate - rate) < 1e-6) {
        rate = newRate;
        break;
      }
      rate = newRate;
    }

    return rate > -1 && rate < 100 ? round(rate * 100, 2) : null;
  } catch {
    return null;
  }
}

/**
 * XIRR per stock using actual trade cash flows + current market value.
 * Buys = negative cashflow, sells = positive, current value = inflow today.
 */
function computeXirr(masterLedger, pnlRows) {
  logger.info("MODULE 2 — Computing XIRR per stock...");

  const eq = equityRows(masterLedger);
  const TODAY = today();

  const pnlLookup = new Map(
    pnlRows.map((r) => [r.symbol, { current_value: r.current_value, current_qty: r.current_qty }])
  );

  const results = [];

  for (const [symbol, group] of groupBy(eq, "underlying")) {
    const trades = sortByDate(group);
    const cashflows = [];

    for (const row of trades) {
      const amt = (Number(row.quantity) || 0) * (Number(row.price) || 0);
      cashflows.push([row.trade_date, isBuy(row) ? -amt : +amt]);
    }

    const currentVal = pnlLookup.get(symbol)?.current_value || 0;
    if (currentVal > 0) cashflows.push([TODAY, +currentVal]);

    results.push({ symbol, xirr_pct: xirr(cashflows) });
  }

  const ok = results.filter((r) => r.xirr_pct !== null).length;
  logger.info(`  XIRR computed for ${ok}/${results.length} stocks ✓`);
  return results;
}

// ═══════════════════════════════════════════════════════════
// MODULE 3 — HOLDING PERIOD ANALYSIS
// ═══════════════════════════════════════════════════════════

function computeHoldingPeriod(masterLedger) {
  logger.info("MODULE 3 — Computing holding periods...");

  const eq = equityRows(masterLedger);
  const TODAY = today();
  const results = [];

  for (const [symbol, group] of groupBy(eq, "underlying")) {
    const trades = sortByDate(group);
    const buys = trades.filter(isBuy);
    const sells = trades.filter((r) => !isBuy(r));

    const buyDates = buys.map((r) => r.trade_date);
    const allDates = trades.map((r) => r.trade_date);

    const firstBuy = buyDates.length
      ? new Date(Math.min(...buyDates.map((d) => d.getTime())))
      : null;
    const lastAct = allDates.length
      ? new Date(Math.max(...allDates.map((d) => d.getTime())))
      : null;

    const daysHeld = firstBuy ? daysBetween(TODAY, firstBuy) : 0;

    const netQty = sum(
      trades.map((r) => (Number(r.quantity) || 0) * (isBuy(r) ? 1 : -1))
    );
    const stillHolding = netQty > 0;

    // Average days between buys and their corresponding sells
    let avgHold;
    if (sells.length && buys.length) {
      const mSell = meanDate(sells.map((r) => r.trade_date));
      const mBuy = meanDate(buyDates);
      avgHold = Math.max(0, daysBetween(mSell, mBuy));
    } else {
      avgHold = daysHeld;   // still holding — count from first buy to today
    }

    results.push({
      symbol,
      first_buy_date: toDateString(firstBuy),
      last_activity: toDateString(lastAct),
      days_since_first_buy: daysHeld,
      avg_holding_days: avgHold,
      tax_classification: avgHold >= 365 ? "LTCG" : "STCG",
      total_buy_trades: buys.length,
      total_sell_trades: sells.length,
      still_holding: stillHolding,
    });
  }

  const ltcg = results.filter((r) => r.tax_classification === "LTCG").length;
  const stcg = results.length - ltcg;
  logger.info(`  Holding periods computed ✓  LTCG: ${ltcg} stocks | STCG: ${stcg} stocks`);
  return results;
}

// ═══════════════════════════════════════════════════════════
// MODULE 4 — VOLATILITY & BETA
// ═══════════════════════════════════════════════════════════

/**
 * Simulates a realistic price series when live data is unavailable.
 * Seeded from the symbol string, so the same symbol always gives the same
 * series — unlike the Python original, which used a per-process salted hash().
 */
function simulatePriceSeries(symbol, nDays = 252) {
  const rand = seededRandom(hashString(symbol));
  const prices = [];
  let price = 1000.0;

  for (let i = 0; i < nDays; i++) {
    const dailyReturn = normalFrom(rand, 0.0005, 0.018);
    price *= 1 + dailyReturn;
    prices.push(price);
  }
  return prices;
}

/** Fetch 1y of closing prices. Falls back to simulation when offline or empty. */
async function fetchPriceData(symbol, useLive = true) {
  if (useLive) {
    try {
      const yahooFinance = require("../utils/yahoo");
      const ticker = symbol.startsWith("^") ? symbol : `${symbol}.NS`;

      const period1 = new Date(Date.now() - 365 * DAY_MS);
      const rows = await yahooFinance.chart(ticker, { period1, interval: "1d" });
      const closes = (rows?.quotes || [])
        .map((q) => q.adjclose ?? q.close)
        .filter((c) => Number.isFinite(c));

      if (!closes.length) throw new Error("Empty response from Yahoo Finance");
      return closes;
    } catch (e) {
      logger.warning(`  yahoo-finance failed for ${symbol}: ${e.message} — using simulation`);
    }
  }
  return simulatePriceSeries(symbol);
}

/**
 * Per stock: annualized volatility, beta vs NIFTY 50, and max drawdown.
 * Fully wrapped in try/catch — never crashes the pipeline.
 */
async function computeVolatilityBeta(symbols, useLive = true) {
  logger.info("MODULE 4 — Computing Volatility & Beta...");
  if (!useLive) logger.warning("  Running in OFFLINE mode — using simulated price data");

  // Benchmark — safe fallback if it fails
  let niftyRet = [];
  try {
    const nifty = await fetchPriceData("^NSEI", useLive);
    niftyRet = pctChange(nifty);
  } catch (e) {
    logger.warning(`  Could not fetch NIFTY benchmark: ${e.message} — beta will be null`);
  }

  const results = [];

  for (const symbol of symbols) {
    try {
      const prices = await fetchPriceData(symbol, useLive);
      const returns = pctChange(prices);

      if (!returns.length) throw new Error("Empty returns series");

      const volPct = round(std(returns) * Math.sqrt(252) * 100, 2);
      const maxDdPct = round(maxDrawdown(prices) * 100, 2);

      // Beta vs NIFTY 50 — align on the shortest common tail
      let beta = null;
      if (niftyRet.length > 10) {
        try {
          const n = Math.min(returns.length, niftyRet.length);
          if (n > 10) {
            const stock = returns.slice(-n);
            const bench = niftyRet.slice(-n);
            const covSb = covariance(stock, bench);
            const varB = covariance(bench, bench);
            beta = varB !== 0 ? round(covSb / varB, 2) : null;
          }
        } catch {
          beta = null;
        }
      }

      results.push({
        symbol,
        volatility_pct: volPct,
        beta,
        max_drawdown_pct: maxDdPct,
      });
    } catch (e) {
      logger.warning(`  Risk metrics failed for ${symbol}: ${e.message} — using null`);
      results.push({ symbol, volatility_pct: null, beta: null, max_drawdown_pct: null });
    }
  }

  logger.info(`  Volatility & Beta computed for ${results.length} stocks ✓`);
  return results;
}

// ═══════════════════════════════════════════════════════════
// MODULE 5 — CONVICTION SCORE
// ═══════════════════════════════════════════════════════════

/**
 * Conviction Score (0–100) per stock. Measures how well you acted as an
 * investor — not just returns.
 *   30 pts — Hold Duration    : longer hold = higher score
 *   25 pts — Position Size    : bigger position = higher conviction
 *   25 pts — Add-on Behaviour : did you buy more on dips?
 *   20 pts — Sell Discipline  : did you hold winners or sell too soon?
 */
function computeConvictionScore(masterLedger, pnlRows, holdingRows) {
  logger.info("MODULE 5 — Computing Conviction Scores...");

  const eq = equityRows(masterLedger);
  const pnlIdx = new Map(pnlRows.map((r) => [r.symbol, r]));
  const holdingIdx = new Map(holdingRows.map((r) => [r.symbol, r]));
  const totalPortfolioValue = sum(pnlRows.map((r) => r.total_invested || 0));

  const results = [];

  for (const [symbol, group] of groupBy(eq, "underlying")) {
    const trades = sortByDate(group);
    const buys = trades.filter(isBuy);

    // ── 30 pts: Hold Duration ──
    const avgHold = holdingIdx.get(symbol)?.avg_holding_days || 0;
    const holdScore = Math.min(30, round((avgHold / 730) * 30, 1));

    // ── 25 pts: Position Size ──
    const invested = pnlIdx.get(symbol)?.total_invested || 0;
    const positionPct = totalPortfolioValue > 0 ? (invested / totalPortfolioValue) * 100 : 0;
    const sizeScore = Math.min(25, round((positionPct / 5) * 25, 1));

    // ── 25 pts: Add-on Behaviour ──
    const numBuys = buys.length;
    let addonScore = numBuys >= 3 ? 25 : numBuys === 2 ? 15 : 8;

    if (numBuys >= 2) {
      const buyPrices = buys.map((r) => Number(r.price) || 0);
      let dipBuys = 0;
      for (let i = 1; i < buyPrices.length; i++) {
        if (buyPrices[i] < buyPrices[i - 1]) dipBuys++;
      }
      addonScore = Math.min(25, addonScore + dipBuys * 3);
    }

    // ── 20 pts: Sell Discipline ──
    const totalPnlPct = pnlIdx.get(symbol)?.total_pnl_pct || 0;
    const stillHolding = holdingIdx.get(symbol)?.still_holding || false;

    let sellScore;
    if (stillHolding && totalPnlPct > 0) sellScore = 20;          // holding a winner
    else if (stillHolding && totalPnlPct < -20) sellScore = 5;    // holding a big loser
    else if (!stillHolding && totalPnlPct > 20) sellScore = 10;   // sold a winner too soon
    else if (!stillHolding && totalPnlPct < 0) sellScore = 8;     // cut losses
    else sellScore = 14;

    const totalScore = round(holdScore + sizeScore + addonScore + sellScore, 1);
    const convictionScore = Math.min(100, totalScore);

    results.push({
      symbol,
      hold_score: holdScore,
      size_score: sizeScore,
      addon_score: addonScore,
      sell_score: sellScore,
      conviction_score: convictionScore,
      conviction_grade:
        convictionScore >= 75 ? "🟢 High" : convictionScore >= 50 ? "🟡 Medium" : "🔴 Low",
    });
  }

  results.sort((a, b) => b.conviction_score - a.conviction_score);
  logger.info(`  Conviction scores computed for ${results.length} stocks ✓`);
  return results;
}

// ═══════════════════════════════════════════════════════════
// MODULE 6 — F&O P&L MATCHING
// ═══════════════════════════════════════════════════════════

function computeFnoPnl(masterLedger) {
  logger.info("MODULE 6 — Computing F&O P&L...");

  const fno = masterLedger.filter(
    (r) => (r.segment === "FUT" || r.segment === "OPT") && r.trade_date
  );

  if (!fno.length) {
    logger.warning("  No F&O trades found in ledger");
    return { trade_pairs: [], summary: {} };
  }

  const pairs = [];

  for (const [instrument, group] of groupBy(sortByDate(fno), "scrip_name")) {
    const buys = group.filter(isBuy);
    const sells = group.filter((r) => !isBuy(r));

    const buyVal = sum(buys.map((r) => (Number(r.quantity) || 0) * (Number(r.price) || 0)));
    const sellVal = sum(sells.map((r) => (Number(r.quantity) || 0) * (Number(r.price) || 0)));
    const netPnl = sellVal - buyVal;

    pairs.push({
      instrument,
      segment: group[0].segment,
      buy_value: round(buyVal, 2),
      sell_value: round(sellVal, 2),
      net_pnl: round(netPnl, 2),
      result: netPnl > 0 ? "WIN" : "LOSS",
      num_trades: group.length,
    });
  }

  pairs.sort((a, b) => b.net_pnl - a.net_pnl);

  const wins = pairs.filter((p) => p.net_pnl > 0).length;
  const losses = pairs.length - wins;
  const winRate = pairs.length ? round((wins / pairs.length) * 100, 1) : 0;

  const netPnls = pairs.map((p) => p.net_pnl);

  const summary = {
    total_fno_pnl: round(sum(netPnls), 2),
    futures_pnl: round(sum(pairs.filter((p) => p.segment === "FUT").map((p) => p.net_pnl)), 2),
    options_pnl: round(sum(pairs.filter((p) => p.segment === "OPT").map((p) => p.net_pnl)), 2),
    total_trades: pairs.length,
    wins,
    losses,
    win_rate_pct: winRate,
    best_trade: pairs.length ? pairs[0].instrument : null,
    best_trade_pnl: pairs.length ? Math.max(...netPnls) : null,
    worst_trade: pairs.length ? pairs[pairs.length - 1].instrument : null,
    worst_trade_pnl: pairs.length ? Math.min(...netPnls) : null,
  };

  logger.info(
    `  F&O P&L computed ✓  Win rate: ${winRate}%  |  Net P&L: ₹${Math.round(summary.total_fno_pnl)}`
  );
  return { trade_pairs: pairs, summary };
}

// ═══════════════════════════════════════════════════════════
// MASTER FUNCTION — run all 6 modules
// ═══════════════════════════════════════════════════════════

/** Left-join `right` onto `left` on the `symbol` key, picking only `cols`. */
function leftJoin(left, right, cols) {
  const idx = new Map();
  for (const row of right) {
    if (!idx.has(row.symbol)) idx.set(row.symbol, row);   // drop_duplicates(keep="first")
  }

  return left.map((row) => {
    const match = idx.get(row.symbol);
    const merged = { ...row };
    for (const col of cols) {
      merged[col] = match ? match[col] ?? null : null;
    }
    return merged;
  });
}

function dedupBySymbol(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });
}

/**
 * Run all 6 analytics modules in order.
 * @returns {Promise<object>} scorecard plus each module's raw output
 */
async function runAnalytics(cleanedData, useLivePrices = true) {
  const master = cleanedData.master_ledger;
  const holdings = cleanedData.holdings;

  logger.info("=".repeat(55));
  logger.info("PHASE 3 — ANALYTICS ENGINE STARTED");
  logger.info(`  master_ledger rows : ${master.length}`);
  logger.info("=".repeat(55));

  // Module 1 — P&L
  const pnl = computePnl(master, holdings);

  // Module 2 — XIRR
  const xirrRows = computeXirr(master, pnl);

  // Module 3 — Holding Period
  const holding = computeHoldingPeriod(master);

  // Module 4 — Volatility & Beta
  const risk = await computeVolatilityBeta(pnl.map((r) => r.symbol), useLivePrices);

  // Module 5 — Conviction Score
  const conviction = computeConvictionScore(master, pnl, holding);

  // Module 6 — F&O P&L
  const fno = computeFnoPnl(master);

  // ── Deduplicate on symbol before merging, then left-join ──
  let scorecard = dedupBySymbol(pnl);
  scorecard = leftJoin(scorecard, xirrRows, ["xirr_pct"]);
  scorecard = leftJoin(scorecard, holding, [
    "avg_holding_days", "tax_classification", "still_holding",
    "total_buy_trades", "total_sell_trades", "first_buy_date",
  ]);
  scorecard = leftJoin(scorecard, risk, ["volatility_pct", "beta", "max_drawdown_pct"]);
  scorecard = leftJoin(scorecard, conviction, ["conviction_score", "conviction_grade"]);

  logger.info("=".repeat(55));
  logger.info("PHASE 3 — ANALYTICS COMPLETE ✓");
  logger.info(`  Scorecard rows : ${scorecard.length}`);
  logger.info("=".repeat(55));

  return { scorecard, pnl, xirr: xirrRows, holding, risk, conviction, fno };
}

module.exports = {
  runAnalytics,
  computePnl,
  computeXirr,
  computeHoldingPeriod,
  computeVolatilityBeta,
  computeConvictionScore,
  computeFnoPnl,
  xirr,
  simulatePriceSeries,
};
