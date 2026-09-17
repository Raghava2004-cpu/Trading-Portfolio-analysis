// src/pipeline/cleaner.js
// PHASE 2 — Data Cleaning
// Port of backend/pipeline/cleaner.py
// Fixes dates, symbols, duplicates, F&O contract parsing, and merges into a
// unified master ledger.

const { getLogger } = require("../utils/logger");
const { BROKER_SCHEMAS, SYMBOL_RENAME_MAP, SEGMENT } = require("../config");

const logger = getLogger("cleaner");

// ─────────────────────────────────────────────
// STEP 1 — Date Parsing
// ─────────────────────────────────────────────

/**
 * Replacement for pd.to_datetime(dayfirst=True, errors="coerce").
 * Returns a Date, or null when the value cannot be parsed (pandas NaT).
 */
function parseDate(value) {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === "nan" || raw.toLowerCase() === "nat") return null;

  // ISO first — Zerodha uses 2023-04-12 and 2023-04-12T10:15:30
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, hh = "0", mi = "0", ss = "0"] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // Day-first formats: 12-04-2023, 12/04/2023, 12.04.2023 (with optional time)
  m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let [, d, mo, y, hh = "0", mi = "0", ss = "0"] = m;
    let year = Number(y);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    // dayfirst=True, but fall back to month-first when day > 12 is impossible
    let day = Number(d);
    let month = Number(mo);
    if (day > 31 || month > 12) {
      if (month <= 31 && day <= 12) [day, month] = [month, day];
    }
    const dt = new Date(Date.UTC(year, month - 1, day, +hh, +mi, +ss));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Convert all date columns to Date objects in place (on a copy of the rows). */
function parseDates(rows, dateCols, label) {
  let nulls = 0;
  const out = rows.map((row) => {
    const copy = { ...row };
    for (const col of dateCols) {
      if (col in copy) {
        const parsed = parseDate(copy[col]);
        if (parsed === null && copy[col] !== null && String(copy[col]).trim() !== "") nulls++;
        copy[col] = parsed;
      }
    }
    return copy;
  });

  if (nulls > 0) {
    logger.warning(`[${label}] ${nulls} unparseable dates — set to null`);
  }
  logger.info(`[${label}] Date columns parsed ✓`);
  return out;
}

// ─────────────────────────────────────────────
// STEP 2 — Symbol Standardization
// ─────────────────────────────────────────────

/**
 * Strip exchange suffixes, whitespace, and apply the rename map.
 * e.g. 'INFY EQ' → 'INFY', 'MINDTREE' → 'LTIM'
 */
function cleanSymbol(symbol) {
  if (symbol === null || symbol === undefined) return symbol;
  let s = String(symbol).trim().toUpperCase();
  // Remove common suffixes like '-EQ', ' EQ', '-BE'
  s = s.replace(/[-\s](EQ|BE|BL|SM|ST)$/, "");
  // Apply merger / rename map
  return SYMBOL_RENAME_MAP[s] !== undefined ? SYMBOL_RENAME_MAP[s] : s;
}

function standardizeSymbols(rows, symbolCol, label) {
  const before = new Set(rows.map((r) => r[symbolCol])).size;
  const out = rows.map((r) => ({ ...r, [symbolCol]: cleanSymbol(r[symbolCol]) }));
  const after = new Set(out.map((r) => r[symbolCol])).size;
  logger.info(`[${label}] Symbols standardized ✓  (${before} → ${after} unique tickers)`);
  return out;
}

// ─────────────────────────────────────────────
// STEP 3 — Duplicate Removal
// ─────────────────────────────────────────────

function removeDuplicates(rows, tradeIdCol, label) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = String(row[tradeIdCol]);
    if (seen.has(key)) continue;   // keep="first"
    seen.add(key);
    out.push(row);
  }
  const dropped = rows.length - out.length;
  if (dropped > 0) {
    logger.warning(`[${label}] Removed ${dropped} duplicate trade_id rows`);
  } else {
    logger.info(`[${label}] No duplicates found ✓`);
  }
  return out;
}

// ─────────────────────────────────────────────
// STEP 4 — Numeric Cleaning
// ─────────────────────────────────────────────

/** Strip commas / rupee symbols and cast to number (NaN → null). */
function cleanNumerics(rows, cols, label) {
  const out = rows.map((row) => {
    const copy = { ...row };
    for (const col of cols) {
      if (col in copy) {
        const cleaned = String(copy[col] ?? "")
          .replace(/,/g, "")
          .replace(/₹/g, "")
          .trim();
        const num = cleaned === "" ? NaN : Number(cleaned);
        copy[col] = Number.isFinite(num) ? num : null;
      }
    }
    return copy;
  });
  logger.info(`[${label}] Numeric columns cleaned ✓`);
  return out;
}

// ─────────────────────────────────────────────
// STEP 5 — F&O Contract Parsing
// ─────────────────────────────────────────────

// Matches Zerodha F&O instrument names like:
//   NIFTY23MAR17500PE  → underlying=NIFTY, expiry=23MAR, strike=17500, type=PE
//   BANKNIFTY21OCT37000CE
//   RELIANCE19SEPFUT   → underlying=RELIANCE, type=FUT
const FNO_PATTERN = /^(?<underlying>[A-Z&]+)(?<expiry_code>\d{2}[A-Z]{3})(?:(?<strike>\d+)(?<opt_type>CE|PE)|(?<fut>FUT))$/;

/** Parse a raw F&O instrument name into structured fields. */
function parseFnoInstrument(name) {
  const result = {
    underlying: null,
    expiry_code: null,
    strike_price_parsed: null,
    option_type_parsed: null,
    instrument_type: null,
  };

  if (name === null || name === undefined) return result;

  const m = FNO_PATTERN.exec(String(name).trim().toUpperCase());
  if (!m) return result;

  const g = m.groups;
  result.underlying = g.underlying;
  result.expiry_code = g.expiry_code;

  if (g.fut) {
    result.instrument_type = SEGMENT.futures;
    result.option_type_parsed = "FUT";
  } else {
    result.strike_price_parsed = Number(g.strike);
    result.option_type_parsed = g.opt_type;   // CE or PE
    result.instrument_type = SEGMENT.options;
  }

  return result;
}

/** Apply F&O contract parsing and merge parsed fields back into each row. */
function parseFnoContracts(rows) {
  let parsedCount = 0;

  const out = rows.map((row) => {
    const parsed = parseFnoInstrument(row.scrip_name);
    const merged = { ...row, ...parsed };

    // Fill instrument_type from the series column if the regex missed (fallback)
    if (merged.instrument_type === null && merged.series) {
      const series = String(merged.series);
      if (series.startsWith("FUTIDX") || series.startsWith("FUTSTK")) {
        merged.instrument_type = SEGMENT.futures;
      } else if (series.startsWith("OPTIDX") || series.startsWith("OPTSTK")) {
        merged.instrument_type = SEGMENT.options;
      }
    }

    if (merged.underlying !== null) parsedCount++;
    return merged;
  });

  logger.info(`[F&O] Parsed ${parsedCount}/${rows.length} contract names ✓`);
  return out;
}

// ─────────────────────────────────────────────
// STEP 6 — Build Master Ledger
// ─────────────────────────────────────────────

const SHARED_COLS = [
  "trade_date", "trade_type", "scrip_name", "underlying",
  "exchange", "quantity", "price", "trade_id", "segment",
];

const FNO_EXTRA = [
  "expiry_date", "strike_price", "option_type", "instrument_type",
  "expiry_code", "strike_price_parsed", "option_type_parsed",
];

function reindex(row, cols) {
  const out = {};
  for (const col of cols) out[col] = col in row ? row[col] : null;
  return out;
}

/**
 * Combine equity + F&O into one unified master ledger.
 * Adds a 'segment' column and sorts by trade date.
 */
function buildMasterLedger(dfEquity, dfFno) {
  const cols = [...SHARED_COLS, ...FNO_EXTRA];

  const eqAligned = dfEquity.map((r) =>
    reindex({ ...r, segment: SEGMENT.equity, underlying: r.scrip_name }, cols)
  );

  const fnoHasUnderlying = dfFno.some((r) => r.underlying !== null && r.underlying !== undefined);
  const fnoAligned = dfFno.map((r) => {
    const segment = r.instrument_type || SEGMENT.futures;
    const underlying = fnoHasUnderlying && r.underlying ? r.underlying : r.scrip_name;
    return reindex({ ...r, segment, underlying }, cols);
  });

  const master = [...eqAligned, ...fnoAligned];

  // Sort by trade_date — nulls last, matching pandas sort_values default
  master.sort((a, b) => {
    const at = a.trade_date ? a.trade_date.getTime() : Infinity;
    const bt = b.trade_date ? b.trade_date.getTime() : Infinity;
    return at - bt;
  });

  for (const row of master) {
    row.trade_value = (Number(row.quantity) || 0) * (Number(row.price) || 0);
  }

  const count = (seg) => master.filter((r) => r.segment === seg).length;
  logger.info(`Master ledger built: ${master.length} total trades ✓`);
  logger.info(`  Equity : ${count("EQ")} trades`);
  logger.info(`  Futures: ${count("FUT")} trades`);
  logger.info(`  Options: ${count("OPT")} trades`);

  return master;
}

// ─────────────────────────────────────────────
// STEP 7 — Holdings Reconciliation
// ─────────────────────────────────────────────

/** Net equity position per stock from trade history. buy → +qty, sell → -qty */
function computeNetPositions(masterLedger) {
  const net = new Map();

  for (const row of masterLedger) {
    if (row.segment !== "EQ") continue;
    const qty = Number(row.quantity) || 0;
    const signed = String(row.trade_type).toLowerCase() === "buy" ? qty : -qty;
    const symbol = row.underlying;
    net.set(symbol, (net.get(symbol) || 0) + signed);
  }

  return [...net.entries()].map(([symbol, net_qty_from_trades]) => ({
    symbol,
    net_qty_from_trades,
  }));
}

/**
 * Compare computed positions from trades vs the broker's reported holdings.
 * Returns a reconciliation table with a 'discrepancy' flag.
 */
function reconcileHoldings(
  masterLedger,
  dfHoldings,
  holdingsSymbolCol = "tradingsymbol",
  holdingsQtyCol = "realised_quantity"
) {
  const netPositions = computeNetPositions(masterLedger);

  const brokerMap = new Map();
  for (const row of dfHoldings) {
    const symbol = cleanSymbol(row[holdingsSymbolCol]);
    const qty = Number(row[holdingsQtyCol]);
    brokerMap.set(symbol, Number.isFinite(qty) ? qty : 0);
  }

  // Outer join on symbol
  const symbols = new Set([
    ...netPositions.map((p) => p.symbol),
    ...brokerMap.keys(),
  ]);

  const netMap = new Map(netPositions.map((p) => [p.symbol, p.net_qty_from_trades]));

  const recon = [...symbols].map((symbol) => {
    const fromTrades = netMap.get(symbol) || 0;
    const brokerQty = brokerMap.get(symbol) || 0;
    return {
      symbol,
      net_qty_from_trades: fromTrades,
      broker_qty: brokerQty,
      discrepancy: fromTrades !== brokerQty,
      qty_diff: fromTrades - brokerQty,
    };
  });

  const discrepancies = recon.filter((r) => r.discrepancy).length;
  if (discrepancies > 0) {
    logger.warning(`Reconciliation: ${discrepancies} discrepancies found — check recon report`);
  } else {
    logger.info("Reconciliation: All positions match broker holdings ✓");
  }

  return recon;
}

// ─────────────────────────────────────────────
// MAIN CLEAN FUNCTION
// ─────────────────────────────────────────────

/**
 * Full Phase 2 cleaning pipeline.
 * @param {{equity: object[], fno: object[], holdings: object[]}} rawData from ingest()
 * @returns {{master_ledger: object[], holdings: object[], reconciliation: object[]}}
 */
function clean(rawData, broker = "zerodha") {
  const schema = BROKER_SCHEMAS[broker];
  const eqSchema = schema.equity;
  const fnoSchema = schema.fno;

  logger.info("=".repeat(50));
  logger.info("PHASE 2 — DATA CLEANING STARTED");
  logger.info("=".repeat(50));

  // ── Equity ──
  let eq = parseDates(rawData.equity, eqSchema.date_cols, "Equity");
  eq = standardizeSymbols(eq, eqSchema.symbol_col, "Equity");
  eq = removeDuplicates(eq, eqSchema.trade_id_col, "Equity");
  eq = cleanNumerics(eq, ["quantity", "price"], "Equity");

  // ── F&O ──
  let fno = parseDates(rawData.fno, fnoSchema.date_cols, "F&O");
  fno = removeDuplicates(fno, fnoSchema.trade_id_col, "F&O");
  fno = cleanNumerics(fno, ["quantity", "price"], "F&O");
  fno = parseFnoContracts(fno);

  // ── Holdings ──
  let holdings = standardizeSymbols(rawData.holdings, schema.holdings.symbol_col, "Holdings");
  holdings = cleanNumerics(holdings, ["average_price", "last_price", "pnl", "realised_quantity"], "Holdings");

  // ── Master Ledger ──
  const master = buildMasterLedger(eq, fno);

  // ── Reconciliation ──
  const recon = reconcileHoldings(master, holdings);

  logger.info("PHASE 2 — CLEANING COMPLETE ✓");

  return {
    master_ledger: master,
    holdings,
    reconciliation: recon,
  };
}

module.exports = {
  clean,
  parseDate,
  parseDates,
  cleanSymbol,
  standardizeSymbols,
  removeDuplicates,
  cleanNumerics,
  parseFnoInstrument,
  parseFnoContracts,
  buildMasterLedger,
  computeNetPositions,
  reconcileHoldings,
};
