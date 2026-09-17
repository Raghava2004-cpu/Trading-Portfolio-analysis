// src/config/index.js
// Central config for all broker schemas and project settings.
// To support a new broker, add a new key under BROKER_SCHEMAS.
// Port of backend/config.py

const path = require("path");

const BROKER_SCHEMAS = {
  zerodha: {
    equity: {
      required_columns: [
        "trade_date", "order_execution_time", "trade_type",
        "scrip_name", "exchange", "quantity", "price",
        "trade_id", "order_id", "series",
      ],
      date_cols: ["trade_date", "order_execution_time"],
      symbol_col: "scrip_name",
      trade_type_col: "trade_type",
      quantity_col: "quantity",
      price_col: "price",
      trade_id_col: "trade_id",
    },
    fno: {
      required_columns: [
        "trade_date", "order_execution_time", "trade_type",
        "scrip_name", "exchange", "quantity", "price",
        "trade_id", "order_id", "series",
      ],
      date_cols: ["trade_date", "order_execution_time"],
      symbol_col: "scrip_name",
      trade_type_col: "trade_type",
      quantity_col: "quantity",
      price_col: "price",
      trade_id_col: "trade_id",
      expiry_col: "expiry_date",
      strike_col: "strike_price",
      option_type_col: "option_type",
    },
    holdings: {
      required_columns: [
        "tradingsymbol", "exchange", "isin",
        "average_price", "last_price", "pnl",
      ],
      symbol_col: "tradingsymbol",
      avg_price_col: "average_price",
      last_price_col: "last_price",
      quantity_col: "realised_quantity",
    },
  },
};

// Symbol rename map — handles mergers, rebranding
const SYMBOL_RENAME_MAP = {
  MINDTREE: "LTIM",
  LTINFOTECH: "LTIM",
  HDFC: "HDFCBANK", // post-merger 2023
  INFRATEL: "BHARTIARTL",
  ZEEL: "ZEEMEDIA",
  "INFY EQ": "INFY",
  "TCS EQ": "TCS",
  "RELIANCE EQ": "RELIANCE",
};

// Segment labels used in master ledger
const SEGMENT = {
  equity: "EQ",
  futures: "FUT",
  options: "OPT",
};

// Paths
const DATA_RAW_DIR = process.env.DATA_RAW_DIR || path.join(process.cwd(), "data", "raw");
const DATA_CLEANED_DIR = path.join(process.cwd(), "data", "cleaned");

// Tax constants (Budget 2024)
const LTCG_EXEMPTION = 125000;
const LTCG_TAX_RATE = 0.125;
const STCG_TAX_RATE = 0.20;

module.exports = {
  BROKER_SCHEMAS,
  SYMBOL_RENAME_MAP,
  SEGMENT,
  DATA_RAW_DIR,
  DATA_CLEANED_DIR,
  LTCG_EXEMPTION,
  LTCG_TAX_RATE,
  STCG_TAX_RATE,
};
