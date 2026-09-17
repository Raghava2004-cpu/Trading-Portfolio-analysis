// src/middleware/auth.js
// JWT creation / verification + the "current user" middleware.
// Port of the token half of backend/auth.py.
//
// Tokens stay compatible with the FastAPI version: same HS256 algorithm,
// same claims (sub, email, name, exp). Existing logged-in users are unaffected.

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { User } = require("../models");
const { HttpError, asyncHandler } = require("./errorHandler");

const SECRET_KEY = process.env.JWT_SECRET || "stocksage-dev-secret-change-in-production";
const ALGORITHM = "HS256";
const TOKEN_EXPIRY_DAYS = 30;

// ── Password helpers ──────────────────────────────────
// bcrypt has a hard 72-byte limit, same truncation as the Python version.
// bcryptjs can verify $2a$/$2b$ hashes written by Python's bcrypt, so old
// accounts keep working.
function hashPassword(password) {
  return bcrypt.hashSync(String(password).slice(0, 72), bcrypt.genSaltSync(12));
}

function verifyPassword(plain, hashed) {
  try {
    return bcrypt.compareSync(String(plain).slice(0, 72), hashed);
  } catch {
    return false;
  }
}

// ── Token helpers ─────────────────────────────────────
function createToken(userId, email, name) {
  return jwt.sign(
    { sub: userId, email, name },
    SECRET_KEY,
    { algorithm: ALGORITHM, expiresIn: `${TOKEN_EXPIRY_DAYS}d` }
  );
}

function decodeToken(token) {
  try {
    return jwt.verify(token, SECRET_KEY, { algorithms: [ALGORITHM] });
  } catch {
    throw new HttpError(401, "Token is invalid or expired. Please log in again.");
  }
}

// ── Middleware — attach req.user from the Bearer token ─
const getCurrentUser = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new HttpError(401, "Not authenticated.");
  }

  const payload = decodeToken(token);
  const user = await User.findByPk(payload.sub);

  if (!user) throw new HttpError(401, "User not found.");

  req.user = user;
  next();
});

module.exports = {
  hashPassword,
  verifyPassword,
  createToken,
  decodeToken,
  getCurrentUser,
  SECRET_KEY,
  TOKEN_EXPIRY_DAYS,
};
