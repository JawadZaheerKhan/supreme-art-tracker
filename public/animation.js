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
  // The app's red (index.html --brand, --brand-dark, --brand-light, --brand-deep).
  const BRAND = 0xA32D2D, BRAND_DARK = 0x7C1F1F, BRAND_LIGHT = 0xC04545, BRAND_DEEP = 0x5C1414, BRAND_PALE = 0xe8a3a3;
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
  // The Production building is the owner's real floor plans (2026-10-21):
  // the Basement under the ground (in a pit, seen through the cut-away), the
  // Ground floor at street level - its front part (Production Office, Plate
  // Making, offices) on the street and its back part (rooms, halls, Breaking
  // Area) a few steps up - and the 1st floor above. Floors are stacked with a
  // gap so each can be seen. A floor is one or more parts, each drawn from a
  // plan in that plan's own pixels; all plans are fitted to one footprint.
  const BLD = { x0: -54, z0: -32, w: 45, d: 56 };
  const FLOOR_Y = [-5, 0, 11, 22];              // basement (one storey down, owner), ground (street), 1st floor, roof
  const RAISE = 1.2;                            // the ground floor's back part, a few steps up
  const OPEN_RAISE = 0.8;                       // the 1st floor's open area, a little above the floor
  const FLOOR_NAMES = ['BASEMENT', 'GROUND FLOOR', '1ST FLOOR', 'ROOF'];
  const PLAN_G = { px0: 158, py0: 158, sx: 20, sz: 20 };                             // evacuation plan (upper floors)
  const PLAN_B = { px0: 157, py0: 60, sx: 20 * 865 / 900, sz: 20 * 1078 / 1115 };     // basement drawing
  // The ground floor's real front part (the owner's ground-floor plan),
  // fitted into the evacuation plan's lower block (x 512-1058, y 822-1272).
  const PLAN_P = { px0: -391.2, py0: -725.5, sx: 22.1, sz: 22.0 };
  const wx = (pl, px) => BLD.x0 + (px - pl.px0) / pl.sx;
  const wz = (pl, py) => BLD.z0 + (py - pl.py0) / pl.sz;
  const OUTLINE_G = [[158, 158], [1058, 158], [1058, 1272], [512, 1272], [512, 940], [212, 940], [212, 718], [158, 718]];
  const LIFT_G = [343, 718, 410, 780];
  // Stair towers (owner, 2026-10-22): switchback stairs that really climb
  // the gap between floors. The core's goes basement -> ground -> 1st floor
  // from the back of the core; the Entrance Lobby's goes down to Hall-02.
  const TOWER_CORE = [218, 775, 276, 905];              // evacuation-plan pixels
  // The floor openings over it leave the back strip (the stairs' top landing) as floor.
  const TOWER_LOBBY = [22, 392, 172, 495];              // ground-floor-plan pixels
  // Rooms, halls, Breaking Area and the hall with the ablution row.
  const UPPER_WALLS = [
    [345, 158, 345, 533], [158, 253, 345, 253], [158, 348, 345, 348], [158, 437, 345, 437], [158, 533, 345, 533], [262, 540, 262, 690],
    [512, 158, 512, 718], [697, 158, 697, 348], [875, 158, 875, 348], [512, 348, 1058, 348], [512, 530, 875, 530], [875, 348, 875, 718],
    [512, 630, 600, 718], [600, 718, 1058, 718], [975, 718, 975, 760], [1013, 718, 1013, 760], [512, 822, 1058, 822], [512, 718, 512, 822],
    [158, 718, 343, 718], [410, 718, 512, 718]];
  const UPPER_LABELS = [['ROOM', 250, 205, 0.8], ['ROOM', 250, 300, 0.8], ['ROOM', 250, 390, 0.8], ['ROOM', 250, 485, 0.8], ['KITCHEN', 222, 625, 0.7],
    ['HALL', 430, 370, 1.1], ['HALL', 420, 615, 1.1], ['ROOM', 605, 250, 0.9], ['ROOM', 785, 250, 0.9], ['STORE', 965, 250, 0.9], ['HALL', 695, 440, 1.1],
    ['HALL', 965, 540, 1.1], ['BREAKING AREA', 720, 620, 0.9], ['HALL', 735, 770, 1.0], ['ABLUTION AREA', 945, 790, 0.7]];
  const FLOORS = [
    { parts: [{ plan: PLAN_B,
      outline: [[157, 60], [1022, 60], [1022, 1138], [500, 1138], [500, 815], [207, 815], [207, 600], [157, 600]],
      // The Machine Area is open to Hall-01 (no wall along its top) and the
      // lift's hall side is its doors (owner, 2026-10-21).
      walls: [[330, 597, 330, 815], [400, 597, 400, 710], [400, 710, 500, 710], [500, 710, 500, 815], [330, 668, 400, 668]],
      ramp: [515, 692, 617, 763, 'back'],        // hand-lifter ramp (owner's mark): Hall-02's top-left corner, high end at the back
      dashed: [[500, 703, 1022, 703]],
      columns: [[332, 242], [504, 242], [677, 242], [849, 242], [332, 421], [504, 421], [677, 421], [849, 421], [504, 600], [677, 600], [849, 600], [677, 707], [849, 707], [677, 815], [849, 815], [677, 922], [849, 922], [677, 1030], [849, 1030]],
      // [plan rect, reversed?] - Hall-02's front stairs climb toward the left.
      // Outside steps; the stairs to the ground floor are the stair towers below.
      stairs: [[1025, 258, 1055, 410]],
      lift: [333, 597, 397, 665],
      labels: [['HALL-01', 585, 320, 1.4], ['HALL-02', 755, 870, 1.4], ['MACHINE AREA', 265, 708, 0.8], ['WORK SHOP', 415, 765, 0.8]] }] },
    { parts: [
      // Back part, a few steps up: rooms, halls, Breaking Area, ablution hall.
      { plan: PLAN_G, raise: RAISE, outline: [[158, 158], [1058, 158], [1058, 822], [512, 822], [512, 718], [158, 718]], ext: [0, 1, 5],
        walls: UPPER_WALLS, labels: UPPER_LABELS },
      // Stairs + lift core, level with the hall beside it (owner): the U
      // stairs on up to the 1st floor (the basement's L flight arrives here), the lift, and
      // behind it the loading area with its roller-shutter gate - a few
      // steps outside the gate lead down to the street.
      { plan: PLAN_G, raise: RAISE, outline: [[212, 718], [512, 718], [512, 940], [212, 940]], ext: [3],
        walls: [[412, 780, 412, 940], [212, 940, 420, 940], [505, 940, 512, 940]],
        holes: [[218, 801, 276, 905, 'LB', [[276, 801, 276, 878]]]], lift: LIFT_G, loading: [416, 784, 508, 936], gate: [420, 505, 940],
        stairs: [[420, 942, 505, 978, 1, RAISE + 0.35 - 0.12, 'z', -RAISE + 0.12]] },
      // Front part on the street (the owner's ground-floor plan).
      { plan: PLAN_P, outline: [[0, 5], [603, 5], [603, 500], [0, 500]], ext: [1, 3],
        walls: [
          [135, 5, 135, 125], [135, 125, 150, 125], [185, 125, 205, 125], [205, 125, 205, 250], [5, 250, 205, 250],
          [200, 250, 200, 378], [5, 378, 200, 378],
          [205, 245, 270, 245], [330, 245, 392, 245],
          [392, 125, 603, 125], [392, 125, 392, 500], [392, 248, 603, 248], [392, 375, 550, 375], [545, 400, 545, 500],
          [0, 500, 270, 500], [330, 500, 603, 500]],
        // A few steps up to the back part beside the Production Office; the
        // Entrance Lobby's staircase goes DOWN to the basement, |_____ shaped,
        // through an opening in the floor.
        stairs: [[140, 8, 195, 48, 1, RAISE, 'z']],
        // Railed all round except where the stairs start (back-left corner).
        holes: [[...TOWER_LOBBY, 'LRB', [[57, 392, 172, 392]]]],
        labels: [['PRODUCTION OFFICE', 95, 175, 0.75], ['LOBBY', 300, 110, 1.0], ['PLATE MAKING', 485, 65, 0.85], ['SCANNING ROOM', 495, 185, 0.75],
          ['STORE ROOM', 100, 315, 0.85], ['ENTRANCE LOBBY', 297, 340, 0.85], ['ACCOUNT OFFICE', 475, 310, 0.7], ['DIRECTOR', 470, 445, 0.75], ['BATH', 572, 478, 0.6]] },
    ] },
    // 1st floor: the rooms / halls / ablution row and the stairs + lift core
    // (the loading area below is open - no floor over it). Beside the hall,
    // over the ground floor's front part, an OPEN AREA a little higher, with
    // a ramp up from the hall on its left and solar panels over it (owner).
    { parts: [
      { plan: PLAN_G,
        outline: [[158, 158], [1058, 158], [1058, 822], [512, 822], [512, 718], [412, 718], [412, 940], [212, 940], [212, 718], [158, 718]],
        walls: UPPER_WALLS.filter(w => !(w[1] === 822 && w[3] === 822)).concat([[600, 822, 1058, 822]]),
        holes: [[218, 801, 276, 905, 'LRB']], lift: LIFT_G, labels: UPPER_LABELS,
        ramp: [516, 768, 598, 822, 'front', OPEN_RAISE] },
      { plan: PLAN_G, raise: OPEN_RAISE, parapet: true, outline: [[512, 822], [1058, 822], [1058, 1272], [512, 1272]], ext: [1, 2, 3],
        solar: [522, 832, 1048, 1262], labels: [['OPEN AREA', 785, 1050, 1.3]] },
    ] },
    // Roof (2nd floor): open, with rows of solar panels on a steel frame.
    { parts: [{ plan: PLAN_G, parapet: true,
      outline: [[158, 158], [1058, 158], [1058, 822], [512, 822], [512, 718], [158, 718]],
      solar: [170, 170, 1046, 810], labels: [['SOLAR PANELS', 610, 440, 1.4]] }] },
  ];
  // The stair towers: plan rect, the floor heights they join, the axis the
  // flights run along, and which lane the first (lowest) flight climbs.
  // Two flights per tower with one landing between them (owner, 2026-10-22).
  // The basement one (owner's blue line) runs against the outer wall: from
  // the back of the basement forward along the left side, a corner landing,
  // then a short flight across the front up to the ground floor. The 1st-
  // floor one (yellow) leaves from the back-right: right side forward,
  // landing, back up the left. The lobby one: |_____ from its back-left.
  const FLOOR_TOP = 0.35;                         // slab thickness: a floor's walking level above its y
  const TOWERS = [
    { name: 'basement-ground', plan: PLAN_G, r: TOWER_CORE, from: FLOOR_Y[0] + FLOOR_TOP, to: FLOOR_Y[1] + RAISE + FLOOR_TOP, shape: 'L', longAxis: 'z', lane: 'lo', bottom: 'lo' },
    { name: 'ground-first', plan: PLAN_G, r: TOWER_CORE, from: FLOOR_Y[1] + RAISE + FLOOR_TOP, to: FLOOR_Y[2] + FLOOR_TOP, axis: 'z', flights: 2, startLane: 'right' },
    { name: 'lobby-basement', plan: PLAN_P, r: TOWER_LOBBY, from: FLOOR_Y[0] + FLOOR_TOP, to: FLOOR_Y[1] + FLOOR_TOP, shape: 'L', longAxis: 'x', lane: 'hi', bottom: 'hi' },
  ];
  // The basement machines, placed by the owner (2026-10-21) on a screenshot:
  // 7 printing presses (red) and 7 die-cutting + embellishment machines
  // (green) - 5 small platens along the left, 2 big ones by the back wall.
  // `at` is the basement plan pixel (nudged off pillars / walls); `face` is
  // the side the machine's front (delivery) points to on the plan - up is
  // the back wall; `units` is a press's number of printing units; `pallets`
  // are the spots beside each machine where its jobs' pallets wait, in
  // metres from the machine's centre. Numbered from the top, as the owner
  // counts them (2026-10-21): presses 1-3 five-unit, 4 two-unit, 5-7 one-
  // unit; presses 1-5 deliver to the left, 6-7 to the right. Die cutters 1-2
  // big, front down; 3-5 front right; 6-7 front down; 5-7 in the Machine Area.
  const MACHINES = [
    // 1-3: long presses (~13 m, extended delivery), from just right of the
    // middle pillars to the right side of Hall-01 (owner's blue lines).
    { kind: 'press', stage: 1, units: 5, len: 12.8, face: 'left', at: [811, 138], pallets: [[-4.5, 2.7], [-1.9, 2.7]] },
    { kind: 'press', stage: 1, units: 5, len: 12.8, face: 'left', at: [802, 298], pallets: [[-4.5, 2.7], [-1.9, 2.7]] },
    { kind: 'press', stage: 1, units: 5, len: 12.8, face: 'left', at: [797, 447], pallets: [[-4.5, -2.7], [-1.9, -2.7]] },
    { kind: 'press', stage: 1, units: 2, face: 'left', at: [970, 808], pallets: [[-1.4, 2.7], [1.0, 2.7]] },
    // 5-6 by Hall-02's left wall (owner's blue dots).
    { kind: 'press', stage: 1, units: 1, face: 'left', at: [573, 880], pallets: [[-1.3, -2.7], [1.3, -2.7]] },
    { kind: 'press', stage: 1, units: 1, face: 'right', at: [581, 971], pallets: [[4.3, -0.8], [4.3, 1.5]] },
    { kind: 'press', stage: 1, units: 1, face: 'right', at: [955, 989], pallets: [[-1.4, 2.7], [0.8, 2.7]] },
    // Die cutters 1-2: ~6 m long, toward the left (owner's red lines); 3-4
    // nearer the left wall.
    { kind: 'diecut-big', stage: 3, len: 6.2, face: 'down', at: [425, 189], pallets: [[0, 4.4], [-2.6, 4.4]] },
    { kind: 'diecut-big', stage: 3, len: 6.2, face: 'down', at: [245, 180], pallets: [[2.6, 1.5], [2.6, -1.2]] },
    { kind: 'diecut', stage: 3, face: 'right', at: [235, 358], pallets: [[3.2, 0]] },
    { kind: 'diecut', stage: 3, face: 'right', at: [224, 435], pallets: [[3.2, 0]] },
    // 5-7 stand together in the Machine Area (owner, 2026-10-21), between
    // the stairs and the Work Shop wall.
    { kind: 'diecut', stage: 3, face: 'right', at: [290, 620], pallets: [[0, -2.6]] },
    { kind: 'diecut', stage: 3, face: 'down', at: [300, 686], pallets: [[3.0, 0]] },
    { kind: 'diecut', stage: 3, face: 'down', at: [300, 752], pallets: [[3.0, 0]] },
  ];
  // A machine's front is its local +x; this turns it to face that side.
  const FACE_ROT = { right: 0, up: Math.PI / 2, left: Math.PI, down: -Math.PI / 2 };
  // Where each stage's pallets stand. Printing and Die Cutting wait beside
  // their machines; the rest use a plan rectangle - PROVISIONAL until the
  // owner places those stages too.
  const STAGE_ZONES = [
    { floor: 1, plan: PLAN_P, r: [400, 18, 590, 118] },    // CTP         - ground floor, the Plate Making room
    { floor: 0, machines: true },                          // Printing    - beside the 7 presses
    { floor: 0, plan: PLAN_B, r: [700, 492, 1000, 588] },  // Coatings    - basement, Hall-01 front strip
    { floor: 0, machines: true },                          // Die Cutting - beside the 7 die cutters
    { floor: 2, plan: PLAN_G, r: [530, 365, 860, 520] },   // Sorting     - 1st floor, middle hall
    { floor: 2, plan: PLAN_G, r: [890, 365, 1040, 700] },  // Pasting     - 1st floor, right hall
  ];
  const zoneRect = i => { const z = STAGE_ZONES[i], pl = z.plan; return { floor: z.floor, raise: z.raise || 0, x0: wx(pl, z.r[0]), z0: wz(pl, z.r[1]), x1: wx(pl, z.r[2]), z1: wz(pl, z.r[3]) }; };
  const READY = { x0: 8, x1: 36, z0: -14, z1: 8 };
  const DOCKS = [14, 22, 30];
  const DOCK_Z = READY.z1 + 4.85;          // truck centre when backed onto the dock
  const GATE = { x0: 39, x1: 48, z: 34 };
  const ROAD_Z = 42;
  const WAIT = { x0: -7, x1: 4, z0: 12, z1: 24 };

  function slotFor(place, k) {
    if (place === 'ready') {
      const col = k % 6, row = Math.floor(k / 6) % 4, layer = Math.floor(k / 24);
      return { x: READY.x0 + 3.6 + col * 3.9, z: READY.z0 + 7.5 + row * 3.4, lift: layer, y: 0 };
    }
    if (place === 'wait') {
      const col = k % 3, row = Math.floor(k / 3) % 3, layer = Math.floor(k / 9);
      return { x: WAIT.x0 + 2 + col * 3.5, z: WAIT.z0 + 2.2 + row * 3.8, lift: layer, y: 0 };
    }
    if (STAGE_ZONES[place].machines) {
      // Spread across the stage's machines first, then their second spot,
      // then stack a layer up.
      const ms = MACHINES.filter(m => m.stage === place);
      const spots = [];
      for (let s = 0; s < 3; s++) ms.forEach(m => { if (m.pallets[s]) spots.push([m, m.pallets[s]]); });
      const [m, off] = spots[k % spots.length];
      return { x: wx(PLAN_B, m.at[0]) + off[0], z: wz(PLAN_B, m.at[1]) + off[1], lift: Math.floor(k / spots.length), y: FLOOR_Y[0], floor: 0 };
    }
    const r = zoneRect(place);
    const cols = Math.max(1, Math.floor((r.x1 - r.x0 - 0.6) / 3.3)), rows = Math.max(1, Math.floor((r.z1 - r.z0 - 0.6) / 3.0));
    const per = cols * rows, i = k % per;
    return { x: r.x0 + 1.9 + (i % cols) * 3.3, z: r.z0 + 1.8 + Math.floor(i / cols) * 3.0, lift: Math.floor(k / per), y: FLOOR_Y[r.floor] + r.raise, floor: r.floor };
  }

  // ── Styles for the overlay (scoped to .saa-*) ──────────────────────
  const CSS = `
  .saa-host { position: relative; width: 100%; height: max(420px, calc(100vh - 160px)); height: max(420px, calc(100dvh - 160px)); border-radius: 14px; overflow: hidden; background: linear-gradient(#f5f8fc, #e6edf5); border: 1px solid var(--border, #e2e8f0); user-select: none; -webkit-user-select: none; }
  .saa-host canvas { display: block; width: 100%; height: 100%; touch-action: none; outline: none; }
  .saa-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px; color: var(--text2, #64748b); font-size: 14px; }
  /* "No orders" note: a small pill under the cards, not over the 3D view. */
  .saa-empty { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); background: rgba(255,255,255,.92); border: 1px solid #e2e8f0; border-radius: 999px; padding: 6px 14px; font-size: 12px; color: #64748b; white-space: nowrap; }
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
  .saa-views button.on { background: #A32D2D; border-color: #A32D2D; color: #fff; }
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
    .saa-host { height: max(400px, calc(100vh - 150px)); height: max(400px, calc(100dvh - 150px)); border-radius: 10px; }
    .saa-top { top: 8px; left: 8px; right: 8px; flex-direction: column; gap: 6px; }
    .saa-empty { top: 112px; }
    .saa-stats { gap: 5px; flex-wrap: nowrap; width: 100%; }
    .saa-card { flex: 1 1 0; min-width: 0; padding: 4px 6px; border-radius: 8px; }
    .saa-card b { font-size: 14px; } .saa-card span { font-size: 9.5px; white-space: normal; display: block; line-height: 1.15; }
    .saa-views { width: 100%; gap: 4px; }
    .saa-views button { flex: 1 1 auto; padding: 6px 4px; font-size: 10.5px; white-space: nowrap; }
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
    const cam = { target: new THREE.Vector3(-10, 1, 0), az: 0.32, el: 0.62, dist: 150 };

    scene.add(new THREE.HemisphereLight(0xffffff, 0xc7d2e0, 2.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.position.set(-40, 95, 55);
    sun.castShadow = true;
    sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 85, bottom: -85, near: 10, far: 260 });
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
      const bg = tone === 'red' ? '#dc2626' : tone === 'blue' ? '#1e40af' : tone === 'brand' ? '#A32D2D' : tone === 'amber' ? '#b45309' : '#ffffff';
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
    // Street level, with a pit in the basement's shape: the ground and the
    // yard have that hole, and see-through earth walls line it, so the
    // basement reads as underground but stays visible.
    const pitPts = FLOORS[0].parts[0].outline.map(([px, py]) => [wx(PLAN_B, px), wz(PLAN_B, py)]);
    const holePath = () => new THREE.Path(pitPts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const flatShape = (x0, z0, x1, z1) => { const sh = new THREE.Shape([new THREE.Vector2(x0, -z0), new THREE.Vector2(x1, -z0), new THREE.Vector2(x1, -z1), new THREE.Vector2(x0, -z1)]); sh.holes.push(holePath()); return sh; };
    const groundGeo = new THREE.ShapeGeometry(flatShape(-450, -450, 450, 450)); geos.add(groundGeo);
    // Own materials: in the Basement view the street goes see-through so the
    // whole basement shows, right up to its front wall.
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xe9eef4, roughness: 0.82, transparent: true });
    const yardMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.82, transparent: true });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const yardGeo = new THREE.ExtrudeGeometry(flatShape(-60, -38, 52, 34), { depth: 0.12, bevelEnabled: false }); geos.add(yardGeo);
    const yard = new THREE.Mesh(yardGeo, yardMat); yard.rotation.x = -Math.PI / 2; yard.receiveShadow = true; scene.add(yard);
    const earthMat = new THREE.MeshStandardMaterial({ color: 0x8d6e4c, roughness: 1, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
    pitPts.forEach(([x1, z1], k) => {
      const [x2, z2] = pitPts[(k + 1) % pitPts.length], len = Math.hypot(x2 - x1, z2 - z1);
      const eg2 = new THREE.BoxGeometry(len, -FLOOR_Y[0], 0.3); geos.add(eg2);
      const wall = new THREE.Mesh(eg2, earthMat); wall.position.set((x1 + x2) / 2, FLOOR_Y[0] / 2, (z1 + z2) / 2); wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1); scene.add(wall);
      box(len, 0.25, 0.5, 0x6b5b4a, (x1 + x2) / 2, 0.06, (z1 + z2) / 2, scene, false).rotation.y = -Math.atan2(z2 - z1, x2 - x1);   // the pit's rim
    });
    box(320, 0.14, 11, 0xb6c2d1, 40, 0.07, ROAD_Z, scene, false);
    for (let x = -110; x <= 190; x += 7) box(3.2, 0.02, 0.28, 0xffffff, x, 0.15, ROAD_Z, scene, false);
    box(320, 0.18, 1.4, 0xdfe5ec, 40, 0.09, ROAD_Z - 6.2, scene, false);
    box(GATE.x1 - GATE.x0, 0.13, 8, 0xc4ced9, (GATE.x0 + GATE.x1) / 2, 0.08, GATE.z + 2.5, scene, false);
    // Painted lanes from the docks to the gate.
    for (const dx of DOCKS) {
      box(0.18, 0.02, 9, BRAND_PALE, dx - 1.9, 0.14, DOCK_Z + 1, scene, false);
      box(0.18, 0.02, 9, BRAND_PALE, dx + 1.9, 0.14, DOCK_Z + 1, scene, false);
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
    fenceRun(-60, GATE.z, GATE.x0, GATE.z); fenceRun(GATE.x1, GATE.z, 52, GATE.z);
    fenceRun(-60, -38, 52, -38); fenceRun(-60, -38, -60, GATE.z); fenceRun(52, -38, 52, GATE.z);
    // Gate: a booth and a boom that lifts for trucks.
    box(2.2, 2.6, 2.2, 0xffffff, GATE.x1 + 1.6, 1.3, GATE.z - 1.6, scene);
    box(2.6, 0.25, 2.6, BRAND, GATE.x1 + 1.6, 2.72, GATE.z - 1.6, scene);
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
    [[-66, -30], [-66, -12], [-66, 6], [-66, 22], [-44, -44], [-24, -44], [-4, -44], [16, -44], [36, -44], [58, -20], [58, 0], [58, 20],
     [-56, 31], [-44, 31], [8, 30], [24, 30], [-70, 48], [-48, 49], [-20, 48], [10, 49], [34, 48], [62, 49], [86, 48]]
      .forEach(([x, z], i) => tree(x, z, 0.9 + ((i * 37) % 10) / 22));

    // ── Buildings (cut-away: tall back wall, low front so you see in) ──
    const building = (b, name, opts2) => {
      const g = new THREE.Group(); scene.add(g);
      const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const fl = box(w, 0.3, d, 0xf1f5f9, cx, 0.15, cz, g); fl.castShadow = false;
      box(w, 7, 0.5, BRAND, cx, 3.8, b.z0, g);
      box(w + 0.3, 0.45, 0.8, BRAND_DARK, cx, 7.5, b.z0, g);
      for (let x = b.x0 + 2.5; x < b.x1 - 1; x += 2.5) box(0.12, 6.4, 0.06, 0x8f2626, x, 3.7, b.z0 + 0.28, g, false);
      box(0.5, 7, d, BRAND, b.x0, 3.8, cz, g);
      box(0.8, 0.45, d + 0.3, BRAND_DARK, b.x0, 7.5, cz, g);
      box(0.5, 1.3, d, BRAND_LIGHT, b.x1, 0.95, cz, g);
      // Roof beams, so it reads as a building rather than a yard.
      for (let x = b.x0 + 5; x < b.x1 - 2; x += 7.5) box(0.35, 0.35, d * 0.55, BRAND_DEEP, x, 7.4, b.z0 + d * 0.27, g);
      // Front: low wall, with gaps for the docks when asked.
      const gaps = (opts2 && opts2.gaps) || [];
      let x = b.x0;
      const cuts = gaps.map(gx => [gx - 2.1, gx + 2.1]).concat([[b.x1, b.x1]]);
      for (const [a, c] of cuts) { if (a - x > 0.2) box(a - x, 1.3, 0.5, BRAND_LIGHT, (x + a) / 2, 0.95, b.z1, g); x = c; }
      const sign = decal(name, Math.min(w * 0.6, 22), 2.6, '#ffffff', { size: 0.66, spacing: 6 });
      sign.position.set(cx, 5.2, b.z0 + 0.3); g.add(sign);
      return g;
    };
    building(READY, 'READY STOCK', { gaps: DOCKS });

    // People (forklift drivers).
    const people = [];
    const person = (x, z, face, parent) => {
      const g = new THREE.Group(); g.position.set(x, 0.3, z); g.rotation.y = face || 0;
      cyl(0.32, 0.36, 1.1, BRAND, 0, 0.85, 0, g, 10);
      const hg = new THREE.SphereGeometry(0.3, 12, 10); geos.add(hg);
      const head = new THREE.Mesh(hg, mat(0xe8b98f)); head.position.y = 1.65; head.castShadow = true; g.add(head);
      box(0.66, 0.16, 0.62, 0xfacc15, 0, 1.92, 0, g);
      (parent || scene).add(g); people.push(g);
      return g;
    };

    // ── Production: the three floors from the owner's plans, stacked apart ──
    const SLAB = 0.35;
    const floorGroups = [], floorTags = [], slabMats = [], liftAnims = [];
    const wallSeg = (x1, z1, x2, z2, h, color, t, parent) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.05) return null;
      const m = box(len + t, h, t, color, (x1 + x2) / 2, SLAB + h / 2, (z1 + z2) / 2, parent);
      m.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      return m;
    };
    const edgeMat = new THREE.LineBasicMaterial({ color: BRAND_DARK });
    // Solar canopy: steel posts on a grid, beams along the rows, and tilted
    // panels (one instanced mesh, so hundreds of panels stay cheap).
    const solarCanopy = (parent, x0, x1, z0, z1, y) => {
      const nx = Math.max(1, Math.round((x1 - x0) / 7)), nz = Math.max(1, Math.round((z1 - z0) / 7));
      for (let i = 0; i <= nx; i++) for (let k = 0; k <= nz; k++) box(0.22, y, 0.22, 0x6b7280, x0 + (x1 - x0) * i / nx, y / 2, z0 + (z1 - z0) * k / nz, parent);
      for (let k = 0; k <= nz; k++) box(x1 - x0, 0.2, 0.2, 0x4b5563, (x0 + x1) / 2, y, z0 + (z1 - z0) * k / nz, parent, false);
      for (let i = 0; i <= nx; i++) box(0.2, 0.2, z1 - z0, 0x4b5563, x0 + (x1 - x0) * i / nx, y, (z0 + z1) / 2, parent, false);
      const pw = 1.6, pd = 1.0, cols = Math.floor((x1 - x0) / (pw + 0.12)), rows = Math.floor((z1 - z0) / 1.9);
      const pg2 = new THREE.BoxGeometry(pw, 0.06, pd); geos.add(pg2);
      const pm = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.35, metalness: 0.4 });
      const inst = new THREE.InstancedMesh(pg2, pm, cols * rows);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.26, 0, 0)), sc = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
      let n = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        pos.set(x0 + (pw + 0.12) * (c + 0.5) + ((x1 - x0) - cols * (pw + 0.12)) / 2, y + 0.35, z0 + 1.9 * (r + 0.5) + ((z1 - z0) - rows * 1.9) / 2);
        inst.setMatrixAt(n++, m4.compose(pos, q, sc));
      }
      inst.castShadow = true; inst.receiveShadow = true; parent.add(inst);
    };
    // A guard rail: posts every ~1.2 m with a black top rail and a red kick plate.
    const railing = (x1, z1, x2, z2, y, parent) => {
      const len = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.round(len / 1.2)), rot = -Math.atan2(z2 - z1, x2 - x1);
      for (let i = 0; i <= n; i++) box(0.07, 0.95, 0.07, 0x374151, x1 + (x2 - x1) * i / n, y + 0.475, z1 + (z2 - z1) * i / n, parent);
      box(len + 0.07, 0.07, 0.09, 0x111827, (x1 + x2) / 2, y + 0.96, (z1 + z2) / 2, parent).rotation.y = rot;
      box(len, 0.03, 0.05, 0x6b7280, (x1 + x2) / 2, y + 0.5, (z1 + z2) / 2, parent, false).rotation.y = rot;
      box(len, 0.12, 0.06, BRAND_LIGHT, (x1 + x2) / 2, y + 0.06, (z1 + z2) / 2, parent).rotation.y = rot;
    };
    FLOORS.forEach((F, fi) => {
      const g = new THREE.Group(); g.position.y = FLOOR_Y[fi]; scene.add(g); floorGroups.push(g);
      // One slab material per floor (upper floors see-through in the overview).
      const sm = new THREE.MeshStandardMaterial({ color: fi === 0 ? 0xe2e8f0 : 0xf1f5f9, roughness: 0.9, transparent: true, opacity: fi === 0 ? 1 : 0.62 });
      slabMats.push(sm);
      for (const P of F.parts) {
        const raise = P.raise || 0, pg = new THREE.Group(); pg.position.y = raise; g.add(pg);
        const pl = P.plan, X = px => wx(pl, px), Z = py => wz(pl, py);
        // Slab in the part's own shape; a raised part is a solid step up.
        const shape = new THREE.Shape(P.outline.map(([px, py]) => new THREE.Vector2(X(px), -Z(py))));
        // Stair openings, with railings on the given sides (Top/back, Bottom/front, Left, Right).
        for (const [a, b, c, d, rails, extra] of P.holes || []) {
          shape.holes.push(new THREE.Path([new THREE.Vector2(X(a), -Z(b)), new THREE.Vector2(X(c), -Z(b)), new THREE.Vector2(X(c), -Z(d)), new THREE.Vector2(X(a), -Z(d))]));
          const sides = { T: [X(a), Z(b), X(c), Z(b)], B: [X(a), Z(d), X(c), Z(d)], L: [X(a), Z(b), X(a), Z(d)], R: [X(c), Z(b), X(c), Z(d)] };
          for (const k of rails || '') {
            const [p, q, u, v] = sides[k];
            railing(p, q, u, v, SLAB, pg);
          }
          for (const [e, f, g2, h] of extra || []) railing(X(e), Z(f), X(g2), Z(h), SLAB, pg);
        }
        const sg = new THREE.ExtrudeGeometry(shape, { depth: SLAB + raise, bevelEnabled: false }); geos.add(sg);
        const slab = new THREE.Mesh(sg, sm); slab.rotation.x = -Math.PI / 2; slab.position.y = -raise; slab.receiveShadow = true; pg.add(slab);
        const eg = new THREE.EdgesGeometry(sg); geos.add(eg);
        const edges = new THREE.LineSegments(eg, edgeMat); edges.rotation.x = -Math.PI / 2; edges.position.y = -raise; pg.add(edges);
        // Outer walls (on the part's outside edges) and room walls, low so you see in.
        P.outline.forEach(([px, py], k) => {
          if (P.ext && !P.ext.includes(k)) return;
          const [qx, qy] = P.outline[(k + 1) % P.outline.length];
          wallSeg(X(px), Z(py), X(qx), Z(qy), P.parapet ? 1.1 : 2.4, BRAND, 0.35, pg);
        });
        // Solar panels on a steel frame over the given area (roof, open area).
        if (P.solar) solarCanopy(pg, X(P.solar[0]), X(P.solar[2]), Z(P.solar[1]), Z(P.solar[3]), SLAB + 3.0);
        for (const [a, b, c, d] of P.walls || []) wallSeg(X(a), Z(b), X(c), Z(d), 1.5, BRAND_PALE, 0.2, pg);
        for (const [a, b, c, d] of P.dashed || []) {
          const n = Math.round(Math.hypot(X(c) - X(a), Z(d) - Z(b)) / 1.2);
          for (let k = 0; k < n; k += 2) { const t0 = k / n, t1 = (k + 1) / n; box(Math.abs(X(c) - X(a)) * (t1 - t0) + 0.15, 0.02, Math.abs(Z(d) - Z(b)) * (t1 - t0) + 0.15, 0x94a3b8, X(a) + (X(c) - X(a)) * (t0 + t1) / 2, SLAB + 0.01, Z(b) + (Z(d) - Z(b)) * (t0 + t1) / 2, pg, false); }
        }
        for (const [px, py] of P.columns || []) box(0.6, 2.4, 0.6, 0x64748b, X(px), SLAB + 1.2, Z(py), pg);
        // Stairs [rect, reversed?, top height, 'x' | 'z', base]: steps rising
        // along the long side (or the given axis), reversed ones the other
        // way; `base` lets a flight start below the part's floor (outside steps).
        for (const [a, b, c, d, rev, top, axis, base] of P.stairs || []) {
          const x0 = X(a), x1 = X(c), z0 = Z(b), z1 = Z(d), alongX = axis ? axis === 'x' : (x1 - x0) > (z1 - z0), n = 9, y0 = base == null ? SLAB : base;
          for (let k = 0; k < n; k++) {
            const h = (top || 2.25) * ((rev ? n - k - 1 : k) + 1) / n;
            if (alongX) box((x1 - x0) / n, h, z1 - z0, 0xcbd5e1, x0 + (x1 - x0) * (k + 0.5) / n, y0 + h / 2, (z0 + z1) / 2, pg);
            else box(x1 - x0, h, (z1 - z0) / n, 0xcbd5e1, (x0 + x1) / 2, y0 + h / 2, z0 + (z1 - z0) * (k + 0.5) / n, pg);
          }
        }
        // Hand-lifter ramp: a wedge climbing toward the front (or the back), yellow edges.
        if (P.ramp) {
          const [a, b, c, d, up, rise] = P.ramp, D = Z(d) - Z(b), W = X(c) - X(a), H = rise || 2.2, back = up === 'back';
          const rshape = new THREE.Shape(back ? [new THREE.Vector2(0, 0), new THREE.Vector2(D, 0), new THREE.Vector2(0, H)] : [new THREE.Vector2(0, 0), new THREE.Vector2(D, 0), new THREE.Vector2(D, H)]);
          const rg = new THREE.ExtrudeGeometry(rshape, { depth: W, bevelEnabled: false }); geos.add(rg);
          const ramp = new THREE.Mesh(rg, mat(0x9ca3af)); ramp.rotation.y = -Math.PI / 2; ramp.position.set(X(c), SLAB, Z(b));
          ramp.castShadow = true; ramp.receiveShadow = true; pg.add(ramp);
          const len = Math.hypot(D, H), tilt = Math.atan2(H, D);
          for (const ex of [X(a) + 0.12, X(c) - 0.12]) {
            const edge = box(0.2, 0.06, len, 0xfacc15, ex, SLAB + H / 2 + 0.04, Z(b) + D / 2, pg, false); edge.rotation.x = back ? tilt : -tilt;
          }
          const lab = decal(back ? 'RAMP  ↓' : 'RAMP  ↑', 4, 1.0, '#b45309', { size: 0.6 });
          lab.rotation.x = -Math.PI / 2; lab.position.set((X(a) + X(c)) / 2, SLAB + 0.02, back ? Z(d) + 0.9 : Z(b) - 0.9); lab.renderOrder = 1; pg.add(lab);
        }
        // Loading area (yellow-striped bay) and its roller-shutter gate.
        if (P.loading) {
          const [a, b, c, d] = P.loading, x0 = X(a), x1 = X(c), z0 = Z(b), z1 = Z(d), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
          for (const [w, dd, x, z] of [[x1 - x0, 0.18, cx, z0], [x1 - x0, 0.18, cx, z1], [0.18, z1 - z0, x0, cz], [0.18, z1 - z0, x1, cz]]) box(w, 0.02, dd, 0xfacc15, x, SLAB + 0.01, z, pg, false);
          for (let k = 1; k < 6; k++) { const s = box(0.14, 0.02, (x1 - x0) * 0.9, 0xfacc15, cx, SLAB + 0.012, z0 + (z1 - z0) * k / 6, pg, false); s.rotation.y = Math.PI / 4; s.scale.z = 0.5; }
          const lab = decal('LOADING AREA', 4.4, 0.9, '#b45309', { size: 0.6 });
          lab.rotation.x = -Math.PI / 2; lab.rotation.z = Math.PI / 2; lab.position.set(cx, SLAB + 0.03, cz); lab.renderOrder = 1; pg.add(lab);
        }
        if (P.gate) {
          const [a, c, y] = P.gate, x0 = X(a), x1 = X(c), z = Z(y);
          box(0.3, 2.4, 0.4, 0x6b7280, x0, SLAB + 1.2, z, pg); box(0.3, 2.4, 0.4, 0x6b7280, x1, SLAB + 1.2, z, pg);
          box(x1 - x0 + 0.3, 0.45, 0.45, 0x4b5563, (x0 + x1) / 2, SLAB + 2.3, z, pg);          // shutter box
          const sh = box(x1 - x0, 0.9, 0.08, 0x9ca3af, (x0 + x1) / 2, SLAB + 1.65, z, pg);       // half-open roller shutter
          for (let k = 0; k < 5; k++) box(x1 - x0, 0.03, 0.1, 0x6b7280, (x0 + x1) / 2, SLAB + 1.25 + k * 0.18, z, pg, false);
          sh.castShadow = true;
        }
        // Lift: silver car with doors that slide open and shut.
        if (P.lift) {
          const [a, b, c, d] = P.lift, lx0 = X(a), lx1 = X(c), lz0 = Z(b), lz1 = Z(d), lw = lx1 - lx0, ld = lz1 - lz0, H = 2.5, cx = (lx0 + lx1) / 2;
          wallSeg(lx0, lz0, lx0, lz1, H, 0xcbd5e1, 0.15, pg); wallSeg(lx1, lz0, lx1, lz1, H, 0xcbd5e1, 0.15, pg); wallSeg(lx0, lz1, lx1, lz1, H, 0xcbd5e1, 0.15, pg);
          box(lw + 0.15, 0.15, ld + 0.15, 0x9ca3af, cx, SLAB + H + 0.07, (lz0 + lz1) / 2, pg);
          box(lw, 0.3, 0.18, 0x6b7280, cx, SLAB + H - 0.15, lz0, pg);                   // door head with the floor display
          const disp = box(0.5, 0.18, 0.04, 0x111827, cx, SLAB + H - 0.15, lz0 - 0.1, pg, false); disp.material = new THREE.MeshBasicMaterial({ color: 0xef4444 });
          const doors = [-1, 1].map(s => box(lw / 2 - 0.05, H - 0.35, 0.08, 0x9ca3af, cx + s * lw / 4, SLAB + (H - 0.3) / 2, lz0, pg));
          const fi0 = fi;
          liftAnims.push(t => {                                                      // open ~3 s of every 9, a floor apart
            const u = ((t + fi0 * 3) % 9) / 9, open = u < 0.1 ? u / 0.1 : u < 0.4 ? 1 : u < 0.5 ? 1 - (u - 0.4) / 0.1 : 0;
            doors.forEach((dr, k) => { dr.position.x = cx + (k ? 1 : -1) * (lw / 4 + open * lw * 0.22); });
          });
        }
        for (const [text, px, py, s] of P.labels || []) {
          const m = decal(text, Math.max(3, text.length * s * 0.78), s * 1.3, '#64748b', { size: 0.6, weight: 700 });
          m.rotation.x = -Math.PI / 2; m.position.set(X(px), SLAB + 0.02, Z(py)); m.renderOrder = 1; pg.add(m);
        }
      }
      const ft = tag(FLOOR_NAMES[fi], '', 'brand', 3.4);
      ft.position.set(BLD.x0 - 4.5, 2.4, BLD.z0 + 18); g.add(ft); floorTags.push(ft);
    });
    // ── Stair towers: switchback stairs that really climb between floors ──
    // Flights alternate lanes with a landing at each end; every flight has
    // treads with a nosing, stringers and handrails on both sides. A tower
    // shows in the overview and in the views of the two floors it joins.
    const towerGroups = [];
    // One straight flight from l0 to l1 along x (axisX) or z, centred on
    // `wc` across, `wdt` wide, climbing `rise` from `base`: treads with a
    // nosing, stringers and handrails on both sides, posts at both ends.
    const flight = (tg, axisX, l0, l1, wc, wdt, base, rise) => {
      const run = Math.abs(l1 - l0), dir = Math.sign(l1 - l0) || 1, m = Math.max(5, Math.round(rise / 0.27)), tread = run / m, sr = rise / m;
      const put = (dl, dw, h, l, w, y, color, tilt) => {
        const b = axisX ? box(dl, h, dw, color, l, y, w, tg) : box(dw, h, dl, color, w, y, l, tg);
        if (tilt) { if (axisX) b.rotation.z = tilt; else b.rotation.x = -tilt; }
        return b;
      };
      for (let s = 0; s < m; s++) {
        const top = base + (s + 1) * sr, l = l0 + dir * (s + 0.5) * tread;
        put(tread + 0.03, wdt, 0.14, l, wc, top - 0.07, 0xe5e7eb);                                  // tread
        put(0.05, wdt, 0.05, l + dir * tread / 2, wc, top - 0.025, 0x9ca3af);                       // nosing
      }
      const ang = Math.atan2(rise, run) * dir, slope = Math.hypot(run, rise), midL = (l0 + l1) / 2;
      for (const w of [wc - wdt / 2 + 0.04, wc + wdt / 2 - 0.04]) {
        put(slope, 0.08, 0.32, midL, w, base + rise / 2 - 0.2, BRAND_DARK, ang);                   // stringer
        put(slope, 0.06, 0.06, midL, w, base + rise / 2 + 0.92, 0x111827, ang);                    // handrail
        put(0.06, 0.06, 0.95, l0, w, base + 0.47, 0x374151);                                       // posts
        put(0.06, 0.06, 0.95, l1, w, base + rise + 0.47, 0x374151);
      }
    };
    const landing = (tg, x0, x1, z0, z1, y) => box(x1 - x0, 0.2, z1 - z0, 0xd1d5db, (x0 + x1) / 2, y - 0.1, (z0 + z1) / 2, tg);
    for (const T of TOWERS) {
      const tg = new THREE.Group(); scene.add(tg); towerGroups.push({ g: tg, floors: T.name === 'ground-first' ? [1, 2] : [0, 1] });
      const pl = T.plan, x0 = wx(pl, T.r[0]), x1 = wx(pl, T.r[2]), z0 = wz(pl, T.r[1]), z1 = wz(pl, T.r[3]);
      if (T.shape === 'L') {
        // L stairs, built bottom-up: one long flight along `longAxis` in the
        // `lane` strip ('lo' = left / back side, 'hi' = right / front side)
        // starting from the `bottom` end, a corner landing, then a short
        // flight along the other axis to the top. Same slope for both.
        const lx = T.longAxis === 'x', A0 = lx ? x0 : z0, A1 = lx ? x1 : z1, B0 = lx ? z0 : x0, B1 = lx ? z1 : x1;
        const fw = Math.min(1.6, (B1 - B0) * 0.45), hiLane = T.lane === 'hi', hiBottom = T.bottom === 'hi';
        const laneC = hiLane ? B1 - fw / 2 : B0 + fw / 2;
        const aStart = hiBottom ? A1 : A0, aEnd = hiBottom ? A0 + fw : A1 - fw;
        const cA = hiBottom ? [A0, A0 + fw] : [A1 - fw, A1], cB = hiLane ? [B1 - fw, B1] : [B0, B0 + fw];
        const bStart = hiLane ? B1 - fw : B0 + fw, bEnd = hiLane ? B0 : B1;
        const runLong = Math.abs(aEnd - aStart), runShort = Math.abs(bEnd - bStart);
        const total = T.to - T.from, hLong = total * runLong / (runLong + runShort), hShort = total - hLong;
        flight(tg, lx, aStart, aEnd, laneC, fw, T.from, hLong);
        if (lx) landing(tg, cA[0], cA[1], cB[0], cB[1], T.from + hLong); else landing(tg, cB[0], cB[1], cA[0], cA[1], T.from + hLong);
        flight(tg, !lx, bStart, bEnd, (cA[0] + cA[1]) / 2, fw, T.from + hLong, hShort);
        continue;
      }
      // Dog-leg / switchback: flights alternate lanes with a landing at each turn.
      const alongX = T.axis === 'x';
      const L0 = alongX ? x0 : z0, L1 = alongX ? x1 : z1, W0 = alongX ? z0 : x0, W1 = alongX ? z1 : x1;
      const len = L1 - L0, wid = W1 - W0, lane = (wid - 0.12) / 2, land = Math.min(1.3, len * 0.22);
      const rise = (T.to - T.from) / T.flights;
      const rect = (la, lb, wa, wb, y) => alongX ? landing(tg, Math.min(la, lb), Math.max(la, lb), wa, wb, y) : landing(tg, wa, wb, Math.min(la, lb), Math.max(la, lb), y);
      for (let k = 0; k < T.flights; k++) {
        const fwd = k % 2 === 0;                                   // even flights run from L0 to L1
        const low = (k % 2 === 0) === (T.startLane === 'left');    // on the low-side (left / back) lane?
        const laneW = low ? W0 + lane / 2 : W1 - lane / 2, base = T.from + k * rise;
        flight(tg, alongX, fwd ? L0 + land : L1 - land, fwd ? L1 - land : L0 + land, laneW, lane, base, rise);
        // Landing at the flight's top end: full width between flights; the last one meets the floor.
        const e0 = fwd ? L1 - land : L0, e1 = fwd ? L1 : L0 + land;
        if (k < T.flights - 1) rect(e0, e1, W0, W1, base + rise);
        else rect(e0, e1, laneW - lane / 2, laneW + lane / 2, base + rise);
      }
    }
    // The building's frame: corner posts through all three floors, the lift
    // shaft with its car going up and down, and the name on top.
    const frame = new THREE.Group(); scene.add(frame);
    {
      const pl = PLAN_G, bot = FLOOR_Y[0], top = FLOOR_Y[3] + 1.4, hgt = top - bot;
      for (const [px, py] of OUTLINE_G) cyl(0.14, 0.14, hgt, BRAND_DARK, wx(pl, px), bot + hgt / 2, wz(pl, py), frame, 8);
      const [a, b, c, d] = LIFT_G, lx = (wx(pl, a) + wx(pl, c)) / 2, lz = (wz(pl, b) + wz(pl, d)) / 2, lw = wx(pl, c) - wx(pl, a), ld = wz(pl, d) - wz(pl, b);
      const shaftGeo = new THREE.BoxGeometry(lw, hgt, ld); geos.add(shaftGeo);
      const shaft = new THREE.Mesh(shaftGeo, new THREE.MeshStandardMaterial({ color: BRAND_LIGHT, transparent: true, opacity: 0.18, depthWrite: false }));
      shaft.position.set(lx, bot + hgt / 2, lz); frame.add(shaft);
      var liftCar = box(lw * 0.8, 2.0, ld * 0.8, BRAND_DARK, lx, bot + 1.4, lz, frame);
      const sign = tag('PRODUCTION', '', 'brand', 5.5);
      sign.position.set(BLD.x0 + BLD.w / 2, top + 4.2, BLD.z0 + 2); frame.add(sign); floorTags.push(sign);
    }
    // Stage areas (provisional until the owner places them): a painted
    // outline and the stage's name on its floor.
    STAGE_ZONES.forEach((z, i) => {
      if (!z.r) return;
      const r = zoneRect(i), g = floorGroups[r.floor], y = SLAB + r.raise + 0.015;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, w = r.x1 - r.x0, d = r.z1 - r.z0;
      for (const [bw, bd, x, zz] of [[w, 0.2, cx, r.z0], [w, 0.2, cx, r.z1], [0.2, d, r.x0, cz], [0.2, d, r.x1, cz]]) box(bw, 0.02, bd, BRAND, x, y, zz, g, false);
      const lab = `${i + 1}  ${BAY_NAMES[i].toUpperCase()}`;
      const m = decal(lab, Math.min(w - 0.4, lab.length * 0.95), 1.2, '#7C1F1F', { size: 0.62 });
      m.rotation.x = -Math.PI / 2; m.position.set(cx, y + 0.01, r.z1 - 0.9); m.renderOrder = 1; g.add(m);
    });
    // ── Basement machines (owner's placement): presses and die cutters ──
    // Each machine runs: rollers turn, sheets travel feeder -> delivery, the
    // delivery pile grows, die-cutter platens press, flywheels spin.
    const animated = [];
    const roller = (len, r, color, x, y, z, parent) => {   // a roller along z that can spin
      const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g);
      cyl(r, r, len, color, 0, 0, 0, g, 12).rotation.x = Math.PI / 2;
      box(r * 0.5, r * 0.5, len * 0.98, 0x1e293b, 0, r * 0.85, 0, g, false);   // a stripe, so the turning shows
      return g;
    };
    const sheetGeo = new THREE.BoxGeometry(1, 0.03, 1); geos.add(sheetGeo);
    const sheetMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const travelSheet = (parent, x0, x1, y, w, d, speed, phase) => {
      const s = new THREE.Mesh(sheetGeo, sheetMat); s.scale.set(w, 1, d); s.position.y = y; parent.add(s);
      return t => { const u = ((t * speed + phase) % 1 + 1) % 1; s.position.x = x0 + (x1 - x0) * u; s.visible = u > 0.04 && u < 0.96; };
    };
    const signal = (parent, x, z) => {   // the green / amber / red light tower
      cyl(0.05, 0.05, 0.7, 0x334155, x, 2.25, z, parent, 6);
      const lamp = c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.15 });
      const green = lamp(0x22c55e);
      [[0xef4444, 2.95], [0xf59e0b, 2.78]].forEach(([c, y]) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 10), lamp(c)); geos.add(m.geometry); m.position.set(x, y, z); parent.add(m); });
      const gm = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 10), green); geos.add(gm.geometry); gm.position.set(x, 2.61, z); parent.add(gm);
      return t => { green.emissiveIntensity = 0.5 + 0.5 * Math.sin(t * 4); };
    };
    const buildPress = (g, n, units, len) => {  // sheet-fed offset press: feeder -> units -> delivery along +x
      const UW = units >= 5 ? 1.25 : 0.95, W = 2.2, L = Math.max(len || 0, 1.3 + units * UW + 1.3 + 0.2), del = L - 1.3 - units * UW - 0.2;
      box(L, 0.3, W, 0x111827, 0, 0.15, 0, g);
      box(1.3, 1.4, W * 0.9, 0xcbd5e1, -L / 2 + 0.65, 1.0, 0, g);                 // feeder
      box(1.1, 0.5, 1.6, 0xffffff, -L / 2 + 0.6, 1.95, 0, g);                     // paper pile
      const rollers = [];
      for (let u = 0; u < units; u++) {                                          // the printing units
        const ux = -L / 2 + 1.3 + 0.1 + UW * (u + 0.5);   // units right after the feeder
        box(UW - 0.05, 1.9, W, u % 2 ? 0x1f2937 : 0x111827, ux, 1.25, 0, g);
        box(0.65, 0.25, W * 0.7, [0x06b6d4, 0xdb2777, 0xfacc15, 0x111827, 0xf97316][u % 5], ux, 2.32, 0, g);   // ink ducts: C M Y K + a fifth colour
        rollers.push(roller(W * 1.02, 0.17, 0x94a3b8, ux + 0.42, 1.6, 0, g));
      }
      box(del, 1.1, W, 0xcbd5e1, L / 2 - del / 2, 0.85, 0, g);                    // delivery (extended on the long presses)
      if (del > 2.2) box(del - 1.6, 0.55, W * 0.92, 0x374151, L / 2 - del / 2 - 0.5, 1.68, 0, g);   // dryer hood over the extended delivery
      const pile = box(1.0, 1, 1.5, 0xffffff, L / 2 - 0.65, 1.4, 0, g);
      box(0.5, 1.1, 0.35, 0x1f2937, L / 2 - 0.4, 0.85, W / 2 + 0.45, g);         // console
      const scr = box(0.42, 0.3, 0.02, 0x22d3ee, L / 2 - 0.4, 1.25, W / 2 + 0.63, g, false); scr.material = new THREE.MeshBasicMaterial({ color: 0x67e8f9 });
      const light = signal(g, L / 2 - 1.3, -W / 2 + 0.2);
      person(L / 2 + 0.75, 0.3, 0, g);                                            // operator at the delivery end
      const sheets = [0, 0.33, 0.66].map(ph => travelSheet(g, -L / 2 + 0.9, L / 2 - 0.8, 2.52, 0.9, 1.4, 0.45, ph + n * 0.13));
      animated.push((dt, t) => {
        for (const r of rollers) r.rotation.z -= dt * 6;
        for (const s of sheets) s(t);
        const h = 0.15 + ((t * 0.05 + n * 0.17) % 1) * 0.6; pile.scale.y = h; pile.position.y = 1.4 + h / 2;
        light(t + n);
      });
    };
    const buildDieCutBig = (g, n, len) => {  // big automatic die cutter, ~5-6 m along x
      const L = len || 5, W = 2.4;
      box(L, 0.3, W, 0x111827, 0, 0.15, 0, g);
      box(1.2, 1.5, W * 0.9, 0xcbd5e1, -L / 2 + 0.6, 1.05, 0, g);
      box(1.0, 0.45, 1.7, 0xffffff, -L / 2 + 0.6, 2.02, 0, g);
      box(2.2, 2.1, W, 0x111827, -0.2, 1.35, 0, g);                              // cutting section
      const platen = box(1.9, 0.25, W * 0.85, 0x94a3b8, -0.2, 2.55, 0, g);
      box(L / 2 - 1.2, 1.6, W, 0x9ca3af, (0.9 + L / 2 - 0.8) / 2, 1.1, 0, g);     // stripping, up to the delivery
      box(0.8, 1.0, W, 0xcbd5e1, L / 2 - 0.4, 0.8, 0, g);                        // delivery
      const pile = box(0.7, 1, 1.6, 0xc9a26b, L / 2 - 0.4, 1.3, 0, g);
      const light = signal(g, 1.4, -W / 2 + 0.2);
      person(0.6, W / 2 + 0.9, Math.PI, g);
      const sheets = [0, 0.5].map(ph => travelSheet(g, -L / 2 + 0.8, L / 2 - 0.5, 2.3, 1.0, 1.6, 0.4, ph + n * 0.2));
      animated.push((dt, t) => {
        platen.position.y = 2.55 + Math.max(0, Math.sin(t * 5 + n)) * 0.22;
        for (const s of sheets) s(t);
        const h = 0.15 + ((t * 0.04 + n * 0.3) % 1) * 0.55; pile.scale.y = h; pile.position.y = 1.3 + h / 2;
        light(t + n);
      });
    };
    const buildDieCut = (g, n) => {        // small platen die cutter with its flywheel
      box(1.8, 0.25, 1.5, 0x111827, 0, 0.12, 0, g);
      box(1.3, 1.5, 1.3, 0x1f2937, -0.15, 1.0, 0, g);
      const jaw = new THREE.Group(); jaw.position.set(0.5, 0.6, 0); g.add(jaw);    // front (+x): the platen that opens and closes
      box(0.18, 1.1, 1.1, 0x94a3b8, 0.09, 0.55, 0, jaw);
      const fly = new THREE.Group(); fly.position.set(-0.15, 1.15, 0.8); g.add(fly);
      cyl(0.62, 0.62, 0.12, 0xcbd5e1, 0, 0, 0, fly, 18).rotation.x = Math.PI / 2;
      for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) { const sp = box(1.15, 0.08, 0.14, 0x1f2937, 0, 0, 0.02, fly, false); sp.rotation.z = a; }
      person(1.35, -0.2, 0, g);                                                    // operator feeding at the front
      const light = signal(g, -0.6, -0.5);
      animated.push((dt, t) => {
        fly.rotation.z -= dt * 4;
        jaw.rotation.z = -0.45 * (0.5 + 0.5 * Math.sin(t * 2.6 + n * 1.3));
        light(t + n);
      });
    };
    const STAGE_COLOR = { 1: '#374151', 3: '#374151' };
    MACHINES.forEach((m, i) => {
      const g = new THREE.Group(), x = wx(PLAN_B, m.at[0]), z = wz(PLAN_B, m.at[1]);
      g.position.set(x, SLAB, z);
      g.rotation.y = FACE_ROT[m.face] || 0;
      floorGroups[0].add(g);
      if (m.kind === 'press') buildPress(g, i, m.units || 4, m.len); else if (m.kind === 'diecut-big') buildDieCutBig(g, i, m.len); else buildDieCut(g, i);
      // Name painted on the floor behind the machine, far enough back that
      // the machine itself doesn't hide it from the usual camera angle.
      const sideways = m.face === 'up' || m.face === 'down';
      const depth = m.kind === 'press' ? 2.2 : m.kind === 'diecut-big' ? (sideways ? (m.len || 5) : 2.4) : (sideways ? 1.8 : 1.5);
      const name = m.stage === 1 ? (m.units ? m.units + '-UNIT PRESS' : 'PRINTING') : m.kind === 'diecut' ? 'DIE CUT' : 'DIE CUTTING';
      const lab = decal(name, name.length * 0.55, 0.75, STAGE_COLOR[m.stage], { size: 0.62 });
      lab.rotation.x = -Math.PI / 2; lab.position.set(x, SLAB + 0.02, z - depth / 2 - (m.kind === 'diecut' ? 1.0 : 1.5)); lab.renderOrder = 1; floorGroups[0].add(lab);
    });

    // Which floors show: all (see-through upper slabs) or just one.
    let floorFocus = null;
    const setFloorFocus = f => {
      floorFocus = f;
      floorGroups.forEach((g, i) => { g.visible = f == null || i === f; });
      towerGroups.forEach(t => { t.g.visible = f == null || t.floors.includes(f); });
      frame.visible = f == null;
      for (const m of [groundMat, yardMat]) { m.opacity = f === 0 ? 0.15 : 1; m.depthWrite = f !== 0; }
      slabMats.forEach((m, i) => { m.opacity = (f != null || i === 0) ? 1 : 0.62; });
      for (const p of pallets.values()) p.g.visible = f == null || p.floor == null || p.floor === f;
      for (const w of wanderers) w.f.visible = f == null || w.floor == null || w.floor === f;
    };
    // Ready Stock: racks along the back wall, filled with cartons.
    for (let r = 0; r < 3; r++) {
      const rx = READY.x0 + 5 + r * 9;
      for (const ux of [-3.8, 3.8]) for (const uz of [-0.7, 0.7]) box(0.16, 5.2, 0.16, 0x374151, rx + ux, 2.9, READY.z0 + 1.8 + uz, scene);
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
    const wander = (area, start, floor, model, raise) => {
      const f = model || forklift();
      f.position.set(start[0], floor == null ? 0.3 : FLOOR_Y[floor] + SLAB + (raise || 0), start[1]);
      wanderers.push({ f, area, floor, target: null, wait: Math.random() * 2, busy: false });
      return wanderers[wanderers.length - 1];
    };
    const planArea = (pl, a, b, c, d) => ({ x0: wx(pl, a), z0: wz(pl, b), x1: wx(pl, c), z1: wz(pl, d) });
    // Production floors: three yellow hand lifters (hand pallet trucks) on
    // each floor, each with its operator, moving along the clear aisles.
    const handLifter = (load) => {
      const g = new THREE.Group();                        // forks point forward (+z)
      for (const x of [-0.33, 0.33]) box(0.3, 0.1, 1.5, 0xfacc15, x, 0.1, 0.55, g);
      box(0.95, 0.4, 0.4, 0xfacc15, 0, 0.3, -0.35, g);
      cyl(0.1, 0.1, 0.5, 0xeab308, 0, 0.7, -0.38, g, 8);
      const handle = box(0.07, 1.1, 0.07, 0x111827, 0, 1.15, -0.62, g); handle.rotation.x = -0.35;
      box(0.45, 0.07, 0.07, 0x111827, 0, 1.66, -0.82, g);
      for (const x of [-0.3, 0.3]) { const w = cyl(0.12, 0.12, 0.1, 0x111827, x, 0.12, -0.35, g, 10); w.rotation.z = Math.PI / 2; }
      if (load) for (const x of [-0.3, 0.3]) box(0.55, 0.5, 1.2, 0xc9a26b, x, 0.42, 0.6, g);
      person(0, -1.25, 0, g);
      g.traverse(o => { if (o.isMesh) o.castShadow = true; });
      scene.add(g);
      return g;
    };
    const LIFTER_AISLES = [               // [plan, floor, step height, aisles]
      [PLAN_B, 0, 0, [[470, 300, 640, 560], [640, 610, 1000, 690], [690, 740, 830, 1100]]],
      [PLAN_G, 1, RAISE, [[360, 180, 500, 700], [530, 370, 860, 520]]],
      [PLAN_P, 1, 0, [[215, 262, 380, 400]]],
      [PLAN_G, 2, 0, [[360, 180, 500, 700], [530, 370, 860, 520], [890, 365, 1040, 700]]],
    ];
    LIFTER_AISLES.forEach(([pl, floor, raise, areas]) => areas.forEach((r, k) => {
      const a = planArea(pl, r[0], r[1], r[2], r[3]);
      const w = wander(a, [(a.x0 + a.x1) / 2, (a.z0 + a.z1) / 2], floor, handLifter((k + floor) % 2 === 0), raise);
      w.speed = 1.7;
    }));
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
          const to = new THREE.Vector3(s.x, (s.y || 0) + (s.floor == null ? 0.3 : SLAB) + s.lift * 1.6, s.z);
          p.floor = s.floor;
          p.g.visible = floorFocus == null || p.floor == null || p.floor === floorFocus;
          if (instant || !p.placed) { p.g.position.copy(to); p.placed = true; p.move = null; return; }
          if (p.g.position.distanceTo(to) < 0.01) return;
          const from = p.g.position.clone(), dist = from.distanceTo(to);
          const arc = (from.x < 4) !== (to.x < 4) || Math.abs(from.z - to.z) > 9 || Math.abs(from.y - to.y) > 1 ? 9 : Math.min(1.2, 0.2 + dist * 0.08);
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
    // A floor view shows only that floor (floor: index).
    const BX = BLD.x0 + BLD.w / 2, BZ = BLD.z0 + BLD.d / 2;
    const VIEWS = {
      overview: { target: [-10, 1, 0], az: 0.32, el: 0.62, dist: 150 },
      basement: { target: [BX, FLOOR_Y[0], BZ], az: 0.22, el: 1.0, dist: 112, floor: 0 },
      ground: { target: [BX, FLOOR_Y[1], BZ], az: 0.22, el: 1.0, dist: 112, floor: 1 },
      first: { target: [BX, FLOOR_Y[2], BZ], az: 0.22, el: 1.0, dist: 112, floor: 2 },
      roof: { target: [BX, FLOOR_Y[3], BZ - 6], az: 0.3, el: 0.8, dist: 100, floor: 3 },
      ready: { target: [24, 0, 4], az: 0.42, el: 0.72, dist: 60 },
    };
    const want = { target: cam.target.clone(), az: cam.az, el: cam.el, dist: cam.dist };
    // Phones held upright: turn the yard side-on so the row of buildings runs
    // up the screen instead of off both edges.
    const TALL_VIEWS = {
      overview: { target: [-8, 1, -2], az: 1.25, el: 0.9, dist: 235 },
      basement: { target: [BX, FLOOR_Y[0], BZ], az: 1.2, el: 1.0, dist: 125, floor: 0 },
      ground: { target: [BX, FLOOR_Y[1], BZ], az: 1.2, el: 1.0, dist: 125, floor: 1 },
      first: { target: [BX, FLOOR_Y[2], BZ], az: 1.2, el: 1.0, dist: 125, floor: 2 },
      roof: { target: [BX, FLOOR_Y[3], BZ - 6], az: 1.2, el: 0.9, dist: 125, floor: 3 },
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
      setFloorFocus(v.floor == null ? null : v.floor);
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
    ui.views.innerHTML = '<button data-v="overview">Overview</button><button data-v="basement">Basement</button><button data-v="ground">Ground</button><button data-v="first">1st Floor</button><button data-v="roof">Roof</button><button data-v="ready">Ready Stock</button>';
    ui.bar = document.createElement('div'); ui.bar.className = 'saa-bar';
    ui.msg = document.createElement('div'); ui.msg.className = 'saa-empty'; ui.msg.style.display = 'none'; ui.msg.style.pointerEvents = 'none';
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
        // Zoom to the pallet; on a production floor show just that floor.
        if (p) {
          want.target.set(p.g.position.x, p.floor == null ? 0 : FLOOR_Y[p.floor], p.g.position.z); want.dist = fitDist(34); want.el = 0.8; viewName = 'focus';
          setFloorFocus(p.floor == null ? null : p.floor);
          ui.views.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        }
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
      const shown = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
      const hit = ray.intersectObjects(palletRoot.children, true).find(h => (h.object.userData.jobId != null || h.object.isSprite) && shown(h.object));
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
      // Lift, floor names, people.
      liftCar.position.y = FLOOR_Y[0] + 1.4 + (FLOOR_Y[2] - FLOOR_Y[0]) * (0.5 - 0.5 * Math.cos(clock * 0.3));
      if (floorGroups[0].visible) for (const f of animated) f(dt, clock);
      for (const f of liftAnims) f(clock);
      for (const t of floorTags) scaleTag(t);
      people.forEach((pp, i) => { if (!pp.parent || pp.parent.type !== 'Scene') return; pp.position.y = 0.3 + Math.abs(Math.sin(clock * 2 + i)) * 0.05; });
      // Forklifts wandering about.
      for (const w of wanderers) {
        if (w.busy) continue;
        if (w.wait > 0) { w.wait -= dt; continue; }
        if (!w.target) w.target = [w.area.x0 + Math.random() * (w.area.x1 - w.area.x0), w.area.z0 + Math.random() * (w.area.z1 - w.area.z0)];
        if (driveTo(w.f, w.target[0], w.target[1], dt, w.speed || 3.2)) { w.target = null; w.wait = 1 + Math.random() * 2.5; }
        const forks = w.f.userData.forks; if (forks) forks.position.y = Math.max(0, Math.sin(clock * 0.9 + w.area.x0) * 0.5);
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
      ui.msg.style.display = next.length ? 'none' : 'block';
      ui.msg.textContent = 'No orders to show for this company yet.';
      renderStats(); renderBar();
    };
    applyJobs(opts.jobs, true);
    // Replay today's deliveries once, so the trucks' trips are seen.
    if (!reduceMotion) for (const s of todaysShipments(jobs).slice(0, 3)) enqueueDeparture(s.job, s.cartons, null);
    resize(); setView('overview', true);

    return {
      company: opts.company,
      _debug: { cam, want, camera, VIEWS, setView, scene },
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

  window.SAAnimation = { mount, _test: { jobPlace, diffJobs, todaysShipments, slotFor, dayOf, shippedCartons, isBlocked, FLOORS, FLOOR_Y, RAISE, PLAN_P, TOWERS } };
})();
