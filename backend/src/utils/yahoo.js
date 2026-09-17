// src/utils/yahoo.js
// Single shared Yahoo Finance client.
//
// yahoo-finance2 v4 no longer exports a ready-made singleton the way v2 did —
// you construct it yourself. Keeping that in one place means the rest of the
// code just does `const yahooFinance = require("../utils/yahoo");`.

const YahooFinance = require("yahoo-finance2").default;

const yahooFinance = new YahooFinance({
  // Keep the library's survey / notice banners out of the server logs
  suppressNotices: ["yahooSurvey", "ripHistorical"],
  validation: {
    // Yahoo changes response fields often; a schema mismatch should not take
    // a price request down, so log and carry on instead of throwing.
    logErrors: false,
    logOptionsErrors: false,
  },
});

module.exports = yahooFinance;
