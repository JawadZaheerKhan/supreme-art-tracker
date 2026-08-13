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
// Epoch (ms) for a business-local wall-clock date/time. The server runs in
// UTC, so `new Date(y, mo-1, d, h, mi)` would interpret the numbers as UTC
// and be hours off. This finds BUSINESS_TZ's offset at that instant and
// corrects for it, so a byline like "03/07/2026 00:45" (PKT) maps to the
// same epoch the coating's UTC done_at has. Used only for legacy stage
// rows written before we stamped an explicit `at` instant.
function businessWallClockToMs(y, mo, d, h, mi) {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcGuess));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let hh = map.hour; if (hh === '24') hh = '00';
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +hh, +map.minute, +map.second);
  const offset = asUTC - utcGuess;          // BUSINESS_TZ offset at that instant
  return utcGuess - offset;                 // corrected epoch for the wall clock
}

// Production stages — must mirror STAGES in public/index.html. Used by the
// station-update endpoint to build stage names + detect the final stage.
const STAGES = ['CTP Plate Making','Printing','Coatings','Die Cutting','Sorting','Pasting','Ready to Deliver','Delivered'];

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
  { id: 'storage',   label: 'Ready to Deliver',  stage_index: 6 },
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
  // Prefer the unambiguous UTC instant (`at`); fall back to parsing the
  // wall-clock byline for legacy rows written before `at` existed. The
  // byline parse is timezone-dependent, so only use it when there's no
  // instant available.
  if (stageRec && stageRec.at) {
    const t = new Date(stageRec.at).getTime();
    if (isFinite(t)) stageMs = t;
  } else if (stageRec && stageRec.time) {
    const m = String(stageRec.time).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (m) {
      // Legacy row: the byline is a business-local wall clock, so parse it
      // in the business timezone (NOT the server's UTC) to line up with
      // the coating's UTC done_at instant.
      const t = businessWallClockToMs(+m[3], +m[2], +m[1], +(m[4]||0), +(m[5]||0));
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
const SCHEMA_VERSION = 'v2026-08-10-finance-role-check';

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

    // Shade-card flag: this job is being PRINTED as a shade card (proof/
    // sample), not a normal production run. Distinct from
    // particulars.shade_card.quantity which tracks whether the shade card
    // DOCUMENT for a normal job is approved. Drives a big green SHADE CARD
    // badge on the printed job card (same slot as URGENT) and a filter in
    // the jobs list so PM can see all in-flight shade-card jobs.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_shade_card BOOLEAN NOT NULL DEFAULT false`;

    // Split issuance record: PM now picks a brand-agnostic paper GROUP
    // (paper_type + size + gsm + is_offcut), and the store keeper chooses
    // brand(s) at issue time — possibly across multiple brands in the
    // group. issued_items stores what actually left the storeroom:
    //   [{ item_id, brand, sheets }, ...]
    // Empty until anything is issued, so old rows land at [] cleanly.
    // The app shows this list (comma-joined brands) once populated; the
    // printed job card leaves brand blank for the cutting group to
    // handwrite regardless.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS issued_items JSONB NOT NULL DEFAULT '[]'::jsonb`;

    // Client portal: PM ticks this on the job card to expose the job to
    // the client (via the client's own portal). Defaults to false so
    // nothing is visible until someone consciously opts in. Filtered by
    // GET /api/client/jobs alongside role + company + delivered-cutoff.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT false`;

    // Soft-delete (Trash) columns: when admin "Delete from History" deletes a
    // delivered job, we set deleted_at instead of dropping the row, so the
    // admin has 30 days to recover it from the Trash page. Auto-purged later.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`;
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_by TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS jobs_deleted_at_idx ON jobs(deleted_at) WHERE deleted_at IS NOT NULL`;

    // Partial deliveries ledger: each entry is one shipment out of the total
    // P.O. qty. { date, pieces, cartons, notes, by, at }. delqty is now a
    // derived running total (sum of deliveries[].pieces) whenever the array
    // has any entries; jobs without any deliveries still use the legacy
    // scalar delqty column so historical data isn't disturbed.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deliveries JSONB NOT NULL DEFAULT '[]'::jsonb`;
    // Linked Jobs — pairwise, one-off pairing for orders printed together
    // but placed at different times (different PO/qty). Symmetric: linking
    // A<->B sets both rows' linked_job_id to each other. Used to run one
    // joint delivery (1 challan, both jobs' own qty) and to merge their
    // rows in the Jobs Report.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS linked_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL`;
    // Stock Groups — named tag shared by multiple job cards for the same
    // product (ongoing reprints). FIFO delivery deducts from oldest first.
    await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS stock_group_name TEXT`;
    // Group-level client visibility — INDEPENDENT from per-job client_visible.
    // When ON, the client sees the group tile with ALL member data aggregated,
    // regardless of individual jobs' client_visible. Individual client_visible
    // only controls whether that job appears in the client's "View Jobs" modal.
    // Shared across all members of a group (server updates every row on toggle).
    {
      const colExists = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'jobs' AND column_name = 'stock_group_visible'
      `;
      await sql`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS stock_group_visible BOOLEAN NOT NULL DEFAULT false`;
      // Backfill only when the column was just added: preserve existing behavior
      // by turning group visibility ON for any group that had at least one
      // client-visible member. Runs exactly once — later toggles won't be undone.
      if (!colExists.length) {
        await sql`
          UPDATE jobs j SET stock_group_visible = true
           WHERE j.stock_group_name IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM jobs g
                WHERE g.stock_group_name = j.stock_group_name
                  AND g.client_visible = true
             )
        `;
      }
    }
    // Backfill: for any already-Delivered job (stage 7) that has a delqty
    // but no ledger entry yet, seed a single ledger entry so the mini table
    // in the job card and the client view are not blank for old jobs. In
    // this shop 1 carton == 1 piece, so cartons == delqty.
    await sql`
      UPDATE jobs
         SET deliveries = jsonb_build_array(
               jsonb_build_object(
                 'cartons',  NULLIF(delqty,'')::text,
                 'date',     COALESCE(NULLIF(deadline,''), to_char(NOW(),'YYYY-MM-DD')),
                 'notes',    'Backfilled from legacy delqty on schema upgrade',
                 'by',       'system',
                 'at',       to_char(NOW(),'YYYY-MM-DD"T"HH24:MI:SSOF')
               )
             )
       WHERE stage_index = 7
         AND (deliveries IS NULL OR jsonb_array_length(deliveries) = 0)
         AND delqty IS NOT NULL AND delqty <> ''
    `;
    // Migrate any earlier backfilled/manually-added rows that stored the
    // pieces + cartons split: rewrite each entry so `cartons` = legacy
    // pieces value (they're the same unit here) and drop the pieces key.
    await sql`
      UPDATE jobs
         SET deliveries = (
           SELECT jsonb_agg(
             CASE
               WHEN d ? 'pieces' AND (d->>'cartons') IN ('', '0', NULL)
                 THEN (d - 'pieces') || jsonb_build_object('cartons', d->>'pieces')
               ELSE d - 'pieces'
             END
           )
             FROM jsonb_array_elements(deliveries) AS d
         )
       WHERE deliveries IS NOT NULL
         AND jsonb_array_length(deliveries) > 0
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(deliveries) d
            WHERE d ? 'pieces'
         )
    `;

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
    // Challan No. — supplier delivery / customer challan reference for
    // bulk stock-in and bulk stock-out. Shown as a column + filter in
    // the Stock In / Stock Out reports. Nullable — single-item entries
    // and pre-existing rows leave it blank.
    await sql`ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS challan_no TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS inventory_tx_challan_idx ON inventory_transactions(challan_no) WHERE challan_no IS NOT NULL`;

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
    // Partial receive support: tracks how many packets have been received so
    // far across possibly multiple deliveries. status flows pending →
    // partial (some but not all received) → received (fully received), or
    // pending → cancelled.
    await sql`ALTER TABLE inventory_imports ADD COLUMN IF NOT EXISTS received_packets NUMERIC DEFAULT 0`;

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
    await sql`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','production_manager','store_manager','finance','operator','ceo','client'))`;
    // Multi-role support: a user can hold several roles at once (e.g. CEO +
    // Admin). `roles` is the source of truth; the legacy `role` column keeps
    // the highest-priority role for back-compat with old JWT cookies and any
    // code that still reads the single value. Backfill from `role`.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT[]`;
    await sql`UPDATE users SET roles = ARRAY[role] WHERE roles IS NULL OR array_length(roles, 1) IS NULL`;
    // Client portal: bind a client-role user to a single company name (must
    // match a value in jobs.client for the portal to surface anything). Only
    // used when the user's roles include 'client'; null for every internal
    // role. Case-insensitive matching is done at query time so the admin
    // doesn't have to worry about exact casing when picking from the dropdown.
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_company TEXT`;

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

    // Finished Goods Transfer Notes (PRD/QR/008)
    await sql`
      CREATE TABLE IF NOT EXISTS transfer_notes (
        id               SERIAL PRIMARY KEY,
        transfer_note_no TEXT NOT NULL,
        date             TEXT NOT NULL,
        po_no            TEXT,
        client           TEXT,
        transferred_from TEXT DEFAULT 'Production',
        transferred_to   TEXT DEFAULT 'Store / Warehouse',
        product_name     TEXT,
        job_ids          JSONB DEFAULT '[]',
        items            JSONB DEFAULT '[]',
        total_qty        INTEGER DEFAULT 0,
        total_packages   INTEGER DEFAULT 0,
        qc_status        TEXT DEFAULT 'passed',
        auth_signatures  JSONB DEFAULT '{}',
        remarks          TEXT,
        created_by       TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // One-time rename of legacy paper-type labels — old "Bleach Card" and
    // "Box Board" are now "Bleach Board" and "Duplex Board" across the app.
    await sql`UPDATE inventory_items   SET paper_type = 'Bleach Board' WHERE paper_type = 'Bleach Card'`;
    await sql`UPDATE inventory_items   SET paper_type = 'Duplex Board' WHERE paper_type = 'Box Board'`;
    await sql`UPDATE inventory_imports SET paper_type = 'Bleach Board' WHERE paper_type = 'Bleach Card'`;
    await sql`UPDATE inventory_imports SET paper_type = 'Duplex Board' WHERE paper_type = 'Box Board'`;

    // Case-normalization pass (v2026-07-13): every human-typed identifier
    // — paper_type, brand, size, supplier on inventory rows; name, client
    // on jobs — is stored as lowercase from here on. This one-time
    // UPDATE collapses the historical duplicates ("NINGBO"/"Ningbo"/
    // "ningbo" all becoming "ningbo") so the dropdowns and reports stop
    // showing the same entity as three different things.
    await sql`UPDATE inventory_items SET paper_type = LOWER(TRIM(paper_type)) WHERE paper_type IS NOT NULL AND paper_type <> LOWER(TRIM(paper_type))`;
    await sql`UPDATE inventory_items SET brand      = LOWER(TRIM(brand))      WHERE brand      IS NOT NULL AND brand      <> LOWER(TRIM(brand))`;
    await sql`UPDATE inventory_items SET size       = LOWER(TRIM(size))       WHERE size       IS NOT NULL AND size       <> LOWER(TRIM(size))`;
    await sql`UPDATE inventory_items SET supplier   = LOWER(TRIM(supplier))   WHERE supplier   IS NOT NULL AND supplier   <> LOWER(TRIM(supplier))`;
    await sql`UPDATE inventory_imports SET paper_type = LOWER(TRIM(paper_type)) WHERE paper_type IS NOT NULL AND paper_type <> LOWER(TRIM(paper_type))`;
    await sql`UPDATE inventory_imports SET brand      = LOWER(TRIM(brand))      WHERE brand      IS NOT NULL AND brand      <> LOWER(TRIM(brand))`;
    await sql`UPDATE inventory_imports SET size       = LOWER(TRIM(size))       WHERE size       IS NOT NULL AND size       <> LOWER(TRIM(size))`;
    await sql`UPDATE inventory_imports SET supplier   = LOWER(TRIM(supplier))   WHERE supplier   IS NOT NULL AND supplier   <> LOWER(TRIM(supplier))`;
    await sql`UPDATE jobs SET name   = LOWER(TRIM(name))   WHERE name   IS NOT NULL AND name   <> LOWER(TRIM(name))`;
    await sql`UPDATE jobs SET client = LOWER(TRIM(client)) WHERE client IS NOT NULL AND client <> LOWER(TRIM(client))`;

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
    req.user = { id: 0, email: 'dev@local', role: 'admin', roles: ['admin'], name: 'Local Dev', picture: '' };
    return next();
  }
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = {
        id: payload.id, email: payload.email, name: payload.name, picture: payload.picture,
        role: payload.role,
        // Multi-role: newer tokens carry the full list; tokens issued before
        // the feature only have the single role — wrap it.
        roles: Array.isArray(payload.roles) && payload.roles.length ? payload.roles : [payload.role],
        client_company: payload.client_company || null,
      };
    } catch (e) {
      // Invalid/expired token — leave req.user undefined.
    }
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  // Client-role users are external and must never see internal endpoints.
  // Every existing GET /api/jobs, /api/inventory, /api/audit, /api/users
  // etc. goes through this middleware, so blocking here is the single
  // authoritative gate. Client-only endpoints live under /api/client/*
  // and use requireClient instead.
  if (userHasRole(req.user, 'client')) {
    return res.status(403).json({ error: 'Client accounts can only access the client portal (/api/client/*).' });
  }
  next();
}
// ── Role helpers ─────────────────────────────────────────────
// Roles: 'admin' (full), 'production_manager' (jobs+station write),
// 'store_manager' (inventory+imports write), 'operator' (station only),
// 'ceo' (read-only everywhere).
// A user may hold SEVERAL roles at once (e.g. CEO + Admin) — access is
// granted when ANY of their roles allows the action (highest privilege
// wins). Legacy fallback: rows/JWTs from before the role rename still
// carry 'user' (→ production_manager) and 'stock' (→ store_manager).
const ROLE_ALIASES = { user: 'production_manager', stock: 'store_manager' };
function normalizeUserRoles(src) {
  const raw = Array.isArray(src) ? src : (src ? [src] : []);
  const out = [];
  for (const r0 of raw) {
    const r = ROLE_ALIASES[r0] || r0;
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}
function userHasRole(user, ...want) {
  if (!user) return false;
  const rs = normalizeUserRoles(Array.isArray(user.roles) && user.roles.length ? user.roles : user.role);
  return want.some(w => rs.includes(w));
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!userHasRole(req.user, 'admin')) return res.status(403).json({ error: 'Admin only' });
  next();
}
function canWriteJobs(user)      { return userHasRole(user, 'admin', 'production_manager'); }
function canWriteInventory(user) { return userHasRole(user, 'admin', 'store_manager'); }
function canRunStation(user)     { return userHasRole(user, 'admin', 'production_manager', 'operator', 'ceo'); }
// Delivery ledger — admin, PM, or the dedicated finance role. Finance is
// otherwise fully read-only; recording shipments is the one thing they own.
function canRecordDelivery(user) { return userHasRole(user, 'admin', 'production_manager', 'finance'); }
// Station WRITE actions — Save / Advance / Skip / Notes. CEO can enter
// the terminal (view-only) via canRunStation, but must never process a
// job. Admin / PM / operator still write freely.
function canProcessStation(user) { return userHasRole(user, 'admin', 'production_manager', 'operator'); }
// Operator roster CRUD — admin or production manager. The PM owns the
// floor and needs to add / edit / retire operators without an admin
// having to be involved every time.
function canManageOperators(user){ return userHasRole(user, 'admin', 'production_manager'); }

// Generic "not read-only" check. Used for cross-cutting endpoints (audit
// metadata, profile edits, etc.) where any write-capable role is fine.
// Positive logic (allow if ANY role grants writes) so a CEO+Admin combo
// isn't blocked by the read-only CEO role.
function requireWriteUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (userHasRole(req.user, 'admin', 'production_manager', 'store_manager')) return next();
  if (userHasRole(req.user, 'operator')) {
    return res.status(403).json({ error: 'Operator accounts can only use the Station view' });
  }
  return res.status(403).json({ error: 'Read-only account — changes are not allowed' });
}
// Jobs writes (create/edit/delete/move stages outside station) — admin or
// production_manager.
function requireJobsWriter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canWriteJobs(req.user)) {
    return res.status(403).json({ error: 'Not allowed — jobs write access required' });
  }
  next();
}
// Deliveries — admin, PM, or finance. Finance holds no other job-write
// role but is the only user allowed to record shipments (which is why it
// exists as a separate middleware from requireJobsWriter).
function requireDeliveryWriter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canRecordDelivery(req.user)) {
    return res.status(403).json({ error: 'Not allowed — delivery write access required' });
  }
  next();
}
// Inventory + imports writes — admin or store_manager.
function requireInventoryWriter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canWriteInventory(req.user)) {
    return res.status(403).json({ error: 'Not allowed — inventory write access required' });
  }
  next();
}
// Station endpoints — admin, production_manager, operator, or CEO.
// (Store_manager is blocked.) PIN is still verified separately per call.
function requireStationUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canRunStation(req.user)) {
    return res.status(403).json({ error: 'Not allowed — station access required' });
  }
  next();
}
// Operator roster CRUD — admin or production_manager. Used in place
// of requireAdmin on the operator endpoints so the PM can keep the
// floor PIN roster current on their own.
function requireOperatorAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!canManageOperators(req.user)) {
    return res.status(403).json({ error: 'Not allowed — operator admin access required' });
  }
  next();
}
// Client portal — the only middleware that ADMITS 'client' role users.
// requireAuth blocks them from everything else, so this is the sole gate
// into /api/client/*. A client without client_company bound to a company
// name is inert (would match no jobs), so we reject that here too.
function requireClient(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!userHasRole(req.user, 'client')) {
    return res.status(403).json({ error: 'Client portal is only for client accounts.' });
  }
  if (!req.user.client_company || !String(req.user.client_company).trim()) {
    return res.status(403).json({ error: 'Your account is not bound to a company yet — ask an admin to complete setup.' });
  }
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
      {
        id: user.id, email: user.email, name: user.name, picture: user.picture,
        role: user.role,
        roles: normalizeUserRoles(Array.isArray(user.roles) && user.roles.length ? user.roles : user.role),
        client_company: user.client_company || null,
      },
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
// Re-reads the user's CURRENT roles from the DB and, if they differ from the
// (up to 30-day-old) session token, re-issues the cookie on the spot. So an
// admin ticking a second role box takes effect on the user's next page
// load/refresh — no logout-login dance required.
app.get('/api/auth/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  try {
    if (req.user.id) {           // skip DEV bypass (id 0) — no DB row to check
      await dbReady;
      const sql = getDb();
      const rows = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
      const dbUser = rows[0];
      if (!dbUser) {
        // Account was removed — kill the session instead of serving a ghost.
        res.clearCookie(SESSION_COOKIE, { path: '/' });
        return res.status(401).json({ error: 'Account no longer exists' });
      }
      const freshRoles = normalizeUserRoles(Array.isArray(dbUser.roles) && dbUser.roles.length ? dbUser.roles : dbUser.role);
      const tokenRoles = normalizeUserRoles(req.user.roles && req.user.roles.length ? req.user.roles : req.user.role);
      const freshCompany = dbUser.client_company || null;
      const tokenCompany = req.user.client_company || null;
      const rolesChanged   = freshRoles.join(',') !== tokenRoles.join(',');
      const companyChanged = freshCompany !== tokenCompany;
      if (rolesChanged || companyChanged) {
        req.user = { ...req.user, role: dbUser.role, roles: freshRoles, client_company: freshCompany };
        const sessionToken = jwt.sign(
          { id: dbUser.id, email: dbUser.email, name: req.user.name, picture: req.user.picture, role: dbUser.role, roles: freshRoles, client_company: freshCompany },
          JWT_SECRET,
          { expiresIn: '30d' }
        );
        res.cookie(SESSION_COOKIE, sessionToken, {
          httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_MAX_AGE, path: '/',
        });
      }
    }
  } catch (e) {
    // DB hiccup — fall through and serve the token's view rather than
    // logging the user out over a transient error.
    console.error('auth/me role refresh failed:', e.message);
  }
  res.json({ user: req.user });
});

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, picture: u.picture,
    role: u.role,
    roles: normalizeUserRoles(Array.isArray(u.roles) && u.roles.length ? u.roles : u.role),
    client_company: u.client_company || null,
    created_at: u.created_at, last_login_at: u.last_login_at, invited_by: u.invited_by,
  };
}

// Multi-role input parsing shared by invite + role-change. Returns the
// cleaned roles array plus the single highest-priority role kept in the
// legacy `role` column (admin outranks manager roles outranks ceo/operator;
// client is a mutually-exclusive external role, ranked last).
const ROLE_PRIORITY = ['admin', 'production_manager', 'store_manager', 'finance', 'ceo', 'operator', 'client'];
function parseRolesInput(body) {
  const ALLOWED = new Set(ROLE_PRIORITY);
  let roles = normalizeUserRoles(Array.isArray(body.roles) && body.roles.length ? body.roles : body.role)
    .filter(r => ALLOWED.has(r));
  if (!roles.length) roles = ['production_manager'];
  // Client is external. If it appears alongside any internal role we drop
  // the internal ones — an outside client account must never also carry
  // admin/PM/store/operator/CEO privileges.
  if (roles.includes('client') && roles.length > 1) roles = ['client'];
  const primary = ROLE_PRIORITY.find(r => roles.includes(r)) || 'production_manager';
  return { roles, primary };
}

// ── User management (admin only) ─────────────────────────────

// GET users — admin + ceo (CEO is read-only; mutation endpoints below stay
// requireAdmin so role change / invite / remove are still locked down).
app.get('/api/users', requireAuth, async (req, res) => {
  if (!userHasRole(req.user, 'admin', 'ceo')) {
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
    const { roles, primary } = parseRolesInput(req.body);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    // Client-role invites need a company binding up front — a client
    // without a bound company would sign in and see nothing.
    const rawCompany = (req.body.client_company || '').trim();
    const clientCompany = roles.includes('client') ? rawCompany : null;
    if (roles.includes('client') && !clientCompany) {
      return res.status(400).json({ error: 'Client accounts must be bound to a company at invite time.' });
    }
    const inserted = await sql`
      INSERT INTO users (email, role, roles, client_company, invited_by)
      VALUES (${email}, ${primary}, ${roles}, ${clientCompany}, ${req.user.id})
      ON CONFLICT (email) DO NOTHING
      RETURNING *
    `;
    if (!inserted.length) return res.status(409).json({ error: 'A user with this email already exists' });
    const summary = `Invited ${email} as ${roles.join(' + ')}${clientCompany ? ` (client of ${clientCompany})` : ''}`;
    await logAudit(sql, req, { action: 'user.invite', entityType: 'user', entityId: inserted[0].id, summary });
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
    const { roles, primary } = parseRolesInput(req.body);
    // Guardrail: don't allow removing admin from yourself — locks you out
    // of the admin tools. Adding EXTRA roles to yourself is fine.
    if (parseInt(id, 10) === req.user.id && !roles.includes('admin')) {
      return res.status(400).json({ error: "You can't remove the Admin role from your own account." });
    }
    // client_company is only meaningful when the role IS client; drop it
    // otherwise so switching a user away from 'client' also clears the
    // company binding.
    const rawCompany = (req.body.client_company || '').trim();
    const clientCompany = roles.includes('client') ? rawCompany : null;
    if (roles.includes('client') && !clientCompany) {
      return res.status(400).json({ error: 'Client accounts must be bound to a company.' });
    }
    const updated = await sql`
      UPDATE users
         SET role = ${primary}, roles = ${roles}, client_company = ${clientCompany}
       WHERE id = ${id}
       RETURNING *
    `;
    if (!updated.length) return res.status(404).json({ error: 'User not found' });
    const summary = `Set ${updated[0].email} to ${roles.join(' + ')}${clientCompany ? ` (client of ${clientCompany})` : ''}`;
    await logAudit(sql, req, { action: 'user.role-change', entityType: 'user', entityId: updated[0].id, summary });
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
// Sum a possibly pipe-joined quantity string: "26000 | 500" → 26500.
// NEVER digit-strip these with a bare parseInt — that reads the same
// string as 26000500. Single plain numbers pass through unchanged.
function sumPipeInts(s) {
  return String(s || '').split('|').reduce((acc, piece) => {
    const n = parseInt(piece.replace(/[^0-9-]/g, ''), 10);
    return acc + (Number.isFinite(n) ? n : 0);
  }, 0);
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
  // Person-name → machine-name map for THIS section's operators only. Used
  // by the LEGACY (no-entries[]) fallback to credit "obaid" (typed on the
  // Job Card's Die Cutting Sheets row) to obaid's registered machine.
  const personToMachine = new Map();
  for (const r of machineRows) {
    const list = Array.isArray(r.persons) ? r.persons : [];
    for (const p of list) {
      const n = String((p && p.name) || '').trim().toLowerCase();
      if (n && !personToMachine.has(n)) personToMachine.set(n, r.name);
    }
  }
  const jobs = await sql`SELECT id, particulars, log, machine, stages FROM jobs WHERE deleted_at IS NULL AND log IS NOT NULL`;

  // Per-machine accumulator. `jobsMap` keeps a per-job breakdown so the
  // report can list "E-152-4clr / E-153-3+1clr" instead of the old
  // "1-4clr / 1-3clr" count grouping — each job stamped with its colors,
  // plates, and the earliest submission ms on that machine (used for
  // ordering the display list).
  const acc = new Map();
  const ensure = (m) => {
    if (!acc.has(m)) acc.set(m, {
      sheets: 0, waste: 0,
      jobsMap: new Map(),   // jobId -> { colorsRaw, platesRaw, firstMs }
      operators: new Set(),
    });
    return acc.get(m);
  };
  // Track the earliest submission ms per (machine, jobId) — computed from
  // log bylines matching this stage+date, so the per-machine job list
  // orders by who-worked-first that day. Preserves the operator's chosen
  // "+" notation in colors/plates by using the literal string as label.
  const parseMs = t => {
    const m = String(t || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    return m ? new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0)).getTime() : 0;
  };

  for (const job of jobs) {
    const log = Array.isArray(job.log) ? job.log : [];
    const part = (job.particulars && typeof job.particulars === 'object') ? job.particulars : {};

    // Sheets / waste get credited to whichever machine each entry stamps.
    // Legacy jobs (no entries[]) fall through to the old latest-byline
    // rule further down. Skip any entry that doesn't stamp a machine —
    // except Printing, which safely falls back to the job card's machine
    // so unstamped historical Printing entries still land somewhere.
    const sheetsField = part[sheetsKey];
    const wasteField  = wasteKey ? part[wasteKey] : null;
    const hasSheetEntries = sheetsField && Array.isArray(sheetsField.entries) && sheetsField.entries.length;
    const hasWasteEntries = wasteField  && Array.isArray(wasteField.entries)  && wasteField.entries.length;
    // Credits map: machine -> { sheets, waste, operators:Set, firstMs }.
    const credits = new Map();
    const bumpCredit = (mc, key, qty, op, ms) => {
      if (!mc) return;
      if (!credits.has(mc)) credits.set(mc, { sheets: 0, waste: 0, operators: new Set(), firstMs: Infinity });
      const c = credits.get(mc);
      c[key] += qty;
      if (op) c.operators.add(op);
      if (ms && ms < c.firstMs) c.firstMs = ms;
    };
    // Log-derived earliest ms per machine, so the per-machine job list
    // orders by "who submitted first that day". Preferred over the entry
    // itself, which only carries date-precision (no per-submission time).
    const logFirstMsByMc = new Map();
    for (const e of log) {
      if (!e || !e.by) continue;
      if (logTimeToISODate(e.time) !== date) continue;
      if (parseByStage(e.by) !== stageLabel) continue;
      const mc = parseByMachine(e.by);
      if (!mc) continue;
      const ms = parseMs(e.time);
      if (!logFirstMsByMc.has(mc) || ms < logFirstMsByMc.get(mc)) logFirstMsByMc.set(mc, ms);
    }
    const isPrinting = stageLabel === 'Printing';

    // Compute the legacy attribution machine/operator once — used when
    // EITHER field lacks entries[] and we need to attribute its pipe-sum
    // total. Same rules as the pre-fix code: latest-byline first, then
    // card-name-to-registered-machine, then job.machine.
    let latestMs = -1, latestMc = '', latestOp = '';
    let sawStageEntry = false;
    for (const e of log) {
      if (!e || !e.by) continue;
      if (logTimeToISODate(e.time) !== date) continue;
      if (parseByStage(e.by) !== stageLabel) continue;
      sawStageEntry = true;
      const ms = parseMs(e.time);
      if (ms > latestMs) {
        latestMs = ms;
        latestMc = parseByMachine(e.by);
        latestOp = parseByOperator(e.by);
      }
    }
    let legacyMc = latestMc, legacyOp = latestOp;
    if (!legacyMc) {
      const cardOp = sheetsField && String(sheetsField.name || '').trim();
      const cardOpMachine = cardOp ? personToMachine.get(cardOp.toLowerCase()) : '';
      const stageIdx = STAGES.indexOf(stageLabel);
      const stageRec = stageIdx >= 0 ? (job.stages && job.stages[stageIdx]) : null;
      const stageTimeMatches = stageRec && stageRec.time && logTimeToISODate(stageRec.time) === date;
      const cardEntryFits = cardOpMachine && (stageTimeMatches || sawStageEntry);
      if (cardEntryFits) {
        legacyMc = cardOpMachine;
        legacyOp = cardOp;
      } else if (job.machine && (sawStageEntry || stageTimeMatches) && machines.includes(job.machine)) {
        legacyMc = job.machine;
        if (cardOp) legacyOp = cardOp;
      }
    }

    // Sheets and waste are processed INDEPENDENTLY — one field can be
    // new-style entries[] while the other is still a legacy pipe string
    // (e.g. operator resubmitted printed_sheets_qty via the tablet but
    // waste was only ever typed on the card). Each field picks its own
    // path so the legacy side never gets silently dropped.
    if (hasSheetEntries) {
      for (const e of sheetsField.entries) {
        if (!e || e.date !== date) continue;
        const n = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
        if (!Number.isFinite(n) || n === 0) continue;
        let mc = String(e.machine || '').trim();
        if (!mc && isPrinting && job.machine) mc = job.machine;   // Printing-only safety fallback
        if (!mc) continue;
        bumpCredit(mc, 'sheets', n, String(e.operator || '').trim(), logFirstMsByMc.get(mc));
      }
    } else if (sheetsField && sheetsField.quantity && legacyMc) {
      const sN = sumPipeInts(sheetsField.quantity);
      if (sN) bumpCredit(legacyMc, 'sheets', sN, legacyOp, latestMs > 0 ? latestMs : 0);
    }
    if (hasWasteEntries) {
      for (const e of wasteField.entries) {
        if (!e || e.date !== date) continue;
        const n = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
        if (!Number.isFinite(n) || n === 0) continue;
        let mc = String(e.machine || '').trim();
        if (!mc && isPrinting && job.machine) mc = job.machine;
        if (!mc) continue;
        bumpCredit(mc, 'waste', n, String(e.operator || '').trim(), logFirstMsByMc.get(mc));
      }
    } else if (wasteField && wasteField.quantity && legacyMc) {
      const wN = sumPipeInts(wasteField.quantity);
      if (wN) bumpCredit(legacyMc, 'waste', wN, legacyOp, latestMs > 0 ? latestMs : 0);
    }

    if (!credits.size) continue;

    // Colors/Plates come from the job card, preserved as literals so a CTP
    // shorthand like "3+1" (3 process + 1 spot) shows through unchanged.
    const colorsRaw = String((part.no_of_colors && part.no_of_colors.quantity) || '').trim();
    const platesRaw = String((part.plates && part.plates.quantity) || '').trim();
    // Plates fallback: legacy jobs where plates was never filled in used
    // colors as a stand-in. Preserved here for those historical rows.
    const platesForJob = platesRaw || colorsRaw;

    for (const [mc, c] of credits) {
      const row = ensure(mc);
      row.sheets += c.sheets;
      row.waste  += c.waste;
      for (const op of c.operators) row.operators.add(op);
      if (!row.jobsMap.has(job.id)) {
        row.jobsMap.set(job.id, {
          colorsRaw, platesRaw: platesForJob,
          firstMs: Number.isFinite(c.firstMs) ? c.firstMs : 0,
        });
      } else {
        // Same job credited twice on the same machine (two entries in the
        // same day) — merge, keeping the earlier ms so the display list
        // orders by when the job first appeared on that machine.
        const prev = row.jobsMap.get(job.id);
        if (Number.isFinite(c.firstMs) && c.firstMs < (prev.firstMs || Infinity)) prev.firstMs = c.firstMs;
      }
    }
  }
  return { machines, acc };
}

// Build the { jobs, jobs_count } pair the per-day endpoints attach to
// each machine row. jobs is a comma-joined "E-152, E-153" display string
// ordered by earliest-submission-ms, jobs_count is the numeric length
// (used by the client's totals footer). Shared by Printing / Die /
// Pasting / Coatings so the four tabs render the Jobs column the same
// way.
function jobsDisplayPair(jobsMap) {
  if (!jobsMap || !jobsMap.size) return { jobs: '', jobs_count: 0 };
  const ordered = [...jobsMap.entries()]
    .sort((a, b) => (a[1].firstMs || 0) - (b[1].firstMs || 0) || a[0] - b[0]);
  return {
    jobs: ordered.map(([id]) => 'E-' + id).join(', '),
    jobs_count: ordered.length,
  };
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
      const operators = row ? [...row.operators].sort() : [];
      // Per-job Colors / Plates / Jobs strings, ordered by earliest
      // submission ms — "E-152-4clr / E-153-3+1clr" instead of the old
      // "2-4clr / 1-6clr" grouping. Numeric plates sum kept alongside
      // for the footer total (parses only the leading digits, so "3+1"
      // counts as 3 plates, not 31).
      const orderedJobs = row
        ? [...row.jobsMap.entries()].sort((a, b) => (a[1].firstMs || 0) - (b[1].firstMs || 0) || a[0] - b[0])
        : [];
      const colorsStr = orderedJobs
        .filter(([, v]) => v.colorsRaw)
        .map(([id, v]) => `E-${id}-${v.colorsRaw}clr`)
        .join(' / ');
      const platesStr = orderedJobs
        .filter(([, v]) => v.platesRaw)
        .map(([id, v]) => `E-${id}-${v.platesRaw}`)
        .join(' / ');
      const platesCount = orderedJobs.reduce((sum, [, v]) => {
        const head = String(v.platesRaw || '').match(/^-?\d+/);
        return sum + (head ? parseInt(head[0], 10) : 0);
      }, 0);
      const { jobs: jobsStr, jobs_count } = jobsDisplayPair(row && row.jobsMap);
      return {
        machine: m,
        // Source-of-truth columns (sheets / waste / operator / jobs /
        // colors / plates) are pure aggregates over the Job Card — admin
        // edits these via the Job Card itself, never via the report, so
        // clearing a Job Card row clears the report row too. Custom
        // (ad-hoc) machines still read these from the notes row because
        // there's no aggregate behind them.
        sheets: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : jobsStr,
        jobs_count: isCustom ? (parseInt(note.jobs, 10) || 0) : jobs_count,
        colors: isCustom ? (note.colors || '') : colorsStr,
        plates: isCustom ? (note.plates || '') : platesStr,
        plates_count: isCustom ? (parseInt(note.plates, 10) || 0) : platesCount,
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
        sheets: 0, jobsMap: new Map(), operators: new Set(),
        finishCounts: new Map(), waste: 0,
      });
      return acc.get(m);
    };
    // Coatings has no station "byline" the same way Printing does — done_at
    // on each coatings_done entry is our best per-job timestamp for that
    // machine, so use it as the sort key when we build the per-machine
    // Jobs display string.
    const noteFirstMs = (row, jobId, ms) => {
      if (!row.jobsMap.has(jobId)) row.jobsMap.set(jobId, { firstMs: ms || 0 });
      else if (ms && ms < (row.jobsMap.get(jobId).firstMs || Infinity)) row.jobsMap.get(jobId).firstMs = ms;
    };

    for (const job of jobs) {
      const done = Array.isArray(job.coatings_done) ? job.coatings_done : [];
      const part = (job.particulars && typeof job.particulars === 'object') ? job.particulars : {};
      // Owner report: coatings that were saved-but-not-forwarded didn't
      // appear in the Daily Production Report. Root cause was a
      // "if (!done.length) continue;" early-skip here that dropped the
      // job before its coating_sheets_qty.entries[] were credited. The
      // legacy branch below (line "if (!qtyEntries && !wasteEntries &&
      // sheetsN <= 0) continue;") already covers the truly-empty case,
      // so removing the early skip is safe.
      // Sum pipe-separated values like "500 | 500" → 1000. coating_sheets_qty
      // and uv_waste_sheets both use this format because station submissions
      // append pass-by-pass.
      const sumPipe = (s) => String(s || '').split('|').reduce((acc, part) => {
        const n = parseInt(part.replace(/[^0-9-]/g, ''), 10);
        return acc + (Number.isFinite(n) ? n : 0);
      }, 0);
      const coatSheetsAdmin = sumPipe(part.coating_sheets_qty && part.coating_sheets_qty.quantity);
      // Fallback: if admin hasn't filled in Coating Sheets Qty, derive from
      // printed − printed-waste (legacy formula). sumPipe — NOT parseInt —
      // because multi-pass quantities are pipe-joined ("26000 | 500") and a
      // bare digit-strip would read that as 26000500.
      const printedN = sumPipe(part.printed_sheets_qty && part.printed_sheets_qty.quantity);
      const printedWasteN = sumPipe(part.printed_waste_sheets && part.printed_waste_sheets.quantity);
      const sheetsN = coatSheetsAdmin > 0 ? coatSheetsAdmin : Math.max(0, printedN - printedWasteN);
      // Per-day, per-machine credit — SAME criteria as Printing. Station
      // passes are date- and machine-stamped in entries[], so sheets/waste
      // land on the day the work was entered (a 500/500 split across two
      // days shows 500 on each day), and each machine only gets ITS OWN
      // entries (UV 1000 + Emboss 800 no longer shows 1800 on both rows).
      const qtyEntries = part.coating_sheets_qty && Array.isArray(part.coating_sheets_qty.entries) && part.coating_sheets_qty.entries.length
        ? part.coating_sheets_qty.entries : null;
      const wasteEntries = part.uv_waste_sheets && Array.isArray(part.uv_waste_sheets.entries) && part.uv_waste_sheets.entries.length
        ? part.uv_waste_sheets.entries : null;
      const creditEntries = (entries, field) => {
        for (const e of entries) {
          if (!e || e.date !== date) continue;
          const mc = String(e.machine || '').trim();
          if (!mc) continue;
          const v = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
          if (!Number.isFinite(v) || v === 0) continue;
          const row = ensure(mc);
          row[field] += v;
          noteFirstMs(row, job.id, 0);
          const op = String(e.operator || '').trim();
          if (op) row.operators.add(op);
        }
      };
      if (qtyEntries) creditEntries(qtyEntries, 'sheets');
      if (wasteEntries) creditEntries(wasteEntries, 'waste');
      // Legacy jobs (no entries at all) keep the old badge-day behavior.
      if (!qtyEntries && !wasteEntries && sheetsN <= 0) continue;
      // ✓ badges still drive the finishes column, operator list, and job
      // count for the day the finish was recorded. Sheets/waste from the
      // badges only apply when the job has NO entries (legacy) — otherwise
      // the per-day entries above are the source of truth.
      const sheetsCredited = new Set();
      for (const entry of done) {
        if (!entry) continue;
        if (isoTsToDate(entry.done_at) !== date) continue;
        const kind = String(entry.kind || '').trim();
        const mc = String(entry.machine || '').trim();
        if (!mc) continue;
        const row = ensure(mc);
        const doneMs = (() => { const d = new Date(entry.done_at); return isNaN(d) ? 0 : d.getTime(); })();
        noteFirstMs(row, job.id, doneMs);
        if (!qtyEntries && !sheetsCredited.has(mc)) {
          row.sheets += sheetsN;
          sheetsCredited.add(mc);
        }
        const opName = String(entry.operator_name || '').trim();
        if (opName) row.operators.add(opName);
        if (kind) row.finishCounts.set(kind, (row.finishCounts.get(kind) || 0) + 1);
        if (!wasteEntries) {
          const w = parseInt(String(entry.waste_sheets || '').replace(/[^0-9-]/g, ''), 10);
          if (Number.isFinite(w)) row.waste += w;
        }
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
      const { jobs: jobsStr, jobs_count } = jobsDisplayPair(row && row.jobsMap);
      return {
        machine: m,
        sheets: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : jobsStr,
        jobs_count: isCustom ? (parseInt(note.jobs, 10) || 0) : jobs_count,
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
      const { jobs: jobsStr, jobs_count } = jobsDisplayPair(row && row.jobsMap);
      return {
        machine: m,
        // The helper calls it `sheets`; the Pasting register labels it Units.
        units: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : jobsStr,
        jobs_count: isCustom ? (parseInt(note.jobs, 10) || 0) : jobs_count,
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
      const { jobs: jobsStr, jobs_count } = jobsDisplayPair(row && row.jobsMap);
      return {
        machine: m,
        sheets: isCustom ? (note.sheets || '') : (row ? row.sheets : 0),
        jobs: isCustom ? (note.jobs || '') : jobsStr,
        jobs_count: isCustom ? (parseInt(note.jobs, 10) || 0) : jobs_count,
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
      // Legacy single-quantity fallback — pipe-aware (see sumPipeInts).
      return sumPipeInts(partKey.quantity);
    }
    return 0;
  };
  const jobs = await sql`SELECT id, particulars, log, machine, coatings_done FROM jobs WHERE deleted_at IS NULL`;
  for (const job of jobs) {
    const log = Array.isArray(job.log) ? job.log : [];
    const part = (job.particulars && typeof job.particulars === 'object') ? job.particulars : {};
    // Per-entry attribution: iterate entries[] in each stage and credit
    // (machine, operator) stamped on the entry with its own qty. Two
    // operators sharing a job on the same day → each gets their own
    // sheets/waste + job count instead of "latest byline wins".
    // Legacy jobs with no entries[] fall back to the old latest-byline
    // rule so historical rows still land somewhere.
    for (const [stageLabel, [sheetsKey, wasteKey]] of Object.entries(STAGE_KEYS)) {
      const sheetsField = part[sheetsKey];
      const wasteField  = part[wasteKey];
      const hasSheetEntries = sheetsField && Array.isArray(sheetsField.entries) && sheetsField.entries.length;
      const hasWasteEntries = wasteField  && Array.isArray(wasteField.entries)  && wasteField.entries.length;
      const isPrinting = stageLabel === 'Printing';
      const bump = (mc, op, date, field, qty) => {
        if (!date || date < from || date > to || !qty) return;
        if (mc) { const r = ensureMD(date, mc); r[field] += qty; r.jobs.add(job.id); }
        if (op) { const r = ensureOD(date, op); r[field] += qty; r.jobs.add(job.id); }
      };
      // Legacy attribution: latest byline per date, computed only if we
      // actually need it below (a field lacks entries[]).
      let legacyByDate = null;
      const computeLegacyByDate = () => {
        if (legacyByDate) return legacyByDate;
        legacyByDate = new Map(); // date -> { ms, mc, op }
        for (const le of log) {
          if (!le || !le.by) continue;
          const eDate = logTimeToISODate(le.time);
          if (!eDate || eDate < from || eDate > to) continue;
          if (parseByStage(le.by) !== stageLabel) continue;
          const m = String(le.time || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
          const ms = m ? new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0)).getTime() : 0;
          const cur = legacyByDate.get(eDate);
          if (!cur || ms >= cur.ms) {
            legacyByDate.set(eDate, { ms, mc: parseByMachine(le.by), op: parseByOperator(le.by) });
          }
        }
        return legacyByDate;
      };

      // Sheets and waste are handled INDEPENDENTLY — one can be new-style
      // while the other stays legacy (e.g. operator re-entered sheets
      // through the tablet but waste was only ever typed on the card).
      // Processing them separately keeps the legacy side from being
      // silently dropped when only one field flipped to entries[].
      if (hasSheetEntries) {
        for (const e of sheetsField.entries) {
          if (!e) continue;
          const n = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
          if (!Number.isFinite(n) || n === 0) continue;
          let mc = String(e.machine || '').trim();
          if (!mc && isPrinting && job.machine) mc = job.machine;
          bump(mc, String(e.operator || '').trim(), e.date, 'sheets', n);
        }
      } else if (sheetsField && sheetsField.quantity) {
        const perDate = computeLegacyByDate();
        for (const [eDate, { mc, op }] of perDate) {
          const n = qtyForDate(sheetsField, eDate);
          if (n) bump(mc, op, eDate, 'sheets', n);
        }
      }
      if (hasWasteEntries) {
        for (const e of wasteField.entries) {
          if (!e) continue;
          const n = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
          if (!Number.isFinite(n) || n === 0) continue;
          let mc = String(e.machine || '').trim();
          if (!mc && isPrinting && job.machine) mc = job.machine;
          bump(mc, String(e.operator || '').trim(), e.date, 'waste', n);
        }
      } else if (wasteField && wasteField.quantity) {
        const perDate = computeLegacyByDate();
        for (const [eDate, { mc, op }] of perDate) {
          const n = qtyForDate(wasteField, eDate);
          if (n) bump(mc, op, eDate, 'waste', n);
        }
      }
    }
    // Coatings: sheets AND waste come from the date+machine-stamped
    // entries (coating_sheets_qty / uv_waste_sheets) — same per-day source
    // the Daily Coatings report uses — so the two reports always agree.
    // Sheets used to be excluded here from the days they were derived by
    // formula from Printing's number (counting the copy would have
    // double-counted); now the coating operator types their own count, so
    // it's first-hand machine workload and belongs in the report. Badge
    // waste_sheets carries a RUNNING total per finish, so summing badges
    // both double-counted and dumped everything on the badge date —
    // badges only count jobs/operators, plus waste for legacy jobs
    // without entries.
    const creditCoatingEntries = (entries, field) => {
      for (const e of entries) {
        if (!e || !e.date || e.date < from || e.date > to) continue;
        const mc = String(e.machine || '').trim();
        const op = String(e.operator || '').trim();
        const v = parseInt(String(e.qty || '').replace(/[^0-9-]/g, ''), 10);
        if (!Number.isFinite(v) || v === 0) continue;
        if (mc) { const r = ensureMD(e.date, mc); r[field] += v; r.jobs.add(job.id); }
        if (op) { const r = ensureOD(e.date, op); r[field] += v; r.jobs.add(job.id); }
      }
    };
    const csPart = part.coating_sheets_qty;
    const coatSheetEntries = csPart && Array.isArray(csPart.entries) && csPart.entries.length ? csPart.entries : null;
    if (coatSheetEntries) creditCoatingEntries(coatSheetEntries, 'sheets');
    const wfPart = part.uv_waste_sheets;
    const wasteEntries = wfPart && Array.isArray(wfPart.entries) && wfPart.entries.length ? wfPart.entries : null;
    if (wasteEntries) creditCoatingEntries(wasteEntries, 'waste');
    const coatings = Array.isArray(job.coatings_done) ? job.coatings_done : [];
    for (const c of coatings) {
      if (!c) continue;
      const cDate = isoTsToDate(c.done_at);
      if (!cDate || cDate < from || cDate > to) continue;
      const w = wasteEntries ? 0 : (parseInt(String(c.waste_sheets || '').replace(/[^0-9-]/g, ''), 10) || 0);
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
    if (!userHasRole(req.user, 'admin', 'production_manager', 'store_manager')) return res.status(403).json({ error: 'Not allowed' });
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
    if (!userHasRole(req.user, 'admin', 'production_manager', 'store_manager')) return res.status(403).json({ error: 'Not allowed' });
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

// ── Client portal ──────────────────────────────────────────────
// Returns ONLY the jobs a client is allowed to see, with ONLY the
// fields the client should ever see. Every filter is enforced here
// so nothing from the client side can widen the view:
//   1. Row belongs to the client's company (case-insensitive match
//      of jobs.client against user.client_company).
//   2. client_visible = true — PM explicitly opted this job in.
//   3. NOT soft-deleted, NOT blocked at its current stage.
//   4. Delivered ≤ 2 calendar days ago (or still in production).
//      Older delivered jobs drop off the portal automatically.
//
// Paper type is resolved from jobs.paper when present, else from
// the linked inventory item's paper_type — never the brand, so the
// client sees the paper spec, not the storekeeper's brand choice.
// Coatings are exposed as [{name, done}] pairs derived from
// coatings_done, so the portal can render per-coating pills.
// Shared: returns exactly the projected job list a client bound to
// `company` would see. Called by /api/client/jobs (real clients) AND
// /api/admin/client-view (admin previewing what a client sees).
// Keeping both endpoints on the same helper guarantees the admin
// preview never drifts from what the real client sees.
async function buildClientJobsView(sql, companyRaw, opts) {
  opts = opts || {};
  const includeHidden = !!opts.includeHidden;
  const company = String(companyRaw || '').trim().toLowerCase();
  if (!company) return [];
  // Admin's Client View passes includeHidden=true so admin can see AND
  // toggle every job for the company. Real client callers never do —
  // they only see rows where client_visible=true.
  const rows = includeHidden
    ? await sql`
        SELECT
          j.id, j.name, j.client, j.ref, j.bno, j.jobcode, j.stage_index, j.machine,
          j.paper, j.coatings, j.coatings_done, j.dateissued, j.deadline,
          j.size, j.ups, j.sheets, j.qty, j.cartonqty, j.delqty,
          j.priority, j.stages, j.issuance_status, j.client_visible,
          j.stock_group_visible,
          j.cut_size, j.offcut_size, j.is_shade_card, j.deleted_at,
          j.linked_job_id, j.deliveries, j.stock_group_name, j.particulars,
          inv.paper_type AS inv_paper_type
        FROM jobs j
        LEFT JOIN inventory_items inv ON inv.id = j.inventory_item_id
        WHERE j.deleted_at IS NULL
          AND LOWER(TRIM(j.client)) = ${company}
        ORDER BY j.id DESC`
    : await sql`
        SELECT
          j.id, j.name, j.client, j.ref, j.bno, j.jobcode, j.stage_index, j.machine,
          j.paper, j.coatings, j.coatings_done, j.dateissued, j.deadline,
          j.size, j.ups, j.sheets, j.qty, j.cartonqty, j.delqty,
          j.priority, j.stages, j.issuance_status, j.client_visible,
          j.stock_group_visible,
          j.cut_size, j.offcut_size, j.is_shade_card, j.deleted_at,
          j.linked_job_id, j.deliveries, j.stock_group_name, j.particulars,
          inv.paper_type AS inv_paper_type
        FROM jobs j
        LEFT JOIN inventory_items inv ON inv.id = j.inventory_item_id
        WHERE j.deleted_at IS NULL
          AND LOWER(TRIM(j.client)) = ${company}
          AND (
            (j.stock_group_name IS NULL AND j.client_visible = true)
            OR (j.stock_group_name IS NOT NULL AND j.stock_group_visible = true)
          )
        ORDER BY j.id DESC`;
  const now = Date.now();
  const cutoffMs = 3 * 24 * 60 * 60 * 1000;
  const parseDeliveredAt = (stages) => {
    const s7 = stages && stages['7'];
    if (!s7 || s7.status !== 'done') return null;
    if (s7.at) {
      const t = Date.parse(s7.at);
      if (Number.isFinite(t)) return t;
    }
    // Legacy fallback: "dd/mm/yyyy hh:mm" (PKT). Parse loosely.
    const m = String(s7.time || '').match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (m) {
      const [_, dd, mm, yyyy, hh='0', mi='0'] = m;
      // PKT is UTC+5; convert display time back to UTC for comparison.
      const utc = Date.UTC(+yyyy, +mm - 1, +dd, +hh - 5, +mi);
      return Number.isFinite(utc) ? utc : null;
    }
    return null;
  };
  // Blocked jobs are now INCLUDED in the client view (per user request) —
  // clients need to see when a job is blocked and why. Delivered jobs
  // still drop off after 2 days.
  const filtered = rows.filter(r => {
    const deliveredAt = parseDeliveredAt(r.stages);
    if (deliveredAt !== null && (now - deliveredAt) > cutoffMs) return false;
    return true;
  });
  const coatingsList = j => Array.isArray(j.coatings) ? j.coatings : [];
  const coatingsDoneKinds = j => new Set(
    (Array.isArray(j.coatings_done) ? j.coatings_done : [])
      .map(x => (x && x.kind) ? String(x.kind).toLowerCase() : null)
      .filter(Boolean)
  );
  // Sanitize stages before sending — strip operator identity and
  // timestamps. Notes are kept ONLY on the currently-blocked stage
  // (that's the block reason, which the client is supposed to see);
  // notes on other stages are still stripped for privacy.
  const sanitizeStages = (stages, currentSi) => {
    if (!stages || typeof stages !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(stages)) {
      if (v && typeof v === 'object') {
        const isBlockedCurrent = v.status === 'blocked' && String(k) === String(currentSi);
        out[k] = {
          status: v.status || undefined,
          time: v.time || undefined,
          notes: isBlockedCurrent ? (v.notes || '') : undefined,
        };
      }
    }
    return out;
  };
  return filtered.map(j => {
    // Projected shape mirrors an internal job row so the same
    // renderJobCard() renderer can consume it directly on the client.
    // Nothing sensitive is included: no inventory_item_id, no particulars,
    // no print_count / last_printed_at, no coatings_done, no created_at,
    // no issued_at / issued_by_id, no deleted_at.
    return {
      id: j.id,
      name: j.name,
      client: j.client,
      jobcode: j.jobcode || null,
      ref: j.ref || null,
      bno: j.bno || null,
      dateissued: j.dateissued || null,
      deadline: j.deadline || null,
      size: j.size || null,
      ups: j.ups || null,
      sheets: j.sheets || null,
      qty: j.qty || null,
      paper: j.paper || j.inv_paper_type || null,
      machine: j.machine || null,
      coatings: coatingsList(j),
      priority: j.priority || 'Normal',
      delqty: j.delqty || null,
      cartonqty: j.cartonqty || null,
      cut_size: j.cut_size || null,
      offcut_size: j.offcut_size || null,
      stage_index: j.stage_index || 0,
      stages: sanitizeStages(j.stages, j.stage_index || 0),
      issuance_status: j.issuance_status || 'issued',
      client_visible: !!j.client_visible,
      stock_group_visible: !!j.stock_group_visible,
      // Minimal particulars — ONLY the two qty fields the client tile
      // needs for READY / partial-ready chips. Everything else in
      // particulars (paper specs, colors, weights, brand, etc.) stays
      // server-side.
      particulars: (() => {
        const p = j.particulars || {};
        const out = {};
        if (p.delivered_cartons_qty) {
          out.delivered_cartons_qty = {
            quantity: p.delivered_cartons_qty.quantity || '',
            entries: Array.isArray(p.delivered_cartons_qty.entries)
              ? p.delivered_cartons_qty.entries.map(e => ({ qty: (e && e.qty) || '' }))
              : undefined,
          };
        }
        if (p.pasted_cartons_qty) {
          out.pasted_cartons_qty = {
            quantity: p.pasted_cartons_qty.quantity || '',
            entries: Array.isArray(p.pasted_cartons_qty.entries)
              ? p.pasted_cartons_qty.entries.map(e => ({ qty: (e && e.qty) || '' }))
              : undefined,
          };
        }
        return out;
      })(),
      is_shade_card: !!j.is_shade_card,
      // Linked Jobs — lets the client see from the start that this order
      // is tied to another one (same product, printed together). Only the
      // id rides through; the client tile resolves it to the OTHER job's
      // PO number, which is what the client actually recognises.
      linked_job_id: j.linked_job_id || null,
      stock_group_name: j.stock_group_name || null,
      // Per-shipment breakdown for the client tile. Operator identity is
      // stripped (clients don't need to see who recorded it) but cartons,
      // date, and any notes ride through so the client sees the same
      // running ledger the admin sees.
      deliveries: (Array.isArray(j.deliveries) ? j.deliveries : []).map(d => ({
        cartons:  d && d.cartons  || '',
        date:     d && d.date     || '',
        notes:    d && d.notes    || '',
        po_no:    d && d.po_no    || '',
        batch_no: d && d.batch_no || '',
        linked_job_id: d && d.linked_job_id || null,
      })),
      // Slim particulars slice — only the rows the client tile needs:
      //   pasted_cartons_qty       → partial-ready detection + fallback
      //   delivered_cartons_qty    → 'Ready to Delivery Qty' cartons value
      //   ready_packets_qty        → 'Ready to Delivery Qty' packets value
      // (both delivered/packets rows may be pipe-joined for multi-pass
      // entries; the client tile joins them the same way the job card does)
      // All other particulars stay server-side (internal production data).
      particulars: (() => {
        const src = j.particulars || {};
        const slim = {};
        const slice = (row) => ({
          quantity: (row && row.quantity) || '',
          entries: Array.isArray(row && row.entries)
            ? row.entries.map(e => ({ qty: (e && e.qty) || '' }))
            : undefined,
        });
        if (src.pasted_cartons_qty)    slim.pasted_cartons_qty    = slice(src.pasted_cartons_qty);
        if (src.delivered_cartons_qty) slim.delivered_cartons_qty = slice(src.delivered_cartons_qty);
        if (src.ready_packets_qty)     slim.ready_packets_qty     = slice(src.ready_packets_qty);
        return slim;
      })(),
      // Belt-and-braces: pre-computed pasted-ready total so the client
      // tile doesn't need to reconstruct it from particulars. Used by
      // isPartialReady as a fallback if particulars is empty.
      pasted_ready_cartons: (() => {
        const p = j.particulars && j.particulars.pasted_cartons_qty;
        if (!p) return 0;
        if (Array.isArray(p.entries) && p.entries.length) {
          return p.entries.reduce((a, e) => {
            const n = parseFloat(String((e && e.qty) || '').replace(/[^0-9.\-]/g, ''));
            return a + (Number.isFinite(n) ? n : 0);
          }, 0);
        }
        return String(p.quantity || '').split('|').reduce((a, s) => {
          const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
          return a + (Number.isFinite(n) ? n : 0);
        }, 0);
      })(),
    };
  });
}

app.get('/api/client/jobs', requireClient, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const projected = await buildClientJobsView(sql, req.user.client_company);
    res.json(projected);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Admin preview of the client portal. Same helper, so what the admin
// sees IS what the client would see. Gated to internal roles that
// already have full read access (admin, PM, CEO); operator + store
// manager are excluded since neither has a legitimate reason to
// review client-facing state. `company` param is required — no
// default so the admin can't accidentally reveal the wrong client's
// jobs from a saved link.
app.get('/api/admin/client-view', requireAuth, async (req, res) => {
  if (!userHasRole(req.user, 'admin', 'production_manager', 'ceo')) {
    return res.status(403).json({ error: 'Admin / Production Manager / CEO only' });
  }
  try {
    await dbReady;
    const sql = getDb();
    const company = String(req.query.company || '').trim();
    if (!company) return res.status(400).json({ error: 'company query param required' });
    // includeHidden so the admin can see AND toggle every job for the
    // company — hidden ones render dimmed on the client tile.
    const projected = await buildClientJobsView(sql, company, { includeHidden: true });
    res.json(projected);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Lightweight toggle used by the admin Client View tile so the admin
// can flip client_visible without opening the full job edit modal.
// Admin / PM only — CEO is read-only, so the toggle isn't shown to
// them client-side and the server rejects them here too.
app.post('/api/jobs/:id/client-visible', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const value = !!(req.body && req.body.value);
    const updated = await sql`
      UPDATE jobs SET client_visible = ${value}
       WHERE id = ${id} AND deleted_at IS NULL
       RETURNING id, name, client, client_visible
    `;
    if (!updated.length) return res.status(404).json({ error: 'Job not found' });
    await logAudit(sql, req, {
      action: 'job.client_visible',
      entityType: 'job',
      entityId: id,
      summary: `Job E-${id} (${updated[0].name}): client_visible → ${value ? 'ON' : 'OFF'} for ${updated[0].client}`,
    });
    res.json(updated[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Group-level client visibility toggle. Sets stock_group_visible on ALL
// members of the group at once (they must agree — the group is one
// visibility unit). Independent from per-job client_visible.
app.post('/api/groups/client-visible', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const name = String((req.body && req.body.name) || '').trim();
    const value = !!(req.body && req.body.value);
    if (!name) return res.status(400).json({ error: 'name required' });
    // Turning the group ON also flips client_visible=true on every member,
    // so the client can immediately see them in the View Jobs modal without
    // admin having to tick each one. Turning OFF only flips group visibility
    // and leaves per-job client_visible alone (admin's earlier per-job
    // choices are preserved for next time).
    const updated = value
      ? await sql`
          UPDATE jobs SET stock_group_visible = true, client_visible = true
           WHERE stock_group_name = ${name} AND deleted_at IS NULL
           RETURNING id
        `
      : await sql`
          UPDATE jobs SET stock_group_visible = false
           WHERE stock_group_name = ${name} AND deleted_at IS NULL
           RETURNING id
        `;
    await logAudit(sql, req, {
      action: 'group.client_visible',
      entityType: 'group',
      entityId: null,
      summary: `Group "${name}": stock_group_visible → ${value ? 'ON' : 'OFF'} (${updated.length} jobs)`,
    });
    res.json({ ok: true, updated: updated.length });
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
const REAM_PAPERS = new Set(['art paper', 'off-white', 'offset paper']);
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
async function applyInventoryChange(sql, { itemId, change, reason, jobId, notes, user, reversesTxId, challanNo }) {
  if (!itemId || !change) return null;
  if (change < 0) {
    const [item] = await sql`SELECT current_balance FROM inventory_items WHERE id = ${itemId}`;
    const bal = item ? parseFloat(item.current_balance) || 0 : 0;
    if (bal + change < 0) throw new Error(`Insufficient stock: only ${bal} sheets available, cannot deduct ${Math.abs(change)}`);
  }
  const userId    = user && user.id    ? user.id    : null;
  const userEmail = user && user.email ? user.email : null;
  const challan   = challanNo && String(challanNo).trim() ? String(challanNo).trim() : null;
  const inserted = await sql`
    INSERT INTO inventory_transactions (item_id, change, reason, job_id, notes, user_id, user_email, reverses_tx_id, challan_no)
    VALUES (${itemId}, ${change}, ${reason}, ${jobId || null}, ${notes || null}, ${userId}, ${userEmail}, ${reversesTxId || null}, ${challan})
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
    let { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id, cut_size, offcut_size, is_shade_card, client_visible } = req.body;
    // Case rule (v2026-07-13): name and client are stored lowercase so
    // "Fenbro" / "FENBRO" / "fenbro" all collapse to one canonical value
    // in searches, dropdowns, and reports.
    if (name)   name   = String(name).trim().toLowerCase();
    if (client) client = String(client).trim().toLowerCase();
    // Newly-created jobs land in issuance_status='new' — they show up
    // in the "New Jobs" tab for the Production Manager (or Admin) to
    // review, and are NOT visible to the store keeper yet. Clicking
    // "Process to CTP" on the card flips them to 'pending' so the
    // store keeper's Pending Stock queue picks them up. Stock is only
    // deducted after that, via POST /api/jobs/:id/issue-stock.
    const result = await sql`
      INSERT INTO jobs (name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id, cut_size, offcut_size, is_shade_card, client_visible, issuance_status)
      VALUES (${name}, ${client}, ${jobcode||null}, ${ref||null}, ${dateissued||null}, ${deadline||null}, ${size||null}, ${ups||null}, ${sheets||null}, ${qty||null}, ${paper||null}, ${machine||null}, ${coatings||[]}, ${priority||'Normal'}, ${delqty||null}, ${cartonqty||null}, ${notes||null}, ${bno||null}, ${mfgdate||null}, ${expdate||null}, ${mrp||null}, ${JSON.stringify(particulars||{})}, ${inventory_item_id||null}, ${cut_size||null}, ${offcut_size||null}, ${!!is_shade_card}, ${!!client_visible}, 'new')
      RETURNING *
    `;
    const job = result[0];
    await logAudit(sql, req, { action: 'job.create', entityType: 'job', entityId: job.id, summary: `Created Job E-${job.id}: ${job.name} (${job.client}) — new job (awaiting Process to CTP)` });
    res.json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Flip a job from New Jobs into the production queue. Only meaningful
// for status='new'; anything else is idempotent-refused. After this
// runs the job shows up in Pending Stock for the store keeper.
// New Job -> CTP queue. The job stays at stage 0 (CTP Plate Making) but
// now sits in its OWN tab so the CTP operator can pick it up and start
// making plates BEFORE paper is ordered/issued. Only advances to Pending
// Stock once CTP is done (see process-from-ctp / station-update below).
app.post('/api/jobs/:id/process-to-ctp', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT id, name, issuance_status FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status !== 'new') {
      return res.status(400).json({ error: `Job E-${id} is already in the production queue (status: ${job.issuance_status}).` });
    }
    const updated = await sql`
      UPDATE jobs SET issuance_status='ctp' WHERE id=${id} RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.process_to_ctp',
      entityType: 'job',
      entityId: id,
      summary: `Processed Job E-${id}: ${job.name} to CTP — now in CTP queue`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Pending Stock -> CTP (undo). Puts a job that was just processed out of
// CTP back into the CTP queue. Only allowed while the job hasn't actually
// entered production yet — status must be 'pending' (stock not issued) AND
// stage_index must be 1 (Printing, the stage process-from-ctp leaves it
// at). Once paper is issued or the Printing operator has recorded anything
// we refuse — reverting then would silently discard downstream state.
app.post('/api/jobs/:id/move-back-to-ctp', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT id, name, issuance_status, stage_index, stages, log FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status !== 'pending' || (job.stage_index || 0) > 1) {
      return res.status(400).json({ error: `Job E-${id} can only be moved back to CTP from Pending Stock (before paper is issued).` });
    }
    const stages = (job.stages && typeof job.stages === 'object') ? { ...job.stages } : {};
    const log = Array.isArray(job.log) ? [...job.log] : [];
    const time = businessStamp();
    const nowIso = new Date().toISOString();
    const by = `${(req.user && req.user.name) || 'Manager'} (CTP)`;
    // Undo the process-from-ctp side-effects: clear the fresh Printing
    // stage entry, mark CTP active again, log the reversal.
    delete stages[1];
    stages[0] = { ...(stages[0] || {}), status: 'active', by, time, at: nowIso, notes: 'Reopened for CTP work' };
    log.push({ stage: STAGES[0], status: 'active', notes: `Moved back to CTP by ${by}`, by, time });
    const updated = await sql`
      UPDATE jobs
         SET issuance_status='ctp',
             stage_index=0,
             stages=${JSON.stringify(stages)},
             log=${JSON.stringify(log)}
       WHERE id=${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.move_back_to_ctp',
      entityType: 'job',
      entityId: id,
      summary: `Moved Job E-${id}: ${job.name} back to CTP from Pending Stock`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Send a job back to the CTP queue from ANY stage. Used by the pipeline
// pill click on the job tile — admin/PM only. Broader than move-back-to-
// ctp (which is gated to Pending Stock at stage <= 1) because this one
// is a deliberate "reset back to CTP" action from anywhere in production.
// Ledger untouched (mirrors paper-swap flow); store keeper handles any
// physical paper return manually.
app.post('/api/jobs/:id/move-to-ctp', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT id, name, issuance_status, stage_index, stages, log, particulars FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status === 'new' || job.issuance_status === 'ctp') {
      return res.status(400).json({ error: `Job E-${id} is already at CTP.` });
    }
    const time = businessStamp();
    const nowIso = new Date().toISOString();
    const by = `${(req.user && req.user.name) || 'Manager'} (CTP)`;
    // Reset stages: keep nothing past CTP (all downstream work must be
    // redone once the job comes back through Pending Stock + Printing).
    const stages = { 0: { status: 'active', by, time, at: nowIso, notes: 'Sent back to CTP from pipeline pill' } };
    const log = Array.isArray(job.log) ? [...job.log] : [];
    log.push({ stage: STAGES[0], status: 'active', notes: `Moved back to CTP by ${by} (from ${STAGES[job.stage_index || 0]})`, by, time });
    // Clear the partial-issuance marker too — anything held over from the
    // previous issuance is stale once the job resets.
    const cleanP = { ...(job.particulars || {}) };
    delete cleanP.partial_pending_sheets;
    const updated = await sql`
      UPDATE jobs
         SET issuance_status='ctp',
             stage_index=0,
             stages=${JSON.stringify(stages)},
             log=${JSON.stringify(log)},
             issued_items='[]'::jsonb,
             coatings_done='[]'::jsonb,
             particulars=${JSON.stringify(cleanP)},
             issued_at=NULL,
             issued_by_id=NULL
       WHERE id=${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.move_to_ctp',
      entityType: 'job',
      entityId: id,
      summary: `Moved Job E-${id}: ${job.name} back to CTP from ${STAGES[job.stage_index || 0]}. Ledger untouched — store keeper handles any manual return.`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Send a job back to Pending Stock from any downstream stage. Same idea
// as move-to-ctp but stops one step further along the pipeline:
// stage_index=1 (Printing), issuance_status='pending'. Used by the
// Pending Stock pipeline pill on the job tile. Ledger untouched.
app.post('/api/jobs/:id/move-to-pending-stock', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT id, name, issuance_status, stage_index, stages, log, particulars FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status === 'new' || job.issuance_status === 'ctp') {
      return res.status(400).json({ error: `Job E-${id} must be past CTP before it can move to Pending Stock (use Process to Printing).` });
    }
    if (job.issuance_status === 'pending' && (job.stage_index || 0) === 1) {
      return res.status(400).json({ error: `Job E-${id} is already in Pending Stock.` });
    }
    const time = businessStamp();
    const nowIso = new Date().toISOString();
    const by = `${(req.user && req.user.name) || 'Manager'} (Pipeline)`;
    // Keep the CTP-done marker, everything from stage 1 onwards is reset.
    const oldStages = (job.stages && typeof job.stages === 'object') ? job.stages : {};
    const stages = {};
    if (oldStages[0]) stages[0] = oldStages[0];
    else stages[0] = { status: 'done', by, time, at: nowIso };
    const log = Array.isArray(job.log) ? [...job.log] : [];
    log.push({ stage: 'Pending Stock', status: 'active', notes: `Sent back to Pending Stock by ${by} (from ${STAGES[job.stage_index || 0]})`, by, time });
    const cleanP = { ...(job.particulars || {}) };
    delete cleanP.partial_pending_sheets;
    const updated = await sql`
      UPDATE jobs
         SET issuance_status='pending',
             stage_index=1,
             stages=${JSON.stringify(stages)},
             log=${JSON.stringify(log)},
             issued_items='[]'::jsonb,
             coatings_done='[]'::jsonb,
             particulars=${JSON.stringify(cleanP)},
             issued_at=NULL,
             issued_by_id=NULL
       WHERE id=${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.move_to_pending_stock',
      entityType: 'job',
      entityId: id,
      summary: `Moved Job E-${id}: ${job.name} back to Pending Stock from ${STAGES[job.stage_index || 0]}. Ledger untouched — store keeper handles any manual return.`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// CTP -> Printing / Pending Stock. Marks CTP (stage 0) as done, advances
// stage_index to 1 (Printing), and flips issuance_status to 'pending' so
// the store keeper sees the job in Pending Stock (waiting for paper). Two
// callers exercise this transition:
//   * PM clicks "Process to Printing" on the CTP-tab job card (this endpoint)
//   * CTP operator at Station clicks Save & Done on the plate-making
//     screen — that path lives inside /api/jobs/:id/station-update and
//     applies the same status/stage flip when the source status is 'ctp'.
app.post('/api/jobs/:id/process-from-ctp', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT id, name, issuance_status, stage_index, stages, log FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status !== 'ctp') {
      return res.status(400).json({ error: `Job E-${id} is not in the CTP queue (status: ${job.issuance_status}).` });
    }
    const stages = (job.stages && typeof job.stages === 'object') ? { ...job.stages } : {};
    const log = Array.isArray(job.log) ? [...job.log] : [];
    const time = businessStamp();
    const nowIso = new Date().toISOString();
    const by = `${(req.user && req.user.name) || 'Manager'} (CTP)`;
    stages[0] = { ...(stages[0] || {}), status: 'done', by, time, at: nowIso, notes: 'CTP plates finished (marked by manager)' };
    // Advance to stage 1 (Printing) but leave that stage in a fresh
    // "pending stock" state — the Printing operator can only start once
    // the store keeper issues paper, same rule as before.
    stages[1] = { ...(stages[1] || {}), status: 'active', by, time, at: nowIso };
    log.push({ stage: STAGES[0], status: 'done', notes: `CTP done by ${by} — moved to Pending Stock / Printing`, by, time });
    const updated = await sql`
      UPDATE jobs
         SET issuance_status='pending',
             stage_index=1,
             stages=${JSON.stringify(stages)},
             log=${JSON.stringify(log)}
       WHERE id=${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.process_from_ctp',
      entityType: 'job',
      entityId: id,
      summary: `CTP done for Job E-${id}: ${job.name} — moved to Pending Stock / Printing`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// UPDATE job details
app.put('/api/jobs/:id', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    let { name, client, jobcode, ref, dateissued, deadline, size, ups, sheets, qty, paper, machine, coatings, priority, delqty, cartonqty, notes, bno, mfgdate, expdate, mrp, particulars, inventory_item_id, cut_size, offcut_size, is_shade_card, client_visible } = req.body;
    if (name)   name   = String(name).trim().toLowerCase();
    if (client) client = String(client).trim().toLowerCase();

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
        cut_size=${cut_size||null}, offcut_size=${newOffcutSize},
        is_shade_card=${!!is_shade_card},
        client_visible=${!!client_visible}
      WHERE id=${id} RETURNING *
    `;
    const job = result[0];

    // Paper swap after issuance = re-issuance REQUEST, not auto-adjustment.
    // Per shop rule: production physically holds the old paper (already cut
    // to size, offcut already generated), so the ledger for the OLD paper
    // stays exactly as it was. Store keeper enters any manual return by
    // hand when production hands unused sheets back.
    //
    // What we DO change on paper swap:
    //   - Flip issuance_status → 'pending' so the job re-appears in the
    //     Pending Stock queue with the NEW paper.
    //   - Clear issued_items so the fresh issuance starts clean.
    //   - Clear any stale partial_pending_sheets marker.
    //   - Leave stage_index untouched — job stays where it is (usually
    //     Printing) and the operator carries on with the sheets they
    //     already have while store keeper prepares the new issuance.
    const paperItemChanged = (oldItemId !== newItemId);
    if (wasIssued && paperItemChanged) {
      const cleanP = { ...(job.particulars || {}) };
      delete cleanP.partial_pending_sheets;
      const updated2 = await sql`
        UPDATE jobs
           SET issuance_status = 'pending',
               issued_items    = '[]'::jsonb,
               particulars     = ${JSON.stringify(cleanP)}
         WHERE id = ${job.id}
         RETURNING *
      `;
      Object.assign(job, updated2[0]);
      await logAudit(sql, req, {
        action: 'job.paper_change_reissue',
        entityType: 'job',
        entityId: job.id,
        summary: `Paper changed on Job E-${job.id} after issuance — sent back to Pending Stock for re-issuance. Old paper ledger left untouched; store keeper must enter any manual return.`,
      });
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
// Issue stock — brand-agnostic paper groups.
//
// PM picks a paper GROUP on the job (paper_type + size + gsm + is_offcut).
// Store keeper decides which brand(s) to actually pull from at issue time.
//
// Payload: { splits: [{ item_id, sheets }, ...] }
//   - Each split must live in the SAME paper group as the job's
//     representative inventory_item_id.
//   - Total sheets across splits must not exceed the job's need.
//   - If total < need, the job is flagged partially issued
//     (particulars.partial_pending_sheets) — same marker manual
//     inventory issuance already uses, so Pending Stock still surfaces
//     the shortfall.
//   - If splits is omitted (empty body), fall back to full issuance
//     from job.inventory_item_id (backwards-compat with existing UIs).
//
// A per-split offcut is created when the job has a cut configured — the
// Dismiss pending stock for a delivered job. Admin-only. Clears the
// issuance_status to 'issued' and removes any partial_pending_sheets
// so the job drops out of the pending queue.
app.post('/api/jobs/:id/dismiss-pending', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT * FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const lastStage = STAGES.length - 1;
    const delivered = job.stages && job.stages[lastStage] && job.stages[lastStage].status === 'done';
    if (!delivered) return res.status(400).json({ error: 'Can only dismiss pending stock for delivered jobs.' });
    const p = { ...(job.particulars || {}) };
    delete p.partial_pending_sheets;
    await sql`UPDATE jobs SET issuance_status = 'issued', particulars = ${JSON.stringify(p)} WHERE id = ${id}`;
    await logAudit(sql, req, {
      action: 'job.dismiss_pending',
      entityType: 'job',
      entityId: id,
      summary: `Dismissed pending stock for delivered job E-${id}`,
    });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// offcut brand matches the source brand for that split.
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
    const challanNo = (req.body && typeof req.body.challan_no === 'string')
      ? (req.body.challan_no.trim() || null)
      : null;
    // Resolve the paper GROUP from the job's representative item. The
    // group is (paper_type, size, gsm, is_offcut). Every accepted split
    // must live in this group.
    const anchorRows = await sql`SELECT * FROM inventory_items WHERE id = ${job.inventory_item_id}`;
    const anchor = anchorRows[0];
    if (!anchor) return res.status(400).json({ error: 'Assigned paper item no longer exists.' });
    const paperType = anchor.paper_type || '';
    const needSheets = jobDeductionSheets({ paperType, particulars: job.particulars });
    if (needSheets <= 0) {
      return res.status(400).json({ error: 'Job has no Quantity of Packets — set the packets count on the job, then try again. (Inventory is deducted in raw packets/reams.)' });
    }
    // Parse & validate splits (or synthesize the single-brand fallback).
    const rawSplits = Array.isArray(req.body && req.body.splits) ? req.body.splits : null;
    let splits;
    if (rawSplits && rawSplits.length) {
      splits = rawSplits
        .map(s => ({ item_id: parseInt(s.item_id, 10), sheets: parseInt(s.sheets, 10) }))
        .filter(s => Number.isFinite(s.item_id) && Number.isFinite(s.sheets) && s.sheets > 0);
      if (!splits.length) return res.status(400).json({ error: 'No valid split rows in payload.' });
    } else {
      // Empty payload → old-style full issuance from the representative.
      splits = [{ item_id: job.inventory_item_id, sheets: needSheets }];
    }
    // Load every source item at once; validate they're all in the same
    // paper group (paper_type + size + gsm + is_offcut) as the anchor.
    const itemIds = [...new Set(splits.map(s => s.item_id))];
    const itemRows = await sql`SELECT * FROM inventory_items WHERE id = ANY(${itemIds})`;
    const itemsById = new Map(itemRows.map(r => [r.id, r]));
    for (const s of splits) {
      const it = itemsById.get(s.item_id);
      if (!it) return res.status(400).json({ error: `Inventory item ${s.item_id} not found.` });
      const sameGroup =
        (it.paper_type || '') === (anchor.paper_type || '') &&
        (it.size || '') === (anchor.size || '') &&
        String(it.gsm || '') === String(anchor.gsm || '') &&
        !!it.is_offcut === !!anchor.is_offcut;
      if (!sameGroup) {
        return res.status(400).json({ error: `Split item "${it.paper_type} · ${it.size || ''} · ${it.gsm || ''}gsm · ${it.brand || 'no brand'}" is not in this job's paper group.` });
      }
    }
    const totalIssued = splits.reduce((a, s) => a + s.sheets, 0);
    const ps   = packetSize(paperType);
    const unit = REAM_PAPERS.has(paperType) ? 'reams' : 'packets';

    // Over-issuance is intentional (store keeper wants to pull 2 packets
    // for a job that only needs 1). The excess goes back to inventory as
    // an offcut item of the SAME size/paper/gsm/brand (whole packets
    // returned) so it stays traceable and separate from fresh stock.
    // Distributed across the splits proportionally, with the last split
    // absorbing the rounding remainder so per-split integers still sum
    // exactly to the total overage.
    const overSheets = Math.max(0, totalIssued - needSheets);
    const perSplitOver = new Array(splits.length).fill(0);
    if (overSheets > 0 && totalIssued > 0) {
      let accounted = 0;
      for (let i = 0; i < splits.length; i++) {
        perSplitOver[i] = (i === splits.length - 1)
          ? overSheets - accounted
          : Math.round((splits[i].sheets / totalIssued) * overSheets);
        accounted += perSplitOver[i];
      }
    }
    const fmtPack = n => Number.isInteger(n) ? n.toString() : (+n.toFixed(2)).toString();

    // Deduct each split; create per-split offcut if the job has a cut.
    // Record the ledger row's brand into issued_items so the app can
    // show all sourced brands at a glance (comma-joined) later.
    const issuedItems = [];
    for (let i = 0; i < splits.length; i++) {
      const s = splits[i];
      const it = itemsById.get(s.item_id);
      const packs = s.sheets / ps;
      const overThis = perSplitOver[i];
      const overPacks = overThis / ps;
      const overNote = overThis > 0
        ? ` · ${fmtPack(overPacks)} ${unit} added to offcut (over-issued)`
        : '';
      await applyInventoryChange(sql, {
        itemId: s.item_id,
        change: -s.sheets,
        reason: 'job-consumed',
        jobId: job.id,
        notes: `Job E-${job.id}${job.jobcode ? ' · ' + job.jobcode : ''}: ${job.name} — ${fmtPack(packs)} ${unit} (${s.sheets} sheets) from ${it.brand || 'no brand'} issued by ${req.user.email}${overNote}`,
        user: req.user,
        challanNo,
      });
      if (job.cut_size && job.offcut_size) {
        const offcutItem = await findOrCreateOffcutItem(sql, it, job.offcut_size);
        await applyInventoryChange(sql, {
          itemId: offcutItem.id,
          change: +s.sheets,
          reason: 'job-offcut',
          jobId: job.id,
          notes: `Job E-${job.id}: ${s.sheets} sheets of ${job.offcut_size} offcut (${it.brand || 'no brand'}) returned to stock`,
          user: req.user,
          challanNo,
        });
      }
      // Over-issuance handling — the auto-offcut credit that used to run
      // here has moved to POST /api/jobs/:id/over-issue/decide. Instead
      // we stash a per-split record and the PM chooses on the job tile:
      //   • Use     → creates an approved packet top-up on the job
      //                (no offcut credit)
      //   • Offcut  → creates the offcut inventory credit that used to
      //                run automatically
      //   • Send Back → logs the return; store keeper does the physical
      //                 return manually
      // Source deduction stays unchanged (still the -s.sheets applied
      // above), so the inventory report keeps recording the extra
      // issuance exactly as before.
      issuedItems.push({ item_id: s.item_id, brand: it.brand || '', sheets: s.sheets });
    }
    // Build the pending decision record from every split that got extras.
    const overIssueSplits = [];
    if (overSheets > 0 && totalIssued > 0) {
      for (let i = 0; i < splits.length; i++) {
        if (perSplitOver[i] <= 0) continue;
        const it = itemsById.get(splits[i].item_id);
        overIssueSplits.push({
          source_item_id: splits[i].item_id,
          brand: (it && it.brand) || null,
          sheets: perSplitOver[i],
          packets: perSplitOver[i] / ps,
        });
      }
    }

    // Update job. Partial issuance: use the existing partial marker so
    // Pending Stock still shows the remaining need. Over-issue counts as
    // fully issued (need was met, extras went to offcut).
    const fullyIssued = totalIssued >= needSheets;
    const remaining = Math.max(0, needSheets - totalIssued);
    const nextParticulars = { ...(job.particulars || {}) };
    if (fullyIssued) delete nextParticulars.partial_pending_sheets;
    else             nextParticulars.partial_pending_sheets = remaining;
    // Over-issue decision pending — PM picks Use / Offcut / Send Back on
    // the job tile. See POST /api/jobs/:id/over-issue/decide.
    if (overIssueSplits.length > 0) {
      nextParticulars.over_issue_pending = {
        id: 'oi' + Date.now() + Math.floor(Math.random() * 1000),
        total_sheets: overSheets,
        total_packets: overSheets / ps,
        unit,
        ps,
        splits: overIssueSplits,
        challan_no: challanNo || null,
        issued_by_email: req.user?.email || null,
        issued_at: new Date().toISOString(),
      };
    }
    // Point inventory_item_id at whichever brand contributed the most —
    // downstream displays that still read from it get the dominant brand
    // rather than an arbitrary one. Any code that wants the full picture
    // reads issued_items directly.
    const primary = [...splits].sort((a, b) => b.sheets - a.sheets)[0];
    // Invariant: any stock issuance (full OR partial) means the job is
    // physically in production — floor operators have real sheets in hand.
    // Stage must be at Printing (stage 1) or beyond. Bump stage_index up
    // from 0 → 1 here so any weird upstream state (manual DB reset, half-
    // issued today/half tomorrow workflow, etc.) auto-corrects on the
    // next issuance instead of leaving the job stuck at CTP.
    const bumpedStage = Math.max(job.stage_index || 0, 1);
    const updated = await sql`
      UPDATE jobs
         SET issuance_status = 'issued',
             issued_at = COALESCE(issued_at, NOW()),
             issued_by_id = COALESCE(issued_by_id, ${req.user.id || null}),
             inventory_item_id = ${primary.item_id},
             stage_index = ${bumpedStage},
             particulars = ${JSON.stringify(nextParticulars)},
             issued_items = (COALESCE(issued_items, '[]'::jsonb) || ${JSON.stringify(issuedItems)}::jsonb)
       WHERE id = ${id}
       RETURNING *
    `;
    const brandList = issuedItems.map(x => x.brand || 'no brand').join(', ');
    await logAudit(sql, req, {
      action: 'job.issue_stock',
      entityType: 'job',
      entityId: id,
      summary: `Issued ${totalIssued} sheets for Job E-${id}: ${job.name} (${brandList})${fullyIssued ? '' : ` · partial (${remaining} sheets still needed)`}${job.cut_size && job.offcut_size ? ` · cut to ${job.cut_size}, ${totalIssued} sheets of ${job.offcut_size} offcut returned` : ''}`,
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
    // Refund every un-reversed job-consumed row for this job — even if
    // stock was split across brands, each row is already recorded per
    // source brand in inventory_transactions, so this loop naturally
    // reverses the whole split. Each refund links back via reverses_tx_id
    // so the report's pair-hiding drops both sides cleanly. Do the same
    // for the (per-source-brand) job-offcut rows.
    const consumedRows = await sql`
      SELECT t.id, t.item_id, t.change FROM inventory_transactions t
      WHERE t.job_id = ${job.id} AND t.reason = 'job-consumed'
        AND t.reverses_tx_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM inventory_transactions r WHERE r.reverses_tx_id = t.id)
      ORDER BY t.id ASC
    `;
    for (const row of consumedRows) {
      await applyInventoryChange(sql, {
        itemId: row.item_id,
        change: -row.change, // change is negative on a consume, so this refunds +N
        reason: 'job-issuance-reversed',
        jobId: job.id,
        notes: `Job E-${job.id}${job.jobcode ? ' · ' + job.jobcode : ''}: issuance reversed by ${req.user.email} — ${Math.abs(row.change)} sheets returned (TX #${row.id})`,
        user: req.user,
        reversesTxId: row.id,
      });
    }
    const offcutRows = await sql`
      SELECT t.id, t.item_id, t.change FROM inventory_transactions t
      WHERE t.job_id = ${job.id} AND t.reason = 'job-offcut'
        AND t.reverses_tx_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM inventory_transactions r WHERE r.reverses_tx_id = t.id)
      ORDER BY t.id ASC
    `;
    for (const row of offcutRows) {
      await applyInventoryChange(sql, {
        itemId: row.item_id,
        change: -row.change,
        reason: 'job-issuance-reversed',
        jobId: job.id,
        notes: `Job E-${job.id}: offcut return reversed by ${req.user.email} — ${Math.abs(row.change)} sheets pulled back (TX #${row.id})`,
        user: req.user,
        reversesTxId: row.id,
      });
    }
    // Clear the partial-issuance marker AND the split-issuance record so
    // the job returns to a clean 'nothing issued' state. Also drop
    // anything that was CREATED BY THIS SPECIFIC ISSUANCE:
    //   • over_issue_pending — the store keeper's over-issue awaiting a
    //     PM decision; that issuance is gone now, so the decision is
    //     moot.
    //   • over_issue_decisions — the archived PM decisions on this
    //     issuance's over-issue.
    //   • packet_topups where source==='over-issue-reconcile' — these
    //     were auto-created by the PM's "Use" click on the pending
    //     over-issue; without the underlying issuance they'd wrongly
    //     inflate the job's packet count (owner report: "still saying
    //     2 top up after reversal").
    // Real manual top-ups (packet_topups without that source flag)
    // stay intact — they were separate PM requests, not tied to this
    // one issuance.
    const cleanParticulars = { ...(job.particulars || {}) };
    delete cleanParticulars.partial_pending_sheets;
    delete cleanParticulars.over_issue_pending;
    delete cleanParticulars.over_issue_decisions;
    if (Array.isArray(cleanParticulars.packets_topups)) {
      cleanParticulars.packets_topups = cleanParticulars.packets_topups
        .filter(t => !t || t.source !== 'over-issue-reconcile');
      if (!cleanParticulars.packets_topups.length) delete cleanParticulars.packets_topups;
    }
    const updated = await sql`
      UPDATE jobs
         SET issuance_status = 'pending',
             issued_at = NULL,
             issued_by_id = NULL,
             particulars = ${JSON.stringify(cleanParticulars)},
             issued_items = '[]'::jsonb
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

// Packets top-up: request extra packets on an already-issued job. The job
// stays 'issued' — this only appends a pending entry in particulars.packets_topups
// so the store-keeper sees it in the Pending Stock queue and can Approve
// (deducts extra) or Reject (no ledger change).
app.post('/api/jobs/:id/packets-topup', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const qty = parseFloat(req.body?.qty);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be a positive number' });
    const rows = await sql`SELECT * FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.issuance_status !== 'issued') return res.status(400).json({ error: 'Job must be already issued before requesting extra packets' });
    const p = job.particulars || {};
    const topups = Array.isArray(p.packets_topups) ? p.packets_topups.slice() : [];
    const entry = {
      id: `t${Date.now()}${Math.floor(Math.random()*1000)}`,
      qty,
      status: 'pending',
      requested_at: new Date().toISOString(),
      requested_by_id: req.user?.id || null,
      requested_by_email: req.user?.email || null,
    };
    topups.push(entry);
    p.packets_topups = topups;
    const updated = await sql`UPDATE jobs SET particulars=${JSON.stringify(p)} WHERE id=${id} RETURNING *`;
    await logAudit(sql, req, {
      action: 'job.packets_topup.request',
      entityType: 'job',
      entityId: id,
      summary: `Requested +${qty} extra packets for Job E-${id}: ${job.name} — pending store-keeper approval`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/:id/packets-topup/:topupId/approve', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const topupId = req.params.topupId;
    const rows = await sql`SELECT * FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const p = job.particulars || {};
    const topups = Array.isArray(p.packets_topups) ? p.packets_topups.slice() : [];
    const idx = topups.findIndex(t => String(t.id) === String(topupId));
    if (idx < 0) return res.status(404).json({ error: 'Top-up request not found' });
    const t = topups[idx];
    if (t.status !== 'pending') return res.status(400).json({ error: `Top-up already ${t.status}` });
    if (!job.inventory_item_id) return res.status(400).json({ error: 'Job has no paper linked — cannot approve' });
    const inv = await sql`SELECT * FROM inventory_items WHERE id=${job.inventory_item_id}`;
    const sourceItem = inv[0];
    const paperType = sourceItem?.paper_type || '';
    const ps = packetSize(paperType);
    const unit = REAM_PAPERS.has(paperType) ? 'reams' : 'packets';
    const sheets = Math.round(parseFloat(t.qty) * ps);
    if (sheets <= 0) return res.status(400).json({ error: 'Top-up qty invalid' });
    await applyInventoryChange(sql, {
      itemId: job.inventory_item_id,
      change: -sheets,
      reason: 'job-consumed',
      jobId: job.id,
      notes: `Job E-${job.id}${job.jobcode ? ' · ' + job.jobcode : ''}: ${job.name} — extra ${t.qty} ${unit} (${sheets} sheets) top-up issued by ${req.user.email}`,
      user: req.user,
    });
    if (job.cut_size && job.offcut_size && sourceItem) {
      const offcutItem = await findOrCreateOffcutItem(sql, sourceItem, job.offcut_size);
      await applyInventoryChange(sql, {
        itemId: offcutItem.id,
        change: +sheets,
        reason: 'job-offcut',
        jobId: job.id,
        notes: `Job E-${job.id}: ${sheets} sheets of ${job.offcut_size} offcut returned to stock (top-up)`,
        user: req.user,
      });
    }
    topups[idx] = { ...t, status: 'approved', approved_at: new Date().toISOString(), approved_by_id: req.user?.id || null, approved_by_email: req.user?.email || null };
    p.packets_topups = topups;
    const updated = await sql`UPDATE jobs SET particulars=${JSON.stringify(p)} WHERE id=${id} RETURNING *`;
    await logAudit(sql, req, {
      action: 'job.packets_topup.approve',
      entityType: 'job',
      entityId: id,
      summary: `Approved +${t.qty} extra packets for Job E-${id}: ${sheets} sheets deducted`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/:id/packets-topup/:topupId/reject', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const topupId = req.params.topupId;
    const rows = await sql`SELECT * FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const p = job.particulars || {};
    const topups = Array.isArray(p.packets_topups) ? p.packets_topups.slice() : [];
    const idx = topups.findIndex(t => String(t.id) === String(topupId));
    if (idx < 0) return res.status(404).json({ error: 'Top-up request not found' });
    const t = topups[idx];
    if (t.status !== 'pending') return res.status(400).json({ error: `Top-up already ${t.status}` });
    topups[idx] = { ...t, status: 'rejected', rejected_at: new Date().toISOString(), rejected_by_email: req.user?.email || null };
    p.packets_topups = topups;
    const updated = await sql`UPDATE jobs SET particulars=${JSON.stringify(p)} WHERE id=${id} RETURNING *`;
    await logAudit(sql, req, {
      action: 'job.packets_topup.reject',
      entityType: 'job',
      entityId: id,
      summary: `Rejected +${t.qty} extra packets request for Job E-${id}`,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Over-issuance decision ───────────────────────────────────────
// When the store keeper issues more sheets than the job needs, the
// extras used to auto-credit an offcut item. Now the job flags an
// over_issue_pending record and the PM (admin / production manager)
// picks what happens to those extras on the job tile:
//   • use     → creates an approved packet top-up on the job so the
//                job's packet count effectively grows by that amount.
//                No inventory movement (sheets were already deducted
//                at issue-stock time).
//   • offcut  → runs the offcut credit that used to happen automatically
//                (per-split findOrCreateOffcutItem + applyInventoryChange).
//   • return  → logs the decision only. Store keeper does the physical
//                return through the normal manual inventory tools.
// The source item's original deduction stays untouched, so the inventory
// report keeps recording the extra issuance exactly as it did before.
app.post('/api/jobs/:id/over-issue/decide', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const decision = String((req.body && req.body.decision) || '').trim();
    if (!['use', 'offcut', 'return'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be use, offcut, or return' });
    }
    const rows = await sql`SELECT * FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const p = { ...(job.particulars || {}) };
    const pending = p.over_issue_pending;
    if (!pending || !Array.isArray(pending.splits)) {
      return res.status(400).json({ error: 'No pending over-issue decision on this job' });
    }
    const unit = pending.unit || 'packets';
    const totalPackets = Number(pending.total_packets) || 0;
    let summary = '';
    if (decision === 'use') {
      const topups = Array.isArray(p.packets_topups) ? p.packets_topups.slice() : [];
      topups.push({
        id: 't' + Date.now() + Math.floor(Math.random() * 1000),
        qty: totalPackets,
        status: 'approved',
        source: 'over-issue-reconcile',
        requested_at: pending.issued_at || new Date().toISOString(),
        requested_by_email: pending.issued_by_email || null,
        approved_at: new Date().toISOString(),
        approved_by_id: req.user?.id || null,
        approved_by_email: req.user?.email || null,
        note: 'Auto-created from PM \"Use\" decision on over-issuance (sheets already deducted at issuance).',
      });
      p.packets_topups = topups;
      summary = `Job E-${id}: over-issued ${totalPackets} ${unit} added to job as approved packet top-up (PM: Use)`;
    } else if (decision === 'offcut') {
      for (const s of pending.splits) {
        if (!s || !s.source_item_id || !(s.sheets > 0)) continue;
        const invRows = await sql`SELECT * FROM inventory_items WHERE id=${s.source_item_id}`;
        if (!invRows.length) continue;
        const it = invRows[0];
        const offcutItem = await findOrCreateOffcutItem(sql, it, it.size || '');
        await applyInventoryChange(sql, {
          itemId: offcutItem.id,
          change: +s.sheets,
          reason: 'job-offcut',
          jobId: id,
          notes: `Job E-${id}: ${s.packets} ${unit} over-issued from ${it.brand || 'no brand'} added to offcut stock (PM: Add to Offcut)`,
          user: req.user,
          challanNo: pending.challan_no || null,
        });
      }
      summary = `Job E-${id}: over-issued ${totalPackets} ${unit} credited to offcut (PM: Add to Offcut)`;
    } else {
      // return — no inventory transaction; ledger note comes from the
      // audit log line below.
      summary = `Job E-${id}: over-issued ${totalPackets} ${unit} marked as returned to store — store keeper handles the physical return (PM: Send Back)`;
    }
    // Archive the decision on the job so the history is inspectable.
    const decisions = Array.isArray(p.over_issue_decisions) ? p.over_issue_decisions.slice() : [];
    decisions.push({
      id: pending.id,
      decision,
      total_sheets: pending.total_sheets,
      total_packets: pending.total_packets,
      unit: pending.unit,
      challan_no: pending.challan_no || null,
      issued_by_email: pending.issued_by_email || null,
      issued_at: pending.issued_at,
      decided_at: new Date().toISOString(),
      decided_by_id: req.user?.id || null,
      decided_by_email: req.user?.email || null,
    });
    p.over_issue_decisions = decisions;
    delete p.over_issue_pending;
    const updated = await sql`UPDATE jobs SET particulars=${JSON.stringify(p)} WHERE id=${id} RETURNING *`;
    await logAudit(sql, req, {
      action: 'job.over_issue.decide',
      entityType: 'job',
      entityId: id,
      summary,
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Partial deliveries ──────────────────────────────────────────
// Large P.O.s often ship out over multiple dates. Each entry in the
// deliveries[] array is one shipment; delqty stays in sync as the sum
// of pieces so old reports/exports keep working. The job auto-advances
// from stage 6 (Ready to Deliver) to stage 7 (Delivered) when the
// running total meets or exceeds the booked P.O. qty.
// Cartons is the ONE unit for deliveries in this shop — 1 carton == 1
// piece in the way the owner counts P.O. qty. So the running total that
// backs delqty is simply the sum of each entry's cartons value.
function sumDeliveryCartons(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((a, d) => {
    const n = parseFloat(String((d && d.cartons) || '').replace(/[^0-9.\-]/g, ''));
    return a + (Number.isFinite(n) ? n : 0);
  }, 0);
}

// Delivery eligibility — same rule everywhere a delivery can be recorded
// (single-job endpoint AND Linked-Jobs joint delivery): from Ready to
// Deliver (6) onward, or from Pasting (5) once the operator has recorded
// some pasted cartons (partial-ready). Returns an error string, or null
// when eligible.
function deliveryEligibilityError(job) {
  const curStage = job.stage_index || 0;
  if (curStage < 5) {
    return `Job E-${job.id} is at stage "${STAGES[curStage]||'?'}" — reach "Ready to Deliver" before recording a delivery.`;
  }
  if (curStage === 5) {
    const pastedRow = (job.particulars && job.particulars.pasted_cartons_qty) || null;
    const pastedFromEntries = pastedRow && Array.isArray(pastedRow.entries)
      ? pastedRow.entries.reduce((a, e) => a + (parseFloat(String((e && e.qty) || '').replace(/[^0-9.\-]/g, '')) || 0), 0)
      : 0;
    const pastedFromQty = pastedRow
      ? String(pastedRow.quantity || '').split('|').reduce((a, s) => a + (parseFloat(String(s).replace(/[^0-9.\-]/g, '')) || 0), 0)
      : 0;
    const pastedReady = pastedFromEntries || pastedFromQty;
    if (pastedReady <= 0) {
      return `Job E-${job.id} is at Pasting with no cartons recorded — record some pasted cartons on the station first.`;
    }
  }
  return null;
}

// Builds the { deliveries, delqty, stage_index, stages, log } fields to
// persist for one delivery entry on one job — shared by the single-job
// delivery endpoint and the Linked-Jobs joint delivery endpoint so the
// two never drift out of sync (auto-advance-to-Delivered logic identical
// in both places).
function computeDeliveryUpdate(job, { cartonsN, date, notes, poNo, batchNo, linkedJobId, byEmail }) {
  const bookedQty  = parseFloat(String(job.qty || '').replace(/[^0-9.\-]/g, '')) || 0;
  const priorTotal = sumDeliveryCartons(job.deliveries);
  const nextTotal  = priorTotal + cartonsN;
  const entry = {
    cartons: String(cartonsN),
    date, notes,
    po_no: poNo,
    batch_no: batchNo,
    by: byEmail || 'unknown',
    at: new Date().toISOString(),
    linked_job_id: linkedJobId || null,
  };
  const deliveries = [...(Array.isArray(job.deliveries) ? job.deliveries : []), entry];
  const nowIso = new Date().toISOString();
  const time   = businessStamp();
  const by     = byEmail || 'unknown';
  let stage_index = job.stage_index || 0;
  let stages = (job.stages && typeof job.stages === 'object') ? { ...job.stages } : {};
  let log = Array.isArray(job.log) ? [...job.log] : [];
  log.push({ stage: STAGES[stage_index], status: stages[stage_index]?.status || 'active',
    notes: `Delivery recorded: ${cartonsN.toLocaleString()} cartons${notes ? ' — ' + notes : ''}`,
    by: `${by} (${STAGES[stage_index] || '?'})`, time });
  if (bookedQty && nextTotal >= bookedQty && stage_index < 7) {
    // Mark 6 done, move to 7.
    stages[6] = { ...(stages[6] || {}), status: 'done', by, time, at: nowIso };
    stages[7] = { status: 'done', notes: '', by, time, at: nowIso };
    stage_index = 7;
    log.push({ stage: STAGES[7], status: 'done', notes: `All ${bookedQty.toLocaleString()} pcs delivered`, by: `${by} (${STAGES[7]})`, time });
  }
  return { deliveries, delqty: String(nextTotal), stage_index, stages, log, entry, nextTotal, bookedQty };
}

// CREATE a partial delivery. Input is CARTONS — the only quantity unit
// used for deliveries in this shop (1 carton == 1 piece per the owner).
// delqty stays in sync as the running sum of cartons so the tile's
// "Delivered Qty" and the client view keep working with no pieces math.
app.post('/api/jobs/:id/deliveries', requireDeliveryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const cartons = String(req.body.cartons ?? '').trim();
    const date    = String(req.body.date    ?? '').trim() || businessDateISO();
    const notes   = String(req.body.notes   ?? '').trim() || null;
    const poNo    = String(req.body.po_no    ?? '').trim() || null;
    const batchNo = String(req.body.batch_no ?? '').trim() || null;
    const cartonsN = parseFloat(cartons.replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(cartonsN) || cartonsN <= 0) {
      return res.status(400).json({ error: 'Delivery cartons must be a positive number.' });
    }
    const rows = await sql`SELECT * FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const eligErr = deliveryEligibilityError(job);
    if (eligErr) return res.status(400).json({ error: eligErr });
    // No cap against booked qty — the shop routinely ships slightly more
    // or less than the P.O. asked for (yield, over-run, customer top-up
    // request). Recording reality is the priority; the tile just shows
    // the running total against the booked qty for context.
    const { deliveries, delqty, stage_index, stages, log, entry, nextTotal, bookedQty } =
      computeDeliveryUpdate(job, { cartonsN, date, notes, poNo, batchNo, byEmail: req.user?.email });
    const updated = await sql`
      UPDATE jobs
         SET deliveries  = ${JSON.stringify(deliveries)},
             delqty      = ${delqty},
             stage_index = ${stage_index},
             stages      = ${JSON.stringify(stages)},
             log         = ${JSON.stringify(log)}
       WHERE id = ${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.delivery.add',
      entityType: 'job',
      entityId: id,
      summary: `Recorded delivery of ${cartonsN.toLocaleString()} cartons for Job E-${id} (total ${nextTotal.toLocaleString()}${bookedQty ? '/' + bookedQty.toLocaleString() : ''})`,
      metadata: { cartons: entry.cartons, date, total: nextTotal, booked: bookedQty },
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Linked Jobs (pairwise) ────────────────────────────────────────
// Two job cards for the same product placed at different times, printed
// together to save cost. Linking is symmetric (A<->B) and one-off — a
// job can only be linked to ONE partner at a time. Purpose: run one
// joint delivery (1 challan, each job's own qty) and merge their rows in
// the Jobs Report.
app.post('/api/jobs/:id/link', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const targetId = parseInt(req.body?.target_id, 10);
    if (!Number.isFinite(targetId) || targetId === id) {
      return res.status(400).json({ error: 'Pick a different job to link with.' });
    }
    const rows = await sql`SELECT * FROM jobs WHERE id = ANY(${[id, targetId]}) AND deleted_at IS NULL`;
    const job = rows.find(r => r.id === id);
    const target = rows.find(r => r.id === targetId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!target) return res.status(404).json({ error: 'Target job not found' });
    if (job.linked_job_id) return res.status(400).json({ error: `Job E-${id} is already linked to E-${job.linked_job_id}. Unlink it first.` });
    if (target.linked_job_id) return res.status(400).json({ error: `Job E-${targetId} is already linked to E-${target.linked_job_id}. Unlink it first.` });
    await sql`UPDATE jobs SET linked_job_id = ${targetId} WHERE id = ${id}`;
    await sql`UPDATE jobs SET linked_job_id = ${id} WHERE id = ${targetId}`;
    await logAudit(sql, req, {
      action: 'job.link',
      entityType: 'job',
      entityId: id,
      summary: `Linked Job E-${id} with Job E-${targetId}`,
    });
    const updated = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/jobs/:id/unlink', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const rows = await sql`SELECT * FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const partnerId = job.linked_job_id;
    await sql`UPDATE jobs SET linked_job_id = NULL WHERE id = ${id}`;
    if (partnerId) await sql`UPDATE jobs SET linked_job_id = NULL WHERE id = ${partnerId}`;
    await logAudit(sql, req, {
      action: 'job.unlink',
      entityType: 'job',
      entityId: id,
      summary: `Unlinked Job E-${id}${partnerId ? ' from Job E-' + partnerId : ''}`,
    });
    const updated = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Stock Groups ─────────────────────────────────────────────────
// Named tag shared by multiple job cards for the same product (ongoing
// reprints). FIFO delivery deducts from oldest-id job first.

// Set or clear a job's group tag. Send group_name=null to remove.
app.patch('/api/jobs/:id/group', requireJobsWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    if (!('group_name' in body)) return res.status(400).json({ error: 'group_name field required (null to remove)' });
    const groupName = body.group_name ? String(body.group_name).trim() || null : null;
    const rows = await sql`SELECT id FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    // Inherit the group's current visibility so the new member matches
    // the rest. bool_or() picks "visible" if ANY member has it — so a
    // group where a hand-edit / interrupted sync left the flags disagreeing
    // still inherits deterministically (the sooner-visible wins rather than
    // a random Postgres LIMIT 1 pick). If the group is visible, also flip
    // client_visible=true on the new member so it shows up in the client's
    // View Jobs modal by default.
    let inherit = false;
    if (groupName) {
      const existing = await sql`
        SELECT COALESCE(bool_or(stock_group_visible), false) AS visible
          FROM jobs
         WHERE stock_group_name = ${groupName} AND deleted_at IS NULL
      `;
      inherit = !!(existing.length && existing[0].visible);
    }
    if (inherit) {
      await sql`UPDATE jobs SET stock_group_name = ${groupName}, stock_group_visible = true, client_visible = true WHERE id = ${id}`;
    } else {
      await sql`UPDATE jobs SET stock_group_name = ${groupName}, stock_group_visible = ${inherit} WHERE id = ${id}`;
    }
    await logAudit(sql, req, {
      action: groupName ? 'job.group_set' : 'job.group_clear',
      entityType: 'job', entityId: id,
      summary: groupName ? `Added job E-${id} to group "${groupName}"` : `Removed job E-${id} from its group`,
    });
    const updated = await sql`SELECT * FROM jobs WHERE id = ${id}`;
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// List all unique group names (for the group filter dropdown).
app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`
      SELECT DISTINCT stock_group_name FROM jobs
      WHERE stock_group_name IS NOT NULL AND deleted_at IS NULL
      ORDER BY stock_group_name`;
    res.json(rows.map(r => r.stock_group_name));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// FIFO group delivery — auto-deducts from oldest job first, spilling into
// newer jobs as needed. Uses computeDeliveryUpdate so auto-advance-to-
// Delivered fires identically to a normal single-job delivery.
app.post('/api/groups/deliver', requireDeliveryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { group_name, cartons: cartonsRaw, date, notes, po_no, batch_no } = req.body || {};
    if (!group_name || !String(group_name).trim()) return res.status(400).json({ error: 'group_name required' });
    const totalCartons = parseFloat(String(cartonsRaw || '').replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(totalCartons) || totalCartons <= 0) return res.status(400).json({ error: 'cartons must be a positive number' });
    const delivDate = String(date || '').trim() || businessDateISO();
    const poNo     = String(po_no    || '').trim() || null;
    const batchNo  = String(batch_no || '').trim() || null;
    const notesStr = String(notes    || '').trim() || null;
    const byEmail  = req.user?.email || 'unknown';
    const groupJobs = await sql`
      SELECT * FROM jobs
      WHERE stock_group_name = ${String(group_name).trim()} AND deleted_at IS NULL
      ORDER BY id ASC`;
    if (!groupJobs.length) return res.status(404).json({ error: 'No jobs found in this group' });
    let remaining = totalCartons;
    const deliveriesMade = [];
    for (const job of groupJobs) {
      if (remaining <= 0) break;
      if (deliveryEligibilityError(job)) continue;
      const readyQty = parseFloat(
        ((job.particulars || {}).delivered_cartons_qty || {}).quantity || ''
      ) || parseFloat(String(job.cartonqty || '').replace(/[^0-9.\-]/g, '')) || 0;
      const alreadyDelivered = sumDeliveryCartons(job.deliveries);
      const available = Math.max(0, readyQty - alreadyDelivered);
      if (available <= 0) continue;
      const allocate = Math.min(available, remaining);
      remaining -= allocate;
      const { deliveries, delqty, stage_index, stages, log } = computeDeliveryUpdate(job, {
        cartonsN: allocate, date: delivDate, notes: notesStr, poNo, batchNo, byEmail,
      });
      await sql`
        UPDATE jobs
           SET deliveries  = ${JSON.stringify(deliveries)},
               delqty      = ${delqty},
               stage_index = ${stage_index},
               stages      = ${JSON.stringify(stages)},
               log         = ${JSON.stringify(log)}
         WHERE id = ${job.id}`;
      deliveriesMade.push({ job_id: job.id, cartons: allocate });
    }
    if (!deliveriesMade.length) return res.status(400).json({ error: 'No cartons available — all group jobs may be at an early stage or fully delivered.' });
    const fulfilled = totalCartons - remaining;
    await logAudit(sql, req, {
      action: 'group.deliver', entityType: 'group', entityId: null,
      summary: `FIFO delivery from group "${group_name}": ${fulfilled} cartons across ${deliveriesMade.length} job(s)${remaining > 0 ? ` — ${remaining} unfulfilled` : ''}`,
    });
    res.json({ ok: true, deliveries_made: deliveriesMade, unfulfilled: remaining });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Joint delivery — ONE challan number stamped across both linked jobs.
// Each job ships its OWN cartons figure (no auto-splitting: the store
// keeper/QC already know each job's own ready quantity). Runs the exact
// same per-job eligibility + auto-advance logic as a normal delivery,
// just twice, wrapped in one response so the UI can show one confirmation.
// Payload: { challan_no, date, entries: [{ job_id, cartons, po_no, batch_no }, ...] }
app.post('/api/jobs/:id/deliver-linked', requireDeliveryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const challanNo = String(req.body?.challan_no ?? '').trim() || null;
    const date = String(req.body?.date ?? '').trim() || businessDateISO();
    const entriesIn = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (entriesIn.length !== 2) {
      return res.status(400).json({ error: 'Linked delivery needs exactly 2 job entries.' });
    }
    const rows = await sql`SELECT * FROM jobs WHERE id = ANY(${entriesIn.map(e => parseInt(e.job_id, 10))}) AND deleted_at IS NULL`;
    const jobsById = new Map(rows.map(r => [r.id, r]));
    const jobA = jobsById.get(id);
    if (!jobA) return res.status(404).json({ error: 'Job not found' });
    if (!jobA.linked_job_id) return res.status(400).json({ error: `Job E-${id} is not linked to another job.` });
    const partnerId = jobA.linked_job_id;
    const jobB = jobsById.get(partnerId);
    if (!jobB) return res.status(404).json({ error: 'Linked partner job not found' });
    if (jobB.linked_job_id !== id) return res.status(400).json({ error: 'Link is inconsistent — unlink and relink these jobs.' });
    // Match each payload entry to its job by id.
    const entryFor = (jobId) => entriesIn.find(e => parseInt(e.job_id, 10) === jobId);
    const eA = entryFor(id);
    const eB = entryFor(partnerId);
    if (!eA || !eB) return res.status(400).json({ error: 'Both linked jobs need a cartons entry.' });
    const cartonsA = parseFloat(String(eA.cartons ?? '').replace(/[^0-9.\-]/g, ''));
    const cartonsB = parseFloat(String(eB.cartons ?? '').replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(cartonsA) || cartonsA <= 0) return res.status(400).json({ error: `Job E-${id}: cartons must be a positive number.` });
    if (!Number.isFinite(cartonsB) || cartonsB <= 0) return res.status(400).json({ error: `Job E-${partnerId}: cartons must be a positive number.` });
    const errA = deliveryEligibilityError(jobA);
    if (errA) return res.status(400).json({ error: errA });
    const errB = deliveryEligibilityError(jobB);
    if (errB) return res.status(400).json({ error: errB });

    const byEmail = req.user?.email;
    const updA = computeDeliveryUpdate(jobA, {
      cartonsN: cartonsA, date, notes: challanNo,
      poNo: String(eA.po_no ?? '').trim() || null,
      batchNo: String(eA.batch_no ?? '').trim() || null,
      linkedJobId: partnerId, byEmail,
    });
    const updB = computeDeliveryUpdate(jobB, {
      cartonsN: cartonsB, date, notes: challanNo,
      poNo: String(eB.po_no ?? '').trim() || null,
      batchNo: String(eB.batch_no ?? '').trim() || null,
      linkedJobId: id, byEmail,
    });
    const [rowA] = await sql`
      UPDATE jobs SET deliveries=${JSON.stringify(updA.deliveries)}, delqty=${updA.delqty},
             stage_index=${updA.stage_index}, stages=${JSON.stringify(updA.stages)}, log=${JSON.stringify(updA.log)}
       WHERE id=${id} RETURNING *`;
    const [rowB] = await sql`
      UPDATE jobs SET deliveries=${JSON.stringify(updB.deliveries)}, delqty=${updB.delqty},
             stage_index=${updB.stage_index}, stages=${JSON.stringify(updB.stages)}, log=${JSON.stringify(updB.log)}
       WHERE id=${partnerId} RETURNING *`;
    await logAudit(sql, req, {
      action: 'job.delivery.add_linked',
      entityType: 'job',
      entityId: id,
      summary: `Joint delivery (Challan ${challanNo || '—'}): E-${id} ${cartonsA.toLocaleString()} cartons + E-${partnerId} ${cartonsB.toLocaleString()} cartons`,
      metadata: { challan_no: challanNo, date, a: { job_id: id, cartons: cartonsA }, b: { job_id: partnerId, cartons: cartonsB } },
    });
    res.json({ job: rowA, partner: rowB });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// DELETE a specific delivery entry by index — admin only, for corrections.
// If removing the last entry drops the job below full delivery, moves stage
// back from Delivered (7) to Ready to Deliver (6).
app.delete('/api/jobs/:id/deliveries/:index', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id  = parseInt(req.params.id, 10);
    const ix  = parseInt(req.params.index, 10);
    const rows = await sql`SELECT * FROM jobs WHERE id=${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const list = Array.isArray(job.deliveries) ? [...job.deliveries] : [];
    if (ix < 0 || ix >= list.length) return res.status(400).json({ error: 'Delivery index out of range' });
    const removed = list.splice(ix, 1)[0] || null;
    const totalCartons = sumDeliveryCartons(list);
    const bookedQty    = parseFloat(String(job.qty || '').replace(/[^0-9.\-]/g, '')) || 0;
    const nowIso = new Date().toISOString();
    const time   = businessStamp();
    const by     = req.user?.email || 'unknown';
    let stage_index = job.stage_index || 0;
    let stages = (job.stages && typeof job.stages === 'object') ? { ...job.stages } : {};
    let log = Array.isArray(job.log) ? [...job.log] : [];
    // If a corrected removal drops the running total below the booked qty
    // AND the job was Delivered, walk it back to Ready to Deliver so the
    // remaining balance shows in the queue again.
    if (stage_index === 7 && bookedQty && totalCartons < bookedQty) {
      stages[7] = { ...(stages[7] || {}), status: 'active' };
      stages[6] = { ...(stages[6] || {}), status: 'active', by, time, at: nowIso };
      delete stages[7];
      stage_index = 6;
    }
    log.push({ stage: STAGES[stage_index], status: stages[stage_index]?.status || 'active',
      notes: `Delivery entry removed (was ${(removed && removed.cartons) || '?'} cartons on ${(removed && removed.date) || '?'})`,
      by: `${by} (${STAGES[stage_index] || '?'})`, time });
    const updated = await sql`
      UPDATE jobs
         SET deliveries  = ${JSON.stringify(list)},
             delqty      = ${totalCartons ? String(totalCartons) : null},
             stage_index = ${stage_index},
             stages      = ${JSON.stringify(stages)},
             log         = ${JSON.stringify(log)}
       WHERE id = ${id}
       RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.delivery.remove',
      entityType: 'job',
      entityId: id,
      summary: `Removed delivery entry #${ix + 1} from Job E-${id}`,
      metadata: { removed, remaining_total: totalCartons },
    });
    res.json(updated[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Delete one saved particulars entry (a station "pass") from a job.
// The station view surfaces a "−" on each saved pass so a mis-entered
// coating / printing row can be undone without a DB touch.
//
// Auth matrix (server enforces so a console POST can't cheat):
//   • admin / production_manager: allowed for any entry (no PIN needed)
//   • anyone else: must send a valid station PIN in the body, AND every
//     entry being removed must carry that PIN's machine name in its
//     `.machine` field — so an Emboss operator can undo an Emboss pass
//     but never a UV pass sitting in the same field.
// Rebuilds each key's derived quantity / name / signature display strings
// from the remaining entries so the job card stays in sync.
app.post('/api/jobs/:id/particulars/delete-entry', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const id = parseInt(req.params.id, 10);
    const idx = parseInt(req.body && req.body.idx, 10);
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys.filter(k => typeof k === 'string' && k) : [];
    const pin = String((req.body && req.body.pin) || '').trim();
    if (!Number.isFinite(idx) || idx < 0) return res.status(400).json({ error: 'idx required (non-negative integer)' });
    if (!keys.length) return res.status(400).json({ error: 'keys[] required' });
    const rows = await sql`SELECT * FROM jobs WHERE id = ${id} AND deleted_at IS NULL`;
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const particulars = (job.particulars && typeof job.particulars === 'object') ? { ...job.particulars } : {};

    const adminOrPm = canWriteJobs(req.user);
    let allowedMachine = null;
    let actorLabel = req.user?.email || 'unknown';
    if (!adminOrPm) {
      if (!validPin(pin)) {
        return res.status(403).json({ error: 'Enter your machine PIN to delete an entry — only admin / production manager can delete without one.' });
      }
      const ops = await sql`SELECT id, name FROM operators WHERE pin = ${pin} AND active LIMIT 1`;
      if (!ops.length) return res.status(401).json({ error: 'PIN not recognized' });
      allowedMachine = String(ops[0].name || '').trim().toLowerCase();
      actorLabel = `${actorLabel} · machine ${ops[0].name}`;
      // Machine-match check: every entry we're about to delete must belong
      // to this PIN's machine, else reject the whole request so nothing
      // gets deleted piecemeal.
      for (const key of keys) {
        const p = particulars[key];
        if (!p || !Array.isArray(p.entries) || idx >= p.entries.length) continue;
        const ent = p.entries[idx] || {};
        const entMachine = String(ent.machine || '').trim().toLowerCase();
        if (entMachine !== allowedMachine) {
          return res.status(403).json({
            error: `Cannot delete: entry belongs to a different machine${ent.machine ? ' (' + ent.machine + ')' : ''}. Only that machine's PIN, admin, or the production manager can remove it.`,
          });
        }
      }
    }

    const removedSummary = [];
    const goneEntries = []; // { key, entry } — for coatings_done cleanup below
    for (const key of keys) {
      const p = particulars[key];
      if (!p || !Array.isArray(p.entries) || idx >= p.entries.length) continue;
      const next = [...p.entries];
      const gone = next.splice(idx, 1)[0] || {};
      goneEntries.push({ key, entry: gone });
      if (!next.length) {
        // Fully empty entries[] → drop the whole particulars sub-object
        // instead of leaving stub .quantity/.name/.signature/.details
        // rows behind. Owner report: deleting an entry left the
        // machine name, operator, and date visible until a new entry
        // was recorded, and the row kept showing in Daily Production /
        // Production reports too. A clean delete removes the key so
        // report aggregators (which read from particulars) see nothing
        // to credit.
        delete particulars[key];
      } else {
        const opsList = [...new Set(
          next.map(e => String((e && e.operator) || '').trim()).filter(Boolean)
        )];
        const machinesList = [...new Set(
          next.map(e => String((e && e.machine) || '').trim()).filter(Boolean)
        )];
        particulars[key] = {
          ...p,
          entries: next,
          quantity: next.map(e => (e && e.qty) || '').filter(q => q !== '').join(' | '),
          // Rebuild name from remaining entries only — never fall back
          // to the stale p.name that carried the deleted machine.
          name: machinesList.join(' | '),
          signature: opsList.join(' | '),
          // Recompute details from the earliest remaining entry's date
          // so the row's timestamp column reflects what's actually there.
          details: next.reduce((acc, e) => {
            if (e && e.date && (!acc || String(e.date) < String(acc))) return String(e.date);
            return acc;
          }, ''),
        };
      }
      if (gone.qty) removedSummary.push(`${key}=${gone.qty}${gone.date ? '@' + gone.date : ''}`);
    }
    // If we just deleted coating-related entries, prune matching
    // coatings_done badges. A badge is redundant once no more entries
    // for that machine exist across any coating field for the same day,
    // otherwise the finish name keeps showing on the tile + Daily
    // Production Report ("Coatings did not get deleted totally").
    const COATING_KEYS = new Set(['coating_sheets_qty', 'coating_waste_sheets', 'uv_waste_sheets']);
    const coatingDeletes = goneEntries.filter(g => COATING_KEYS.has(g.key));
    if (coatingDeletes.length && Array.isArray(particulars.coatings_done) && particulars.coatings_done.length) {
      const stillHasEntry = (machine, date) => {
        for (const ckey of COATING_KEYS) {
          const cp = particulars[ckey];
          const ents = cp && Array.isArray(cp.entries) ? cp.entries : [];
          if (ents.some(e => e && e.machine === machine && (!date || e.date === date))) return true;
        }
        return false;
      };
      const doneNext = particulars.coatings_done.filter(d => {
        if (!d) return false;
        // Drop badge only if a delete targeted this badge's machine AND
        // no remaining entry exists for that machine on the same day.
        const dDate = (d.done_at || '').slice(0, 10);
        const targeted = coatingDeletes.some(g => (g.entry.machine || '') === (d.machine || ''));
        if (!targeted) return true;
        return stillHasEntry(d.machine || '', dDate);
      });
      if (doneNext.length !== particulars.coatings_done.length) {
        if (doneNext.length) particulars.coatings_done = doneNext;
        else delete particulars.coatings_done;
      }
    }
    const nowLog = Array.isArray(job.log) ? [...job.log] : [];
    nowLog.push({
      stage: STAGES[job.stage_index || 0] || '?',
      status: (job.stages && job.stages[job.stage_index || 0] && job.stages[job.stage_index || 0].status) || 'active',
      notes: `Particulars entry #${idx + 1} removed${removedSummary.length ? ' (' + removedSummary.join(', ') + ')' : ''}`,
      by: actorLabel,
      time: businessStamp(),
    });
    const updated = await sql`
      UPDATE jobs SET particulars = ${JSON.stringify(particulars)}, log = ${JSON.stringify(nowLog)}
      WHERE id = ${id}
      RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'job.particulars.delete-entry',
      entityType: 'job', entityId: id,
      summary: `Job E-${id}: removed particulars entry #${idx + 1} by ${actorLabel}${removedSummary.length ? ' (' + removedSummary.join(', ') + ')' : ''}`,
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
    let { paper_type, size, gsm, brand, reorder_threshold, opening_balance, opening_notes, supplier, is_offcut } = req.body;
    if (!paper_type) return res.status(400).json({ error: 'paper_type is required' });
    const isOffcut = !!is_offcut;
    // Brand is stored uppercase for consistency — Ningbo / ningbo / NINGBO
    // all save as NINGBO. The case-insensitive duplicate check below still
    // catches dupes against the existing data even if old rows aren't
    // yet uppercase.
    // Case rule (v2026-07-13): every human-typed identifier is stored
    // lowercase so the same value can't appear as "ningbo" and "NINGBO".
    if (brand)      brand      = String(brand).trim().toLowerCase();
    if (size)       size       = String(size).trim().toLowerCase();
    if (paper_type) paper_type = String(paper_type).trim().toLowerCase();
    if (supplier)   supplier   = String(supplier).trim().toLowerCase();
    const opening = parseSheets(opening_balance);
    const label = `${paper_type}${size?' '+size:''}${gsm?' '+gsm+'gsm':''}${brand?' · '+brand:''}`;

    // Hard duplicate check: same (paper_type, size, gsm, brand) — compared
    // case-insensitively and trimmed, so "ningbo" / "Ningbo" / "NINGBO" all
    // count as the same brand. Refuse the add with a 409 instead of merging.
    // The user uses "+ Stock" on the existing card to top up instead.
    //
    // Only blocks against FRESH-STOCK rows (is_offcut = false). Offcut items
    // are managed by the cut-sheets workflow OR the manual Add Offcut form
    // — either way they may legitimately share dimensions with fresh stock,
    // so skip the check entirely when the caller is adding an offcut.
    if (!isOffcut) {
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
    }

    // No match — fresh item (or a manually-added offcut).
    const inserted = await sql`
      INSERT INTO inventory_items (paper_type, size, gsm, brand, reorder_threshold, supplier, is_offcut)
      VALUES (${paper_type}, ${size||null}, ${gsm||null}, ${brand||null}, ${reorder_threshold||0}, ${supplier||null}, ${isOffcut})
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
    // Case rule (v2026-07-13): every human-typed identifier is stored
    // lowercase so the same value can't appear as "ningbo" and "NINGBO".
    if (brand)      brand      = String(brand).trim().toLowerCase();
    if (size)       size       = String(size).trim().toLowerCase();
    if (paper_type) paper_type = String(paper_type).trim().toLowerCase();
    if (supplier)   supplier   = String(supplier).trim().toLowerCase();

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
    const { change, reason, notes, job_card, challan_no } = req.body;
    const delta = parseSheets(change);
    if (!delta) return res.status(400).json({ error: 'change must be a non-zero integer' });
    const itemId = parseInt(id, 10);

    // Optional Job Card No. resolution: accepts "E-85" or "85".
    let jobId = null;
    let jobRow = null;
    if (job_card) {
      const m = String(job_card).match(/(\d+)/);
      if (m) {
        const candidate = parseInt(m[1], 10);
        const rows = await sql`SELECT * FROM jobs WHERE id = ${candidate} AND deleted_at IS NULL`;
        if (rows[0]) { jobId = candidate; jobRow = rows[0]; }
      }
    }

    // Overdraw guard for stock-outs. Balance may not go negative.
    if (delta < 0) {
      const bal = await sql`SELECT current_balance FROM inventory_items WHERE id = ${itemId}`;
      const have = bal[0] ? (bal[0].current_balance || 0) : 0;
      if (have + delta < 0) {
        return res.status(400).json({ error: `Not enough stock — on hand ${have.toLocaleString()} sheets, requested ${Math.abs(delta).toLocaleString()} sheets.` });
      }
    }

    // Job-card-linked issuance flow. When the user explicitly picks the
    // "Job Card" reason and provides a valid job number, this row is a
    // manual issuance and must obey the same accounting rules as the
    // regular Issue Stock button: paper must match the job, no
    // over-issuance, partial issuances keep the job in Pending Stock
    // until the full needed sheets have been issued.
    const isJobIssuance = !!(jobRow && delta < 0 && reason === 'job-card');
    let finalReason = reason || (delta > 0 ? 'delivery' : 'adjustment');
    let jobFullyIssued = false;
    let partialRemaining = 0;

    if (isJobIssuance) {
      // Brand-agnostic: the job specifies a paper GROUP (type + size +
      // gsm + is_offcut). Store keeper is free to issue from any brand
      // in that same group. Only reject when the manual item is in a
      // truly different paper spec (e.g. wrong size / wrong gsm).
      const grpRows = await sql`
        SELECT
          (SELECT to_jsonb(a) FROM inventory_items a WHERE a.id = ${jobRow.inventory_item_id}) AS anchor,
          (SELECT to_jsonb(b) FROM inventory_items b WHERE b.id = ${itemId}) AS pick
      `;
      const anchor = grpRows[0]?.anchor;
      const pick   = grpRows[0]?.pick;
      const sameGroup = anchor && pick &&
        (anchor.paper_type || '') === (pick.paper_type || '') &&
        (anchor.size || '')       === (pick.size || '') &&
        String(anchor.gsm || '')  === String(pick.gsm || '') &&
        !!anchor.is_offcut         === !!pick.is_offcut;
      if (!sameGroup) {
        return res.status(400).json({ error: `Job E-${jobRow.id} needs a different paper (${anchor?.paper_type || '?'} · ${anchor?.size || ''} · ${anchor?.gsm || ''}gsm) — this item is not in the same paper group.` });
      }
      const needed = jobDeductionSheets({ paperType: (await sql`SELECT paper_type FROM inventory_items WHERE id=${itemId}`)[0]?.paper_type || '', particulars: jobRow.particulars });
      if (needed <= 0) {
        return res.status(400).json({ error: `Job E-${jobRow.id} has no Quantity of Packets set — cannot compute needed sheets.` });
      }
      const consumedRows = await sql`
        SELECT COALESCE(SUM(-t.change),0) AS issued FROM inventory_transactions t
        WHERE t.job_id = ${jobRow.id} AND t.reason = 'job-consumed'
          AND t.reverses_tx_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions r WHERE r.reverses_tx_id = t.id)
      `;
      const alreadyIssued = parseInt(consumedRows[0]?.issued || 0, 10);
      const remaining = needed - alreadyIssued;
      if (remaining <= 0) {
        return res.status(400).json({ error: `Job E-${jobRow.id} is already fully issued (${needed.toLocaleString()} sheets).` });
      }
      if (Math.abs(delta) > remaining) {
        return res.status(400).json({ error: `Would exceed job requirement by ${(Math.abs(delta) - remaining).toLocaleString()} sheets. Remaining need: ${remaining.toLocaleString()} sheets.` });
      }
      finalReason = 'job-consumed';   // report semantics
      jobFullyIssued = Math.abs(delta) === remaining;
      partialRemaining = jobFullyIssued ? 0 : (remaining - Math.abs(delta));
    }

    // Notes: preserve unresolved job_card strings; tag manual issuance
    // rows with the user-picked reason label so it isn't lost.
    let finalNotes = notes || null;
    if (job_card && !jobId) {
      finalNotes = [finalNotes, `Job Card: ${String(job_card).trim()}`].filter(Boolean).join(' · ');
    }

    await applyInventoryChange(sql, {
      itemId,
      change: delta,
      reason: finalReason,
      jobId,
      notes: finalNotes,
      user: req.user,
      challanNo: challan_no,
    });

    // Job state after a manual issuance:
    //   fully issued  → status='issued', clear partial marker
    //   partial       → status='issued' (so stages can progress), record
    //                   the shortfall in particulars.partial_pending_sheets
    //                   so Pending Stock still surfaces it.
    let jobFlipped = false;
    if (isJobIssuance) {
      const nextParticulars = { ...(jobRow.particulars || {}) };
      if (jobFullyIssued) delete nextParticulars.partial_pending_sheets;
      else                nextParticulars.partial_pending_sheets = partialRemaining;
      const wasPending = jobRow.issuance_status === 'pending';
      await sql`
        UPDATE jobs
           SET issuance_status='issued',
               issued_at = COALESCE(issued_at, NOW()),
               issued_by_id = COALESCE(issued_by_id, ${req.user?.id || null}),
               particulars = ${JSON.stringify(nextParticulars)}
         WHERE id=${jobRow.id}
      `;
      jobFlipped = wasPending && jobFullyIssued;
    }

    const refreshed = await sql`SELECT * FROM inventory_items WHERE id = ${id}`;
    const it = refreshed[0];
    if (it) {
      const label = `${it.paper_type}${it.size?' '+it.size:''}${it.gsm?' '+it.gsm+'gsm':''}${it.brand?' · '+it.brand:''}`;
      const sign = delta > 0 ? '+' : '';
      await logAudit(sql, req, {
        action: 'inventory.stock',
        entityType: 'inventory',
        entityId: it.id,
        summary: `${sign}${delta.toLocaleString()} sheets · ${label} (${finalReason})${jobId ? ` · Job E-${jobId}` : ''}${isJobIssuance ? (jobFullyIssued ? ' · full issuance' : ` · partial (${partialRemaining} sheets still needed)`) : ''}`,
      });
    }
    res.json({
      ...(it || {}),
      job_flipped: jobFlipped,
      linked_job_id: jobId,
      job_partial_remaining: isJobIssuance && !jobFullyIssued ? partialRemaining : 0,
      job_fully_issued: isJobIssuance && jobFullyIssued,
    });
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
//   • Store manager / production manager can reverse entries created in
//     the last 7 days (rolling window).
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
      // Manual stock-out reasons — added so the store keeper can undo
      // a wrong Sold/Damaged/Sample entry from the item History.
      'sold', 'damaged', 'sample', 'job-card', 'manual-job-card',
    ]);
    // Admin can reverse ANY reason (including bookkeeping rows like
    // 'correction' or 'opening-balance'). Non-admins are still bound
    // to the standard reversible-reasons allow-list.
    if (!REVERSIBLE_REASONS.has(tx.reason) && !userHasRole(req.user, 'admin')) {
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

    // 7-day rolling window applies to everyone except admin. Store manager
    // and production manager can self-correct mistakes for a week; anything
    // older needs an admin to keep the audit trail intact.
    if (!userHasRole(req.user, 'admin')) {
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const within7Days = (Date.now() - new Date(tx.created_at).getTime()) <= SEVEN_DAYS_MS;
      if (!within7Days) {
        return res.status(403).json({ error: 'You can only reverse entries created in the last 7 days. Ask an admin to reverse older entries.' });
      }
    }

    const itemRows = await sql`SELECT * FROM inventory_items WHERE id = ${tx.item_id} LIMIT 1`;
    const item     = itemRows[0];
    const label    = item ? `${item.paper_type}${item.size?' '+item.size:''}${item.gsm?' '+item.gsm+'gsm':''}${item.brand?' · '+item.brand:''}` : `item ${tx.item_id}`;
    const origNote = tx.notes ? ` (orig note: "${tx.notes}")` : '';
    const origBy   = tx.user_email ? ` entered by ${tx.user_email}` : '';
    // Format the original timestamp as dd/mm/yyyy hh:mm for the audit note —
    // matches the app-wide dd/mm/yyyy display convention, in business-local
    // time (the server's own clock is UTC).
    const _d        = new Date(tx.created_at);
    const _stamp    = isNaN(_d) ? String(tx.created_at) : businessStamp(_d);
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

    // If we just reversed a 'job-consumed' row, flip the linked job back
    // to Pending Stock regardless of what stage the job has reached —
    // matches the paper-swap-after-issuance flow, which also sends the
    // job back to Pending Stock from mid-flight so the store keeper can
    // re-issue. Stage stays where it is; the operator will see the
    // "Pending Stock" badge on the job until the store keeper acts.
    let jobReverted = false;
    let offcutRefundedSheets = 0;
    if (tx.reason === 'job-consumed' && tx.job_id) {
      const jobRows = await sql`SELECT * FROM jobs WHERE id = ${tx.job_id} AND deleted_at IS NULL`;
      const job = jobRows[0];
      if (job && job.issuance_status === 'issued') {
        // Same cleanup as /reverse-issuance: drop anything created by
        // the specific issuance we're undoing so the job doesn't keep
        // ghost effects (owner report: reversal left a "+2 top-up" chip
        // on a job whose over-issue had been "Use"-decided).
        const cleanParticulars = { ...(job.particulars || {}) };
        delete cleanParticulars.partial_pending_sheets;
        delete cleanParticulars.over_issue_pending;
        delete cleanParticulars.over_issue_decisions;
        if (Array.isArray(cleanParticulars.packets_topups)) {
          cleanParticulars.packets_topups = cleanParticulars.packets_topups
            .filter(t => !t || t.source !== 'over-issue-reconcile');
          if (!cleanParticulars.packets_topups.length) delete cleanParticulars.packets_topups;
        }
        await sql`
          UPDATE jobs
             SET issuance_status = 'pending',
                 issued_at = NULL,
                 issued_by_id = NULL,
                 issued_items = '[]'::jsonb,
                 particulars = ${JSON.stringify(cleanParticulars)}
           WHERE id = ${tx.job_id}
        `;
        jobReverted = true;
      }
      // Cascade-reverse every unreversed job-offcut row for this same
      // job. Without this, the paired offcut credits (cut-size return
      // and/or over-issue offcut) stay in inventory as ghost stock even
      // though the consume that spawned them has been undone. Job is
      // going back to Pending Stock anyway — the entire issuance's
      // side-effects should unwind together.
      const pairedOffcuts = await sql`
        SELECT t.id, t.item_id, t.change FROM inventory_transactions t
        WHERE t.job_id = ${tx.job_id} AND t.reason = 'job-offcut'
          AND t.reverses_tx_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions r WHERE r.reverses_tx_id = t.id)
        ORDER BY t.id ASC
      `;
      for (const orow of pairedOffcuts) {
        await applyInventoryChange(sql, {
          itemId: orow.item_id,
          change: -orow.change,
          reason: 'correction',
          jobId: null,
          notes: `Auto-reversal of paired offcut TX #${orow.id} (job E-${tx.job_id} issuance was reversed via TX #${tx.id})`,
          user: req.user,
          reversesTxId: orow.id,
        });
        offcutRefundedSheets += Math.abs(orow.change);
      }
    }

    await logAudit(sql, req, {
      action: 'inventory.reverse',
      entityType: 'inventory',
      entityId: tx.item_id,
      summary: `Reversed TX #${tx.id} (${tx.change > 0 ? '+' : ''}${tx.change} sheets) on ${label}${jobReverted ? ` · Job E-${tx.job_id} flipped back to Pending Stock` : ''}${offcutRefundedSheets ? ` · ${offcutRefundedSheets} offcut sheets also pulled back` : ''}`,
    });

    res.json({ ok: true, reversal_tx_id: newTxId, original_tx_id: tx.id, job_reverted: jobReverted, offcut_refunded_sheets: offcutRefundedSheets });
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
    // Challan filter — matches a substring anywhere in the challan_no.
    // Empty / missing = no filter (all rows).
    const challanQ = req.query.challan ? String(req.query.challan).trim() : '';
    // Day boundaries in BUSINESS time. Passing the bare date string to
    // Postgres made it parse as UTC midnight = 05:00 PKT, so stock moved
    // between midnight and 5am showed under the previous day's filter.
    // Convert each date to the UTC instant of ITS local midnight instead;
    // `to` is exclusive at the NEXT local midnight (inclusive end-of-day).
    const dayStartIso = (d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
      return m ? new Date(businessWallClockToMs(+m[1], +m[2], +m[3], 0, 0)).toISOString() : null;
    };
    const fromTs   = from ? dayStartIso(from) : null;
    const toEndIso = to   ? (() => {
      const s = dayStartIso(to);
      return s ? new Date(new Date(s).getTime() + 86400000).toISOString() : null;
    })() : null;
    // reason='correction' is an admin-only balance edit (data fix). It
    // shows in the per-item History modal but is intentionally excluded
    // from movement reports so Stock In / Stock Out / Dashboard totals
    // reflect actual material flow only.
    const txs = await sql`
      SELECT t.*, j.name AS job_name, j.jobcode AS job_code,
             i.paper_type, i.size AS item_size, i.gsm AS item_gsm,
             i.brand AS item_brand, i.unit AS item_unit,
             i.is_offcut AS item_is_offcut
      FROM inventory_transactions t
      LEFT JOIN jobs j ON j.id = t.job_id
      LEFT JOIN inventory_items i ON i.id = t.item_id
      WHERE (${fromTs}::timestamptz   IS NULL OR t.created_at >= ${fromTs}::timestamptz)
        AND (${toEndIso}::timestamptz IS NULL OR t.created_at <  ${toEndIso}::timestamptz)
        AND t.reason NOT IN ('correction', 'job-edit-revert', 'job-edit-apply')
        -- Hide reversal rows and the original tx they undo. A mistake that
        -- was reversed shouldn't inflate Stock In/Out totals — the pair
        -- nets to zero, so both sides drop out of the movement report.
        AND t.reverses_tx_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM inventory_transactions r WHERE r.reverses_tx_id = t.id
        )
        -- Offcut items are a side ledger managed by admin / PM; their
        -- ins and outs don't belong in the movement report so drop them
        -- server-side. Per-item History still shows the row unchanged.
        AND COALESCE(i.is_offcut, false) = false
        AND (${dir} = 'all'
             OR (${dir} = 'in'  AND t.change > 0)
             OR (${dir} = 'out' AND t.change < 0))
        AND (${challanQ} = '' OR t.challan_no ILIKE ${'%' + challanQ + '%'})
      ORDER BY t.id DESC
    `;
    res.json(txs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Consumption summary: total sheets consumed (stock-out) per item over
// the last N days. Used by the Low Stock filter to compare current
// balance against recent usage.
app.get('/api/inventory/consumption', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 730);
    const rows = await sql`
      SELECT item_id, SUM(ABS(change)) AS consumed
      FROM inventory_transactions
      WHERE change < 0
        AND created_at >= NOW() - (${days} || ' days')::interval
        AND reverses_tx_id IS NULL
      GROUP BY item_id
    `;
    res.json(rows);
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
    let { paper_type, size, gsm, brand, packets, weight_kg, supplier, booked_date, expected_arrival, notes } = req.body;
    if (!paper_type) return res.status(400).json({ error: 'paper_type is required' });
    // Same lowercase rule as /api/inventory so imports don't spawn a
    // duplicate row keyed on a mixed-case value that won't match the
    // existing inventory item on receive.
    if (paper_type) paper_type = String(paper_type).trim().toLowerCase();
    if (size)       size       = String(size).trim().toLowerCase();
    if (brand)      brand      = String(brand).trim().toLowerCase();
    if (supplier)   supplier   = String(supplier).trim().toLowerCase();
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
    let { paper_type, size, gsm, brand, packets, weight_kg, supplier, booked_date, expected_arrival, notes } = req.body;
    if (paper_type) paper_type = String(paper_type).trim().toLowerCase();
    if (size)       size       = String(size).trim().toLowerCase();
    if (brand)      brand      = String(brand).trim().toLowerCase();
    if (supplier)   supplier   = String(supplier).trim().toLowerCase();
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
// when the actual delivery differs from the booked quantity). Supports
// partial receives: if the received quantity (added to whatever was already
// received on earlier deliveries) is less than the booked total, the import
// stays at status='partial' instead of 'received' so it remains actionable.
app.post('/api/imports/:id/receive', requireInventoryWriter, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const { id } = req.params;
    const overridePackets = parseFloat(req.body?.packets);
    const challanNo = req.body?.challan_no;
    const receiveNotes = req.body?.notes;
    const imp = (await sql`SELECT * FROM inventory_imports WHERE id=${id} AND deleted_at IS NULL`)[0];
    if (!imp) return res.status(404).json({ error: 'Import not found' });
    if (imp.status !== 'pending' && imp.status !== 'partial') {
      return res.status(400).json({ error: 'Only pending or partially-received imports can be received' });
    }

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
    const reamSet = new Set(['art paper', 'off-white', 'offset paper']);
    const perPack = reamSet.has(imp.paper_type) ? 500 : 100;
    const receivedPackets = Number.isFinite(overridePackets) && overridePackets > 0 ? overridePackets : parseFloat(imp.packets);
    const sheets = Math.round(receivedPackets * perPack);
    if (!sheets || sheets <= 0) return res.status(400).json({ error: 'packets must be > 0' });

    const notesParts = [
      `Import #${imp.id}${imp.supplier ? ' · ' + imp.supplier : ''}`,
      imp.notes || null,
      receiveNotes ? String(receiveNotes).trim() || null : null,
    ].filter(Boolean);

    await applyInventoryChange(sql, {
      itemId,
      change: +sheets,
      reason: 'import-received',
      jobId: null,
      notes: notesParts.join(' · '),
      user: req.user,
      challanNo,
    });

    const newReceivedTotal = (parseFloat(imp.received_packets) || 0) + receivedPackets;
    const finalDelivery = !!req.body?.final_delivery;
    const newStatus = (newReceivedTotal >= parseFloat(imp.packets) || finalDelivery) ? 'received' : 'partial';
    const updated = await sql`
      UPDATE inventory_imports SET
        status=${newStatus},
        received_at=NOW(),
        inventory_item_id=${itemId},
        received_packets=${newReceivedTotal}
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
    // CEO can enter the terminal to observe, but every write action is
    // blocked here so a dev-tools POST can't sneak past the hidden UI.
    if (!canProcessStation(req.user)) {
      return res.status(403).json({ error: 'View-only: your role cannot process jobs at the station.' });
    }
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
    // CTP-queue jobs are the exception to the "must be issued" rule above:
    // CTP work happens BEFORE paper is ordered. The CTP operator (stage 0)
    // is the only station allowed to act on them; every other stage still
    // needs stock to be issued before anything can be recorded.
    if (job.issuance_status === 'ctp' && curStage !== 0) {
      return res.status(400).json({ error: 'This job is still in the CTP queue — plates must be finished first.' });
    }

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
    // Parse "dd/mm/yyyy hh:mm" business stamp -> ISO date (yyyy-mm-dd).
    // Used to back-fill a real date onto a legacy scalar entry so the
    // Daily Production report can credit it. Falls back to null when the
    // stamp is missing or malformed.
    const detailsToISODate = (s) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || ''));
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    };
    for (const [key, value] of Object.entries(particularsPatch)) {
      const prev = (particulars[key] && typeof particulars[key] === 'object') ? particulars[key] : {};
      if (Array.isArray(value)) {
        // Seed from existing entries[], or back-fill a single legacy
        // entry from prev.quantity so a job's first multi-pass save
        // doesn't lose its original day-1 number.
        // prev.name holds the MACHINE and prev.signature holds the
        // OPERATOR (per particulars[key]'s render contract). Older code
        // wrote { operator: prev.name, machine: null } into the seed,
        // which flipped them and left "MACHINENAME | person" in the
        // Signature column forever after. Swap so the seed matches the
        // rest of the pipeline.
        // Seed date pulled from prev.details when possible — otherwise
        // a same-day scalar save followed by a same-day array save lost
        // the first pass's date and the Daily Production report dropped
        // it (was crediting only the LAST entry instead of the sum).
        const seedDate = detailsToISODate(prev.details);
        const seed = Array.isArray(prev.entries) && prev.entries.length
          ? prev.entries
          : (prev.quantity != null && String(prev.quantity).trim() !== ''
              ? [{ qty: String(prev.quantity).trim(), date: seedDate,
                   operator: prev.signature || null,
                   machine:  prev.name      || null }]
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
        // Trim before dedup so subtle whitespace variants ("Ar" vs " Ar")
        // collapse to one entry — the owner wants a person / machine that
        // did N passes shown once, not N times.
        const opsList = [...new Set(
          merged.map(e => String((e && e.operator) || '').trim()).filter(Boolean)
        )];
        const machinesList = [...new Set(
          merged.map(e => String((e && e.machine) || '').trim()).filter(Boolean)
        )];
        particulars[key] = {
          ...prev,
          entries: merged,
          details: prev.details || businessStamp(),
          quantity: merged.map(e => e.qty).filter(q => q !== '').join(' | '),
          name: machinesList.join(' | ') || operator.machine || '',
          signature: opsList.join(' | '),
        };
      } else {
        // Scalar single-value patch. Also write a one-item entries[] with
        // today's date so a follow-up same-day save (which the client
        // sends as an array once stationPassCount bumps) can merge on top
        // WITHOUT losing the date on this first pass. Without the entries
        // stamp, the seed back-fill runs with date:null and the Daily
        // Production report skips the entry.
        const qty = String(value ?? '').trim();
        const nextEntries = qty
          ? [{ qty, date: todayISO, operator: operator.name, machine: operator.machine || null }]
          : [];
        particulars[key] = {
          ...prev,
          entries: nextEntries,
          details: prev.details || businessStamp(),
          quantity: qty,
          name: operator.machine || '',
          signature: operator.name,
        };
      }
    }

    // Byline used by every log entry below. The stage in parentheses must
    // reflect the stage the WORK is being done at (curStage), NOT the
    // operator's primary stage_index. A machine authorized for multiple
    // stages (e.g. Coatings + Die Cutting) has a single primary stage_index,
    // and stamping that on every log entry would misattribute die-cutting
    // work to Coatings — which the job card's particularsTable auto-fill
    // then reads back into the wrong row.
    const stageLabel = STAGES[curStage] || 'Stage ' + curStage;
    const by = `${operator.name}${operator.machine ? ' · ' + operator.machine : ''} (${stageLabel})`;
    const time = businessStamp();
    // Machine-comparable instant for the SAME moment as `time`. `time` is a
    // business-local wall-clock string ("dd/mm/yyyy hh:mm") that different
    // clients parse in different timezones; `at` is an unambiguous UTC
    // instant used for staleness math (see pendingCoatings) so a coating's
    // done_at instant compares correctly against the stage-entry instant
    // regardless of where the code runs (Vercel UTC vs browser PKT).
    const nowIso = new Date().toISOString();

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
      // Owner report: doing save+advance twice for the same finish on
      // the same day produced "UV ×2" (or "Emboss ×2") on the Daily
      // Production coatings report — a duplicate badge for what was
      // really one coating run. Dedup by {kind, machine, YYYY-MM-DD}
      // before pushing. Multi-day passes still work: a second UV run
      // TOMORROW gets a fresh badge (different date). Waste on the
      // existing same-day badge is updated so multi-pass totals stay
      // accurate.
      const todayIsoDate = new Date().toISOString().slice(0, 10);
      const dupIdx = coatings_done.findIndex(d =>
        d && d.kind === finishKind &&
        (d.machine || '') === (finishMachine || '') &&
        String(d.done_at || '').slice(0, 10) === todayIsoDate
      );
      if (dupIdx >= 0) {
        // Refresh the waste total on the existing badge so multi-pass
        // totals reported today reflect the latest saved numbers.
        if (finishWaste) coatings_done[dupIdx] = { ...coatings_done[dupIdx], waste_sheets: finishWaste };
      } else {
        coatings_done.push({
          kind: finishKind,
          operator_id: operator.id,
          operator_name: operator.name,
          machine: finishMachine || null,
          waste_sheets: finishWaste || null,
          done_at: new Date().toISOString(),
        });
      }
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
      stages[curStage] = { ...(stages[curStage] || {}), status: target === curStage ? (stages[curStage]?.status || 'active') : 'done', by, time, at: nowIso };
      if (target !== curStage && !finishing) {
        // Mark every skipped intermediate stage as done with an audit note
        // so the pipeline UI shows them passed, not blank.
        for (let i = curStage + 1; i < target; i++) {
          stages[i] = { ...(stages[i] || {}), status: 'done', by, time, at: nowIso, notes: `Skipped — job went from ${STAGES[curStage]} directly to ${STAGES[target]}` };
        }
        const status = target === STAGES.length - 1 ? 'done' : 'active';
        stages[target] = { status, notes: '', by, time, at: nowIso };
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

    // Pasting → Ready: auto-fill delivered_cartons_qty from pasted_cartons_qty
    // so the QC person at Ready just confirms and adds packets.
    if (advance && curStage === 5 && stage_index === 6) {
      const pasted = particulars.pasted_cartons_qty;
      if (pasted && !particulars.delivered_cartons_qty) {
        particulars.delivered_cartons_qty = {
          quantity: pasted.quantity || '',
          entries: Array.isArray(pasted.entries) ? JSON.parse(JSON.stringify(pasted.entries)) : undefined,
          name: pasted.name || '',
          signature: pasted.signature || '',
          details: pasted.details || '',
        };
      }
    }

    // When the CTP operator (stage 0) finishes plates and advances the job
    // off stage 0, flip issuance_status from 'ctp' to 'pending' so the job
    // pops into Pending Stock for the store keeper to issue paper. Every
    // other transition leaves issuance_status alone.
    const nextStatus = (job.issuance_status === 'ctp' && curStage === 0 && stage_index > 0)
      ? 'pending'
      : job.issuance_status;
    const updated = await sql`
      UPDATE jobs
         SET particulars     = ${JSON.stringify(particulars)},
             stage_index     = ${stage_index},
             stages          = ${JSON.stringify(stages)},
             log             = ${JSON.stringify(log)},
             coatings_done   = ${JSON.stringify(coatings_done)},
             issuance_status = ${nextStatus}
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
    if (!canProcessStation(req.user)) {
      return res.status(403).json({ error: 'View-only: your role cannot post notes at the station.' });
    }
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
    if (!canProcessStation(req.user)) {
      return res.status(403).json({ error: 'View-only: your role cannot mark notes as heard.' });
    }
    await dbReady;
    const sql = getDb();
    await sql`UPDATE station_notes SET heard_at = COALESCE(heard_at, NOW()) WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


// ── Transfer Notes (Finished Goods Transfer) ────────────────
app.get('/api/transfer-notes', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`SELECT * FROM transfer_notes ORDER BY id DESC`;
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/transfer-notes/:id', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`SELECT * FROM transfer_notes WHERE id=${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/transfer-notes', requireAuth, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const last = await sql`SELECT transfer_note_no FROM transfer_notes ORDER BY id DESC LIMIT 1`;
    let nextNum = 1;
    if (last.length) {
      const m = /(\d+)$/.exec(last[0].transfer_note_no);
      if (m) nextNum = parseInt(m[1], 10) + 1;
    }
    const tnNo = 'TN-' + String(nextNum).padStart(4, '0');
    const b = req.body;
    const [row] = await sql`
      INSERT INTO transfer_notes (transfer_note_no, date, po_no, client, transferred_from, transferred_to,
        product_name, job_ids, items, total_qty, total_packages, qc_status, auth_signatures, remarks, created_by)
      VALUES (${tnNo}, ${b.date || businessStamp()}, ${b.po_no || ''}, ${b.client || ''},
        ${b.transferred_from || 'Production'}, ${b.transferred_to || 'Store / Warehouse'},
        ${b.product_name || ''}, ${JSON.stringify(b.job_ids || [])}, ${JSON.stringify(b.items || [])},
        ${b.total_qty || 0}, ${b.total_packages || 0}, ${b.qc_status || 'passed'},
        ${JSON.stringify(b.authorization || {})}, ${b.remarks || ''}, ${req.user?.email || ''})
      RETURNING *
    `;
    await logAudit(sql, req, {
      action: 'transfer_note.create',
      entityType: 'transfer_note',
      entityId: row.id,
      summary: `Transfer Note ${tnNo} created`,
      metadata: { transfer_note_no: tnNo, job_ids: b.job_ids, client: b.client },
    });
    res.json(row);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/transfer-notes/:id', requireAdmin, async (req, res) => {
  try {
    await dbReady;
    const sql = getDb();
    const rows = await sql`SELECT * FROM transfer_notes WHERE id=${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await sql`DELETE FROM transfer_notes WHERE id=${req.params.id}`;
    await logAudit(sql, req, {
      action: 'transfer_note.delete',
      entityType: 'transfer_note',
      entityId: rows[0].id,
      summary: `Transfer Note ${rows[0].transfer_note_no} deleted`,
      metadata: { transfer_note_no: rows[0].transfer_note_no },
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
