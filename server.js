const express = require('express');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
// 6mb limit: station voice notes arrive as base64 audio (~1MB for 60s of
// opus). Default 100kb would 413 them. Vercel itself caps bodies at 4.5MB.
app.use(express.json({ limit: '6mb' }));
app.use(cookieParser());

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET       = process.env.JWT_SECRET || 'dev-only-change-me';
const BOOTSTRAP_ADMIN  = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase();
const SESSION_COOKIE   = 'sa_session';
const SESSION_MAX_AGE  = 30 * 24 * 60 * 60 * 1000; // 30 days
const googleClient     = new OAuth2Client(GOOGLE_CLIENT_ID);

// Business timezone. The server runs on Vercel in UTC, but the press
// (and everyone reading the reports) is in Pakistan (UTC+5). Without
// pinning this, work logged after 19:00 PKT rolls back to the previous
// UTC calendar day, so the Daily Production report shows it on the wrong
// date. Every server-generated "today" / stamp / date-of-instant goes
// through these two helpers so the whole app agrees on the local day.
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Asia/Karachi';
// YYYY-MM-DD for the given instant in business-local time.
function businessDateISO(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
// "dd/mm/yyyy hh:mm" (24h) for the given instant in business-local time —
// the byline stamp format every station/stage log entry uses.
function businessStamp(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');
}

// Production stages — must mirror STAGES in public/index.html. Used by the
// station-update endpoint to build stage names + detect the final stage.
const STAGES = ['CTP Plate Making','Printing','Coatings','Die Cutting','Sorting','Pasting','Finished','Delivered'];

// Coating finish kinds split into wet (Coatings tab) and embellishment
// (Embellishments tab) so each tab shows only the work that section does.
// Color Seal and Colour Seal are both accepted because the print label
// normalizes them but historical data has both spellings.
const WET_FINISHES = new Set(['UV','Spot UV','Varnish','Lacquer','Water Base','Lamination']);
const EMBELLISH_FINISHES = new Set(['Emboss','Color Seal','Colour Seal','Dripup','Cylinder Emboss','Hot Foiling']);

// Operator roles — what each role lets the holder do. Multiple roles can
// land on the same stage_index (Coatings + Embellishments both at 2): the
// difference is which specific finishes they're qualified for. ROLES keeps
// the named list; ROLE_FINISHES maps the coatings-stage roles to the
// finish kinds they cover. Roles without finishes simply gate the stage.
const ROLES = [
  { id: 'ctp',       label: 'CTP Plate Making', stage_index: 0 },
  { id: 'print',     label: 'Printing',         stage_index: 1 },
  { id: 'coatings',  label: 'Coatings',         stage_index: 2 },
  { id: 'embellish', label: 'Embellishments',   stage_index: 2 },
  { id: 'diecut',    label: 'Die Cutting',      stage_index: 3 },
  { id: 'break',     label: 'Sorting',          stage_index: 4 },
  { id: 'paste',     label: 'Pasting',          stage_index: 5 },
  { id: 'storage',   label: 'Finished',         stage_index: 6 },
];
const ROLE_FINISHES = {
  coatings:  ['UV','Spot UV','Varnish','Lacquer','Water Base','Lamination','Dripup','Color Seal'],
  embellish: ['Emboss','Cylinder Emboss','Hot Foiling'],
};
const ALL_FINISHES = [...ROLE_FINISHES.coatings, ...ROLE_FINISHES.embellish];
const ROLE_IDS = new Set(ROLES.map(r => r.id));

function rolesOf(operator) {
  if (Array.isArray(operator.roles) && operator.roles.length) return operator.roles;
  // Back-compat: derive from legacy stage_indices/stage_index — assume the
  // wet/film 'coatings' role when stage 2 was assigned (admin can refine).
  const idxs = (Array.isArray(operator.stage_indices) && operator.stage_indices.length)
    ? operator.stage_indices : [operator.stage_index];
  const out = [];
  for (const r of ROLES) if (idxs.includes(r.stage_index) && r.id !== 'embellish') out.push(r.id);
  return out;
}
function allowedFinishesForOperator(operator) {
  const set = new Set();
  for (const id of rolesOf(operator)) {
    const list = ROLE_FINISHES[id];
    if (list) list.forEach(f => set.add(f));
  }
  return set;
}
function stageIndicesFromRoles(roles) {
  const set = new Set();
  for (const r of ROLES) if (roles.includes(r.id)) set.add(r.stage_index);
  return [...set].sort((a, b) => a - b);
}
// Pending coatings for a job, optionally restricted to a single role's
// finish set (so an Embellishments operator only sees the embellishments
// still to do, not the UV / lamination items meant for the wet section).
function pendingCoatings(job, allowedSet) {
  const planned = Array.isArray(job.coatings) ? job.coatings : [];
  const allDone = Array.isArray(job.coatings_done) ? job.coatings_done : [];
  // Staleness: ignore done entries from before the Coatings stage was last
  // re-entered. Lets an admin reverse the stage and have operators redo
  // coatings without the queue treating them as already done.
  const stageRec = job.stages && job.stages[2];
  let stageMs = 0;
  if (stageRec && stageRec.time) {
    const m = String(stageRec.time).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (m) {
      const t = new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0)).getTime();
      if (isFinite(t)) stageMs = t;
    }
  }
  const liveDone = stageMs ? allDone.filter(d => d && (new Date(d.done_at).getTime() || 0) >= stageMs) : allDone;
  const doneKinds = liveDone.map(d => d && d.kind).filter(Boolean);
  return planned.filter(c => !doneKinds.includes(c) && (!allowedSet || allowedSet.has(c)));
}

// Expose the public Google client id to the frontend so it can configure GIS.
// Safe to expose — it's a public identifier, not a secret.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  // vercelEnv ('production' | 'preview' | 'development') drives client-side
  // polling: preview deployments don't auto-poll (manual refresh only) so they
  // never keep the Neon compute awake. Set automatically by Vercel per deploy.
  res.send(`window.__SA_CONFIG__ = ${JSON.stringify({
    googleClientId: GOOGLE_CLIENT_ID || '',
    vercelEnv: process.env.VERCEL_ENV || 'development',
  })};`);
});

app.use(express.static(path.join(__dirname, 'public')));

function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is not set');
  return neon(url);
}

// Bump this whenever a new migration is added to initDb. The first cold
// start after a deploy runs the full schema setup once and writes this
// value to schema_meta; subsequent cold starts read the marker in a single
// query and skip the ~30 CREATE/ALTER statements entirely. This is what
// kept the Station PIN waiting 30 s on every cold start.
const SCHEMA_VERSION = 'v2026-06-29-rename-paper-types';

async function initDb() {
  try {
    const sql = getDb();
    // Fast-path: schema_meta has to exist before we can read the version
    // marker, but CREATE TABLE IF NOT EXISTS is idempotent so it's cheap
    // on warm DBs (one roundtrip vs. the ~30 we'd otherwise run).
    await sql`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)`;
    const cur = await sql`SELECT value FROM schema_meta WHERE key = 'schema_version'`;
    if (cur.length && cur[0].value === SCHEMA_VERSION) return;
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
        priority    TEXT DEFAULT 'Normal',
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
    // Job card print tracking: incremented every time someone clicks Print
    // on a job card. Drives the small "this job has been printed" dot on
    // the job card UI so the office can tell at a glance which jobs are
    // already on the floor as paper.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS print_count INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_printed_at TIMESTAMPTZ`;
    // Cut workflow: a job may consume a source sheet at one size (cut_size,
    // what the job prints on) and return the leftover to stock at another
    // size (offcut_size). NULL on both = no cut, issue normally.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cut_size    TEXT`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS offcut_size TEXT`;
    // Per-finish completion log. Each entry: {kind, operator_id, operator_name,
    // machine, waste_sheets, done_at}. Drives the queue/advance logic at the
    // Coatings + Embellishments stations.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS coatings_done JSONB DEFAULT '[]'::jsonb`;

    // Soft-delete (Trash) columns: when admin "Delete from History" deletes a
    // delivered job, we set deleted_at instead of dropping the row, so the
    // admin has 30 days to recover it from the Trash page. Auto-purged later.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_by TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS jobs_deleted_at_idx ON jobs(deleted_at) WHERE deleted_at IS NOT NULL`;

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
        supplier           TEXT,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // Add supplier on pre-existing DBs that were created before the column.
    await sql`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS supplier TEXT`;
    // Distinguish offcut items (reclaimed leftovers from cutting parent
    // sheets) from fresh stock of the same dimensions. A 24x18 offcut and a
    // 24x18 fresh sheet are different inventory lines.
    await sql`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS is_offcut BOOLEAN NOT NULL DEFAULT false`;
    // For offcut items, record the dimensions of the parent sheet they were
    // cut from (e.g. "24x32"). Set on first create; not overwritten on
    // subsequent matches — the first source stays as the canonical origin.
    await sql`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS cut_from_size TEXT`;

    // (paper_type, size, gsm, brand, is_offcut) uniquely identifies an
    // inventory line. COALESCE keeps NULLs from defeating uniqueness —
    // Postgres treats NULL as not-equal otherwise. Drop+recreate is
    // idempotent: existing rows all have is_offcut=false, so no collisions.
    await sql`DROP INDEX IF EXISTS inventory_items_unique_idx`;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_items_unique_idx
        ON inventory_items (paper_type, COALESCE(size,''), COALESCE(gsm,''), COALESCE(brand,''), is_offcut)
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
    // Reversal pointer: when an admin or stock keeper reverses a wrong
    // stock-in within 24h, the new "undo" row stores the id of the original
    // it cancels. Used to (a) hide the Reverse button on already-reversed
    // entries and (b) highlight both rows in the History UI.
    await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS reverses_tx_id INTEGER REFERENCES inventory_transactions(id) ON DELETE SET NULL`;
    // Track WHO entered each transaction so the stock-keeper-within-24h rule
    // can authorize reversals and the History UI can show the entrant. No FK
    // on user_id because the users table is created further down — plain int
    // is safer and we already denormalize the email anyway.
    await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS user_id    INTEGER`;
    await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS user_email TEXT`;

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
    // Soft-delete columns for the Trash page. Only non-received rows can be
    // soft-deleted (received rows would orphan their stock-in tx).
    await sql`ALTER TABLE inventory_imports ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
    await sql`ALTER TABLE inventory_imports ADD COLUMN IF NOT EXISTS deleted_by TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS imports_deleted_at_idx ON inventory_imports(deleted_at) WHERE deleted_at IS NOT NULL`;

    // Auth: allow-list of users keyed by email. role is enforced via CHECK so
    // the DB rejects typos. invited_by is just a breadcrumb for the Users tab.
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        name          TEXT,
        picture       TEXT,
        role          TEXT NOT NULL DEFAULT 'production_manager' CHECK (role IN ('admin','production_manager','store_manager','operator','ceo')),
        invited_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      )
    `;
    // Role rename rollout: the original roles were 'admin','user','stock','ceo'.
    // We renamed 'user' → 'production_manager' and 'stock' → 'store_manager',
    // and added a new 'operator' role for the station-only floor staff.
    // The migration runs every boot but is idempotent:
    //   1. Widen the CHECK to accept both old + new names so the UPDATE doesn't
    //      get blocked.
    //   2. UPDATE the old role names to the new ones.
    //   3. Re-narrow the CHECK to only the new role names.
    await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`;
    await sql`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','user','stock','ceo','production_manager','store_manager','operator'))`;
    await sql`UPDATE users SET role = 'production_manager' WHERE role = 'user'`;
    await sql`UPDATE users SET role = 'store_manager'      WHERE role = 'stock'`;
    await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`;
    await sql`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','production_manager','store_manager','operator','ceo'))`;

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

    // Operators: shop-floor workers who update jobs from the shared station
    // terminal via a 4-digit PIN. Separate from `users` (login accounts) —
    // these never sign in, they just identify themselves at a machine.
    // stage_index ties an operator to one production section (index into STAGES).
    await sql`
      CREATE TABLE IF NOT EXISTS operators (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        pin         TEXT NOT NULL,
        stage_index INTEGER NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    // PIN must be unique among active operators so /verify is unambiguous.
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS operators_pin_active_idx ON operators(pin) WHERE active`;
    // PINs are now 3 digits. Existing 4-digit PINs that start with 0 get
    // their leading 0 dropped (0001 → 001, 0023 → 023). PINs that don't fit
    // that pattern are left alone so admin can re-issue them by hand.
    await sql`UPDATE operators SET pin = SUBSTRING(pin FROM 2) WHERE pin ~ '^0\\d{3}$'`;
    // Optional machine label — which specific press / coater / die-cutter
    // this operator is at. Free-text so the floor can name machines
    // however they refer to them ('SM-52', 'Heidelberg #2', 'Coater 1').
    await sql`ALTER TABLE operators ADD COLUMN IF NOT EXISTS machine TEXT`;
    // Multiple stages per operator — an operator may run more than one section
    // (e.g. Printing AND Coatings on the same machine). stage_index stays as
    // the "primary" / default and the array carries the full set of roles.
    await sql`ALTER TABLE operators ADD COLUMN IF NOT EXISTS stage_indices INTEGER[]`;
    await sql`UPDATE operators SET stage_indices = ARRAY[stage_index]
              WHERE stage_indices IS NULL OR cardinality(stage_indices) = 0`;
    // Named roles — Coatings and Embellishments live at the same stage_index
    // but are different role labels so the admin can assign people to the
    // wet/film section vs. the foil/emboss section without splitting the
    // workflow into two stages.
    await sql`ALTER TABLE operators ADD COLUMN IF NOT EXISTS roles TEXT[]`;
    // Urdu name — shown next to the Roman name on the station terminal so
    // operators who can't read Roman script can still recognise themselves.
    await sql`ALTER TABLE operators ADD COLUMN IF NOT EXISTS name_ur TEXT`;
    // Each row in `operators` now represents a MACHINE. PIN belongs to the
    // machine; one or more people work on it. persons is [{name, name_ur}].
    await sql`ALTER TABLE operators ADD COLUMN IF NOT EXISTS persons JSONB DEFAULT '[]'::jsonb`;
    // One-time migration: turn each existing single-person row into a machine
    // with that one person, and move the machine-name column into `name` so
    // `name` consistently means the machine label going forward.
    const machV1 = await sql`SELECT value FROM schema_meta WHERE key = 'operators_as_machines_v1'`;
    if (!machV1.length) {
      await sql`
        UPDATE operators
        SET persons = jsonb_build_array(jsonb_build_object('name', name, 'name_ur', COALESCE(name_ur, '')))
        WHERE persons IS NULL OR jsonb_array_length(persons) = 0
      `;
      await sql`UPDATE operators SET name = machine WHERE machine IS NOT NULL AND machine <> '' AND machine <> name`;
      await sql`INSERT INTO schema_meta (key, value) VALUES ('operators_as_machines_v1', NOW()::TEXT)`;
    }

    // (schema_meta already created at the top of initDb for the fast-path.)
    // Revert the short-lived v2 migration that added an Embellishments
    // stage at index 3. If v2 ever ran on this DB, undo the stage_index
    // shift: any stage_index that landed at 3 (Embellishments) collapses
    // back into 2 (Coatings); 4+ steps back down by 1. Idempotent via
    // the v3 marker.
    const v3 = await sql`SELECT value FROM schema_meta WHERE key = 'stages_v3_no_embellishments'`;
    if (!v3.length) {
      const v2 = await sql`SELECT value FROM schema_meta WHERE key = 'stages_v2_embellishments'`;
      if (v2.length) {
        await sql`UPDATE jobs SET stage_index = 2 WHERE stage_index = 3`;
        await sql`UPDATE jobs SET stage_index = stage_index - 1 WHERE stage_index >= 4`;
        const jobsWithStages = await sql`SELECT id, stages FROM jobs WHERE stages IS NOT NULL`;
        for (const r of jobsWithStages) {
          if (!r.stages || typeof r.stages !== 'object' || Array.isArray(r.stages)) continue;
          const shifted = {};
          for (const [k, v] of Object.entries(r.stages)) {
            const idx = parseInt(k, 10);
            let newIdx;
            if (idx === 3) newIdx = 2;
            else if (idx >= 4) newIdx = idx - 1;
            else newIdx = idx;
            // If both an old-2 (Coatings) and old-3 (Embellishments) entry
            // existed, prefer the existing target so we don't clobber it.
            if (shifted[String(newIdx)]) continue;
            shifted[String(newIdx)] = v;
          }
          await sql`UPDATE jobs SET stages = ${JSON.stringify(shifted)} WHERE id = ${r.id}`;
        }
        await sql`UPDATE operators SET stage_index = 2 WHERE stage_index = 3`;
        await sql`UPDATE operators SET stage_index = stage_index - 1 WHERE stage_index >= 4`;
        await sql`UPDATE operators
                  SET stage_indices = ARRAY(
                    SELECT DISTINCT CASE WHEN x = 3 THEN 2 WHEN x >= 4 THEN x - 1 ELSE x END
                    FROM unnest(stage_indices) AS x
                  )
                  WHERE stage_indices IS NOT NULL`;
      }
      await sql`INSERT INTO schema_meta (key, value) VALUES ('stages_v3_no_embellishments', NOW()::TEXT)`;
    }
    // Backfill operator.roles from the legacy stage_indices for anyone who
    // hasn't been edited since this column landed. Embellishments operators
    // can't be auto-detected (Coatings + Embellishments share stage 2), so
    // they default to the 'coatings' role; admin re-saves to add 'embellish'.
    const opsNeedingRoles = await sql`SELECT id, stage_indices FROM operators WHERE roles IS NULL OR cardinality(roles) = 0`;
    for (const op of opsNeedingRoles) {
      const idxs = Array.isArray(op.stage_indices) ? op.stage_indices : [];
      const ids = [];
      for (const r of ROLES) {
        if (r.id === 'embellish') continue;
        if (idxs.includes(r.stage_index)) ids.push(r.id);
      }
      if (ids.length) {
        await sql`UPDATE operators SET roles = ${ids} WHERE id = ${op.id}`;
      }
    }

    // Dropdown blacklist — values removed from the brand/supplier dropdown
    // suggestions without touching existing inventory items. So "Century" can
    // be hidden from new-item suggestions, but every item already tagged
    // "Century" keeps its tag intact (and its stock history is preserved).
    await sql`
      CREATE TABLE IF NOT EXISTS dropdown_hidden (
        field      TEXT NOT NULL,
        value      TEXT NOT NULL,
        hidden_at  TIMESTAMPTZ DEFAULT NOW(),
        hidden_by  TEXT,
        PRIMARY KEY (field, value)
      )
    `;

    // CAPA reports: Corrective & Preventive Action reports raised against a
    // job card. A job can have multiple CAPAs (one per non-conformance issue).
    // Section-1 job details are auto-snapshotted at creation in job_snapshot
    // so the CAPA stays stable even if the underlying job is edited. The rest
    // of the form lives in `data` JSONB so we can evolve fields without
    // migrations. Status is denormalized out of `data` for easy filtering.
    await sql`
      CREATE TABLE IF NOT EXISTS capa_reports (
        id               SERIAL PRIMARY KEY,
        job_id           INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        capa_ref         TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        status           TEXT NOT NULL DEFAULT 'open',
        issue_date       TEXT,
        job_snapshot     JSONB NOT NULL DEFAULT '{}',
        data             JSONB NOT NULL DEFAULT '{}',
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        created_by_id    INTEGER,
        created_by_email TEXT,
        updated_at       TIMESTAMPTZ DEFAULT NOW(),
        closed_at        TIMESTAMPTZ
      )
    `;
    // Allow standalone CAPAs (not tied to a specific job). job_id stays a FK
    // but is now nullable — the user fills Section 1 manually instead of
    // snapshotting from a job. Idempotent migration on existing deployments.
    await sql`ALTER TABLE capa_reports ALTER COLUMN job_id DROP NOT NULL`;
    await sql`CREATE INDEX IF NOT EXISTS capa_reports_job_idx    ON capa_reports(job_id)`;
    await sql`CREATE INDEX IF NOT EXISTS capa_reports_status_idx ON capa_reports(status)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS capa_reports_job_seq_uidx ON capa_reports(job_id, seq)`;

    // Station notes — short text/voice messages an operator leaves on a job
    // for the NEXT station ("plate 2 runs dark, watch the left edge").
    // stage_index records where the note was written; it is shown at the
    // station whose stage_index is one higher, while the job sits there.
    // Voice audio is stored inline as a base64 data-URL (TEXT) — a 60s opus
    // clip is ~1MB, fine at floor volumes; audio is purged after 30 days
    // (lazily, on each note insert) while the text rows stay for history.
    await sql`
      CREATE TABLE IF NOT EXISTS station_notes (
        id            SERIAL PRIMARY KEY,
        job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        stage_index   INTEGER NOT NULL,
        operator_name TEXT,
        kind          TEXT NOT NULL DEFAULT 'text',
        body          TEXT,
        audio         TEXT,
        mime          TEXT,
        duration_s    REAL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        heard_at      TIMESTAMPTZ
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS station_notes_job_idx ON station_notes(job_id)`;

    // Daily Production register notes — admin-editable Hours + Remarks cells
    // that overlay the auto-aggregated machine totals. One row per
    // (date, section, machine), composite primary key for clean upserts.
    await sql`
      CREATE TABLE IF NOT EXISTS daily_production_notes (
        date     DATE NOT NULL,
        section  TEXT NOT NULL,
        machine  TEXT NOT NULL,
        hours    TEXT,
        remarks  TEXT,
        PRIMARY KEY (date, section, machine)
      )
    `;
    // Die-section specific cells. Other sections can add their own
    // editable fields the same way later.
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS make_ready TEXT`;
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS settings   TEXT`;
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS blankets   TEXT`;
    // Breaking section is manually entered (no workflow stage to derive
    // from). Each (date, 'breaking', operator_name) row stores one
    // operator's day. Reuses the same table — only the new columns are
    // section-specific.
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS sheets TEXT`;
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS jobs   TEXT`;
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS helper TEXT`;
    // Custom-row fields — used when admin adds an ad-hoc row via the +
    // button on a Daily Production tab. For regular (role-tagged) rows
    // these stay null and the auto-aggregated values are shown.
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS colors         TEXT`;
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS plates         TEXT`;
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS operators_text TEXT`;
    // Wastage cell — auto-aggregated from each section's per-job waste
    // particulars (printed_waste_sheets / die_cutting_waste /
    // pasting_waste_qty / coatings_done[].waste_sheets) and admin-
    // editable per machine row, same as Hours / Remarks.
    await sql`ALTER TABLE daily_production_notes ADD COLUMN IF NOT EXISTS waste TEXT`;

    // One-time rename of legacy paper-type labels — old "Bleach Card" and
    // "Box Board" are now "Bleach Board" and "Duplex Board" across the app.
    await sql`UPDATE inventory_items   SET paper_type = 'Bleach Board' WHERE paper_type = 'Bleach Card'`;
    await sql`UPDATE inventory_items   SET paper_type = 'Duplex Board' WHERE paper_type = 'Box Board'`;
    await sql`UPDATE inventory_imports SET paper_type = 'Bleach Board' WHERE paper_type = 'Bleach Card'`;
    await sql`UPDATE inventory_imports SET paper_type = 'Duplex Board' WHERE paper_type = 'Box Board'`;

    // Stamp the schema version so future cold starts hit the fast-path
    // short-circuit at the top of initDb instead of replaying every ALTER.
    await sql`
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', ${SCHEMA_VERSION})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    console.log('Database ready (schema ' + SCHEMA_VERSION + ')');
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
// ── Role helpers ─────────────────────────────────────────────
// Roles: 'admin' (full), 'production_manager' (jobs+station write),
// 'store_manager' (inventory+imports write), 'operator' (station only),
// 'ceo' (read-only everywhere).
// Legacy fallback: JWT cookies issued before the role rename still carry
// 'user' (→ production_manager) and 'stock' (→ store_manager). Treat them as
// the new equivalents so stale cookies don't break access until they expire.
function canWriteJobs(role)      { return role === 'admin' || role === 'production_manager' || role === 'user'; }
function canWriteInventory(role) { return role === 'admin' || role === 'store_manager'      || role === 'stock'; }
function canRunStation(role)     { return role === 'admin' || role === 'production_manager' || role === 'user' || role === 'operator' || role === 'ceo'; }
// Operator roster CRUD — admin or production manager. The PM owns the
// floor and needs to add / edit / retire operators without an admin
// having to be involved every time.
function canManageOperators(role){ return role === 'admin' || role === 'production_manager' || role === 'user'; }
function isOperatorRole(role)    { return role === 'operator'; }

// Generic "not read-only" check. Used for cross-cutting endpoints (audit
// metadata, profile edits, etc.) where any non-CEO write is fine.
function requireWriteUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (req.user.role === 'ceo') {
    return res.status(403).json({ error: 'Read-only account — changes are not allowed' });
  }
  // Operators can only touch the station endpoints — block everything else.
  if (req.user.role === 'operator') {
    return res.status(403).json({ error: 'Operator accounts can only use the Station view' });
  }
  next();
}
// Jobs writes (create/edit/delete/move stages outside station) — admin or
// production_manager.
function requireJobsWriter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canWriteJobs(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed — jobs write access required' });
  }
  next();
}
// Inventory + imports writes — admin or store_manager.
function requireInventoryWriter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canWriteInventory(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed — inventory write access required' });
  }
  next();
}
// Station endpoints — admin, production_manager, operator, or CEO.
// (Store_manager is blocked.) PIN is still verified separately per call.
function requireStationUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canRunStation(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed — station access required' });
  }
  next();
}
// Operator roster CRUD — admin or production_manager. Used in place
// of requireAdmin on the operator endpoints so the PM can keep the
// floor PIN roster current on their own.
function requireOperatorAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canManageOperators(req.user.role)) {
    return res.status(403).json({ error: 'Not allowed — operator admin access required' });
  }
  next();
}
// CAPA writes — admin, production_manager, or CEO. CAPA is governance,
// not floor work; CEOs need to be able to file / close their own reports.
function requireCapaWriter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const r = req.user.role;
  const ok = r === 'admin' || r === 'production_manager' || r === 'user' || r === 'ceo';
  if (!ok) return res.status(403).json({ error: 'Not allowed — CAPA write access required' });
  next();
}
// Legacy aliases — kept so existing call sites compile until they're
// individually migrated to the more specific middleware above.
const requireStockOrAdmin = requireInventoryWriter;

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

// GET users — admin + ceo (CEO is read-only; mutation endpoints below stay
// requireAdmin so role change / invite / remove are still locked down).
app.get('/api/users', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'ceo') {
    return res.status(403).json({ error: 'Admin or CEO only' });
  }
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
    const ALLOWED_ROLES = ['admin','production_manager','store_manager','operator','ceo'];
    const role = ALLOWED_ROLES.includes(req.body.role) ? req.body.role : 'production_manager';
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
    const role = ['admin','production_manager','store_manager','operator','ceo'].includes(req.body.role) ? req.body.role : 'production_manager';
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

// ── Operators (shop-floor roster) ────────────────────────────

function validPin(pin) { return /^\d{3}$/.test(String(pin || '')); }

// List operators — admin only (includes pin for management).
// Byline parsers — job log entries store the actor as a string of the
// form "Name · Machine (Stage)". The Daily Production report scans
// every job's log[] looking for entries on a given date at a given
// stage, so we lift the operator name, machine, and stage label out.
function parseByOperator(by) {
  const m = /^([^·(]+?)\s*(?:·|\()/.exec(String(by || ''));
  return m ? m[1].trim() : '';
}
function parseByMachine(by) {
  const m = /·\s*([^()]+?)\s*\(/.exec(String(by || ''));
  return m ? m[1].trim() : '';
}
function parseByStage(by) {
  // Stage label is in the LAST set of parentheses, so a trailing
  // "(skipped 2 stages)" doesn't confuse us. We want the stage that's
  // immediately tied to who acted.
  const all = String(by || '').match(/\(([^)]+)\)/g);
  if (!all || !all.length) return '';
  // Try each match from the right; "(skipped N stages)" is a known
  // suffix — pick the first one that isn't that pattern.
  for (let i = all.length - 1; i >= 0; i--) {
    const inner = all[i].slice(1, -1).trim();
    if (/^skipped\b/i.test(inner)) continue;
    return inner;
  }
  return '';
}
// time string format the station-update writes: "dd/mm/yyyy hh:mm".
// Returns 'YYYY-MM-DD' or '' if unparseable.
function logTimeToISODate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

app.get('/api/operators', requireOperatorAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`SELECT * FROM operators ORDER BY pin ASC`;
    res.json(rows);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Parse the role payload — admin assigns operators by role name (Coatings,
// Embellishments, Die Cutting, …) and stage_indices are derived from the
// roles. Accepts legacy `stage_indices` only when no roles are sent.
function parseOperatorRoles(body) {
  let roleIds = Array.isArray(body.roles) ? body.roles.filter(r => ROLE_IDS.has(r)) : [];
  if (!roleIds.length && (Array.isArray(body.stage_indices) || body.stage_index !== undefined)) {
    // Legacy path: derive a default 'coatings' (wet) role when stage 2 is
    // requested; map other stage indices 1:1 to their role ids.
    const arr = Array.isArray(body.stage_indices)
      ? body.stage_indices
      : (body.stage_index !== undefined ? [body.stage_index] : []);
    const idxs = arr.map(v => parseInt(v, 10)).filter(n => Number.isInteger(n) && n >= 0);
    for (const r of ROLES) {
      if (r.id === 'embellish') continue;
      if (idxs.includes(r.stage_index)) roleIds.push(r.id);
    }
  }
  roleIds = Array.from(new Set(roleIds));
  if (!roleIds.length) return null;
  const stageIndices = stageIndicesFromRoles(roleIds);
  if (!stageIndices.length) return null;
  return { roles: roleIds, stageIndices, primary: stageIndices[0] };
}

// Persons list belongs to a machine — pin/role gates the machine, the
// signed-in operator is then picked from this list at the station screen.
function parsePersons(body) {
  if (!Array.isArray(body.persons)) return [];
  const out = [];
  for (const p of body.persons) {
    if (!p || typeof p !== 'object') continue;
    const n = String(p.name || '').trim();
    if (!n) continue;
    const nu = String(p.name_ur || '').trim();
    out.push({ name: n, name_ur: nu });
  }
  return out;
}

app.post('/api/operators', requireOperatorAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const name = (req.body.name || '').trim();
    const pin = String(req.body.pin || '').trim();
    const parsed = parseOperatorRoles(req.body);
    const persons = parsePersons(req.body);
    if (!name) return res.status(400).json({ error: 'Machine name is required' });
    if (!validPin(pin)) return res.status(400).json({ error: 'PIN must be exactly 3 digits' });
    if (!parsed) return res.status(400).json({ error: 'At least one role is required' });
    if (!persons.length) return res.status(400).json({ error: 'Add at least one operator on this machine' });
    const dupe = await sql`SELECT id FROM operators WHERE pin = ${pin} AND active`;
    if (dupe.length) return res.status(409).json({ error: 'That PIN is already in use by another machine' });
    const inserted = await sql`
      INSERT INTO operators (name, pin, stage_index, stage_indices, roles, persons)
      VALUES (${name}, ${pin}, ${parsed.primary}, ${parsed.stageIndices}, ${parsed.roles}, ${JSON.stringify(persons)}) RETURNING *
    `;
    await logAudit(sql, req, { action: 'operator.create', entityType: 'operator', entityId: inserted[0].id, summary: `Added machine ${name} (roles ${parsed.roles.join(',')}, ${persons.length} operator${persons.length === 1 ? '' : 's'})` });
    res.json(inserted[0]);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

app.put('/api/operators/:id', requireOperatorAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const name = (req.body.name || '').trim();
    const pin = String(req.body.pin || '').trim();
    const parsed = parseOperatorRoles(req.body);
    const persons = parsePersons(req.body);
    const active = req.body.active !== false;
    if (!name) return res.status(400).json({ error: 'Machine name is required' });
    if (!validPin(pin)) return res.status(400).json({ error: 'PIN must be exactly 3 digits' });
    if (!parsed) return res.status(400).json({ error: 'At least one role is required' });
    if (!persons.length) return res.status(400).json({ error: 'Add at least one operator on this machine' });
    const dupe = await sql`SELECT id FROM operators WHERE pin = ${pin} AND active AND id <> ${id}`;
    if (dupe.length) return res.status(409).json({ error: 'That PIN is already in use by another machine' });
    const updated = await sql`
      UPDATE operators SET name=${name}, pin=${pin}, stage_index=${parsed.primary}, stage_indices=${parsed.stageIndices}, roles=${parsed.roles}, persons=${JSON.stringify(persons)}, active=${active}
      WHERE id=${id} RETURNING *
    `;
    if (!updated.length) return res.status(404).json({ error: 'Operator not found' });
    await logAudit(sql, req, { action: 'operator.update', entityType: 'operator', entityId: id, summary: `Edited operator ${name}` });
    res.json(updated[0]);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

app.delete('/api/operators/:id', requireOperatorAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const deleted = await sql`DELETE FROM operators WHERE id=${id} RETURNING *`;
    if (!deleted.length) return res.status(404).json({ error: 'Operator not found' });
    await logAudit(sql, req, { action: 'operator.delete', entityType: 'operator', entityId: id, summary: `Removed operator ${deleted[0].name}` });
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Verify a PIN — used by the station PIN pad. Returns the operator's identity
// (never the pin). requireWriteUser so the floor terminal can call it but the
// read-only CEO account cannot.
app.post('/api/operators/verify', requireStationUser, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const pin = String(req.body.pin || '').trim();
    if (!validPin(pin)) return res.status(400).json({ error: 'Enter a 3-digit PIN' });
    const rows = await sql`SELECT id, name, stage_index, stage_indices, roles, persons FROM operators WHERE pin = ${pin} AND active LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'PIN not recognized' });
    const op = rows[0];
    if (!op.stage_indices || !op.stage_indices.length) op.stage_indices = [op.stage_index];
    if (!Array.isArray(op.roles) || !op.roles.length) op.roles = rolesOf(op);
    if (!Array.isArray(op.persons)) op.persons = [];
    res.json(op);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// All active persons across every machine — backs the "Custom" picker on
// the station, used when an operator works on a machine that's not their
// usual one. Returns a flat list of { name, name_ur, machine } so the UI
// can present the full roster without leaking PINs.
// Lightweight machines-by-role list — any signed-in user can read it.
// Used by the Job Card form to populate the Machine dropdown with the
// current printing machines (or any role passed in). Add a new printing
// machine under Users → Operators and it shows up here automatically.
app.get('/api/operators/machines', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const role = String(req.query.role || '').trim();
    const rows = role
      ? await sql`SELECT name FROM operators WHERE active AND roles @> ARRAY[${role}]::text[] ORDER BY name`
      : await sql`SELECT name FROM operators WHERE active ORDER BY name`;
    res.json(rows.map(r => r.name).filter(Boolean));
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

app.get('/api/operators/all-persons', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`SELECT name, persons, roles FROM operators WHERE active AND persons IS NOT NULL`;
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      const machineName = r.name || '';
      const list = Array.isArray(r.persons) ? r.persons : [];
      const roles = Array.isArray(r.roles) ? r.roles : [];
      for (const p of list) {
        const n = p && p.name ? String(p.name).trim() : '';
        if (!n) continue;
        const key = `${n.toLowerCase()}@${machineName.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // `roles` lets callers filter (e.g. the Breaking section of the
        // Daily Production print pulls everyone whose machine has the
        // 'break' role). Additive — existing all-persons consumers are
        // free to ignore it.
        out.push({ name: n, name_ur: (p.name_ur || '').trim(), machine: machineName, roles });
      }
    }
    out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    res.json(out);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Aggregate Daily Production data for one section + date. Both the
// Printing and Die endpoints use this — the only difference is which
// stage we filter on and which particulars-key supplies the sheet count.
async function aggregateDailyProduction(sql, { date, sectionRole, stageLabel, sheetsKey, wasteKey }) {
  const machineRows = await sql`SELECT name, persons FROM operators WHERE active AND roles @> ARRAY[${sectionRole}]::text[] ORDER BY name`;
  const machines = machineRows.map(r => r.name).filter(Boolean);
  // Person-name → machine-name map for THIS section's operators only. Lets
  // the fallback below credit "obaid" (typed on the Job Card's Die Cutting
  // Sheets row) to the Die Cutting machine obaid is registered on, rather
  // than blindly using the job's planned machine (which is the Printing
  // machine and would be wrong for any non-Printing section).
  const personToMachine = new Map();
  for (const r of machineRows) {
    const list = Array.isArray(r.persons) ? r.persons : [];
    for (const p of list) {
      const n = String((p && p.name) || '').trim().toLowerCase();
      if (n && !personToMachine.has(n)) personToMachine.set(n, r.name);
    }
  }
  const jobs = await sql`SELECT id, particulars, log, machine, stages FROM jobs WHERE deleted_at IS NULL AND log IS NOT NULL`;

  const acc = new Map();
  const ensure = (m) => {
    if (!acc.has(m)) acc.set(m, {
      sheets: 0, waste: 0, jobIds: new Set(), colorsCounts: new Map(),
      operators: new Set(), plates: 0,
    });
    return acc.get(m);
  };

  for (const job of jobs) {
    const log = Array.isArray(job.log) ? job.log : [];
    const machinesThisJob = new Set();
    const opsByMachine = new Map();
    // Pick the LATEST log entry for this (date, stage). Earlier station
    // submissions on the same day are treated as corrections — operator
    // hit submit at the wrong station, then re-submitted at the right
    // one — so only the most recent submission credits a machine. Stops
    // the same job from being counted on two machines.
    let latestMs = -1, latestMc = '', latestOp = '';
    let sawStageEntry = false;
    for (const e of log) {
      if (!e || !e.by) continue;
      if (logTimeToISODate(e.time) !== date) continue;
      if (parseByStage(e.by) !== stageLabel) continue;
      sawStageEntry = true;
      const m = String(e.time || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
      const ms = m ? new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0)).getTime() : 0;
      if (ms > latestMs) {
        latestMs = ms;
        latestMc = parseByMachine(e.by);
        latestOp = parseByOperator(e.by);
      }
    }
    if (latestMc) {
      machinesThisJob.add(latestMc);
      if (latestOp) {
        if (!opsByMachine.has(latestMc)) opsByMachine.set(latestMc, new Set());
        opsByMachine.get(latestMc).add(latestOp);
      }
    } else {
      // No station log entry attributed a machine. Look for an admin entry
      // on the Job Card: particulars[sheetsKey].name is the operator the
      // admin typed in (e.g. "obaid"). Cross-reference against operators
      // registered for THIS section's role to find their machine —
      // crediting "Die cutting 1060" instead of the printing machine the
      // job is planned on.
      const part0 = (job.particulars && typeof job.particulars === 'object') ? job.particulars : {};
      const cardOp = part0[sheetsKey] && String(part0[sheetsKey].name || '').trim();
      const cardOpMachine = cardOp ? personToMachine.get(cardOp.toLowerCase()) : '';
      const stageIdx = STAGES.indexOf(stageLabel);
      const stageRec = stageIdx >= 0 ? (job.stages && job.stages[stageIdx]) : null;
      const stageTimeMatches = stageRec && stageRec.time && logTimeToISODate(stageRec.time) === date;
      // Admin entered a Job Card row with a recognised operator name?
      // Credit the operator's machine ONLY when the stage was actually
      // advanced on this date (stageTimeMatches) or a station log entry
      // for this stage was recorded on this date (sawStageEntry). We do
      // NOT default admin-only entries to "today" — that caused old jobs
      // to reappear on every calendar day the report was viewed.
      const cardEntryFits = cardOpMachine && (stageTimeMatches || sawStageEntry);
      if (cardEntryFits) {
        machinesThisJob.add(cardOpMachine);
        if (!opsByMachine.has(cardOpMachine)) opsByMachine.set(cardOpMachine, new Set());
        opsByMachine.get(cardOpMachine).add(cardOp);
      } else if (job.machine && (sawStageEntry || stageTimeMatches) && machines.includes(job.machine)) {
        // Legacy fallback: the admin-typed name doesn't match any operator
        // registered for this section, but the job's planned machine IS a
        // machine for this section and the stage was advanced on the date.
        machinesThisJob.add(job.machine);
        if (cardOp) {
          if (!opsByMachine.has(job.machine)) opsByMachine.set(job.machine, new Set());
          opsByMachine.get(job.machine).add(cardOp);
        }
      }
    }
    if (!machinesThisJob.size) continue;
    const part = (job.particulars && typeof job.particulars === 'object') ? job.particulars : {};
    // Multi-pass entries[] is the source of truth when present — sum
    // only entries whose date matches the report date so a job split
    // across days gets attributed correctly. Falls back to the legacy
    // single-quantity number for jobs that never used multi-pass.
    let sheetsN = 0;
    const partKey = part[sheetsKey];
    if (partKey && Array.isArray(partKey.entries) && partKey.entries.length) {
      for (const e of partKey.entries) {
        if (!e || e.date !== date) continue;
        const n = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
        if (Number.isFinite(n)) sheetsN += n;
      }
    } else {
      const n = parseInt(String((partKey && partKey.quantity) || '').replace(/[^0-9-]/g, ''), 10);
      if (Number.isFinite(n)) sheetsN = n;
    }
    const colors = parseInt(String((part.no_of_colors && part.no_of_colors.quantity) || '').replace(/[^0-9-]/g, ''), 10);
    const colorsN = Number.isFinite(colors) ? colors : 0;
    // Waste — same per-date attribution as sheets. Multi-pass
    // entries[] take precedence; legacy single-quantity falls back.
    let wasteN = 0;
    if (wasteKey) {
      const partW = part[wasteKey];
      if (partW && Array.isArray(partW.entries) && partW.entries.length) {
        for (const e of partW.entries) {
          if (!e || e.date !== date) continue;
          const n = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
          if (Number.isFinite(n)) wasteN += n;
        }
      } else {
        const n = parseInt(String((partW && partW.quantity) || '').replace(/[^0-9-]/g, ''), 10);
        if (Number.isFinite(n)) wasteN = n;
      }
    }
    // Skip jobs the admin emptied out on the Job Card (no sheets, no
    // waste, no colors). Otherwise a job whose particulars row was
    // cleared would still inflate the jobs count and surface the
    // operator name parsed from the log byline.
    const hasData = sheetsN > 0 || wasteN > 0 || colorsN > 0;
    if (!hasData) continue;
    for (const mc of machinesThisJob) {
      const row = ensure(mc);
      row.jobIds.add(job.id);
      row.sheets += sheetsN;
      row.waste  += wasteN;
      row.plates += colorsN;
      if (colorsN > 0) row.colorsCounts.set(colorsN, (row.colorsCounts.get(colorsN) || 0) + 1);
      for (const op of (opsByMachine.get(mc) || [])) row.operators.add(op);
    }
  }
  return { machines, acc };
}

// Daily Production register — Printing section.
// Aggregates every Printing-stage log entry on `:date` from every job,
// groups by machine (parsed from the byline), and returns one row per
// machine with sheets, jobs count, colors breakdown, plates and the
// operator list. Hours + Remarks come from daily_production_notes so
// admin can scribble what the auto-totals can't capture.
app.get('/api/reports/daily-production/printing/:date', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const date = String(req.params.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    const { machines, acc } = await aggregateDailyProduction(sql, {
      date, sectionRole: 'print', stageLabel: 'Printing',
      sheetsKey: 'printed_sheets_qty', wasteKey: 'printed_waste_sheets',
    });
    const notesRows = await sql`SELECT machine, hours, remarks, sheets, jobs, colors, plates, operators_text, waste FROM daily_production_notes WHERE date = ${date} AND section = 'printing'`;
    const noteByMachine = new Map(notesRows.map(r => [r.machine, r]));
    const customMachines = notesRows.map(r => r.machine).filter(m => m && !machines.includes(m));
    const allMachines = [...machines, ...customMachines.sort()];
    const out = allMachines.map(m => {
      const row = acc.get(m);
      const note = noteByMachine.get(m) || {};
      const isCustom = !machines.includes(m);
      const colorsArr = row ? [...row.colorsCounts.entries()].sort((a, b) => a[0] - b[0]) : [];
      const colorsStr = colorsArr.map(([clr, cnt]) => `${cnt}-${clr}clr`).join(' / ');
      const operators = row ? [...row.operators].sort() : [];
      return {
        machine: m,
        // Source-of-truth columns (sheets / waste / operator / jobs /
        // colors / plates) are pure aggregates over the Job Card — admin
        // edits these via the Job Card itself, never via the report, so
        // clearing a Job Card row clears the report row too. Custom
        // (ad-hoc) machines still read these from the notes row because
        // there's no aggregate behind them.
        sheets: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : (row ? row.jobIds.size : 0),
        colors: isCustom ? (note.colors || '') : colorsStr,
        plates: isCustom ? (note.plates || '') : (row ? row.plates : 0),
        operators: isCustom ? (note.operators_text || '') : operators.join(', '),
        waste: isCustom ? (note.waste || '') : (row ? row.waste : 0),
        hours: note.hours || '',
        remarks: note.remarks || '',
        is_custom: isCustom,
      };
    });
    res.json(out);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Daily Production register — Coatings section (matches the paper
// register's "U.V — Spot U.V" page). Unlike Printing/Die where the
// stage moves on once finished, every individual coating is logged to
// the job's coatings_done JSONB array with { kind, operator_name,
// machine, waste_sheets, done_at }. We aggregate from there directly
// — more accurate than parsing bylines, and we get the finish kinds
// and waste totals for free.
// Date (YYYY-MM-DD) of an ISO timestamp instant, in business-local time.
// done_at values are stored as UTC instants (new Date().toISOString()), so
// a coating recorded at 00:30 PKT must report on that PKT day, not the
// UTC day (19:30 the day before). Falls back to a bare string-slice if the
// value isn't a parseable instant.
function isoTsToDate(ts) {
  const d = new Date(ts);
  if (!isNaN(d)) return businessDateISO(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ts || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
app.get('/api/reports/daily-production/coatings/:date', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const date = String(req.params.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

    // Coating machines = operators with 'coatings' (wet) or 'embellish'
    // (foil/emboss) roles. Both share this tab — embellishments machines
    // live in the same shop as the coatings machines.
    const machineRows = await sql`
      SELECT name FROM operators
      WHERE active
        AND (roles @> ARRAY['coatings']::text[] OR roles @> ARRAY['embellish']::text[])
      ORDER BY name
    `;
    const machines = machineRows.map(r => r.name).filter(Boolean);

    const jobs = await sql`SELECT id, particulars, coatings_done FROM jobs WHERE deleted_at IS NULL AND coatings_done IS NOT NULL`;

    const acc = new Map();
    const ensure = (m) => {
      if (!acc.has(m)) acc.set(m, {
        sheets: 0, jobIds: new Set(), operators: new Set(),
        finishCounts: new Map(), waste: 0,
      });
      return acc.get(m);
    };

    for (const job of jobs) {
      const done = Array.isArray(job.coatings_done) ? job.coatings_done : [];
      if (!done.length) continue;
      const part = (job.particulars && typeof job.particulars === 'object') ? job.particulars : {};
      // Sum pipe-separated values like "500 | 500" → 1000. coating_sheets_qty
      // and uv_waste_sheets both use this format because station submissions
      // append pass-by-pass.
      const sumPipe = (s) => String(s || '').split('|').reduce((acc, part) => {
        const n = parseInt(part.replace(/[^0-9-]/g, ''), 10);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
      const coatSheetsAdmin = sumPipe(part.coating_sheets_qty && part.coating_sheets_qty.quantity);
      // Fallback: if admin hasn't filled in Coating Sheets Qty, derive from
      // printed − printed-waste (legacy formula).
      const printedN = parseInt(String((part.printed_sheets_qty && part.printed_sheets_qty.quantity) || '').replace(/[^0-9-]/g, ''), 10) || 0;
      const printedWasteN = parseInt(String((part.printed_waste_sheets && part.printed_waste_sheets.quantity) || '').replace(/[^0-9-]/g, ''), 10) || 0;
      const sheetsN = coatSheetsAdmin > 0 ? coatSheetsAdmin : Math.max(0, printedN - printedWasteN);
      // Job-level waste from particulars (admin- or station-written).
      const adminWasteN = sumPipe(part.uv_waste_sheets && part.uv_waste_sheets.quantity);
      if (sheetsN <= 0) continue;
      const sheetsCredited = new Set();
      for (const entry of done) {
        if (!entry) continue;
        if (isoTsToDate(entry.done_at) !== date) continue;
        const kind = String(entry.kind || '').trim();
        const mc = String(entry.machine || '').trim();
        if (!mc) continue;
        const row = ensure(mc);
        row.jobIds.add(job.id);
        if (!sheetsCredited.has(mc)) {
          row.sheets += sheetsN;
          sheetsCredited.add(mc);
        }
        const opName = String(entry.operator_name || '').trim();
        if (opName) row.operators.add(opName);
        if (kind) row.finishCounts.set(kind, (row.finishCounts.get(kind) || 0) + 1);
        const w = parseInt(String(entry.waste_sheets || '').replace(/[^0-9-]/g, ''), 10);
        if (Number.isFinite(w)) row.waste += w;
      }
    }

    const notesRows = await sql`SELECT machine, hours, blankets, remarks, sheets, jobs, operators_text, waste FROM daily_production_notes WHERE date = ${date} AND section = 'coatings'`;
    const noteByMachine = new Map(notesRows.map(r => [r.machine, r]));
    const customMachines = notesRows.map(r => r.machine).filter(m => m && !machines.includes(m));
    const allMachines = [...machines, ...customMachines.sort()];

    const out = allMachines.map(m => {
      const row = acc.get(m);
      const note = noteByMachine.get(m) || {};
      const isCustom = !machines.includes(m);
      const operators = row ? [...row.operators].sort() : [];
      const finishes = row
        ? [...row.finishCounts.entries()].sort((a, b) => b[1] - a[1])
            .map(([k, n]) => n > 1 ? `${k} ×${n}` : k).join(', ')
        : '';
      return {
        machine: m,
        sheets: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : (row ? row.jobIds.size : 0),
        finishes,
        waste: isCustom ? (note.waste || '') : (row ? row.waste : 0),
        operators: isCustom ? (note.operators_text || '') : operators.join(', '),
        hours: note.hours || '',
        blankets: note.blankets || '',
        remarks: note.remarks || '',
        is_custom: isCustom,
      };
    });
    res.json(out);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Daily Production register — Breaking section. Unlike the others
// there's no workflow stage to aggregate from, so all numeric cells
// are admin-entered. We pull the operator roster from anyone whose
// machine has the 'break' role and serve their saved cells.
app.get('/api/reports/daily-production/breaking/:date', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const date = String(req.params.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

    const machRows = await sql`SELECT name, persons FROM operators WHERE active AND roles @> ARRAY['break']::text[]`;
    // De-dupe by lowercase name so the same person appearing on two
    // machines only shows up once in the register.
    const seen = new Map();
    for (const r of machRows) {
      const list = Array.isArray(r.persons) ? r.persons : [];
      for (const p of list) {
        const n = String((p && p.name) || '').trim();
        if (!n) continue;
        const key = n.toLowerCase();
        if (!seen.has(key)) seen.set(key, { name: n, name_ur: String((p && p.name_ur) || '').trim() });
      }
    }
    const operators = [...seen.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const notesRows = await sql`SELECT machine, sheets, hours, jobs, helper, remarks FROM daily_production_notes WHERE date = ${date} AND section = 'breaking'`;
    const noteByOp = new Map(notesRows.map(r => [r.machine, r]));
    // Custom operators added via the + button on the report. Listed
    // after the role-tagged roster so the regular crew stays at top.
    const existingNames = new Set(operators.map(o => o.name.toLowerCase()));
    const customOps = notesRows
      .map(r => r.machine)
      .filter(name => name && !existingNames.has(name.toLowerCase()))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(name => ({ name, name_ur: '' }));
    const allOperators = [...operators, ...customOps];

    const out = allOperators.map(op => {
      const n = noteByOp.get(op.name) || {};
      return {
        operator: op.name,
        operator_ur: op.name_ur || '',
        sheets:  n.sheets  || '',
        hours:   n.hours   || '',
        jobs:    n.jobs    || '',
        helper:  n.helper  || '',
        remarks: n.remarks || '',
        is_custom: !existingNames.has(op.name.toLowerCase()),
      };
    });
    res.json(out);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Daily Production register — Pasting section. Same byline-parsing
// pattern as Printing/Die. UNITS column is sum of pasted_cartons_qty
// per job per machine on the chosen date.
app.get('/api/reports/daily-production/pasting/:date', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const date = String(req.params.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    const { machines, acc } = await aggregateDailyProduction(sql, {
      date, sectionRole: 'paste', stageLabel: 'Pasting',
      sheetsKey: 'pasted_cartons_qty', wasteKey: 'pasting_waste_qty',
    });
    const notesRows = await sql`SELECT machine, hours, remarks, sheets, jobs, operators_text, waste FROM daily_production_notes WHERE date = ${date} AND section = 'pasting'`;
    const noteByMachine = new Map(notesRows.map(r => [r.machine, r]));
    const customMachines = notesRows.map(r => r.machine).filter(m => m && !machines.includes(m));
    const allMachines = [...machines, ...customMachines.sort()];
    const out = allMachines.map(m => {
      const row = acc.get(m);
      const note = noteByMachine.get(m) || {};
      const isCustom = !machines.includes(m);
      const operators = row ? [...row.operators].sort() : [];
      return {
        machine: m,
        // The helper calls it `sheets`; the Pasting register labels it Units.
        units: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : (row ? row.jobIds.size : 0),
        operators: isCustom ? (note.operators_text || '') : operators.join(', '),
        waste: isCustom ? (note.waste || '') : (row ? row.waste : 0),
        hours: note.hours || '',
        remarks: note.remarks || '',
        is_custom: isCustom,
      };
    });
    res.json(out);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Daily Production register — Die Cutting section. Same shape as the
// Printing endpoint but sheets come from die_cutting_sheets, the stage
// label is 'Die Cutting', and Make Ready + Settings join Hours/Remarks
// as admin-editable cells.
app.get('/api/reports/daily-production/die/:date', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const date = String(req.params.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    const { machines, acc } = await aggregateDailyProduction(sql, {
      date, sectionRole: 'diecut', stageLabel: 'Die Cutting',
      sheetsKey: 'die_cutting_sheets', wasteKey: 'die_cutting_waste',
    });
    const notesRows = await sql`SELECT machine, hours, make_ready, settings, remarks, sheets, jobs, operators_text, waste FROM daily_production_notes WHERE date = ${date} AND section = 'die'`;
    const noteByMachine = new Map(notesRows.map(r => [r.machine, r]));
    const customMachines = notesRows.map(r => r.machine).filter(m => m && !machines.includes(m));
    const allMachines = [...machines, ...customMachines.sort()];
    const out = allMachines.map(m => {
      const row = acc.get(m);
      const note = noteByMachine.get(m) || {};
      const isCustom = !machines.includes(m);
      const operators = row ? [...row.operators].sort() : [];
      return {
        machine: m,
        sheets: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : (row ? row.jobIds.size : 0),
        operators: isCustom ? (note.operators_text || '') : operators.join(', '),
        waste: isCustom ? (note.waste || '') : (row ? row.waste : 0),
        hours: note.hours || '',
        make_ready: note.make_ready || '',
        settings: note.settings || '',
        remarks: note.remarks || '',
        is_custom: isCustom,
      };
    });
    res.json(out);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// ── Production Report (date-range, per-machine + per-operator) ───────
// Aggregates across the full date range using the same log-byline +
// daily-production-notes sources the per-day Daily Production tabs use.
// Sheets / Jobs come from the auto-aggregation (job log entries within
// the date range); Hours come from the manager-entered notes (no other
// source records hours). Returns { byMachine: [...], byOperator: [...] }
// each row { sheets, hours, jobs } — frontend renders two tables with a
// summed footer.
async function aggregateProductionRange(sql, { from, to }) {
  // Per-(date, machine) and per-(date, operator) accumulators so the
  // frontend can either group by entity (summary view) or filter to one
  // entity and show its day-by-day rows in the range.
  const byMachineDaily = new Map();   // key: 'YYYY-MM-DD|machine'
  const byOperatorDaily = new Map();  // key: 'YYYY-MM-DD|operator'
  const ensureMD = (date, m) => {
    const k = date + '|' + m;
    if (!byMachineDaily.has(k)) byMachineDaily.set(k, { date, machine: m, sheets: 0, waste: 0, hours: 0, jobs: new Set() });
    return byMachineDaily.get(k);
  };
  const ensureOD = (date, op) => {
    const k = date + '|' + op;
    if (!byOperatorDaily.has(k)) byOperatorDaily.set(k, { date, operator: op, sheets: 0, waste: 0, hours: 0, jobs: new Set() });
    return byOperatorDaily.get(k);
  };
  // Stage label -> [sheetsKey, wasteKey] for particulars extraction.
  // Coatings handled separately via coatings_done JSONB.
  const STAGE_KEYS = {
    'Printing':    ['printed_sheets_qty', 'printed_waste_sheets'],
    'Die Cutting': ['die_cutting_sheets', 'die_cutting_waste'],
    'Pasting':     ['pasted_cartons_qty', 'pasting_waste_qty'],
  };
  // Per-date qty from a particulars sub-object — multi-pass entries[]
  // (per-date qty) preferred; single-quantity fallback for older jobs.
  const qtyForDate = (partKey, date) => {
    if (!partKey) return 0;
    if (Array.isArray(partKey.entries) && partKey.entries.length) {
      let n = 0;
      for (const e of partKey.entries) {
        if (e && e.date === date) {
          const v = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
          if (Number.isFinite(v)) n += v;
        }
      }
      return n;
    }
    if (partKey.quantity) {
      const v = parseInt(String(partKey.quantity).replace(/[^0-9-]/g, ''), 10);
      return Number.isFinite(v) ? v : 0;
    }
    return 0;
  };
  const jobs = await sql`SELECT id, particulars, log, coatings_done FROM jobs WHERE deleted_at IS NULL`;
  for (const job of jobs) {
    const log = Array.isArray(job.log) ? job.log : [];
    const part = (job.particulars && typeof job.particulars === 'object') ? job.particulars : {};
    for (const e of log) {
      if (!e || !e.by) continue;
      const eDate = logTimeToISODate(e.time);
      if (!eDate || eDate < from || eDate > to) continue;
      const stageLabel = parseByStage(e.by);
      const keys = STAGE_KEYS[stageLabel];
      if (!keys) continue;
      const [sheetsKey, wasteKey] = keys;
      const mc = parseByMachine(e.by);
      const op = parseByOperator(e.by);
      const sheets = qtyForDate(part[sheetsKey], eDate);
      const waste  = qtyForDate(part[wasteKey],  eDate);
      if (mc) { const r = ensureMD(eDate, mc); r.sheets += sheets; r.waste += waste; r.jobs.add(job.id); }
      if (op) { const r = ensureOD(eDate, op); r.sheets += sheets; r.waste += waste; r.jobs.add(job.id); }
    }
    // Coatings: source of truth is coatings_done. No sheet count — only
    // the waste_sheets number — so we contribute waste + jobs but not
    // sheets, to avoid double-counting.
    const coatings = Array.isArray(job.coatings_done) ? job.coatings_done : [];
    for (const c of coatings) {
      if (!c) continue;
      const cDate = isoTsToDate(c.done_at);
      if (!cDate || cDate < from || cDate > to) continue;
      const w = parseInt(String(c.waste_sheets || '').replace(/[^0-9-]/g, ''), 10) || 0;
      if (c.machine)       { const r = ensureMD(cDate, c.machine);       r.waste += w; r.jobs.add(job.id); }
      if (c.operator_name) { const r = ensureOD(cDate, c.operator_name); r.waste += w; r.jobs.add(job.id); }
    }
  }
  // Hours come from daily_production_notes only. Breaking's notes use
  // the `machine` column to hold the operator name (Breaking is
  // operator-keyed in the paper register), so that section contributes
  // to byOperator, never byMachine.
  const notes = await sql`SELECT date, machine, hours, operators_text, section FROM daily_production_notes WHERE date BETWEEN ${from} AND ${to}`;
  for (const n of notes) {
    const hrs = parseFloat(String(n.hours || '').replace(/[^0-9.]/g, '')) || 0;
    if (hrs <= 0) continue;
    const dateStr = n.date instanceof Date
      ? n.date.toISOString().slice(0, 10)
      : String(n.date).slice(0, 10);
    if (n.section === 'breaking') {
      if (n.machine) ensureOD(dateStr, n.machine).hours += hrs;
    } else {
      if (n.machine) ensureMD(dateStr, n.machine).hours += hrs;
      // operators_text is a comma/semicolon list. Split the hours
      // evenly so two operators on a 6-hour shift each get 3h credit.
      if (n.operators_text) {
        const ops = String(n.operators_text).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        if (ops.length) {
          const per = hrs / ops.length;
          for (const op of ops) ensureOD(dateStr, op).hours += per;
        }
      }
    }
  }
  const toMRow = r => ({ date: r.date, machine: r.machine, sheets: r.sheets, waste: r.waste, hours: Math.round(r.hours * 100) / 100, jobs: r.jobs.size });
  const toORow = r => ({ date: r.date, operator: r.operator, sheets: r.sheets, waste: r.waste, hours: Math.round(r.hours * 100) / 100, jobs: r.jobs.size });
  const byMachineDailyArr = [...byMachineDaily.values()]
    .map(toMRow)
    .filter(r => r.sheets > 0 || r.waste > 0 || r.hours > 0 || r.jobs > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.machine.localeCompare(b.machine));
  const byOperatorDailyArr = [...byOperatorDaily.values()]
    .map(toORow)
    .filter(r => r.sheets > 0 || r.waste > 0 || r.hours > 0 || r.jobs > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.operator.localeCompare(b.operator));
  return { byMachineDaily: byMachineDailyArr, byOperatorDaily: byOperatorDailyArr };
}

app.get('/api/reports/production', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const from = String(req.query.from || '').trim();
    const to   = String(req.query.to   || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    if (from > to) return res.status(400).json({ error: 'from must be on or before to' });
    const result = await aggregateProductionRange(sql, { from, to });
    res.json(result);
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Save Hours / Remarks for a single (date, section, machine) cell.
// Upsert so blanking a cell still leaves the row in place — admins can
// also clear by sending empty strings.
app.put('/api/reports/daily-production/:section/:date/:machine', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const date = String(req.params.date || '').trim();
    const section = String(req.params.section || '').trim().toLowerCase();
    const machine = String(req.params.machine || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    if (!section || !machine) return res.status(400).json({ error: 'Missing section or machine' });
    // Only admin / managers can edit register cells. Read is fine for
    // everyone with an account.
    const r = req.user && req.user.role;
    const okRoles = ['admin', 'production_manager', 'store_manager', 'user', 'stock'];
    if (!okRoles.includes(r)) return res.status(403).json({ error: 'Not allowed' });
    const hours      = (req.body.hours      == null) ? null : String(req.body.hours).trim();
    const remarks    = (req.body.remarks    == null) ? null : String(req.body.remarks).trim();
    const makeReady  = (req.body.make_ready == null) ? null : String(req.body.make_ready).trim();
    const settings   = (req.body.settings   == null) ? null : String(req.body.settings).trim();
    const blankets   = (req.body.blankets   == null) ? null : String(req.body.blankets).trim();
    const sheets     = (req.body.sheets     == null) ? null : String(req.body.sheets).trim();
    const jobs       = (req.body.jobs       == null) ? null : String(req.body.jobs).trim();
    const helper     = (req.body.helper     == null) ? null : String(req.body.helper).trim();
    const colors     = (req.body.colors     == null) ? null : String(req.body.colors).trim();
    const plates     = (req.body.plates     == null) ? null : String(req.body.plates).trim();
    const operatorsT = (req.body.operators_text == null) ? null : String(req.body.operators_text).trim();
    const waste      = (req.body.waste      == null) ? null : String(req.body.waste).trim();
    await sql`
      INSERT INTO daily_production_notes (date, section, machine, hours, remarks, make_ready, settings, blankets, sheets, jobs, helper, colors, plates, operators_text, waste)
      VALUES (${date}, ${section}, ${machine}, ${hours}, ${remarks}, ${makeReady}, ${settings}, ${blankets}, ${sheets}, ${jobs}, ${helper}, ${colors}, ${plates}, ${operatorsT}, ${waste})
      ON CONFLICT (date, section, machine) DO UPDATE
        SET hours          = EXCLUDED.hours,
            remarks        = EXCLUDED.remarks,
            make_ready     = EXCLUDED.make_ready,
            settings       = EXCLUDED.settings,
            blankets       = EXCLUDED.blankets,
            sheets         = EXCLUDED.sheets,
            jobs           = EXCLUDED.jobs,
            helper         = EXCLUDED.helper,
            colors         = EXCLUDED.colors,
            plates         = EXCLUDED.plates,
            operators_text = EXCLUDED.operators_text,
            waste          = EXCLUDED.waste
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// Remove a custom Daily Production row entirely (the × button next to
// a row added via the + button). Same role gate as the PUT endpoint.
app.delete('/api/reports/daily-production/:section/:date/:machine', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const date = String(req.params.date || '').trim();
    const section = String(req.params.section || '').trim().toLowerCase();
    const machine = String(req.params.machine || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });
    if (!section || !machine) return res.status(400).json({ error: 'Missing section or machine' });
    const r = req.user && req.user.role;
    const okRoles = ['admin', 'production_manager', 'store_manager', 'user', 'stock'];
    if (!okRoles.includes(r)) return res.status(403).json({ error: 'Not allowed' });
    await sql`DELETE FROM daily_production_notes WHERE date = ${date} AND section = ${section} AND machine = ${machine}`;
    res.json({ ok: true });
  } catch (err) {
    console.error(err); res.status(500).json({ error: err.message });
  }
});

// GET all jobs
app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    // The station only needs jobs that are still moving through stages, so
    // it passes ?active=1 to skip Delivered + soft-deleted rows. The full
    // list (used by Reports, History, etc.) loads everything as before.
    const deliveredIdx = STAGES.length - 1;
    const jobs = req.query.active
      ? await sql`SELECT * FROM jobs WHERE deleted_at IS NULL AND stage_index < ${deliveredIdx} ORDER BY id ASC`
      : await sql`SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY id ASC`;
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
// user / reversesTxId are optional metadata used by the History UI to show
// who entered the row and to link reversals to their originals.
async function applyInventoryChange(sql, { itemId, change, reason, jobId, notes, user, reversesTxId }) {
  if (!itemId || !change) return null;
  const userId    = user && user.id    ? user.id    : null;
  const userEmail = user && user.email ? user.email : null;
  const inserted = await sql`
    INSERT INTO inventory_transactions (item_id, change, reason, job_id, notes, user_id, user_email, reverses_tx_id)
    VALUES (${itemId}, ${change}, ${reason}, ${jobId || null}, ${notes || null}, ${userId}, ${userEmail}, ${reversesTxId || null})
    RETURNING id
  `;
  await sql`
    UPDATE inventory_items SET current_balance = current_balance + ${change} WHERE id = ${itemId}
  `;
  return inserted[0] ? inserted[0].id : null;
}

// Look up an offcut inventory item matching the source's paper_type, gsm,
// brand and the cut-leftover size, or create one if none exists. The match
// is intentionally strict (is_offcut=true) so we never accidentally top up
// fresh stock with reclaimed offcuts. Stores the source's size on first
// create as cut_from_size so the inventory list can show provenance. Does
// not update cut_from_size on subsequent matches — the original parent
// stays as the canonical origin label.
async function findOrCreateOffcutItem(sql, sourceItem, offcutSize) {
  const existing = await sql`
    SELECT * FROM inventory_items
    WHERE paper_type = ${sourceItem.paper_type}
      AND COALESCE(size,'')  = COALESCE(${offcutSize||null}, '')
      AND COALESCE(gsm,'')   = COALESCE(${sourceItem.gsm||null}, '')
      AND COALESCE(brand,'') = COALESCE(${sourceItem.brand||null},'')
      AND is_offcut = true
    LIMIT 1
  `;
  if (existing[0]) return existing[0];
  const inserted = await sql`
    INSERT INTO inventory_items (paper_type, size, gsm, brand, is_offcut, cut_from_size, reorder_threshold)
    VALUES (${sourceItem.paper_type}, ${offcutSize||null}, ${sourceItem.gsm||null}, ${sourceItem.brand||null}, true, ${sourceItem.size||null}, 0)
    RETURNING *
  `;
  return inserted[0];
}

// CREATE a job
app.post('/api/jobs', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id, cut_size, offcut_size } = req.body;
    // New jobs are created with issuance_status='pending'. Stock is NOT
    // deducted at creation time — a stock-role user (or admin) must call
    // POST /api/jobs/:id/issue-stock to deduct inventory and flip status.
    // cut_size/offcut_size describe an optional cut performed at issuance:
    // the source sheet is cut, the job uses cut_size, the leftover at
    // offcut_size is returned to inventory as a +N transaction.
    const result = await sql`
      INSERT INTO jobs (name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id, cut_size, offcut_size, issuance_status)
      VALUES (${name}, ${client}, ${jobcode||null}, ${ref||null}, ${dateissued||null}, ${deadline||null}, ${size||null}, ${ups||null}, ${sheets||null}, ${qty||null}, ${paper||null}, ${machine||null}, ${coatings||[]}, ${priority||'Normal'}, ${delqty||null}, ${cartonqty||null}, ${notes||null}, ${bno||null}, ${mfgdate||null}, ${expdate||null}, ${mrp||null}, ${JSON.stringify(particulars||{})}, ${inventory_item_id||null}, ${cut_size||null}, ${offcut_size||null}, 'pending')
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
app.put('/api/jobs/:id', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id, cut_size, offcut_size } = req.body;

    // Read prior values for inventory adjustment AND issuance status — if the
    // job is still 'pending' (stock never issued), edits don't touch inventory
    // at all. Once 'issued', edits auto-adjust the ledger using the same
    // packet-first formula as initial issuance.
    const prior = await sql`SELECT inventory_item_id, sheets, particulars, issuance_status, cut_size, offcut_size FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    const wasIssued  = prior[0]?.issuance_status === 'issued';
    const oldItemId  = prior[0]?.inventory_item_id || null;
    const newItemId  = inventory_item_id || null;
    const oldOffcutSize = prior[0]?.offcut_size || null;
    const newOffcutSize = offcut_size || null;
    // Look up paper types so the packet-multiplier matches what was actually
    // deducted at issuance time (and what the new state would deduct).
    let oldSourceItem = null;
    let newSourceItem = null;
    if (oldItemId) {
      const r = await sql`SELECT * FROM inventory_items WHERE id = ${oldItemId}`;
      oldSourceItem = r[0] || null;
    }
    if (newItemId) {
      const r = await sql`SELECT * FROM inventory_items WHERE id = ${newItemId}`;
      newSourceItem = r[0] || null;
    }
    const oldPaperType = oldSourceItem?.paper_type || '';
    const newPaperType = newSourceItem?.paper_type || '';
    const oldSheets = jobDeductionSheets({ paperType: oldPaperType, particulars: prior[0]?.particulars });
    const newSheets = jobDeductionSheets({ paperType: newPaperType, particulars });

    const result = await sql`
      UPDATE jobs SET
        name=${name}, client=${client}, jobcode=${jobcode||null}, ref=${ref||null},
        dateissued=${dateissued||null}, deadline=${deadline||null}, size=${size||null},
        ups=${ups||null}, sheets=${sheets||null}, qty=${qty||null}, paper=${paper||null},
        machine=${machine||null}, coatings=${coatings||[]}, priority=${priority||'Normal'},
        delqty=${delqty||null}, cartonqty=${cartonqty||null}, notes=${notes||null},
        bno=${bno||null}, mfgdate=${mfgdate||null}, expdate=${expdate||null}, mrp=${mrp||null},
        particulars=${JSON.stringify(particulars||{})}, inventory_item_id=${newItemId},
        cut_size=${cut_size||null}, offcut_size=${newOffcutSize}
      WHERE id=${id} RETURNING *
    `;
    const job = result[0];

    // Only adjust inventory if the job was already issued AND the linked
    // paper/board (inventory_item_id) actually changed. Per user rule:
    // editing a job card belongs to the job's own audit trail — the paper
    // ledger should stay untouched unless the paper item itself was swapped.
    // Changes to packets/qty/particulars alone do NOT trigger ledger writes.
    const paperItemChanged = (oldItemId !== newItemId);
    if (wasIssued && paperItemChanged) {
      if (oldItemId && oldSheets > 0) {
        await applyInventoryChange(sql, {
          itemId: oldItemId,
          change: +oldSheets,
          reason: 'job-edit-revert',
          jobId: job.id,
          notes: `Edit on Job E-${job.id}: returned previous ${oldSheets} sheets`,
          user: req.user,
        });
        // Revert the offcut +N too — compensating transaction keeps the
        // ledger append-only. We re-apply the new offcut below if the new
        // state also has a cut.
        if (oldSourceItem && oldOffcutSize) {
          const oldOffcutItem = await findOrCreateOffcutItem(sql, oldSourceItem, oldOffcutSize);
          await applyInventoryChange(sql, {
            itemId: oldOffcutItem.id,
            change: -oldSheets,
            reason: 'job-edit-revert',
            jobId: job.id,
            notes: `Edit on Job E-${job.id}: removed previous ${oldSheets} sheets of ${oldOffcutSize} offcut`,
            user: req.user,
          });
        }
      }
      if (newItemId && newSheets > 0) {
        await applyInventoryChange(sql, {
          itemId: newItemId,
          change: -newSheets,
          reason: 'job-edit-apply',
          jobId: job.id,
          notes: `Edit on Job E-${job.id}: consumed ${newSheets} sheets`,
          user: req.user,
        });
        // Re-apply the offcut yield for the new state, if cut spec is set.
        if (newSourceItem && newOffcutSize) {
          const newOffcutItem = await findOrCreateOffcutItem(sql, newSourceItem, newOffcutSize);
          await applyInventoryChange(sql, {
            itemId: newOffcutItem.id,
            change: +newSheets,
            reason: 'job-edit-apply',
            jobId: job.id,
            notes: `Edit on Job E-${job.id}: added ${newSheets} sheets of ${newOffcutSize} offcut`,
            user: req.user,
          });
        }
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
// 'issued'. Admin, stock, and user roles can all issue (CEO is blocked
// Bump print_count + last_printed_at when someone clicks Print on a job
// card in the UI. Allows any signed-in user (CEO included — they may
// well want to print a card for an exec review). Returns the updated
// row so the client can refresh the print-dot indicator inline.
app.post('/api/jobs/:id/printed', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`
      UPDATE jobs
         SET print_count = COALESCE(print_count, 0) + 1,
             last_printed_at = NOW()
       WHERE id = ${id} AND deleted_at IS NULL
       RETURNING id, print_count, last_printed_at
    `;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// upstream by requireWriteUser). The stock-keeper-only restriction was
// relaxed once the workflow expanded so any non-readonly role can act.
app.post('/api/jobs/:id/issue-stock', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT * FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status === 'issued') {
      return res.status(400).json({ error: 'Stock already issued for this job' });
    }
    if (!job.inventory_item_id) {
      return res.status(400).json({ error: 'Job has no paper assigned — nothing to issue' });
    }
    const inv = await sql`SELECT * FROM inventory_items WHERE id = ${job.inventory_item_id}`;
    const sourceItem = inv[0];
    const paperType = sourceItem?.paper_type || '';
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
      user: req.user,
    });
    // Cut workflow: if the job specifies an offcut size, find-or-create the
    // matching offcut item and return the leftover to stock. Per source
    // sheet, exactly one offcut is produced.
    let cutSummary = '';
    if (job.cut_size && job.offcut_size && sourceItem) {
      const offcutItem = await findOrCreateOffcutItem(sql, sourceItem, job.offcut_size);
      await applyInventoryChange(sql, {
        itemId: offcutItem.id,
        change: +sheetsUsed,
        reason: 'job-offcut',
        jobId: job.id,
        notes: `Job E-${job.id}: ${sheetsUsed} sheets of ${job.offcut_size} offcut returned to stock`,
        user: req.user,
      });
      cutSummary = ` · cut to ${job.cut_size}, ${sheetsUsed} sheets of ${job.offcut_size} offcut returned to stock`;
    }
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
      summary: `Issued ${sheetsUsed} sheets for Job E-${id}: ${job.name}${cutSummary}`,
    });
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reverse a previously-issued stock issuance: refunds the consumed sheets
// back to inventory, undoes the offcut return if there was one, and flips
// the job back to issuance_status='pending'. Guarded to stage 0 because
// once the operators have started working a card the sheets have probably
// already left the storeroom — refunding inventory then would lie about
// what's actually on the shelf.
app.post('/api/jobs/:id/reverse-issuance', requireWriteUser, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT * FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status !== 'issued') {
      return res.status(400).json({ error: 'Stock was not issued for this job' });
    }
    if ((job.stage_index || 0) > 0) {
      return res.status(400).json({ error: 'Cannot reverse — job has already moved past the first stage' });
    }
    // Refund the consumed sheets if the job had an inventory item linked.
    if (job.inventory_item_id) {
      const inv = await sql`SELECT * FROM inventory_items WHERE id = ${job.inventory_item_id}`;
      const sourceItem = inv[0];
      const paperType = sourceItem?.paper_type || '';
      const sheetsUsed = jobDeductionSheets({ paperType, particulars: job.particulars });
      if (sheetsUsed > 0) {
        await applyInventoryChange(sql, {
          itemId: job.inventory_item_id,
          change: +sheetsUsed,
          reason: 'job-issuance-reversed',
          jobId: job.id,
          notes: `Job E-${job.id}${job.jobcode ? ' · ' + job.jobcode : ''}: issuance reversed by ${req.user.email} — ${sheetsUsed} sheets returned`,
          user: req.user,
        });
        // If the original issuance created an offcut return, undo it too.
        if (job.cut_size && job.offcut_size && sourceItem) {
          const offcutItem = await findOrCreateOffcutItem(sql, sourceItem, job.offcut_size);
          await applyInventoryChange(sql, {
            itemId: offcutItem.id,
            change: -sheetsUsed,
            reason: 'job-issuance-reversed',
            jobId: job.id,
            notes: `Job E-${job.id}: offcut return reversed by ${req.user.email} — ${sheetsUsed} sheets pulled back from ${job.offcut_size} offcuts`,
            user: req.user,
          });
        }
      }
    }
    const updated = await sql`
      UPDATE jobs
         SET issuance_status = 'pending',
             issued_at = NULL,
             issued_by_id = NULL
       WHERE id = ${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.reverse_issuance',
      entityType: 'job',
      entityId: id,
      summary: `Reversed stock issuance for Job E-${id}: ${job.name}`,
    });
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a job — admin only. SOFT delete: flips deleted_at so the row stays
// recoverable from the Trash page for 30 days. Inventory ledger entries are
// unaffected (their FK is ON DELETE SET NULL and we don't actually delete).
app.delete('/api/jobs/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const by  = req.user?.email || 'unknown';
    const updated = await sql`
      UPDATE jobs SET deleted_at = NOW(), deleted_by = ${by}
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING *
    `;
    if (!updated.length) return res.status(404).json({ error: 'Job not found' });
    await logAudit(sql, req, { action: 'job.delete', entityType: 'job', entityId: id, summary: `Moved Job E-${id} to Archive: ${updated[0].name}` });
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
    // Also attach the most recent stock-in and stock-out per item so the
    // inventory cards can show small green "+N" and red "-N" pills at a
    // glance. Subqueries are scoped to one item_id each (the per-item index
    // makes them cheap) and return NULL for items that have never moved.
    const items = await sql`
      SELECT i.*,
        (SELECT change     FROM inventory_transactions
           WHERE item_id = i.id AND change > 0
           ORDER BY created_at DESC LIMIT 1) AS latest_in_sheets,
        (SELECT created_at FROM inventory_transactions
           WHERE item_id = i.id AND change > 0
           ORDER BY created_at DESC LIMIT 1) AS latest_in_at,
        (SELECT change     FROM inventory_transactions
           WHERE item_id = i.id AND change < 0
           ORDER BY created_at DESC LIMIT 1) AS latest_out_sheets,
        (SELECT created_at FROM inventory_transactions
           WHERE item_id = i.id AND change < 0
           ORDER BY created_at DESC LIMIT 1) AS latest_out_at,
        -- Most recent balance correction (reason='correction'). Frontend
        -- shows a small red dot for 24h after this timestamp so anyone
        -- viewing the item knows the current balance reflects a recent
        -- manual adjustment, not just delivery/issuance flow.
        (SELECT created_at FROM inventory_transactions
           WHERE item_id = i.id AND reason = 'correction'
           ORDER BY created_at DESC LIMIT 1) AS latest_correction_at
      FROM inventory_items i
      ORDER BY paper_type, size, gsm, brand
    `;
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// CREATE an inventory item. Initial balance, if provided, is recorded as an
// "opening-balance" ledger row so the audit trail is complete from day one.
app.post('/api/inventory', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    let { paper_type, size, gsm, brand, reorder_threshold, opening_balance, opening_notes, supplier } = req.body;
    if (!paper_type) return res.status(400).json({ error: 'paper_type is required' });
    // Brand is stored uppercase for consistency — Ningbo / ningbo / NINGBO
    // all save as NINGBO. The case-insensitive duplicate check below still
    // catches dupes against the existing data even if old rows aren't
    // yet uppercase.
    if (brand) brand = String(brand).trim().toUpperCase();
    const opening = parseSheets(opening_balance);
    const label = `${paper_type}${size?' '+size:''}${gsm?' '+gsm+'gsm':''}${brand?' · '+brand:''}`;

    // Hard duplicate check: same (paper_type, size, gsm, brand) — compared
    // case-insensitively and trimmed, so "ningbo" / "Ningbo" / "NINGBO" all
    // count as the same brand. Refuse the add with a 409 instead of merging.
    // The user uses "+ Stock" on the existing card to top up instead.
    //
    // Only blocks against FRESH-STOCK rows (is_offcut = false). Offcut items
    // are managed by the cut-sheets workflow at issuance time and may legitimately
    // share dimensions with fresh stock — they're tracked as separate lines.
    const existing = await sql`
      SELECT * FROM inventory_items
      WHERE is_offcut = false
        AND lower(trim(paper_type))          = lower(trim(${paper_type}))
        AND lower(trim(COALESCE(size,'')))   = lower(trim(COALESCE(${size||null},  '')))
        AND lower(trim(COALESCE(gsm,'')))    = lower(trim(COALESCE(${gsm||null},   '')))
        AND lower(trim(COALESCE(brand,'')))  = lower(trim(COALESCE(${brand||null}, '')))
      LIMIT 1
    `;
    if (existing[0]) {
      const item = existing[0];
      const existingLabel = `${item.paper_type}${item.size?' '+item.size:''}${item.gsm?' '+item.gsm+'gsm':''}${item.brand?' · '+item.brand:''}`;
      return res.status(409).json({
        error: `This paper item already exists: ${existingLabel}. Use "+ Stock" on the existing card to add more.`,
        existing_item: item,
      });
    }

    // No match — fresh item.
    const inserted = await sql`
      INSERT INTO inventory_items (paper_type, size, gsm, brand, reorder_threshold, supplier)
      VALUES (${paper_type}, ${size||null}, ${gsm||null}, ${brand||null}, ${reorder_threshold||0}, ${supplier||null})
      RETURNING *
    `;
    const item = inserted[0];
    if (opening > 0) {
      await applyInventoryChange(sql, {
        itemId: item.id,
        change: +opening,
        reason: 'opening-balance',
        jobId: null,
        notes: opening_notes || 'Opening balance',
        user: req.user,
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
app.put('/api/inventory/:id', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    let { paper_type, size, gsm, brand, reorder_threshold, current_balance, correction_notes, supplier, expected_balance_sheets } = req.body;
    // Same uppercase normalization as POST — keeps brand storage consistent
    // (Ningbo / ningbo / NINGBO all save as NINGBO).
    if (brand) brand = String(brand).trim().toUpperCase();

    // Snapshot the pre-edit balance — needed so an admin-only balance
    // correction below can compute the delta.
    const before = await sql`SELECT current_balance FROM inventory_items WHERE id=${id}`;
    if (!before[0]) return res.status(404).json({ error: 'Item not found' });
    const oldBalance = before[0].current_balance || 0;

    // Concurrency check: when the frontend submits a balance correction, it
    // also sends what it BELIEVED the current balance was at the moment the
    // user opened the Edit form. If that's drifted from the DB (because
    // someone received an import, issued stock for a job, or another tab
    // edited the same item), reject — the delta would be computed against
    // the wrong baseline and silently corrupt the running balance. The
    // browser then prompts the user to re-open with fresh numbers.
    if (expected_balance_sheets !== undefined && expected_balance_sheets !== null && expected_balance_sheets !== '') {
      const expected = parseInt(expected_balance_sheets, 10);
      if (Number.isFinite(expected) && expected !== oldBalance) {
        return res.status(409).json({
          error: `Stock balance changed since you opened this form (had ${expected.toLocaleString()} sheets, now ${oldBalance.toLocaleString()}). Refresh and try again.`,
        });
      }
    }

    const result = await sql`
      UPDATE inventory_items SET
        paper_type=${paper_type}, size=${size||null}, gsm=${gsm||null},
        brand=${brand||null}, reorder_threshold=${reorder_threshold||0},
        supplier=${supplier||null}
      WHERE id=${id} RETURNING *
    `;
    const item = result[0];

    // Direct balance correction — any writeable role (admin, stock, user)
    // can adjust the balance. We write a transaction with reason='correction'
    // so the per-item History modal still shows the change with the editor's
    // identity (full audit trail), but the aggregate movement report
    // (Stock In / Stock Out / Dashboard) filters this reason out so it
    // doesn't pollute the in/out totals. CEO is blocked upstream by
    // requireWriteUser, so they never reach this code path.
    if (req.user && current_balance !== undefined && current_balance !== null && current_balance !== '') {
      const newBalance = parseInt(current_balance, 10);
      if (Number.isFinite(newBalance) && newBalance !== oldBalance) {
        const delta = newBalance - oldBalance;
        await applyInventoryChange(sql, {
          itemId: parseInt(id, 10),
          change: delta,
          reason: 'correction',
          jobId: null,
          notes: correction_notes || 'Balance edit from inventory form',
          user: req.user,
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

// Admin-only: clear a brand or supplier value across the whole inventory.
// Used by the "Manage Brands / Manage Suppliers" cleanup UI to fix typo
// duplicates (e.g. "century" vs "Century") without per-item editing. The
// items themselves stay — just the brand/supplier column is NULLed where it
// matched. Doesn't touch paper_type (required column, can't be NULLed).
// Hide a dropdown value (brand or supplier) — adds it to dropdown_hidden so
// it won't be suggested in new-item forms or the Manage UI, but DOES NOT
// touch existing inventory items. They keep their brand/supplier text so
// historical stock records stay intact. requireWriteUser (admin/user/stock).
// Admin can still undo via the GET-list + unhide endpoint below.
app.delete('/api/inventory/dropdown/:field/:value', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const field = req.params.field;
    const value = req.params.value;
    if (!['brand', 'supplier'].includes(field)) {
      return res.status(400).json({ error: 'Field must be brand or supplier' });
    }
    await sql`
      INSERT INTO dropdown_hidden (field, value, hidden_by)
      VALUES (${field}, ${value}, ${req.user.email})
      ON CONFLICT (field, value) DO NOTHING
    `;
    await logAudit(sql, req, {
      action: 'inventory.hide-dropdown',
      summary: `Hid ${field} "${value}" from dropdown suggestions (existing items unchanged)`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List all hidden dropdown values. Used client-side to filter the brand /
// supplier suggestions in inventory forms and the Manage UI.
app.get('/api/inventory/dropdown-hidden', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`SELECT field, value FROM dropdown_hidden ORDER BY field, value`;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Un-hide a dropdown value — admin only, in case someone hides one by
// mistake. Pulls it back into the suggestion list.
app.post('/api/inventory/dropdown/:field/:value/unhide', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const field = req.params.field;
    const value = req.params.value;
    await sql`DELETE FROM dropdown_hidden WHERE field=${field} AND value=${value}`;
    await logAudit(sql, req, {
      action: 'inventory.unhide-dropdown',
      summary: `Restored ${field} "${value}" to dropdown suggestions`,
    });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE an inventory item. Admin only. Refused if any pending-issuance
// jobs still reference this item (their stock hasn't been deducted yet, so
// losing the link would orphan them). Issued/in-progress/delivered jobs are
// fine to lose the live link — their deductions already happened. Cascades
// the full transaction history (intentional — admin saw the warning).
app.delete('/api/inventory/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const itemId = parseInt(id, 10);
    if (!Number.isFinite(itemId)) return res.status(400).json({ error: 'Invalid id' });

    // Block delete if any still-pending jobs depend on this item. Trashed
    // jobs don't block — they're conceptually gone.
    const blockers = await sql`
      SELECT id, jobcode, name FROM jobs
      WHERE inventory_item_id = ${itemId} AND issuance_status = 'pending'
        AND deleted_at IS NULL
      ORDER BY id
    `;
    if (blockers.length > 0) {
      const list = blockers.map(j => `E-${j.id}${j.jobcode ? ' ('+j.jobcode+')' : ''}`).join(', ');
      return res.status(409).json({
        error: `Cannot delete — used by ${blockers.length} pending job${blockers.length>1?'s':''}: ${list}. Issue stock for those jobs first or delete them.`,
        pending_jobs: blockers,
      });
    }

    // Snapshot for audit log before delete.
    const existing = await sql`SELECT * FROM inventory_items WHERE id = ${itemId}`;
    if (!existing[0]) return res.status(404).json({ error: 'Item not found' });
    const it = existing[0];
    const label = `${it.paper_type}${it.size?' '+it.size:''}${it.gsm?' '+it.gsm+'gsm':''}${it.brand?' · '+it.brand:''}`;

    // Clear the link on any non-pending jobs that still pointed at this item
    // (no FK on jobs.inventory_item_id, so we tidy up manually). Their
    // historical paper data stays in the jobs row, just the live link is gone.
    await sql`UPDATE jobs SET inventory_item_id = NULL WHERE inventory_item_id = ${itemId}`;
    // Cascades inventory_transactions; sets inventory_imports.inventory_item_id NULL.
    await sql`DELETE FROM inventory_items WHERE id = ${itemId}`;

    await logAudit(sql, req, {
      action: 'inventory.delete',
      entityType: 'inventory',
      entityId: itemId,
      summary: `Deleted paper item: ${label} (balance was ${it.current_balance||0} sheets)`,
    });

    res.json({ ok: true, deleted_id: itemId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ADD/ADJUST stock — used for deliveries and manual corrections.
app.post('/api/inventory/:id/transactions', requireInventoryWriter, async (req, res) => {
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
      user: req.user,
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

// REVERSE any inventory transaction — stock-in or job-driven stock-out.
// Creates an opposite ledger row with reason='correction' that nets out
// the original. Movement reports filter out 'correction' so the day's
// totals stay clean.
//
// Permissions:
//   • Admin can reverse any reversible transaction, any time.
//   • Stock keeper / writer can only reverse entries from the last 24 hours.
//   • CEO can't reach this endpoint at all (requireWriteUser blocks them).
//
// Refused if:
//   • The transaction has already been reversed (no double-reversals)
//   • The transaction is itself a reversal (no chain reversals)
//   • The reason isn't one of the reversible kinds (delivery, job-consumed,
//     job-edit-apply, job-edit-revert, job-offcut, adjustment)
app.post('/api/inventory/transactions/:id/reverse', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const txId = parseInt(req.params.id, 10);
    if (!Number.isFinite(txId)) return res.status(400).json({ error: 'Invalid id' });

    const rows = await sql`SELECT * FROM inventory_transactions WHERE id = ${txId} LIMIT 1`;
    if (!rows[0]) return res.status(404).json({ error: 'Transaction not found' });
    const tx = rows[0];

    // Reasons we never reverse — these are bookkeeping rows that don't
    // represent a real, undo-able event. 'correction' is itself a reversal
    // class; reversing one would create an infinite loop of corrections.
    const REVERSIBLE_REASONS = new Set([
      'delivery', 'adjustment', 'opening',
      'job-consumed', 'job-edit-apply', 'job-edit-revert', 'job-offcut',
      'job-issuance-reversed',
    ]);
    if (!REVERSIBLE_REASONS.has(tx.reason)) {
      return res.status(400).json({ error: `Cannot reverse a '${tx.reason}' entry.` });
    }
    if (tx.reverses_tx_id) {
      return res.status(400).json({ error: 'This row is itself a reversal — cannot reverse a reversal.' });
    }
    // Is the original already reversed?
    const existingReversal = await sql`SELECT id FROM inventory_transactions WHERE reverses_tx_id = ${txId} LIMIT 1`;
    if (existingReversal[0]) {
      return res.status(409).json({ error: 'This entry has already been reversed.' });
    }

    // 24-hour window applies to everyone except admin. Stock keepers and
    // regular users can self-correct recent mistakes; anything older
    // needs an admin to keep the audit trail intact.
    if (req.user.role !== 'admin') {
      // Calendar-day rule: reversible only if created on today's date
      // (00:00–23:59 of the same day), not rolling 24 hours.
      const t = new Date(tx.created_at);
      const n = new Date();
      const sameDay = t.getFullYear() === n.getFullYear() &&
                      t.getMonth()    === n.getMonth() &&
                      t.getDate()     === n.getDate();
      if (!sameDay) {
        return res.status(403).json({ error: 'You can only reverse entries created today. Ask an admin to reverse older entries.' });
      }
    }

    const itemRows = await sql`SELECT * FROM inventory_items WHERE id = ${tx.item_id} LIMIT 1`;
    const item     = itemRows[0];
    const label    = item ? `${item.paper_type}${item.size?' '+item.size:''}${item.gsm?' '+item.gsm+'gsm':''}${item.brand?' · '+item.brand:''}` : `item ${tx.item_id}`;
    const origNote = tx.notes ? ` (orig note: "${tx.notes}")` : '';
    const origBy   = tx.user_email ? ` entered by ${tx.user_email}` : '';
    // Format the original timestamp as dd/mm/yyyy hh:mm for the audit note —
    // matches the app-wide dd/mm/yyyy display convention.
    const _d        = new Date(tx.created_at);
    const _pad      = (n) => String(n).padStart(2, '0');
    const _stamp    = isNaN(_d) ? String(tx.created_at) :
      `${_pad(_d.getDate())}/${_pad(_d.getMonth()+1)}/${_d.getFullYear()} ${_pad(_d.getHours())}:${_pad(_d.getMinutes())}`;
    const note     = `Reversal of TX #${tx.id}${origBy} on ${_stamp}${origNote}`;

    const newTxId = await applyInventoryChange(sql, {
      itemId: tx.item_id,
      change: -tx.change,            // exact opposite of original
      reason: 'correction',          // filtered out of Stock In / Stock Out reports
      jobId: null,
      notes: note,
      user: req.user,
      reversesTxId: tx.id,
    });

    // If we just reversed a 'job-consumed' row and the linked job is still
    // sitting at the first stage with issuance_status='issued', flip the
    // job back to Pending Stock so the store-keeper queue picks it up
    // again. If the job has already moved past CTP we leave its state
    // alone — refunding inventory while the floor is mid-flight is a
    // judgment call the user just made; we don't second-guess them by
    // also rewriting the job's progress.
    let jobReverted = false;
    if (tx.reason === 'job-consumed' && tx.job_id) {
      const jobRows = await sql`SELECT * FROM jobs WHERE id = ${tx.job_id} AND deleted_at IS NULL`;
      const job = jobRows[0];
      if (job && job.issuance_status === 'issued' && (job.stage_index || 0) === 0) {
        await sql`
          UPDATE jobs
             SET issuance_status = 'pending',
                 issued_at = NULL,
                 issued_by_id = NULL
           WHERE id = ${tx.job_id}
        `;
        jobReverted = true;
      }
    }

    await logAudit(sql, req, {
      action: 'inventory.reverse',
      entityType: 'inventory',
      entityId: tx.item_id,
      summary: `Reversed TX #${tx.id} (${tx.change > 0 ? '+' : ''}${tx.change} sheets) on ${label}${jobReverted ? ` · Job E-${tx.job_id} flipped back to Pending Stock` : ''}`,
    });

    res.json({ ok: true, reversal_tx_id: newTxId, original_tx_id: tx.id, job_reverted: jobReverted });
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
        AND t.reason NOT IN ('correction', 'job-edit-revert', 'job-edit-apply')
        -- Hide reversal rows and the original tx they undo. A mistake that
        -- was reversed shouldn't inflate Stock In/Out totals — the pair
        -- nets to zero, so both sides drop out of the movement report.
        AND t.reverses_tx_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM inventory_transactions r WHERE r.reverses_tx_id = t.id
        )
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
    // has_been_reversed: a later tx pointing back at this one. Used by the
    // History UI to hide the Reverse button on rows that have already been
    // undone (prevents accidental double-reversals).
    const txs = await sql`
      SELECT t.*, j.name AS job_name, j.jobcode AS job_code,
        EXISTS(SELECT 1 FROM inventory_transactions r WHERE r.reverses_tx_id = t.id) AS has_been_reversed
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
      WHERE deleted_at IS NULL
        AND (${status}::text IS NULL OR status = ${status})
      ORDER BY (status = 'pending') DESC, expected_arrival NULLS LAST, id DESC
    `;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CREATE an import. Auto-links to a matching inventory_item if one exists
// (same paper_type + size + gsm + brand). No match → leave the link NULL;
// receiving the import later will create the item.
app.post('/api/imports', requireInventoryWriter, async (req, res) => {
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
app.put('/api/imports/:id', requireInventoryWriter, async (req, res) => {
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
      WHERE id=${id} AND deleted_at IS NULL RETURNING *
    `;
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CANCEL an import (status → cancelled, no inventory change).
app.post('/api/imports/:id/cancel', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const rows = await sql`
      UPDATE inventory_imports SET status='cancelled' WHERE id=${id} AND status='pending' AND deleted_at IS NULL RETURNING *
    `;
    if (!rows.length) return res.status(400).json({ error: 'Only pending imports can be cancelled' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Trash (soft-deleted jobs + imports) ─────────────────────
// Items soft-deleted by the bulk "Delete from History" actions live here for
// 30 days, then auto-purge. Lazy purge model: every GET /api/trash runs a
// cleanup first so we don't need cron on Vercel.
const TRASH_RETENTION_DAYS = 30;

// Run the auto-purge for both tables. Cheap (indexed on deleted_at) and
// idempotent — safe to call on every list request.
async function purgeExpiredTrash(sql) {
  await sql`DELETE FROM jobs              WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - (${TRASH_RETENTION_DAYS} || ' days')::interval`;
  await sql`DELETE FROM inventory_imports WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - (${TRASH_RETENTION_DAYS} || ' days')::interval`;
}

// LIST everything in trash. Returns { jobs, imports, retention_days } so the
// frontend can show "Auto-purges in N days" per row. Open to admin AND ceo
// (CEO is read-only — the write endpoints below still require admin).
// Anyone signed in can view the Trash bin (admin, user, stock, ceo). Restore
// and Empty stay admin-only — see those endpoints below.
app.get('/api/trash', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    await purgeExpiredTrash(sql);
    const jobsRows = await sql`
      SELECT id, name, jobcode, client, stage_index, deleted_at, deleted_by, created_at
      FROM jobs WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
    `;
    const importsRows = await sql`
      SELECT id, paper_type, size, gsm, brand, packets, supplier, status, deleted_at, deleted_by, booked_date, expected_arrival
      FROM inventory_imports WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
    `;
    res.json({ jobs: jobsRows, imports: importsRows, retention_days: TRASH_RETENTION_DAYS });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// RESTORE one row from trash. Body: { type: 'job'|'import', id: 123 }.
app.post('/api/trash/restore', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { type, id } = req.body || {};
    const rowId = parseInt(id, 10);
    if (!Number.isFinite(rowId)) return res.status(400).json({ error: 'Invalid id' });
    if (type === 'job') {
      const updated = await sql`UPDATE jobs SET deleted_at=NULL, deleted_by=NULL WHERE id=${rowId} AND deleted_at IS NOT NULL RETURNING id, name`;
      if (!updated.length) return res.status(404).json({ error: 'Job not in archive' });
      await logAudit(sql, req, { action: 'job.restore', entityType: 'job', entityId: rowId, summary: `Restored Job E-${rowId}: ${updated[0].name}` });
      return res.json({ ok: true });
    }
    if (type === 'import') {
      const updated = await sql`UPDATE inventory_imports SET deleted_at=NULL, deleted_by=NULL WHERE id=${rowId} AND deleted_at IS NOT NULL RETURNING id, paper_type, status`;
      if (!updated.length) return res.status(404).json({ error: 'Import not in archive' });
      await logAudit(sql, req, { action: 'import.restore', entityType: 'import', entityId: rowId, summary: `Restored ${updated[0].status} import #${rowId}: ${updated[0].paper_type}` });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'type must be "job" or "import"' });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// PERMANENT delete from trash. Same shape as restore. Hard-deletes the row.
app.delete('/api/trash/:type/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const type = req.params.type;
    const rowId = parseInt(req.params.id, 10);
    if (!Number.isFinite(rowId)) return res.status(400).json({ error: 'Invalid id' });
    if (type === 'job') {
      const deleted = await sql`DELETE FROM jobs WHERE id=${rowId} AND deleted_at IS NOT NULL RETURNING id, name`;
      if (!deleted.length) return res.status(404).json({ error: 'Job not in archive' });
      await logAudit(sql, req, { action: 'job.purge', entityType: 'job', entityId: rowId, summary: `Permanently deleted Job E-${rowId}: ${deleted[0].name}` });
      return res.json({ ok: true });
    }
    if (type === 'import') {
      const deleted = await sql`DELETE FROM inventory_imports WHERE id=${rowId} AND deleted_at IS NOT NULL RETURNING id, paper_type`;
      if (!deleted.length) return res.status(404).json({ error: 'Import not in archive' });
      await logAudit(sql, req, { action: 'import.purge', entityType: 'import', entityId: rowId, summary: `Permanently deleted import #${rowId}: ${deleted[0].paper_type}` });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'type must be "job" or "import"' });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// EMPTY trash entirely (admin "Empty Trash" button). Hard-deletes everything
// currently in trash regardless of age.
app.post('/api/trash/empty', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const jobsDel    = await sql`DELETE FROM jobs              WHERE deleted_at IS NOT NULL RETURNING id`;
    const importsDel = await sql`DELETE FROM inventory_imports WHERE deleted_at IS NOT NULL RETURNING id`;
    await logAudit(sql, req, {
      action: 'trash.empty',
      entityType: 'system',
      entityId: 0,
      summary: `Emptied Archive: ${jobsDel.length} job${jobsDel.length===1?'':'s'} + ${importsDel.length} import${importsDel.length===1?'':'s'} permanently deleted`,
    });
    res.json({ ok: true, jobs: jobsDel.length, imports: importsDel.length });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE an inventory transaction row from history (admin only). Pure archival
// cleanup — does NOT touch current_balance, since the row already happened and
// its effect is baked into the running balance. Intended for wiping old rows
// after months/years. To actually undo a row's effect on stock, use the
// per-row Reverse on the inventory History modal instead (which posts a
// proper correction entry).
app.delete('/api/inventory/transactions/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const tx = (await sql`SELECT id, item_id, change, reason FROM inventory_transactions WHERE id=${id}`)[0];
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    // reverses_tx_id has ON DELETE SET NULL so reversal rows pointing at this
    // one (if any) survive — they just lose their back-link. Acceptable for
    // archival purposes.
    await sql`DELETE FROM inventory_transactions WHERE id=${id}`;
    await logAudit(sql, req, {
      action: 'inventory.tx.delete',
      entityType: 'inventory_item',
      entityId: tx.item_id,
      summary: `Deleted tx #${id} from history (${tx.change > 0 ? '+' : ''}${tx.change} sheets · ${tx.reason || 'no reason'}) — balance unchanged`,
    });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE an import row entirely (admin only). Used by the bulk Delete action
// on the Imports page. Refuses to delete a "received" row because that would
// orphan the stock-in transaction it created. Pending / Cancelled are fine to
// hard-delete since they never touched inventory.
app.delete('/api/imports/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const imp = (await sql`SELECT * FROM inventory_imports WHERE id=${id} AND deleted_at IS NULL`)[0];
    if (!imp) return res.status(404).json({ error: 'Import not found' });
    if (imp.status === 'received') {
      return res.status(400).json({ error: 'Cannot delete a received import — reverse the stock-in entry first.' });
    }
    // SOFT delete: flip deleted_at. Recoverable from the Trash page for 30
    // days; auto-purged after.
    const by = req.user?.email || 'unknown';
    await sql`UPDATE inventory_imports SET deleted_at = NOW(), deleted_by = ${by} WHERE id=${id}`;
    const label = [imp.paper_type, imp.size, imp.gsm && (imp.gsm + 'gsm'), imp.brand].filter(Boolean).join(' · ');
    await logAudit(sql, req, {
      action: 'import.delete',
      entityType: 'import',
      entityId: parseInt(id, 10),
      summary: `Moved ${imp.status} import #${imp.id} to Archive: ${label || '(no details)'} · ${imp.packets} packets · ${imp.supplier || 'no supplier'}`,
    });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// RECEIVE an import — converts it to a real stock-in transaction. If the
// import has no linked inventory_item, we create one on the fly using the
// import's paper_type/size/gsm/brand. The body may override `packets` (e.g.,
// when the actual delivery differs from the booked quantity).
app.post('/api/imports/:id/receive', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const overridePackets = parseFloat(req.body?.packets);
    const imp = (await sql`SELECT * FROM inventory_imports WHERE id=${id} AND deleted_at IS NULL`)[0];
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
      user: req.user,
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
app.patch('/api/jobs/:id/stage', requireJobsWriter, async (req, res) => {
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

// Station update — a shop-floor operator advances a job and/or records that
// stage's production numbers, identified by a 4-digit PIN. PIN is verified
// server-side; the operator must be assigned to the job's current stage.
app.post('/api/jobs/:id/station-update', requireStationUser, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const pin = String(req.body.pin || '').trim();
    const particularsPatch = req.body.particulars_patch && typeof req.body.particulars_patch === 'object'
      ? req.body.particulars_patch : {};
    const advance = req.body.advance === true;
    // Optional skip target. When the operator uses 'Skip to stage', they
    // pick a downstream stage index; we mark every stage between current
    // and target as done and jump straight there. Must be > curStage and
    // within the STAGES array; anything else falls back to the regular
    // single-step advance below.
    const skipToRaw = req.body.skip_to;
    const skipTo = Number.isFinite(parseInt(skipToRaw, 10)) ? parseInt(skipToRaw, 10) : null;

    // 1) Identify the operator by PIN (server-side — never trust the client).
    if (!validPin(pin)) return res.status(400).json({ error: 'Enter a 3-digit PIN' });
    const ops = await sql`SELECT id, name, stage_index, stage_indices, roles, persons FROM operators WHERE pin = ${pin} AND active LIMIT 1`;
    if (!ops.length) return res.status(401).json({ error: 'PIN not recognized' });
    const machine = ops[0];
    const opStages = (machine.stage_indices && machine.stage_indices.length) ? machine.stage_indices : [machine.stage_index];
    const allowedFinishes = allowedFinishesForOperator(machine);
    // Pick the actual person doing this update from the machine's persons
    // list. Single-person machine → auto-pick. Multi-person → client must
    // send person_name (validated against the list).
    const personsList = Array.isArray(machine.persons) ? machine.persons : [];
    const reqPersonName = String(req.body.person_name || '').trim();
    let person = null;
    let personIsCustom = false;
    if (personsList.length === 1 && !reqPersonName) person = personsList[0];
    else if (reqPersonName) {
      person = personsList.find(p => p && p.name === reqPersonName) || null;
      // Custom fallback — operator working on a machine that isn't their
      // usual one. Look up any active person across all machines and accept
      // a matching name. Audit log will note "(custom)" so it's visible.
      if (!person) {
        const otherRows = await sql`SELECT persons FROM operators WHERE active AND persons IS NOT NULL`;
        for (const r of otherRows) {
          const list = Array.isArray(r.persons) ? r.persons : [];
          const hit = list.find(p => p && p.name === reqPersonName);
          if (hit) { person = hit; personIsCustom = true; break; }
        }
      }
    }
    if (!person) return res.status(400).json({ error: 'Pick which operator is doing this update.' });
    // Synthesize an "operator" shape so the existing log/coatings_done code
    // keeps working without rewiring everything to a separate person object.
    const operator = {
      id: machine.id,
      name: person.name + (personIsCustom ? ' (custom)' : ''),
      name_ur: person.name_ur || '',
      stage_index: machine.stage_index,
      stage_indices: machine.stage_indices,
      roles: machine.roles,
      machine: machine.name,
    };

    // 2) Load job + guards.
    const rows = await sql`SELECT * FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status === 'pending') {
      return res.status(400).json({ error: 'Stock must be issued before this job can be updated.' });
    }
    const curStage = job.stage_index || 0;

    // 3) Scope: the operator may only act on jobs at one of their assigned stages.
    if (!opStages.includes(curStage)) {
      return res.status(400).json({ error: "This job isn't at your station right now." });
    }

    // 4) Merge the stage's number fields into particulars. Two payload
    // shapes are supported per key:
    //   - string  → legacy single-value patch (overwrites quantity).
    //   - string[] → multi-pass mode. Each element is one pass; we merge
    //     index-by-index with any existing entries[] so corrections to
    //     historical values keep their original date/operator/machine,
    //     while brand-new pass slots get today's date stamped on them.
    //     quantity gets recomposed as a pipe-joined display string
    //     ("90 | 20") so the job card and downstream consumers continue
    //     to work without knowing about entries[].
    const particulars = (job.particulars && typeof job.particulars === 'object') ? { ...job.particulars } : {};
    const todayISO = businessDateISO();
    for (const [key, value] of Object.entries(particularsPatch)) {
      const prev = (particulars[key] && typeof particulars[key] === 'object') ? particulars[key] : {};
      if (Array.isArray(value)) {
        // Seed from existing entries[], or back-fill a single legacy
        // entry from prev.quantity so a job's first multi-pass save
        // doesn't lose its original day-1 number.
        const seed = Array.isArray(prev.entries) && prev.entries.length
          ? prev.entries
          : (prev.quantity != null && String(prev.quantity).trim() !== ''
              ? [{ qty: String(prev.quantity).trim(), date: null,
                   operator: prev.name || null, machine: null }]
              : []);
        const merged = value.map((v, i) => {
          const qty = String(v ?? '').trim();
          const old = seed[i];
          if (old) {
            // Preserve whatever date the existing entry had — including
            // null for entries that were back-filled from the legacy
            // single-quantity field. Stamping "today" on a null date
            // would silently misattribute the original day-1 number to
            // the day the operator first added a second pass.
            return {
              qty,
              date:     old.date     || null,
              operator: old.operator || operator.name,
              machine:  old.machine  || operator.machine || null,
            };
          }
          return { qty, date: todayISO, operator: operator.name, machine: operator.machine || null };
        });
        const opsList = [...new Set(merged.map(e => e.operator).filter(Boolean))];
        particulars[key] = {
          ...prev,
          entries: merged,
          quantity: merged.map(e => e.qty).filter(q => q !== '').join(' | '),
          name: opsList.join(' | '),
        };
      } else {
        particulars[key] = { ...prev, quantity: String(value ?? '').trim(), name: operator.name };
      }
    }

    // Byline used by every log entry below. Including the operator's
    // assigned machine here means the job history shows e.g.
    // "Wajid · SM-52 (Printing)" — same info whether the operator was
    // advancing the stage or just recording numbers.
    const stageLabel = STAGES[operator.stage_index] || 'Stage ' + operator.stage_index;
    const by = `${operator.name}${operator.machine ? ' · ' + operator.machine : ''} (${stageLabel})`;
    const time = businessStamp();

    let stage_index = curStage;
    let stages = (job.stages && typeof job.stages === 'object') ? { ...job.stages } : {};
    let log = Array.isArray(job.log) ? [...job.log] : [];
    let coatings_done = Array.isArray(job.coatings_done) ? [...job.coatings_done] : [];

    // Coatings flow: the operator records which planned finish they did.
    // The sheets + waste NUMBERS ride in on particularsPatch just like any
    // other stage (coating_sheets_qty + uv_waste_sheets, both merged above
    // into entries[] so they round-trip and show on the job card). Here we
    // only stamp the coatings_done badge (kind + operator + machine +
    // waste) so the pipeline knows the finish is complete. The waste for
    // the badge is read back from the just-merged uv_waste_sheets entry
    // for THIS machine — no separate finish_waste field needed.
    const isCoatingsStage = curStage === 2;
    const finishKind = isCoatingsStage && typeof req.body.finish_kind === 'string' ? req.body.finish_kind.trim() : '';
    const finishMachine = isCoatingsStage ? String(req.body.finish_machine || '').trim() : '';
    if (isCoatingsStage && finishKind) {
      if (!ALL_FINISHES.includes(finishKind)) return res.status(400).json({ error: 'Unknown coating type.' });
      if (allowedFinishes.size && !allowedFinishes.has(finishKind)) return res.status(403).json({ error: `Your role isn't allowed to do ${finishKind}.` });
      const planned = Array.isArray(job.coatings) ? job.coatings : [];
      if (!planned.includes(finishKind)) return res.status(400).json({ error: 'That coating was not planned for this job.' });
      // Total waste for this machine, read back off the merged
      // uv_waste_sheets field. Summed across this machine's passes so a
      // multi-day coating (half today, half tomorrow) reports the full
      // waste on the badge and in the Daily Production coatings report,
      // which reads coatings_done[].waste_sheets.
      let finishWaste = '';
      const wf = particulars.uv_waste_sheets;
      if (wf && Array.isArray(wf.entries) && wf.entries.length) {
        const mine = wf.entries.filter(e => e && (!e.machine || e.machine === (operator.machine || '')));
        const src = mine.length ? mine : wf.entries;
        const sum = src.reduce((a, e) => {
          const n = parseInt(String((e && e.qty) || '').replace(/[^0-9-]/g, ''), 10);
          return a + (Number.isFinite(n) ? n : 0);
        }, 0);
        if (sum > 0) finishWaste = String(sum);
      } else if (wf && wf.quantity != null) {
        finishWaste = String(wf.quantity).trim();
      }
      // Multi-day support: same finish kind can be recorded more than
      // once for a job. The Daily Production aggregator filters by done_at
      // so each pass lands on the correct day.
      coatings_done.push({
        kind: finishKind,
        operator_id: operator.id,
        operator_name: operator.name,
        machine: finishMachine || null,
        waste_sheets: finishWaste || null,
        done_at: new Date().toISOString(),
      });
      log.push({ stage: STAGES[curStage], status: stages[curStage]?.status || 'active', notes: `${finishKind} recorded by ${operator.name}${finishMachine ? ' on ' + finishMachine : ''}${finishWaste ? ' (waste ' + finishWaste + ')' : ''}`, by, time });
    }

    if (advance) {
      const peekJob = { ...job, coatings_done };
      // Decide target. Priority: explicit skip_to wins. At Coatings, stay
      // here while any planned coating is still pending. Otherwise default
      // to next stage, auto-skipping Coatings if no coatings were planned.
      const validSkip = Number.isInteger(skipTo) && skipTo > curStage && skipTo < STAGES.length;
      let target;
      if (validSkip) {
        target = skipTo;
      } else if (isCoatingsStage) {
        // Stay at Coatings only while a planned finish is still pending.
        // A follow-up pass no longer blocks an EXPLICIT advance — the
        // operator clicked "send to next stage" and nothing is owed, so
        // holding the job here just strands it (multi-day passes that
        // should stay use "Save numbers (stay here)" / advance=false).
        const remaining = pendingCoatings(peekJob);
        target = remaining.length > 0 ? curStage : Math.min(curStage + 1, STAGES.length - 1);
      } else {
        // Auto-skip Coatings when leaving an earlier stage on a job that
        // has no coatings planned (jumps Printing → Die Cutting directly).
        let next = Math.min(curStage + 1, STAGES.length - 1);
        if (next === 2 && pendingCoatings(peekJob).length === 0 && (!Array.isArray(job.coatings) || job.coatings.length === 0)) {
          next = Math.min(next + 1, STAGES.length - 1);
        }
        target = next;
      }
      const skipped = Math.max(0, target - curStage - 1); // intermediate stages we're flying past
      const finishing = curStage === STAGES.length - 1;
      stages[curStage] = { ...(stages[curStage] || {}), status: target === curStage ? (stages[curStage]?.status || 'active') : 'done', by, time };
      if (target !== curStage && !finishing) {
        // Mark every skipped intermediate stage as done with an audit note
        // so the pipeline UI shows them passed, not blank.
        for (let i = curStage + 1; i < target; i++) {
          stages[i] = { ...(stages[i] || {}), status: 'done', by, time, notes: `Skipped — job went from ${STAGES[curStage]} directly to ${STAGES[target]}` };
        }
        const status = target === STAGES.length - 1 ? 'done' : 'active';
        stages[target] = { status, notes: '', by, time };
        for (let i = target + 1; i < STAGES.length; i++) delete stages[i];
        stage_index = target;
        const skipNote = skipped > 0 ? ` (skipped ${skipped} stage${skipped > 1 ? 's' : ''})` : '';
        log.push({ stage: STAGES[target], status, notes: `Moved from ${STAGES[curStage]} by ${operator.name}${skipNote}`, by, time });
      } else if (finishing) {
        log.push({ stage: STAGES[curStage], status: 'done', notes: `Completed by ${operator.name}`, by, time });
      }
      // target === curStage && !finishing → we already pushed the finish log
      // entry; the job legitimately stays at this stage waiting for the
      // remaining finishes, so nothing else to log here.
    } else if (!finishKind) {
      log.push({ stage: STAGES[curStage], status: stages[curStage]?.status || 'active', notes: `Numbers recorded by ${operator.name}`, by, time });
    }

    const updated = await sql`
      UPDATE jobs
         SET particulars   = ${JSON.stringify(particulars)},
             stage_index   = ${stage_index},
             stages        = ${JSON.stringify(stages)},
             log           = ${JSON.stringify(log)},
             coatings_done = ${JSON.stringify(coatings_done)}
       WHERE id = ${id}
       RETURNING *
    `;
    const skippedCount = Math.max(0, stage_index - curStage - 1);
    await logAudit(sql, req, {
      action: 'job.station',
      entityType: 'job',
      entityId: id,
      summary: advance
        ? `Job E-${id} ${stage_index === curStage ? 'completed' : 'moved to ' + STAGES[stage_index]} by ${operator.name} at ${STAGES[curStage]}${skippedCount > 0 ? ` (skipped ${skippedCount} stage${skippedCount > 1 ? 's' : ''})` : ''}`
        : `Job E-${id} numbers recorded by ${operator.name} at ${STAGES[curStage]}`,
      metadata: { operator_id: operator.id, operator_name: operator.name, stage_index: curStage, advance, target_stage: stage_index, skipped: skippedCount },
    });
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Station notes (text + voice, operator → next station) ───
// A note written at stage S is shown to the station at stage S+1 while
// the job sits there. Office users can read everything via the per-job
// GET (used by the History modal).

// CREATE a note. PIN-verified like station-update — never trust the client
// for the operator identity. kind: 'text' (body required) or 'voice'
// (audio data-URL required, ≤ ~3MB so we stay under Vercel's body cap).
app.post('/api/jobs/:id/station-notes', requireStationUser, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const pin = String(req.body.pin || '').trim();
    const kind = req.body.kind === 'voice' ? 'voice' : 'text';
    const body = String(req.body.body || '').trim();
    const audio = typeof req.body.audio === 'string' ? req.body.audio : '';
    const mime = String(req.body.mime || '').slice(0, 80);
    const duration = Number.isFinite(+req.body.duration_s) ? +req.body.duration_s : null;

    if (!validPin(pin)) return res.status(400).json({ error: 'Enter a 3-digit PIN' });
    const ops = await sql`SELECT id, name, stage_index, stage_indices, persons FROM operators WHERE pin = ${pin} AND active LIMIT 1`;
    if (!ops.length) return res.status(401).json({ error: 'PIN not recognized' });
    const machine = ops[0];
    const opStages = (machine.stage_indices && machine.stage_indices.length) ? machine.stage_indices : [machine.stage_index];
    const personsList = Array.isArray(machine.persons) ? machine.persons : [];
    const reqPersonName = String(req.body.person_name || '').trim();
    let person = null;
    let personIsCustom = false;
    if (personsList.length === 1 && !reqPersonName) person = personsList[0];
    else if (reqPersonName) {
      person = personsList.find(p => p && p.name === reqPersonName) || null;
      if (!person) {
        const otherRows = await sql`SELECT persons FROM operators WHERE active AND persons IS NOT NULL`;
        for (const r of otherRows) {
          const list = Array.isArray(r.persons) ? r.persons : [];
          const hit = list.find(p => p && p.name === reqPersonName);
          if (hit) { person = hit; personIsCustom = true; break; }
        }
      }
    }
    if (!person) return res.status(400).json({ error: 'Pick which operator is leaving this note.' });
    const operator = { id: machine.id, name: person.name + (personIsCustom ? ' (custom)' : ''), stage_index: machine.stage_index, stage_indices: machine.stage_indices };

    if (kind === 'text' && !body) return res.status(400).json({ error: 'Note is empty' });
    if (kind === 'voice') {
      if (!audio.startsWith('data:audio/')) return res.status(400).json({ error: 'No recording attached' });
      if (audio.length > 3_000_000) return res.status(413).json({ error: 'Recording too long — keep it under a minute' });
    }

    const rows = await sql`SELECT id, stage_index, deleted_at FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    // Operator may only leave notes on jobs at one of their assigned stations.
    if (!opStages.includes(rows[0].stage_index || 0)) {
      return res.status(400).json({ error: "This job isn't at your station right now." });
    }

    // Lazy purge: drop audio blobs older than 30 days (text survives).
    await sql`UPDATE station_notes SET audio = NULL WHERE audio IS NOT NULL AND created_at < NOW() - INTERVAL '30 days'`;

    const inserted = await sql`
      INSERT INTO station_notes (job_id, stage_index, operator_name, kind, body, audio, mime, duration_s)
      VALUES (${id}, ${operator.stage_index}, ${operator.name}, ${kind},
              ${kind === 'text' ? body : (body || null)}, ${kind === 'voice' ? audio : null},
              ${kind === 'voice' ? mime : null}, ${duration})
      RETURNING id, job_id, stage_index, operator_name, kind, body, mime, duration_s, created_at
    `;
    await logAudit(sql, req, {
      action: 'job.station-note',
      entityType: 'job',
      entityId: id,
      summary: `${kind === 'voice' ? 'Voice note' : 'Note'} left on Job E-${id} by ${operator.name} at ${STAGES[operator.stage_index] || 'Stage ' + operator.stage_index}`,
      metadata: { operator_name: operator.name, stage_index: operator.stage_index, kind },
    });
    res.json(inserted[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Notes for a whole station queue in one call: every note written at
// stage (S-1) on jobs that are CURRENTLY at stage S. Powers both the
// queue badges and the job screen at the station.
app.get('/api/station-notes/for-stage/:stageIndex', requireStationUser, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const stage = parseInt(req.params.stageIndex, 10);
    if (!Number.isInteger(stage) || stage < 0) return res.json([]);
    // Forward-broadcast + self-echo: an operator at this stage sees notes
    // from EVERY upstream stage AND their own stage's notes on the jobs
    // currently at their station. CTP's message reaches Printing,
    // Coating, Die-Cut, Break, Paste, Storage, and Delivered; and an
    // operator who hits Save (stay here) after recording immediately
    // sees their own broadcast in the same list so they can verify it
    // went out.
    const rows = await sql`
      SELECT n.id, n.job_id, n.stage_index, n.operator_name, n.kind, n.body,
             n.audio, n.mime, n.duration_s, n.created_at, n.heard_at
        FROM station_notes n
        JOIN jobs j ON j.id = n.job_id
       WHERE j.deleted_at IS NULL
         AND (j.stage_index) = ${stage}
         AND n.stage_index <= ${stage}
       ORDER BY n.created_at ASC
    `;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// All notes for one job — the office History modal. Any signed-in user.
app.get('/api/jobs/:id/station-notes', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`
      SELECT id, job_id, stage_index, operator_name, kind, body, audio, mime, duration_s, created_at, heard_at
        FROM station_notes WHERE job_id = ${req.params.id} ORDER BY created_at ASC
    `;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Mark a note heard/read — fired when the next station plays or views it.
app.post('/api/station-notes/:id/heard', requireStationUser, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    await sql`UPDATE station_notes SET heard_at = COALESCE(heard_at, NOW()) WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── CAPA reports ─────────────────────────────────────────────
// Corrective & Preventive Action reports raised against a job. Multiple
// per job allowed (ref = JC-{jobcode}-{seq}). Section 1 (job details) is
// snapshotted at creation so the CAPA stays stable if the job is edited
// later. The rest of the form lives in a JSONB blob.
//
// Permissions:
//   • Any signed-in user can read.
//   • Admin + User + Stock can create/edit while status != 'closed'.
//   • Once status='closed', only admin can edit/delete.
//   • CEO is read-only everywhere (requireWriteUser blocks them).

// Build a Section-1 snapshot from a job row. Frozen at CAPA creation time.
// `issue_date` is the date the JOB CARD was issued — NOT the date this CAPA
// was raised (that lives on capa.issue_date instead). Falls back to the
// job's created_at if the user never typed a Date Issued on the job form.
function buildJobSnapshot(job) {
  const jobIssueDate = job.dateissued
    || (job.created_at ? businessDateISO(new Date(job.created_at)) : '');
  return {
    job_card_no:  job.jobcode || (job.id ? `E-${job.id}` : ''),
    job_ref_id:   job.id,
    po_no:        job.ref || '',
    issue_date:   jobIssueDate,
    machine:      job.machine || '',
    job_name:     job.name || '',
    company:      job.client || '',
    po_qty:       job.qty || '',
    delivered_qty:job.delqty || '',
  };
}

// GET all CAPAs across the whole shop with filters. Used by the CAPA Report
// page under Jobs Reports — supports date range, company, and status filters,
// and is the source for bulk export / bulk print on that page.
app.get('/api/capa', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { from, to, client, status } = req.query;
    // Date filter is on the CAPA's issue_date (the day it was raised). We
    // bind it loosely as text — values are 'yyyy-mm-dd' which sort lexically.
    const fromTxt   = from   && /^\d{4}-\d{2}-\d{2}$/.test(from)   ? from   : null;
    const toTxt     = to     && /^\d{4}-\d{2}-\d{2}$/.test(to)     ? to     : null;
    const clientTxt = client && String(client).trim()              ? String(client).trim() : null;
    const statusTxt = status && ['open','in_progress','closed'].includes(status) ? status : null;
    const rows = await sql`
      SELECT * FROM capa_reports
      WHERE (${fromTxt}::text IS NULL OR issue_date >= ${fromTxt})
        AND (${toTxt}::text   IS NULL OR issue_date <= ${toTxt})
        AND (${clientTxt}::text IS NULL OR job_snapshot->>'company' = ${clientTxt})
        AND (${statusTxt}::text IS NULL OR status = ${statusTxt})
      ORDER BY created_at DESC
    `;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET all CAPAs for a job, newest first.
app.get('/api/jobs/:id/capa', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`
      SELECT * FROM capa_reports WHERE job_id=${req.params.id}
      ORDER BY seq DESC
    `;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET one CAPA.
app.get('/api/capa/:id', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`SELECT * FROM capa_reports WHERE id=${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'CAPA not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CREATE a standalone CAPA (not tied to any job). Used for shop-wide quality
// issues that aren't a single-job event — supplier complaint, machine
// calibration drift, safety incident, etc. capa_ref = GEN-{YYYY}-{seq}
// where seq is monotonic across all standalone CAPAs ever raised. Section 1
// stays empty in job_snapshot; the user types those fields themselves on
// the edit form (capaFormHtml flips Section 1 to editable when snapshot is
// empty).
app.post('/api/capa', requireCapaWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const year = new Date().getFullYear();
    // Count existing GEN- refs to find the next seq. Cheaper than a sequence
    // and handles year-boundary resets cleanly.
    const existing = await sql`
      SELECT COALESCE(MAX(seq),0) AS m FROM capa_reports
      WHERE job_id IS NULL AND capa_ref LIKE ${'GEN-' + year + '-%'}
    `;
    const seq = (existing[0].m || 0) + 1;
    const capaRef = `GEN-${year}-${seq}`;
    const today = businessDateISO();
    const inserted = await sql`
      INSERT INTO capa_reports
        (job_id, capa_ref, seq, status, issue_date, job_snapshot, data, created_by_id, created_by_email)
      VALUES
        (${null}, ${capaRef}, ${seq}, 'open', ${today}, ${JSON.stringify({})}, ${JSON.stringify(req.body && req.body.data || {})}, ${req.user.id}, ${req.user.email})
      RETURNING *
    `;
    const capa = inserted[0];
    await logAudit(sql, req, {
      action: 'capa.create',
      entityType: 'capa',
      entityId: capa.id,
      summary: `General CAPA ${capa.capa_ref} raised (no job)`,
      metadata: { capa_ref: capa.capa_ref, general: true },
    });
    res.json(capa);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CREATE a new CAPA against a job. Auto-snapshots Section 1, auto-assigns
// the next seq, and builds capa_ref = JC-{jobcode||E-id}-{seq}.
app.post('/api/jobs/:id/capa', requireCapaWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const jobId = parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'Invalid job id' });

    const jobs = await sql`SELECT * FROM jobs WHERE id=${jobId}`;
    if (!jobs.length) return res.status(404).json({ error: 'Job not found' });
    const job = jobs[0];

    const snap = buildJobSnapshot(job);
    const maxRows = await sql`SELECT COALESCE(MAX(seq),0) AS m FROM capa_reports WHERE job_id=${jobId}`;
    const seq = (maxRows[0].m || 0) + 1;
    const capaRef = `JC-${snap.job_card_no}-${seq}`;
    const today = businessDateISO(); // yyyy-mm-dd, business-local

    const inserted = await sql`
      INSERT INTO capa_reports
        (job_id, capa_ref, seq, status, issue_date, job_snapshot, data, created_by_id, created_by_email)
      VALUES
        (${jobId}, ${capaRef}, ${seq}, 'open', ${today}, ${JSON.stringify(snap)}, ${JSON.stringify(req.body && req.body.data || {})}, ${req.user.id}, ${req.user.email})
      RETURNING *
    `;
    const capa = inserted[0];
    await logAudit(sql, req, {
      action: 'capa.create',
      entityType: 'capa',
      entityId: capa.id,
      summary: `CAPA ${capa.capa_ref} raised on job E-${jobId}`,
      metadata: { job_id: jobId, capa_ref: capa.capa_ref },
    });
    res.json(capa);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// UPDATE a CAPA. Anyone with write access can edit while open/in_progress.
// Once closed, only admin can change it (including reopening).
app.put('/api/capa/:id', requireCapaWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const existing = await sql`SELECT * FROM capa_reports WHERE id=${req.params.id}`;
    if (!existing.length) return res.status(404).json({ error: 'CAPA not found' });
    const current = existing[0];

    // Lock closed CAPAs to admin + CEO — CEO has full CAPA governance.
    if (current.status === 'closed' && req.user.role !== 'admin' && req.user.role !== 'ceo') {
      return res.status(403).json({ error: 'This CAPA is closed. Only admin or CEO can edit it.' });
    }

    const { status, issue_date, data, job_snapshot } = req.body || {};
    const nextStatus = ['open', 'in_progress', 'closed'].includes(status) ? status : current.status;
    const nextData   = data && typeof data === 'object' ? data : current.data;
    const nextIssue  = (issue_date === undefined || issue_date === null) ? current.issue_date : issue_date;
    const closingNow = nextStatus === 'closed' && current.status !== 'closed';
    const reopening  = nextStatus !== 'closed' && current.status === 'closed';
    // Compute closed_at in JS so we don't have to embed a SQL fragment into a
    // value slot (neon's tagged template parameterizes ${...} as bind values).
    const nextClosedAt = closingNow ? new Date() : (reopening ? null : current.closed_at);
    // Section 1 (job_snapshot) is only writable for General CAPAs (job_id IS
    // NULL). Job-tied CAPAs keep their frozen snapshot — even if the client
    // sends a different value, we ignore it. This preserves the audit
    // guarantee that Section 1 reflects the job at CAPA creation.
    const nextSnap = (current.job_id == null && job_snapshot && typeof job_snapshot === 'object')
      ? job_snapshot
      : current.job_snapshot;

    const updated = await sql`
      UPDATE capa_reports SET
        status=${nextStatus},
        issue_date=${nextIssue},
        data=${JSON.stringify(nextData)},
        job_snapshot=${JSON.stringify(nextSnap)},
        updated_at=NOW(),
        closed_at=${nextClosedAt}
      WHERE id=${req.params.id}
      RETURNING *
    `;
    const capa = updated[0];
    let action = 'capa.update';
    let summary = `CAPA ${capa.capa_ref} updated`;
    if (closingNow) { action = 'capa.close'; summary = `CAPA ${capa.capa_ref} closed`; }
    if (reopening)  { action = 'capa.reopen'; summary = `CAPA ${capa.capa_ref} reopened`; }
    await logAudit(sql, req, {
      action, entityType: 'capa', entityId: capa.id, summary,
      metadata: { job_id: capa.job_id, capa_ref: capa.capa_ref, status: capa.status },
    });
    res.json(capa);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE a CAPA. Hard delete — CAPAs aren't trashed.
//   • Admin can delete any CAPA, in any status.
//   • User / Stock can delete a CAPA only if it's still Open or In Progress;
//     once Closed it's locked to admin (matches the edit-lock behavior).
//   • CEO can't reach this — requireWriteUser blocks them.
app.delete('/api/capa/:id', requireCapaWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const existing = await sql`SELECT * FROM capa_reports WHERE id=${req.params.id}`;
    if (!existing.length) return res.status(404).json({ error: 'CAPA not found' });
    const capa = existing[0];
    if (capa.status === 'closed' && req.user.role !== 'admin' && req.user.role !== 'ceo') {
      return res.status(403).json({ error: 'This CAPA is closed. Only admin or CEO can delete it.' });
    }
    await sql`DELETE FROM capa_reports WHERE id=${req.params.id}`;
    await logAudit(sql, req, {
      action: 'capa.delete',
      entityType: 'capa',
      entityId: capa.id,
      summary: `CAPA ${capa.capa_ref} deleted`,
      metadata: { job_id: capa.job_id, capa_ref: capa.capa_ref },
    });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
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
