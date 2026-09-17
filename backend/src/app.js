// src/app.js
// Express application — the equivalent of the FastAPI app object in api.py.

const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const pricesRoutes = require("./routes/prices.routes");
const portfolioRoutes = require("./routes/portfolio.routes");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();

// CORS — allow_origins=["*"] in the FastAPI version.
// Set CORS_ORIGIN to a comma-separated list to lock it down in production.
const origins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
  : "*";

app.use(cors({ origin: origins, methods: "*", allowedHeaders: "*" }));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Strip a trailing slash so /prices/ and /prices both work, the way FastAPI's
// redirect_slashes did.
app.use((req, res, next) => {
  if (req.path.length > 1 && req.path.endsWith("/")) {
    const query = req.url.slice(req.path.length);
    return res.redirect(308, req.path.slice(0, -1) + query);
  }
  next();
});

app.use("/auth", authRoutes);
app.use("/prices", pricesRoutes);
app.use("/", portfolioRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
