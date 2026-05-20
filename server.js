const express = require('express');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
app.use(express.json());
app.use(cookieParser());

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET       = process.env.JWT_SECRET || 'dev-only-change-me';
const BOOTSTRAP_ADMIN  = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase();
const SESSION_COOKIE   = 'sa_session';
const SESSION_MAX_AGE  = 30 * 24 * 60 * 60 * 1000; // 30 days
const googleClient     = new OAuth2Client(GOOGLE_CLIENT_ID);

// Expose the public Google client id to the frontend so it can configure GIS.
// Safe to expose — it's a public identifier, not a secret.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.__SA_CONFIG__ = ${JSON.stringify({ googleClientId: GOOGLE_CLIENT_ID || '' })};`);
});

app.use(express.static(path.join(__dirname, 'public')));

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is not set');
  return neon(url);
}

async function initDb() {
  try {
    const sql = getDb();
    await sql`
      CREATE TABLE IF NOT EXISTS jobs (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        client      TEXT NOT NULL,
        jobcode     TEXT,
        ref         TEXT,
        dateissued  TEXT,
        deadline    TEXT,
        size        TEXT,
        ups         TEXT,
        sheets      TEXT,
        qty         TEXT,
        paper       TEXT,
        machine     TEXT,
        coatings    TEXT[],
        priority    TEXT DEFAULT 'Medium',
        delqty      TEXT,
        cartonqty   TEXT,
        notes       TEXT,
        stage_index INTEGER DEFAULT 0,
        stages      JSONB DEFAULT '{}',
        log         JSONB DEFAULT '[]',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // Idempotent migrations for new fields added after the table existed
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bno         TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mfgdate     TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS expdate     TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mrp         TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS particulars JSONB DEFAULT '{}'`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS inventory_item_id INTEGER`;
    // Stock issuance workflow: jobs start 'pending' until a stock-role user
    // (or admin) issues stock, which deducts inventory and flips to 'issued'.
    // Existing rows backfill to 'issued' since their stock was already
    // consumed in the previous auto-deduct flow.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS issuance_status TEXT NOT NULL DEFAULT 'issued'`;
    await sql`ALTER TABLE jobs ALTER COLUMN issuance_status SET DEFAULT 'pending'`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS issued_at  TIMESTAMPTZ`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS issued_by_id INTEGER`;

    // Inventory: paper (and future ink/etc) catalog + append-only ledger
    await sql`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id                 SERIAL PRIMARY KEY,
        paper_type         TEXT NOT NULL,
        size               TEXT,
        gsm                TEXT,
        brand              TEXT,
        unit               TEXT DEFAULT 'sheets',
        current_balance    INTEGER DEFAULT 0,
        reorder_threshold  INTEGER DEFAULT 0,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // (paper_type, size, gsm, brand) uniquely identifies an inventory line.
    // COALESCE keeps NULLs from defeating uniqueness — Postgres treats NULL as not-equal otherwise.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_unique_idx
        ON inventory_items (paper_type, COALESCE(size,''), COALESCE(gsm,''), COALESCE(brand,''))
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS inventory_transactions (
        id         SERIAL PRIMARY KEY,
        item_id    INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
        change     INTEGER NOT NULL,
        reason     TEXT NOT NULL,
        job_id     INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        notes      TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS inventory_tx_item_idx ON inventory_transactions(item_id)`;
    await sql`CREATE INDEX IF NOT EXISTS inventory_tx_job_idx  ON inventory_transactions(job_id)`;

    // Inventory imports: booked-but-not-yet-arrived shipments. Status flows
    // pending → received (creates a stock-in transaction) or pending → cancelled.
    // inventory_item_id is nullable so users can book imports for items that
    // don't yet exist in the catalog — the item gets auto-created on receive.
    await sql`
      CREATE TABLE IF NOT EXISTS inventory_imports (
        id                SERIAL PRIMARY KEY,
        paper_type        TEXT NOT NULL,
        size              TEXT,
        gsm               TEXT,
        brand             TEXT,
        packets           NUMERIC NOT NULL DEFAULT 0,
        weight_kg         NUMERIC,
        supplier          TEXT,
        booked_date       DATE,
        expected_arrival  DATE,
        received_at       TIMESTAMPTZ,
        status            TEXT NOT NULL DEFAULT 'pending',
        inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
        notes             TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS inventory_imports_status_idx ON inventory_imports(status)`;
    await sql`CREATE INDEX IF NOT EXISTS inventory_imports_type_idx   ON inventory_imports(paper_type)`;

    // Auth: allow-list of users keyed by email. role is enforced via CHECK so
    // the DB rejects typos. invited_by is just a breadcrumb for the Users tab.
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT,
        picture       TEXT,
        role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user','stock')),
        invited_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      )
    `;
    // Migrate the role CHECK constraint on existing DBs that were created
    // before 'stock' was a valid role. Drop the old constraint and add the
    // new one; idempotent because the second add fails silently if the
    // constraint already permits 'stock'.
    await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`;
    await sql`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','user','stock'))`;

    // Audit log: action-level history of every mutation. user_email is
    // denormalized so log rows survive even if their user row is deleted.
    await sql`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        user_email  TEXT,
        action      TEXT NOT NULL,
        entity_type TEXT,
        entity_id   INTEGER,
        summary     TEXT NOT NULL,
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id)`;
    await sql`CREATE INDEX IF NOT EXISTS audit_log_user_idx   ON audit_log(user_id)`;

    console.log('Database ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// Run schema migrations once at module load. Every handler awaits this so
// requests can't race ahead of ALTER TABLE on a cold start.
const dbReady = initDb();

// ── Auth helpers ─────────────────────────────────────────────

// Parses our session cookie and attaches req.user if valid. Never errors —
// downstream handlers use requireAuth/requireAdmin to enforce.
//
// LOCAL DEV ONLY: when DEV_BYPASS_AUTH=1 is set in the environment, every
// request is treated as an admin user. This lets developers run the app
// against a real DB without setting up Google OAuth locally. The env var
// is never set on Vercel, so production remains fully protected.
function authMiddleware(req, res, next) {
  if (process.env.DEV_BYPASS_AUTH === '1') {
    req.user = { id: 0, email: 'dev@local', role: 'admin', name: 'Local Dev', picture: '' };
    return next();
  }
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = { id: payload.id, email: payload.email, role: payload.role, name: payload.name, picture: payload.picture };
    } catch (e) {
      // Invalid/expired token — leave req.user undefined.
    }
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
// Stock issuance — admins and the dedicated 'stock' role can both issue.
// Plain users (job people) get a 403.
function requireStockOrAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role !== 'admin' && req.user.role !== 'stock') {
    return res.status(403).json({ error: 'Stock or admin role required' });
  }
  next();
}

app.use(authMiddleware);

// Write an action-level audit row. Called from every mutating handler after
// the primary write succeeds, so the log only ever shows real changes.
async function logAudit(sql, req, { action, entityType, entityId, summary, metadata }) {
  if (!req.user) return;
  try {
    await sql`
      INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id, summary, metadata)
      VALUES (${req.user.id}, ${req.user.email}, ${action}, ${entityType || null}, ${entityId || null}, ${summary}, ${JSON.stringify(metadata || {})})
    `;
  } catch (e) {
    // Audit failures should never break the user-facing request.
    console.error('Audit log write failed:', e.message);
  }
}

// ── Auth routes ──────────────────────────────────────────────

// Exchange a Google ID token for a session cookie. The frontend collects
// the ID token via Google Identity Services and POSTs it here.
app.post('/api/auth/google', async (req, res) => {
  try {
    await dbReady;
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID env var is not set on the server.' });
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = (payload.email || '').toLowerCase();
    const name = payload.name || null;
    const picture = payload.picture || null;
    if (!email || !payload.email_verified) {
      return res.status(401).json({ error: 'Google did not verify this email address.' });
    }

    const sql = getDb();
    // Look up by email — case-insensitive.
    let userRows = await sql`SELECT * FROM users WHERE lower(email) = ${email}`;
    let user = userRows[0];

    // Bootstrap: if no record exists and this email matches the env-configured
    // BOOTSTRAP_ADMIN_EMAIL, auto-create as admin. This is the only way to get
    // the first admin into a fresh database.
    if (!user && BOOTSTRAP_ADMIN && email === BOOTSTRAP_ADMIN) {
      const inserted = await sql`
        INSERT INTO users (email, name, picture, role)
        VALUES (${email}, ${name}, ${picture}, 'admin')
        RETURNING *
      `;
      user = inserted[0];
      // Audit the bootstrap as the new admin acting on themselves.
      await logAudit(sql, { user: { id: user.id, email: user.email } },
        { action: 'user.bootstrap', entityType: 'user', entityId: user.id, summary: `Bootstrap admin ${email} auto-created` });
    }

    if (!user) {
      return res.status(403).json({ error: 'Not authorized — contact your administrator to be invited.' });
    }

    // Refresh profile + login timestamp on every sign-in.
    const updated = await sql`
      UPDATE users SET name = ${name}, picture = ${picture}, last_login_at = NOW()
      WHERE id = ${user.id} RETURNING *
    `;
    user = updated[0];

    const sessionToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name, picture: user.picture },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.cookie(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      path: '/',
    });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(401).json({ error: 'Could not verify Google sign-in: ' + err.message });
  }
});

// Logout — clears the cookie. Safe to call when already signed out.
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Who am I — used by the frontend on load to decide whether to show the login screen.
app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.user });
});

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, picture: u.picture, role: u.role, created_at: u.created_at, last_login_at: u.last_login_at, invited_by: u.invited_by };
}

// ── User management (admin only) ─────────────────────────────

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`
      SELECT u.*, inv.email AS invited_by_email
      FROM users u
      LEFT JOIN users inv ON inv.id = u.invited_by
      ORDER BY u.created_at ASC
    `;
    res.json(rows.map(r => ({ ...publicUser(r), invited_by_email: r.invited_by_email })));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const email = (req.body.email || '').trim().toLowerCase();
    // Allow 'admin', 'stock', or 'user' (default). Anything else falls back to user.
    const role = ['admin','stock','user'].includes(req.body.role) ? req.body.role : 'user';
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const inserted = await sql`
      INSERT INTO users (email, role, invited_by) VALUES (${email}, ${role}, ${req.user.id})
      ON CONFLICT (email) DO NOTHING
      RETURNING *
    `;
    if (!inserted.length) return res.status(409).json({ error: 'A user with this email already exists' });
    await logAudit(sql, req, { action: 'user.invite', entityType: 'user', entityId: inserted[0].id, summary: `Invited ${email} as ${role}` });
    res.json(publicUser(inserted[0]));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const role = ['admin','stock','user'].includes(req.body.role) ? req.body.role : 'user';
    // Guardrail: don't allow demoting yourself — locks you out of admin tools.
    if (parseInt(id, 10) === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: "You can't change your own role away from admin." });
    }
    const updated = await sql`UPDATE users SET role = ${role} WHERE id = ${id} RETURNING *`;
    if (!updated.length) return res.status(404).json({ error: 'User not found' });
    await logAudit(sql, req, { action: 'user.role-change', entityType: 'user', entityId: updated[0].id, summary: `Set ${updated[0].email} to ${role}` });
    res.json(publicUser(updated[0]));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself." });
    const deleted = await sql`DELETE FROM users WHERE id = ${id} RETURNING *`;
    if (!deleted.length) return res.status(404).json({ error: 'User not found' });
    await logAudit(sql, req, { action: 'user.delete', entityType: 'user', entityId: id, summary: `Removed ${deleted[0].email}` });
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// ── Audit log query ──────────────────────────────────────────

app.get('/api/audit', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { entity_type, entity_id, user_id, limit } = req.query;
    const cap = Math.min(parseInt(limit, 10) || 100, 500);
    let rows;
    if (entity_type && entity_id) {
      rows = await sql`SELECT * FROM audit_log WHERE entity_type = ${entity_type} AND entity_id = ${entity_id} ORDER BY id DESC LIMIT ${cap}`;
    } else if (user_id) {
      rows = await sql`SELECT * FROM audit_log WHERE user_id = ${user_id} ORDER BY id DESC LIMIT ${cap}`;
    } else {
      rows = await sql`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${cap}`;
    }
    res.json(rows);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// GET all jobs
app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const jobs = await sql`SELECT * FROM jobs ORDER BY id ASC`;
    res.json(jobs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Helper: parse the sheets-qty form field into an integer. Returns 0 on garbage.
function parseSheets(v) {
  const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// Inventory deduction for jobs is ALWAYS computed from Quantity of Packets
// times the paper's raw packetSize. Reason: Sheets Qty is the working/post-cut
// sheet count (e.g. 1000 working 20x15 sheets from 500 raw 20x30 sheets at
// 1/2 cut). Inventory tracks RAW sheets, so we must deduct in raw units —
// and Quantity of Packets is the only field that maps cleanly to raw stock.
// Returns 0 if packets is missing/zero; caller must surface a clear error.
const REAM_PAPERS = new Set(['Art Paper', 'Off-White', 'Offset Paper']);
function packetSize(paperType) { return REAM_PAPERS.has(paperType) ? 500 : 100; }
function jobDeductionSheets({ paperType, particulars }) {
  const ps      = packetSize(paperType || '');
  const packets = parseFloat((particulars || {}).quantity_of_packets);
  if (!Number.isFinite(packets) || packets <= 0) return 0;
  return Math.round(packets * ps);
}

// Helper: apply a stock change (+/-) and write a ledger row. Must be called
// after dbReady. Assumes the item exists. Updates current_balance atomically
// in the same UPDATE so balance always matches the sum of ledger changes.
async function applyInventoryChange(sql, { itemId, change, reason, jobId, notes }) {
  if (!itemId || !change) return;
  await sql`
    INSERT INTO inventory_transactions (item_id, change, reason, job_id, notes)
    VALUES (${itemId}, ${change}, ${reason}, ${jobId || null}, ${notes || null})
  `;
  await sql`
    UPDATE inventory_items SET current_balance = current_balance + ${change} WHERE id = ${itemId}
  `;
}

// CREATE a job
app.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id } = req.body;
    // New jobs are created with issuance_status='pending'. Stock is NOT
    // deducted at creation time — a stock-role user (or admin) must call
    // POST /api/jobs/:id/issue-stock to deduct inventory and flip status.
    const result = await sql`
      INSERT INTO jobs (name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id, issuance_status)
      VALUES (${name}, ${client}, ${jobcode||null}, ${ref||null}, ${dateissued||null}, ${deadline||null}, ${size||null}, ${ups||null}, ${sheets||null}, ${qty||null}, ${paper||null}, ${machine||null}, ${coatings||[]}, ${priority||'Medium'}, ${delqty||null}, ${cartonqty||null}, ${notes||null}, ${bno||null}, ${mfgdate||null}, ${expdate||null}, ${mrp||null}, ${JSON.stringify(particulars||{})}, ${inventory_item_id||null}, 'pending')
      RETURNING *
    `;
    const job = result[0];
    await logAudit(sql, req, { action: 'job.create', entityType: 'job', entityId: job.id, summary: `Created Job E-${job.id}: ${job.name} (${job.client}) — pending stock issuance` });
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE job details
app.put('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id } = req.body;

    // Read prior values for inventory adjustment AND issuance status — if the
    // job is still 'pending' (stock never issued), edits don't touch inventory
    // at all. Once 'issued', edits auto-adjust the ledger using the same
    // packet-first formula as initial issuance.
    const prior = await sql`SELECT inventory_item_id, sheets, particulars, issuance_status FROM jobs WHERE id = ${id}`;
    const wasIssued  = prior[0]?.issuance_status === 'issued';
    const oldItemId  = prior[0]?.inventory_item_id || null;
    const newItemId  = inventory_item_id || null;
    // Look up paper types so the packet-multiplier matches what was actually
    // deducted at issuance time (and what the new state would deduct).
    let oldPaperType = '';
    let newPaperType = '';
    if (oldItemId) {
      const r = await sql`SELECT paper_type FROM inventory_items WHERE id = ${oldItemId}`;
      oldPaperType = r[0]?.paper_type || '';
    }
    if (newItemId) {
      const r = await sql`SELECT paper_type FROM inventory_items WHERE id = ${newItemId}`;
      newPaperType = r[0]?.paper_type || '';
    }
    const oldSheets = jobDeductionSheets({ paperType: oldPaperType, particulars: prior[0]?.particulars });
    const newSheets = jobDeductionSheets({ paperType: newPaperType, particulars });

    const result = await sql`
      UPDATE jobs SET
        name=${name}, client=${client}, jobcode=${jobcode||null}, ref=${ref||null},
        dateissued=${dateissued||null}, deadline=${deadline||null}, size=${size||null},
        ups=${ups||null}, sheets=${sheets||null}, qty=${qty||null}, paper=${paper||null},
        machine=${machine||null}, coatings=${coatings||[]}, priority=${priority||'Medium'},
        delqty=${delqty||null}, cartonqty=${cartonqty||null}, notes=${notes||null},
        bno=${bno||null}, mfgdate=${mfgdate||null}, expdate=${expdate||null}, mrp=${mrp||null},
        particulars=${JSON.stringify(particulars||{})}, inventory_item_id=${newItemId}
      WHERE id=${id} RETURNING *
    `;
    const job = result[0];

    // Only adjust inventory if the job was already issued — pending jobs
    // haven't taken any stock yet, so there's nothing to revert.
    if (wasIssued) {
      if (oldItemId && oldSheets > 0) {
        await applyInventoryChange(sql, {
          itemId: oldItemId,
          change: +oldSheets,
          reason: 'job-edit-revert',
          jobId: job.id,
          notes: `Edit on Job E-${job.id}: returned previous ${oldSheets} sheets`,
        });
      }
      if (newItemId && newSheets > 0) {
        await applyInventoryChange(sql, {
          itemId: newItemId,
          change: -newSheets,
          reason: 'job-edit-apply',
          jobId: job.id,
          notes: `Edit on Job E-${job.id}: consumed ${newSheets} sheets`,
        });
      }
    }
    await logAudit(sql, req, { action: 'job.update', entityType: 'job', entityId: job.id, summary: `Edited Job E-${job.id}: ${job.name}` });
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Issue stock for a pending job. Deducts inventory and flips status to
// 'issued'. Admin or stock role only — the job person can't self-approve.
app.post('/api/jobs/:id/issue-stock', requireStockOrAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status === 'issued') {
      return res.status(400).json({ error: 'Stock already issued for this job' });
    }
    if (!job.inventory_item_id) {
      return res.status(400).json({ error: 'Job has no paper assigned — nothing to issue' });
    }
    const inv = await sql`SELECT paper_type FROM inventory_items WHERE id = ${job.inventory_item_id}`;
    const paperType = inv[0]?.paper_type || '';
    const sheetsUsed = jobDeductionSheets({ paperType, particulars: job.particulars });
    if (sheetsUsed <= 0) {
      return res.status(400).json({ error: 'Job has no Quantity of Packets — set the packets count on the job, then try again. (Inventory is deducted in raw packets/reams.)' });
    }
    const ps   = packetSize(paperType);
    const unit = REAM_PAPERS.has(paperType) ? 'reams' : 'packets';
    const packs = sheetsUsed / ps;
    // Deduct inventory using the same helper edits use, so the ledger entry
    // looks identical to the original auto-deduct flow.
    await applyInventoryChange(sql, {
      itemId: job.inventory_item_id,
      change: -sheetsUsed,
      reason: 'job-consumed',
      jobId: job.id,
      notes: `Job E-${job.id}${job.jobcode ? ' · ' + job.jobcode : ''}: ${job.name} — ${packs} ${unit} (${sheetsUsed} sheets) issued by ${req.user.email}`,
    });
    const updated = await sql`
      UPDATE jobs
         SET issuance_status = 'issued',
             issued_at = NOW(),
             issued_by_id = ${req.user.id || null}
       WHERE id = ${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.issue_stock',
      entityType: 'job',
      entityId: id,
      summary: `Issued ${sheetsUsed} sheets for Job E-${id}: ${job.name}`,
    });
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a job — admin only. Inventory ledger entries keep their data
// (the FK is ON DELETE SET NULL) so historical balances stay traceable.
app.delete('/api/jobs/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const deleted = await sql`DELETE FROM jobs WHERE id = ${id} RETURNING *`;
    if (!deleted.length) return res.status(404).json({ error: 'Job not found' });
    await logAudit(sql, req, { action: 'job.delete', entityType: 'job', entityId: id, summary: `Deleted Job E-${id}: ${deleted[0].name}` });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Inventory endpoints ─────────────────────────────────────────

// LIST all inventory items
app.get('/api/inventory', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const items = await sql`SELECT * FROM inventory_items ORDER BY paper_type, size, gsm, brand`;
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// CREATE an inventory item. Initial balance, if provided, is recorded as an
// "opening-balance" ledger row so the audit trail is complete from day one.
app.post('/api/inventory', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { paper_type, size, gsm, brand, reorder_threshold, opening_balance, opening_notes } = req.body;
    if (!paper_type) return res.status(400).json({ error: 'paper_type is required' });
    const inserted = await sql`
      INSERT INTO inventory_items (paper_type, size, gsm, brand, reorder_threshold)
      VALUES (${paper_type}, ${size||null}, ${gsm||null}, ${brand||null}, ${reorder_threshold||0})
      RETURNING *
    `;
    const item = inserted[0];
    const opening = parseSheets(opening_balance);
    const label = `${paper_type}${size?' '+size:''}${gsm?' '+gsm+'gsm':''}${brand?' · '+brand:''}`;
    if (opening > 0) {
      await applyInventoryChange(sql, {
        itemId: item.id,
        change: +opening,
        reason: 'opening-balance',
        jobId: null,
        notes: opening_notes || 'Opening balance',
      });
      const refreshed = await sql`SELECT * FROM inventory_items WHERE id = ${item.id}`;
      await logAudit(sql, req, { action: 'inventory.create', entityType: 'inventory', entityId: item.id, summary: `Added paper item: ${label} (opening ${opening.toLocaleString()} sheets)` });
      return res.json(refreshed[0]);
    }
    await logAudit(sql, req, { action: 'inventory.create', entityType: 'inventory', entityId: item.id, summary: `Added paper item: ${label}` });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE inventory item fields (not balance — balance is ledger-driven)
app.put('/api/inventory/:id', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { paper_type, size, gsm, brand, reorder_threshold, current_balance, correction_notes } = req.body;

    // Snapshot the pre-edit balance — needed so an admin-only balance
    // correction below can compute the delta.
    const before = await sql`SELECT current_balance FROM inventory_items WHERE id=${id}`;
    if (!before[0]) return res.status(404).json({ error: 'Item not found' });
    const oldBalance = before[0].current_balance || 0;

    const result = await sql`
      UPDATE inventory_items SET
        paper_type=${paper_type}, size=${size||null}, gsm=${gsm||null},
        brand=${brand||null}, reorder_threshold=${reorder_threshold||0}
      WHERE id=${id} RETURNING *
    `;
    const item = result[0];

    // Admin-only direct balance correction. We write a transaction with
    // reason='correction' so the per-item History modal still shows the
    // change (full audit trail), but the aggregate movement report
    // (Stock In / Stock Out / Dashboard) filters this reason out so it
    // doesn't pollute the in/out totals.
    if (req.user && req.user.role === 'admin' && current_balance !== undefined && current_balance !== null && current_balance !== '') {
      const newBalance = parseInt(current_balance, 10);
      if (Number.isFinite(newBalance) && newBalance !== oldBalance) {
        const delta = newBalance - oldBalance;
        await applyInventoryChange(sql, {
          itemId: parseInt(id, 10),
          change: delta,
          reason: 'correction',
          jobId: null,
          notes: correction_notes || 'Balance edit from inventory form',
        });
        if (item) {
          const label = `${item.paper_type}${item.size?' '+item.size:''}${item.gsm?' '+item.gsm+'gsm':''}${item.brand?' · '+item.brand:''}`;
          const sign = delta > 0 ? '+' : '';
          await logAudit(sql, req, { action: 'inventory.correction', entityType: 'inventory', entityId: item.id, summary: `Balance corrected: ${oldBalance.toLocaleString()} -> ${newBalance.toLocaleString()} sheets (${sign}${delta.toLocaleString()}) · ${label}` });
        }
      }
    }

    if (item) {
      const label = `${item.paper_type}${item.size?' '+item.size:''}${item.gsm?' '+item.gsm+'gsm':''}${item.brand?' · '+item.brand:''}`;
      await logAudit(sql, req, { action: 'inventory.update', entityType: 'inventory', entityId: item.id, summary: `Edited paper item: ${label}` });
    }
    // Re-fetch so the returned row reflects any balance correction above.
    const refreshed = await sql`SELECT * FROM inventory_items WHERE id=${id}`;
    res.json(refreshed[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ADD/ADJUST stock — used for deliveries and manual corrections.
app.post('/api/inventory/:id/transactions', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { change, reason, notes } = req.body;
    const delta = parseSheets(change);
    if (!delta) return res.status(400).json({ error: 'change must be a non-zero integer' });
    const itemId = parseInt(id, 10);
    await applyInventoryChange(sql, {
      itemId,
      change: delta,
      reason: reason || (delta > 0 ? 'delivery' : 'adjustment'),
      jobId: null,
      notes: notes || null,
    });
    const refreshed = await sql`SELECT * FROM inventory_items WHERE id = ${id}`;
    const it = refreshed[0];
    if (it) {
      const label = `${it.paper_type}${it.size?' '+it.size:''}${it.gsm?' '+it.gsm+'gsm':''}${it.brand?' · '+it.brand:''}`;
      const sign = delta > 0 ? '+' : '';
      await logAudit(sql, req, { action: 'inventory.stock', entityType: 'inventory', entityId: it.id, summary: `${sign}${delta.toLocaleString()} sheets · ${label} (${reason || (delta>0?'delivery':'adjustment')})` });
    }
    res.json(it);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// REPORT: all inventory transactions across all items, with item details joined.
// Query params (all optional):
//   from       — ISO date (inclusive lower bound, e.g. "2026-05-01")
//   to         — ISO date (inclusive upper bound, e.g. "2026-05-31")
//   direction  — "in" (change > 0), "out" (change < 0), or omitted for both
// Newest first. Used by the Inventory Stock Report screen.
app.get('/api/inventory/transactions', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const from = req.query.from || null;
    const to   = req.query.to   || null;
    const dir = req.query.direction === 'in' ? 'in'
              : req.query.direction === 'out' ? 'out'
              : 'all';
    // Inclusive end-of-day on `to` so a date like 2026-05-31 matches transactions
    // recorded at 2026-05-31 18:00:00. Without this, same-day queries miss data.
    // reason='correction' is an admin-only balance edit (data fix). It
    // shows in the per-item History modal but is intentionally excluded
    // from movement reports so Stock In / Stock Out / Dashboard totals
    // reflect actual material flow only.
    const txs = await sql`
      SELECT t.*, j.name AS job_name, j.jobcode AS job_code,
             i.paper_type, i.size AS item_size, i.gsm AS item_gsm,
             i.brand AS item_brand, i.unit AS item_unit
      FROM inventory_transactions t
      LEFT JOIN jobs j ON j.id = t.job_id
      LEFT JOIN inventory_items i ON i.id = t.item_id
      WHERE (${from}::timestamptz IS NULL OR t.created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz   IS NULL OR t.created_at <  (${to}::timestamptz + INTERVAL '1 day'))
        AND t.reason != 'correction'
        AND (${dir} = 'all'
             OR (${dir} = 'in'  AND t.change > 0)
             OR (${dir} = 'out' AND t.change < 0))
      ORDER BY t.id DESC
    `;
    res.json(txs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// LEDGER for one item — full transaction history, newest first.
app.get('/api/inventory/:id/transactions', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const txs = await sql`
      SELECT t.*, j.name AS job_name, j.jobcode AS job_code
      FROM inventory_transactions t
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.item_id = ${id}
      ORDER BY t.id DESC
    `;
    res.json(txs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Inventory Imports endpoints ─────────────────────────────────
// "Pending imports" — orders placed with suppliers that haven't arrived yet.
// Listed in their own modal, drive the "Required After Import" column in the
// Stock Summary. Mark Received turns the import into a stock-in transaction.

// LIST imports. Optional status query param ("pending" by default — that's
// the only thing the UI cares about most of the time).
app.get('/api/imports', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const status = req.query.status || null; // null means all statuses
    const rows = await sql`
      SELECT * FROM inventory_imports
      WHERE (${status}::text IS NULL OR status = ${status})
      ORDER BY (status = 'pending') DESC, expected_arrival NULLS LAST, id DESC
    `;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CREATE an import. Auto-links to a matching inventory_item if one exists
// (same paper_type + size + gsm + brand). No match → leave the link NULL;
// receiving the import later will create the item.
app.post('/api/imports', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { paper_type, size, gsm, brand, packets, weight_kg, supplier, booked_date, expected_arrival, notes } = req.body;
    if (!paper_type) return res.status(400).json({ error: 'paper_type is required' });
    const matchRows = await sql`
      SELECT id FROM inventory_items
      WHERE paper_type = ${paper_type}
        AND COALESCE(size,'')  = COALESCE(${size||null}, '')
        AND COALESCE(gsm,'')   = COALESCE(${gsm||null},  '')
        AND COALESCE(brand,'') = COALESCE(${brand||null},'')
      LIMIT 1
    `;
    const itemId = matchRows[0]?.id || null;
    const inserted = await sql`
      INSERT INTO inventory_imports
        (paper_type, size, gsm, brand, packets, weight_kg, supplier, booked_date, expected_arrival, notes, inventory_item_id)
      VALUES
        (${paper_type}, ${size||null}, ${gsm||null}, ${brand||null}, ${packets||0}, ${weight_kg||null},
         ${supplier||null}, ${booked_date||null}, ${expected_arrival||null}, ${notes||null}, ${itemId})
      RETURNING *
    `;
    res.json(inserted[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// UPDATE import fields. Status changes go through /receive or /cancel below.
app.put('/api/imports/:id', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { paper_type, size, gsm, brand, packets, weight_kg, supplier, booked_date, expected_arrival, notes } = req.body;
    const rows = await sql`
      UPDATE inventory_imports SET
        paper_type=${paper_type}, size=${size||null}, gsm=${gsm||null}, brand=${brand||null},
        packets=${packets||0}, weight_kg=${weight_kg||null}, supplier=${supplier||null},
        booked_date=${booked_date||null}, expected_arrival=${expected_arrival||null}, notes=${notes||null}
      WHERE id=${id} RETURNING *
    `;
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CANCEL an import (status → cancelled, no inventory change).
app.post('/api/imports/:id/cancel', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const rows = await sql`
      UPDATE inventory_imports SET status='cancelled' WHERE id=${id} AND status='pending' RETURNING *
    `;
    if (!rows.length) return res.status(400).json({ error: 'Only pending imports can be cancelled' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// RECEIVE an import — converts it to a real stock-in transaction. If the
// import has no linked inventory_item, we create one on the fly using the
// import's paper_type/size/gsm/brand. The body may override `packets` (e.g.,
// when the actual delivery differs from the booked quantity).
app.post('/api/imports/:id/receive', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const overridePackets = parseFloat(req.body?.packets);
    const imp = (await sql`SELECT * FROM inventory_imports WHERE id=${id}`)[0];
    if (!imp) return res.status(404).json({ error: 'Import not found' });
    if (imp.status !== 'pending') return res.status(400).json({ error: 'Only pending imports can be received' });

    // Find or create the inventory item. The unique index on
    // (paper_type, COALESCE(size,''), COALESCE(gsm,''), COALESCE(brand,''))
    // means we can't race-create duplicates — but we still SELECT first since
    // we need the id either way.
    let itemId = imp.inventory_item_id;
    if (!itemId) {
      const existing = await sql`
        SELECT id FROM inventory_items
        WHERE paper_type = ${imp.paper_type}
          AND COALESCE(size,'')  = COALESCE(${imp.size},  '')
          AND COALESCE(gsm,'')   = COALESCE(${imp.gsm},   '')
          AND COALESCE(brand,'') = COALESCE(${imp.brand}, '')
        LIMIT 1
      `;
      if (existing[0]) itemId = existing[0].id;
      else {
        const created = await sql`
          INSERT INTO inventory_items (paper_type, size, gsm, brand)
          VALUES (${imp.paper_type}, ${imp.size||null}, ${imp.gsm||null}, ${imp.brand||null})
          RETURNING id
        `;
        itemId = created[0].id;
      }
    }

    // Packets → sheets using the paper-type convention (Cards=100, Papers=500).
    // Mirrors packetSize() in the frontend.
    const reamSet = new Set(['Art Paper', 'Off-White', 'Offset Paper']);
    const perPack = reamSet.has(imp.paper_type) ? 500 : 100;
    const pkts = Number.isFinite(overridePackets) && overridePackets > 0 ? overridePackets : parseFloat(imp.packets);
    const sheets = Math.round(pkts * perPack);
    if (!sheets || sheets <= 0) return res.status(400).json({ error: 'packets must be > 0' });

    await applyInventoryChange(sql, {
      itemId,
      change: +sheets,
      reason: 'import-received',
      jobId: null,
      notes: `Import #${imp.id}${imp.supplier ? ' · ' + imp.supplier : ''}${imp.notes ? ' · ' + imp.notes : ''}`,
    });
    const updated = await sql`
      UPDATE inventory_imports SET
        status='received', received_at=NOW(), inventory_item_id=${itemId}, packets=${pkts}
      WHERE id=${id} RETURNING *
    `;
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// UPDATE stage/status only
app.patch('/api/jobs/:id/stage', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { stage_index, stages, log } = req.body;
    const result = await sql`
      UPDATE jobs SET stage_index=${stage_index}, stages=${JSON.stringify(stages)}, log=${JSON.stringify(log)}
      WHERE id=${id} RETURNING *
    `;
    const job = result[0];
    if (job) {
      // Use the most recent log entry's action verb if available; otherwise generic.
      const last = Array.isArray(log) && log.length ? log[log.length - 1] : null;
      const summary = last
        ? `Job E-${job.id} ${last.status === 'blocked' ? 'blocked' : last.status === 'done' ? 'completed' : 'moved'} at "${last.stage}"${last.notes ? ': ' + last.notes : ''}`
        : `Job E-${job.id} stage updated`;
      await logAudit(sql, req, { action: 'job.stage', entityType: 'job', entityId: job.id, summary });
    }
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  dbReady.then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  });
}

module.exports = app;
