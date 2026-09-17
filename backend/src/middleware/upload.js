// src/middleware/upload.js
// Replaces FastAPI's UploadFile. The three CSVs land in data/raw under the
// exact filenames the ingestor expects — same as shutil.copyfileobj did.

const fs = require("fs");
const multer = require("multer");
const { DATA_RAW_DIR } = require("../config");
const { HttpError } = require("./errorHandler");

const FILE_MAP = {
  equity: "zerodha_tradebook_equity.csv",
  fno: "zerodha_tradebook_fno.csv",
  holdings: "zerodha_holdings.csv",
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(DATA_RAW_DIR, { recursive: true });
    cb(null, DATA_RAW_DIR);
  },
  filename(req, file, cb) {
    cb(null, FILE_MAP[file.fieldname] || file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter(req, file, cb) {
    const ok = /\.(csv|txt)$/i.test(file.originalname) ||
      ["text/csv", "application/vnd.ms-excel", "text/plain"].includes(file.mimetype);
    if (!ok) return cb(new HttpError(400, `${file.originalname} is not a CSV file.`));
    cb(null, true);
  },
});

const uploadTradebooks = upload.fields([
  { name: "equity", maxCount: 1 },
  { name: "fno", maxCount: 1 },
  { name: "holdings", maxCount: 1 },
]);

module.exports = { uploadTradebooks, FILE_MAP };
