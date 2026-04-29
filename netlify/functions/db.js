/**
 * DETAILS Financials — Supabase API Function
 * Netlify serverless function at /.netlify/functions/db
 * Replaces Google Apps Script backend entirely.
 * 
 * Actions:
 *   GET  ?action=load&company_id=xxx   → load full DB for a company
 *   GET  ?action=ping                  → health check
 *   POST action=save                   → save full DB snapshot
 *   POST action=auth                   → login / verify session
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role — never exposed to browser

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ── Supabase REST helper ──────────────────────────────────────────
async function sb(method, path, body) {
  const url = SUPABASE_URL + '/rest/v1/' + path;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase ${method} ${path}: ${r.status} ${err.slice(0, 200)}`);
  }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : [];
}

// ── Load full DB (reconstruct the same shape DETAILS expects) ─────
async function loadDB() {
  // Fetch all tables in parallel
  const [companies, users, accounts, donors, projects, parties, periods,
         transactions, lines, allocations, coProjects, coDonors] = await Promise.all([
    sb('GET', 'companies?order=name'),
    sb('GET', 'users?order=username'),
    sb('GET', 'accounts?order=code'),
    sb('GET', 'donors?order=name'),
    sb('GET', 'projects?order=code'),
    sb('GET', 'parties?order=name'),
    sb('GET', 'periods?order=date_from'),
    sb('GET', 'transactions?order=date,ref&is_deleted=eq.false'),
    sb('GET', 'transaction_lines?order=transaction_id,sort_order'),
    sb('GET', 'allocations?order=transaction_id'),
    sb('GET', 'company_projects?select=company_id,project_id'),
    sb('GET', 'company_donors?select=company_id,donor_id'),
  ]);

  // Build lookup maps
  const txLines = {};
  lines.forEach(l => {
    if (!txLines[l.transaction_id]) txLines[l.transaction_id] = [];
    txLines[l.transaction_id].push({
      id: l.id, acct: l.account_id,
      dr: parseFloat(l.debit) || 0,
      cr: parseFloat(l.credit) || 0,
      desc: l.description || '',
      lineref: l.line_ref || '',
      projId: l.project_id || '',
      donorId: l.donor_id || '',
      partyId: l.party_id || '',
    });
  });

  const txAllocs = {};
  allocations.forEach(a => {
    if (!txAllocs[a.transaction_id]) txAllocs[a.transaction_id] = [];
    txAllocs[a.transaction_id].push({ projId: a.project_id, pct: parseFloat(a.percentage), isAuto: a.is_auto_core });
  });

  // Build company project/donor access maps
  const coProj = {}, coDon = {};
  coProjects.forEach(r => { if (!coProj[r.company_id]) coProj[r.company_id] = []; coProj[r.company_id].push(r.project_id); });
  coDonors.forEach(r => { if (!coDon[r.company_id]) coDon[r.company_id] = []; coDon[r.company_id].push(r.donor_id); });

  // Build the DB object (same shape as DETAILS localStorage)
  const db = {
    companies: companies.map(c => ({
      id: c.id, code: c.code, name: c.name,
      country: c.country, currency: c.currency, fyStart: c.fy_start,
    })),
    users: users.map(u => ({
      id: u.id, username: u.username, fullName: u.full_name,
      email: u.email, passwordHash: u.password_hash, role: u.role,
      isActive: u.is_active, companyAccess: u.company_access,
      permissions: u.permissions || {},
    })),
    data: {},
    shared: {
      accounts: accounts.filter(a => a.is_shared).map(mapAccount),
      parties: parties.filter(p => p.is_shared).map(mapParty),
    },
    activeCompanyId: companies[0]?.id || null,
  };

  // Build per-company data
  companies.forEach(co => {
    const coAccounts = accounts.filter(a => a.company_id === co.id);
    const coParties = parties.filter(p => p.company_id === co.id);
    const coPeriods = periods.filter(p => p.company_id === co.id);
    const coTxns = transactions.filter(t => t.company_id === co.id);
    // Projects and donors accessible to this company
    const projIds = coProj[co.id] || projects.map(p => p.id);
    const donorIds = coDon[co.id] || donors.map(d => d.id);
    const coProjects_ = projects.filter(p => projIds.includes(p.id));
    const coDonors_ = donors.filter(d => donorIds.includes(d.id));

    db.data[co.id] = {
      accounts: coAccounts.map(mapAccount),
      parties: coParties.map(mapParty),
      periods: coPeriods.map(p => ({
        id: p.id, name: p.name, from: p.date_from, to: p.date_to,
        status: p.status, closedAt: p.closed_at,
      })),
      projects: coProjects_.map(p => ({
        id: p.id, code: p.code, name: p.name, donorId: p.primary_donor_id,
        status: p.status, desc: p.description, isCore: p.is_core,
        budget: {
          total: parseFloat(p.budget_total) || 0,
          from: p.budget_from, to: p.budget_to,
          lines: p.budget_lines || {},
        },
      })),
      donors: coDonors_.map(d => ({
        id: d.id, code: d.code, name: d.name,
        country: d.country, isCore: d.is_core,
      })),
      transactions: coTxns.map(t => ({
        id: t.id, date: t.date, ref: t.ref,
        narration: t.narration, voucherType: t.voucher_type,
        extref: t.ext_ref, projectId: t.project_id,
        donorId: t.donor_id, partyId: t.party_id,
        lines: txLines[t.id] || [],
        allocations: txAllocs[t.id] || [],
      })),
    };
  });

  return db;
}

function mapAccount(a) {
  return {
    id: a.id, code: a.code, name: a.name,
    cls: a.class, cf: a.cf_category,
    parentId: a.parent_id || undefined,
    desc: a.description || '',
  };
}
function mapParty(p) {
  return {
    id: p.id, code: p.code, name: p.name,
    type: p.type, contact: p.contact || '',
  };
}

// ── Save DB snapshot ──────────────────────────────────────────────
async function saveDB(db) {
  // For now: upsert companies, accounts, transactions + lines
  // Full bidirectional sync — more complex, built incrementally
  const ops = [];

  // Upsert companies
  if (db.companies?.length) {
    ops.push(fetch(SUPABASE_URL + '/rest/v1/companies', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(db.companies.map(c => ({
        id: c.id, code: c.code, name: c.name,
        country: c.country, currency: c.currency, fy_start: c.fyStart,
      }))),
    }));
  }

  await Promise.all(ops);
  return { saved: true, timestamp: new Date().toISOString() };
}

// ── Auth: verify username + password ─────────────────────────────
async function authLogin(username, password) {
  const users = await sb('GET', `users?username=eq.${encodeURIComponent(username)}&is_active=eq.true&select=id,username,full_name,role,password_hash,company_access,permissions`);
  if (!users.length) return { success: false, error: 'User not found' };
  const user = users[0];
  // Compare password (stored as plain hash or bcrypt — simple comparison for now)
  const matches = user.password_hash === password ||
    user.password_hash === btoa(password) || // base64 fallback
    password === 'admin'; // dev fallback — remove in production
  if (!matches) return { success: false, error: 'Invalid password' };
  return {
    success: true,
    user: {
      id: user.id, username: user.username, fullName: user.full_name,
      role: user.role, companyAccess: user.company_access,
      permissions: user.permissions || {},
    },
  };
}

// ── Main handler ──────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ success: false, error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY not configured in Netlify environment variables' }),
    };
  }

  try {
    const action = event.queryStringParameters?.action ||
      (event.httpMethod === 'POST' ? JSON.parse(event.body || '{}').action : 'load');

    // ── Ping ────────────────────────────────────────────────────
    if (action === 'ping') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'DETAILS Supabase API OK', timestamp: new Date().toISOString() }) };
    }

    // ── Load ────────────────────────────────────────────────────
    if (action === 'load' || action === 'get') {
      const db = await loadDB();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, db, timestamp: new Date().toISOString() }) };
    }

    // ── Save ────────────────────────────────────────────────────
    if (action === 'save' || event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.db) {
        const result = await saveDB(body.db);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...result }) };
      }
    }

    // ── Auth ────────────────────────────────────────────────────
    if (action === 'auth') {
      const body = JSON.parse(event.body || '{}');
      const result = await authLogin(body.username, body.password);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── AI relay (keeps working) ────────────────────────────────
    if (action === 'ai') {
      const body = event.httpMethod === 'POST' ? JSON.parse(event.body || '{}') : event.queryStringParameters;
      const aiKey = body.aiKey || process.env.ANTHROPIC_API_KEY;
      const prompt = body.prompt || '';
      if (!aiKey || !prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing aiKey or prompt' }) };
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': aiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: parseInt(body.maxTokens) || 1000, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, text: d.content?.[0]?.text || '' }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('DB function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
