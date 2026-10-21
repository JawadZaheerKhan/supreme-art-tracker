// Project Animation (owner, 2026-10-21) - the Clients tab's "Animation"
// sub-tab. A real 3D view of the shop: a Production building with one bay
// per stage, a Ready Stock building, and three trucks. Nothing here is GPS -
// a pallet moves only when a stage is marked done in the app, and a truck
// leaves only when a delivery is recorded. It reads the same client-filtered
// jobs the Jobs sub-tab lists, so a client never sees anyone else's work.
//
// Three.js is fetched from jsdelivr on first use (the same way the Excel
// export loads xlsx), so the rest of the app never pays for it.
(function () {
  'use strict';
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
  let threePromise = null;
  const loadThree = () => threePromise || (threePromise = import(THREE_URL).catch(e => { threePromise = null; throw e; }));

  // ── Pure helpers (no Three.js; covered by the offline tests) ──────
  const STAGES = ['CTP Plate Making', 'Printing', 'Coatings', 'Die Cutting', 'Sorting', 'Pasting', 'Ready to Deliver', 'Delivered'];
  const BAY_NAMES = ['CTP', 'Printing', 'Coatings', 'Die Cutting', 'Sorting', 'Pasting'];

  function num(v) {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  function stageIndex(j) { return Math.max(0, Math.min(7, parseInt(j && j.stage_index, 10) || 0)); }
  // Where a job stands in the scene: 'wait' (new / waiting for paper),
  // a Production bay 0-5, 'ready' (Ready Stock building) or 'delivered'.
  function jobPlace(j) {
    const si = stageIndex(j);
    if (si >= 7) return 'delivered';
    if (si === 6) return 'ready';
    const st = String((j && j.issuance_status) || 'issued');
    if (st === 'ctp') return 0;
    if (st === 'new' || st === 'pending') return 'wait';
    return si;
  }
  function isBlocked(j) {
    const s = j && j.stages && j.stages[String(stageIndex(j))];
    return !!(s && s.status === 'blocked');
  }
  function blockNote(j) {
    const s = j && j.stages && j.stages[String(stageIndex(j))];
    return (s && s.status === 'blocked' && s.notes) ? String(s.notes) : '';
  }
  function shipments(j) {
    return (Array.isArray(j && j.deliveries) ? j.deliveries : []).filter(d => d && (num(d.cartons) > 0 || d.date));
  }
  function shippedCartons(j) { return shipments(j).reduce((a, d) => a + num(d.cartons), 0); }
  function clip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function jobTitle(j) { return j.ref ? 'PO ' + clip(j.ref, 12) : clip(j.name || ('Job ' + j.id), 14); }
  function jobSub(j) { return j.ref ? clip(j.name, 20) : clip(j.jobcode || '', 20); }
  // Local yyyy-mm-dd of a delivery date ('2026-10-21') or a stage time
  // ('21/10/2026 14:05'); '' when it can't be read.
  function dayOf(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return '';
  }
  function localDay(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // What changed between two snapshots of the same company's jobs. A truck
  // leaves for every new shipment row, and for a job that reached Delivered
  // without one (finalised). Pallets move when the place changes.
  function diffJobs(prev, next) {
    const before = new Map((prev || []).map(j => [j.id, j]));
    const moves = [], departures = [], added = [], removed = [];
    for (const j of next || []) {
      const o = before.get(j.id);
      before.delete(j.id);
      if (!o) { added.push(j); continue; }
      const was = jobPlace(o), now = jobPlace(j);
      const newShips = shipments(j).slice(shipments(o).length);
      for (const d of newShips) departures.push({ job: j, cartons: num(d.cartons), from: was });
      if (!newShips.length && was !== 'delivered' && now === 'delivered') departures.push({ job: j, cartons: 0, from: was });
      if (was !== now && now !== 'delivered') moves.push({ job: j, from: was, to: now });
      else if (now === 'delivered' && was !== 'delivered') moves.push({ job: j, from: was, to: now });
    }
    for (const o of before.values()) removed.push(o);
    return { moves, departures, added, removed };
  }
  // Deliveries recorded today, newest first - replayed once when the view
  // opens so a client who looks in the evening still sees today's truck go.
  function todaysShipments(jobs, today) {
    today = today || localDay();
    const out = [];
    for (const j of jobs || []) {
      const ships = shipments(j);
      ships.forEach((d, k) => { if (dayOf(d.date) === today) out.push({ job: j, cartons: num(d.cartons), order: k }); });
      if (!ships.length && jobPlace(j) === 'delivered') {
        const s7 = j.stages && j.stages['7'];
        if (s7 && dayOf(s7.time || s7.at) === today) out.push({ job: j, cartons: 0, order: 0 });
      }
    }
    return out.reverse();
  }

  // ── Layout (world units ~ metres; +x right, +z toward the camera) ──
  const PROD = { x0: -46, x1: -2, z0: -14, z1: 10 };
  const READY = { x0: 8, x1: 36, z0: -14, z1: 8 };
  const BAY_W = (PROD.x1 - PROD.x0 - 1) / 6;
  const bayCenter = i => PROD.x0 + 0.5 + BAY_W * (i + 0.5);
  const DOCKS = [14, 22, 30];
  const DOCK_Z = READY.z1 + 4.85;          // truck centre when backed onto the dock
  const GATE = { x0: 39, x1: 48, z: 34 };
  const ROAD_Z = 42;
  const WAIT = { x0: -44, x1: -26, z0: 13, z1: 21 };

  function slotFor(place, k) {
    if (place === 'ready') {
      const col = k % 6, row = Math.floor(k / 6) % 4, layer = Math.floor(k / 24);
      return { x: READY.x0 + 3.6 + col * 3.9, z: READY.z0 + 7.5 + row * 3.4, lift: layer };
    }
    if (place === 'wait') {
      const col = k % 5, row = Math.floor(k / 5) % 2, layer = Math.floor(k / 10);
      return { x: WAIT.x0 + 2.2 + col * 3.4, z: WAIT.z0 + 2.2 + row * 3.6, lift: layer };
    }
    const c = bayCenter(place);
    const col = k % 2, row = Math.floor(k / 2) % 5, layer = Math.floor(k / 10);
    return { x: c + (col ? 1.65 : -1.65), z: -5.2 + row * 2.75, lift: layer };
  }

  // ── Styles for the overlay (scoped to .saa-*) ──────────────────────
  const CSS = `
  .saa-host { position: relative; width: 100%; height: clamp(460px, calc(100vh - 230px), 900px); border-radius: 14px; overflow: hidden; background: linear-gradient(#f5f8fc, #e6edf5); border: 1px solid var(--border, #e2e8f0); user-select: none; -webkit-user-select: none; }
  .saa-host canvas { display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
  .saa-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: var(--text2, #64748b); font-size: 14px; }
  .saa-top { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; pointer-events: none; }
  .saa-stats { display: flex; gap: 8px; flex-wrap: wrap; }
  .saa-card { background: rgba(255,255,255,.92); border: 1px solid #e2e8f0; border-radius: 10px; padding: 6px 10px; min-width: 86px; box-shadow: 0 2px 8px rgba(15,23,42,.06); }
  .saa-card b { display: block; font-size: 18px; line-height: 1.1; color: #0f172a; }
  .saa-card span { font-size: 11px; color: #64748b; white-space: nowrap; }
  .saa-card.red b { color: #dc2626; }
  .saa-card.blue b { color: #1e40af; }
  .saa-card.green b { color: #166534; }
  .saa-views { display: flex; gap: 6px; flex-shrink: 0; pointer-events: auto; }
  .saa-views button { font: 600 12px/1 inherit; font-family: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid #cbd5e1; background: rgba(255,255,255,.92); color: #1e293b; cursor: pointer; }
  .saa-views button.on { background: #1e40af; border-color: #1e40af; color: #fff; }
  .saa-bar { position: absolute; left: 12px; right: 12px; bottom: 12px; background: rgba(255,255,255,.95); border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px 14px; box-shadow: 0 4px 14px rgba(15,23,42,.08); font-size: 12px; color: #334155; }
  .saa-bar .saa-hint { color: #64748b; }
  .saa-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .saa-head b { font-size: 14px; color: #0f172a; }
  .saa-head .saa-x { margin-left: auto; border: 0; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #64748b; padding: 0 2px; }
  .saa-facts { display: flex; gap: 4px 14px; flex-wrap: wrap; color: #475569; }
  .saa-facts i { font-style: normal; color: #94a3b8; }
  .saa-track { display: grid; grid-template-columns: repeat(8, 1fr); margin-top: 10px; position: relative; }
  .saa-track::before { content: ''; position: absolute; left: 6.25%; right: 6.25%; top: 6px; height: 2px; background: #e2e8f0; }
  .saa-step { position: relative; text-align: center; font-size: 10px; color: #94a3b8; line-height: 1.25; padding: 0 2px; }
  .saa-step::before { content: ''; display: block; width: 10px; height: 10px; border-radius: 50%; margin: 1px auto 5px; background: #fff; border: 2px solid #cbd5e1; position: relative; }
  .saa-step.done { color: #1e40af; }
  .saa-step.done::before { background: #2563eb; border-color: #2563eb; }
  .saa-step.now { color: #0f172a; font-weight: 700; }
  .saa-step.now::before { border-color: #2563eb; box-shadow: 0 0 0 4px rgba(37,99,235,.18); animation: saa-pulse 1.6s ease-in-out infinite; }
  .saa-step.blocked { color: #dc2626; font-weight: 700; }
  .saa-step.blocked::before { border-color: #dc2626; background: #fee2e2; }
  .saa-step small { display: block; color: #94a3b8; font-weight: 400; }
  .saa-note { margin-top: 8px; color: #b91c1c; background: #fef2f2; border-radius: 8px; padding: 6px 8px; }
  @keyframes saa-pulse { 50% { box-shadow: 0 0 0 7px rgba(37,99,235,.06); } }
  @media (max-width: 640px) {
    .saa-host { height: clamp(420px, calc(100vh - 200px), 760px); border-radius: 10px; }
    .saa-top { top: 8px; left: 8px; right: 8px; flex-direction: column; gap: 6px; }
    .saa-stats { gap: 5px; flex-wrap: nowrap; width: 100%; }
    .saa-card { flex: 1 1 0; min-width: 0; padding: 4px 6px; border-radius: 8px; }
    .saa-card b { font-size: 14px; } .saa-card span { font-size: 9.5px; white-space: normal; display: block; line-height: 1.15; }
    .saa-views button { padding: 6px 9px; font-size: 11px; }
    .saa-bar { left: 8px; right: 8px; bottom: 8px; padding: 8px 10px; }
    .saa-step { font-size: 8.5px; }
  }
  @media (prefers-reduced-motion: reduce) { .saa-step.now::before { animation: none; } }
  `;
  function ensureCss() {
    if (document.getElementById('saa-css')) return;
    const st = document.createElement('style');
    st.id = 'saa-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── The scene ──────────────────────────────────────────────────────
  function createScene(THREE, host, opts) {
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const small = Math.min(host.clientWidth, window.innerWidth) < 700;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.75 : 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef3f8);
    scene.fog = new THREE.Fog(0xeef3f8, 190, 360);
    const camera = new THREE.PerspectiveCamera(32, 1, 1, 800);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xc7d2e0, 2.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.position.set(-40, 80, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 70, bottom: -70, near: 10, far: 220 });
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(sun);

    // Materials and mesh helpers.
    const mats = new Map();
    const mat = (color, extra) => {
      const key = color + (extra ? JSON.stringify(extra) : '');
      if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.82, metalness: 0.04 }, extra || {})));
      return mats.get(key);
    };
    const geos = new Set();
    const box = (w, h, d, color, x, y, z, parent, shadow) => {
      const g = new THREE.BoxGeometry(w, h, d); geos.add(g);
      const m = new THREE.Mesh(g, typeof color === 'number' ? mat(color) : color);
      m.position.set(x || 0, y || 0, z || 0);
      m.castShadow = shadow !== false; m.receiveShadow = true;
      if (parent) parent.add(m);
      return m;
    };
    const cyl = (rt, rb, h, color, x, y, z, parent, seg) => {
      const g = new THREE.CylinderGeometry(rt, rb, h, seg || 14); geos.add(g);
      const m = new THREE.Mesh(g, mat(color));
      m.position.set(x || 0, y || 0, z || 0);
      m.castShadow = true; m.receiveShadow = true;
      if (parent) parent.add(m);
      return m;
    };
    const textures = [];
    const canvasTex = (w, h, draw) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
      textures.push(t);
      return t;
    };
    const rrect = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
    // Text painted flat on the floor / on a wall.
    const decal = (text, w, h, color, opts2) => {
      const o = opts2 || {};
      const tex = canvasTex(1024, Math.round(1024 * h / w), (g, cw, ch) => {
        g.fillStyle = color;
        g.font = `${o.weight || 800} ${Math.round(ch * (o.size || 0.62))}px ${FONT}`;
        g.textAlign = o.align || 'center'; g.textBaseline = 'middle';
        if (o.spacing && 'letterSpacing' in g) g.letterSpacing = o.spacing + 'px';
        g.fillText(text, o.align === 'left' ? 8 : cw / 2, ch / 2 + 2);
      });
      const pg = new THREE.PlaneGeometry(w, h); geos.add(pg);
      const m = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      return m;
    };
    const floorDecal = (text, w, h, color, x, z, opts2) => {
      const m = decal(text, w, h, color, opts2);
      m.rotation.x = -Math.PI / 2; m.position.set(x, 0.33, z); m.renderOrder = 1;
      scene.add(m);
      return m;
    };
    // Rounded tag that always faces the camera.
    const tag = (title, sub, tone, base) => {
      const bg = tone === 'red' ? '#dc2626' : tone === 'blue' ? '#1e40af' : tone === 'amber' ? '#b45309' : '#ffffff';
      const fg = tone ? '#ffffff' : '#0f172a';
      const fg2 = tone ? 'rgba(255,255,255,.85)' : '#64748b';
      const tex = canvasTex(512, sub ? 176 : 120, (g, w, h) => {
        g.shadowColor = 'rgba(15,23,42,.25)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
        g.fillStyle = bg; rrect(g, 10, 8, w - 20, h - 22, 26); g.fill();
        g.shadowColor = 'transparent';
        if (!tone) { g.strokeStyle = '#cbd5e1'; g.lineWidth = 3; rrect(g, 10, 8, w - 20, h - 22, 26); g.stroke(); }
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = fg; g.font = `800 54px ${FONT}`;
        g.fillText(title, w / 2, sub ? 54 : (h - 14) / 2 + 4, w - 50);
        if (sub) { g.fillStyle = fg2; g.font = `600 38px ${FONT}`; g.fillText(sub, w / 2, 118, w - 50); }
      });
      const sm = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
      const s = new THREE.Sprite(sm);
      s.renderOrder = 10;
      s.userData.aspect = (sub ? 176 : 120) / 512;
      s.userData.base = base || 3.4;
      scaleTag(s);
      return s;
    };
    // Tags grow as the camera pulls back, so they stay readable from the
    // overview without swamping a close-up.
    const scaleTag = s => {
      const w = s.userData.base * Math.max(1, Math.min(2.4, cam.dist / 42));
      if (s.userData.w !== w) { s.userData.w = w; s.scale.set(w, w * s.userData.aspect, 1); }
    };
    const disposeSprite = s => { if (!s) return; if (s.material.map) { s.material.map.dispose(); const i = textures.indexOf(s.material.map); if (i >= 0) textures.splice(i, 1); } s.material.dispose(); s.parent && s.parent.remove(s); };

    // ── Ground, yard, road, fence, trees ──
    const groundGeo = new THREE.PlaneGeometry(900, 900); geos.add(groundGeo);
    const ground = new THREE.Mesh(groundGeo, mat(0xe9eef4));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const yard = box(104, 0.12, 60, 0xf8fafc, -5, 0.06, 4, scene, false); yard.castShadow = false;
    box(320, 0.14, 11, 0xb6c2d1, 40, 0.07, ROAD_Z, scene, false);
    for (let x = -110; x <= 190; x += 7) box(3.2, 0.02, 0.28, 0xffffff, x, 0.15, ROAD_Z, scene, false);
    box(320, 0.18, 1.4, 0xdfe5ec, 40, 0.09, ROAD_Z - 6.2, scene, false);
    box(GATE.x1 - GATE.x0, 0.13, 8, 0xc4ced9, (GATE.x0 + GATE.x1) / 2, 0.08, GATE.z + 2.5, scene, false);
    // Painted lanes from the docks to the gate.
    for (const dx of DOCKS) {
      box(0.18, 0.02, 9, 0x93c5fd, dx - 1.9, 0.14, DOCK_Z + 1, scene, false);
      box(0.18, 0.02, 9, 0x93c5fd, dx + 1.9, 0.14, DOCK_Z + 1, scene, false);
    }
    // Fence with a gate gap.
    const fence = new THREE.Group(); scene.add(fence);
    const fenceRun = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 3));
      for (let i = 0; i <= n; i++) cyl(0.09, 0.09, 1.6, 0x94a3b8, x0 + (x1 - x0) * i / n, 0.8, z0 + (z1 - z0) * i / n, fence, 6);
      const rail = box(len, 0.08, 0.08, 0x94a3b8, (x0 + x1) / 2, 1.45, (z0 + z1) / 2, fence, false);
      rail.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      const rail2 = rail.clone(); rail2.position.y = 0.75; fence.add(rail2);
    };
    fenceRun(-56, GATE.z, GATE.x0, GATE.z); fenceRun(GATE.x1, GATE.z, 46 + 4, GATE.z);
    fenceRun(-56, -24, 50, -24); fenceRun(-56, -24, -56, GATE.z); fenceRun(50, -24, 50, GATE.z);
    // Gate: a booth and a boom that lifts for trucks.
    box(2.2, 2.6, 2.2, 0xffffff, GATE.x1 + 1.6, 1.3, GATE.z - 1.6, scene);
    box(2.6, 0.25, 2.6, 0x1e40af, GATE.x1 + 1.6, 2.72, GATE.z - 1.6, scene);
    box(0.06, 0.8, 1.6, 0x60a5fa, GATE.x1 + 0.48, 1.7, GATE.z - 1.6, scene, false);
    const boomPivot = new THREE.Group(); boomPivot.position.set(GATE.x1 - 0.3, 1.25, GATE.z); scene.add(boomPivot);
    box(0.5, 1.2, 0.5, 0x334155, GATE.x1 - 0.3, 0.6, GATE.z, scene);
    const boom = new THREE.Group(); boomPivot.add(boom);
    for (let i = 0; i < 9; i++) box(0.95, 0.16, 0.16, i % 2 ? 0xffffff : 0xdc2626, -0.5 - i * 0.95, 0.05, 0, boom, false);
    let boomAngle = 0;
    // Trees.
    const trees = new THREE.Group(); scene.add(trees);
    const tree = (x, z, s) => {
      cyl(0.18 * s, 0.24 * s, 1.6 * s, 0x9a7b5c, x, 0.8 * s, z, trees, 6);
      const g1 = new THREE.IcosahedronGeometry(1.25 * s, 0); geos.add(g1);
      const f = new THREE.Mesh(g1, mat(0x86d39b, { flatShading: true })); f.position.set(x, 2.3 * s, z); f.castShadow = true; trees.add(f);
      const g2 = new THREE.IcosahedronGeometry(0.85 * s, 0); geos.add(g2);
      const f2 = new THREE.Mesh(g2, mat(0x5fbf7f, { flatShading: true })); f2.position.set(x + 0.2 * s, 3.25 * s, z - 0.1 * s); f2.castShadow = true; trees.add(f2);
    };
    [[-62, -10], [-62, 6], [-62, 22], [-30, -30], [-12, -30], [6, -30], [24, -30], [44, -30], [57, -12], [57, 6], [57, 22],
     [-50, 29], [-38, 29], [-22, 29], [-6, 29], [8, 29], [24, 29], [-70, 48], [-48, 49], [-20, 48], [10, 49], [34, 48], [62, 49], [86, 48]]
      .forEach(([x, z], i) => tree(x, z, 0.9 + ((i * 37) % 10) / 22));

    // ── Buildings (cut-away: tall back wall, low front so you see in) ──
    const building = (b, name, opts2) => {
      const g = new THREE.Group(); scene.add(g);
      const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const fl = box(w, 0.3, d, 0xf1f5f9, cx, 0.15, cz, g); fl.castShadow = false;
      box(w, 7, 0.5, 0x3b82f6, cx, 3.8, b.z0, g);
      box(w + 0.3, 0.45, 0.8, 0x1e40af, cx, 7.5, b.z0, g);
      for (let x = b.x0 + 2.5; x < b.x1 - 1; x += 2.5) box(0.12, 6.4, 0.06, 0x2f6fe0, x, 3.7, b.z0 + 0.28, g, false);
      box(0.5, 7, d, 0x3b82f6, b.x0, 3.8, cz, g);
      box(0.8, 0.45, d + 0.3, 0x1e40af, b.x0, 7.5, cz, g);
      box(0.5, 1.3, d, 0x60a5fa, b.x1, 0.95, cz, g);
      // Roof beams, so it reads as a building rather than a yard.
      for (let x = b.x0 + 5; x < b.x1 - 2; x += 7.5) box(0.35, 0.35, d * 0.55, 0x1e3a8a, x, 7.4, b.z0 + d * 0.27, g);
      // Front: low wall, with gaps for the docks when asked.
      const gaps = (opts2 && opts2.gaps) || [];
      let x = b.x0;
      const cuts = gaps.map(gx => [gx - 2.1, gx + 2.1]).concat([[b.x1, b.x1]]);
      for (const [a, c] of cuts) { if (a - x > 0.2) box(a - x, 1.3, 0.5, 0x60a5fa, (x + a) / 2, 0.95, b.z1, g); x = c; }
      const sign = decal(name, Math.min(w * 0.6, 22), 2.6, '#ffffff', { size: 0.66, spacing: 6 });
      sign.position.set(cx, 5.2, b.z0 + 0.3); g.add(sign);
      return g;
    };
    building(PROD, 'PRODUCTION');
    building(READY, 'READY STOCK', { gaps: DOCKS });

    // Bays: floor lines, names, a machine and an operator in each.
    const people = [];
    const person = (x, z, face, parent) => {
      const g = new THREE.Group(); g.position.set(x, 0.3, z); g.rotation.y = face || 0;
      cyl(0.32, 0.36, 1.1, 0x1e40af, 0, 0.85, 0, g, 10);
      const hg = new THREE.SphereGeometry(0.3, 12, 10); geos.add(hg);
      const head = new THREE.Mesh(hg, mat(0xe8b98f)); head.position.y = 1.65; head.castShadow = true; g.add(head);
      box(0.66, 0.16, 0.62, 0xfacc15, 0, 1.92, 0, g);
      (parent || scene).add(g); people.push(g);
      return g;
    };
    const machine = (i, cx) => {
      const g = new THREE.Group(); g.position.set(cx, 0.3, -10.4); scene.add(g);
      if (i === 0) {           // CTP plate setter
        box(3.4, 1.5, 2.2, 0xe2e8f0, 0, 0.75, 0, g); box(3.0, 0.2, 1.6, 0x2563eb, 0, 1.6, 0, g);
        box(1.4, 0.5, 1.2, 0xcbd5e1, 2.6, 0.25, 0.4, g); box(1.2, 0.08, 1.0, 0x94a3b8, 2.6, 0.55, 0.4, g);
      } else if (i === 1) {    // printing press: five units in a row
        for (let u = 0; u < 5; u++) { box(1.05, 2.1, 2.3, u % 2 ? 0x1d4ed8 : 0x2563eb, -2.4 + u * 1.15, 1.05, 0, g); cyl(0.22, 0.22, 2.0, 0x334155, -2.4 + u * 1.15, 2.2, 0, g).rotation.x = Math.PI / 2; }
        box(1.2, 0.9, 2.0, 0xe2e8f0, 3.3, 0.45, 0, g);
      } else if (i === 2) {    // coater with the UV lamp
        box(5.4, 1.4, 2.0, 0xe2e8f0, 0, 0.7, 0, g); box(1.4, 0.7, 2.2, 0x0e7490, -0.6, 1.75, 0, g);
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 1.8), new THREE.MeshBasicMaterial({ color: 0xa78bfa })); geos.add(lamp.geometry); lamp.position.set(-0.6, 1.4, 0); g.add(lamp);
      } else if (i === 3) {    // die cutter with its flywheel
        box(3.6, 2.2, 2.4, 0x334155, 0, 1.1, 0, g); box(3.8, 0.3, 2.6, 0x1e40af, 0, 2.35, 0, g);
        const fw = cyl(1.0, 1.0, 0.3, 0x64748b, 2.05, 1.3, 0, g, 18); fw.rotation.z = Math.PI / 2; g.userData.flywheel = fw;
      } else if (i === 4) {    // sorting tables
        for (const tx of [-1.7, 1.7]) { box(2.8, 0.12, 1.6, 0xe7d3b0, tx, 1.0, 0, g); for (const lx of [-1.2, 1.2]) for (const lz of [-0.6, 0.6]) box(0.1, 1.0, 0.1, 0x94a3b8, tx + lx, 0.5, lz, g, false); box(0.8, 0.1, 0.6, 0xffffff, tx, 1.11, 0, g, false); }
      } else {                 // folder-gluer conveyor
        box(6.0, 0.9, 1.4, 0xe2e8f0, 0, 0.45, 0, g); for (let r = 0; r < 9; r++) { const rl = cyl(0.12, 0.12, 1.3, 0x94a3b8, -2.7 + r * 0.68, 0.98, 0, g, 8); rl.rotation.x = Math.PI / 2; }
        box(1.3, 1.4, 1.6, 0x2563eb, -3.2, 0.7, 0, g);
      }
      return g;
    };
    const machines = [];
    for (let i = 0; i < 6; i++) {
      const cx = bayCenter(i);
      machines.push(machine(i, cx));
      person(cx + (i === 1 ? 0 : -1.2), -8.0, Math.PI, null);
      if (i > 0) box(0.12, 0.02, PROD.z1 - PROD.z0 - 1, 0x93c5fd, PROD.x0 + 0.5 + BAY_W * i, 0.31, (PROD.z0 + PROD.z1) / 2, scene, false);
      floorDecal(`${i + 1}  ${BAY_NAMES[i].toUpperCase()}`, BAY_W - 0.6, 1.25, '#1e40af', cx, PROD.z1 - 1.2, { size: 0.58 });
    }
    // Ready Stock: racks along the back wall, filled with cartons.
    for (let r = 0; r < 3; r++) {
      const rx = READY.x0 + 5 + r * 9;
      for (const ux of [-3.8, 3.8]) for (const uz of [-0.7, 0.7]) box(0.16, 5.2, 0.16, 0x1e40af, rx + ux, 2.9, READY.z0 + 1.8 + uz, scene);
      for (let lv = 0; lv < 3; lv++) {
        box(7.8, 0.14, 0.14, 0xf97316, rx, 0.9 + lv * 1.75, READY.z0 + 1.1, scene, false);
        box(7.8, 0.14, 0.14, 0xf97316, rx, 0.9 + lv * 1.75, READY.z0 + 2.5, scene, false);
        for (let bx = 0; bx < 4; bx++) if ((r + lv + bx) % 5 !== 0) box(1.5, 1.0, 1.2, (r + bx) % 2 ? 0xc9a26b : 0xb88f5a, rx - 2.85 + bx * 1.9, 1.5 + lv * 1.75, READY.z0 + 1.8, scene);
      }
    }
    floorDecal('CARTONS READY TO SHIP', 13, 1.2, '#166534', (READY.x0 + READY.x1) / 2, READY.z1 - 1.0, { size: 0.55 });
    for (const dx of DOCKS) {
      box(3.8, 0.12, 1.2, 0xfacc15, dx, 0.33, READY.z1 - 0.9, scene, false);
      for (const s of [-1.3, 1.3]) box(0.4, 0.8, 0.35, 0x111827, dx + s, 0.7, READY.z1 + 0.35, scene);
    }
    // Waiting area in front of Production (new orders / waiting for paper).
    {
      const wx = (WAIT.x0 + WAIT.x1) / 2, wz = (WAIT.z0 + WAIT.z1) / 2, ww = WAIT.x1 - WAIT.x0, wd = WAIT.z1 - WAIT.z0;
      for (const [w, d, x, z] of [[ww, 0.25, wx, WAIT.z0], [ww, 0.25, wx, WAIT.z1], [0.25, wd, WAIT.x0, wz], [0.25, wd, WAIT.x1, wz]]) box(w, 0.03, d, 0xf59e0b, x, 0.15, z, scene, false);
      floorDecal('WAITING TO START', 10, 1.1, '#b45309', wx, WAIT.z1 + 1.3, { size: 0.6 });
    }

    // ── Forklifts ──
    const forklift = () => {
      const g = new THREE.Group();
      box(1.3, 0.75, 2.0, 0xfacc15, 0, 0.62, -0.2, g);
      box(1.2, 0.5, 0.6, 0x1f2937, 0, 0.8, -1.05, g);
      for (const x of [-0.55, 0.55]) box(0.08, 1.5, 0.08, 0x1f2937, x, 1.55, -0.1, g, false);
      box(1.2, 0.08, 1.4, 0x1f2937, 0, 2.3, -0.4, g, false);
      const mast = new THREE.Group(); mast.position.set(0, 0, 0.95); g.add(mast);
      for (const x of [-0.45, 0.45]) box(0.1, 2.2, 0.1, 0x334155, x, 1.2, 0, mast, false);
      const forks = new THREE.Group(); mast.add(forks);
      for (const x of [-0.32, 0.32]) box(0.14, 0.06, 1.2, 0x475569, x, 0.25, 0.6, forks, false);
      for (const [x, z] of [[-0.62, 0.5], [0.62, 0.5], [-0.62, -0.8], [0.62, -0.8]]) { const w = cyl(0.3, 0.3, 0.22, 0x111827, x, 0.3, z, g, 10); w.rotation.z = Math.PI / 2; }
      person(0, -0.45, 0, g).scale.setScalar(0.75);
      g.userData.forks = forks;
      g.traverse(o => { if (o.isMesh) o.castShadow = true; });
      scene.add(g);
      return g;
    };
    // A forklift that potters about inside an area between jobs.
    const wanderers = [];
    const wander = (area, start) => {
      const f = forklift();
      f.position.set(start[0], 0.3, start[1]);
      wanderers.push({ f, area, target: null, wait: Math.random() * 2, busy: false });
      return wanderers[wanderers.length - 1];
    };
    wander({ x0: PROD.x0 + 3, x1: PROD.x0 + 22, z0: -6.5, z1: 6.5 }, [PROD.x0 + 10, 7.5]);
    wander({ x0: PROD.x0 + 24, x1: PROD.x1 - 3, z0: -6.5, z1: 6.5 }, [PROD.x1 - 8, 7.5]);
    const loader = wander({ x0: READY.x0 + 3, x1: READY.x1 - 3, z0: -8, z1: 5 }, [READY.x0 + 14, 5]);

    // ── Trucks ──
    const trucks = [];
    const truckLogo = canvasTex(1024, 256, (g, w, h) => {
      g.fillStyle = '#1e40af'; g.font = `900 120px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('SUPREME ART', w / 2, h * 0.42);
      g.fillStyle = '#64748b'; g.font = `700 54px ${FONT}`; g.fillText('PACKAGING PRESS', w / 2, h * 0.82);
    });
    const makeTruck = () => {
      const g = new THREE.Group();   // forward is local +z
      box(2.0, 0.5, 9.6, 0x1f2937, 0, 0.75, -0.2, g);
      box(2.6, 2.9, 7.0, 0xffffff, 0, 2.45, -1.3, g);
      for (const s of [-1, 1]) {
        box(0.03, 0.32, 7.0, 0x2563eb, s * 1.315, 1.25, -1.3, g, false);
        const lg = new THREE.PlaneGeometry(5.6, 1.4); geos.add(lg);
        const logo = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ map: truckLogo, transparent: true }));
        logo.position.set(s * 1.32, 2.7, -1.3); logo.rotation.y = s * Math.PI / 2; g.add(logo);
      }
      box(2.5, 2.3, 2.1, 0xffffff, 0, 1.95, 3.45, g);
      box(2.5, 0.35, 2.1, 0x1e40af, 0, 0.95, 3.45, g);
      box(2.2, 0.95, 0.05, 0x1e3a5f, 0, 2.45, 4.52, g, false);
      for (const s of [-1, 1]) { box(0.05, 0.75, 1.1, 0x1e3a5f, s * 1.26, 2.4, 3.6, g, false); box(0.35, 0.18, 0.06, 0xfde68a, s * 0.95, 1.2, 4.52, g, false); }
      for (const z of [3.4, -2.5, -3.75]) for (const s of [-1, 1]) { const w = cyl(0.55, 0.55, 0.42, 0x111827, s * 1.1, 0.55, z, g, 14); w.rotation.z = Math.PI / 2; }
      scene.add(g);
      return g;
    };
    DOCKS.forEach((dx, k) => {
      const g = makeTruck();
      g.position.set(dx, 0, DOCK_Z);
      trucks.push({ g, k, dx, state: 'docked', path: null, t: 0, badge: null, onDone: null });
    });
    // Smooth curves for a truck's trips (CatmullRom through key points).
    const P = (x, z) => new THREE.Vector3(x, 0, z);
    const curve = pts => new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const gx = (GATE.x0 + GATE.x1) / 2;
    const departCurve = dx => curve([P(dx, DOCK_Z), P(dx, DOCK_Z + 6), P((dx + gx) / 2 + 2, GATE.z - 6), P(gx - 1, GATE.z - 2), P(gx, GATE.z + 2), P(gx + 4, ROAD_Z + 2.3), P(gx + 20, ROAD_Z + 2.4), P(150, ROAD_Z + 2.4)]);
    const returnCurve = dx => curve([P(130, ROAD_Z - 2.4), P(gx + 16, ROAD_Z - 2.4), P(gx + 3, ROAD_Z - 2), P(gx + 1, GATE.z + 1), P(gx - 2, GATE.z - 5), P(dx + 10, DOCK_Z + 13), P(dx - 3, DOCK_Z + 12), P(dx - 7, DOCK_Z + 8), P(dx - 4, DOCK_Z + 6.2), P(dx + 7, DOCK_Z + 7.6)]);
    const reverseCurve = dx => curve([P(dx + 7, DOCK_Z + 7.6), P(dx + 2.5, DOCK_Z + 6.4), P(dx, DOCK_Z + 3), P(dx, DOCK_Z)]);
    const startTrip = (tr, legs, onDone) => { tr.legs = legs; tr.leg = 0; tr.t = 0; tr.v = 0; tr.onDone = onDone; };

    // ── Job pallets ──
    const pallets = new Map();     // job id -> { g, place, job, ... }
    const palletRoot = new THREE.Group(); scene.add(palletRoot);
    // Pallet contents are rebuilt as jobs move; free their geometry each time.
    const dropMeshes = g => {
      g.traverse(o => { if (o.isMesh && o.geometry) { o.geometry.dispose(); geos.delete(o.geometry); } });
      while (g.children.length) g.remove(g.children[0]);
    };
    const JOB_COLORS = [0xef4444, 0x2563eb, 0x16a34a, 0x9333ea, 0xf59e0b, 0x0891b2, 0xdb2777, 0x65a30d];
    const fillPallet = (p) => {
      const g = p.content;
      dropMeshes(g);
      const place = p.place;
      box(2.4, 0.18, 2.0, 0xc08a57, 0, 0.09, 0, g);
      if (place === 'wait') {
        box(2.1, 0.7, 1.7, 0xffffff, 0, 0.53, 0, g); box(2.12, 0.08, 1.72, 0xe2e8f0, 0, 0.6, 0, g, false);
      } else if (place === 'ready' || place === 4 || place === 5) {
        const layers = place === 'ready' ? Math.max(1, Math.min(4, Math.ceil(Math.log10(num(p.job.qty) + 1) - 1))) : 2;
        for (let l = 0; l < layers; l++) for (const x of [-0.55, 0.55]) for (const z of [-0.45, 0.45]) box(1.04, 0.72, 0.86, (l + (x > 0) + (z > 0)) % 2 ? 0xc9a26b : 0xbf9660, x, 0.55 + l * 0.74, z, g);
        if (place === 'ready') box(2.2, 0.08, 1.8, 0x2563eb, 0, 0.55 + layers * 0.74 - 0.36, 0, g, false);
      } else {
        const h = 0.45 + Math.min(1.1, Math.log10(num(p.job.sheets) + 1) * 0.22);
        box(2.1, h, 1.7, 0xffffff, 0, 0.18 + h / 2, 0, g);
        if (place >= 1) box(2.12, 0.05, 1.72, JOB_COLORS[p.job.id % JOB_COLORS.length], 0, 0.18 + h + 0.01, 0, g, false);
      }
      let top = 0;
      g.children.forEach(c => { top = Math.max(top, c.position.y + (c.geometry.parameters.height || 0) / 2); });
      p.top = top;
      g.traverse(o => { if (o.isMesh) o.userData.jobId = p.job.id; });
    };
    const ringGeo = new THREE.RingGeometry(1.75, 2.05, 36); geos.add(ringGeo);
    const setTag = (p) => {
      const j = p.job, blocked = isBlocked(j), urgent = /urgent/i.test(String(j.priority || ''));
      const tone = blocked ? 'red' : (selectedId === j.id ? 'blue' : (urgent ? 'amber' : ''));
      const sub = blocked ? 'Blocked' : (urgent ? 'Urgent' : jobSub(j));
      const key = jobTitle(j) + '|' + sub + '|' + tone;
      if (p.tagKey === key) return;
      disposeSprite(p.tag); disposeSprite(p.tagS);
      // Two tags: the full one for close up, a title-only one for the
      // overview so neighbouring pallets' tags don't pile on each other.
      p.tag = tag(jobTitle(j), sub, tone); p.tagS = tag(jobTitle(j), '', tone, 2.5); p.tagKey = key;
      p.tag.userData.jobId = p.tagS.userData.jobId = j.id;
      p.g.add(p.tag, p.tagS);
      if (p.ring) { p.g.remove(p.ring); p.ring.material.dispose(); p.ring = null; }
      if (blocked || urgent || selectedId === j.id) {
        p.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: blocked ? 0xdc2626 : selectedId === j.id ? 0x2563eb : 0xf59e0b, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
        p.ring.rotation.x = -Math.PI / 2; p.ring.position.y = 0.06; p.g.add(p.ring);
      }
    };
    const placeTag = p => { if (p.tag) p.tag.position.set(0, p.top + 1.25, 0); };
    const makePallet = (j, place, delay) => {
      const g = new THREE.Group(); palletRoot.add(g);
      const content = new THREE.Group(); g.add(content);
      const p = { g, content, job: j, place, tag: null, tagKey: '', ring: null, move: null, pop: reduceMotion ? 1 : -(delay || 0), top: 1 };
      fillPallet(p); setTag(p); placeTag(p);
      g.scale.setScalar(reduceMotion ? 1 : 0.001);
      pallets.set(j.id, p);
      return p;
    };
    const removePallet = p => {
      disposeSprite(p.tag); disposeSprite(p.tagS); if (p.ring) p.ring.material.dispose();
      dropMeshes(p.content);
      palletRoot.remove(p.g); pallets.delete(p.job.id);
    };
    // Every pallet's spot, recomputed after each change (ordered by job id
    // so a pallet keeps its place when others come and go).
    const layout = (instant) => {
      const groups = new Map();
      for (const p of pallets.values()) { if (p.leaving) continue; const k = String(p.place); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
      for (const [k, list] of groups) {
        list.sort((a, b) => a.job.id - b.job.id);
        const place = k === 'ready' || k === 'wait' ? k : +k;
        list.forEach((p, i) => {
          const s = slotFor(place, i);
          p.stag = i % 2;
          const to = new THREE.Vector3(s.x, 0.3 + s.lift * 1.6, s.z);
          if (instant || !p.placed) { p.g.position.copy(to); p.placed = true; p.move = null; return; }
          if (p.g.position.distanceTo(to) < 0.01) return;
          const from = p.g.position.clone(), dist = from.distanceTo(to);
          const arc = (from.x < 4) !== (to.x < 4) || Math.abs(from.z - to.z) > 9 ? 9 : Math.min(1.2, 0.2 + dist * 0.08);
          p.move = { from, to, t: 0, dur: Math.max(0.9, Math.min(4, dist / 9)), arc, refill: p.pendingFill };
        });
      }
    };

    // ── Deliveries: the loader carries the cartons to a truck, it drives off ──
    const queue = [];
    let loaderJob = null;
    const freeTruck = () => trucks.find(t => t.state === 'docked');
    const enqueueDeparture = (job, cartons, fromPos) => { queue.push({ job, cartons, fromPos }); };
    const runQueue = () => {
      if (loaderJob || !queue.length) return;
      const tr = freeTruck();
      if (!tr) return;
      const q = queue.shift();
      tr.state = 'loading';
      const crate = new THREE.Group();
      for (const x of [-0.55, 0.55]) for (const z of [-0.45, 0.45]) box(1.04, 0.72, 0.86, 0xc9a26b, x, 0.5, z, crate);
      box(2.4, 0.16, 2.0, 0xc08a57, 0, 0.08, 0, crate);
      crate.scale.setScalar(0.62);
      loaderJob = { q, tr, crate, phase: 'toStack', from: q.fromPos || new THREE.Vector3(READY.x0 + 10, 0.3, -2) };
      loader.busy = true; loader.target = null;
    };
    const departTruck = (tr, q) => {
      const cart = q.cartons > 0 ? q.cartons.toLocaleString() + ' cartons' : 'Delivered';
      tr.badge = tag(jobTitle(q.job), cart, 'blue');
      tr.badge.position.set(0, 5.4, -1); tr.g.add(tr.badge);
      tr.state = 'out';
      startTrip(tr, [{ c: departCurve(tr.dx), speed: 10 }], () => {
        disposeSprite(tr.badge); tr.badge = null;
        tr.state = 'away'; tr.awayFor = reduceMotion ? 1 : 6;
      });
    };

    // ── Camera: drag to turn, wheel / pinch to zoom, right-drag to pan ──
    const VIEWS = {
      overview: { target: [-4, 0, 6], az: 0.3, el: 0.74, dist: 112 },
      process: { target: [(PROD.x0 + PROD.x1) / 2, 0, -1], az: 0.18, el: 0.78, dist: 68 },
      ready: { target: [24, 0, 4], az: 0.42, el: 0.72, dist: 60 },
    };
    const cam = { target: new THREE.Vector3(-4, 0, 6), az: 0.3, el: 0.74, dist: 112 };
    const want = { target: cam.target.clone(), az: cam.az, el: cam.el, dist: cam.dist };
    // Phones held upright: turn the yard side-on so the row of buildings runs
    // up the screen instead of off both edges.
    const TALL_VIEWS = {
      overview: { target: [-3, 0, 1], az: 1.25, el: 0.98, dist: 200 },
      process: { target: [(PROD.x0 + PROD.x1) / 2, 0, -1], az: 1.15, el: 0.9, dist: 100 },
      ready: { target: [23, 0, 6], az: 1.05, el: 0.86, dist: 82 },
    };
    let viewName = 'overview', baseAz = cam.az, lastInput = -1e9, clock = 0;
    const aspectNow = () => host.clientWidth / Math.max(1, host.clientHeight);
    const fitDist = d => {
      const aspect = aspectNow();
      return aspect < 1.25 && aspect >= 0.9 ? d * 1.25 / aspect : d;
    };
    const setView = (name, instant) => {
      const v = (aspectNow() < 0.9 ? TALL_VIEWS : VIEWS)[name]; viewName = name;
      want.target.set(v.target[0], v.target[1], v.target[2]); want.az = v.az; want.el = v.el; want.dist = fitDist(v.dist); baseAz = v.az;
      if (instant) { cam.target.copy(want.target); cam.az = want.az; cam.el = want.el; cam.dist = want.dist; }
      ui.views.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === name));
    };
    const applyCamera = () => {
      const c = Math.cos(cam.el);
      camera.position.set(cam.target.x + Math.sin(cam.az) * c * cam.dist, cam.target.y + Math.sin(cam.el) * cam.dist, cam.target.z + Math.cos(cam.az) * c * cam.dist);
      camera.lookAt(cam.target);
    };

    // ── Overlay DOM ──
    const ui = {};
    ui.top = document.createElement('div'); ui.top.className = 'saa-top';
    ui.stats = document.createElement('div'); ui.stats.className = 'saa-stats';
    ui.views = document.createElement('div'); ui.views.className = 'saa-views';
    ui.top.append(ui.stats, ui.views);
    ui.views.innerHTML = '<button data-v="overview">Overview</button><button data-v="process">Production</button><button data-v="ready">Ready Stock</button>';
    ui.bar = document.createElement('div'); ui.bar.className = 'saa-bar';
    ui.msg = document.createElement('div'); ui.msg.className = 'saa-msg'; ui.msg.style.display = 'none'; ui.msg.style.pointerEvents = 'none';
    host.append(ui.top, ui.bar, ui.msg);
    ui.views.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; select(null); setView(b.dataset.v); lastInput = clock; });

    let jobs = [], selectedId = null;
    const renderStats = () => {
      const live = jobs.filter(j => jobPlace(j) !== 'delivered');
      const inProc = live.filter(j => jobPlace(j) !== 'ready').length;
      const ready = live.filter(j => jobPlace(j) === 'ready').length;
      const delivered = jobs.filter(j => jobPlace(j) === 'delivered').length;
      const blocked = live.filter(isBlocked).length;
      const out = trucks.filter(t => t.state !== 'docked' && t.state !== 'loading').length;
      ui.stats.innerHTML =
        `<div class="saa-card blue"><b>${inProc}</b><span>In production</span></div>` +
        `<div class="saa-card green"><b>${ready}</b><span>Ready to ship</span></div>` +
        `<div class="saa-card"><b>${delivered}</b><span>Delivered (3 days)</span></div>` +
        (blocked ? `<div class="saa-card red"><b>${blocked}</b><span>On hold</span></div>` : '') +
        `<div class="saa-card"><b>${out ? out + ' on road' : 'All 3'}</b><span>${out ? (3 - out) + ' at the dock' : 'trucks at the dock'}</span></div>`;
    };
    const renderBar = () => {
      const j = selectedId != null ? jobs.find(x => x.id === selectedId) : null;
      if (!j) {
        ui.bar.innerHTML = `<span class="saa-hint">${jobs.some(x => jobPlace(x) !== 'delivered') ? 'Tap a pallet to see where that order is. Drag to turn the view, scroll or pinch to zoom.' : 'Nothing in production or waiting to ship right now. A truck drives out here whenever an order is delivered.'}</span>`;
        return;
      }
      const si = stageIndex(j), blocked = isBlocked(j), place = jobPlace(j);
      const steps = STAGES.map((name, k) => {
        const s = j.stages && j.stages[String(k)];
        const done = (s && s.status === 'done') || k < si || place === 'delivered';
        const cls = k === si && place !== 'delivered' ? (blocked ? 'blocked' : 'now') : done ? 'done' : '';
        const when = s && s.status === 'done' && s.time ? String(s.time).split(' ')[0] : '';
        return `<div class="saa-step ${cls}">${esc(name)}${when ? `<small>${esc(when)}</small>` : ''}</div>`;
      }).join('');
      const shipped = shippedCartons(j);
      const where = place === 'wait' ? 'Waiting to start' : place === 'ready' ? 'In Ready Stock' : place === 'delivered' ? 'Delivered' : 'At ' + BAY_NAMES[place];
      ui.bar.innerHTML =
        `<div class="saa-head"><b>${esc(j.name || 'Job ' + j.id)}</b><span>${esc(where)}</span><button class="saa-x" title="Close" aria-label="Close">&times;</button></div>` +
        `<div class="saa-facts">${j.ref ? `<span><i>PO</i> ${esc(j.ref)}</span>` : ''}${j.bno ? `<span><i>Batch</i> ${esc(j.bno)}</span>` : ''}${j.qty ? `<span><i>Qty</i> ${esc(j.qty)}</span>` : ''}${shipped ? `<span><i>Shipped</i> ${shipped.toLocaleString()} cartons</span>` : ''}${j.deadline ? `<span><i>Due</i> ${esc(j.deadline)}</span>` : ''}</div>` +
        `<div class="saa-track">${steps}</div>` +
        (blocked && blockNote(j) ? `<div class="saa-note">On hold: ${esc(blockNote(j))}</div>` : '');
      ui.bar.querySelector('.saa-x').onclick = () => { select(null); setView(viewName === 'focus' ? 'overview' : viewName); };
    };
    const select = id => {
      const prev = selectedId; selectedId = id;
      for (const k of [prev, id]) { const p = k != null && pallets.get(k); if (p) setTag(p), placeTag(p); }
      if (id != null) {
        const p = pallets.get(id);
        if (p) { want.target.copy(p.g.position).setY(0); want.dist = fitDist(34); want.el = 0.8; viewName = 'focus'; ui.views.querySelectorAll('button').forEach(b => b.classList.remove('on')); }
      }
      renderBar();
    };

    // Pointer input.
    const el = renderer.domElement;
    const pointers = new Map();
    let drag = null, pinch0 = 0;
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const pick = (cx, cy) => {
      const r = el.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(palletRoot.children, true).find(h => h.object.userData.jobId != null || h.object.isSprite);
      if (!hit) return null;
      let o = hit.object;
      while (o && o.userData.jobId == null && o.parent && o.parent !== palletRoot) o = o.parent;
      if (o && o.userData.jobId != null) return o.userData.jobId;
      for (const p of pallets.values()) if (p.g === o || p.tag === hit.object) return p.job.id;
      return null;
    };
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); drag = null; return; }
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), pan: e.button === 2 || e.shiftKey, moved: false };
    });
    el.addEventListener('pointermove', e => {
      const pt = pointers.get(e.pointerId);
      if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch0 > 0) { want.dist = Math.max(16, Math.min(260, want.dist * pinch0 / d)); pinch0 = d; lastInput = clock; }
        return;
      }
      if (!drag) { if (e.pointerType === 'mouse') el.style.cursor = pick(e.clientX, e.clientY) != null ? 'pointer' : 'grab'; return; }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 5) drag.moved = true;
      if (!drag.moved) return;
      lastInput = clock;
      if (drag.pan) {
        // Grab the ground: right = (cos az, -sin az), forward = (-sin az, -cos az).
        const s = want.dist / 700;
        const ca = Math.cos(cam.az), sa = Math.sin(cam.az);
        want.target.x += (-dx * ca - dy * sa) * s;
        want.target.z += (dx * sa - dy * ca) * s;
      } else {
        want.az -= dx * 0.006; baseAz = want.az;
        want.el = Math.max(0.32, Math.min(1.3, want.el + dy * 0.004));
      }
    });
    const endPointer = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch0 = 0;
      if (drag && !drag.moved && performance.now() - drag.t < 600 && e.type === 'pointerup') {
        const id = pick(e.clientX, e.clientY);
        select(id);
        lastInput = clock;
      }
      drag = null;
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    el.addEventListener('wheel', e => { e.preventDefault(); want.dist = Math.max(16, Math.min(260, want.dist * (1 + Math.sign(e.deltaY) * Math.min(0.25, Math.abs(e.deltaY) * 0.0012)))); lastInput = clock; }, { passive: false });

    // ── Frame loop ──
    let raf = 0, active = false, last = 0;
    const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const easeBack = t => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
    const tmp = new THREE.Vector3();
    const driveTo = (f, x, z, dt, speed) => {
      tmp.set(x - f.position.x, 0, z - f.position.z);
      const d = tmp.length();
      if (d < 0.08) return true;
      const want2 = Math.atan2(tmp.x, tmp.z);
      let diff = want2 - f.rotation.y; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      f.rotation.y += diff * Math.min(1, dt * 6);
      const step = Math.min(d, speed * dt * (Math.abs(diff) > 1.2 ? 0.3 : 1));
      f.position.x += tmp.x / d * step; f.position.z += tmp.z / d * step;
      return false;
    };
    const tick = (now) => {
      raf = active ? requestAnimationFrame(tick) : 0;
      if (!host.isConnected || host.offsetParent === null || document.hidden) { last = now; return; }
      const dt = Math.min(0.05, ((now - last) || 16) / 1000); last = now; clock += dt;
      // Camera easing + slow drift when nobody is touching it.
      if (!reduceMotion && selectedId == null && clock - lastInput > 7) want.az = baseAz + Math.sin((clock - lastInput - 7) * 0.07) * 0.2;
      const k = 1 - Math.exp(-dt * 3.2);
      cam.target.lerp(want.target, k); cam.az += (want.az - cam.az) * k; cam.el += (want.el - cam.el) * k; cam.dist += (want.dist - cam.dist) * k;
      applyCamera();
      // Pallets: pop in, glide between spots.
      for (const p of pallets.values()) {
        if (p.pop < 1) { p.pop = Math.min(1, p.pop + dt * 2.2); p.g.scale.setScalar(p.pop <= 0 ? 0.001 : Math.max(0.001, easeBack(p.pop))); }
        if (p.move) {
          const m = p.move; m.t = Math.min(1, m.t + dt / m.dur);
          const e2 = ease(m.t);
          p.g.position.lerpVectors(m.from, m.to, e2); p.g.position.y += Math.sin(Math.PI * m.t) * m.arc;
          if (m.t >= 0.5 && m.refill) { fillPallet(p); placeTag(p); m.refill = false; p.pendingFill = false; }
          if (m.t >= 1) p.move = null;
        }
        if (p.ring) p.ring.material.opacity = 0.55 + Math.sin(clock * 4) * 0.3;
        if (p.tag) {
          const far = cam.dist > 62 && selectedId !== p.job.id;
          const t = far ? p.tagS : p.tag;
          p.tag.visible = !far; p.tagS.visible = far;
          // Side-by-side pallets: every other tag sits a step higher.
          scaleTag(t); t.position.y = p.top + 0.5 + t.scale.y * (0.5 + (far ? (p.stag || 0) * 1.1 : 0));
        }
      }
      // Machines and people.
      for (const m of machines) if (m.userData.flywheel) m.userData.flywheel.rotation.x += dt * 3;
      people.forEach((pp, i) => { if (!pp.parent || pp.parent.type !== 'Scene') return; pp.position.y = 0.3 + Math.abs(Math.sin(clock * 2 + i)) * 0.05; });
      // Forklifts wandering about.
      for (const w of wanderers) {
        if (w.busy) continue;
        if (w.wait > 0) { w.wait -= dt; continue; }
        if (!w.target) w.target = [w.area.x0 + Math.random() * (w.area.x1 - w.area.x0), w.area.z0 + Math.random() * (w.area.z1 - w.area.z0)];
        if (driveTo(w.f, w.target[0], w.target[1], dt, 3.2)) { w.target = null; w.wait = 1 + Math.random() * 2.5; }
        const forks = w.f.userData.forks; forks.position.y = Math.max(0, Math.sin(clock * 0.9 + w.area.x0) * 0.5);
      }
      // Loader: stack -> dock -> back.
      if (loaderJob) {
        const L = loaderJob, f = loader.f;
        if (L.phase === 'toStack') {
          if (driveTo(f, L.from.x, L.from.z + 2.2, dt, 5)) {
            L.phase = 'toDock'; f.add(L.crate); L.crate.position.set(0, 0.35, 1.7);
            if (L.q.onPicked) L.q.onPicked();
          }
        } else if (L.phase === 'toDock') {
          if (driveTo(f, L.tr.dx, READY.z1 - 2.6, dt, 5)) { L.phase = 'drop'; L.t = 0; }
        } else if (L.phase === 'drop') {
          L.t += dt; L.crate.position.z = 1.7 + L.t * 3; L.crate.scale.setScalar(Math.max(0.001, 0.62 * (1 - L.t / 0.8)));
          if (L.t >= 0.8) {
            f.remove(L.crate);
            L.crate.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
            departTruck(L.tr, L.q);
            loaderJob = null; loader.busy = false; loader.wait = 0.5;
            renderStats();
          }
        }
      }
      runQueue();
      // Trucks on their trips.
      for (const tr of trucks) {
        if (tr.state === 'away') {
          tr.g.visible = false; tr.awayFor -= dt;
          if (tr.awayFor <= 0) { tr.g.visible = true; tr.state = 'returning'; startTrip(tr, [{ c: returnCurve(tr.dx), speed: 10 }, { c: reverseCurve(tr.dx), speed: 3, reverse: true }], () => { tr.state = 'docked'; tr.g.position.set(tr.dx, 0, DOCK_Z); tr.g.rotation.y = 0; renderStats(); }); }
          continue;
        }
        if (tr.badge) scaleTag(tr.badge);
        if (!tr.legs) continue;
        const leg = tr.legs[tr.leg];
        const len = leg.len || (leg.len = leg.c.getLength());
        // Pull away gently, then cruise; slow right down for the last metres.
        const left = (1 - tr.t) * len;
        tr.v += (Math.min(leg.speed, 1.2 + left * 0.9) - tr.v) * Math.min(1, dt * 1.4);
        tr.t = Math.min(1, tr.t + dt * Math.max(0.6, tr.v) / len);
        leg.c.getPointAt(tr.t, tr.g.position);
        const tan = leg.c.getTangentAt(tr.t);
        const head = Math.atan2(tan.x, tan.z) + (leg.reverse ? Math.PI : 0);
        let diff = head - tr.g.rotation.y; diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        tr.g.rotation.y += diff * Math.min(1, dt * 8);
        if (tr.t >= 1) {
          tr.leg++; tr.t = 0;
          if (tr.leg >= tr.legs.length) { tr.legs = null; const cb = tr.onDone; tr.onDone = null; cb && cb(); renderStats(); }
        }
      }
      // Boom gate lifts when a truck is close.
      const near = trucks.some(t => t.g.visible && Math.abs(t.g.position.x - gx) < 7 && Math.abs(t.g.position.z - GATE.z) < 7);
      boomAngle += ((near ? 1.35 : 0) - boomAngle) * Math.min(1, dt * 4);
      boomPivot.rotation.z = -boomAngle;
      renderer.render(scene, camera);
    };

    const resize = () => {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      if (viewName !== 'focus') setView(viewName);
    };
    const ro = new ResizeObserver(resize); ro.observe(host);

    // ── Public controller ──
    const applyJobs = (next, first) => {
      next = (next || []).filter(j => j && j.id != null);
      const d = first ? { moves: [], departures: [], added: next, removed: [] } : diffJobs(jobs, next);
      const byId = new Map(next.map(j => [j.id, j]));
      jobs = next;
      // Removed (hidden from the client, or dropped off the portal).
      for (const o of d.removed) { const p = pallets.get(o.id); if (p) removePallet(p); }
      // New jobs pop in, staggered on the first load.
      let n = 0;
      for (const j of d.added) { const place = jobPlace(j); if (place !== 'delivered' && !pallets.has(j.id)) makePallet(j, place, first ? (n++) * 0.06 : 0); }
      // Departures: the pallet (or a share of it) goes on a truck.
      for (const dep of d.departures) {
        const p = pallets.get(dep.job.id);
        const fromPos = p ? p.g.position.clone() : null;
        const full = jobPlace(dep.job) === 'delivered';
        enqueueDeparture(dep.job, dep.cartons, fromPos);
        if (p && full) { const q = queue[queue.length - 1]; p.leaving = true; q.onPicked = () => removePallet(p); }
      }
      // Moves between areas.
      for (const mv of d.moves) {
        const p = pallets.get(mv.job.id);
        if (!p) { if (mv.to !== 'delivered') makePallet(mv.job, mv.to, 0); continue; }
        if (mv.to === 'delivered') { if (!p.leaving) { p.leaving = true; enqueueDeparture(mv.job, 0, p.g.position.clone()); queue[queue.length - 1].onPicked = () => removePallet(p); } continue; }
        p.place = mv.to; p.pendingFill = true;
      }
      for (const p of pallets.values()) { const j = byId.get(p.job.id); if (j) { p.job = j; setTag(p); } }
      layout(first);
      for (const p of pallets.values()) if (p.pendingFill && !p.move) { fillPallet(p); p.pendingFill = false; }
      for (const p of pallets.values()) placeTag(p);
      if (selectedId != null && !byId.has(selectedId)) selectedId = null;
      ui.msg.style.display = next.length ? 'none' : 'flex';
      ui.msg.textContent = 'No orders to show for this company yet.';
      renderStats(); renderBar();
    };
    applyJobs(opts.jobs, true);
    // Replay today's deliveries once, so the trucks' trips are seen.
    if (!reduceMotion) for (const s of todaysShipments(jobs).slice(0, 3)) enqueueDeparture(s.job, s.cartons, null);
    resize(); setView('overview', true);

    return {
      company: opts.company,
      _debug: { cam, want, camera, VIEWS, setView },
      update(nextJobs) { applyJobs(nextJobs, false); },
      setActive(on) {
        on = !!on;
        if (on === active) return;
        active = on;
        if (on) { last = performance.now(); raf = requestAnimationFrame(tick); resize(); }
        else if (raf) { cancelAnimationFrame(raf); raf = 0; }
      },
      destroy() {
        this.setActive(false);
        ro.disconnect();
        geos.forEach(g => g.dispose()); textures.forEach(t => t.dispose()); mats.forEach(m => m.dispose());
        scene.traverse(o => { if (o.isMesh && o.material && !([...mats.values()].includes(o.material))) { o.material.map && o.material.map.dispose(); o.material.dispose(); } });
        renderer.dispose();
        host.innerHTML = '';
      },
    };
  }

  // Mount into `host` (a .saa-host div). Returns a controller at once; the
  // 3D engine finishes loading in the background and picks up the latest
  // jobs passed to update() meanwhile.
  function mount(host, opts) {
    ensureCss();
    host.classList.add('saa-host');
    host.innerHTML = '<div class="saa-msg">Loading the 3D view&hellip;</div>';
    let real = null, pendingJobs = opts.jobs, wantActive = false, dead = false;
    const ctl = {
      company: opts.company,
      update(j) { if (real) real.update(j); else pendingJobs = j; },
      setActive(on) { wantActive = !!on; if (real) real.setActive(on); },
      destroy() { dead = true; if (real) real.destroy(); else host.innerHTML = ''; },
    };
    loadThree().then(THREE => {
      if (dead) return;
      host.innerHTML = '';
      real = createScene(THREE, host, Object.assign({}, opts, { jobs: pendingJobs }));
      ctl._debug = real._debug;
      real.setActive(wantActive);
    }).catch(() => {
      if (dead) return;
      host.innerHTML = '<div class="saa-msg">Couldn’t load the 3D view. Check the internet connection, then press Refresh.</div>';
    });
    return ctl;
  }

  window.SAAnimation = { mount, _test: { jobPlace, diffJobs, todaysShipments, slotFor, dayOf, shippedCartons, isBlocked } };
})();
