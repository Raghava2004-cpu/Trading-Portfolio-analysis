// src/utils/math.js
// Small numeric helpers that replace the pandas / numpy calls used by the
// original Python pipeline. Kept deliberately tiny and dependency-free.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Round to n decimal places, returning null for non-finite input. */
function round(value, digits = 2) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** null / undefined / NaN / Infinity → null. Everything else passes through. */
function safeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function sum(arr) {
  return arr.reduce((acc, v) => acc + (Number(v) || 0), 0);
}

function mean(arr) {
  if (!arr.length) return NaN;
  return sum(arr) / arr.length;
}

/** Sample standard deviation (pandas Series.std() default, ddof = 1). */
function std(arr) {
  const n = arr.length;
  if (n < 2) return NaN;
  const m = mean(arr);
  const ss = arr.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

/** Sample covariance (numpy.cov default, ddof = 1). */
function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (a[i] - ma) * (b[i] - mb);
  return acc / (n - 1);
}

/** Percentage change series — equivalent to pandas Series.pct_change().dropna(). */
function pctChange(values) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    if (!Number.isFinite(prev) || prev === 0) continue;
    const change = (values[i] - prev) / prev;
    if (Number.isFinite(change)) out.push(change);
  }
  return out;
}

/** Worst peak-to-trough drop of a price series, as a negative fraction. */
function maxDrawdown(prices) {
  let peak = -Infinity;
  let worst = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    if (peak > 0) {
      const dd = (p - peak) / peak;
      if (dd < worst) worst = dd;
    }
  }
  return worst;
}

/**
 * Deterministic 32-bit string hash (FNV-1a).
 * Python's built-in hash() is salted per process, so the original simulated
 * price series was never reproducible across runs. This one always is.
 */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, seeded uniform RNG in [0, 1). */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal deviate from a uniform generator (Box–Muller transform). */
function normalFrom(rand, loc = 0, scale = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return loc + scale * z;
}

/** Whole days between two Dates, truncated like pandas Timedelta.days. */
function daysBetween(later, earlier) {
  if (!later || !earlier) return 0;
  return Math.floor((later.getTime() - earlier.getTime()) / DAY_MS);
}

/** Mean of a list of Dates, as a Date. */
function meanDate(dates) {
  if (!dates.length) return null;
  const avg = sum(dates.map((d) => d.getTime())) / dates.length;
  return new Date(avg);
}

/** YYYY-MM-DD for a Date, or null. */
function toDateString(d) {
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

module.exports = {
  DAY_MS,
  round,
  safeNumber,
  sum,
  mean,
  std,
  covariance,
  pctChange,
  maxDrawdown,
  hashString,
  seededRandom,
  normalFrom,
  daysBetween,
  meanDate,
  toDateString,
};
