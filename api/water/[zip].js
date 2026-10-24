'use strict';

const fetch = require('node-fetch');

const EPA_BASE   = 'https://data.epa.gov/efservice';
const TIMEOUT_MS = 12000;
const MAX_RETRIES = 2;

async function epaFetch(path, attempt = 0) {
  const url = `${EPA_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'WellWater/1.0' }
    });
    clearTimeout(timer);
    if (!res.ok) { if (res.status === 404) return []; throw new Error(`EPA ${res.status}`); }
    const text = await res.text();
    if (!text || text.trim() === '' || text.trim() === '[]') return [];
    try { return JSON.parse(text); } catch { return []; }
  } catch (err) {
    clearTimeout(timer);
    if (attempt < MAX_RETRIES && err.name !== 'AbortError') {
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      return epaFetch(path, attempt + 1);
    }
    throw err;
  }
}

const CONTAMINANT_LABELS = {
  'TCR': 'Total Coliform Rule', 'LCR': 'Lead & Copper Rule',
  '1040': 'Nitrate', '1041': 'Nitrite', '1005': 'Arsenic',
  '1025': 'Lead', '1030': 'Copper', '2050': 'Atrazine',
  '3100': 'E. coli', '4010': 'Radium-226/228', '4000': 'Gross Alpha',
};

const TEST_RECOMMENDATIONS = {
  COLIFORM: { name: 'Total Coliform & E. coli', reason: 'Indicated by TCR violations. Fecal contamination risk.' },
  LEAD:     { name: 'Lead',     reason: 'Universal baseline — no safe level exists.' },
  NITRATE:  { name: 'Nitrate',  reason: 'Common near farms. Dangerous for infants.' },
  ARSENIC:  { name: 'Arsenic',  reason: 'Found in groundwater. Long-term cancer risk.' },
  PFAS:     { name: 'PFAS',     reason: 'Detected near industrial/military sites.' },
  RADIUM:   { name: 'Radium',   reason: 'Found in some groundwater; linked to bone cancer.' },
};

function normalizeSystem(r) {
  return {
    pwsid:      r.pwsid       || null,
    name:       r.pws_name    || 'Unknown Water System',
    city:       r.city_name   || null,
    state:      r.state_code  || null,
    type:       r.pws_type_code || null,
    sourceCode: r.primary_source_code || null,
    population: r.population_served_count ? parseInt(r.population_served_count, 10) : null,
    epaLink:    r.pwsid ? `https://echo.epa.gov/drinking-water/water-systems/details/${r.pwsid}` : null,
  };
}

const FIVE_YEARS_AGO = Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000;

function normalizeViolation(r) {
  const catCode  = (r.violation_category_code || '').toUpperCase();
  const typeCode = (r.violation_type_code     || '').toUpperCase();
  const contCode = (r.contaminant_code        || '').toUpperCase();
  const status   = (r.compliance_status_code  || '').toUpperCase();

  const isHealthBased = ['MCL','MRDL','TT'].some(c => catCode === c || typeCode.startsWith(c));
  const isOpen = status !== 'R' && !r.return_to_compliance_period_end_date;

  const startDate = r.compliance_period_begin_date || r.occurrence_submit_date || null;
  const endDate   = r.return_to_compliance_period_end_date || null;

  let category = 'other';
  if (isHealthBased) category = 'health';
  else if (catCode === 'MR' || typeCode.includes('MON') || typeCode.includes('MR')) category = 'monitoring';

  return {
    id: r.violation_id || null,
    category,
    contaminant: CONTAMINANT_LABELS[contCode] || r.contaminant_name || contCode || 'Unknown',
    contaminantCode: contCode,
    isHealthBased,
    isOpen,
    startDate: startDate ? new Date(startDate).toISOString().slice(0,10) : null,
    endDate:   endDate   ? new Date(endDate).toISOString().slice(0,10)   : null,
  };
}

function computeRisk(violations) {
  const ho = violations.filter(v => v.isHealthBased && v.isOpen).length;
  const ht = violations.filter(v => v.isHealthBased).length;
  const mo = violations.filter(v => v.category === 'monitoring' && v.isOpen).length;
  if (ho >= 3) return { level: 'critical', label: 'Critical',      score: 4 };
  if (ho >= 1) return { level: 'high',     label: 'High risk',     score: 3 };
  if (ht >= 3 || mo >= 3) return { level: 'moderate', label: 'Moderate risk', score: 2 };
  if (ht >= 1 || mo >= 1) return { level: 'moderate', label: 'Moderate risk', score: 2 };
  return                         { level: 'low',      label: 'Low risk',      score: 1 };
}

function buildTestRecs(violations, system) {
  const recs = new Set(['LEAD', 'NITRATE']);
  const src  = (system.sourceCode || '').toUpperCase();
  violations.forEach(v => {
    const c = v.contaminantCode;
    if (c === 'TCR' || c === '3100') recs.add('COLIFORM');
    if (c === 'LCR' || c === '1025') recs.add('LEAD');
    if (c === '1040' || c === '1041') recs.add('NITRATE');
    if (c === '1005') recs.add('ARSENIC');
    if (c === '4010' || c === '4000') recs.add('RADIUM');
  });
  if (src.startsWith('GW') || src === 'G' || src === 'GU') {
    recs.add('ARSENIC'); recs.add('RADIUM');
  }
  return [...recs].slice(0,6).map(k => TEST_RECOMMENDATIONS[k]).filter(Boolean);
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const zip = (req.query.zip || '').replace(/\D/g,'').slice(0,5);
  if (zip.length !== 5) {
    return res.status(400).json({ error: 'INVALID_ZIP', message: 'Please provide a valid 5-digit US zip code.' });
  }

  try {
    // Step 1 — find PWSID via geographic area boundary table
    let pwsid = null;
    const geo = await epaFetch(`/GEOGRAPHIC_AREA/ZIP_CODE_SERVED/${zip}/JSON`);
    if (Array.isArray(geo) && geo.length > 0) {
      const cws = geo.find(g => (g.pws_type_code||'').toUpperCase() === 'CWS') || geo[0];
      pwsid = cws.pwsid;
    }

    // Step 2 — fallback: direct zip on WATER_SYSTEM table
    if (!pwsid) {
      const direct = await epaFetch(`/WATER_SYSTEM/ZIP_CODE/${zip}/PWS_TYPE_CODE/CWS/JSON`);
      if (Array.isArray(direct) && direct.length > 0) pwsid = direct[0].pwsid;
    }

    if (!pwsid) {
      return res.status(404).json({
        error: 'NO_SYSTEM',
        message: `No community water system found for zip code ${zip}. This area may use private wells, or try a neighboring zip.`,
      });
    }

    // Step 3 — fetch full system record
    const sysRows = await epaFetch(`/WATER_SYSTEM/PWSID/${pwsid}/JSON`);
    if (!Array.isArray(sysRows) || sysRows.length === 0) {
      return res.status(404).json({ error: 'NO_SYSTEM', message: `Water system ${pwsid} not found.` });
    }
    const system = normalizeSystem(sysRows[0]);

    // Step 4 — fetch violations, filter to last 5 years, normalize, sort
    const rawViols = await epaFetch(`/VIOLATION/PWSID/${pwsid}/JSON`);
    const violations = (Array.isArray(rawViols) ? rawViols : [])
      .map(normalizeViolation)
      .filter(v => v.startDate && new Date(v.startDate).getTime() >= FIVE_YEARS_AGO)
      .sort((a, b) => {
        if (a.isHealthBased && a.isOpen && !(b.isHealthBased && b.isOpen)) return -1;
        if (b.isHealthBased && b.isOpen && !(a.isHealthBased && a.isOpen)) return  1;
        return (b.startDate||'').localeCompare(a.startDate||'');
      });

    const risk  = computeRisk(violations);
    const tests = buildTestRecs(violations, system);
    const stats = {
      total:            violations.length,
      healthBasedTotal: violations.filter(v => v.isHealthBased).length,
      healthBasedOpen:  violations.filter(v => v.isHealthBased && v.isOpen).length,
      monitoringOpen:   violations.filter(v => v.category === 'monitoring' && v.isOpen).length,
      resolvedCount:    violations.filter(v => !v.isOpen).length,
    };

    return res.status(200).json({
      zip, system, violations, risk, stats, tests,
      fetchedAt:  new Date().toISOString(),
      dataSource: 'EPA SDWIS via Envirofacts',
    });

  } catch (err) {
    console.error(`[water/${zip}]`, err.message);
    return res.status(502).json({ error: 'UPSTREAM_ERROR', message: 'Could not reach the EPA database. Please try again.' });
  }
};
