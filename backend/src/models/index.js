// src/models/index.js
// Port of backend/database.py models.
// Column names and table names are kept EXACTLY the same so an existing
// Postgres database created by the FastAPI version keeps working unchanged.

const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");

// ── User ──────────────────────────────────────────────
const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.STRING, primaryKey: true },            // UUID
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    password_hash: { type: DataTypes.STRING, allowNull: false },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: "users", timestamps: false, indexes: [{ fields: ["email"] }] }
);

// ── Portfolio ─────────────────────────────────────────
// Each CSV upload creates one Portfolio snapshot — old ones are kept for history.
const Portfolio = sequelize.define(
  "Portfolio",
  {
    id: { type: DataTypes.STRING, primaryKey: true },            // UUID
    user_id: { type: DataTypes.STRING, allowNull: false },
    uploaded_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    is_active: { type: DataTypes.BOOLEAN, defaultValue: true },  // one active per user

    // Snapshot totals — stored so history queries stay O(1)
    total_invested: { type: DataTypes.FLOAT, defaultValue: 0 },
    total_current_value: { type: DataTypes.FLOAT, defaultValue: 0 },
    total_pnl: { type: DataTypes.FLOAT, defaultValue: 0 },
    total_pnl_pct: { type: DataTypes.FLOAT, defaultValue: 0 },
  },
  { tableName: "portfolios", timestamps: false, indexes: [{ fields: ["user_id"] }] }
);

// ── Stock ─────────────────────────────────────────────
// One row per stock per portfolio snapshot.
const Stock = sequelize.define(
  "Stock",
  {
    id: { type: DataTypes.STRING, primaryKey: true },            // UUID
    portfolio_id: { type: DataTypes.STRING, allowNull: false },

    symbol: { type: DataTypes.STRING, allowNull: false },
    total_invested: { type: DataTypes.FLOAT, defaultValue: 0 },
    current_value: { type: DataTypes.FLOAT, defaultValue: 0 },
    total_pnl: { type: DataTypes.FLOAT, defaultValue: 0 },
    total_pnl_pct: { type: DataTypes.FLOAT, defaultValue: 0 },
    realized_pnl: { type: DataTypes.FLOAT, defaultValue: 0 },
    unrealized_pnl: { type: DataTypes.FLOAT, defaultValue: 0 },
    xirr_pct: { type: DataTypes.FLOAT, allowNull: true },
    avg_buy_price: { type: DataTypes.FLOAT, defaultValue: 0 },
    last_price: { type: DataTypes.FLOAT, defaultValue: 0 },
    current_qty: { type: DataTypes.INTEGER, defaultValue: 0 },
    conviction_score: { type: DataTypes.INTEGER, defaultValue: 0 },
    tax_classification: { type: DataTypes.STRING, allowNull: true },  // LTCG / STCG / FNO
    avg_holding_days: { type: DataTypes.FLOAT, defaultValue: 0 },
    total_buy_trades: { type: DataTypes.INTEGER, defaultValue: 0 },
    total_sell_trades: { type: DataTypes.INTEGER, defaultValue: 0 },
    first_buy_date: { type: DataTypes.STRING, allowNull: true },
    volatility_pct: { type: DataTypes.FLOAT, allowNull: true },
    max_drawdown_pct: { type: DataTypes.FLOAT, allowNull: true },
    beta: { type: DataTypes.FLOAT, allowNull: true },
  },
  { tableName: "stocks", timestamps: false, indexes: [{ fields: ["portfolio_id"] }] }
);

// ── Relationships (cascade delete, same as SQLAlchemy) ─
User.hasMany(Portfolio, { foreignKey: "user_id", as: "portfolios", onDelete: "CASCADE" });
Portfolio.belongsTo(User, { foreignKey: "user_id", as: "user" });

Portfolio.hasMany(Stock, { foreignKey: "portfolio_id", as: "stocks", onDelete: "CASCADE" });
Stock.belongsTo(Portfolio, { foreignKey: "portfolio_id", as: "portfolio" });

/** Equivalent of create_tables() — creates anything missing, alters nothing. */
async function createTables() {
  await sequelize.authenticate();
  await sequelize.sync();
}

module.exports = { sequelize, User, Portfolio, Stock, createTables };
