// src/config/database.js
// Sequelize connection. Mirrors the SQLAlchemy setup in backend/database.py:
// reads DATABASE_URL, falls back to a local SQLite file.

const { Sequelize } = require("sequelize");

const DATABASE_URL = process.env.DATABASE_URL || "sqlite:./stocksage.db";

let sequelize;

if (DATABASE_URL.startsWith("sqlite")) {
  // Accept sqlite:///./x.db (SQLAlchemy style) and sqlite:./x.db
  const storage = DATABASE_URL.replace(/^sqlite:(\/\/\/)?/, "") || "./stocksage.db";
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage,
    logging: false,
  });
} else {
  // Render / Heroku hand out postgres:// — Sequelize wants postgres:// too,
  // but managed Postgres needs SSL with a relaxed CA check.
  sequelize = new Sequelize(DATABASE_URL, {
    dialect: "postgres",
    logging: false,
    dialectOptions:
      process.env.DB_SSL === "false"
        ? {}
        : { ssl: { require: true, rejectUnauthorized: false } },
    pool: { max: 5, min: 0, idle: 10000 },
  });
}

module.exports = { sequelize, DATABASE_URL };
