// ── The Store (moved from the ERP / Employee app, owner 2026-11-24) ─────────────────────────────────────────────
// The ERP's raw material store - Inks & Consumables and the Parts Store (Machinery) - with every screen, feature and
// its past data. The store page itself (public/store/index.html) is the ERP's page, unchanged in behaviour; these are
// its /api/store/* routes rebuilt here with the same answers, on tables of their own (store_*), so nothing of the
// Job Tracker's own data (paper, cartons, plates) is touched.
// Two things stay in the ERP and are only READ from it (ERP_DATABASE_URL, a read-only user): the employee list
// ("Issued To") and Procurement's P.O.s (Orders -> New Order from a P.O.).
// Who may do what: the Store tab of the Access Register - one row per grant the ERP had.
'use strict';

module.exports = function registerStoreRoutes(app, deps) {
  const { getDb, dbReady, logAudit, userHasBtn, userHasRole, requireAuth, neon, afterErpCopy, cartonReverse, cartonCreate, plateReverse } = deps;

  // The ERP grant -> its Access Register row here.
  const GRANT_ROW = {
    store: 'store_btn_edit',
    'store.stockin': 'store_btn_stock_in',
    'store.stockout': 'store_btn_stock_out',
    'store.reverse': 'store_btn_reverse',
    'store.delete': 'store_btn_delete_history',
    'store.partdelete': 'store_btn_part_delete',
    'store.reconcile': 'store_btn_reconcile',
    'store.settings': 'store_btn_settings',
    'store.orders': 'store_btn_orders',
  };
  const MODULES = ['machinery', 'consumables'];
  const MOD_LABEL = { machinery: 'Machinery', consumables: 'Consumables' };
  const MOD_ROW = { machinery: 'store_sec_machinery', consumables: 'store_sec_consumables' };
  const normMod = m => (m === 'consumables' ? 'consumables' : 'machinery');
  const isSA = u => userHasRole(u, 'super_admin');
  const can = (u, grant) => isSA(u) || userHasBtn(u, GRANT_ROW[grant] || grant);
  const modulesFor = u => {
    if (isSA(u)) return [...MODULES];
    if (!userHasBtn(u, 'store_tab_access', 'view')) return [];
    return MODULES.filter(m => userHasBtn(u, MOD_ROW[m], 'view'));
  };
  const roundQty = n => Math.round(n * 1000) / 1000;
  const ORD = ['th', 'st', 'nd', 'rd'];
  const ordinal = n => { const v = n % 100; return n + (ORD[(v - 20) % 10] || ORD[v] || ORD[0]); };
  const productKey = s => String(s || '').toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/(\d)\s*(?:grams?|grms?|gms?|gm|gr|g)(?![a-z])/g, '$1g')
    .replace(/(\d)\s*(?:kilograms?|kilos?|kgs?)(?![a-z])/g, '$1kg')
    .replace(/[^a-z0-9]/g, '');
  const poDigits = s => String(s == null ? '' : s).replace(/[^0-9]/g, '');
  const who = req => (req.user && (req.user.name || String(req.user.email || '').split('@')[0])) || '';
  const labelOf = p => `${p && p.sku ? `[${p.sku}] ` : ''}${(p && p.name) || ''}`;
  const todayPk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const fail = (res, e) => { console.error('store:', e); res.status(500).json({ error: e.message || String(e) }); };
  const log = (sql, req, action, summary, entityId) => logAudit(sql, req, { action, entityType: 'store', entityId: entityId || null, summary });

  // The ERP's database, read only: employees and Procurement P.O.s. No URL set = those two lists are empty.
  let _erp = null;
  const erpSql = () => {
    const url = process.env.ERP_DATABASE_URL;
    if (!url) return null;
    if (!_erp) _erp = neon(url);
    return _erp;
  };

  // ── Tables (created on first use, each step a no-op the second time) ──
  let _ready = null;
  async function ensureStore() {
    if (_ready) return _ready;
    _ready = (async () => {
      await dbReady;
      const sql = getDb();
      await sql`CREATE TABLE IF NOT EXISTS store_categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL, module TEXT NOT NULL DEFAULT 'machinery')`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS store_categories_module_name_key ON store_categories (module, name)`;
      await sql`CREATE TABLE IF NOT EXISTS store_machines (id SERIAL PRIMARY KEY, name TEXT NOT NULL, module TEXT NOT NULL DEFAULT 'machinery')`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS store_machines_module_name_key ON store_machines (module, name)`;
      await sql`CREATE TABLE IF NOT EXISTS store_recipients (id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS store_recipients_name_key ON store_recipients (LOWER(name))`;
      await sql`
        CREATE TABLE IF NOT EXISTS store_parts (
          id SERIAL PRIMARY KEY, sku TEXT, name TEXT NOT NULL, category TEXT NOT NULL, module TEXT NOT NULL DEFAULT 'machinery',
          machine TEXT DEFAULT '', brand TEXT DEFAULT '', supplier TEXT DEFAULT '', rack_no TEXT DEFAULT '',
          unit TEXT NOT NULL DEFAULT 'pcs', qty DOUBLE PRECISION NOT NULL DEFAULT 0, min_qty INTEGER NOT NULL DEFAULT 0,
          description TEXT DEFAULT '', image_url TEXT, deleted_at TIMESTAMPTZ, archived_at TIMESTAMPTZ)`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS store_parts_sku_active_unique_ci ON store_parts (LOWER(sku)) WHERE sku IS NOT NULL AND deleted_at IS NULL`;
      await sql`
        CREATE TABLE IF NOT EXISTS store_orders (
          id SERIAL PRIMARY KEY, part_id INTEGER REFERENCES store_parts(id) ON DELETE CASCADE, qty DOUBLE PRECISION NOT NULL,
          supplier TEXT NOT NULL DEFAULT '', po_no TEXT NOT NULL DEFAULT '', order_date DATE NOT NULL, expected_date DATE,
          notes TEXT NOT NULL DEFAULT '', cancelled_at TIMESTAMPTZ, created_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(), item_name TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '',
          module TEXT NOT NULL DEFAULT 'consumables', po_id INTEGER, po_sr INTEGER)`;
      await sql`
        CREATE TABLE IF NOT EXISTS store_tx (
          id SERIAL PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('in','out')),
          part_id INTEGER NOT NULL REFERENCES store_parts(id) ON DELETE CASCADE, qty DOUBLE PRECISION NOT NULL, date DATE NOT NULL,
          ref TEXT DEFAULT '', notes TEXT DEFAULT '', issued_to TEXT DEFAULT '', purpose TEXT DEFAULT '', challan_no TEXT DEFAULT '',
          created_by TEXT, batch INTEGER, po_no TEXT, invoice_no TEXT, batch_label TEXT, created_at TIMESTAMPTZ, order_id INTEGER)`;
      await sql`CREATE INDEX IF NOT EXISTS store_tx_part_idx ON store_tx (part_id)`;
      await sql`CREATE INDEX IF NOT EXISTS store_tx_order_idx ON store_tx (order_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS store_ledger_ignores (
          part_id INTEGER PRIMARY KEY REFERENCES store_parts(id) ON DELETE CASCADE, diff DOUBLE PRECISION NOT NULL,
          ignored_by TEXT NOT NULL DEFAULT '', ignored_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await sql`
        CREATE TABLE IF NOT EXISTS store_dropdown_hidden (
          field TEXT NOT NULL, value TEXT NOT NULL, hidden_by TEXT NOT NULL DEFAULT '', hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (field, value))`;
      // Photos of items added here (the ERP's old photo links stay as they are).
      await sql`
        CREATE TABLE IF NOT EXISTS store_images (
          id SERIAL PRIMARY KEY, data BYTEA NOT NULL, content_type TEXT NOT NULL, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      // A photo brought from the ERP keeps the link it came from (a later copy reuses it instead of fetching again).
      await sql`ALTER TABLE store_images ADD COLUMN IF NOT EXISTS source_url TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS store_images_source_idx ON store_images (source_url)`;
      // Carton Shippers (owner, 2026-11-24): the Store item of a carton type, the Store entry of a carton entry.
      await sql`ALTER TABLE store_parts ADD COLUMN IF NOT EXISTS carton_type_id INTEGER`;
      // Size of a Carton Shipper / CTCP plate (shown under its name, owner 2026-11-24).
      await sql`ALTER TABLE store_parts ADD COLUMN IF NOT EXISTS size TEXT`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS store_parts_carton_type_uq ON store_parts (carton_type_id) WHERE carton_type_id IS NOT NULL`;
      await sql`ALTER TABLE store_tx ADD COLUMN IF NOT EXISTS carton_tx_id INTEGER`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS store_tx_carton_tx_uq ON store_tx (carton_tx_id) WHERE carton_tx_id IS NOT NULL`;
    })().catch(e => { _ready = null; throw e; });
    return _ready;
  }
  const db = async () => { await ensureStore(); return getDb(); };

  // ── Gates ──
  // Read: the Store tab (View) - and the section asked for.
  const storeRead = (req, res, next) => requireAuth(req, res, () => {
    if (!modulesFor(req.user).length) return res.status(403).json({ error: 'Your role does not have access to the Store.' });
    next();
  });
  // Write: any one of the grants given.
  const storeWrite = (...grants) => (req, res, next) => requireAuth(req, res, () => {
    if (!modulesFor(req.user).length || !grants.some(g => can(req.user, g))) return res.status(403).json({ error: 'Not allowed' });
    next();
  });
  const modDenied = (req, res, mod) => {
    const m = normMod(mod);
    if (modulesFor(req.user).includes(m)) return false;
    res.status(403).json({ error: `Your role doesn't have access to the ${MOD_LABEL[m]} store.` });
    return true;
  };
  async function partsDenied(sql, req, res, ids) {
    const list = (ids || []).filter(n => Number.isFinite(n) && n > 0);
    if (!list.length || isSA(req.user)) return false;
    const rows = await sql`SELECT DISTINCT module FROM store_parts WHERE id = ANY(${list})`;
    for (const r of rows) if (modDenied(req, res, r.module)) return true;
    return false;
  }
  async function txnsDenied(sql, req, res, ids) {
    const list = (ids || []).filter(n => Number.isFinite(n) && n > 0);
    if (!list.length || isSA(req.user)) return false;
    const rows = await sql`SELECT DISTINCT p.module FROM store_tx t JOIN store_parts p ON p.id = t.part_id WHERE t.id = ANY(${list})`;
    for (const r of rows) if (modDenied(req, res, r.module)) return true;
    return false;
  }

  // Batches of an Inks & Consumables part (as the ERP): later batches hold what came in less what went out; the 1st
  // batch is the rest of what is on hand.
  async function batchBalances(sql, partId, opts = {}) {
    const [part] = await sql`SELECT qty FROM store_parts WHERE id = ${partId}`;
    const qty = opts.qtyOverride != null ? opts.qtyOverride : Number((part && part.qty) || 0);
    const skip = opts.skipTxns && opts.skipTxns.length ? opts.skipTxns : [0];
    const rows = await sql`
      SELECT COALESCE(batch, 1) AS b, SUM(CASE WHEN type = 'in' THEN qty ELSE -qty END) AS bal
        FROM store_tx WHERE part_id = ${partId} AND NOT (id = ANY(${skip})) GROUP BY 1`;
    const later = rows.filter(r => Number(r.b) >= 2).map(r => ({ n: Number(r.b), qty: roundQty(Number(r.bal)) })).sort((a, b) => a.n - b.n);
    const laterSum = later.reduce((s, x) => s + x.qty, 0);
    return { batches: [{ n: 1, qty: roundQty(qty - laterSum) }, ...later], any: rows.length > 0 || qty > 0 };
  }

  // The open order a stock in with a P.O. No. belongs to (as the ERP's orderForStockIn).
  async function orderForStockIn(sql, partId, poNo) {
    const po = poDigits(poNo);
    if (!po) return null;
    const orders = await sql`
      SELECT o.id, o.part_id AS "partId", o.item_name AS "itemName", o.module, o.qty,
             COALESCE((SELECT SUM(t.qty) FROM store_tx t WHERE t.order_id = o.id AND t.type = 'in'), 0) AS received
        FROM store_orders o
       WHERE o.cancelled_at IS NULL AND regexp_replace(o.po_no, '[^0-9]', '', 'g') = ${po}
       ORDER BY o.id`;
    const open = orders.filter(o => Number(o.qty) - Number(o.received) > 0.0005);
    const mine = open.find(o => Number(o.partId) === partId);
    if (mine) return Number(mine.id);
    const unlinked = open.filter(o => !o.partId);
    if (!unlinked.length) return null;
    const [p] = await sql`SELECT name, sku, module FROM store_parts WHERE id = ${partId}`;
    if (!p) return null;
    const keys = new Set([productKey(p.name), productKey(`${p.sku || ''} ${p.name || ''}`)].filter(Boolean));
    const named = unlinked.find(o => o.module === p.module && keys.has(productKey(o.itemName)));
    if (!named) return null;
    await sql`UPDATE store_orders SET part_id = ${partId} WHERE id = ${named.id} AND part_id IS NULL`;
    return Number(named.id);
  }

  // (Plain text: this database library can't put one query piece inside another.)
  const PART_COLS = `id, sku, name, category, machine, brand, supplier, rack_no AS "rackNo", module, unit, qty,
                     min_qty AS "minQty", description AS "desc", image_url AS "imageUrl", carton_type_id AS "cartonTypeId", size`;
  const TX_COLS = `t.id, t.type, t.part_id AS "partId", t.qty, t.date::text AS date, t.ref, t.notes, t.issued_to AS "issuedTo",
                   t.purpose, t.challan_no AS "challanNo", t.batch, t.po_no AS "poNo", t.invoice_no AS "invoiceNo",
                   t.batch_label AS "batchLabel", t.order_id AS "orderId", t.created_by AS "createdBy", t.created_at AS "createdAt"`;

  // ── Who is signed in (the store page asks this first) ──
  app.get('/api/store/auth', async (req, res) => {
    const action = String(req.query.action || 'me');
    if (action === 'set-password') return res.json({ valid: false, reason: 'Not supported - sign in to the Job Tracker.' });
    if (action !== 'me') return res.status(400).json({ error: 'Sign in is handled by the Job Tracker.' });
    const u = req.user;
    if (!u || userHasRole(u, 'client') || !modulesFor(u).length) return res.json({ authenticated: false, needsSetup: false, emailConfigured: false });
    const role = isSA(u) || userHasRole(u, 'admin') ? 'admin' : userHasRole(u, 'ceo') ? 'ceo' : 'machinery';
    res.json({
      authenticated: true, emailConfigured: false,
      user: {
        id: u.id, email: u.email, name: u.name || String(u.email || '').split('@')[0], role,
        modules: modulesFor(u),
        canDelete: can(u, 'store.delete'), canReconcile: can(u, 'store.reconcile'), canEdit: can(u, 'store'),
        canStockIn: can(u, 'store.stockin'), canStockOut: can(u, 'store.stockout'), canReverse: can(u, 'store.reverse'),
        canPartDelete: can(u, 'store.partdelete'), canSettings: can(u, 'store.settings'), canOrders: can(u, 'store.orders'),
      },
    });
  });
  app.post('/api/store/auth', (req, res) => {
    if (String(req.query.action || '') === 'logout') return res.json({ ok: true });
    res.status(400).json({ error: 'Sign in is handled by the Job Tracker.' });
  });
  // The ERP's own user list and activity feed are not used: users are the Job Tracker's, actions go to its Activity Log.
  app.get('/api/store/users', storeRead, (req, res) => res.json([]));
  for (const m of ['post', 'put', 'delete']) app[m]('/api/store/users', (req, res) => res.status(405).json({ error: 'Manage users in the Job Tracker.' }));
  app.get('/api/store/activity', storeRead, (req, res) => res.json([]));
  app.post('/api/store/init', storeRead, async (req, res) => { try { await ensureStore(); res.json({ ok: true, message: 'Store tables ready' }); } catch (e) { fail(res, e); } });

  // ── Items ──
  app.get('/api/store/parts', storeRead, async (req, res) => {
    try {
      const sql = await db();
      const mod = normMod(req.query.module);
      if (modDenied(req, res, mod)) return;
      res.json(await sql(`SELECT ${PART_COLS} FROM store_parts WHERE module = $1 AND deleted_at IS NULL ORDER BY id`, [mod]));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/store/parts', storeWrite('store'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const mod = normMod(b.module);
      if (modDenied(req, res, mod)) return;
      const name = String(b.name || '').trim(), category = String(b.category || '').trim();
      if (!name) return res.status(400).json({ error: 'Name required' });
      if (!category) return res.status(400).json({ error: 'Category required' });
      const sku = String(b.sku || '').trim() || null;
      if (sku) {
        const [dup] = await sql`SELECT id, sku, name, category, module, unit, qty, min_qty AS "minQty", description AS "desc"
                                  FROM store_parts WHERE LOWER(sku) = LOWER(${sku}) AND deleted_at IS NULL LIMIT 1`;
        if (dup) return res.status(409).json({ error: `SKU "${dup.sku}" already exists`, existing: dup });
      }
      const size = String(b.size || '').trim().slice(0, 60) || null;
      if (mod === 'consumables' && /carton/i.test(category) && cartonCreate) {
        const r = await cartonCreate(req, { name, size, reorder: Number(b.minQty || 0) || null, openingQty: Math.max(0, Math.round(Number(b.openingQty) || 0)) });
        if (r.error) return res.status(r.status || 400).json({ error: r.error });
        const [row] = await sql(`SELECT ${PART_COLS} FROM store_parts WHERE carton_type_id = $1`, [r.typeId]);
        return res.json(row || { ok: true });
      }
      try {
        const [row] = await sql(`
          INSERT INTO store_parts (sku, name, category, machine, brand, supplier, rack_no, module, unit, qty, min_qty, description, image_url, size)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13)
          RETURNING ${PART_COLS}`,
          [sku, name, category, String(b.machine || ''), String(b.brand || ''), String(b.supplier || ''), String(b.rackNo || ''), mod,
           String(b.unit || 'pcs'), Number(b.minQty || 0) || 0, String(b.desc || ''), b.imageUrl || null, size]);
        await log(sql, req, `store.${mod}.part.add`, `added store part "${sku ? `[${sku}] ` : ''}${name}" (${mod})`, row.id);
        res.json(row);
      } catch (e) {
        if (e.code === '23505' || /sku/i.test(String(e.message || ''))) return res.status(409).json({ error: `SKU "${sku}" already exists` });
        throw e;
      }
    } catch (e) { fail(res, e); }
  });
  // Edit. A qty given OVERWRITES the quantity on hand and records an adjustment entry for the difference (as the ERP).
  app.put('/api/store/parts', storeWrite('store'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const id = Number(b.id);
      if (!id) return res.status(400).json({ error: 'ID required' });
      if (await partsDenied(sql, req, res, [id])) return;
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name required' });
      const sku = String(b.sku || '').trim() || null;
      const imageProvided = Object.prototype.hasOwnProperty.call(b, 'imageUrl');
      const qtyVal = b.qty === undefined || b.qty === null || b.qty === '' ? null : roundQty(Math.max(0, Number(b.qty) || 0));
      const [before] = await sql`SELECT id, name, sku, unit, module, qty, carton_type_id FROM store_parts WHERE id = ${id}`;
      if (!before) return res.status(404).json({ error: 'Part not found' });
      if (before.carton_type_id) return res.status(409).json({ error: `"${before.name}" is a Carton Shipper - change it with Edit on its row (name, size, reorder level).` });
      try {
        await sql`
          UPDATE store_parts SET sku = ${sku}, name = ${name}, category = ${String(b.category || '')}, machine = ${String(b.machine || '')},
                 brand = ${String(b.brand || '')}, supplier = ${String(b.supplier || '')}, rack_no = ${String(b.rackNo || '')},
                 unit = ${String(b.unit || 'pcs')}, min_qty = ${Number(b.minQty || 0) || 0}, description = ${String(b.desc || '')},
                 qty = COALESCE(${qtyVal}::double precision, qty),
                 size = CASE WHEN ${Object.prototype.hasOwnProperty.call(b, 'size')} THEN ${String(b.size || '').trim().slice(0, 60) || null} ELSE size END,
                 image_url = CASE WHEN ${imageProvided} THEN ${imageProvided ? (b.imageUrl || null) : null} ELSE image_url END
           WHERE id = ${id}`;
      } catch (e) {
        if (e.code === '23505' || /sku/i.test(String(e.message || ''))) return res.status(409).json({ error: `SKU "${sku}" already exists` });
        throw e;
      }
      let adjustmentTxn = null;
      if (qtyVal !== null && Number(before.qty) !== qtyVal) {
        const diff = roundQty(qtyVal - Number(before.qty || 0));
        const label = `Qty Edit (${diff > 0 ? 'increase' : 'decrease'})`;
        const detail = `Qty corrected via Edit: ${before.qty} → ${qtyVal} ${before.unit}`;
        const [t] = await sql`
          INSERT INTO store_tx (type, part_id, qty, date, ref, notes, issued_to, purpose, created_by, created_at)
          VALUES (${diff > 0 ? 'in' : 'out'}, ${id}, ${Math.abs(diff)}, ${todayPk()}::date, ${label}, ${detail}, ${label}, ${detail}, ${who(req)}, now())
          RETURNING id, type, part_id AS "partId", qty, date::text AS date, ref, notes, issued_to AS "issuedTo", purpose,
                    challan_no AS "challanNo", created_by AS "createdBy", created_at AS "createdAt"`;
        adjustmentTxn = t;
        await log(sql, req, `store.${before.module}.part.qty_edit`, `edited qty of "${labelOf(before)}": ${before.qty} → ${qtyVal} ${before.unit} (${diff > 0 ? '+' : ''}${diff})`, id);
      }
      res.json({ ok: true, adjustmentTxn });
    } catch (e) { fail(res, e); }
  });
  // Delete = to the Trash.
  app.delete('/api/store/parts', storeWrite('store.partdelete'), async (req, res) => {
    try {
      const sql = await db();
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'ID required' });
      if (await partsDenied(sql, req, res, [id])) return;
      const [ct] = await sql`SELECT name FROM store_parts WHERE id = ${id} AND carton_type_id IS NOT NULL`;
      if (ct) return res.status(409).json({ error: `"${ct.name}" is a Carton Shipper - delete it with Delete on its row (the carton type).` });
      // (A CTCP plate deleted here leaves the CTP Station's list too - its plate sizes come from the Store.)
      const [p] =await sql`UPDATE store_parts SET deleted_at = now() WHERE id = ${id} RETURNING name, sku, module`;
      await log(sql, req, `store.${(p && p.module) || 'unknown'}.part.trash`, `moved store part "${p ? labelOf(p) : '#' + id}" to trash`, id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Suppliers & Brands: change the supplier or brand of several Inks & Consumables items at once.
  app.post('/api/store/parts/relabel', storeWrite('store.settings'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const field = String(b.field || '');
      if (field !== 'supplier' && field !== 'brand') return res.status(400).json({ error: 'field must be supplier or brand' });
      const value = String(b.value == null ? '' : b.value).trim().slice(0, 120);
      const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(x => parseInt(x, 10)).filter(n => n > 0))].slice(0, 500);
      if (!ids.length) return res.status(400).json({ error: 'Pick at least one item' });
      if (modDenied(req, res, 'consumables')) return;
      const norm = s => String(s == null ? '' : s).trim().toLowerCase();
      const all = await sql`SELECT id, name, supplier, brand FROM store_parts WHERE module = 'consumables' AND deleted_at IS NULL`;
      const picked = all.filter(r => ids.includes(Number(r.id)));
      if (!picked.length) return res.status(404).json({ error: 'Those items were not found' });
      const keyOf = (r, changed) => `${norm(r.name)}|${norm(changed && field === 'supplier' ? value : r.supplier)}|${norm(changed && field === 'brand' ? value : r.brand)}`;
      const seen = new Map();
      for (const r of all) {
        const k = keyOf(r, ids.includes(Number(r.id)));
        const other = seen.get(k);
        if (other && (ids.includes(Number(r.id)) || ids.includes(Number(other.id)))) {
          const w = [field === 'supplier' ? value : r.supplier, field === 'brand' ? value : r.brand].filter(Boolean).join(' · ') || 'no supplier / brand';
          return res.status(409).json({ error: `"${r.name}" would then be in the store twice as ${w}. Change the other one first, or pick different items.` });
        }
        seen.set(k, r);
      }
      const pickIds = picked.map(r => Number(r.id));
      if (field === 'supplier') await sql`UPDATE store_parts SET supplier = ${value} WHERE id = ANY(${pickIds}) AND module = 'consumables' AND deleted_at IS NULL`;
      else await sql`UPDATE store_parts SET brand = ${value} WHERE id = ANY(${pickIds}) AND module = 'consumables' AND deleted_at IS NULL`;
      const names = [...new Set(picked.map(r => r.name))].slice(0, 3).join(', ');
      await log(sql, req, `store.consumables.${field}.change`, `changed the ${field} of ${picked.length} Inks & Consumables item${picked.length === 1 ? '' : 's'} (${names}${picked.length > 3 ? '…' : ''}) to ${value ? `"${value}"` : 'none'}`);
      res.json({ ok: true, updated: picked.length });
    } catch (e) { fail(res, e); }
  });

  // ── Stock movements ──
  app.get('/api/store/transactions', storeRead, async (req, res) => {
    try {
      const sql = await db();
      const mods = modulesFor(req.user);
      const rows = await sql(`SELECT ${TX_COLS} FROM store_tx t JOIN store_parts p ON p.id = t.part_id WHERE p.module = ANY($1) ORDER BY t.id DESC`, [mods]);
      res.json(rows);
    } catch (e) { fail(res, e); }
  });
  // Stock in / out - the quantity and the entry in ONE statement (as the ERP).
  app.post('/api/store/transactions', (req, res, next) => storeWrite(String((req.body || {}).type || '') === 'out' ? 'store.stockout' : 'store.stockin')(req, res, next), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const type = String(b.type || '');
      const partId = parseInt(b.partId, 10);
      const qty = roundQty(Number(b.qty));
      const date = String(b.date || '');
      if (!type || !partId || !date) return res.status(400).json({ error: 'type, partId, qty and date are required' });
      if (await partsDenied(sql, req, res, [partId])) return;
      if (!isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than zero' });
      if (type !== 'in' && type !== 'out') return res.status(400).json({ error: "type must be 'in' or 'out'" });
      const [p] = await sql`SELECT qty, name, sku, unit, module, category, carton_type_id FROM store_parts WHERE id = ${partId}`;
      if (!p) return res.status(400).json({ error: 'Part not found' });
      if (p.carton_type_id) return res.status(409).json({ error: `"${p.name}" is a Carton Shipper - use + Stock / − Stock on its row (the carton Stock In / Issue with E-Job, Manual Job, Other).` });
      if (type === 'out' && /ctcp|plates/i.test(String(p.category || ''))) return res.status(409).json({ error: `"${p.name}" is a CTCP plate - issue it with − Stock on its row (the plate Use with its reason, job and plates), or at the CTP Station.` });
      if (type === 'out' && p.qty < qty) return res.status(400).json({ error: `Not enough stock! Available: ${p.qty}` });
      let batch = null;
      if (p.module === 'consumables') {
        const { batches, any } = await batchBalances(sql, partId);
        const want = parseInt(b.batch, 10);
        if (type === 'in') {
          if (want > 0) {
            if (!(batches.some(x => x.n === want) && (any || want === 1))) return res.status(400).json({ error: `There is no ${ordinal(want)} batch of this item to add to.` });
            batch = want;
          } else {
            // A batch below zero (CTP plates used before their stock in was entered) is filled first; else a new batch.
            const neg = batches.find(x => x.qty < -0.0005);
            batch = neg ? neg.n : any ? batches[batches.length - 1].n + 1 : 1;
          }
        } else if (want > 0) {
          const hit = batches.find(x => x.n === want);
          if (!hit) return res.status(400).json({ error: `There is no ${ordinal(want)} batch of this item.` });
          if (hit.qty < qty - 0.0005) return res.status(400).json({ error: `Only ${hit.qty} ${p.unit || ''} left in the ${ordinal(want)} batch.`.replace('  ', ' ') });
          batch = want;
        } else if (batches.length <= 1) batch = 1;
        else return res.status(400).json({ error: 'This item has more than one batch. Choose which batch to take it from.' });
      }
      const ref = String(b.ref || ''), notes = String(b.notes || ''), issuedTo = String(b.issuedTo || ''), purpose = String(b.purpose || '');
      const challanNo = String(b.challanNo || '');
      const poNo = String(b.poNo || '').trim().slice(0, 60), invoiceNo = String(b.invoiceNo || '').trim().slice(0, 60);
      let orderId = null;
      if (type === 'in' && b.orderId) {
        orderId = parseInt(b.orderId, 10);
        const [o] = await sql`SELECT part_id, cancelled_at FROM store_orders WHERE id = ${orderId}`;
        if (!o || Number(o.part_id) !== partId) return res.status(400).json({ error: 'That order is not for this item.' });
        if (o.cancelled_at) return res.status(400).json({ error: 'That order was cancelled.' });
      }
      if (type === 'in' && !orderId && poNo) orderId = await orderForStockIn(sql, partId, poNo);
      const sign = type === 'in' ? 1 : -1;
      const [row] = await sql`
        WITH upd AS (
          UPDATE store_parts SET qty = ROUND((qty + ${sign * qty})::numeric, 3)::double precision
           WHERE id = ${partId} AND (${type} = 'in' OR qty >= ${qty})
          RETURNING id
        )
        INSERT INTO store_tx (type, part_id, qty, date, ref, notes, issued_to, purpose, challan_no, batch, po_no, invoice_no, order_id, created_by, created_at)
        SELECT ${type}, upd.id, ${qty}, ${date}::date, ${ref}, ${notes}, ${issuedTo}, ${purpose}, ${challanNo}, ${batch}::integer, ${poNo}, ${invoiceNo},
               ${orderId}::integer, ${who(req)}, now() FROM upd
        RETURNING id, type, part_id AS "partId", qty, date::text AS date, ref, notes, issued_to AS "issuedTo", purpose, challan_no AS "challanNo",
                  batch, po_no AS "poNo", invoice_no AS "invoiceNo", order_id AS "orderId", created_by AS "createdBy", created_at AS "createdAt"`;
      if (!row) {
        const [now] = await sql`SELECT qty FROM store_parts WHERE id = ${partId}`;
        return res.status(400).json({ error: `Not enough stock! Available: ${(now && now.qty) || 0}` });
      }
      await log(sql, req, `store.${p.module}.txn.${type}`,
        `${type === 'in' ? 'stocked' : 'issued'} ${qty} ${p.unit || ''} of "${labelOf(p)}"${orderId ? ` against order ${orderId}` : ''}${batch ? ` (${ordinal(batch)} batch)` : ''}${issuedTo ? ` to ${issuedTo}` : ''}${challanNo ? ` (challan ${challanNo})` : ''}`.trim(), row.id);
      res.json(row);
    } catch (e) { fail(res, e); }
  });
  // Reverse (the quantity comes back) or Delete from History (the records only) - ?id=42 or { ids, historyOnly }.
  app.delete('/api/store/transactions', storeRead, async (req, res) => {
    try {
      const sql = await db();
      let ids = [], historyOnly = false;
      if (req.query.id) ids = [parseInt(req.query.id, 10)].filter(Boolean);
      else {
        const body = req.body || {};
        if (Array.isArray(body.ids)) ids = body.ids.map(Number).filter(Boolean);
        historyOnly = body.historyOnly === true;
      }
      if (!ids.length) return res.status(400).json({ error: 'ID(s) required' });
      if (!can(req.user, historyOnly ? 'store.delete' : 'store.reverse')) return res.status(403).json({ error: 'Not allowed' });
      if (await txnsDenied(sql, req, res, ids)) return;
      // A plate Use / Stock In made at the CTP Station: it is changed there (its Delete puts the Store stock back too),
      // so the station's Register and the Store never disagree.
      const cartonRows = await sql`SELECT id, carton_tx_id FROM store_tx WHERE id = ANY(${ids}) AND carton_tx_id IS NOT NULL`;
      if (cartonRows.length) {
        if (historyOnly || ids.length > 1) return res.status(409).json({ error: 'Carton Shipper entries are reversed one at a time (Reverse on the entry) - they stay in the history.' });
        const r = await cartonReverse(req, cartonRows[0].carton_tx_id);
        if (r.code !== 200) return res.status(r.code).json(r.body || { error: 'Reverse failed' });
        return res.json({ ok: true, deleted: 0, reload: true });
      }
      // A CTP Station plate entry (owner, 2026-11-24: "store person can reverse it"): Reverse here = the CTP Register's
      // Reverse - the whole station entry (all its Store parts) goes and the stock comes back; the page reloads.
      const [pe] = await sql`SELECT id, reason FROM plate_stock_tx WHERE store_tx_ids && ${ids}::int[] LIMIT 1`;
      if (pe) {
        if (historyOnly || ids.length > 1) return res.status(409).json({ error: 'A CTP Station plate entry is reversed on its own (Reverse on the entry).' });
        if (pe.reason === 'plate-made' || !plateReverse) return res.status(409).json({ error: 'This was a plate made at the CTP Station - it is not reversed.' });
        const r = await plateReverse(req, pe.id);
        if (r.code !== 200) return res.status(r.code).json(r.body || { error: 'Reverse failed' });
        return res.json({ ok: true, deleted: 0, reload: true });
      }
      const txns = await sql`SELECT id, type, part_id, qty, date::text AS date, ref, issued_to FROM store_tx WHERE id = ANY(${ids})`;
      if (!txns.length) return res.json({ ok: true, deleted: 0 });
      const partIds = [...new Set(txns.map(t => t.part_id))];
      const parts = await sql`SELECT id, name, sku, unit, qty, module FROM store_parts WHERE id = ANY(${partIds})`;
      const partsMap = new Map(parts.map(p => [p.id, p]));
      if (!historyOnly) {
        const delta = new Map();
        for (const t of txns) delta.set(t.part_id, (delta.get(t.part_id) || 0) + (t.type === 'in' ? -t.qty : t.qty));
        for (const pid of partIds) {
          const p = partsMap.get(pid);
          if (!p) continue;
          const d = delta.get(pid) || 0;
          const projected = p.qty + d;
          // Only what the reversal makes worse is refused (a CTP plate may have left the item below zero already).
          if (projected < 0 && d < 0) return res.status(400).json({ error: `Cannot delete: would make "${p.name}" go below zero (current ${p.qty}, net reversal ${d}). Adjust stock first or use 'Delete from History' to purge without reversing qty.` });
          if (p.module === 'consumables') {
            const mine = txns.filter(t => t.part_id === pid).map(t => t.id);
            const before = new Map((await batchBalances(sql, pid)).batches.map(x => [x.n, x.qty]));
            const { batches } = await batchBalances(sql, pid, { skipTxns: mine, qtyOverride: projected });
            const low = batches.find(x => x.qty < -0.0005 && x.qty < (before.has(x.n) ? before.get(x.n) : 0) - 0.0005);
            if (low) return res.status(400).json({ error: `Cannot reverse this: it would leave the ${ordinal(low.n)} batch of "${p.name}" below zero, because stock was already issued from it. Reverse those issues first.` });
          }
        }
        await sql`
          WITH del AS (DELETE FROM store_tx WHERE id = ANY(${ids}) RETURNING part_id, type, qty),
               agg AS (SELECT part_id, SUM(CASE WHEN type = 'in' THEN -qty ELSE qty END) AS d FROM del GROUP BY part_id)
          UPDATE store_parts p SET qty = ROUND((p.qty + agg.d)::numeric, 3)::double precision FROM agg WHERE p.id = agg.part_id`;
      } else {
        await sql`DELETE FROM store_tx WHERE id = ANY(${ids})`;
      }
      for (const t of txns) {
        const p = partsMap.get(t.part_id);
        const label = p ? labelOf(p) : `part #${t.part_id}`;
        const verb = t.type === 'in' ? 'Stock In' : 'Stock Out';
        const w = t.type === 'in' ? (t.ref || '—') : (t.issued_to || '—');
        await log(sql, req, historyOnly ? `store.${(p && p.module) || 'unknown'}.txn.purge` : `store.${(p && p.module) || 'unknown'}.txn.delete`,
          `${historyOnly ? 'Purged from history' : 'Reversed'} ${verb}: ${t.type === 'in' ? '+' : '-'}${t.qty} ${(p && p.unit) || ''} of "${label}" on ${t.date} (${t.type === 'in' ? 'ref' : 'to'}: ${w})`, t.id);
      }
      res.json({ ok: true, deleted: txns.length });
    } catch (e) { fail(res, e); }
  });
  // A stock in's P.O. / Invoice No. and the batch no. on its sticker.
  app.put('/api/store/transactions/details', storeWrite('store'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'id is required' });
      if (await txnsDenied(sql, req, res, [id])) return;
      const poNo = String(b.poNo == null ? '' : b.poNo).trim().slice(0, 60), invoiceNo = String(b.invoiceNo == null ? '' : b.invoiceNo).trim().slice(0, 60);
      const hasLabel = Object.prototype.hasOwnProperty.call(b, 'batchLabel');
      const batchLabel = String(b.batchLabel == null ? '' : b.batchLabel).trim().slice(0, 40);
      const [row] = await sql`
        UPDATE store_tx SET po_no = ${poNo}, invoice_no = ${invoiceNo}, batch_label = CASE WHEN ${hasLabel} THEN ${batchLabel} ELSE batch_label END
         WHERE id = ${id} AND type = 'in'
        RETURNING id, part_id AS "partId", order_id AS "orderId", po_no AS "poNo", invoice_no AS "invoiceNo", batch_label AS "batchLabel"`;
      if (!row) return res.status(404).json({ error: 'That stock in was not found' });
      if (!row.orderId && poNo) {
        const orderId = await orderForStockIn(sql, Number(row.partId), poNo);
        if (orderId) { await sql`UPDATE store_tx SET order_id = ${orderId} WHERE id = ${id}`; row.orderId = orderId; }
      }
      await log(sql, req, 'store.consumables.txn.details', `set PO "${poNo || '—'}" and invoice "${invoiceNo || '—'}" on a stock in`, id);
      res.json(row);
    } catch (e) { fail(res, e); }
  });

  // ── "Does not add up": reconcile / ignore ──
  app.get('/api/store/ledger', storeRead, async (req, res) => {
    try { const sql = await db(); res.json(await sql`SELECT part_id AS "partId", diff FROM store_ledger_ignores`); } catch (e) { fail(res, e); }
  });
  app.post('/api/store/ledger', storeWrite('store.reconcile'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const action = String(b.action || '');
      const partId = parseInt(b.partId, 10);
      if (!partId) return res.status(400).json({ error: 'partId is required' });
      if (await partsDenied(sql, req, res, [partId])) return;
      const [part] = await sql`SELECT id, sku, name, unit, module FROM store_parts WHERE id = ${partId}`;
      if (!part) return res.status(404).json({ error: 'Part not found' });
      const label = labelOf(part);
      if (action === 'ignore') {
        const diff = roundQty(Number(b.diff));
        if (!isFinite(diff) || diff === 0) return res.status(400).json({ error: 'diff is required' });
        await sql`INSERT INTO store_ledger_ignores (part_id, diff, ignored_by) VALUES (${partId}, ${diff}, ${who(req)})
                  ON CONFLICT (part_id) DO UPDATE SET diff = EXCLUDED.diff, ignored_by = EXCLUDED.ignored_by, ignored_at = now()`;
        await log(sql, req, `store.${part.module}.ledger.ignore`, `ignored the "does not add up" warning for "${label}" (difference ${diff} ${part.unit || ''})`, partId);
        return res.json({ ok: true });
      }
      if (action === 'unignore') {
        await sql`DELETE FROM store_ledger_ignores WHERE part_id = ${partId}`;
        await log(sql, req, `store.${part.module}.ledger.unignore`, `stopped ignoring the "does not add up" warning for "${label}"`, partId);
        return res.json({ ok: true });
      }
      if (action === 'reconcile') {
        const [row] = await sql`
          INSERT INTO store_tx (type, part_id, qty, date, ref, notes, issued_to, purpose, challan_no, created_by, created_at)
          SELECT CASE WHEN p.qty > s.total THEN 'in' ELSE 'out' END, p.id,
                 ABS(ROUND((p.qty - s.total)::numeric, 3))::double precision,
                 CASE WHEN p.qty > s.total THEN COALESCE(s.first_day - 1, (now() AT TIME ZONE 'Asia/Karachi')::date)
                      ELSE (now() AT TIME ZONE 'Asia/Karachi')::date END,
                 CASE WHEN p.qty > s.total THEN 'Adjustment' ELSE '' END,
                 'Opening balance adjustment - brings the history in line with the quantity on hand',
                 CASE WHEN p.qty > s.total THEN '' ELSE 'Adjustment' END,
                 'Adjustment', '', ${who(req)}, now()
            FROM store_parts p
            CROSS JOIN LATERAL (SELECT COALESCE(SUM(CASE WHEN type = 'in' THEN qty ELSE -qty END), 0) AS total, MIN(date) AS first_day
                                  FROM store_tx WHERE part_id = p.id) s
           WHERE p.id = ${partId} AND ABS(p.qty - s.total) > 0.0005
          RETURNING id, type, qty, date::text AS date`;
        if (!row) return res.status(400).json({ error: 'This part already adds up - nothing to reconcile.' });
        await sql`DELETE FROM store_ledger_ignores WHERE part_id = ${partId}`;
        await log(sql, req, `store.${part.module}.txn.reconcile`, `reconciled "${label}": recorded an adjustment of ${row.type === 'in' ? '+' : '-'}${row.qty} ${part.unit || ''} dated ${row.date} (quantity on hand unchanged)`, partId);
        return res.json({ ok: true, adjustment: row });
      }
      res.status(400).json({ error: 'Unknown action' });
    } catch (e) { fail(res, e); }
  });

  // ── Categories / Machines (per section) ──
  for (const [path, table, what] of [['categories', 'store_categories', 'category'], ['machines', 'store_machines', 'machine']]) {
    app.get(`/api/store/${path}`, storeRead, async (req, res) => {
      try {
        const sql = await db();
        const mod = normMod(req.query.module);
        if (modDenied(req, res, mod)) return;
        const rows = await sql(`SELECT name FROM ${table} WHERE module = $1 ORDER BY name`, [mod]);
        res.json(rows.map(r => r.name));
      } catch (e) { fail(res, e); }
    });
    app.post(`/api/store/${path}`, storeWrite('store.settings'), async (req, res) => {
      try {
        const sql = await db();
        const b = req.body || {};
        const mod = normMod(b.module);
        if (modDenied(req, res, mod)) return;
        const name = String(b.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Name required' });
        await sql(`INSERT INTO ${table} (name, module) VALUES ($1, $2) ON CONFLICT (module, name) DO NOTHING`, [name, mod]);
        await log(sql, req, `store.${mod}.${what}.add`, `added store ${what} "${name}" (${mod})`);
        res.json({ ok: true });
      } catch (e) { fail(res, e); }
    });
    app.delete(`/api/store/${path}`, storeWrite('store.settings'), async (req, res) => {
      try {
        const sql = await db();
        const name = String(req.query.name || '');
        const mod = normMod(req.query.module);
        if (modDenied(req, res, mod)) return;
        if (!name) return res.status(400).json({ error: 'Name required' });
        const used = what === 'category'
          ? await sql`SELECT id FROM store_parts WHERE category = ${name} AND module = ${mod} AND deleted_at IS NULL LIMIT 1`
          : await sql`SELECT id FROM store_parts WHERE machine ~ ${'(^|,\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s*,|$)'} AND module = ${mod} AND deleted_at IS NULL LIMIT 1`;
        if (used.length) return res.status(400).json({ error: what === 'category' ? 'Cannot delete: parts are using this category. Reassign them first.' : 'Cannot delete: parts are assigned to this machine. Reassign them first.' });
        await sql(`DELETE FROM ${table} WHERE name = $1 AND module = $2`, [name, mod]);
        await log(sql, req, `store.${mod}.${what}.delete`, `deleted store ${what} "${name}" (${mod})`);
        res.json({ ok: true });
      } catch (e) { fail(res, e); }
    });
  }

  // ── Issued To: people not on the payroll (kept here) + the ERP's active employees (read) ──
  app.get('/api/store/recipients', storeRead, async (req, res) => {
    try { const sql = await db(); res.json(await sql`SELECT id, name FROM store_recipients ORDER BY name`); } catch (e) { fail(res, e); }
  });
  app.post('/api/store/recipients', storeWrite('store'), async (req, res) => {
    try {
      const sql = await db();
      const name = String((req.body || {}).name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name required' });
      if (name.length > 120) return res.status(400).json({ error: 'Name is too long' });
      const [made] = await sql`INSERT INTO store_recipients (name) VALUES (${name}) ON CONFLICT (LOWER(name)) DO NOTHING RETURNING id, name`;
      if (made) { await log(sql, req, 'store.recipient.add', `added store issue recipient "${name}"`); return res.json(made); }
      const [had] = await sql`SELECT id, name FROM store_recipients WHERE LOWER(name) = LOWER(${name}) LIMIT 1`;
      res.json(had || { id: 0, name });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/store/recipients', storeWrite('store'), async (req, res) => {
    try {
      const sql = await db();
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'ID required' });
      const [had] = await sql`DELETE FROM store_recipients WHERE id = ${id} RETURNING name`;
      if (!had) return res.status(404).json({ error: 'Not found' });
      await log(sql, req, 'store.recipient.delete', `removed store issue recipient "${had.name}"`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // The Issued To list: this app's Floor Operators - each person on an active machine / station, with the machine
  // under the name (owner, 2026-11-24: not the ERP's employees; any other name can still be typed and added).
  app.get('/api/store/employees', storeRead, async (req, res) => {
    try {
      const sql = await db();
      const rows = await sql`SELECT name, machine, persons FROM operators WHERE active = true ORDER BY name`;
      const seen = new Map();
      for (const r of rows) {
        const people = (Array.isArray(r.persons) ? r.persons : []).map(x => String((x && x.name) || '').trim()).filter(Boolean);
        const where = String(r.machine || r.name || '').trim();
        for (const n of people) {
          const k = n.toLowerCase();
          if (!seen.has(k)) seen.set(k, { code: '', name: n, department: where });
          else if (where && !seen.get(k).department.split(', ').includes(where)) seen.get(k).department += ', ' + where;
        }
      }
      res.json([...seen.values()].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) { fail(res, e); }
  });

  // ── Supplier / brand names hidden from the dropdowns ──
  app.get('/api/store/dropdown-hidden', storeRead, async (req, res) => {
    try { const sql = await db(); res.json(await sql`SELECT field, value FROM store_dropdown_hidden ORDER BY field, value`); } catch (e) { fail(res, e); }
  });
  app.post('/api/store/dropdown-hidden', storeWrite('store.settings'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const action = String(b.action || ''), field = String(b.field || ''), value = String(b.value || '').trim();
      if (field !== 'supplier' && field !== 'brand') return res.status(400).json({ error: 'field must be supplier or brand' });
      if (!value) return res.status(400).json({ error: 'value is required' });
      if (action === 'hide') {
        await sql`INSERT INTO store_dropdown_hidden (field, value, hidden_by) VALUES (${field}, ${value}, ${who(req)}) ON CONFLICT (field, value) DO NOTHING`;
        await log(sql, req, 'store.consumables.dropdown.hide', `hid the ${field} "${value}" from the Add / Edit dropdown`);
        return res.json({ ok: true });
      }
      if (action === 'show') {
        await sql`DELETE FROM store_dropdown_hidden WHERE field = ${field} AND value = ${value}`;
        await log(sql, req, 'store.consumables.dropdown.show', `showed the ${field} "${value}" in the Add / Edit dropdown again`);
        return res.json({ ok: true });
      }
      res.status(400).json({ error: 'action must be hide or show' });
    } catch (e) { fail(res, e); }
  });

  // ── Orders ──
  const text = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const isoDate = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v == null ? '' : v)) ? String(v) : null);
  const orderIn = b => ({
    partId: parseInt(String(b && b.partId != null ? b.partId : ''), 10) || null,
    itemName: text(b && b.itemName, 200), unit: text(b && b.unit, 20),
    qty: Math.round(Number(b && b.qty) * 1000) / 1000,
    supplier: text(b && b.supplier, 120), poNo: text(b && b.poNo, 60), notes: text(b && b.notes, 500),
    poId: parseInt(String(b && b.poId != null ? b.poId : ''), 10) || null, poSr: parseInt(String(b && b.poSr != null ? b.poSr : ''), 10) || null,
    orderDate: isoDate(b && b.orderDate), expectedDate: isoDate(b && b.expectedDate),
  });
  app.get('/api/store/orders', storeRead, async (req, res) => {
    try {
      const sql = await db();
      const mod = normMod(req.query.module || 'consumables');
      if (modDenied(req, res, mod)) return;
      const rows = await sql`
        SELECT o.id, o.part_id AS "partId", o.item_name AS "itemName", o.unit, o.qty, o.supplier, o.po_no AS "poNo",
               o.po_id AS "poId", o.po_sr AS "poSr", o.order_date::text AS "orderDate", o.expected_date::text AS "expectedDate", o.notes,
               o.cancelled_at AS "cancelledAt", o.created_by AS "createdBy", o.created_at AS "createdAt",
               COALESCE((SELECT SUM(t.qty) FROM store_tx t WHERE t.order_id = o.id AND t.type = 'in'), 0) AS "receivedQty",
               (SELECT MAX(t.date)::text FROM store_tx t WHERE t.order_id = o.id AND t.type = 'in') AS "lastReceived"
          FROM store_orders o LEFT JOIN store_parts p ON p.id = o.part_id
         WHERE COALESCE(p.module, o.module) = ${mod}
         ORDER BY o.id DESC`;
      res.json(rows.map(r => ({ ...r, qty: Number(r.qty), receivedQty: Number(r.receivedQty) })));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/store/orders', storeWrite('store.orders'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const mod = normMod(b.module || 'consumables');
      if (modDenied(req, res, mod)) return;
      const list = (Array.isArray(b.orders) ? b.orders : [b]).map(orderIn);
      if (!list.length) return res.status(400).json({ error: 'Nothing to order.' });
      for (const o of list) {
        if (!o.partId && !o.itemName) return res.status(400).json({ error: 'Choose the item that was ordered.' });
        if (!(o.qty > 0)) return res.status(400).json({ error: `Enter the quantity ordered${o.itemName ? ` for ${o.itemName}` : ''}.` });
        if (!o.orderDate) return res.status(400).json({ error: 'Enter the order date.' });
      }
      const ids = list.map(o => o.partId).filter(Boolean);
      if (await partsDenied(sql, req, res, ids)) return;
      const names = new Map();
      if (ids.length) {
        for (const p of await sql`SELECT id, name, unit, module FROM store_parts WHERE id = ANY(${ids}) AND deleted_at IS NULL`) names.set(Number(p.id), p);
        if (ids.some(i => !names.has(i))) return res.status(400).json({ error: 'One of those items was not found in the Store.' });
      }
      const made = [];
      for (const o of list) {
        const p = o.partId ? names.get(o.partId) : null;
        const [row] = await sql`
          INSERT INTO store_orders (part_id, item_name, unit, module, qty, supplier, po_no, po_id, po_sr, order_date, expected_date, notes, created_by)
          VALUES (${o.partId}, ${p ? String(p.name) : o.itemName}, ${p ? String(p.unit || '') : o.unit}, ${mod}, ${o.qty}, ${o.supplier}, ${o.poNo},
                  ${o.poId}, ${o.poSr}, ${o.orderDate}::date, ${o.expectedDate}::date, ${o.notes}, ${who(req)})
          RETURNING id`;
        made.push(Number(row.id));
      }
      const f = list[0];
      const fp = f.partId ? names.get(f.partId) : null;
      await log(sql, req, 'store.order.create', list.length > 1
        ? `ordered ${list.length} items${f.poNo ? ` on PO ${f.poNo}` : ''}${f.supplier ? ` from ${f.supplier}` : ''}`
        : `ordered ${f.qty} ${(fp ? fp.unit : f.unit) || ''} of "${fp ? fp.name : f.itemName}"${f.supplier ? ` from ${f.supplier}` : ''}${f.poNo ? ` (PO ${f.poNo})` : ''}`.replace('  ', ' '));
      res.json({ ok: true, ids: made });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/store/orders', storeWrite('store.orders', 'store.stockin'), async (req, res) => {
    try {
      const sql = await db();
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      const [o] = await sql`
        SELECT o.part_id AS "partId", o.module, COALESCE(p.name, o.item_name) AS name, COALESCE(p.unit, o.unit) AS unit,
               COALESCE((SELECT SUM(t.qty) FROM store_tx t WHERE t.order_id = o.id AND t.type = 'in'), 0) AS received
          FROM store_orders o LEFT JOIN store_parts p ON p.id = o.part_id WHERE o.id = ${id}`;
      if (!o) return res.status(404).json({ error: 'That order was not found.' });
      if (modDenied(req, res, o.module)) return;
      if (o.partId && await partsDenied(sql, req, res, [Number(o.partId)])) return;
      // Linking an item: the receiver (Stock In) may do it.
      if (b.partId !== undefined && Object.keys(b).every(k => k === 'id' || k === 'partId')) {
        const partId = parseInt(b.partId, 10);
        if (o.partId) return res.status(400).json({ error: 'This order is already for a Store item.' });
        const [p] = await sql`SELECT name, module FROM store_parts WHERE id = ${partId} AND deleted_at IS NULL`;
        if (!p || p.module !== o.module) return res.status(400).json({ error: 'That item was not found in this store.' });
        await sql`UPDATE store_orders SET part_id = ${partId} WHERE id = ${id}`;
        await log(sql, req, 'store.order.link', `linked order ${id} ("${o.name}") to the Store item "${p.name}"`);
        return res.json({ ok: true });
      }
      if (!can(req.user, 'store.orders')) return res.status(403).json({ error: 'Not allowed' });
      if (typeof b.cancel === 'boolean') {
        if (b.cancel) await sql`UPDATE store_orders SET cancelled_at = now() WHERE id = ${id}`;
        else await sql`UPDATE store_orders SET cancelled_at = NULL WHERE id = ${id}`;
        await log(sql, req, b.cancel ? 'store.order.cancel' : 'store.order.uncancel', `${b.cancel ? 'cancelled' : 're-opened'} the order of "${o.name}" (order ${id})`);
        return res.json({ ok: true });
      }
      const f = orderIn(b);
      if (!(f.qty > 0)) return res.status(400).json({ error: 'Enter the quantity ordered.' });
      if (f.qty < Number(o.received) - 0.0005) return res.status(400).json({ error: `${o.received} ${o.unit || ''} has already come in against this order; the order can't be less than that.`.replace('  ', ' ') });
      if (!f.orderDate) return res.status(400).json({ error: 'Enter the order date.' });
      await sql`UPDATE store_orders SET qty = ${f.qty}, supplier = ${f.supplier}, po_no = ${f.poNo}, order_date = ${f.orderDate}::date,
                       expected_date = ${f.expectedDate}::date, notes = ${f.notes} WHERE id = ${id}`;
      await log(sql, req, 'store.order.update', `changed the order of "${o.name}" (order ${id}): ${f.qty} ${o.unit || ''}`.trim());
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/store/orders', storeWrite('store.orders'), async (req, res) => {
    try {
      const sql = await db();
      const id = parseInt(req.query.id, 10);
      const [o] = await sql`
        SELECT o.part_id AS "partId", o.module, COALESCE(p.name, o.item_name) AS name,
               (SELECT COUNT(*) FROM store_tx t WHERE t.order_id = o.id) AS n
          FROM store_orders o LEFT JOIN store_parts p ON p.id = o.part_id WHERE o.id = ${id}`;
      if (!o) return res.status(404).json({ error: 'That order was not found.' });
      if (modDenied(req, res, o.module)) return;
      if (Number(o.n) > 0) return res.status(400).json({ error: "Stock has come in against this order, so it can't be deleted - cancel it instead." });
      await sql`DELETE FROM store_orders WHERE id = ${id}`;
      await log(sql, req, 'store.order.delete', `deleted the order of "${o.name}" (order ${id})`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // Orders -> New Order from a Procurement P.O. (read from the ERP): its lines, each matched to a Store item.
  app.get('/api/store/po-lookup', storeWrite('store.orders'), async (req, res) => {
    try {
      const sql = await db();
      const mod = req.query.module === 'machinery' ? 'machinery' : 'consumables';
      if (modDenied(req, res, mod)) return;
      const poNo = parseInt(String(req.query.poNo || '').replace(/[^0-9]/g, ''), 10);
      const erp = erpSql();
      if (!poNo || !erp) return res.json({ pos: [] });
      const pos = await erp`
        SELECT id, po_no AS "poNo", registered, date::text AS date, expected_date::text AS "expectedDate",
               supplier_name AS "supplierName", supplier_brand AS "supplierBrand", items
          FROM purchase_orders WHERE po_no = ${poNo} ORDER BY id DESC`;
      if (!pos.length) return res.json({ pos: [] });
      const parts = await sql`SELECT id, name, sku, unit, supplier, brand FROM store_parts WHERE module = ${mod} AND deleted_at IS NULL`;
      const booked = await sql`SELECT po_id AS "poId", po_sr AS "poSr", SUM(qty) AS qty FROM store_orders
                                WHERE po_id = ANY(${pos.map(p => Number(p.id))}) AND cancelled_at IS NULL GROUP BY po_id, po_sr`;
      const byKey = new Map();
      for (const p of parts) for (const k of new Set([productKey(p.name), productKey(`${p.sku || ''} ${p.name}`)])) {
        if (!k) continue;
        byKey.set(k, [...(byKey.get(k) || []), p]);
      }
      const matchFor = (desc, supplier) => {
        const k = productKey(desc);
        if (!k) return null;
        let cands = byKey.get(k) || [], how = 'same name';
        if (!cands.length) { cands = parts.filter(p => { const pk = productKey(p.name); return pk.length >= 6 && (k.includes(pk) || pk.includes(k)); }); how = 'close name'; }
        if (!cands.length) return null;
        const sk = productKey(supplier);
        const best = cands.find(p => sk && productKey(p.supplier) === sk) || cands[0];
        return { partId: Number(best.id), how, others: cands.length - 1 };
      };
      const parseItems = raw => { if (!raw) return []; try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
      const qtyToNum = s => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); if (!m) return null; const n = parseFloat(m[0]); return isNaN(n) ? null : n; };
      const lineUnit = it => { const u = String(it.uom == null ? '' : it.uom).trim(); if (u) return u; const m = String(it.quantity == null ? '' : it.quantity).trim().match(/^[\d.,\s]+([A-Za-z][A-Za-z .]{0,19})$/); return m ? m[1].trim().replace(/\.$/, '') : ''; };
      res.json({
        pos: pos.map(po => ({
          id: po.id, poNo: po.poNo, label: po.poNo == null ? '' : `${po.poNo}${po.registered === false ? 'u' : ''}`, registered: po.registered,
          date: po.date, expectedDate: po.expectedDate, supplierName: po.supplierName || '', supplierBrand: po.supplierBrand || '',
          items: parseItems(po.items).filter(it => String(it.description || it.item || '').trim()).map(it => {
            const description = String(it.description || it.item || '').trim();
            const bk = booked.find(x => Number(x.poId) === Number(po.id) && Number(x.poSr) === Number(it.srNo));
            return { srNo: it.srNo, description, quantity: qtyToNum(it.quantity) || 0, uom: lineUnit(it), rate: qtyToNum(it.rate),
                     match: matchFor(description, String(po.supplierName || '')), booked: bk ? Number(bk.qty) : 0 };
          }),
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // ── Trash ──
  app.get('/api/store/trash', storeRead, async (req, res) => {
    try {
      const sql = await db();
      const mod = normMod(req.query.module);
      if (modDenied(req, res, mod)) return;
      const all = req.query.all === '1';
      const items = await sql`
        SELECT id, sku, name, category, machine, module, unit, qty, brand, supplier, rack_no AS "rackNo", min_qty AS "minQty",
               description AS "desc", deleted_at::text AS "deletedAt", archived_at::text AS "archivedAt"
          FROM store_parts WHERE module = ${mod} AND deleted_at IS NOT NULL AND (${all} OR archived_at IS NULL)
         ORDER BY deleted_at DESC`;
      res.json({ items });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/store/trash', storeWrite('store.partdelete'), async (req, res) => {
    try {
      const sql = await db();
      const id = Number((req.body || {}).id);
      if (!id) return res.status(400).json({ error: 'ID required' });
      if (await partsDenied(sql, req, res, [id])) return;
      const [t] = await sql`SELECT sku, name, module FROM store_parts WHERE id = ${id} AND deleted_at IS NOT NULL`;
      if (!t) return res.status(404).json({ error: 'Trashed part not found' });
      if (t.sku) {
        const [clash] = await sql`SELECT id, sku, name FROM store_parts WHERE LOWER(sku) = LOWER(${t.sku}) AND deleted_at IS NULL AND id <> ${id} LIMIT 1`;
        if (clash) return res.status(409).json({ error: `Cannot restore: SKU "${t.sku}" is already used by active part "${clash.name}". Rename or delete that one first.` });
      }
      await sql`UPDATE store_parts SET deleted_at = NULL, archived_at = NULL WHERE id = ${id}`;
      await log(sql, req, `store.${t.module}.part.restore`, `restored store part "${labelOf(t)}" from trash`, id);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/store/trash', storeWrite('store.partdelete'), async (req, res) => {
    try {
      const sql = await db();
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'ID required' });
      if (await partsDenied(sql, req, res, [id])) return;
      const [t] = await sql`SELECT module FROM store_parts WHERE id = ${id} AND deleted_at IS NOT NULL`;
      const hasHistory = (await sql`SELECT 1 FROM store_tx WHERE part_id = ${id} LIMIT 1`).length > 0;
      if (hasHistory) await sql`UPDATE store_parts SET archived_at = now() WHERE id = ${id} AND deleted_at IS NOT NULL AND archived_at IS NULL`;
      else await sql`DELETE FROM store_parts WHERE id = ${id} AND deleted_at IS NOT NULL`;
      await log(sql, req, `store.${(t && t.module) || 'unknown'}.part.purge`, hasHistory ? `removed store part #${id} from the Trash (its history is kept)` : `permanently deleted store part #${id} (it had no history)`, id);
      res.json({ ok: true, archived: hasHistory });
    } catch (e) { fail(res, e); }
  });

  // ── Photos (kept in this database; the page resizes them before sending) ──
  app.post('/api/store/upload', storeWrite('store'), require('express').raw({ type: 'image/*', limit: '6mb' }), async (req, res) => {
    try {
      const sql = await db();
      const type = String(req.headers['content-type'] || 'image/jpeg');
      if (!/^image\//i.test(type)) return res.status(400).json({ error: 'Only image uploads are accepted' });
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buf || !buf.length) return res.status(400).json({ error: 'Empty upload' });
      if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (5 MB max)' });
      const [row] = await sql`INSERT INTO store_images (data, content_type, created_by) VALUES (${'\\x' + buf.toString('hex')}::bytea, ${type}, ${who(req)}) RETURNING id`;
      res.json({ url: `/api/store/image/${row.id}`, pathname: `store-parts/${row.id}` });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/store/upload', storeWrite('store'), async (req, res) => {
    try {
      const m = /\/api\/store\/image\/(\d+)$/.exec(String(req.query.url || ''));
      if (m) { const sql = await db(); await sql`DELETE FROM store_images WHERE id = ${parseInt(m[1], 10)}`; }
      res.json({ ok: true });   // an old ERP photo link is left as it is
    } catch (e) { fail(res, e); }
  });
  app.get('/api/store/image/:id', requireAuth, async (req, res) => {
    try {
      const sql = await db();
      const [img] = await sql`SELECT encode(data, 'base64') AS b64, content_type FROM store_images WHERE id = ${parseInt(req.params.id, 10)}`;
      if (!img) return res.status(404).end();
      res.setHeader('Content-Type', img.content_type);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.end(Buffer.from(img.b64, 'base64'));
    } catch (e) { fail(res, e); }
  });

  // ── Copy from the ERP (Super Admin; owner 2026-11-24: "wholeee... even the past data") ──
  // Everything of the ERP store comes over with the SAME ids, so every link (an entry's item, an order's stock ins)
  // stays as it was: categories, machines, Issued To names, items (also those in the Trash or removed from it, whose
  // history is kept), every stock in / out with its date, time, person, batch, P.O. / Invoice No., orders, ignored
  // warnings and hidden dropdown names. The ERP is only READ. What is in this store is REPLACED (until the switch the
  // ERP is the real store). Then every item is checked against the ERP: quantity, entries, in, out, each batch.
  // (Times come over as text, so they keep their microseconds - a JS Date would drop them.)
  const ERP_COPY = [
    { from: 'categories', to: 'store_categories', cols: 'id, name, module' },
    { from: 'machines', to: 'store_machines', cols: 'id, name, module' },
    { from: 'store_recipients', to: 'store_recipients', cols: 'id, name, created_at::text AS created_at' },
    { from: 'parts', to: 'store_parts', cols: 'id, sku, name, category, module, machine, brand, supplier, rack_no, unit, qty, min_qty, description, image_url, deleted_at::text AS deleted_at, archived_at::text AS archived_at' },
    { from: 'store_orders', to: 'store_orders', cols: 'id, part_id, qty, supplier, po_no, order_date::text AS order_date, expected_date::text AS expected_date, notes, cancelled_at::text AS cancelled_at, created_by, created_at::text AS created_at, item_name, unit, module, po_id, po_sr' },
    { from: 'transactions', to: 'store_tx', cols: 'id, type, part_id, qty, date::text AS date, ref, notes, issued_to, purpose, challan_no, created_by, batch, po_no, invoice_no, batch_label, created_at::text AS created_at, order_id' },
    { from: 'store_ledger_ignores', to: 'store_ledger_ignores', cols: 'part_id, diff, ignored_by, ignored_at::text AS ignored_at', noId: true },
    { from: 'store_dropdown_hidden', to: 'store_dropdown_hidden', cols: 'field, value, hidden_by, hidden_at::text AS hidden_at', noId: true },
  ];
  // One side's figures per item: quantity, entries, in, out, and each batch.
  async function storeFigures(q, partsT, txT, where) {
    const parts = await q(`SELECT p.id, p.qty, COUNT(t.id)::int AS n,
                                  COALESCE(SUM(CASE WHEN t.type = 'in' THEN t.qty END), 0) AS i,
                                  COALESCE(SUM(CASE WHEN t.type = 'out' THEN t.qty END), 0) AS o
                             FROM ${partsT} p LEFT JOIN ${txT} t ON t.part_id = p.id ${where || ''} GROUP BY p.id, p.qty`, []);
    const batches = await q(`SELECT part_id, COALESCE(batch, 1) AS b, SUM(CASE WHEN type = 'in' THEN qty ELSE -qty END) AS bal
                               FROM ${txT} GROUP BY 1, 2`, []);
    const m = new Map();
    for (const p of parts) m.set(Number(p.id), { qty: roundQty(Number(p.qty)), n: Number(p.n), i: roundQty(Number(p.i)), o: roundQty(Number(p.o)), b: {} });
    for (const r of batches) { const x = m.get(Number(r.part_id)); if (x) x.b[Number(r.b)] = roundQty(Number(r.bal)); }
    return m;
  }
  // Every table, every row, every column: a fingerprint of all of it on each side (owner, 2026-11-24: "confirm that its
  // right"). Times are compared as moments, so the two databases' time zones don't matter.
  const FP = [
    { erp: 'categories', here: 'store_categories', key: 'id', cols: ['id', 'name', 'module'], hereWhere: "NOT (module = 'consumables' AND name = 'Carton Shippers')" },
    { erp: 'machines', here: 'store_machines', key: 'id', cols: ['id', 'name', 'module'] },
    { erp: 'store_recipients', here: 'store_recipients', key: 'id', cols: ['id', 'name', 'created_at:t'] },
    { erp: 'parts', here: 'store_parts', key: 'id', cols: ['id', 'sku', 'name', 'category', 'module', 'machine', 'brand', 'supplier', 'rack_no', 'unit', 'qty', 'min_qty', 'description', 'image_url:img', 'deleted_at:t', 'archived_at:t'], hereWhere: 'carton_type_id IS NULL' },
    { erp: 'store_orders', here: 'store_orders', key: 'id', cols: ['id', 'part_id', 'qty', 'supplier', 'po_no', 'order_date', 'expected_date', 'notes', 'cancelled_at:t', 'created_by', 'created_at:t', 'item_name', 'unit', 'module', 'po_id', 'po_sr'] },
    { erp: 'transactions', here: 'store_tx', key: 'id', cols: ['id', 'type', 'part_id', 'qty', 'date', 'ref', 'notes', 'issued_to', 'purpose', 'challan_no', 'created_by', 'batch', 'po_no', 'invoice_no', 'batch_label', 'created_at:t', 'order_id'], hereWhere: 'carton_tx_id IS NULL' },
    { erp: 'store_ledger_ignores', here: 'store_ledger_ignores', key: 'part_id', cols: ['part_id', 'diff', 'ignored_by', 'ignored_at:t'] },
    { erp: 'store_dropdown_hidden', here: 'store_dropdown_hidden', key: "field || '|' || value", cols: ['field', 'value', 'hidden_by', 'hidden_at:t'] },
  ];
  const fpSql = (t, table) => {
    const here = table === t.here;
    const parts = t.cols.map(c => {
      const [n, k] = c.split(':');
      if (k === 't') return `COALESCE(EXTRACT(EPOCH FROM ${n})::text, '~')`;
      // A photo brought here is compared by the ERP link it came from.
      if (k === 'img' && here) return `COALESCE((SELECT i.source_url FROM store_images i WHERE '/api/store/image/' || i.id = ${table}.image_url), image_url, '~')`;
      return `COALESCE(${n}::text, '~')`;
    });
    return `SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(x, E'\\n' ORDER BY k), '')) AS h
              FROM (SELECT (${t.key})::text AS k, ${parts.join(` || '|' || `)} AS x FROM ${table}${here && t.hereWhere ? ' WHERE ' + t.hereWhere : ''}) s`;
  };
  async function fingerprints(sql, erp) {
    const out = [];
    for (const t of FP) {
      const [[a], [b]] = await Promise.all([erp(fpSql(t, t.erp), []), sql(fpSql(t, t.here), [])]);
      out.push({ table: t.erp, erp: Number(a.n), here: Number(b.n), match: a.h === b.h && Number(a.n) === Number(b.n) });
    }
    return out;
  }
  async function compareWithErp(sql, erp) {
    const [a, b] = await Promise.all([storeFigures((s, p) => erp(s, p), 'parts', 'transactions'), storeFigures((s, p) => sql(s, p), 'store_parts', 'store_tx', 'WHERE p.carton_type_id IS NULL')]);
    const names = new Map((await sql`SELECT id, sku, name, module FROM store_parts WHERE carton_type_id IS NULL`).map(p => [Number(p.id), p]));
    const diffs = [];
    for (const [id, e] of a) {
      const t = b.get(id);
      const nm = names.get(id) ? labelOf(names.get(id)) : `#${id}`;
      if (!t) { diffs.push({ id, item: nm, what: 'missing here' }); continue; }
      const out = [];
      for (const k of ['qty', 'n', 'i', 'o']) if (Math.abs(e[k] - t[k]) > 0.0005) out.push(`${{ qty: 'quantity', n: 'entries', i: 'in', o: 'out' }[k]} ERP ${e[k]} / here ${t[k]}`);
      for (const bn of new Set([...Object.keys(e.b), ...Object.keys(t.b)])) {
        if (Math.abs((e.b[bn] || 0) - (t.b[bn] || 0)) > 0.0005) out.push(`${ordinal(Number(bn))} batch ERP ${e.b[bn] || 0} / here ${t.b[bn] || 0}`);
      }
      if (out.length) diffs.push({ id, item: nm, what: out.join('; ') });
    }
    for (const id of b.keys()) if (!a.has(id)) diffs.push({ id, item: names.get(id) ? labelOf(names.get(id)) : `#${id}`, what: 'not in the ERP' });
    return { items: a.size, diffs };
  }
  let _copying = false;
  app.post('/api/store/erp-copy', requireAuth, async (req, res) => {
    if (!isSA(req.user)) return res.status(403).json({ error: 'Super Admin only' });
    const erp = erpSql();
    if (!erp) return res.status(400).json({ error: 'The ERP link is not set (ERP_DATABASE_URL).' });
    const checkOnly = !!(req.body && req.body.check_only);
    if (_copying) return res.status(409).json({ error: 'A copy is already running - wait for it to finish.' });
    _copying = true;
    try {
      const sql = await db();
      const counts = {};
      if (!checkOnly) {
        // Read everything first - nothing here changes unless the whole ERP store was read.
        const data = {};
        for (const t of ERP_COPY) data[t.to] = await erp(`SELECT ${t.cols} FROM ${t.from}${t.noId ? '' : ' ORDER BY id'}`, []);
        // 1) The ERP's rows go into staging tables first (same columns) - the Store itself is not touched yet, so a
        //    failure or a time-out here changes nothing.
        for (const t of ERP_COPY) {
          // Made fresh each time, so it always has the table's current columns.
          await sql(`DROP TABLE IF EXISTS ${t.to}__stage`, []);
          await sql(`CREATE TABLE ${t.to}__stage (LIKE ${t.to})`, []);
          const rows = data[t.to];
          for (let k = 0; k < rows.length; k += 1500) {
            await sql(`INSERT INTO ${t.to}__stage SELECT * FROM json_populate_recordset(NULL::${t.to}, $1::json)`, [JSON.stringify(rows.slice(k, k + 1500))]);
          }
          counts[t.from] = rows.length;
        }
        // Plate sizes linked to Store items: kept only where the same item (same id AND name) comes back from the ERP;
        // the CTP Station's entries forget their old Store entries (those are replaced), so nothing points at a wrong one.
        const linked = await sql`SELECT s.id, s.store_part_id, p.name FROM plate_sizes s LEFT JOIN store_parts p ON p.id = s.store_part_id WHERE s.store_part_id IS NOT NULL`;
        const erpNames = new Map(data.store_parts.map(p => [Number(p.id), String(p.name || '')]));
        const unlink = linked.filter(l => erpNames.get(Number(l.store_part_id)) !== String(l.name || '')).map(l => Number(l.id));
        // 2) The swap in ONE transaction: the old Store contents out, the ERP's in, the numbering after them - all or
        //    nothing.
        const steps = [];
        if (unlink.length) steps.push(sql`UPDATE plate_sizes SET store_part_id = NULL WHERE id = ANY(${unlink})`);
        steps.push(sql`UPDATE plate_stock_tx SET store_tx_ids = NULL WHERE store_tx_ids IS NOT NULL`);
        for (const t of ['store_ledger_ignores', 'store_tx', 'store_orders', 'store_parts', 'store_categories', 'store_machines', 'store_recipients', 'store_dropdown_hidden']) steps.push(sql(`DELETE FROM ${t}`, []));
        for (const t of ERP_COPY) {
          steps.push(sql(`INSERT INTO ${t.to} SELECT * FROM ${t.to}__stage`, []));
          if (!t.noId) steps.push(sql(`SELECT setval(pg_get_serial_sequence('${t.to}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t.to}), 1), (SELECT COUNT(*) > 0 FROM ${t.to}))`, []));
        }
        await sql.transaction(steps);
        for (const t of ERP_COPY) await sql(`TRUNCATE ${t.to}__stage`, []);
        // The Carton Shippers are the Job Tracker's own (the ERP has none): they come back into the Store.
        if (afterErpCopy) { try { await afterErpCopy(sql); counts.carton_shippers = 'rebuilt'; } catch (e) { counts.carton_shippers = 'NOT rebuilt: ' + e.message; } }
      }
      const check = await compareWithErp(sql, erp);
      const tables = await fingerprints(sql, erp);
      const tablesOff = tables.filter(t => !t.match);
      await log(sql, req, checkOnly ? 'store.erp_check' : 'store.erp_copy',
        `${checkOnly ? 'Checked the Store against the ERP' : 'Copied the whole Store from the ERP (' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') + ')'}: ${check.items} items, ${check.diffs.length ? check.diffs.length + ' do not match' : 'all match'}; every row and column of ${tables.length - tablesOff.length} of ${tables.length} tables identical${tablesOff.length ? ' (not: ' + tablesOff.map(t => t.table).join(', ') + ')' : ''}`);
      res.json({ ok: true, copied: checkOnly ? null : counts, items: check.items, diffs: check.diffs.slice(0, 200), diffCount: check.diffs.length, tables });
    } catch (e) { fail(res, e); } finally { _copying = false; }
  });

  // ── Photos from the ERP (owner, 2026-11-24: "obv photos should shift here") ──
  // Each item whose photo is still the ERP's link: the photo is fetched and kept in this database, and the item points
  // to it. Only the ERP's photo storage (Vercel Blob) is fetched. A part at a time, so the page can call it again until
  // nothing is left (each call stops before the server's time limit).
  const ERP_PHOTO_HOST = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;
  app.post('/api/store/erp-photos', requireAuth, async (req, res) => {
    if (!isSA(req.user)) return res.status(403).json({ error: 'Super Admin only' });
    try {
      const sql = await db();
      const started = Date.now();
      const todo = await sql`SELECT id, image_url FROM store_parts WHERE image_url LIKE 'https://%' ORDER BY id`;
      let copied = 0, reused = 0;
      const failed = [];
      for (const p of todo) {
        if (Date.now() - started > 40000) break;
        const url = String(p.image_url);
        const [had] = await sql`SELECT id FROM store_images WHERE source_url = ${url} LIMIT 1`;
        if (had) { await sql`UPDATE store_parts SET image_url = ${'/api/store/image/' + had.id} WHERE id = ${p.id}`; reused++; continue; }
        if (!ERP_PHOTO_HOST.test(url)) { failed.push({ id: p.id, why: 'not an ERP photo link' }); continue; }
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const type = String(r.headers.get('content-type') || 'image/jpeg');
          if (!/^image\//i.test(type)) throw new Error('not an image');
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length || buf.length > 5 * 1024 * 1024) throw new Error('empty or over 5 MB');
          const [img] = await sql`INSERT INTO store_images (data, content_type, created_by, source_url) VALUES (${'\\x' + buf.toString('hex')}::bytea, ${type}, 'Copy from ERP', ${url}) RETURNING id`;
          await sql`UPDATE store_parts SET image_url = ${'/api/store/image/' + img.id} WHERE id = ${p.id}`;
          copied++;
        } catch (e) { failed.push({ id: p.id, why: e.message }); }
      }
      // Still left: not yet done this call (the failed ones stay on the ERP link - they still show from there).
      const failedIds = failed.map(f => Number(f.id));
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM store_parts WHERE image_url LIKE 'https://%' AND NOT (id = ANY(${failedIds.length ? failedIds : [0]}))`;
      if (copied || reused) await log(sql, req, 'store.erp_photos', `Brought ${copied} item photo${copied === 1 ? '' : 's'} from the ERP into the Store${reused ? ` (${reused} already here)` : ''}${failed.length ? ` · ${failed.length} could not be fetched` : ''}`);
      res.json({ ok: true, copied, reused, failed, left: n });
    } catch (e) { fail(res, e); }
  });

  // ── Plates from the CTP Station (owner, 2026-11-24): plates are Store items (CTCP Plates); the station's Use / Stock
  // In moves the stock of the Store item its plate size is linked to. Out: oldest batch first (a shortfall comes off
  // the last batch used - the station may run below zero, as before, until the stock in is entered); In: a new batch.
  // Returns the Store entry ids, so the station entry can be reversed with them.
  async function plateMove(sql, o) {
    await ensureStore();
    const [p] = await sql`SELECT id, qty, module FROM store_parts WHERE id = ${o.partId} AND deleted_at IS NULL`;
    if (!p) throw new Error('The Store item of this plate is not there any more - link the plate to its Store item again (Edit).');
    const qty = roundQty(Math.abs(Number(o.change) || 0));
    if (!(qty > 0)) return [];
    const date = o.date || todayPk();
    const ids = [];
    if (o.change > 0) {
      let batch = null;
      if (p.module === 'consumables') {
        // A batch below zero (plates used before this stock in) is filled first; else a new batch.
        const { batches, any } = await batchBalances(sql, p.id);
        const neg = batches.find(x => x.qty < -0.0005);
        batch = neg ? neg.n : any ? batches[batches.length - 1].n + 1 : 1;
      }
      const [t] = await sql`
        WITH upd AS (UPDATE store_parts SET qty = ROUND((qty + ${qty})::numeric, 3)::double precision WHERE id = ${p.id} RETURNING id)
        INSERT INTO store_tx (type, part_id, qty, date, ref, notes, issued_to, purpose, challan_no, batch, created_by, created_at)
        SELECT 'in', upd.id, ${qty}, ${date}::date, ${o.ref || ''}, ${o.notes || ''}, '', '', ${o.challanNo || ''}, ${batch}::integer, ${o.by || ''}, now() FROM upd
        RETURNING id`;
      ids.push(Number(t.id));
    } else {
      const pieces = [];
      if (p.module === 'consumables') {
        const { batches } = await batchBalances(sql, p.id);
        let left = qty;
        for (const b of batches) {
          if (left <= 0) break;
          const take = roundQty(Math.min(left, Math.max(0, b.qty)));
          if (take > 0) { pieces.push({ batch: b.n, qty: take }); left = roundQty(left - take); }
        }
        if (left > 0) {
          const last = pieces[pieces.length - 1];
          if (last) last.qty = roundQty(last.qty + left); else pieces.push({ batch: 1, qty: left });
        }
      } else pieces.push({ batch: null, qty });
      // Every batch piece in ONE transaction: all saved, or none.
      const results = await sql.transaction(pieces.map(pc => sql`
          WITH upd AS (UPDATE store_parts SET qty = ROUND((qty - ${pc.qty})::numeric, 3)::double precision WHERE id = ${p.id} RETURNING id)
          INSERT INTO store_tx (type, part_id, qty, date, ref, notes, issued_to, purpose, challan_no, batch, created_by, created_at)
          SELECT 'out', upd.id, ${pc.qty}, ${date}::date, '', ${o.notes || ''}, ${o.issuedTo || ''}, ${o.purpose || ''}, '', ${pc.batch}::integer, ${o.by || ''}, now() FROM upd
          RETURNING id`));
      for (const r of results) for (const t of r) ids.push(Number(t.id));
    }
    return ids;
  }
  // Undo them (a station entry deleted): the entries go and the quantity moves back, in one statement.
  async function plateUnmove(sql, ids) {
    const list = (ids || []).map(Number).filter(n => n > 0);
    if (!list.length) return;
    await ensureStore();
    await sql`
      WITH del AS (DELETE FROM store_tx WHERE id = ANY(${list}) RETURNING part_id, type, qty),
           agg AS (SELECT part_id, SUM(CASE WHEN type = 'in' THEN -qty ELSE qty END) AS d FROM del GROUP BY part_id)
      UPDATE store_parts p SET qty = ROUND((p.qty + agg.d)::numeric, 3)::double precision FROM agg WHERE p.id = agg.part_id`;
  }

  return { ensureStore, modulesFor, erpSql, plateMove, plateUnmove };
};
