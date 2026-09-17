// src/pipeline/ingestor.js
// PHASE 1 — Data Ingestion
// Port of backend/pipeline/ingestor.py
//
// A pandas DataFrame becomes a plain array of row objects here.
// Headers are lowercased and snake_cased exactly as pandas did.

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const { getLogger } = require("../utils/logger");
const { BROKER_SCHEMAS, DATA_RAW_DIR } = require("../config");

const logger = getLogger("ingestor");

/** Load a single CSV into an array of row objects with basic sanity checks. */
function loadCsv(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  // Strip a UTF-8 BOM if the broker export has one.
  const text = fs.readFileSync(filepath, "utf8").replace(/^\uFEFF/, "");

  const rows = parse(text, {
    columns: (header) =>
      header.map((col) => String(col).trim().toLowerCase().replace(/\s+/g, "_")),
    skip_empty_lines: true,
    trim: true,               // matches skipinitialspace=True
    relax_column_count: true,
    bom: true,
  });

  if (!rows.length) {
    throw new Error(`File is empty: ${filepath}`);
  }

  logger.info(`Loaded ${rows.length} rows from ${path.basename(filepath)}`);
  return rows;
}

/** Raise clearly if any required column is missing. */
function validateSchema(rows, requiredCols, fileLabel) {
  const found = Object.keys(rows[0] || {});
  const missing = requiredCols.filter((col) => !found.includes(col));

  if (missing.length) {
    throw new Error(
      `[${fileLabel}] Missing required columns: ${missing.join(", ")}\n` +
      `Found columns: ${found.join(", ")}`
    );
  }

  logger.info(`[${fileLabel}] Schema validation passed ✓`);
}

/**
 * Read the three Zerodha exports off disk and validate them.
 * @returns {{equity: object[], fno: object[], holdings: object[]}}
 */
function ingest({
  broker = "zerodha",
  equityFile = null,
  fnoFile = null,
  holdingsFile = null,
} = {}) {
  if (!BROKER_SCHEMAS[broker]) {
    throw new Error(
      `Unsupported broker '${broker}'. Supported: ${Object.keys(BROKER_SCHEMAS).join(", ")}`
    );
  }

  const schema = BROKER_SCHEMAS[broker];

  const equityPath = equityFile || path.join(DATA_RAW_DIR, "zerodha_tradebook_equity.csv");
  const fnoPath = fnoFile || path.join(DATA_RAW_DIR, "zerodha_tradebook_fno.csv");
  const holdingsPath = holdingsFile || path.join(DATA_RAW_DIR, "zerodha_holdings.csv");

  logger.info("=".repeat(50));
  logger.info("PHASE 1 — DATA INGESTION STARTED");
  logger.info("=".repeat(50));

  const equity = loadCsv(equityPath);
  const fno = loadCsv(fnoPath);
  const holdings = loadCsv(holdingsPath);

  validateSchema(equity, schema.equity.required_columns, "Equity Tradebook");
  validateSchema(fno, schema.fno.required_columns, "F&O Tradebook");
  validateSchema(holdings, schema.holdings.required_columns, "Holdings");

  logger.info("PHASE 1 — INGESTION COMPLETE ✓");
  logger.info(`Equity trades : ${equity.length} rows`);
  logger.info(`F&O trades    : ${fno.length} rows`);
  logger.info(`Holdings      : ${holdings.length} rows`);

  return { equity, fno, holdings };
}

module.exports = { ingest, loadCsv, validateSchema };
