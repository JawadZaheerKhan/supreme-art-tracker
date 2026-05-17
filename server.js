const express = require('express');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const app = express();
app.use(express.json());
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

    console.log('Database ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

// Run schema migrations once at module load. Every handler awaits this so
// requests can't race ahead of ALTER TABLE on a cold start.
const dbReady = initDb();

// GET all jobs
app.get('/api/jobs', async (req, res) => {
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
app.post('/api/jobs', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id } = req.body;
    const result = await sql`
      INSERT INTO jobs (name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id)
      VALUES (${name}, ${client}, ${jobcode||null}, ${ref||null}, ${dateissued||null}, ${deadline||null}, ${size||null}, ${ups||null}, ${sheets||null}, ${qty||null}, ${paper||null}, ${machine||null}, ${coatings||[]}, ${priority||'Medium'}, ${delqty||null}, ${cartonqty||null}, ${notes||null}, ${bno||null}, ${mfgdate||null}, ${expdate||null}, ${mrp||null}, ${JSON.stringify(particulars||{})}, ${inventory_item_id||null})
      RETURNING *
    `;
    const job = result[0];
    const sheetsUsed = parseSheets(sheets);
    if (inventory_item_id && sheetsUsed > 0) {
      await applyInventoryChange(sql, {
        itemId: inventory_item_id,
        change: -sheetsUsed,
        reason: 'job-consumed',
        jobId: job.id,
        notes: `Job E-${job.id}${job.jobcode ? ' · ' + job.jobcode : ''}: ${job.name}`,
      });
    }
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE job details
app.put('/api/jobs/:id', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id } = req.body;

    // Read the prior values so we can auto-adjust the inventory ledger when
    // either the paper item or the sheets quantity changed.
    const prior = await sql`SELECT inventory_item_id, sheets FROM jobs WHERE id = ${id}`;
    const oldItemId  = prior[0]?.inventory_item_id || null;
    const oldSheets  = parseSheets(prior[0]?.sheets);
    const newItemId  = inventory_item_id || null;
    const newSheets  = parseSheets(sheets);

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

    // Adjust inventory: return the old consumption, charge the new.
    // No-op when both legs are zero or identical.
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
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Inventory endpoints ─────────────────────────────────────────

// LIST all inventory items
app.get('/api/inventory', async (req, res) => {
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
app.post('/api/inventory', async (req, res) => {
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
    if (opening > 0) {
      await applyInventoryChange(sql, {
        itemId: item.id,
        change: +opening,
        reason: 'opening-balance',
        jobId: null,
        notes: opening_notes || 'Opening balance',
      });
      const refreshed = await sql`SELECT * FROM inventory_items WHERE id = ${item.id}`;
      return res.json(refreshed[0]);
    }
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// UPDATE inventory item fields (not balance — balance is ledger-driven)
app.put('/api/inventory/:id', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { paper_type, size, gsm, brand, reorder_threshold } = req.body;
    const result = await sql`
      UPDATE inventory_items SET
        paper_type=${paper_type}, size=${size||null}, gsm=${gsm||null},
        brand=${brand||null}, reorder_threshold=${reorder_threshold||0}
      WHERE id=${id} RETURNING *
    `;
    res.json(result[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ADD/ADJUST stock — used for deliveries and manual corrections.
app.post('/api/inventory/:id/transactions', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { change, reason, notes } = req.body;
    const delta = parseSheets(change);
    if (!delta) return res.status(400).json({ error: 'change must be a non-zero integer' });
    await applyInventoryChange(sql, {
      itemId: parseInt(id, 10),
      change: delta,
      reason: reason || (delta > 0 ? 'delivery' : 'adjustment'),
      jobId: null,
      notes: notes || null,
    });
    const refreshed = await sql`SELECT * FROM inventory_items WHERE id = ${id}`;
    res.json(refreshed[0]);
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
    const txs = await sql`
      SELECT t.*, j.name AS job_name, j.jobcode AS job_code,
             i.paper_type, i.size AS item_size, i.gsm AS item_gsm,
             i.brand AS item_brand, i.unit AS item_unit
      FROM inventory_transactions t
      LEFT JOIN jobs j ON j.id = t.job_id
      LEFT JOIN inventory_items i ON i.id = t.item_id
      WHERE (${from}::timestamptz IS NULL OR t.created_at >= ${from}::timestamptz)
        AND (${to}::timestamptz   IS NULL OR t.created_at <  (${to}::timestamptz + INTERVAL '1 day'))
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
app.get('/api/inventory/:id/transactions', async (req, res) => {
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

// UPDATE stage/status only
app.patch('/api/jobs/:id/stage', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { stage_index, stages, log } = req.body;
    const result = await sql`
      UPDATE jobs SET stage_index=${stage_index}, stages=${JSON.stringify(stages)}, log=${JSON.stringify(log)}
      WHERE id=${id} RETURNING *
    `;
    res.json(result[0]);
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
