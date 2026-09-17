// src/controllers/auth.controller.js
// Port of the route half of backend/auth.py

const crypto = require("crypto");
const { User } = require("../models");
const { hashPassword, verifyPassword, createToken } = require("../middleware/auth");
const { HttpError, asyncHandler } = require("../middleware/errorHandler");

const signup = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    throw new HttpError(422, "name, email and password are required.");
  }

  const existing = await User.findOne({ where: { email } });
  if (existing) throw new HttpError(400, "Email already registered.");

  const user = await User.create({
    id: crypto.randomUUID(),
    email,
    name,
    password_hash: hashPassword(password),
    created_at: new Date(),
  });

  res.json({
    token: createToken(user.id, user.email, user.name),
    is_new_user: true,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    throw new HttpError(422, "email and password are required.");
  }

  const user = await User.findOne({ where: { email } });
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, "Invalid email or password.");
  }

  res.json({
    token: createToken(user.id, user.email, user.name),
    is_new_user: false,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

const me = asyncHandler(async (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email });
});

module.exports = { signup, login, me };
