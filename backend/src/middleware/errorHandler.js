// src/middleware/errorHandler.js
// FastAPI returns errors as { "detail": "..." } and the React frontend reads
// e.response.data.detail everywhere — so this port keeps the same shape.

class HttpError extends Error {
  constructor(statusCode, detail) {
    super(detail);
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

/** Wraps an async route handler so thrown errors reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ detail: `Not Found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;

  if (status >= 500) {
    console.error("[error]", err.stack || err.message);
  }

  res.status(status).json({
    detail: err.detail || err.message || "Internal server error",
  });
}

module.exports = { HttpError, asyncHandler, notFound, errorHandler };
