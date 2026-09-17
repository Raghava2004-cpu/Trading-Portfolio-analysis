// src/routes/auth.routes.js
// Mirrors APIRouter(prefix="/auth") from backend/auth.py

const express = require("express");
const { signup, login, me } = require("../controllers/auth.controller");
const { getCurrentUser } = require("../middleware/auth");

const router = express.Router();

router.post("/signup", signup);
router.post("/login", login);
router.get("/me", getCurrentUser, me);

module.exports = router;
