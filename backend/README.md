# StockSage — Node.js / Express Backend

This is the StockSage backend rewritten in **Node.js + Express**. It replaces the
original FastAPI (Python) backend.

The React frontend does **not** need any code changes. Every route, every JSON
field name, and the error shape (`{"detail": "..."}`) are identical. You only
point the frontend at the new server URL.

---

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | PostgreSQL (SQLite for local dev) |
| ORM | Sequelize 6 |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| File upload | Multer |
| CSV parsing | `csv-parse` |
| Live prices | `yahoo-finance2` |
| Analytics | Plain JavaScript (no pandas / numpy needed) |

---

## Quick start

```bash
cd backend-node
npm install

cp .env.example .env      # then edit .env
npm start                 # http://localhost:8000
```

`npm run dev` restarts on file changes.

With no `DATABASE_URL` set it creates a local SQLite file (`stocksage.db`), so
you can run it with zero setup.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `sqlite:./stocksage.db` |
| `DB_SSL` | Set `false` for a local Postgres without SSL | `true` |
| `JWT_SECRET` | Signing key for tokens | dev value — **change it** |
| `PORT` | Port to listen on | `8000` |
| `HOST` | Bind address | `0.0.0.0` |
| `CORS_ORIGIN` | Comma-separated allowed origins | `*` |

**Migrating from the Python backend?** Use the *same* `JWT_SECRET` and the
*same* `DATABASE_URL`. Tokens and password hashes are compatible, so nobody has
to log in again and no data has to move. Sequelize creates any missing table
and leaves existing ones alone.

### Point the frontend at it

In `frontend/src/constants.js`:

```js
export const API = "http://localhost:8000";        // local
// export const API = "https://your-node-api.onrender.com";   // production
```

---

## API reference

All routes except `/` and `/auth/*` need `Authorization: Bearer <token>`.

| Method | Route | What it does |
|---|---|---|
| GET | `/` | Health check |
| POST | `/auth/signup` | Create account → `{ token, is_new_user, user }` |
| POST | `/auth/login` | Log in → `{ token, is_new_user, user }` |
| GET | `/auth/me` | Current user |
| GET | `/status` | `{ scorecard_ready: bool }` |
| POST | `/upload` | Multipart: `equity`, `fno`, `holdings` CSVs → runs the full pipeline |
| GET | `/stocks` | All stocks. Query: `sort_by`, `order`, `segment` |
| GET | `/portfolio/summary` | Totals, best/worst stock, LTCG/STCG counts |
| GET | `/portfolio/history` | Every upload snapshot, oldest first |
| GET | `/portfolio/tax-harvest` | Tax-loss harvesting suggestions |
| GET | `/prices?symbols=RELIANCE,TCS` | Live prices + previous close (15-min cache) |
| GET | `/prices/nifty` | Nifty 50 value, day change, 1-year return |

Errors always come back as `{ "detail": "message" }` with the right status code.

---

## Project structure

```
backend-node/
├── server.js                       # entry point (replaces uvicorn)
├── package.json
├── .env.example
├── Procfile                        # for Render / Heroku
└── src/
    ├── app.js                      # Express app, CORS, routers
    ├── config/
    │   ├── index.js                # broker schemas, symbol rename map, tax rates
    │   └── database.js             # Sequelize connection
    ├── models/index.js             # User, Portfolio, Stock
    ├── middleware/
    │   ├── auth.js                 # JWT create/verify, bcrypt, auth guard
    │   ├── upload.js               # Multer — writes the 3 CSVs to data/raw
    │   └── errorHandler.js         # {detail} error shape
    ├── routes/                     # auth, prices, portfolio
    ├── controllers/                # auth, prices, portfolio
    ├── pipeline/
    │   ├── ingestor.js             # Phase 1 — load + validate CSVs
    │   ├── cleaner.js              # Phase 2 — dates, symbols, dupes, F&O, ledger
    │   └── analytics.js            # Phase 3 — the 6 analytics modules
    └── utils/
        ├── logger.js
        ├── math.js                 # the pandas/numpy maths, hand-written
        └── yahoo.js                # shared Yahoo Finance client
```

---

## How the Python maps to the Node

| Python file | Node file | Notes |
|---|---|---|
| `api.py` | `src/app.js` + `src/controllers/portfolio.controller.js` | FastAPI app → Express app |
| `auth.py` | `src/middleware/auth.js` + `src/controllers/auth.controller.js` | `python-jose` → `jsonwebtoken`, `bcrypt` → `bcryptjs` |
| `database.py` | `src/config/database.js` + `src/models/index.js` | SQLAlchemy → Sequelize, same table and column names |
| `prices.py` | `src/controllers/prices.controller.js` | `yfinance` → `yahoo-finance2` |
| `config.py` | `src/config/index.js` | Straight translation |
| `pipeline/ingestor.py` | `src/pipeline/ingestor.js` | `pd.read_csv` → `csv-parse` |
| `pipeline/cleaner.py` | `src/pipeline/cleaner.js` | DataFrame → array of row objects |
| `pipeline/analytics.py` | `src/pipeline/analytics.js` | All 6 modules, no numpy |
| `utils/logger.py` | `src/utils/logger.js` | |

A pandas DataFrame becomes a plain array of objects. `groupby` becomes a `Map`,
`merge` becomes a left-join helper, and `std` / `cov` / `pct_change` are written
out by hand in `src/utils/math.js`. All six analytics modules — FIFO P&L, XIRR,
holding period, volatility & beta, conviction score, F&O P&L — produce the same
numbers as before.

---

## Three deliberate differences from the Python version

### 1. Date parsing is fixed (this is a real bug fix)

`cleaner.py` used `pd.to_datetime(col, dayfirst=True)`. On Zerodha's
`YYYY-MM-DD` dates, pandas guesses the format as `%Y-%d-%m`, which silently
corrupts or drops rows. Verified on pandas 2.2.3, the version pinned in
`requirements.txt`:

```
'2022-01-10'  →  2022-10-01   (month and day swapped)
'2022-06-15'  →  NaT          (dropped by dropna in analytics)
'2023-08-20'  →  NaT          (dropped)
```

Any trade whose day-of-month is above 12 disappeared from the ledger. On the
same test file the Python pipeline reported INFY as ₹17,005 invested with zero
sells; the Node pipeline reports ₹24,255 invested with −₹1,444 realised P&L.

`parseDate()` in `src/pipeline/cleaner.js` reads ISO dates as ISO and only
applies day-first logic to genuinely ambiguous formats like `12/04/2023`.

**Worth checking:** your deployed dashboard numbers are probably under-counting
trades. Compare the trade count in the logs against the row count in your CSV.

### 2. Timestamps are stored in UTC and displayed in IST

The Python version stored a naive IST timestamp and then *added* 5:30 again when
building the history labels, pushing displayed times 5½ hours ahead. The Node
version stores proper UTC and formats with `Asia/Kolkata`, so history labels show
the real Indian time.

Rows written by the old backend will read 5:30 early under the new formatting.
New uploads are correct.

### 3. Simulated price series are now reproducible

When risk metrics run offline, prices are simulated. Python seeded the generator
from `hash(symbol)`, which Python randomises per process — so volatility and beta
changed on every restart. The Node version seeds from a stable FNV-1a hash, so
the same symbol always gives the same series. The numbers themselves will differ
from any single old run; they are simulated either way, and only used when live
prices are unavailable.

Minor: in `/stocks`, rows with a `null` sort value now always sort to the bottom
instead of jumping to the top on descending sorts.

---

## Deploying on Render

1. New → **Web Service**, point it at this repo.
2. Root directory: `backend-node`
3. Build command: `npm install`
4. Start command: `npm start`
5. Environment: add `DATABASE_URL`, `JWT_SECRET`, and `CORS_ORIGIN`.

Render sets `PORT` itself, so leave it out of your environment variables.

---

## Testing it locally

```bash
# 1. Create an account
curl -X POST http://localhost:8000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ashok","email":"you@example.com","password":"secret123"}'

# 2. Upload the three Zerodha CSVs (paste the token from step 1)
curl -X POST http://localhost:8000/upload \
  -H "Authorization: Bearer <TOKEN>" \
  -F "equity=@zerodha_tradebook_equity.csv" \
  -F "fno=@zerodha_tradebook_fno.csv" \
  -F "holdings=@zerodha_holdings.csv"

# 3. Read the results
curl http://localhost:8000/portfolio/summary -H "Authorization: Bearer <TOKEN>"
```
