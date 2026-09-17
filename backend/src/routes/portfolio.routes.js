// src/routes/portfolio.routes.js
// Mirrors the routes declared directly on the FastAPI app in backend/api.py

const express = require("express");
const { getCurrentUser } = require("../middleware/auth");
const { uploadTradebooks } = require("../middleware/upload");
const ctrl = require("../controllers/portfolio.controller");

const router = express.Router();

router.get("/", ctrl.root);
router.get("/status", getCurrentUser, ctrl.status);

router.post("/upload", getCurrentUser, uploadTradebooks, ctrl.uploadAndRun);

router.get("/stocks", getCurrentUser, ctrl.getAllStocks);
router.get("/portfolio/summary", getCurrentUser, ctrl.portfolioSummary);
router.get("/portfolio/history", getCurrentUser, ctrl.portfolioHistory);
router.get("/portfolio/tax-harvest", getCurrentUser, ctrl.taxHarvestSuggestions);

module.exports = router;
