// src/utils/logger.js
// Port of backend/utils/logger.py

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function getLogger(name) {
  const write = (level, msg) => {
    console.log(`${stamp()}  [${level}]  ${name} — ${msg}`);
  };
  return {
    info: (msg) => write("INFO", msg),
    warning: (msg) => write("WARNING", msg),
    warn: (msg) => write("WARNING", msg),
    error: (msg) => write("ERROR", msg),
  };
}

module.exports = { getLogger };
