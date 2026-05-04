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

// CREATE a job
app.post('/api/jobs', async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars } = req.body;
    const result = await sql`
      INSERT INTO jobs (name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars)
      VALUES (${name}, ${client}, ${jobcode||null}, ${ref||null}, ${dateissued||null}, ${deadline||null}, ${size||null}, ${ups||null}, ${sheets||null}, ${qty||null}, ${paper||null}, ${machine||null}, ${coatings||[]}, ${priority||'Medium'}, ${delqty||null}, ${cartonqty||null}, ${notes||null}, ${bno||null}, ${mfgdate||null}, ${expdate||null}, ${mrp||null}, ${JSON.stringify(particulars||{})})
      RETURNING *
    `;
    res.json(result[0]);
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
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars } = req.body;
    const result = await sql`
      UPDATE jobs SET
        name=${name}, client=${client}, jobcode=${jobcode||null}, ref=${ref||null},
        dateissued=${dateissued||null}, deadline=${deadline||null}, size=${size||null},
        ups=${ups||null}, sheets=${sheets||null}, qty=${qty||null}, paper=${paper||null},
        machine=${machine||null}, coatings=${coatings||[]}, priority=${priority||'Medium'},
        delqty=${delqty||null}, cartonqty=${cartonqty||null}, notes=${notes||null},
        bno=${bno||null}, mfgdate=${mfgdate||null}, expdate=${expdate||null}, mrp=${mrp||null},
        particulars=${JSON.stringify(particulars||{})}
      WHERE id=${id} RETURNING *
    `;
    res.json(result[0]);
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
