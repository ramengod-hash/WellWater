'use strict';

const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const path     = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── In-memory cache (EPA updates monthly — 6h TTL is plenty) ───
const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.val;
}
function cacheSet(key, val) {
  cache.set(key, { val, ts: Date.now() });
  // Prevent unbounded growth
  if (cache.size > 2000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
    cache.delete(oldest);
  }
}

// ── Simple in-memory rate limiter (100 req / 15 min per IP) ────
const rateMap = new Map();
const RATE_WINDOW_MS  = 15 * 60 * 1000;
const RATE_MAX        = 100;

function rateLimit(req, res, next) {
  const ip  = req.ip || 'unknown';
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW_MS) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateMap.set(ip, entry);
  if (entry.count > RATE_MAX) {
    return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests. Please wait a few minutes.' });
  }
  next();
}

// ── EPA fetch with timeout + retry ──────────────────────────────
const EPA_BASE    = 'https://data.epa.gov/efservice';
const TIMEOUT_MS  = 12000;
const MAX_RETRIES = 2;

async function epaFetch(path, attempt = 0) {
  const url = `${EPA_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'WellWater/1.0 (public health tool)' }
    });
    clearTimeout(timer);

    if (!res.ok) {
      // 404 from EPA means no data — not a server error
      if (res.status === 404) return [];
      throw Object.assign(new Error(`EPA returned ${res.status}`), { status: res.status });
    }

    const text = await res.text();
    if (!text || text.trim() === '' || text.trim() === '[]') return [];

    try {
      return JSON.parse(text);
    } catch {
      // EPA occasionally returns malformed JSON on empty result sets
      return [];
    }
  } catch (err) {
    clearTimeout(timer);
    if (attempt < MAX_RETRIES && err.name !== 'AbortError') {
      await new Promise(r => setTimeout(r, 600 * (attempt + 1))); // back-off
      return epaFetch(path, attempt + 1);
    }
    throw err;
  }
}

// ── Data normalisation ───────────────────────────────────────────

/**
 * Normalize a raw SDWIS WATER_SYSTEM row into a clean object
 * the frontend can trust unconditionally.
 */
function normalizeSystem(raw) {
  return {
    pwsid:           raw.pwsid            || null,
    name:            raw.pws_name         || 'Unknown Water System',
    city:            raw.city_name        || null,
    state:           raw.state_code       || null,
    zip:             raw.zip_code         || null,
    type:            raw.pws_type_code    || null,       // CWS | NTNCWS | TNCWS
    sourceCode:      raw.primary_source_code || null,   // GW | SW | GWP | SWP | GU
    population:      raw.population_served_count
                       ? parseInt(raw.population_served_count, 10)
                       : null,
    owner:           raw.owner_type_code  || null,
    activity:        raw.pws_activity_code || null,
    phone:           raw.phone_number     || null,
    epaLink:         raw.pwsid
                       ? `https://echo.epa.gov/drinking-water/water-systems/details/${raw.pwsid}`
                       : null,
  };
}

/**
 * Categorise a violation row.
 * Returns { category, contaminant, isHealthBased, isOpen, startDate, endDate, raw }
 */
const FIVE_YEARS_AGO = Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000;

const CONTAMINANT_LABELS = {
  // Chemical
  'TCR':    'Total Coliform Rule',
  'LCR':    'Lead & Copper Rule',
  '1040':   'Nitrate',
  '1041':   'Nitrite',
  '1005':   'Arsenic',
  '1025':   'Lead',
  '1030':   'Copper',
  '2050':   'Atrazine',
  '2456':   'Trichloroethylene (TCE)',
  'PFOA':   'PFAS (PFOA)',
  'PFOS':   'PFAS (PFOS)',
  '4010':   'Radium-226/228',
  '4000':   'Gross Alpha',
  '3100':   'E. coli',
  'BARIUM': 'Barium',
  'CHROMIUM': 'Chromium-6',
};

function normalizeViolation(raw) {
  const catCode   = (raw.violation_category_code || '').toUpperCase();
  const typeCode  = (raw.violation_type_code     || '').toUpperCase();
  const contCode  = (raw.contaminant_code        || '').toUpperCase();
  const contName  = raw.contaminant_name         || contCode || 'Unknown';
  const status    = (raw.compliance_status_code  || '').toUpperCase();

  // Health-based = MCL exceeded, treatment technique failure, MRDL exceeded
  const isHealthBased = ['MCL', 'MRDL', 'TT'].some(c => catCode === c || typeCode.startsWith(c));

  const isOpen = status !== 'R' && !raw.return_to_compliance_period_end_date;

  const startDate = raw.compliance_period_begin_date
    ? new Date(raw.compliance_period_begin_date)
    : raw.occurrence_submit_date
    ? new Date(raw.occurrence_submit_date)
    : null;

  const endDate = raw.return_to_compliance_period_end_date
    ? new Date(raw.return_to_compliance_period_end_date)
    : null;

  // Human-readable category
  let category = 'other';
  if (isHealthBased)                              category = 'health';
  else if (catCode === 'MR' || typeCode.includes('MON') || typeCode.includes('MR')) category = 'monitoring';

  // Best label for the contaminant
  const label = CONTAMINANT_LABELS[contCode] || contName;

  return {
    id:            raw.violation_id || null,
    pwsid:         raw.pwsid        || null,
    category,                     // 'health' | 'monitoring' | 'other'
    contaminant:   label,
    contaminantCode: contCode,
    isHealthBased,
    isOpen,
    startDate:     startDate ? startDate.toISOString().slice(0, 10) : null,
    endDate:       endDate   ? endDate.toISOString().slice(0, 10)   : null,
    statusCode:    raw.compliance_status_code || null,
    violationTypeCode: raw.violation_type_code || null,
    enforcementId: raw.enforcement_id || null,
    raw: undefined, // don't leak raw EPA fields
  };
}

/**
 * Compute risk score from normalised violations.
 * Returns { level, label, summary }
 */
function computeRisk(violations) {
  const healthOpen  = violations.filter(v => v.isHealthBased && v.isOpen).length;
  const healthTotal = violations.filter(v => v.isHealthBased).length;
  const monOpen     = violations.filter(v => v.category === 'monitoring' && v.isOpen).length;

  if (healthOpen >= 3)              return { level: 'critical', label: 'Critical',      score: 4 };
  if (healthOpen >= 1)              return { level: 'high',     label: 'High risk',     score: 3 };
  if (healthTotal >= 3 || monOpen >= 3) return { level: 'moderate', label: 'Moderate risk', score: 2 };
  if (healthTotal >= 1 || monOpen >= 1) return { level: 'moderate', label: 'Moderate risk', score: 2 };
  return                                   { level: 'low',      label: 'Low risk',      score: 1 };
}

/**
 * Build test recommendations based on violations and source type.
 */
const TEST_RECOMMENDATIONS = {
  COLIFORM: { name: 'Total Coliform & E. coli', reason: 'Indicated by TCR violations. Fecal contamination risk.' },
  LEAD:     { name: 'Lead',         reason: 'LCR violations present, or universal baseline — no safe level.' },
  NITRATE:  { name: 'Nitrate',      reason: 'Common near farms and feedlots. Dangerous for infants.' },
  ARSENIC:  { name: 'Arsenic',      reason: 'Found in groundwater sources. Long-term cancer risk.' },
  PFAS:     { name: 'PFAS',         reason: 'Increasingly detected near industrial/military sites.' },
  RADIUM:   { name: 'Radium (radioactivity)', reason: 'Found in some groundwater; linked to bone cancer.' },
};

function buildTestRecs(violations, system) {
  const recs = new Set(['LEAD', 'NITRATE']); // always recommend these two baselines
  const source = (system.sourceCode || '').toUpperCase();

  violations.forEach(v => {
    const c = v.contaminantCode;
    if (c === 'TCR' || c === '3100')         recs.add('COLIFORM');
    if (c === 'LCR' || c === '1025')         recs.add('LEAD');
    if (c === '1040' || c === '1041')        recs.add('NITRATE');
    if (c === '1005')                        recs.add('ARSENIC');
    if (c.includes('PFAS') || c === 'PFOA' || c === 'PFOS') recs.add('PFAS');
    if (c === '4010' || c === '4000')        recs.add('RADIUM');
  });

  // Groundwater systems: add arsenic & radium checks
  if (source.startsWith('GW') || source === 'G' || source === 'GU') {
    recs.add('ARSENIC');
    recs.add('RADIUM');
  }

  return [...recs].slice(0, 6).map(k => TEST_RECOMMENDATIONS[k]).filter(Boolean);
}

// ── Route helpers ────────────────────────────────────────────────

async function resolveSystemFromZip(zip) {
  // Strategy 1: geographic area table (most accurate — uses service-area boundaries)
  let geoRows = await epaFetch(`/GEOGRAPHIC_AREA/ZIP_CODE_SERVED/${zip}/JSON`);
  if (!Array.isArray(geoRows)) geoRows = [];

  let pwsid = null;

  // Prefer Community Water Systems
  if (geoRows.length > 0) {
    const cws = geoRows.find(g => (g.pws_type_code || '').toUpperCase() === 'CWS');
    pwsid = (cws || geoRows[0]).pwsid;
  }

  // Strategy 2: direct zip lookup on WATER_SYSTEM table
  if (!pwsid) {
    let direct = await epaFetch(`/WATER_SYSTEM/ZIP_CODE/${zip}/PWS_TYPE_CODE/CWS/JSON`);
    if (!Array.isArray(direct)) direct = [];
    if (direct.length > 0) pwsid = direct[0].pwsid;
  }

  if (!pwsid) return null;

  // Fetch the full system record
  const sysRows = await epaFetch(`/WATER_SYSTEM/PWSID/${pwsid}/JSON`);
  if (!Array.isArray(sysRows) || sysRows.length === 0) return null;

  return { pwsid, raw: sysRows[0] };
}

async function resolveViolations(pwsid) {
  const rows = await epaFetch(`/VIOLATION/PWSID/${pwsid}/JSON`);
  if (!Array.isArray(rows)) return [];

  return rows
    .map(normalizeViolation)
    // Only last 5 years — older records are historical noise for most users
    .filter(v => {
      if (!v.startDate) return false;
      return new Date(v.startDate).getTime() >= FIVE_YEARS_AGO;
    })
    // Sort: open health-based first, then by date desc
    .sort((a, b) => {
      if (a.isHealthBased && a.isOpen && !(b.isHealthBased && b.isOpen)) return -1;
      if (b.isHealthBased && b.isOpen && !(a.isHealthBased && a.isOpen)) return  1;
      return (b.startDate || '').localeCompare(a.startDate || '');
    });
}

// ── Middleware ───────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(rateLimit);

// Serve the frontend from the same origin (avoids CORS entirely in production)
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────────

/**
 * GET /api/water/:zip
 * Main endpoint. Returns system info + violations + risk score + test recs.
 */
app.get('/api/water/:zip', async (req, res) => {
  const zip = (req.params.zip || '').replace(/\D/g, '').slice(0, 5);

  if (zip.length !== 5) {
    return res.status(400).json({
      error: 'INVALID_ZIP',
      message: 'Please provide a valid 5-digit US zip code.',
    });
  }

  const cacheKey = `zip:${zip}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // 1 — resolve system
    const systemResult = await resolveSystemFromZip(zip);

    if (!systemResult) {
      return res.status(404).json({
        error: 'NO_SYSTEM',
        message: `No community water system found for zip code ${zip}. This area may be served by private wells, or the system uses a different zip code. Try a neighboring zip.`,
        zip,
      });
    }

    const { pwsid, raw } = systemResult;
    const system = normalizeSystem(raw);

    // 2 — fetch violations
    const violations = await resolveViolations(pwsid);

    // 3 — compute derived data
    const risk  = computeRisk(violations);
    const tests = buildTestRecs(violations, system);

    const stats = {
      total:            violations.length,
      healthBasedTotal: violations.filter(v => v.isHealthBased).length,
      healthBasedOpen:  violations.filter(v => v.isHealthBased && v.isOpen).length,
      monitoringOpen:   violations.filter(v => v.category === 'monitoring' && v.isOpen).length,
      resolvedCount:    violations.filter(v => !v.isOpen).length,
    };

    const payload = {
      zip,
      system,
      violations,
      risk,
      stats,
      tests,
      cached:      false,
      fetchedAt:   new Date().toISOString(),
      dataSource:  'EPA SDWIS via Envirofacts',
    };

    cacheSet(cacheKey, payload);
    return res.json(payload);

  } catch (err) {
    console.error(`[/api/water/${zip}]`, err.message);
    return res.status(502).json({
      error: 'UPSTREAM_ERROR',
      message: 'Could not reach the EPA database. Please try again in a few seconds.',
    });
  }
});

/**
 * GET /api/system/:pwsid
 * Look up a specific water system directly by its EPA PWSID.
 * Useful for sharing links like /system/TX0010001
 */
app.get('/api/system/:pwsid', async (req, res) => {
  const pwsid = (req.params.pwsid || '').toUpperCase().trim();
  if (!pwsid) return res.status(400).json({ error: 'INVALID_PWSID', message: 'PWSID is required.' });

  const cacheKey = `pwsid:${pwsid}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const sysRows = await epaFetch(`/WATER_SYSTEM/PWSID/${pwsid}/JSON`);
    if (!Array.isArray(sysRows) || sysRows.length === 0) {
      return res.status(404).json({ error: 'NO_SYSTEM', message: `No water system found with PWSID ${pwsid}.` });
    }

    const system     = normalizeSystem(sysRows[0]);
    const violations = await resolveViolations(pwsid);
    const risk       = computeRisk(violations);
    const tests      = buildTestRecs(violations, system);
    const stats      = {
      total:            violations.length,
      healthBasedTotal: violations.filter(v => v.isHealthBased).length,
      healthBasedOpen:  violations.filter(v => v.isHealthBased && v.isOpen).length,
      monitoringOpen:   violations.filter(v => v.category === 'monitoring' && v.isOpen).length,
      resolvedCount:    violations.filter(v => !v.isOpen).length,
    };

    const payload = { pwsid, system, violations, risk, stats, tests, cached: false, fetchedAt: new Date().toISOString() };
    cacheSet(cacheKey, payload);
    return res.json(payload);

  } catch (err) {
    console.error(`[/api/system/${pwsid}]`, err.message);
    return res.status(502).json({ error: 'UPSTREAM_ERROR', message: 'Could not reach the EPA database.' });
  }
});

/**
 * GET /api/report/:pwsid
 * Returns a plain-text constituent letter for this water system.
 * If the system has no health violations, returns 204 No Content.
 */
app.get('/api/report/:pwsid', async (req, res) => {
  const pwsid = (req.params.pwsid || '').toUpperCase().trim();
  if (!pwsid) return res.status(400).json({ error: 'INVALID_PWSID' });

  // Re-use cached system data if available
  let payload = cacheGet(`pwsid:${pwsid}`);

  if (!payload) {
    try {
      const sysRows = await epaFetch(`/WATER_SYSTEM/PWSID/${pwsid}/JSON`);
      if (!Array.isArray(sysRows) || sysRows.length === 0) {
        return res.status(404).json({ error: 'NO_SYSTEM' });
      }
      const system     = normalizeSystem(sysRows[0]);
      const violations = await resolveViolations(pwsid);
      const risk       = computeRisk(violations);
      payload = { system, violations, risk };
    } catch {
      return res.status(502).json({ error: 'UPSTREAM_ERROR' });
    }
  }

  const { system, violations } = payload;

  const healthOpen  = violations.filter(v => v.isHealthBased && v.isOpen).length;
  const healthTotal = violations.filter(v => v.isHealthBased).length;

  if (healthOpen === 0 && healthTotal === 0) {
    return res.status(204).end(); // No violations — no letter needed
  }

  const location = [system.city, system.state].filter(Boolean).join(', ');

  const letter = [
    'Dear Representative,',
    '',
    `I am writing as a constituent concerned about the drinking water safety record of ${system.name}` +
    ` (EPA PWSID: ${pwsid})${location ? `, which serves my community in ${location}` : ''}.`,
    '',
    `According to the EPA's Safe Drinking Water Information System (SDWIS), this water system has recorded:`,
    `  • ${healthOpen} currently open health-based Safe Drinking Water Act violation${healthOpen !== 1 ? 's' : ''}`,
    `  • ${healthTotal} total health-based violation${healthTotal !== 1 ? 's' : ''} in the past 5 years`,
    '',
    'Health-based violations mean contaminants may have exceeded federal safety limits set to protect public health under the Safe Drinking Water Act.',
    '',
    'I respectfully ask that you:',
    '',
    `1. Request a briefing from the EPA and state primacy agency on the compliance status of ${system.name}`,
    '2. Inquire whether affected residents have received timely public notice as required by law',
    '3. Ensure federal infrastructure funding is reaching water systems with chronic compliance issues',
    '',
    'Water safety is a fundamental public health issue. Thank you for your attention.',
    '',
    'Sincerely,',
    '[Your name]',
    '[Your address]',
    '',
    '---',
    `Data source: EPA Envirofacts SDWIS · https://data.epa.gov/efservice/`,
    `Generated by WellWater · A nonpartisan public health tool`,
  ].join('\n');

  return res.type('text/plain').send(letter);
});

/**
 * GET /api/health
 * Simple liveness check + EPA connectivity test.
 */
app.get('/api/health', async (req, res) => {
  let epaReachable = false;
  try {
    const test = await epaFetch('/WATER_SYSTEM/PWSID/TX0010001/JSON');
    epaReachable = Array.isArray(test) && test.length > 0;
  } catch {}

  res.json({
    status:       epaReachable ? 'ok' : 'degraded',
    epaReachable,
    cacheSize:    cache.size,
    uptime:       Math.round(process.uptime()),
    timestamp:    new Date().toISOString(),
  });
});

// ── 404 catch-all ────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` });
  }
  // For non-API routes, serve the frontend (SPA fallback)
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) res.status(404).send('Not found');
  });
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WellWater backend running on http://localhost:${PORT}`);
  console.log(`  /api/water/:zip      — lookup by zip code`);
  console.log(`  /api/system/:pwsid   — lookup by PWSID`);
  console.log(`  /api/report/:pwsid   — constituent letter`);
  console.log(`  /api/health          — health check`);
});
