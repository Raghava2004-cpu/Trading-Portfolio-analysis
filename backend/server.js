// server.js
// Entry point. Equivalent of: uvicorn api:app --host 0.0.0.0 --port 8000
// Run with: npm start

require("dotenv").config();

const app = require("./src/app");
const { createTables } = require("./src/models");
const { DATABASE_URL } = require("./src/config/database");

const PORT = process.env.PORT || 8000;
const HOST = process.env.HOST || "0.0.0.0";

async function main() {
  // FastAPI did this in @app.on_event("startup")
  await createTables();
  console.log(`[startup] Database ready (${DATABASE_URL.split("@").pop()})`);

  app.listen(PORT, HOST, () => {
    console.log(`[startup] StockSage API is live 🚀  http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[startup] Failed to start:", err);
  process.exit(1);
});
