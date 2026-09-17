// src/routes/prices.routes.js
// Mirrors APIRouter(prefix="/prices") from backend/prices.py

const express = require("express");
const { getPrices, getNifty } = require("../controllers/prices.controller");

const router = express.Router();

// /prices/nifty must be declared before the bare "/" handler
router.get("/nifty", getNifty);
router.get("/", getPrices);

module.exports = router;
