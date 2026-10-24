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
  const CREAM = 0xefe4cc, CREAM_DARK = 0xd9c9a5;   // the buildings' walls (owner, 2026-10-22)
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
  // Shipper cartons still in Ready Stock (owner, 2026-10-24): the Carton
  // Shipper count written on the job, less the share of the Ready Qty shipped.
  function readyCartonsLeft(j) {
    const S = num(j && j._shipperCartons), R = num(j && j._readyQty), D = shippedCartons(j);
    if (!(S > 0)) return 0;
    return R > 0 ? Math.max(0, Math.round(S * Math.max(0, R - D) / R)) : S;
  }
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
  // Split level (owner's marked heights, 2026-10-24): the hall block stands
  // half a floor (RAISE) above the office block on every floor. FLOOR_Y are
  // the hall block's levels - basement, ground, 1st floor, roof; the office
  // block's ground floor is the street (FLOOR_Y[1] - RAISE) and its 1st
  // floor / open area sit RAISE below the hall's.
  const RAISE = 6;                              // the hall block above the office block ("a little more", owner 2026-10-24)
  const FLOOR_Y = [-5, RAISE, 11 + RAISE, 22 + RAISE];
  // The open area over the offices sits just OPEN_STEP above the hall's 1st
  // floor - a small ramp up to it (owner, 2026-10-24).
  const OPEN_STEP = 1.2;
  const OPEN_RAISE = FLOOR_Y[2] + OPEN_STEP - FLOOR_Y[3];   // the 2nd floor's open area, relative to the roof
  const OFFICE_RAISE = -RAISE;                  // the 1st floor's offices, half a floor below its hall side
  const FRONT_RAISE = -RAISE;                   // the ground floor's office block, on the street
  const BASE_RAISE = 1.0;                       // basement Hall-01 (+ Machine Area, Work Shop) above Hall-02
  // Is this basement plan point in the raised back part (Hall-01 side)?
  const basementRaise = (px, py) => (py < 703 || px < 500) ? BASE_RAISE : 0;
  const FLOOR_NAMES = ['BASEMENT', 'GROUND FLOOR', '1ST FLOOR', '2ND FLOOR'];
  const PLAN_G = { px0: 158, py0: 158, sx: 20, sz: 20 };                             // evacuation plan (upper floors)
  const PLAN_B = { px0: 157, py0: 60, sx: 20 * 865 / 900, sz: 20 * 1078 / 1115 };     // basement drawing
  // The ground floor's real front part (the owner's ground-floor plan),
  // fitted into the evacuation plan's lower block (x 512-1058, y 822-1272).
  const PLAN_P = { px0: -391.2, py0: -725.5, sx: 22.1, sz: 22.0 };
  const wx = (pl, px) => BLD.x0 + (px - pl.px0) / pl.sx;
  const wz = (pl, py) => BLD.z0 + (py - pl.py0) / pl.sz;
  const OUTLINE_G = [[158, 158], [1058, 158], [1058, 1272], [512, 1272], [512, 940], [212, 940], [212, 718], [158, 718]];
  const LIFT_G = [343, 718, 410, 780];
  // The lift the hand lifters ride between floors: its centre, and a spot in front of its doors.
  const LIFT_X = -54 + ((LIFT_G[0] + LIFT_G[2]) / 2 - 158) / 20, LIFT_Z = -32 + ((LIFT_G[1] + LIFT_G[3]) / 2 - 158) / 20, LIFT_DOOR_Z = -32 + (LIFT_G[1] - 158) / 20 - 1.6;
  // Stair towers (owner, 2026-10-22): switchback stairs that really climb
  // the gap between floors. The core's goes basement -> ground, then one
  // stairwell ground -> 1st floor -> roof in the same place; the Entrance
  // Lobby's goes down to Hall-02.
  const TOWER_CORE = [218, 775, 276, 905];              // evacuation-plan pixels
  // The floor openings over it leave the back strip (where the upper
  // stairs start and arrive) as floor.
  const TOWER_LOBBY = [22, 392, 172, 495];              // ground-floor-plan pixels
  // Rooms, halls, Breaking Area and the hall with the ablution row.
  // The owner's white marks (2026-10-24) took out the hall's wall by the
  // rooms column, the top rooms' and store's walls, the walls round the
  // Breaking Area and the Sorting / Pasting halls, the wall over the
  // ablution hall and the kitchen's short wall: one open hall now.
  const UPPER_WALLS = [
    [345, 158, 345, 533], [158, 253, 345, 253], [158, 348, 345, 348], [158, 437, 345, 437], [158, 533, 345, 533],
    // The owner's white lines (2026-10-24): a room walled on three sides -
    // two walls from the hall's edge and the one joining them by the sorting area.
    [842, 713, 842, 822], [938, 713, 938, 822], [842, 713, 938, 713],
    [600, 822, 1058, 822], [512, 718, 512, 822],
    [158, 718, 343, 718], [410, 718, 512, 718]];
  const UPPER_LABELS = [['ROOM', 250, 205, 0.8], ['ROOM', 250, 300, 0.8], ['ROOM', 250, 390, 0.8], ['ROOM', 250, 485, 0.8], ['KITCHEN', 222, 625, 0.7],
    ['HALL', 430, 370, 1.1], ['HALL', 420, 615, 1.1], ['ROOM', 605, 250, 0.9], ['ROOM', 785, 250, 0.9], ['STORE', 965, 250, 0.9], ['HALL', 695, 440, 1.1],
    ['HALL', 965, 540, 1.1], ['BREAKING AREA', 720, 620, 0.9], ['HALL', 735, 770, 1.0]];
  // The ground floor's back part has lost most of those walls (owner's white
  // marks, 2026-10-22): the rooms column is open to the hall but for its top
  // room's and the kitchen's walls, and the top rooms, the Breaking Area and
  // the hall round it are one open floor.
  // Second pass (owner, 2026-10-22): the top room's wall, the stub at the
  // top of the hall, the wall left of the lift and the ablution walls went
  // too, and a wall from the lift's corner down to the kitchen's line closes
  // the kitchen side off from the hall.
  const GROUND_WALLS = [
    [343, 533, 343, 718],   // the kitchen's wall along the coating machines is gone (owner, 2026-10-24)
    [512, 630, 512, 718], [512, 822, 1058, 822], [512, 718, 512, 822], [158, 718, 343, 718]];
  const GROUND_LABELS = [['KITCHEN', 222, 625, 0.7], ['HALL', 430, 370, 1.1], ['HALL', 420, 615, 1.1], ['HALL', 695, 440, 1.1],
    ['HALL', 735, 790, 1.0], ['ABLUTION AREA', 945, 790, 0.7]];
  // Hall-01's pillars (basement plan pixels). The ground floor's hall stands
  // on the same ones (owner, 2026-10-22), so they line up floor to floor.
  const HALL1_PILLARS = [[332, 242], [504, 242], [677, 242], [849, 242], [332, 421], [504, 421], [677, 421], [849, 421], [504, 600], [677, 600], [849, 600]];
  const GROUND_PILLARS = HALL1_PILLARS.map(([bx, by]) => [158 + (wx(PLAN_B, bx) - BLD.x0) * PLAN_G.sx, 158 + (wz(PLAN_B, by) - BLD.z0) * PLAN_G.sz]);
  const FLOORS = [
    // Basement, split-level (owner, 2026-10-22): Hall-01 with the Machine
    // Area and Work Shop is a step up (BASE_RAISE); Hall-02 at the front is
    // the low part, and the ramp in its top-left corner climbs to Hall-01.
    { parts: [
      { plan: PLAN_B, raise: BASE_RAISE,
        outline: [[157, 60], [1022, 60], [1022, 703], [500, 703], [500, 815], [207, 815], [207, 600], [157, 600]], ext: [0, 1, 4, 5, 6, 7],
        // The Machine Area is open to Hall-01 (no wall along its top) and the
        // lift's hall side is its doors (owner, 2026-10-21).
        walls: [[330, 597, 330, 815], [400, 597, 400, 710], [400, 710, 500, 710], [330, 668, 400, 668]],
        rails: [[617, 703, 1022, 703]],          // guard rail along the step down to Hall-02 (the ramp end stays open)
        columns: HALL1_PILLARS,
        stairs: [[1025, 258, 1055, 410]],        // outside steps; the stairs to the ground floor are the stair towers
        lift: [333, 597, 397, 665],
        labels: [['HALL-01', 585, 320, 1.4], ['MACHINE AREA', 265, 708, 0.8], ['WORK SHOP', 415, 765, 0.8]] },
      { plan: PLAN_B, outline: [[500, 703], [1022, 703], [1022, 1138], [500, 1138]], ext: [1, 2, 3],
        ramp: [515, 703, 617, 775, 'back', BASE_RAISE],   // hand-lifter ramp (owner's mark) up to Hall-01
        columns: [[677, 707], [849, 707], [677, 815], [849, 815], [677, 922], [849, 922], [677, 1030], [849, 1030]],
        labels: [['HALL-02', 755, 870, 1.4]] }] },
    { parts: [
      // Back part, a few steps up: rooms, halls, Breaking Area, ablution hall.
      { plan: PLAN_G, outline: [[158, 158], [1058, 158], [1058, 822], [512, 822], [512, 718], [158, 718]], ext: [0, 1, 5],
        rails: [[512, 822, 638, 822], [690, 822, 1058, 822]],   // the hall's edge over the office block; open where the lobby stairs arrive
        // From the street up to this floor (owner's purple marks, 2026-10-24); the
        // front one over the office block has four windows (between the green marks).
        plinth: [[158, 158, 1058, 158], [1058, 158, 1058, 822], [158, 158, 158, 718],
          [512, 822, 1058, 822, [[605, 655], [723, 773], [873, 923], [1007, 1050]]]],
        walls: GROUND_WALLS, labels: GROUND_LABELS, columns: GROUND_PILLARS },
      // Stairs + lift core, level with the hall beside it (owner): the U
      // stairs on up to the 1st floor (the basement's L flight arrives here), the lift, and
      // behind it the loading area with its roller-shutter gate - a few
      // steps outside the gate lead down to the street.
      { plan: PLAN_G, outline: [[212, 718], [512, 718], [512, 940], [212, 940]], ext: [3],
        walls: [[212, 940, 354, 940], [505, 940, 512, 940]],   // open to the loading area, and the front's third bay open (owner, 2026-10-22)
        holes: [[218, 801, 276, 905, 'LB', [[276, 801, 276, 878]]]], lift: LIFT_G, loading: [416, 784, 508, 936],   // no roller-shutter door any more; the steps outside still lead up (owner, 2026-10-22)
        stairs: [[420, 942, 505, 978, 1, RAISE + 0.35 - 0.12, 'z', -RAISE + 0.12, 'steel']],   // steel stairs (owner, 2026-10-24)
        plinth: [[212, 940, 420, 940], [212, 718, 212, 940], [420, 942, 420, 978]] },   // the core's front left of the loading stairs, its side, and the wall beside those stairs
      // Front part on the street (the owner's ground-floor plan).
      { plan: PLAN_P, raise: FRONT_RAISE, outline: [[0, 5], [603, 5], [603, 500], [0, 500]], ext: [1, 3],
        walls: [
          [135, 5, 135, 125], [135, 125, 150, 125], [185, 125, 205, 125], [205, 125, 205, 250], [5, 250, 205, 250],
          [200, 250, 200, 378], [5, 378, 200, 378],
          [205, 245, 270, 245], [330, 245, 392, 245],
          [392, 125, 603, 125], [392, 125, 392, 500], [392, 248, 603, 248], [392, 375, 550, 375], [545, 400, 545, 500],
          [0, 500, 270, 500], [330, 500, 603, 500]],
        // A few steps up to the back part beside the Production Office; the
        // Entrance Lobby's staircase goes DOWN to the basement, |_____ shaped,
        // through an opening in the floor.
        stairs: [[140, 8, 195, 48, 1, RAISE, 'z', null, 'steel']],   // steel stairs (owner, 2026-10-24)
        // Railed all round except where the stairs start (back-left corner).
        holes: [[...TOWER_LOBBY, 'LRB', [[57, 392, 172, 392]]]],
        labels: [['PRODUCTION OFFICE', 95, 175, 0.75], ['LOBBY', 300, 110, 1.0], ['PLATE MAKING', 485, 65, 0.85], ['SCANNING ROOM', 495, 185, 0.75],
          ['STORE ROOM', 100, 315, 0.85], ['ENTRANCE LOBBY', 297, 340, 0.85], ['ACCOUNT OFFICE', 475, 310, 0.7], ['DIRECTOR', 470, 445, 0.75], ['BATH', 572, 478, 0.6]] },
    ] },
    // 1st floor: the rooms / halls / ablution row and the stairs + lift core
    // (the loading area below is open - no floor over it), and over the
    // ground floor's front part the OFFICES - the evacuation plan's lower
    // block: Dining Room, Kitchen, Director Offices, Finance, Washrooms,
    // Lobby, Corridor, Design Section and the Terrace (owner, 2026-10-22).
    { parts: [
      { plan: PLAN_G,
        outline: [[158, 158], [1058, 158], [1058, 822], [512, 822], [512, 718], [412, 718], [412, 940], [212, 940], [212, 718], [158, 718]],
        ext: [0, 1, 3, 4, 5, 6, 7, 8, 9], street: 6,   // the hall / offices line is the inner wall below; the core's front is the side wing's façade
        walls: UPPER_WALLS, holes: [[218, 801, 276, 905, 'LRB']], lift: LIFT_G, labels: UPPER_LABELS,
        // Ramp from the hall up to the 2nd floor's open area over the offices (owner, 2026-10-24).
        ramp: [518, 742, 598, 822, 'front', OPEN_STEP] },
      // The offices are a few steps below the 1st floor's hall side (owner, 2026-10-24).
      { plan: PLAN_G, raise: OFFICE_RAISE, curtainTop: FLOOR_Y[3] + OPEN_RAISE, outline: [[512, 822], [1058, 822], [1058, 1272], [512, 1272]], ext: [1, 2, 3], street: 2,
        walls: [[560, 822, 560, 938], [512, 938, 1058, 938], [697, 938, 697, 1272], [512, 1050, 697, 1050], [697, 1093, 875, 1093], [697, 1160, 875, 1160],
          [875, 938, 875, 1272], [920, 938, 920, 1272], [920, 1045, 1058, 1045]],
        terrace: [668, 1272, 902, 1345],   // no stairs up to the open area - the 1st floor's ramp goes there (owner, 2026-10-24)
        labels: [['DINING ROOM', 750, 880, 0.9], ['KITCHEN', 975, 885, 0.7], ['BATH', 537, 880, 0.55], ['DIRECTOR OFFICE', 605, 995, 0.7], ['FINANCE SECTION', 785, 1010, 0.7],
          ['WASHROOMS', 985, 995, 0.7], ['LOBBY', 605, 1120, 0.9], ['CORRIDOR', 785, 1125, 0.7], ['DIRECTOR OFFICE', 785, 1215, 0.7], ['DESIGN SECTION', 985, 1160, 0.7], ['TERRACE', 785, 1308, 0.7]] },
    ] },
    // 2nd floor: the roof over the back block (open, solar panels on a steel
    // frame; the stairs come up here) and, over the offices, the OPEN AREA -
    // a little higher, with solar panels over it (owner, 2026-10-22).
    { parts: [
      { plan: PLAN_G, parapet: true,
        outline: [[158, 158], [1058, 158], [1058, 822], [512, 822], [512, 718], [412, 718], [412, 940], [212, 940], [212, 718], [158, 718]],
        holes: [[218, 801, 276, 905, 'LRB']],
        solar: [170, 170, 1046, 760], labels: [['SOLAR PANELS', 610, 440, 1.4]] },
      { plan: PLAN_G, raise: OPEN_RAISE, parapet: true, alsoOn: [2], outline: [[512, 822], [1058, 822], [1058, 1272], [512, 1272]], ext: [1, 2, 3],   // seen from the 1st floor too - its ramp lands here
        solar: [522, 832, 1048, 1262], labels: [['OPEN AREA', 785, 1050, 1.3]] },
    ] },
  ];
  // The stair towers: plan rect, the floor heights they join, the axis the
  // flights run along, and which lane the first (lowest) flight climbs.
  // Two flights per tower with one landing between them (owner, 2026-10-22).
  // Core (owner, 2026-10-22): the basement one runs against the outer wall -
  // from the back of the basement forward, a corner landing, a short flight
  // across the front - and finishes at the ground floor. Then one stairwell
  // in the same place climbs ground -> 1st floor -> roof: each storey starts
  // at the back-left (owner's dot), forward along the wall side, a landing
  // at the front, back up the other side. The lobby one: |_____ from its
  // back-left.
  const FLOOR_TOP = 0.35;                         // slab thickness: a floor's walking level above its y
  const TOWERS = [
    { name: 'basement-ground', plan: PLAN_G, r: TOWER_CORE, from: FLOOR_Y[0] + BASE_RAISE + FLOOR_TOP, to: FLOOR_Y[1] + FLOOR_TOP, shape: 'L', longAxis: 'z', lane: 'lo', bottom: 'lo' },
    { name: 'ground-first', plan: PLAN_G, r: TOWER_CORE, from: FLOOR_Y[1] + FLOOR_TOP, to: FLOOR_Y[2] + FLOOR_TOP, axis: 'z', flights: 2, startLane: 'left' },
    { name: 'first-roof', plan: PLAN_G, r: TOWER_CORE, from: FLOOR_Y[2] + FLOOR_TOP, to: FLOOR_Y[3] + FLOOR_TOP, axis: 'z', flights: 2, startLane: 'left' },
    { name: 'lobby-basement', plan: PLAN_P, r: TOWER_LOBBY, from: FLOOR_Y[0] + FLOOR_TOP, to: FLOOR_Y[1] + FRONT_RAISE + FLOOR_TOP, shape: 'L', longAxis: 'x', lane: 'hi', bottom: 'hi' },
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
    { kind: 'press', stage: 1, units: 5, len: 14.2, face: 'left', at: [811, 138], pallets: [[-4.5, 2.7], [-1.9, 2.7]] },
    { kind: 'press', stage: 1, units: 5, len: 12.8, face: 'left', at: [802, 298], pallets: [[-4.5, 2.7], [-1.9, 2.7]] },
    { kind: 'press', stage: 1, units: 5, len: 12.8, face: 'left', at: [797, 447], pallets: [[-4.5, -2.7], [-1.9, -2.7]] },
    // 4 and 7 (Hall-02's right side) moved down to the owner's lines.
    { kind: 'press', stage: 1, units: 2, face: 'left', at: [950, 903], pallets: [[-1.4, 2.7], [1.0, 2.7]] },
    // 5-6 by Hall-02's left wall (owner's blue dots).
    { kind: 'press', stage: 1, units: 1, face: 'left', at: [573, 880], pallets: [[-1.3, -2.7], [1.3, -2.7]] },
    { kind: 'press', stage: 1, units: 1, face: 'right', at: [581, 971], pallets: [[4.3, -0.8], [4.3, 1.5]] },
    { kind: 'press', stage: 1, units: 1, face: 'right', at: [950, 1046], pallets: [[-1.4, 2.7], [0.8, 2.7]] },
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
    // Paper cutting machines (guillotines) along the line between Hall-01
    // and Hall-02 - two big, one small in the middle (owner's lines), their
    // front (table, operator) toward Hall-01 (owner). Not a
    // job stage in the app, so no pallets wait at them.
    { kind: 'cutter', stage: null, len: 3.9, dep: 2.4, face: 'up', at: [785, 685], pallets: [] },
    { kind: 'cutter', stage: null, len: 2.8, dep: 2.0, face: 'up', at: [871, 680], pallets: [] },
    { kind: 'cutter', stage: null, len: 3.5, dep: 2.4, face: 'up', at: [964, 685], pallets: [] },
    // Folding machine in Hall-02 by the middle pillars, running front-to-back
    // (owner's blue mark). Not a job stage either.
    { kind: 'folder', stage: null, len: 3.0, dep: 1.3, face: 'right', at: [706, 759], pallets: [] },
  ];
  // Racks for the small ink cans in Hall-02, either side of a walkway
  // (owner's green lines): plan line from -> to, the rack's back on the side
  // away from the walkway.
  const INK_RACKS = [
    { from: [859, 744], to: [994, 744], back: 'up' },
    { from: [868, 809], to: [995, 809], back: 'down' },
  ];
  // Ground floor machines (owner's marks, 2026-10-22), evacuation-plan
  // pixels: 4 coating machines in the left column (the app has 5, one is
  // blocked), the 2 inspection machines across the open hall, the manual
  // lamination machine at the left of the lower hall, and the CTP with its
  // plate processor in the Scanning Room by Plate Making. Coatings jobs'
  // pallets wait beside the coating machines.
  const groundRaise = py => (py < 822 ? 0 : FRONT_RAISE);
  const GROUND_MACHINES = [
    { kind: 'coater', stage: 2, floor: 1, len: 5.2, face: 'right', at: [250, 220], pallets: [[3.9, 0], [6.3, 0]], label: [0, 1.35] },
    { kind: 'coater', stage: 2, floor: 1, len: 5.2, face: 'right', at: [250, 329], pallets: [[3.9, -1.0], [6.3, -1.0]], label: [0, 1.4] },
    { kind: 'coater', stage: 2, floor: 1, len: 5.2, face: 'right', at: [250, 410], pallets: [[3.9, 0], [6.3, 0]], label: [0, 1.4] },
    // The 4th is the same size as the other three and in line with them (owner, 2026-10-24).
    { kind: 'coater', stage: 2, floor: 1, len: 5.2, face: 'right', at: [250, 492], pallets: [[3.9, 0], [6.3, 0]], label: [0, 1.4] },
    { kind: 'inspection', stage: null, floor: 1, len: 12, face: 'right', at: [895, 570], pallets: [], label: [-4.2, -1.75] },
    { kind: 'inspection', stage: null, floor: 1, len: 12, face: 'right', at: [894, 650], pallets: [], label: [0, 1.6] },
    { kind: 'laminator', stage: null, floor: 1, len: 2.9, face: 'down', at: [563, 763], pallets: [], label: [1.7, 0] },
    { kind: 'ctp', stage: null, floor: 1, len: 3.4, face: 'left', at: [920, 967], pallets: [], label: [0, 2.6] },
    { kind: 'processor', stage: null, floor: 1, len: 1.8, face: 'down', at: [1003, 1008], pallets: [] },
  ];
  // 1st floor machines (owner's marks, 2026-10-24): the 3 folder gluers
  // (Pasting) across the hall, the thermal lamination machine by the
  // washrooms. Pasting jobs' pallets wait at the gluers' delivery ends.
  const FIRST_MACHINES = [
    { kind: 'gluer', stage: 5, floor: 2, len: 16, face: 'right', at: [794, 221], pallets: [[9.6, 0]], label: [0, 1.6] },
    { kind: 'gluer', stage: 5, floor: 2, len: 16, face: 'right', at: [794, 331], pallets: [[9.6, 0]], label: [0, 1.6] },
    { kind: 'gluer', stage: 5, floor: 2, len: 16, face: 'right', at: [794, 435], pallets: [[9.6, 0]], label: [0, 1.6] },
    { kind: 'laminator', stage: null, floor: 2, len: 3.4, face: 'down', at: [1010, 785], pallets: [], label: [-2.6, 0], name: 'THERMAL LAMINATION' },
  ];
  // Tables with operators round them (owner's marks, 2026-10-24): plan line from -> to.
  const WORK_TABLES = [
    { name: 'BREAKING', from: [645, 800], to: [715, 800] },
    { name: 'SORTING', from: [845, 670], to: [945, 670] },   // the owner's green area (2026-10-24)
  ];
  // The app's names for the machines (the operators' Machine field) and the
  // station whose people work each one (owner, 2026-10-24), in the order of
  // MACHINES / GROUND_MACHINES / FIRST_MACHINES. Presses 1-3 five-unit,
  // 4 two-unit, 5-7 one-unit; die cutters 1-2 big, 3-7 as numbered.
  const MACHINE_STATIONS = {
    basement: [['CD-102', 'CD-102'], ['SM74-1', 'SM74 CP-2000'], ['SM74-2', 'SM74 CP-1998'], ['SORMZ-1', 'SORM Z'], ['SORM-1', 'SORM'], ['GTOZ-52', 'GTOZ-52'], ['SM_52', 'SM_52'],
      ['BOBST102', 'DIE CUTTING 102'], ['1060 CHINA', 'DIE CUTTING 1060 CHINA'], ['CYLINDERDIE-3', 'CYLINDER DIE CUTTING 3'], ['CYLINDERDIE-4', 'CYLINDER DIE CUTTING 4'],
      ['KIRMADIE-5', 'KIRMA DIE CUTTING CHINA'], ['KIRMADIE-6', 'KIRMA DIE CUTTING 27X34'], ['KIRMADIE-7', 'KIRMA DIE CUTTING 22x28'],
      ['CUTTING 1', 'POLAR PAPER CUTTING 1'], [null, 'PAPER CUTTING'], ['CUTTING 2', 'POLAR PAPER CUTTING 2'], ['FOLDING', 'FOLDING MACHINE']],
    ground: [['SORMZ-2', 'SORMZ'], ['SORM-2', 'SORM'], ['COATER-2UV', 'SPOT UV COATER'], ['COATER-3SPOT UV', 'SPOT UV COATER 2'], [null, 'INSPECTION'], [null, 'INSPECTION'],
      ['MAN-LAMINATION', 'MANUAL LAMINATION'], ['CTP', 'CTP'], [null, null]],
    first: [['BOBST', 'BOBST DOMINO 110'], ['BOBST MEDIA', 'BOBST MEDIA 68-II'], ['JAGENBERG', 'JAGENBERG PASTING'], ['THERM-LAMINATION', 'THERMAL LAMINATION']],
  };
  // The owner's marked areas (2026-10-24), plan rects [x0, y0, x1, y1] per
  // floor (0 basement - presses / die; 1 ground - coaters / inspection;
  // 2 1st floor - gluers / sorting). Pallets fill them in order.
  const FLOW_ZONES = {
    issued: [[0, [407, 584, 508, 695]], [0, [616, 615, 760, 695]], [0, [935, 545, 1015, 616]], [0, [752, 731, 841, 791]],
      [1, [463, 488, 562, 560]], [1, [471, 599, 515, 684]], [1, [348, 543, 401, 636]]],
    printx: [[0, [965, 90, 1010, 470]], [0, [691, 1045, 876, 1096]], [0, [559, 1031, 625, 1093]]],
    die: [[0, [300, 315, 388, 507]], [0, [160, 70, 435, 113]], [0, [160, 246, 227, 325]], [0, [160, 478, 231, 559]]],
    emboss: [[0, [486, 70, 632, 208]], [0, [456, 309, 573, 497]]],
    coat: [[1, [336, 175, 512, 248]], [1, [341, 294, 407, 385]], [1, [461, 293, 548, 384]], [1, [162, 557, 237, 681]], [1, [279, 553, 337, 681]], [1, [596, 707, 635, 815]],
      [2, [980, 593, 1050, 720]]],
    inspect: [[1, [635, 446, 1050, 732]]],
    sort: [[2, [518, 611, 603, 713]], [2, [716, 637, 835, 792]], [2, [600, 640, 682, 760]]],
    paste: [[2, [479, 170, 581, 529]], [2, [618, 475, 1033, 559]]],
    // Ready to deliver: kept on the 1st floor (hall strip, rooms, kitchen corner);
    // once the PM ticks Mark Ready it comes down to the ground floor (owner, 2026-10-24).
    final1: [[2, [353, 181, 509, 585]], [2, [175, 175, 330, 240]], [2, [175, 265, 330, 335]], [2, [175, 360, 330, 425]], [2, [175, 450, 330, 520]], [2, [238, 647, 330, 705]]],
    final0: [[1, [592, 170, 1050, 383]]],
  };
  const ZONE_STYLE = {   // outline colour, floor label
    issued: [0xe2e8f0, '#64748b', 'ISSUED STOCK'], printx: [0x22c55e, '#15803d', 'PRINTING'], die: [0x9333ea, '#7e22ce', 'DIE CUTTING'], emboss: [0xdb2777, '#be185d', 'EMBELLISHMENT'],
    coat: [0x38bdf8, '#0369a1', 'COATING'], inspect: [0xdc2626, '#b91c1c', 'INSPECTION (NOT ACTIVE)'], sort: [0xf97316, '#c2410c', 'SORTING'], paste: [0x6b7280, '#374151', 'PASTING'],
    final1: [0x111827, '#111827', 'READY TO DELIVER'], final0: [0x111827, '#111827', 'READY - MARKED, TO SHIP'],
  };
  // The green spots beside each press (owner's dots), by press number; 4 & 7 and 5 & 6 share an area.
  const PRESS_SPOTS = [
    [[719, 213], [799, 216], [909, 222]], [[736, 368], [803, 371], [890, 375]], [[677, 523], [760, 526], [837, 529], [898, 532]],
    'R', 'L', 'L', 'R'];
  const PRESS_AREAS = { R: [936, 947, 1012, 997], L: [641, 867, 736, 1040] };
  // Which press a job is planned on (its Machine Name), by the app's names.
  const pressIndexFor = j => {
    const n = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const jm = n(String(j && j.machine || '').split(/[|+,]/)[0]);
    if (!jm) return -1;
    let best = -1, score = 0;
    MACHINE_STATIONS.basement.slice(0, 7).forEach(([st, name], i) => {
      for (const k of [n(st), n(name)]) {
        const sc = k === jm ? 3 : (k.startsWith(jm) && /^\d*$/.test(k.slice(jm.length))) ? 2 : (k.startsWith(jm) || jm.startsWith(k)) ? 1 : 0;
        if (sc > score) { score = sc; best = i; }
      }
    });
    return best;
  };
  // The PM's Mark Ready tick, still standing (a delivery after it retires it).
  const readyTicked = j => {
    const c = j && j.ready_check, t = c && Date.parse(c.at);
    if (!Number.isFinite(t)) return false;
    return !(Array.isArray(j.deliveries) && j.deliveries.some(d => d && d.at && Date.parse(d.at) > t));
  };
  // A job's zone: by stage, issued stock for 2 days, then its press.
  const zoneKeyFor = (j, place) => {
    if (place === 'wait') return 'wait';
    if (place === 'ready') return j && j.stock_group_name ? 'ready' : (readyTicked(j) ? 'final0' : 'final1');
    if (place === 0) return 'ctp';
    if (place === 1) {
      const t = Date.parse(j && j.issued_at);
      if (Number.isFinite(t) && Date.now() - t < 2 * 86400000) return 'issued';
      const pi = pressIndexFor(j);
      return pi >= 0 ? 'press:' + pi : 'printx';
    }
    return { 2: 'coat', 3: 'die', 4: 'sort', 5: 'paste' }[place] || 'printx';
  };
  // Where a machine stands: x / z in the world, the floor's height under it.
  const machinePos = m => m.floor === 2
    ? { x: wx(PLAN_G, m.at[0]), z: wz(PLAN_G, m.at[1]), y: FLOOR_Y[2], floor: 2 }
    : m.floor === 1
    ? { x: wx(PLAN_G, m.at[0]), z: wz(PLAN_G, m.at[1]), y: FLOOR_Y[1] + groundRaise(m.at[1]), floor: 1 }
    : { x: wx(PLAN_B, m.at[0]), z: wz(PLAN_B, m.at[1]), y: FLOOR_Y[0] + basementRaise(m.at[0], m.at[1]), floor: 0 };
  // A machine's front is its local +x; this turns it to face that side.
  const FACE_ROT = { right: 0, up: Math.PI / 2, left: Math.PI, down: -Math.PI / 2 };
  // Where each stage's pallets stand. Printing and Die Cutting wait beside
  // their machines; the rest use a plan rectangle - PROVISIONAL until the
  // owner places those stages too.
  const STAGE_ZONES = [
    { floor: 1, plan: PLAN_P, raise: FRONT_RAISE, r: [400, 18, 590, 118] },    // CTP         - ground floor, the Plate Making room
    { floor: 0, machines: true },                          // Printing    - beside the 7 presses
    { floor: 1, machines: true },                          // Coatings    - beside the 4 coating machines, ground floor (owner)
    { floor: 0, machines: true },                          // Die Cutting - beside the 7 die cutters
    { floor: 2, plan: PLAN_G, r: [845, 600, 960, 642] },   // Sorting     - 1st floor, beside the sorting table (owner, 2026-10-24)
    { floor: 2, machines: true },                          // Pasting     - beside the 3 folder gluers, 1st floor (owner, 2026-10-24)
  ];
  const zoneRect = i => { const z = STAGE_ZONES[i], pl = z.plan; return { floor: z.floor, raise: z.raise || 0, x0: wx(pl, z.r[0]), z0: wz(pl, z.r[1]), x1: wx(pl, z.r[2]), z1: wz(pl, z.r[3]) }; };
  // Site (owner, 2026-10-22): the Ready Stock warehouse stands left of the
  // building; the yard runs out in front to the road - an L, left empty but
  // for the car park under a red tent - with the gate at its left end.
  const SITE = { x0: -94, x1: -8, z0: -96, z1: 60 };   // ends just past the building's right side; the back strip holds the inventory store (owner)
  const READY = { x0: -92, x1: -58, z0: -42, z1: -12 };   // bigger (owner, 2026-10-24)
  const DOCKS = [-82, -74, -66];
  const DOCK_Z = READY.z1 + 4.85;          // truck centre when backed onto the dock
  const GATE = { x0: -50, x1: -40, z: SITE.z1 };
  const ROAD_Z = 70;
  const CAR_PARK = { x0: -93, x1: -76, z0: 34, z1: 56 };   // the left of the front yard (owner)
  // Inventory store (owner, 2026-10-22): behind the building. Every item on
  // hand stands on pallets - one pallet per PALLET_SHEETS, at least one - in
  // stacks of STACK, two deep, with its size on a tile above. Bleach board
  // has its own side; art card, paper, duplex, sticker... share the other,
  // grouped by type. Items run along rows from the back wall forward.
  const INV = { x0: -90, x1: -12, z0: -90, z1: -46 };   // bigger store (owner, 2026-10-24)
  const INV_SPLIT = -42, INV_DOORS = [-66, -27];
  const PALLET_SCALE = 0.7;   // job pallets in the building, smaller (owner, 2026-10-24)
  const PALLET_SHEETS = 10000, MAX_PALLETS = 48, STACK = 4, COL_W = 1.8, BAY_GAP = 1.4, ROW_PITCH = 6.4, INV_ROWS = 6, DEEP = 1.4, PALLET_H = 0.72;
  const STOCK_TYPES = {   // type -> [tile colour, paper colour]
    'bleach board': ['#2563eb', 0xf8fafc], 'art card': ['#db2777', 0xffffff], 'art paper': ['#ea580c', 0xf1f5f9], 'duplex board': ['#7c3aed', 0xd6d3d1],
    'offset paper': ['#0891b2', 0xfefce8], 'off-white': ['#a16207', 0xfef3c7], sticker: ['#ca8a04', 0xfde68a], 'local paper': ['#4b5563', 0xe5e7eb],
  };
  const STOCK_ORDER = Object.keys(STOCK_TYPES);
  const sizeArea = sz => { const m = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i.exec(String(sz || '')); return m ? m[1] * m[2] : 0; };
  // items: [{ type, size, gsm, sheets, offcut }] -> { bays, overflow }.
  function stockLayout(items) {
    const clean = (items || []).filter(i => i && +i.sheets > 0).map(i => ({
      type: String(i.type || 'other').toLowerCase().trim(), size: String(i.size || ''), gsm: String(i.gsm || ''), sheets: +i.sheets, offcut: !!i.offcut,
      brand: String(i.brand || ''), supplier: String(i.supplier || ''), perPack: +i.perPack || 0, unit: String(i.unit || ''),
      pallets: Math.min(MAX_PALLETS, Math.max(1, Math.ceil(+i.sheets / PALLET_SHEETS))),
    }));
    const rank = t => { const k = STOCK_ORDER.indexOf(t); return k < 0 ? 99 : k; };
    clean.sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type) || (a.offcut - b.offcut) || sizeArea(b.size) - sizeArea(a.size) || (parseFloat(a.gsm) || 0) - (parseFloat(b.gsm) || 0));
    const bays = []; let overflow = 0;
    for (const [x0, x1, list] of [[INV.x0 + 1, INV_SPLIT - 1, clean.filter(i => i.type === 'bleach board')], [INV_SPLIT + 1, INV.x1 - 1, clean.filter(i => i.type !== 'bleach board')]]) {
      let row = 0, x = x0;
      for (const it of list) {
        const cols = Math.ceil(it.pallets / (2 * STACK)), w = cols * COL_W + BAY_GAP;
        if (x + w > x1 + 0.01 && x > x0) { row++; x = x0; }
        if (row >= INV_ROWS) { overflow++; continue; }
        const zBack = INV.z0 + 1.6 + row * ROW_PITCH, pallets = [];
        for (let k = 0; k < it.pallets; k++) {
          const st = Math.floor(k / STACK);
          pallets.push([x + BAY_GAP / 2 + COL_W * (Math.floor(st / 2) + 0.5), (k % STACK), zBack + DEEP * ((st % 2) + 0.5)]);
        }
        const levels = Math.min(STACK, it.pallets);
        bays.push({ item: it, x0: x, x1: x + w, pallets, tile: [x + w / 2, levels, zBack + DEEP] });
        x += w;
      }
    }
    return { bays, overflow };
  }
  const inReady = v => v.x > READY.x0 - 2 && v.x < READY.x1 + 2 && v.z > READY.z0 - 2 && v.z < READY.z1 + 2;
  const WAIT = { x0: -24, x1: -13, z0: 36, z1: 48 };   // in front of the building, inside the plot

  // A pallet's spot in a flow zone (see FLOW_ZONES / zoneKeyFor).
  const floorPlan = f => f === 0 ? PLAN_B : PLAN_G;
  const floorRaise = (f, px, py) => f === 0 ? basementRaise(px, py) : f === 1 ? groundRaise(py) : 0;
  function pressSpots(pi) {
    const sp = PRESS_SPOTS[pi];
    if (Array.isArray(sp)) return sp;
    // its own spots beside it, then alternate cells of the area it shares
    const m = MACHINES[pi], own = (m.pallets || []).map(([dx, dz]) => [m.at[0] + dx * PLAN_B.sx, m.at[1] + dz * PLAN_B.sz]);
    const r = PRESS_AREAS[sp], cells = [];
    for (let y = r[1] + 22; y <= r[3] - 18; y += 44) for (let x = r[0] + 24; x <= r[2] - 20; x += 50) cells.push([x, y]);
    const mates = PRESS_SPOTS.map((v, i) => v === sp ? i : -1).filter(i => i >= 0), me = mates.indexOf(pi);
    return own.concat(cells.filter((_, i) => i % mates.length === me));
  }
  function zoneSlot(key, k) {
    if (key === 'wait' || key === 'ready') return slotFor(key, k);
    if (key === 'ctp') return slotFor(0, k);
    if (key.startsWith('press:')) {
      const pt = pressSpots(+key.slice(6))[k] || pressSpots(+key.slice(6))[0];
      return { x: wx(PLAN_B, pt[0]), z: wz(PLAN_B, pt[1]), lift: 0, y: FLOOR_Y[0] + basementRaise(pt[0], pt[1]), floor: 0 };
    }
    const zones = FLOW_ZONES[key] || FLOW_ZONES.printx;
    const caps = zones.map(([f, r]) => { const pl = floorPlan(f), w = (r[2] - r[0]) / pl.sx, d = (r[3] - r[1]) / pl.sz; return [Math.max(1, Math.floor((w - 0.2) / 2.6)), Math.max(1, Math.floor((d - 0.2) / 2.3))]; });
    const total = caps.reduce((a, [c, rr]) => a + c * rr, 0), layer = Math.floor(k / total);
    let i = k % total, zi = 0;
    while (i >= caps[zi][0] * caps[zi][1]) { i -= caps[zi][0] * caps[zi][1]; zi++; }
    const [f, r] = zones[zi], pl = floorPlan(f), [cols, rows] = caps[zi];
    const x0 = wx(pl, r[0]), z0 = wz(pl, r[1]), x1 = wx(pl, r[2]), z1 = wz(pl, r[3]);
    const col = i % cols, row = Math.floor(i / cols);
    const x = x0 + (x1 - x0) * (col + 0.5) / cols, z = z0 + (z1 - z0) * (row + 0.5) / rows;
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return { x, z, lift: layer, y: FLOOR_Y[f] + floorRaise(f, cx, cy), floor: f };
  }
  function slotFor(place, k) {
    if (place === 'ready') {
      const col = k % 8, row = Math.floor(k / 8) % 6, layer = Math.floor(k / 48);
      return { x: READY.x0 + 3.2 + col * 3.9, z: READY.z0 + 3.6 + row * 3.8, lift: layer, y: 0 };
    }
    if (place === 'wait') {
      const col = k % 3, row = Math.floor(k / 3) % 3, layer = Math.floor(k / 9);
      return { x: WAIT.x0 + 2 + col * 3.5, z: WAIT.z0 + 2.2 + row * 3.8, lift: layer, y: 0 };
    }
    if (STAGE_ZONES[place].machines) {
      // Spread across the stage's machines first, then their second spot,
      // then stack a layer up.
      const ms = MACHINES.concat(GROUND_MACHINES, FIRST_MACHINES).filter(m => m.stage === place);
      const spots = [];
      for (let s = 0; s < 3; s++) ms.forEach(m => { if (m.pallets[s]) spots.push([m, m.pallets[s]]); });
      const [m, off] = spots[k % spots.length], at = machinePos(m);
      return { x: at.x + off[0], z: at.z + off[1], lift: Math.floor(k / spots.length), y: at.y, floor: at.floor };
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
  /* Beside the view, under the date (owner, 2026-10-24). */
  .saa-top.saa-side { position: fixed; left: auto; right: 14px; flex-direction: column; align-items: stretch; gap: 10px; z-index: 39; pointer-events: auto; }
  .saa-side .saa-stats { flex-direction: column; flex-wrap: nowrap; gap: 6px; }
  .saa-side .saa-card { min-width: 0; padding: 6px 10px; }
  .saa-side .saa-views { flex-direction: column; gap: 5px; }
  .saa-side .saa-views button { text-align: left; padding: 8px 12px; font-size: 13px; }
  /* A store item's card, popped up over the view. */
  .saa-pop { position: absolute; transform: translate(-50%, -100%); min-width: 270px; max-width: 340px; background: #fff; border: 3px solid var(--tone, #2563eb); border-radius: 14px; box-shadow: 0 12px 32px rgba(15,23,42,.28); overflow: hidden; pointer-events: auto; z-index: 6; animation: saaPop .18s ease-out; }
  @keyframes saaPop { from { transform: translate(-50%, -100%) scale(.6); opacity: 0; } to { transform: translate(-50%, -100%) scale(1); opacity: 1; } }
  .saa-pop-h { background: var(--tone, #2563eb); color: #fff; font: 800 13px/1 inherit; font-family: inherit; letter-spacing: .04em; padding: 8px 12px; display: flex; align-items: center; gap: 8px; }
  .saa-pop-h .off { margin-left: auto; background: #dc2626; padding: 2px 7px; border-radius: 999px; font-size: 11px; }
  .saa-pop-h button { margin-left: 6px; background: rgba(255,255,255,.2); border: 0; color: #fff; width: 22px; height: 22px; border-radius: 6px; cursor: pointer; font-size: 15px; line-height: 1; }
  .saa-pop-b { padding: 10px 14px 12px; color: #0f172a; }
  .saa-pop-size { display: flex; align-items: baseline; gap: 10px; }
  .saa-pop-size b { font-size: 30px; font-weight: 900; }
  .saa-pop-size span { font-size: 17px; font-weight: 800; color: #334155; }
  .saa-pop-row { display: flex; gap: 10px; font-size: 13px; margin-top: 6px; }
  .saa-pop-row i { font-style: normal; color: #64748b; width: 74px; flex-shrink: 0; }
  .saa-pop-row.bal b { color: #166534; font-size: 15px; }
  .saa-pop-act { display: flex; gap: 8px; margin-top: 12px; }
  .saa-pop-act button { flex: 1; font: 700 12px/1 inherit; font-family: inherit; padding: 8px 6px; border-radius: 8px; border: 1px solid #cbd5e1; background: #f8fafc; color: #0f172a; cursor: pointer; }
  .saa-pop-act button.fwd { background: #166534; border-color: #166534; color: #fff; }
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
    scene.fog = new THREE.Fog(0xeef3f8, 270, 460);
    const camera = new THREE.PerspectiveCamera(32, 1, 0.3, 800);   // near 0.3: close-ups of a machine don't clip
    const cam = { target: new THREE.Vector3(-50, 1, 0), az: 0.32, el: 0.7, dist: 230 };

    scene.add(new THREE.HemisphereLight(0xffffff, 0xc7d2e0, 2.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.position.set(-80, 95, 65); sun.target.position.set(-40, 0, 10); scene.add(sun.target);
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
        g.fillStyle = o.keepColor ? color : '#7f1d1d';   // floor / wall text in maroon (owner, 2026-10-24)
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
    const pitPts = [[157, 60], [1022, 60], [1022, 1138], [500, 1138], [500, 815], [207, 815], [207, 600], [157, 600]].map(([px, py]) => [wx(PLAN_B, px), wz(PLAN_B, py)]);
    const holePath = () => new THREE.Path(pitPts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const flatShape = (x0, z0, x1, z1) => { const sh = new THREE.Shape([new THREE.Vector2(x0, -z0), new THREE.Vector2(x1, -z0), new THREE.Vector2(x1, -z1), new THREE.Vector2(x0, -z1)]); sh.holes.push(holePath()); return sh; };
    const groundGeo = new THREE.ShapeGeometry(flatShape(-450, -450, 450, 450)); geos.add(groundGeo);
    // Own materials: in the Basement view the street goes see-through so the
    // whole basement shows, right up to its front wall.
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xe9eef4, roughness: 0.82, transparent: true });
    const yardMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.82, transparent: true });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    const yardGeo = new THREE.ExtrudeGeometry(flatShape(SITE.x0, SITE.z0, SITE.x1, SITE.z1), { depth: 0.12, bevelEnabled: false }); geos.add(yardGeo);
    const yard = new THREE.Mesh(yardGeo, yardMat); yard.rotation.x = -Math.PI / 2; yard.receiveShadow = true; scene.add(yard);
    const earthMat = new THREE.MeshStandardMaterial({ color: 0x8d6e4c, roughness: 1, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide });
    pitPts.forEach(([x1, z1], k) => {
      const [x2, z2] = pitPts[(k + 1) % pitPts.length], len = Math.hypot(x2 - x1, z2 - z1);
      const eg2 = new THREE.BoxGeometry(len, -FLOOR_Y[0], 0.3); geos.add(eg2);
      const wall = new THREE.Mesh(eg2, earthMat); wall.position.set((x1 + x2) / 2, FLOOR_Y[0] / 2, (z1 + z2) / 2); wall.rotation.y = -Math.atan2(z2 - z1, x2 - x1); scene.add(wall);
      box(len, 0.25, 0.5, 0x6b5b4a, (x1 + x2) / 2, 0.06, (z1 + z2) / 2, scene, false).rotation.y = -Math.atan2(z2 - z1, x2 - x1);   // the pit's rim
    });
    box(360, 0.14, 11, 0xb6c2d1, -20, 0.07, ROAD_Z, scene, false);
    for (let x = -195; x <= 155; x += 7) box(3.2, 0.02, 0.28, 0xffffff, x, 0.15, ROAD_Z, scene, false);
    box(360, 0.18, 1.4, 0xdfe5ec, -20, 0.09, ROAD_Z - 6.2, scene, false);
    box(GATE.x1 - GATE.x0, 0.13, ROAD_Z - 4.5 - GATE.z, 0xc4ced9, (GATE.x0 + GATE.x1) / 2, 0.08, (GATE.z + ROAD_Z - 4.5) / 2, scene, false);
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
    fenceRun(SITE.x0, GATE.z, GATE.x0, GATE.z); fenceRun(GATE.x1, GATE.z, SITE.x1, GATE.z);
    fenceRun(SITE.x0, SITE.z0, SITE.x1, SITE.z0); fenceRun(SITE.x0, SITE.z0, SITE.x0, SITE.z1); fenceRun(SITE.x1, SITE.z0, SITE.x1, SITE.z1);
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
    [[-100, -70], [-100, -50], [-100, -30], [-100, -10], [-100, 10], [-100, 30], [-100, 50], [-84, -102], [-64, -102], [-44, -102], [-24, -102], [-2, -70], [-2, -50], [-2, -30], [-2, -10], [-2, 10], [-2, 30], [-2, 50],
     [-110, 78], [-80, 77], [-50, 78], [-20, 77], [10, 78], [40, 77], [70, 78]]
      .forEach(([x, z], i) => tree(x, z, 0.9 + ((i * 37) % 10) / 22));

    // ── Buildings (cut-away: tall back wall, low front so you see in) ──
    const creamWall = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.85, transparent: true, opacity: 0.82 });   // cream, tinted (owner)
    const building = (b, name, opts2) => {
      const g = new THREE.Group(); scene.add(g);
      const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const fl = box(w, 0.3, d, 0xf3f4f6, cx, 0.15, cz, g); fl.castShadow = false;   // lightest gray floor (owner, 2026-10-24)
      box(w, 7, 0.5, creamWall, cx, 3.8, b.z0, g);                                     // cream tinted walls
      box(w + 0.3, 0.45, 0.8, CREAM_DARK, cx, 7.5, b.z0, g);
      for (let x = b.x0 + 2.5; x < b.x1 - 1; x += 2.5) box(0.12, 6.4, 0.06, CREAM_DARK, x, 3.7, b.z0 + 0.28, g, false);
      box(0.5, 7, d, creamWall, b.x0, 3.8, cz, g);
      box(0.8, 0.45, d + 0.3, CREAM_DARK, b.x0, 7.5, cz, g);
      box(0.5, 1.3, d, creamWall, b.x1, 0.95, cz, g);
      // Roof beams, so it reads as a building rather than a yard.
      if (!(opts2 && opts2.noBeams)) for (let x = b.x0 + 5; x < b.x1 - 2; x += 7.5) box(0.35, 0.35, d * 0.55, 0x6b7280, x, 7.4, b.z0 + d * 0.27, g);
      // Front: low wall, with gaps for the docks when asked.
      const gaps = (opts2 && opts2.gaps) || [];
      let x = b.x0;
      const cuts = gaps.map(gx => [gx - 2.1, gx + 2.1]).concat([[b.x1, b.x1]]);
      for (const [a, c] of cuts) { if (a - x > 0.2) box(a - x, 1.3, 0.5, creamWall, (x + a) / 2, 0.95, b.z1, g); x = c; }
      const sign = decal(name, Math.min(w * 0.6, 22), 2.6, '#A32D2D', { size: 0.66, spacing: 6 });
      sign.position.set(cx, 5.2, b.z0 + 0.3); g.add(sign);
      return g;
    };
    building(READY, 'READY STORE', { gaps: DOCKS });   // MIL jobs' ready store (owner, 2026-10-24)
    // Car park under a red tent in the front yard (owner, 2026-10-22).
    {
      const C = CAR_PARK, cx = (C.x0 + C.x1) / 2, cz = (C.z0 + C.z1) / 2, W = C.x1 - C.x0, half = (C.z1 - C.z0) / 2, eave = 3.2, ridge = 4.6;
      for (const x of [C.x0, cx, C.x1]) for (const z of [C.z0, cz, C.z1]) if (z !== cz || x !== cx) cyl(0.12, 0.12, z === cz ? ridge : eave, 0x9ca3af, x, (z === cz ? ridge : eave) / 2, z, scene, 8);
      const tilt = Math.atan2(ridge - eave, half), slope = Math.hypot(half, ridge - eave);
      const cloth = new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.7, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });   // tent fabric, the cars show through
      for (const sd of [-1, 1]) {
        const roof = box(W + 1.2, 0.08, slope + 0.6, 0xc81e1e, cx, (eave + ridge) / 2, cz + sd * half / 2, scene);
        roof.rotation.x = sd * tilt; roof.material = cloth; roof.renderOrder = 2;
        box(W + 1.2, 0.45, 0.05, 0xffffff, cx, eave - 0.2, cz + sd * (half + 0.3), scene, false);   // white valance
      }
      const rows = [[C.z0 + 4.5, 0], [C.z1 - 4.5, Math.PI]], CARS = [0xffffff, 0x9ca3af, 0x111827, 0x1d4ed8, 0xb91c1c, 0x6b7280, 0xe5e7eb, 0x0f766e];
      let n = 0;
      for (const [z, rot] of rows) for (let x = C.x0 + 1.7; x < C.x1 - 1; x += 2.9) {
        for (const lx of [x - 1.45, x + 1.45]) box(0.1, 0.02, 5, 0xffffff, lx, 0.14, z, scene, false);           // bay lines
        if (++n % 4 === 0) continue;                                                                         // a free bay now and then
        const car = new THREE.Group(); car.position.set(x, 0, z); car.rotation.y = rot; scene.add(car);
        const col = CARS[n % CARS.length];
        box(1.8, 0.6, 4.0, col, 0, 0.62, 0, car); box(1.6, 0.55, 2.1, col, 0, 1.18, -0.25, car);
        box(1.64, 0.34, 1.9, 0x1e293b, 0, 1.2, -0.25, car, false);                                              // windows
        for (const wz2 of [-1.3, 1.3]) for (const sx of [-0.85, 0.85]) { const w = cyl(0.34, 0.34, 0.25, 0x111827, sx, 0.34, wz2, car, 10); w.rotation.z = Math.PI / 2; }
      }
      floorDecal('CAR PARKING', 8, 1.2, '#991b1b', cx, C.z0 - 1.6, { size: 0.6 });
    }
    building(INV, 'INVENTORY STORE', { gaps: INV_DOORS, noBeams: true });   // no roof beams: they'd cross the stock
    box(0.3, 2.4, INV.z1 - 4 - INV.z0, creamWall, INV_SPLIT, 1.35, (INV.z0 + INV.z1 - 4) / 2, scene);           // bleach board's own side
    floorDecal('BLEACH BOARD', 12, 1.4, '#1d4ed8', (INV.x0 + INV_SPLIT) / 2, INV.z1 - 2.6, { size: 0.62 });
    floorDecal('ART CARD · PAPER · DUPLEX · STICKER', 22, 1.3, '#7c3aed', (INV_SPLIT + INV.x1) / 2, INV.z1 - 2.6, { size: 0.55 });
    floorDecal('1 PALLET ≈ ' + PALLET_SHEETS.toLocaleString() + ' SHEETS', 10, 0.9, '#64748b', INV.x1 - 7, INV.z1 - 1.2, { size: 0.55 });
    const stockRoot = new THREE.Group(); scene.add(stockRoot);
    let stockKey = null;
    // Floating item cards (owner, 2026-10-24): one per item above its stack,
    // bobbing gently; a click swaps in the big card with the details.
    const stockTiles = [], stockPick = [];
    let stockInstBay = [], stockSel = null, hideStockPop = () => {}, popTarget = null;
    const fmtQty = n => { const r = Math.round(n * 100) / 100; return Number.isInteger(r) ? r.toLocaleString() : r.toFixed(2); };
    const stockBalance = it => it.perPack > 0 ? fmtQty(it.sheets / it.perPack) + ' ' + (it.unit || 'packets').toLowerCase() + ' · ' + it.sheets.toLocaleString() + ' sheets' : it.sheets.toLocaleString() + ' sheets';
    const tileTex = (it, big) => canvasTex(big ? 560 : 400, big ? 360 : 170, (g, w, h) => {
      const tone = (STOCK_TYPES[it.type] || ['#475569'])[0];
      g.shadowColor = 'rgba(15,23,42,.3)'; g.shadowBlur = 12; g.shadowOffsetY = 4;
      g.fillStyle = '#ffffff'; rrect(g, 8, 6, w - 16, h - 20, 18); g.fill();
      g.shadowColor = 'transparent';
      g.save(); rrect(g, 8, 6, w - 16, h - 20, 18); g.clip(); g.fillStyle = tone; g.fillRect(8, 6, w - 16, big ? 56 : 40); g.restore();
      g.strokeStyle = tone; g.lineWidth = 4; rrect(g, 8, 6, w - 16, h - 20, 18); g.stroke();
      g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = '#ffffff';
      g.font = `800 ${big ? 30 : 24}px ${FONT}`; g.fillText(it.type.toUpperCase(), 26, big ? 35 : 27, w - (it.offcut ? 150 : 52));
      if (it.offcut) { g.textAlign = 'right'; g.font = `900 ${big ? 26 : 20}px ${FONT}`; g.fillText('OFFCUT', w - 26, big ? 35 : 27); }
      g.fillStyle = '#0f172a';
      if (!big) {
        g.textAlign = 'center'; g.font = `900 52px ${FONT}`; g.fillText(it.size || '?', w / 2 - (it.gsm ? 56 : 0), 92, w - 150);
        if (it.gsm) { g.font = `800 34px ${FONT}`; g.fillStyle = '#334155'; g.fillText(it.gsm + 'g', w - 78, 94); }
        g.font = `700 22px ${FONT}`; g.fillStyle = '#64748b'; g.fillText(it.brand || '', w / 2, 132, w - 40);
        return;
      }
      g.textAlign = 'left'; g.font = `900 54px ${FONT}`; g.fillText(it.size || '?', 26, 104, 300);
      if (it.gsm) { g.textAlign = 'right'; g.font = `800 40px ${FONT}`; g.fillStyle = '#334155'; g.fillText(it.gsm + ' GSM', w - 26, 106); }
      const rows = [['Brand', it.brand || '—'], ['Supplier', it.supplier || '—'], ['Balance', stockBalance(it)]];
      rows.forEach(([k, v], i) => {
        const y = 168 + i * 50;
        g.textAlign = 'left'; g.fillStyle = '#64748b'; g.font = `700 24px ${FONT}`; g.fillText(k, 26, y);
        g.fillStyle = i === 2 ? '#166534' : '#0f172a'; g.font = `${i === 2 ? 900 : 800} ${i === 2 ? 30 : 28}px ${FONT}`; g.fillText(v, 150, y, w - 176);
      });
    });
    const applyStock = items => {
      const key = JSON.stringify(items || []);
      if (key === stockKey) return;
      stockKey = key;
      stockSel = null;
      for (const T of stockTiles) { T.small.dispose(); const k = textures.indexOf(T.small); if (k >= 0) textures.splice(k, 1); }
      hideStockPop();   // set once the overlay exists
      stockTiles.length = 0; stockPick.length = 0; stockInstBay = [];
      stockRoot.traverse(o => { if (o.geometry) { o.geometry.dispose(); geos.delete(o.geometry); } if (o.material) { o.material.dispose(); } });
      while (stockRoot.children.length) stockRoot.remove(stockRoot.children[0]);
      const { bays, overflow } = stockLayout(items);
      const all = bays.flatMap((b, bi) => b.pallets.map(pp => [pp, b.item.type, bi]));
      if (all.length) {
        const baseGeo = new THREE.BoxGeometry(1.5, 0.16, 1.22), paperGeo = new THREE.BoxGeometry(1.4, 0.56, 1.12);
        const bases = new THREE.InstancedMesh(baseGeo, new THREE.MeshStandardMaterial({ color: 0xc8a26b, roughness: 0.9 }), all.length);
        const papers = new THREE.InstancedMesh(paperGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }), all.length);
        const m4 = new THREE.Matrix4(), col = new THREE.Color();
        all.forEach(([[x, lv, z], type, bi], i) => {
          const y = 0.3 + lv * PALLET_H;
          bases.setMatrixAt(i, m4.makeTranslation(x, y + 0.08, z));
          papers.setMatrixAt(i, m4.makeTranslation(x, y + 0.16 + 0.28, z));
          papers.setColorAt(i, col.setHex((STOCK_TYPES[type] || [0, 0xe5e7eb])[1]));
          stockInstBay[i] = bi;
        });
        bases.castShadow = papers.castShadow = true; bases.receiveShadow = papers.receiveShadow = true;
        stockRoot.add(bases, papers); stockPick.push(bases, papers);
        bays.forEach((b, bi) => {
          const [tx, lv, tz] = b.tile, ty = 0.3 + lv * PALLET_H + 1.25;
          const small = tileTex(b.item, false);
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: small, transparent: true }));
          sp.scale.set(2.9, 2.9 * 170 / 400, 1); sp.position.set(tx, ty, tz); sp.renderOrder = 5; sp.userData.stockBay = bi;
          stockRoot.add(sp); stockPick.push(sp);
          stockTiles.push({ sprite: sp, small, item: b.item, x: tx, y: ty, z: tz, phase: bi * 0.7, popped: false });
        });
      }
      if (overflow) floorDecal('+' + overflow + ' MORE ITEMS', 8, 0.9, '#b45309', (INV.x0 + INV.x1) / 2, INV.z1 - 1.2, { size: 0.55 });
    };
    applyStock(opts.stock || []);

    // People (forklift drivers).
    const people = [];
    const crews = [];   // each machine's group, its station and the figures its builder made
    // Colours (owner, 2026-10-24): operators blue, line manager / QC red,
    // anyone the app has no record of black.
    const STAFF_BLACK = 0x1f2937, OPERATOR_BLUE = 0x2563eb, MANAGER_RED = 0xdc2626;
    const person = (x, z, face, parent, color) => {
      const g = new THREE.Group(); g.position.set(x, 0.3, z); g.rotation.y = face || 0;
      g.userData.body = cyl(0.32, 0.36, 1.1, color || STAFF_BLACK, 0, 0.85, 0, g, 10);
      const hg = new THREE.SphereGeometry(0.3, 12, 10); geos.add(hg);
      const head = new THREE.Mesh(hg, mat(0xe8b98f)); head.position.y = 1.65; head.castShadow = true; g.add(head);
      box(0.66, 0.16, 0.62, 0xfacc15, 0, 1.92, 0, g);
      (parent || scene).add(g); people.push(g);
      return g;
    };

    // ── Production: the three floors from the owner's plans, stacked apart ──
    const SLAB = 0.35;
    const floorGroups = [], floorTags = [], slabMats = [], liftAnims = [];
    const sharedParts = [];   // parts shown on more than their own floor (alsoOn)
    const wallSeg = (x1, z1, x2, z2, h, color, t, parent) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.05) return null;
      const m = box(len + t, h, t, color, (x1 + x2) / 2, SLAB + h / 2, (z1 + z2) / 2, parent);
      m.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      return m;
    };
    const edgeMat = new THREE.LineBasicMaterial({ color: BRAND_DARK });
    // Façade (owner, 2026-10-22): cream tinted walls over the low outer
    // walls up to the next floor; windows only on the street side, laid out
    // like the owner's photo (built after the floors). Overview only - the
    // floor views keep the low cut-away walls so you see in.
    const facade = new THREE.Group(); scene.add(facade);
    const facadeBits = { wall: [], stone: [], glass: [], mullion: [], trim: [], joint: [] };
    const curtain = (x1, z1, x2, z2, y0, y1) =>
      facadeBits.wall.push([(x1 + x2) / 2, (y0 + y1) / 2, (z1 + z2) / 2, Math.hypot(x2 - x1, z2 - z1), y1 - y0, 0.12, -Math.atan2(z2 - z1, x2 - x1)]);
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
      const sm = new THREE.MeshStandardMaterial({ color: fi === 0 ? 0xe5e7eb : 0xf3f4f6, roughness: 0.9, transparent: true, opacity: fi === 0 ? 1 : 0.62 });   // lightest gray floors (owner, 2026-10-24)
      slabMats.push(sm);
      for (const P of F.parts) {
        const raise = P.raise || 0, pg = new THREE.Group(); pg.position.y = raise;
        if (P.alsoOn) {   // its own group, so another floor's view can show it
          const host = new THREE.Group(); host.position.y = FLOOR_Y[fi]; host.add(pg); scene.add(host);
          sharedParts.push({ g: host, floors: [fi, ...P.alsoOn] });
        } else g.add(pg);
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
        const up = Math.max(0, raise);           // a lowered part is a plain slab at its own level
        const sg = new THREE.ExtrudeGeometry(shape, { depth: SLAB + up, bevelEnabled: false }); geos.add(sg);
        const slab = new THREE.Mesh(sg, sm); slab.rotation.x = -Math.PI / 2; slab.position.y = -up; slab.receiveShadow = true; pg.add(slab);
        const eg = new THREE.EdgesGeometry(sg); geos.add(eg);
        const edges = new THREE.LineSegments(eg, edgeMat); edges.rotation.x = -Math.PI / 2; edges.position.y = -up; pg.add(edges);
        // Outer walls (on the part's outside edges) and room walls, low so you see in.
        P.outline.forEach(([px, py], k) => {
          if (P.ext && !P.ext.includes(k)) return;
          const [qx, qy] = P.outline[(k + 1) % P.outline.length];
          wallSeg(X(px), Z(py), X(qx), Z(qy), P.parapet ? 1.1 : 2.4, creamWall, 0.35, pg);
        });
        // Red-tint wall panels on the outer edges (ground and 1st floor; not
        // the basement, which is underground, nor the roof's parapets). The
        // street front is its own façade, below.
        if (fi === 1 || fi === 2) P.outline.forEach(([px, py], k) => {
          if ((P.ext && !P.ext.includes(k)) || k === P.street) return;
          const [qx, qy] = P.outline[(k + 1) % P.outline.length];
          curtain(X(px), Z(py), X(qx), Z(qy), FLOOR_Y[fi] + raise + SLAB + 2.4, P.curtainTop != null ? P.curtainTop : FLOOR_Y[fi + 1] + Math.min(0, raise));
        });
        // Solar panels on a steel frame over the given area (roof, open area).
        if (P.solar) solarCanopy(pg, X(P.solar[0]), X(P.solar[2]), Z(P.solar[1]), Z(P.solar[3]), SLAB + 3.0);
        for (const [a, b, c, d] of P.walls || []) wallSeg(X(a), Z(b), X(c), Z(d), 1.5, creamWall, 0.2, pg);   // cream tinted, like every wall (owner)
        for (const [a, b, c, d] of P.rails || []) railing(X(a), Z(b), X(c), Z(d), SLAB, pg);
        for (const [a, b, c, d, wins] of P.plinth || []) {
          const yS = -(FLOOR_Y[fi] + raise), yT = SLAB, x1 = X(a), z1 = Z(b), x2 = X(c), z2 = Z(d);
          const len = Math.hypot(x2 - x1, z2 - z1), rot = -Math.atan2(z2 - z1, x2 - x1);
          const piece = (t0, t1, y0, y1, color, thick) => {
            const m = box(len * (t1 - t0), y1 - y0, thick, color, x1 + (x2 - x1) * (t0 + t1) / 2, (y0 + y1) / 2, z1 + (z2 - z1) * (t0 + t1) / 2, pg);
            m.rotation.y = rot; return m;
          };
          const spans = (wins || []).map(([w0, w1]) => [(X(w0) - x1) / (x2 - x1), (X(w1) - x1) / (x2 - x1)]).sort((u, v) => u[0] - v[0]);
          let t = 0;
          for (const [w0, w1] of spans) {
            if (w0 > t) piece(t, w0, yS, yT, CREAM, 0.3);
            piece(w0, w1, yS, yS + 0.8, CREAM, 0.3);            // sill
            piece(w0, w1, yT - 0.7, yT, CREAM, 0.3);            // head
            piece(w0, w1, yS + 0.8, yT - 0.7, 0x374151, 0.12);  // glass, dark gray tint
            t = w1;
          }
          if (t < 1) piece(t, 1, yS, yT, CREAM, 0.3);
        }
        for (const [a, b, c, d] of P.dashed || []) {
          const n = Math.round(Math.hypot(X(c) - X(a), Z(d) - Z(b)) / 1.2);
          for (let k = 0; k < n; k += 2) { const t0 = k / n, t1 = (k + 1) / n; box(Math.abs(X(c) - X(a)) * (t1 - t0) + 0.15, 0.02, Math.abs(Z(d) - Z(b)) * (t1 - t0) + 0.15, 0x94a3b8, X(a) + (X(c) - X(a)) * (t0 + t1) / 2, SLAB + 0.01, Z(b) + (Z(d) - Z(b)) * (t0 + t1) / 2, pg, false); }
        }
        for (const [px, py] of P.columns || []) box(0.6, 2.4, 0.6, 0x64748b, X(px), SLAB + 1.2, Z(py), pg);
        // Stairs [rect, reversed?, top height, 'x' | 'z', base]: steps rising
        // along the long side (or the given axis), reversed ones the other
        // way; `base` lets a flight start below the part's floor (outside steps).
        for (const [a, b, c, d, rev, top, axis, base, kind] of P.stairs || []) {
          const x0 = X(a), x1 = X(c), z0 = Z(b), z1 = Z(d), alongX = axis ? axis === 'x' : (x1 - x0) > (z1 - z0), y0 = base == null ? SLAB : base;
          if (kind === 'steel') {
            // Steel stairs (owner, 2026-10-24): grey treads on two dark
            // stringers, a hand rail each side - you see through them.
            const H = top || 2.25, n = Math.max(9, Math.round(H / 0.22)), run = alongX ? x1 - x0 : z1 - z0, ang = Math.atan2(H, run), len = Math.hypot(H, run);
            for (let k = 0; k < n; k++) {
              const h = H * ((rev ? n - k - 1 : k) + 1) / n;
              if (alongX) box((x1 - x0) / n + 0.04, 0.06, z1 - z0 - 0.2, 0x9ca3af, x0 + (x1 - x0) * (k + 0.5) / n, y0 + h, (z0 + z1) / 2, pg);
              else box(x1 - x0 - 0.2, 0.06, (z1 - z0) / n + 0.04, 0x9ca3af, (x0 + x1) / 2, y0 + h, z0 + (z1 - z0) * (k + 0.5) / n, pg);
            }
            for (const side of [0, 1]) for (const [dy, th, ht, col] of [[0, 0.12, 0.32, 0x374151], [1.0, 0.06, 0.06, 0x111827]]) {
              const sx = alongX ? (x0 + x1) / 2 : (side ? x1 - 0.06 : x0 + 0.06), sz = alongX ? (side ? z1 - 0.06 : z0 + 0.06) : (z0 + z1) / 2;
              const m = alongX ? box(len, ht, th, col, sx, y0 + H / 2 + dy, sz, pg) : box(th, ht, len, col, sx, y0 + H / 2 + dy, sz, pg);
              if (alongX) m.rotation.z = rev ? -ang : ang; else m.rotation.x = rev ? ang : -ang;
            }
            continue;
          }
          const n = 9;
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
        if (P.terrace) {
          const [a, b, c, d] = P.terrace;
          box(X(c) - X(a), SLAB + Math.max(0, raise), Z(d) - Z(b), 0xe7e5e4, (X(a) + X(c)) / 2, (SLAB - Math.max(0, raise)) / 2, (Z(b) + Z(d)) / 2, pg);   // solid down to the floor, like a raised part
          railing(X(a), Z(d), X(c), Z(d), SLAB, pg); railing(X(a), Z(b), X(a), Z(d), SLAB, pg); railing(X(c), Z(b), X(c), Z(d), SLAB, pg);
        }
        for (const [text, px, py, s] of P.labels || []) {
          const m = decal(text, Math.max(3, text.length * s * 0.78), s * 1.3, '#64748b', { size: 0.6, weight: 700 });
          m.rotation.x = -Math.PI / 2; m.position.set(X(px), SLAB + 0.02, Z(py)); m.renderOrder = 1; pg.add(m);
        }
      }
      const ft = tag(FLOOR_NAMES[fi], '', 'brand', 3.4);
      ft.position.set(BLD.x0 - 4.5, 2.4, BLD.z0 + 34); g.add(ft); floorTags.push(ft);   // past the warehouse, beside the core
    });
    // The street side, after the owner's photo (2026-10-22) - the only side
    // with windows. Cream stone panels with joints, windows in dark
    // reflective glass on a black frame grid inside a stone surround.
    // Front block: the tall stair window on a bay that steps forward (the
    // lobby stairs are behind it), the middle bay under the 1st floor
    // terrace - the photo's canopy - with glass doors, dark steps, a small
    // grid window and the name above, and a tall strip window on the right.
    // Side wing (the core, set back): three rows of windows left of the
    // open loading area.
    {
      const stoneAt = (x0, x1, y0, y1, z) => {
        facadeBits.stone.push([(x0 + x1) / 2, (y0 + y1) / 2, z, x1 - x0, y1 - y0, 0.14, 0]);
        for (let y = y0 + 2.9; y < y1 - 0.5; y += 2.9) facadeBits.joint.push([(x0 + x1) / 2, y, z + 0.08, x1 - x0, 0.05, 0.02, 0]);
      };
      const win = (x0, x1, y0, y1, cols, rows, z) => {
        facadeBits.glass.push([(x0 + x1) / 2, (y0 + y1) / 2, z + 0.06, x1 - x0, y1 - y0, 0.05, 0]);
        for (let i = 0; i <= cols; i++) facadeBits.mullion.push([x0 + (x1 - x0) * i / cols, (y0 + y1) / 2, z + 0.12, i % cols ? 0.08 : 0.14, y1 - y0, 0.08, 0]);
        for (let k = 0; k <= rows; k++) facadeBits.mullion.push([(x0 + x1) / 2, y0 + (y1 - y0) * k / rows, z + 0.12, x1 - x0, k % rows ? 0.08 : 0.14, 0.08, 0]);
        const t = 0.3;   // stone surround, standing a little proud of the wall
        facadeBits.trim.push([(x0 + x1) / 2, y1 + t / 2, z + 0.12, x1 - x0 + 2 * t, t, 0.3, 0], [(x0 + x1) / 2, y0 - t / 2, z + 0.12, x1 - x0 + 2 * t, t, 0.3, 0],
          [x0 - t / 2, (y0 + y1) / 2, z + 0.12, t, y1 - y0, 0.3, 0], [x1 + t / 2, (y0 + y1) / 2, z + 0.12, t, y1 - y0, 0.3, 0]);
      };
      // Front block.
      const z = wz(PLAN_P, 500), xa = wx(PLAN_P, 0), xb = wx(PLAN_P, 603), top = FLOOR_Y[3] + OPEN_RAISE + 1.2;
      const d0 = wx(PLAN_P, 270), d1 = wx(PLAN_P, 330), doorTop = 6.4;   // the plan's entrance doors
      const pl = wx(PLAN_G, 668) - 0.8, pr = wx(PLAN_G, 902) + 0.8, mc = (pl + pr) / 2;   // the middle bay, under the terrace
      const zl = z + 0.6;                                                                  // the stair bay steps forward
      stoneAt(xa, pl, SLAB, top + 0.4, zl);
      facadeBits.stone.push([pl, (SLAB + top) / 2, z + 0.3, 0.14, top - SLAB, 0.6, 0], [xa, (SLAB + top) / 2, z + 0.3, 0.14, top - SLAB, 0.6, 0]);   // its returns
      stoneAt(pl, d0, SLAB, top, z); stoneAt(d1, xb, SLAB, top, z); stoneAt(d0, d1, doorTop + 0.4, top, z);
      win(xa + 1.4, pl - 1.6, 1.8, top - 1.2, 4, 4, zl);      // tall stair window
      win(mc - 2.1, mc + 2.1, top - 7.4, top - 4.4, 4, 2, z);      // small window over the terrace
      win(xb - 3.0, xb - 0.6, 1.8, top - 1.2, 3, 4, z);       // tall strip window
      // Entrance: glass doors in a dark frame with steel handles, warm light inside.
      win(d0, d1, SLAB, doorTop, 2, 1, z);
      box(d1 - d0 + 0.5, 0.4, 0.3, 0x111827, (d0 + d1) / 2, doorTop + 0.2, z + 0.15, facade);
      for (const hx of [-0.18, 0.18]) box(0.06, 1.1, 0.08, 0xd1d5db, (d0 + d1) / 2 + hx, 3.2, z + 0.25, facade, false);
      const warm = box(d1 - d0 - 0.2, doorTop - SLAB - 0.4, 0.05, 0xfef3c7, (d0 + d1) / 2, (doorTop + SLAB) / 2, z - 0.4, facade, false);
      warm.material = new THREE.MeshBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.35, depthWrite: false });
      // Cornice, a dark plinth, the terrace's stone fascia (the canopy) and its lights.
      box(pl - xa + 0.4, 0.6, 1.0, CREAM_DARK, (xa + pl) / 2, top + 0.7, zl - 0.1, facade);
      box(xb - pl + 0.4, 0.6, 0.6, CREAM_DARK, (pl + xb) / 2, top + 0.3, z + 0.2, facade);
      box(pl - xa, 0.35, 0.3, 0x1f2937, (xa + pl) / 2, SLAB + 0.17, zl + 0.12, facade, false);
      box(xb - pl, 0.35, 0.3, 0x1f2937, (pl + xb) / 2, SLAB + 0.17, z + 0.12, facade, false);
      const tz = wz(PLAN_G, 1345), tx0 = wx(PLAN_G, 668), tx1 = wx(PLAN_G, 902);
      box(tx1 - tx0 + 0.3, 1.6, 0.35, CREAM_DARK, (tx0 + tx1) / 2, FLOOR_Y[2] + OFFICE_RAISE + 0.3, tz + 0.1, facade);
      for (const dx of [-3.5, 0, 3.5]) box(0.5, 0.05, 0.5, 0xfde68a, mc + dx, FLOOR_Y[2] + OFFICE_RAISE - 0.03, z + 1.8, facade, false);   // lights under the terrace (the entrance canopy)
      box(pr - pl + 1.6, 0.2, 2.4, 0x1f2937, mc, 0.1, z + 1.4, facade, false);                       // dark steps
      box(pr - pl - 0.2, 0.2, 1.5, 0x111827, mc, 0.3, z + 0.95, facade, false);
      for (const [text, y, w, h, color, size] of [['SUPREME ART', top - 1.8, 11, 1.6, '#dc2626', 0.78], ['(PRIVATE) LIMITED', top - 3.1, 7, 0.9, '#1f2937', 0.7]]) {
        const sign = decal(text, w, h, color, { size, weight: 900 }); sign.position.set(mc, y, z + 0.25); sign.renderOrder = 3; facade.add(sign);
      }
      // Paved forecourt with big tiles, like the photo.
      const fz0 = z + 2.6, fz1 = z + 10, fx0 = xa - 1, fx1 = xb + 0.5;
      box(fx1 - fx0, 0.05, fz1 - fz0, 0xe7e5e4, (fx0 + fx1) / 2, 0.15, (fz0 + fz1) / 2, scene, false);
      for (let x = fx0 + 2.2; x < fx1; x += 2.2) box(0.05, 0.02, fz1 - fz0, 0xc8c4bf, x, 0.18, (fz0 + fz1) / 2, scene, false);
      for (let zz = fz0 + 2.2; zz < fz1; zz += 2.2) box(fx1 - fx0, 0.02, 0.05, 0xc8c4bf, (fx0 + fx1) / 2, 0.18, zz, scene, false);
      // Side wing: the core's front, from its corner to the open loading area.
      const cz = wz(PLAN_G, 940), cx0 = wx(PLAN_G, 212), cx1 = wx(PLAN_G, 412), ctop = FLOOR_Y[3] + 1.2;
      // Two columns of windows; the third bay, by the loading area, stands open (owner, 2026-10-22).
      const step = (cx1 - cx0 - 3.4) / 2, cxm = cx0 + 1.7 + step + 2.1;
      stoneAt(cx0, cxm, 0, ctop, cz + 0.05);
      for (const [y0, y1] of [[3.2, 7.7], [12.2, 16.2], [18.2, 21.6]].map(([a, b]) => [a + RAISE, b + RAISE]))
        for (let i = 0; i < 2; i++) { const wc = cx0 + 1.7 + i * step; win(wc - 1.1, wc + 1.1, y0, y1, 2, 2, cz + 0.05); }
      box(cxm - cx0 + 0.4, 0.6, 0.7, CREAM_DARK, (cx0 + cxm) / 2, ctop + 0.3, cz + 0.2, facade);
      box(cxm - cx0, 0.35, 0.3, 0x1f2937, (cx0 + cxm) / 2, 0.17, cz + 0.2, facade, false);
    }
    {
      const unit = new THREE.BoxGeometry(1, 1, 1); geos.add(unit);
      const kinds = [
        ['wall', new THREE.MeshStandardMaterial({ color: CREAM, transparent: true, opacity: 0.38, roughness: 0.85, depthWrite: false, side: THREE.DoubleSide }), 1],
        ['stone', new THREE.MeshStandardMaterial({ color: CREAM, transparent: true, opacity: 0.86, roughness: 0.9, depthWrite: false }), 1],
        ['joint', new THREE.MeshStandardMaterial({ color: 0xc9b994, roughness: 1 }), 0],
        ['trim', new THREE.MeshStandardMaterial({ color: CREAM_DARK, roughness: 0.8 }), 0],
        // Black tinted glass with a sky reflection fading down it.
        ['glass', new THREE.MeshStandardMaterial({ map: canvasTex(64, 256, (g, w, h) => {
          const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#6b7280'); gr.addColorStop(0.35, '#374151'); gr.addColorStop(1, '#111827');   // dark gray tint (owner, 2026-10-24)
          g.fillStyle = gr; g.fillRect(0, 0, w, h);
          g.fillStyle = 'rgba(255,255,255,.10)'; g.beginPath(); g.moveTo(0, h * 0.55); g.lineTo(w, h * 0.3); g.lineTo(w, h * 0.42); g.lineTo(0, h * 0.67); g.fill();
        }), transparent: true, opacity: 0.88, roughness: 0.08, metalness: 0.35, depthWrite: false }), 2],
        ['mullion', new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.4, metalness: 0.6 }), 0],
      ];
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
      for (const [k, m, order] of kinds) {
        const list = facadeBits[k], inst = new THREE.InstancedMesh(unit, m, list.length);
        list.forEach(([x, y, z, w, h, d, rot], i) => inst.setMatrixAt(i, m4.compose(pos.set(x, y, z), q.setFromEuler(e.set(0, rot, 0)), sc.set(w, h, d))));
        inst.renderOrder = order; facade.add(inst);
      }
    }
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
      const tg = new THREE.Group(); scene.add(tg); towerGroups.push({ g: tg, floors: T.name === 'ground-first' ? [1, 2] : T.name === 'first-roof' ? [2, 3] : [0, 1] });
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
        const fwd = (k % 2 === 0) !== (T.startEnd === 'hi');       // even flights run from the start end
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
      for (const [px, py] of OUTLINE_G) cyl(0.14, 0.14, hgt, CREAM_DARK, wx(pl, px), bot + hgt / 2, wz(pl, py), frame, 8);
      const [a, b, c, d] = LIFT_G, lx = (wx(pl, a) + wx(pl, c)) / 2, lz = (wz(pl, b) + wz(pl, d)) / 2, lw = wx(pl, c) - wx(pl, a), ld = wz(pl, d) - wz(pl, b);
      // The lift runs basement -> 1st floor only; nothing goes on up to the roof.
      const shaftH = FLOOR_Y[2] + 2.8 - bot;
      const shaftGeo = new THREE.BoxGeometry(lw, shaftH, ld); geos.add(shaftGeo);
      const shaft = new THREE.Mesh(shaftGeo, new THREE.MeshStandardMaterial({ color: CREAM, transparent: true, opacity: 0.22, depthWrite: false }));
      shaft.position.set(lx, bot + shaftH / 2, lz); frame.add(shaft);
      var liftCar = box(lw * 0.8, 2.0, ld * 0.8, BRAND_DARK, lx, bot + 1.4, lz, frame);
      const sign = tag('PRODUCTION', '', 'brand', 5.5);
      sign.position.set(BLD.x0 + BLD.w / 2, top + 4.2, BLD.z0 + 2); frame.add(sign); floorTags.push(sign);
    }
    // Stage areas (provisional until the owner places them): a painted
    // outline and the stage's name on its floor.
    STAGE_ZONES.forEach((z, i) => {
      if (!z.r || z.hidden) return;
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
    const buildGluer = (g, n, len, dep) => {   // folder gluer along local x: feeder -> folding + glue section -> compression belt -> packed cartons
      len = len || 16; dep = dep || 1.6;
      box(len, 0.35, dep, 0x111827, 0, 0.17, 0, g);
      box(1.8, 1.4, dep + 0.3, 0xcbd5e1, -len / 2 + 0.9, 0.95, 0, g);                            // feeder
      const blanks = box(1.2, 1, dep * 0.75, 0xd6c3a1, -len / 2 + 0.9, 1.65, 0, g);                // stack of flat blanks
      const bx0 = -len / 2 + 2.0, bLen = len - 5.6;
      box(bLen, 0.12, dep * 0.8, 0x374151, bx0 + bLen / 2, 0.98, 0, g);                         // carrier belts
      for (const sd of [-1, 1]) box(bLen, 0.35, 0.08, 0x2563eb, bx0 + bLen / 2, 1.15, sd * dep * 0.45, g);   // folding rails
      for (let k = 0; k < 4; k++) box(0.6, 0.55, dep * 0.95, 0x1d4ed8, bx0 + bLen * (0.12 + k * 0.22), 1.35, 0, g);   // folding / gluing stations
      for (const fx of [0.3, 0.55]) box(0.22, 0.3, 0.22, 0xdc2626, bx0 + bLen * fx, 1.75, dep * 0.3, g);               // glue pots
      box(3.2, 0.9, dep, 0x9ca3af, len / 2 - 1.8, 0.62, 0, g);                                    // compression belt
      box(3.0, 0.12, dep * 0.8, 0x1f2937, len / 2 - 1.8, 1.12, 0, g);
      const packed = box(1.1, 1, dep * 0.7, 0xc9a26b, len / 2 - 0.45, 0.5, 0, g);                  // packed cartons at the end
      const items = [0, 1, 2, 3, 4].map(() => box(0.5, 0.05, dep * 0.55, 0xe7d8b8, bx0, 1.07, 0, g, false));
      const light = signal(g, len / 2 - 0.3, -dep / 2 - 0.1);
      person(-len / 2 - 0.7, 0, Math.PI / 2, g);                                                  // feeding
      person(len / 2 - 1.6, dep / 2 + 0.8, Math.PI, g);                                           // packing at the end
      animated.push((dt, t) => {
        items.forEach((it, k) => { it.position.x = bx0 + ((t * 0.18 + k / 5 + n * 0.17) % 1) * (bLen + 3); });
        const h = 0.1 + ((t * 0.04 + n * 0.3) % 1) * 0.8; packed.scale.y = h; packed.position.y = 0.2 + h / 2;
        const b = 0.9 - ((t * 0.03 + n * 0.2) % 1) * 0.7; blanks.scale.y = b; blanks.position.y = 1.65 - (1 - b) / 2;
        light(t + n);
      });
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
    const buildCutter = (g, n, len, dep) => {   // guillotine paper cutter: frame + knife beam over a front table
      len = len || 3.5; dep = dep || 2.4;
      box(dep * 0.55, 0.9, len, 0x111827, -dep * 0.2, 0.45, 0, g);                      // body
      box(dep * 0.5, 0.1, len * 0.96, 0xcbd5e1, dep * 0.22, 0.95, 0, g);               // front table
      for (const s2 of [-1, 1]) {
        box(dep * 0.5, 1.7, 0.3, 0x1f2937, -dep * 0.12, 1.75, s2 * (len / 2 - 0.15), g);   // side frames
        box(0.12, 0.85, 0.12, 0x6b7280, dep * 0.42, 0.45, s2 * (len / 2 - 0.3), g, false);  // table legs
      }
      box(dep * 0.5, 0.45, len, 0x374151, -dep * 0.12, 2.6, 0, g);                       // knife beam housing
      const knife = box(0.08, 0.55, len * 0.86, 0x9ca3af, dep * 0.06, 1.6, 0, g);       // the blade
      const clamp = box(0.22, 0.2, len * 0.86, 0x6b7280, -dep * 0.06, 1.55, 0, g);      // paper clamp
      box(dep * 0.4, 0.36, len * 0.55, 0xffffff, dep * 0.12, 1.18, 0, g);               // the paper pile
      box(0.3, 0.5, 0.45, 0x1f2937, dep * 0.15, 1.9, len / 2 - 0.1, g);                 // control panel
      const scr = box(0.02, 0.28, 0.32, 0x22d3ee, dep * 0.15 + 0.16, 1.95, len / 2 - 0.1, g, false); scr.material = new THREE.MeshBasicMaterial({ color: 0x67e8f9 });
      const light = signal(g, -dep * 0.2, -len / 2 + 0.3);
      person(dep / 2 + 0.55, 0, -Math.PI / 2, g);                                       // operator at the table
      animated.push((dt, t) => {
        const u = ((t * 0.5 + n * 0.37) % 1);                                          // one cut every 2 s
        const down = u < 0.15 ? u / 0.15 : u < 0.3 ? 1 - (u - 0.15) / 0.15 : 0;
        knife.position.y = 1.6 - down * 0.25; clamp.position.y = 1.55 - Math.min(1, down * 2) * 0.12;
        light(t + n);
      });
    };
    const buildFolder = (g, n, len, dep) => {    // sheet folding machine: feeder, fold plates, rollers, delivery belt (long axis z)
      len = len || 3; dep = dep || 1.3;
      box(dep, 0.8, len, 0x111827, 0, 0.4, 0, g);                                            // stand
      const feed = box(dep * 0.9, 0.08, len * 0.3, 0xcbd5e1, 0, 1.15, -len * 0.33, g); feed.rotation.x = 0.25;   // feed table
      box(dep * 0.7, 0.25, len * 0.22, 0xffffff, 0, 1.3, -len * 0.36, g);                    // paper on the feeder
      for (let k = 0; k < 4; k++) box(dep * 0.85, 0.05, len * 0.18, 0x9ca3af, 0, 0.95 + k * 0.14, -len * 0.05, g, false);   // fold plates
      const rolls = [];
      for (let k = 0; k < 3; k++) { const r = new THREE.Group(); r.position.set(0, 1.0, len * 0.08 + k * 0.22); g.add(r); const c = cyl(0.08, 0.08, dep * 0.9, 0x6b7280, 0, 0, 0, r, 10); c.rotation.z = Math.PI / 2; box(dep * 0.88, 0.04, 0.04, 0x1f2937, 0, 0.07, 0, r, false); rolls.push(r); }
      box(dep * 0.8, 0.06, len * 0.32, 0x1f2937, 0, 0.88, len * 0.32, g);                    // delivery belt
      const stack = box(dep * 0.5, 1, 0.3, 0xffffff, 0, 1.0, len * 0.42, g);                // folded sheets piling up
      box(0.3, 0.45, 0.35, 0x1f2937, dep / 2 + 0.1, 1.05, -len * 0.1, g);                   // control panel
      const light = signal(g, -dep / 2 + 0.15, -len / 2 + 0.2);
      person(dep / 2 + 0.75, 0.2, -Math.PI / 2, g);
      animated.push((dt, t) => {
        for (const r of rolls) r.rotation.x -= dt * 7;
        const h = 0.05 + ((t * 0.08 + n * 0.2) % 1) * 0.3; stack.scale.y = h; stack.position.y = 0.91 + h / 2;
        light(t + n);
      });
    };
    const buildCoater = (g, n, len, dep) => {   // UV coating machine along local x: feeder -> roller coater -> UV tunnel -> delivery
      len = len || 5.2; dep = dep || 1.6;
      const beltX0 = -len / 2 + 2.05, beltLen = len - 3.25;
      box(len, 0.35, dep, 0x111827, 0, 0.17, 0, g);                                            // base
      box(1.1, 1.2, dep * 0.95, 0xcbd5e1, -len / 2 + 0.55, 0.95, 0, g);                        // feeder
      box(0.9, 0.18, dep * 0.7, 0xffffff, -len / 2 + 0.55, 1.64, 0, g);                         // sheets waiting
      box(0.9, 1.3, dep, 0x1f2937, -len / 2 + 1.6, 1.0, 0, g);                                  // roller coater
      const rolls = [];
      for (const dx of [-0.2, 0.2]) {
        const r = new THREE.Group(); r.position.set(-len / 2 + 1.6 + dx, 1.78, 0); g.add(r);
        const c = cyl(0.14, 0.14, dep * 0.9, 0x9ca3af, 0, 0, 0, r, 12); c.rotation.x = Math.PI / 2;
        box(0.05, 0.05, dep * 0.88, 0x4b5563, 0, 0.13, 0, r, false); rolls.push(r);
      }
      box(beltLen, 0.08, dep * 0.8, 0x374151, beltX0 + beltLen / 2, 0.95, 0, g);              // conveyor
      box(beltLen * 0.6, 0.9, dep * 1.02, 0x9ca3af, beltX0 + beltLen * 0.55, 1.45, 0, g);       // UV tunnel
      const glow = box(beltLen * 0.6 - 0.1, 0.08, dep * 0.85, 0x7c3aed, beltX0 + beltLen * 0.55, 1.03, 0, g, false);
      glow.material = new THREE.MeshBasicMaterial({ color: 0xa78bfa });
      const sheets = [0, 1, 2].map(() => box(0.7, 0.03, dep * 0.6, 0xffffff, beltX0, 1.01, 0, g, false));
      box(1.2, 0.9, dep, 0xcbd5e1, len / 2 - 0.6, 0.62, 0, g);                                   // delivery
      const stack = box(0.9, 1, dep * 0.7, 0xffffff, len / 2 - 0.6, 1.1, 0, g);
      const light = signal(g, -len / 2 + 0.25, -dep / 2 + 0.2);
      person(-len / 2 - 0.7, 0, Math.PI / 2, g);
      animated.push((dt, t) => {
        for (const r of rolls) r.rotation.z -= dt * 6;
        sheets.forEach((sh, k) => { sh.position.x = beltX0 + ((t * 0.35 + k / 3 + n * 0.13) % 1) * beltLen; });
        glow.material.color.setHSL(0.73, 0.8, 0.62 + 0.1 * Math.sin(t * 5));
        const h = 0.05 + ((t * 0.06 + n * 0.3) % 1) * 0.4; stack.scale.y = h; stack.position.y = 1.07 + h / 2;
        light(t + n);
      });
    };
    const buildInspection = (g, n, len, dep) => {   // sheet inspection machine along local x: feeder -> camera bridges -> good / reject delivery
      len = len || 12; dep = dep || 1.8;
      const tX0 = -len / 2 + 1.6, tLen = len - 3.3;
      box(len, 0.3, dep, 0x111827, 0, 0.15, 0, g);
      box(1.4, 1.3, dep, 0xcbd5e1, -len / 2 + 0.7, 0.95, 0, g);                                 // feeder
      box(1.0, 0.3, dep * 0.7, 0xffffff, -len / 2 + 0.7, 1.75, 0, g);
      box(tLen, 0.12, dep * 0.75, 0x374151, tX0 + tLen / 2, 0.95, 0, g);                       // transport table
      for (let k = 0; k <= Math.floor(tLen / 2); k++) box(0.1, 0.65, dep * 0.8, 0x1f2937, tX0 + 0.2 + k * 2, 0.6, 0, g);
      for (const fx of [0.3, 0.55]) {                                                           // camera bridges with their lights
        const bx = tX0 + tLen * fx;
        for (const sd of [-1, 1]) box(0.12, 1.5, 0.12, 0x9ca3af, bx, 1.75, sd * (dep / 2 + 0.05), g);
        box(0.55, 0.4, dep + 0.3, 0x1f2937, bx, 2.5, 0, g);
        const lamp = box(0.45, 0.04, dep * 0.9, 0xffffff, bx, 2.28, 0, g, false); lamp.material = new THREE.MeshBasicMaterial({ color: 0xbfdbfe });
      }
      const scr = box(0.75, 0.5, 0.06, 0x111827, tX0 + tLen * 0.42, 1.9, dep / 2 + 0.35, g);       // inspection screen on a post
      box(0.08, 1.0, 0.08, 0x6b7280, tX0 + tLen * 0.42, 1.2, dep / 2 + 0.35, g);
      const glass = box(0.66, 0.4, 0.02, 0x38bdf8, tX0 + tLen * 0.42, 1.9, dep / 2 + 0.39, g, false); glass.material = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      const sheets = [0, 1, 2, 3].map(() => box(0.8, 0.03, dep * 0.6, 0xffffff, tX0, 1.03, 0, g, false));
      box(1.6, 0.85, dep, 0xcbd5e1, len / 2 - 0.85, 0.57, 0, g);                                 // delivery
      const good = box(1.1, 1, dep * 0.55, 0xffffff, len / 2 - 0.85, 1.0, -dep * 0.2, g);
      const bad = box(0.6, 1, 0.5, 0xfca5a5, len / 2 - 0.85, 1.0, dep * 0.3, g);               // rejects
      const light = signal(g, len / 2 - 0.2, -dep / 2 + 0.2);
      person(tX0 + tLen * 0.42, dep / 2 + 0.95, Math.PI, g);
      person(-len / 2 - 0.7, 0, Math.PI / 2, g);
      animated.push((dt, t) => {
        sheets.forEach((sh, k) => { sh.position.x = tX0 + ((t * 0.12 + k / 4 + n * 0.2) % 1) * tLen; });
        const h = 0.05 + ((t * 0.05 + n * 0.4) % 1) * 0.5; good.scale.y = h; good.position.y = 1.0 + h / 2;
        const r = 0.02 + ((t * 0.01 + n * 0.3) % 1) * 0.15; bad.scale.y = r; bad.position.y = 1.0 + r / 2;
        glass.material.color.setHSL(0.55, 0.85, 0.5 + 0.12 * Math.sin(t * 3 + n));
        light(t + n);
      });
    };
    const buildLaminator = (g, n, len, dep) => {   // manual lamination machine along local x: feed table -> heated rollers -> exit table, film roll above
      len = len || 2.9; dep = dep || 1.4;
      box(len, 0.85, dep * 0.8, 0x1f2937, 0, 0.42, 0, g);
      box(len * 0.38, 0.06, dep, 0xcbd5e1, -len * 0.3, 0.9, 0, g);                              // feed table
      box(len * 0.38, 0.06, dep, 0xcbd5e1, len * 0.3, 0.9, 0, g);                               // exit table
      box(0.62, 0.75, dep * 1.05, 0x111827, 0, 1.25, 0, g);                                     // roller head
      const rolls = [];
      for (const y of [1.05, 1.32]) { const r = new THREE.Group(); r.position.set(0.34, y, 0); g.add(r); const c = cyl(0.09, 0.09, dep * 0.9, 0x9ca3af, 0, 0, 0, r, 10); c.rotation.x = Math.PI / 2; rolls.push(r); }
      const film = cyl(0.17, 0.17, dep * 0.9, 0xe0f2fe, -0.1, 1.82, 0, g, 14); film.rotation.x = Math.PI / 2;   // the film roll
      const sheet = box(0.5, 0.02, dep * 0.6, 0xffffff, -len * 0.35, 0.95, 0, g, false);
      person(-len / 2 - 0.6, 0, Math.PI / 2, g);
      animated.push((dt, t) => {
        for (const r of rolls) r.rotation.z -= dt * 4;
        sheet.position.x = -len * 0.4 + ((t * 0.25 + n * 0.3) % 1) * len * 0.8;
      });
    };
    const buildCTP = (g, n, len, dep) => {   // CTP platesetter: cabinet, loading table, screen; a plate goes in and comes back exposed
      len = len || 3.4; dep = dep || 1.6;
      box(len * 0.62, 1.25, dep, 0xe5e7eb, -len * 0.19, 0.63, 0, g);                           // cabinet
      box(len * 0.62, 0.14, dep, 0x2563eb, -len * 0.19, 1.32, 0, g);                            // blue band
      box(len * 0.36, 0.08, dep * 0.8, 0xcbd5e1, len * 0.31, 0.95, 0, g);                       // loading table
      for (const sx of [0.18, 0.44]) for (const sz of [-1, 1]) box(0.07, 0.9, 0.07, 0x6b7280, len * sx, 0.45, sz * dep * 0.35, g);
      const plate = box(len * 0.3, 0.02, dep * 0.6, 0xd1d5db, len * 0.31, 1.0, 0, g, false);
      plate.material = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.7, roughness: 0.3 });
      box(0.06, 0.45, 0.7, 0x111827, -len * 0.19, 1.65, dep / 2 - 0.3, g);                      // screen
      const scr = box(0.02, 0.38, 0.6, 0x60a5fa, -len * 0.19 + 0.04, 1.65, dep / 2 - 0.3, g, false); scr.material = new THREE.MeshBasicMaterial({ color: 0x60a5fa });
      person(len * 0.1, -dep / 2 - 0.75, 0, g);
      animated.push((dt, t) => {
        const u = (t * 0.12 + n * 0.3) % 1;
        plate.position.x = len * 0.31 - (u < 0.5 ? u * 2 : 2 - u * 2) * len * 0.35;
        plate.material.color.setHex(u > 0.5 ? 0x93c5fd : 0xd1d5db);   // comes back exposed
      });
    };
    const buildProcessor = (g, n, len, dep) => {   // plate processor: plates come out developed onto the tray
      len = len || 1.8; dep = dep || 1.2;
      box(len, 0.95, dep, 0xd1d5db, 0, 0.48, 0, g);
      box(len * 0.9, 0.08, dep * 0.9, 0x1f2937, 0, 0.99, 0, g);
      box(0.5, 0.06, dep * 0.8, 0xcbd5e1, len / 2 + 0.25, 0.8, 0, g);                           // out tray
      const pl = box(0.45, 0.02, dep * 0.6, 0x93c5fd, len / 2 + 0.25, 0.85, 0, g, false);
      animated.push((dt, t) => { const u = (t * 0.15 + n * 0.2) % 1; pl.position.x = len / 2 - 0.2 + u * 0.45; pl.visible = u > 0.1; });
    };
    // Ink-can racks: steel shelving, four shelves of small cans (one
    // instanced mesh for all the cans, coloured C / M / Y / K / spot).
    {
      const cans = [];
      for (const R of INK_RACKS) {
        const x1 = wx(PLAN_B, R.from[0]), x2 = wx(PLAN_B, R.to[0]), z = wz(PLAN_B, R.from[1]), lift = basementRaise(R.from[0], R.from[1]);
        const y0 = SLAB + lift, depth = 0.7, zc = z + (R.back === 'up' ? -depth / 2 : depth / 2), bays = Math.max(1, Math.round((x2 - x1) / 1.5));
        for (let i = 0; i <= bays; i++) for (const dz of [-depth / 2, depth / 2]) box(0.07, 2.1, 0.07, 0x1e40af, x1 + (x2 - x1) * i / bays, y0 + 1.05, zc + dz, floorGroups[0], false);
        for (let lv = 0; lv < 4; lv++) {
          const sy = y0 + 0.15 + lv * 0.55;
          box(x2 - x1, 0.05, depth, 0x9ca3af, (x1 + x2) / 2, sy, zc, floorGroups[0], false);
          for (let k = 0; (k + 0.5) * 0.32 < x2 - x1; k++) for (const dz of [-0.17, 0.17]) cans.push([x1 + (k + 0.5) * 0.32, sy + 0.14, zc + dz, (k + lv + (dz > 0 ? 2 : 0)) % 5]);
        }
      }
      {   // one floor label down the middle of the walkway
        const [A, B] = INK_RACKS, lab = decal('INK STORE', 4.4, 0.8, '#374151', { size: 0.6 });
        lab.rotation.x = -Math.PI / 2; lab.position.set(wx(PLAN_B, (A.from[0] + A.to[0]) / 2), SLAB + basementRaise(A.from[0], A.from[1]) + 0.02, wz(PLAN_B, (A.from[1] + B.from[1]) / 2)); lab.renderOrder = 1; floorGroups[0].add(lab);
      }
      const canGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.24, 10); geos.add(canGeo);
      const canMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 });
      const inst = new THREE.InstancedMesh(canGeo, canMat, cans.length);
      const m4 = new THREE.Matrix4(), col = new THREE.Color(), INK = [0x06b6d4, 0xdb2777, 0xfacc15, 0x111827, 0xf97316];
      cans.forEach(([x, y, z, c], i) => { inst.setMatrixAt(i, m4.makeTranslation(x, y, z)); inst.setColorAt(i, col.setHex(INK[c])); });
      inst.castShadow = true; floorGroups[0].add(inst);
    }
    const STAGE_COLOR = { 1: '#374151', 3: '#374151' };
    // Yellow / black hazard tape on the floor round each machine and its
    // operator (owner, 2026-10-22): one striped texture, its stripes kept
    // the same size on every side.
    const tapeTex = canvasTex(64, 16, (g2, w, h) => {
      g2.fillStyle = '#facc15'; g2.fillRect(0, 0, w, h); g2.fillStyle = '#111827';
      for (let k = -1; k < 3; k++) { g2.beginPath(); g2.moveTo(k * 32, h); g2.lineTo(k * 32 + 16, 0); g2.lineTo(k * 32 + 32, 0); g2.lineTo(k * 32 + 16, h); g2.fill(); }
    });
    tapeTex.wrapS = THREE.RepeatWrapping;
    const tapeMat = new THREE.MeshStandardMaterial({ map: tapeTex, roughness: 0.6 });
    const tapeBox = new THREE.Box3();
    const hazardTape = (g, y, parent) => {
      g.updateMatrixWorld(true);
      tapeBox.setFromObject(g);
      const x0 = tapeBox.min.x - 0.35, x1 = tapeBox.max.x + 0.35, z0 = tapeBox.min.z - 0.35, z1 = tapeBox.max.z + 0.35;
      for (const [len, cx, cz, alongX] of [[x1 - x0, (x0 + x1) / 2, z0, true], [x1 - x0, (x0 + x1) / 2, z1, true], [z1 - z0, x0, (z0 + z1) / 2, false], [z1 - z0, x1, (z0 + z1) / 2, false]]) {
        const tg = new THREE.PlaneGeometry(len + 0.22, 0.22); geos.add(tg);
        const uv = tg.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * (len + 0.22) / 0.9);
        const t = new THREE.Mesh(tg, tapeMat); t.rotation.set(-Math.PI / 2, 0, alongX ? 0 : Math.PI / 2);
        t.position.set(cx, y, cz); t.receiveShadow = true; (parent || floorGroups[0]).add(t);
      }
    };
    MACHINES.forEach((m, i) => {
      const g = new THREE.Group(), x = wx(PLAN_B, m.at[0]), z = wz(PLAN_B, m.at[1]);
      const lift0 = basementRaise(m.at[0], m.at[1]);
      g.position.set(x, SLAB + lift0, z);
      g.rotation.y = FACE_ROT[m.face] || 0;
      floorGroups[0].add(g);
      const st = MACHINE_STATIONS.basement[i] || [], p0 = people.length;
      if (m.kind === 'press') buildPress(g, i, m.units || 4, m.len); else if (m.kind === 'diecut-big') buildDieCutBig(g, i, m.len); else if (m.kind === 'cutter') buildCutter(g, i, m.len, m.dep); else if (m.kind === 'folder') buildFolder(g, i, m.len, m.dep); else buildDieCut(g, i);
      hazardTape(g, SLAB + lift0 + 0.012);
      // Name painted on the floor behind the machine, far enough back that
      // the machine itself doesn't hide it from the usual camera angle.
      const sideways = m.face === 'up' || m.face === 'down';
      const depth = m.kind === 'folder' ? m.len : m.kind === 'cutter' ? (sideways ? m.dep : m.len) : m.kind === 'press' ? 2.2 : m.kind === 'diecut-big' ? (sideways ? (m.len || 5) : 2.4) : (sideways ? 1.8 : 1.5);
      crews.push({ g, station: st[0], name: st[1], built: people.slice(p0), depth });
      const name = st[1] || (m.kind === 'folder' ? 'FOLDING' : m.kind === 'cutter' ? 'CUTTING' : m.stage === 1 ? (m.units ? m.units + '-UNIT PRESS' : 'PRINTING') : m.kind === 'diecut' ? 'DIE CUT' : 'DIE CUTTING');
      const lab = decal(name, name.length * 0.5, 0.75, STAGE_COLOR[m.stage] || '#374151', { size: 0.62 });
      lab.rotation.x = -Math.PI / 2; lab.position.set(x, SLAB + lift0 + 0.02, z + (m.face === 'up' || m.kind === 'folder' ? 1 : -1) * (depth / 2 + (m.kind === 'diecut' ? 1.0 : 1.5))); lab.renderOrder = 1; floorGroups[0].add(lab);
    });
    GROUND_MACHINES.forEach((m, i) => {
      const g = new THREE.Group(), at = machinePos(m), lift = groundRaise(m.at[1]);
      g.position.set(at.x, SLAB + lift, at.z);
      g.rotation.y = FACE_ROT[m.face] || 0;
      floorGroups[1].add(g);
      const n = MACHINES.length + i, st = MACHINE_STATIONS.ground[i] || [], p0 = people.length;
      if (m.kind === 'coater') buildCoater(g, n, m.len); else if (m.kind === 'inspection') buildInspection(g, n, m.len); else if (m.kind === 'laminator') buildLaminator(g, n, m.len);
      else if (m.kind === 'ctp') buildCTP(g, n, m.len); else buildProcessor(g, n, m.len);
      hazardTape(g, SLAB + lift + 0.012, floorGroups[1]);
      crews.push({ g, station: st[0], name: st[1], built: people.slice(p0), depth: 2.4 });
      if (m.label) {
        const name = st[1] || { coater: 'COATING', inspection: 'INSPECTION', laminator: 'LAMINATION', ctp: 'CTP' }[m.kind];
        const lab = decal(name, name.length * 0.5, 0.75, '#374151', { size: 0.62 });
        lab.rotation.x = -Math.PI / 2; lab.position.set(at.x + m.label[0], SLAB + lift + 0.02, at.z + m.label[1]); lab.renderOrder = 1; floorGroups[1].add(lab);
      }
    });

    FIRST_MACHINES.forEach((m, i) => {
      const g = new THREE.Group(), at = machinePos(m);
      g.position.set(at.x, SLAB, at.z);
      g.rotation.y = FACE_ROT[m.face] || 0;
      floorGroups[2].add(g);
      const n = MACHINES.length + GROUND_MACHINES.length + i, st = MACHINE_STATIONS.first[i] || [], p0 = people.length;
      if (m.kind === 'gluer') buildGluer(g, n, m.len); else buildLaminator(g, n, m.len);
      hazardTape(g, SLAB + 0.012, floorGroups[2]);
      crews.push({ g, station: st[0], name: st[1], built: people.slice(p0), depth: 2.2 });
      if (m.label) {
        const name = st[1] || m.name || { gluer: 'FOLDER GLUER', laminator: 'LAMINATION' }[m.kind];
        const lab = decal(name, name.length * 0.5, 0.75, '#374151', { size: 0.62 });
        lab.rotation.x = -Math.PI / 2; lab.position.set(at.x + m.label[0], SLAB + 0.02, at.z + m.label[1]); lab.renderOrder = 1; floorGroups[2].add(lab);
      }
    });
    // Breaking and sorting tables, operators along both sides.
    WORK_TABLES.forEach(T => {
      const x1 = wx(PLAN_G, T.from[0]), z1 = wz(PLAN_G, T.from[1]), x2 = wx(PLAN_G, T.to[0]), z2 = wz(PLAN_G, T.to[1]);
      const len = Math.hypot(x2 - x1, z2 - z1), g = new THREE.Group();
      g.position.set((x1 + x2) / 2, SLAB, (z1 + z2) / 2); g.rotation.y = -Math.atan2(z2 - z1, x2 - x1); floorGroups[2].add(g);
      box(len, 0.08, 1.1, 0xd6d3d1, 0, 0.86, 0, g);                                           // table top
      for (const lx of [-len / 2 + 0.15, len / 2 - 0.15]) for (const lz of [-0.45, 0.45]) box(0.08, 0.82, 0.08, 0x6b7280, lx, 0.41, lz, g);
      const per = Math.max(2, Math.round(len / 1.4)), p0 = people.length;
      for (let k = 0; k < per; k++) {
        const px = -len / 2 + len * (k + 0.5) / per;
        box(0.7, 0.18, 0.5, 0xffffff, px, 1.0, 0, g);                                         // sheets on the table
        person(px, -0.95, 0, g); person(px, 0.95, Math.PI, g);
      }
      if (T.name === 'SORTING') crews.push({ g, station: 'SORTING', built: people.slice(p0), depth: 2.0 });
      const lab = decal(T.name + ' TABLE', 6, 0.8, '#374151', { size: 0.6 });
      lab.rotation.x = -Math.PI / 2; lab.position.set((x1 + x2) / 2, SLAB + 0.02, (z1 + z2) / 2 - 2.1); lab.renderOrder = 1; floorGroups[2].add(lab);
    });

    for (const [key, zones] of Object.entries(FLOW_ZONES)) {
      const [col, txt, label] = ZONE_STYLE[key];
      zones.forEach(([f, r], zi) => {
        const pl = floorPlan(f), x0 = wx(pl, r[0]), z0 = wz(pl, r[1]), x1 = wx(pl, r[2]), z1 = wz(pl, r[3]);
        const y = SLAB + floorRaise(f, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2) + 0.02, grp = floorGroups[f];
        for (const [w, d, x, z] of [[x1 - x0, 0.16, (x0 + x1) / 2, z0], [x1 - x0, 0.16, (x0 + x1) / 2, z1], [0.16, z1 - z0, x0, (z0 + z1) / 2], [0.16, z1 - z0, x1, (z0 + z1) / 2]]) box(w, 0.03, d, col, x, y, z, grp, false);
        if (zi === 0 || (x1 - x0) > 5) {
          const lab = decal(label, Math.min(x1 - x0 - 0.4, label.length * 0.42), 0.6, txt, { size: 0.62 });
          lab.rotation.x = -Math.PI / 2; lab.position.set((x0 + x1) / 2, y + 0.01, z0 + 0.5); lab.renderOrder = 1; grp.add(lab);
        }
      });
    }
    const nameTag = text => {
      const t = canvasTex(256, 64, (g, w, h) => {
        g.fillStyle = 'rgba(255,255,255,.96)'; rrect(g, 4, 6, w - 8, h - 12, 14); g.fill();
        g.strokeStyle = '#2563eb'; g.lineWidth = 3; rrect(g, 4, 6, w - 8, h - 12, 14); g.stroke();
        g.fillStyle = '#0f172a'; g.font = `800 28px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 1, w - 22);
      });
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true }));
      sp.scale.set(1.8, 0.45, 1); sp.position.y = 2.65; sp.renderOrder = 4;
      return sp;
    };
    const crewExtras = [];
    const recoloured = [];
    const paint = (who, c) => { if (who && who.userData.body) { who.userData.body.material = mat(c); recoloured.push(who); } };
    const applyOperators = list => {
      for (const w of recoloured) if (w.userData.body) w.userData.body.material = mat(STAFF_BLACK);
      recoloured.length = 0;
      for (const x of crewExtras) {
        if (x.isSprite) { const k = textures.indexOf(x.material.map); if (k >= 0) textures.splice(k, 1); x.material.map.dispose(); x.material.dispose(); }
        else { const k = people.indexOf(x); if (k >= 0) people.splice(k, 1); }
        if (x.parent) x.parent.remove(x);
      }
      crewExtras.length = 0;
      // Every person on the operators list, by station (signed-in staff only - no names in this file).
      const byStation = new Map(), roster = [];
      const addP = (station, name, roles, manager) => {
        const k = String(station || '').trim().toUpperCase(), nm = String(name || '').trim();
        if (!k || !nm) return;
        if (!byStation.has(k)) byStation.set(k, []);
        if (byStation.get(k).some(x => x.toLowerCase() === nm.toLowerCase())) return;
        byStation.get(k).push(nm); roster.push({ station: k, name: nm, roles: roles || [], manager: !!manager });
      };
      for (const o of list || []) if (o && o.machine && o.name) addP(o.machine, o.name, o.roles, o.manager);
      for (const c of crews) {
        if (!c.station) continue;
        (byStation.get(String(c.station).toUpperCase()) || []).forEach((nm, k) => {
          let who = c.built[k];
          if (!who) { const e = k - c.built.length; who = person(-1.4 + e * 1.1, c.depth / 2 + 1.1, Math.PI, c.g); crewExtras.push(who); }
          paint(who, OPERATOR_BLUE);
          const tagS = nameTag(nm); who.add(tagS); crewExtras.push(tagS);
        });
      }
      // Line managers (one per production floor) and QC (at the ready areas), in red.
      const placed = new Set();
      const standAt = (f, px, py, nm, face) => {
        const pl = floorPlan(f), who = person(wx(pl, px), wz(pl, py), face || 0, floorGroups[f], MANAGER_RED);
        who.position.y = SLAB + floorRaise(f, px, py) + 0.3; crewExtras.push(who);
        const tagS = nameTag(nm); who.add(tagS); crewExtras.push(tagS); placed.add(nm.toLowerCase());
      };
      const MANAGER_SPOTS = [[0, 640, 560], [2, 700, 600], [1, 600, 430]];
      roster.filter(r => r.manager).forEach((r, i) => { if (!placed.has(r.name.toLowerCase()) && i < MANAGER_SPOTS.length) standAt(MANAGER_SPOTS[i][0], MANAGER_SPOTS[i][1], MANAGER_SPOTS[i][2], r.name); });
      const QC_SPOTS = [[1, 620, 400], [2, 540, 590], [1, 700, 400], [2, 560, 640]];
      let q = 0;
      roster.filter(r => !r.manager && r.roles.includes('storage')).forEach(r => { if (!placed.has(r.name.toLowerCase()) && q < QC_SPOTS.length) { const sp = QC_SPOTS[q++]; standAt(sp[0], sp[1], sp[2], r.name, Math.PI); } });
    };
    applyOperators(opts.operators || []);

    // Which floors show: all (see-through upper slabs) or just one.
    let floorFocus = null;
    const setFloorFocus = f => {
      floorFocus = f;
      floorGroups.forEach((g, i) => { g.visible = f == null || i === f; });
      sharedParts.forEach(sp => { sp.g.visible = f == null || sp.floors.includes(f); });
      towerGroups.forEach(t => { t.g.visible = f == null || t.floors.includes(f); });
      frame.visible = f == null; facade.visible = f == null;
      for (const m of [groundMat, yardMat]) { m.opacity = f === 0 ? 0.15 : 1; m.depthWrite = f !== 0; }
      slabMats.forEach((m, i) => { m.opacity = (f != null || i === 0) ? 1 : 0.62; });
      for (const p of pallets.values()) p.g.visible = f == null || p.floor == null || p.floor === f;
      for (const w of wanderers) w.f.visible = f == null || w.floor == null || w.floor === f;
    };
    // Ready Stock: every ready order stands on the floor as its cartons (see fillPallet).
    floorDecal('MIL JOBS READY TO SHIP', 13, 1.2, '#166534', (READY.x0 + READY.x1) / 2, READY.z1 - 1.0, { size: 0.55 });
    for (const dx of DOCKS) {
      box(3.8, 0.12, 1.2, 0xfacc15, dx, 0.33, READY.z1 - 0.9, scene, false);
      for (const s of [-1.3, 1.3]) box(0.4, 0.8, 0.35, 0x111827, dx + s, 0.7, READY.z1 + 0.35, scene);
    }
    // No waiting area for new jobs - not needed (owner, 2026-10-24).

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
    // Hand lifters that carry pallets between stages (owner, 2026-10-24), reused.
    const moverPool = [];
    const takeMover = () => { const m = moverPool.pop() || handLifter(false); m.visible = true; return m; };
    const giveMover = m => { if (!m) return; m.visible = false; moverPool.push(m); };
    const LIFTER_AISLES = [               // [plan, floor, step height, aisles]
      [PLAN_B, 0, BASE_RAISE, [[470, 300, 640, 560]]],
      [PLAN_B, 0, 0, [[875, 760, 985, 792], [735, 800, 830, 1100]]],
      [PLAN_G, 1, 0, [[360, 180, 500, 700], [530, 370, 860, 500]]],
      [PLAN_P, 1, FRONT_RAISE, [[215, 262, 380, 400]]],
      [PLAN_G, 2, 0, [[360, 180, 500, 700], [600, 470, 1040, 590], [640, 262, 1000, 296]]],
    ];
    LIFTER_AISLES.forEach(([pl, floor, raise, areas]) => areas.forEach((r, k) => {
      const a = planArea(pl, r[0], r[1], r[2], r[3]);
      const w = wander(a, [(a.x0 + a.x1) / 2, (a.z0 + a.z1) / 2], floor, handLifter((k + floor) % 2 === 0), raise);
      w.speed = 1.7;
    }));
    wander({ x0: INV.x0 + 3, x1: INV.x1 - 3, z0: INV.z1 - 4.2, z1: INV.z1 - 1.8 }, [INV.x0 + 12, INV.z1 - 3]);   // the store's forklift
    const loader = wander({ x0: READY.x0 + 3, x1: READY.x1 - 3, z0: READY.z0 + 6, z1: READY.z1 - 3 }, [READY.x0 + 14, READY.z1 - 3]);

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
    const departCurve = dx => curve([P(dx, DOCK_Z), P(dx, DOCK_Z + 6), P((dx + gx) / 2 + 2, GATE.z - 6), P(gx - 1, GATE.z - 2), P(gx, GATE.z + 2), P(gx + 4, ROAD_Z + 2.3), P(gx + 20, ROAD_Z + 2.4), P(gx + 150, ROAD_Z + 2.4)]);
    const returnCurve = dx => curve([P(gx + 130, ROAD_Z - 2.4), P(gx + 16, ROAD_Z - 2.4), P(gx + 3, ROAD_Z - 2), P(gx + 1, GATE.z + 1), P(gx - 2, GATE.z - 5), P(dx + 10, DOCK_Z + 13), P(dx - 3, DOCK_Z + 12), P(dx - 7, DOCK_Z + 8), P(dx - 4, DOCK_Z + 6.2), P(dx + 7, DOCK_Z + 7.6)]);
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
      g.scale.setScalar(place === 0 ? 1 : PALLET_SCALE);   // smaller pallets (owner, 2026-10-24)
      if (place === 0) {
        // CTP: the job's steel plates on a plate table, not a pallet (owner,
        // 2026-10-24) - Plates on the job card (1 if blank); 4 = C M Y K,
        // any other count in other colours.
        const q = parseInt(String(((p.job.particulars || {}).plates || {}).quantity || '').replace(/[^0-9]/g, ''), 10);
        const n = Math.max(1, Math.min(12, Number.isFinite(q) && q > 0 ? q : 1));
        const cols = n === 4 ? [0x00aeef, 0xec008c, 0xfff200, 0x231f20] : [0xf97316, 0x16a34a, 0x7c3aed, 0xdc2626, 0x0891b2, 0xca8a04, 0xdb2777, 0x2563eb, 0x65a30d, 0x9333ea, 0xea580c, 0x0d9488];
        box(1.8, 0.06, 1.3, 0x6b7280, 0, 0.72, 0, g);                                            // plate table
        for (const lx of [-0.8, 0.8]) for (const lz of [-0.55, 0.55]) box(0.06, 0.7, 0.06, 0x374151, lx, 0.36, lz, g);
        for (let k = 0; k < n; k++) {
          const ox = (k - (n - 1) / 2) * 0.07, y = 0.78 + k * 0.03;
          box(1.4, 0.016, 1.0, 0xc0c7d1, ox, y, 0, g);                                            // aluminium plate
          box(1.34, 0.006, 0.94, cols[k % cols.length], ox, y + 0.011, 0, g, false);               // its colour (the image)
        }
      } else box(2.4, 0.18, 2.0, 0xc08a57, 0, 0.09, 0, g);
      if (place === 0) { /* plates drawn above */ } else if (place === 'wait') {
        box(2.1, 0.7, 1.7, 0xffffff, 0, 0.53, 0, g); box(2.12, 0.08, 1.72, 0xe2e8f0, 0, 0.6, 0, g, false);
      } else if (place === 'ready' && readyCartonsLeft(p.job) > 0) {
        const n = Math.min(96, readyCartonsLeft(p.job)), per = 16;
        for (let k = 0; k < n; k++) {
          const l = Math.floor(k / per), c = k % per;
          box(0.52, 0.4, 0.44, (l + c) % 2 ? 0xc9a26b : 0xbf9660, ((c % 4) - 1.5) * 0.56, 0.39 + l * 0.42, (Math.floor(c / 4) - 1.5) * 0.46, g);
        }
        p.readyN = readyCartonsLeft(p.job);
      // Cartons only once ready: sorting and pasting still carry printed sheets /
      // blanks - unit cartons are packed after folder gluing (owner, 2026-10-24).
      } else if (place === 'ready') {
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
      p.top = top * g.scale.y;
      g.traverse(o => { if (o.isMesh) o.userData.jobId = p.job.id; });
    };
    const ringGeo = new THREE.RingGeometry(1.75, 2.05, 36); geos.add(ringGeo);
    const setTag = (p) => {
      const j = p.job, blocked = isBlocked(j), urgent = /urgent/i.test(String(j.priority || ''));
      const tone = blocked ? 'red' : (selectedId === j.id ? 'blue' : (urgent ? 'amber' : ''));
      const rc = jobPlace(j) === 'ready' ? readyCartonsLeft(j) : 0;
      const sub = blocked ? 'Blocked' : (urgent ? 'Urgent' : rc > 0 ? rc.toLocaleString() + ' carton' + (rc === 1 ? '' : 's') : jobPlace(j) === 0 ? 'Plates' : clip(j.name || '', 20));
      const title = jobPlace(j) === 'ready' && j.stock_group_name ? clip(j.stock_group_name, 18) : 'E-' + j.id;   // job number; a MIL job in the Ready Store: its MIL name (owner, 2026-10-24)
      const key = title + '|' + sub + '|' + tone;
      if (p.tagKey === key) return;
      disposeSprite(p.tag); disposeSprite(p.tagS);
      // Two tags: the full one for close up, a title-only one for the
      // overview so neighbouring pallets' tags don't pile on each other.
      p.tag = tag(title, sub, tone); p.tagS = tag(title, '', tone, 2.5); p.tagKey = key;
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
      const addTo = (k, p) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); };
      for (const p of pallets.values()) { if (p.leaving) continue; addTo(zoneKeyFor(p.job, p.place), p); }
      for (const [k, list] of [...groups]) if (k.startsWith('press:')) {
        list.sort((a, b) => a.job.id - b.job.id);
        list.splice(pressSpots(+k.slice(6)).length).forEach(p => addTo('printx', p));
      }
      for (const [k, list] of groups) {
        list.sort((a, b) => a.job.id - b.job.id);
        list.forEach((p, i) => {
          const s = zoneSlot(k, i);
          p.stag = i % 2;
          const to = new THREE.Vector3(s.x, (s.y || 0) + (s.floor == null ? 0.3 : SLAB) + s.lift * 1.6, s.z);
          p.floor = s.floor;
          p.g.visible = floorFocus == null || p.floor == null || p.floor === floorFocus;
          if (instant || !p.placed) { p.g.position.copy(to); p.placed = true; p.move = null; p.floorWas = s.floor; return; }
          if (p.g.position.distanceTo(to) < 0.01) return;
          const from = p.g.position.clone(), dist = from.distanceTo(to), f0 = p.floorWas;
          p.floorWas = s.floor;
          // Inside the building: an operator walks it there with a hand
          // lifter, using the lift between floors (owner, 2026-10-24).
          if (f0 != null && s.floor != null && !reduceMotion) {
            const pts = [from];
            if (f0 !== s.floor) {
              const y0 = from.y, y1 = to.y;
              pts.push(new THREE.Vector3(LIFT_X, y0, LIFT_DOOR_Z), new THREE.Vector3(LIFT_X, y0, LIFT_Z), new THREE.Vector3(LIFT_X, y1, LIFT_Z), new THREE.Vector3(LIFT_X, y1, LIFT_DOOR_Z));
            }
            pts.push(to);
            p.move = { path: pts, seg: 0, segT: 0, rot: 0, refill: p.pendingFill };
            return;
          }
          const arc = inReady(from) !== inReady(to) || Math.abs(from.z - to.z) > 9 || Math.abs(from.y - to.y) > 1 ? 9 : Math.min(1.2, 0.2 + dist * 0.08);
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
      loaderJob = { q, tr, crate, phase: 'toStack', from: q.fromPos || new THREE.Vector3(READY.x0 + 10, 0.3, READY.z0 + 12) };
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
      overview: { target: [-50, 1, 0], az: 0.32, el: 0.7, dist: 230 },
      basement: { target: [BX, FLOOR_Y[0], BZ], az: 0.22, el: 1.0, dist: 112, floor: 0 },
      ground: { target: [BX, FLOOR_Y[1], BZ], az: 0.22, el: 1.0, dist: 112, floor: 1 },
      first: { target: [BX, FLOOR_Y[2], BZ], az: 0.22, el: 1.0, dist: 112, floor: 2 },
      roof: { target: [BX, FLOOR_Y[3], BZ - 6], az: 0.3, el: 0.8, dist: 100, floor: 3 },
      ready: { target: [(READY.x0 + READY.x1) / 2, 0, (READY.z0 + READY.z1) / 2 + 3], az: 0.3, el: 0.9, dist: 74 },
      inventory: { target: [(INV.x0 + INV.x1) / 2, 0, (INV.z0 + INV.z1) / 2 + 2], az: 0.12, el: 1.0, dist: 92 },
    };
    const want = { target: cam.target.clone(), az: cam.az, el: cam.el, dist: cam.dist };
    // Phones held upright: turn the yard side-on so the row of buildings runs
    // up the screen instead of off both edges.
    const TALL_VIEWS = {
      overview: { target: [-38, 1, 12], az: 0.5, el: 1.0, dist: 270 },
      basement: { target: [BX, FLOOR_Y[0], BZ], az: 1.2, el: 1.0, dist: 125, floor: 0 },
      ground: { target: [BX, FLOOR_Y[1], BZ], az: 1.2, el: 1.0, dist: 125, floor: 1 },
      first: { target: [BX, FLOOR_Y[2], BZ], az: 1.2, el: 1.0, dist: 125, floor: 2 },
      roof: { target: [BX, FLOOR_Y[3], BZ - 6], az: 1.2, el: 0.9, dist: 125, floor: 3 },
      ready: { target: [(READY.x0 + READY.x1) / 2, 0, READY.z1 - 4], az: 1.05, el: 0.86, dist: 82 },
      inventory: { target: [(INV.x0 + INV.x1) / 2, 0, (INV.z0 + INV.z1) / 2], az: 1.1, el: 0.9, dist: 130 },
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
    ui.views.innerHTML = '<button data-v="overview">Overview</button><button data-v="basement">Basement</button><button data-v="ground">Ground</button><button data-v="first">1st Floor</button><button data-v="roof">2nd Floor</button><button data-v="ready">Ready Stock</button><button data-v="inventory">Inventory</button>';
    ui.bar = document.createElement('div'); ui.bar.className = 'saa-bar';
    ui.msg = document.createElement('div'); ui.msg.className = 'saa-empty'; ui.msg.style.display = 'none'; ui.msg.style.pointerEvents = 'none';
    ui.pop = document.createElement('div'); ui.pop.className = 'saa-pop'; ui.pop.style.display = 'none';
    host.append(ui.top, ui.bar, ui.msg, ui.pop);
    hideStockPop = () => { ui.pop.style.display = 'none'; };
    // Stats + view buttons beside the view, under the date, when the page
    // has room on the right; otherwise over the view as before (owner, 2026-10-24).
    const layoutTop = () => {
      const r = host.getBoundingClientRect(), space = window.innerWidth - r.right;
      if (active && r.width > 0 && space >= 200) {
        if (ui.top.parentNode !== document.body) document.body.append(ui.top);
        ui.top.classList.add('saa-side');
        const d = document.getElementById('app-date'), db = d && d.offsetParent !== null ? d.getBoundingClientRect() : null;
        ui.top.style.top = Math.round(db && db.height ? db.bottom + 12 : Math.max(12, r.top)) + 'px';
        ui.top.style.width = Math.round(Math.min(230, space - 28)) + 'px';
      } else {
        if (ui.top.parentNode !== host) host.prepend(ui.top);
        ui.top.classList.remove('saa-side'); ui.top.style.top = ''; ui.top.style.width = '';
      }
    };
    window.addEventListener('resize', layoutTop);
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
        `<div class="saa-facts">${j.ref ? `<span><i>PO</i> ${esc(j.ref)}</span>` : ''}${j.bno ? `<span><i>Batch</i> ${esc(j.bno)}</span>` : ''}${j.qty ? `<span><i>Qty</i> ${esc(j.qty)}</span>` : ''}${place === 'ready' && readyCartonsLeft(j) > 0 ? `<span><i>In store</i> ${readyCartonsLeft(j).toLocaleString()} cartons</span>` : ''}${num(j._readyQty) ? `<span><i>Ready</i> ${num(j._readyQty).toLocaleString()}</span>` : ''}${shipped ? `<span><i>Shipped</i> ${shipped.toLocaleString()}</span>` : ''}${j.deadline ? `<span><i>Due</i> ${esc(j.deadline)}</span>` : ''}</div>` +
        `<div class="saa-track">${steps}</div>` +
        (blocked && blockNote(j) ? `<div class="saa-note">On hold: ${esc(blockNote(j))}</div>` : '');
      ui.bar.querySelector('.saa-x').onclick = () => { select(null); setView(viewName === 'focus' ? 'overview' : viewName); };
    };
    const select = id => {
      const prev = selectedId; selectedId = id;
      if (popTarget && (popTarget.ready || popTarget.job || popTarget.machine)) { popTarget = null; ui.pop.style.display = 'none'; }
      for (const k of [prev, id]) { const p = k != null && pallets.get(k); if (p) setTag(p), placeTag(p); }
      if (id != null) {
        const p = pallets.get(id);
        // The job's card pops up where its pallet stands - no zoom (owner, 2026-10-24).
        if (p && p.place === 'ready') showReadyPop(p);
        else if (p) showJobPop(p);
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
    // Zoom toward a screen point (owner, 2026-10-24): the spot under the
    // cursor stays under it, and you can get right up to a machine.
    const MIN_DIST = 5, MAX_DIST = 300;
    const zoomPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), zoomHit = new THREE.Vector3();
    const zoomAt = (cx, cy, factor) => {
      const nd = Math.max(MIN_DIST, Math.min(MAX_DIST, want.dist * factor));
      if (nd === want.dist) return;
      const r = el.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      zoomPlane.constant = -want.target.y;
      if (ray.ray.intersectPlane(zoomPlane, zoomHit)) {
        const t = 1 - nd / want.dist;   // in: slide toward the spot; out: away from it
        want.target.x += (zoomHit.x - want.target.x) * t;
        want.target.z += (zoomHit.z - want.target.z) * t;
      }
      want.dist = nd; lastInput = clock;
    };
    // Store items: the card or any pallet of the item.
    const pickStock = (cx, cy) => {
      if (!stockPick.length) return null;
      const r = el.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(stockPick, false)[0];
      if (!hit) return null;
      if (hit.object.isSprite) return hit.object.userData.stockBay;
      return hit.instanceId != null ? stockInstBay[hit.instanceId] : null;
    };
    const selectStock = bi => {
      const prev = stockSel != null ? stockTiles.find(T => T.sprite.userData.stockBay === stockSel) : null;
      if (prev) { prev.popped = false; prev.sprite.scale.set(2.9, 2.9 * 170 / 400, 1); prev.sprite.renderOrder = 5; }
      stockSel = bi;
      const T = bi != null ? stockTiles.find(t => t.sprite.userData.stockBay === bi) : null;
      if (!T) { stockSel = null; popTarget = null; ui.pop.style.display = 'none'; renderBar(); return; }
      // The card pops up over the view at the item; the camera stays put (owner, 2026-10-24).
      T.popped = true; T.sprite.scale.set(3.4, 3.4 * 170 / 400, 1); T.sprite.renderOrder = 12;
      lastInput = clock;
      const it = T.item, tone = (STOCK_TYPES[it.type] || ['#475569'])[0];
      ui.pop.style.setProperty('--tone', tone);
      ui.pop.innerHTML =
        `<div class="saa-pop-h">${esc(it.type.toUpperCase())}${it.offcut ? '<span class="off">OFFCUT</span>' : ''}<button title="Close" aria-label="Close">&times;</button></div>` +
        `<div class="saa-pop-b"><div class="saa-pop-size"><b>${esc(it.size || '?')}</b>${it.gsm ? `<span>${esc(it.gsm)} GSM</span>` : ''}</div>` +
        `<div class="saa-pop-row"><i>Brand</i><b>${esc(it.brand || '—')}</b></div>` +
        `<div class="saa-pop-row"><i>Supplier</i><b>${esc(it.supplier || '—')}</b></div>` +
        `<div class="saa-pop-row bal"><i>Balance</i><b>${esc(stockBalance(it))}</b></div></div>`;
      ui.pop.querySelector('button').onclick = ev => { ev.stopPropagation(); selectStock(null); };
      ui.pop.style.display = '';
      ui.pop.style.animation = 'none'; void ui.pop.offsetWidth; ui.pop.style.animation = '';
      popTarget = { obj: T.sprite, dy: 0.8 };
      placeStockPop();
      ui.bar.innerHTML =
        `<div class="saa-head"><b>${esc(it.type.toUpperCase())} · ${esc(it.size || '?')}${it.gsm ? ' · ' + esc(it.gsm) + ' gsm' : ''}${it.offcut ? ' · OFFCUT' : ''}</b><span>Inventory store</span><button class="saa-x" title="Close" aria-label="Close">&times;</button></div>` +
        `<div class="saa-facts"><span><i>Brand</i> ${esc(it.brand || '—')}</span><span><i>Supplier</i> ${esc(it.supplier || '—')}</span><span><i>Balance</i> ${esc(stockBalance(it))}</span></div>`;
      ui.bar.querySelector('.saa-x').onclick = () => selectStock(null);
    };
    // Keep the pop-up over its item as the view turns / zooms; hidden when the item is behind the camera.
    const popV = new THREE.Vector3();
    const popRow = (k, v, cls) => `<div class="saa-pop-row${cls ? ' ' + cls : ''}"><i>${k}</i><b>${v}</b></div>`;
    const openPop = (tone, head, body, target) => {
      ui.pop.style.setProperty('--tone', tone);
      ui.pop.innerHTML = `<div class="saa-pop-h">${head}<button title="Close" aria-label="Close">&times;</button></div><div class="saa-pop-b">${body}</div>`;
      ui.pop.querySelector('button').onclick = ev => { ev.stopPropagation(); select(null); };
      popTarget = target;
      ui.pop.style.display = ''; ui.pop.style.animation = 'none'; void ui.pop.offsetWidth; ui.pop.style.animation = '';
      placeStockPop();
    };
    // A job's pallet: job no., product, company, PO qty, paper, to be printed.
    const showJobPop = p => {
      const j = p.job, sheets = num(j.sheets), ups = num(j.ups);
      const toPrint = sheets ? sheets.toLocaleString() + ' sheets' + (ups > 1 ? ' · ' + (sheets * ups).toLocaleString() + ' UC' : '') : '—';
      openPop('#1e40af', esc(String(STAGES[stageIndex(j)] || '').toUpperCase()),
        `<div class="saa-pop-size"><b>E-${esc(j.id)}</b></div>` + popRow('Product', esc(j.name || '—')) + popRow('Company', esc(j.client || '—')) +
        popRow('PO Qty', num(j.qty) ? num(j.qty).toLocaleString() : esc(j.qty || '—')) + popRow('Paper', esc(j.paper || '—')) + popRow('To print', esc(toPrint), 'bal') +
        (j.machine ? popRow('Machine', esc(j.machine)) : '') +
        (opts.onStage ? `<div class="saa-pop-act"><button data-d="-1" title="Move this job one stage back">&#9664; Stage back</button><button data-d="1" class="fwd" title="Move this job one stage forward">Stage forward &#9654;</button></div>` : ''),
        { obj: p.g, dy: (p.top || 1) + 2.4, job: true });
      if (opts.onStage) ui.pop.querySelectorAll('.saa-pop-act button').forEach(b => { b.onclick = ev => { ev.stopPropagation(); select(null); opts.onStage(j.id, +b.dataset.d); }; });
    };
    // A machine: the last job its station entered (any particulars row's entries).
    const whenOf = e => {
      const v = e && (e.at || e.time || e.date || e.created_at);
      if (!v) return NaN;
      const m = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
      return m ? new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)).getTime() : Date.parse(v);
    };
    const lastJobFor = c => {
      const n = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const keys = new Set([n(c.station), n(c.name)].filter(Boolean));
      let best = null;
      for (const j of jobs) {
        const parts = (j && j.particulars) || {};
        for (const [row, v] of Object.entries(parts)) {
          if (!v || !Array.isArray(v.entries)) continue;
          v.entries.forEach((e, k) => {
            if (!e || !keys.has(n(e.machine))) return;
            const t = whenOf(e), rank = Number.isFinite(t) ? t : -1e15 + k;
            if (!best || rank > best.rank) best = { job: j, entry: e, row, rank, t };
          });
        }
      }
      return best;
    };
    const showMachinePop = c => {
      const last = lastJobFor(c);
      const body = `<div class="saa-pop-size"><b>${esc(c.name || c.station || 'Machine')}</b></div>` + (last
        ? popRow('Last job', 'E-' + esc(last.job.id)) + popRow('Product', esc(last.job.name || '—')) + popRow('Company', esc(last.job.client || '—')) +
          (last.entry.qty != null && last.entry.qty !== '' ? popRow('Entered', esc(String(last.entry.qty)), 'bal') : '') +
          (Number.isFinite(last.t) ? popRow('When', esc(new Date(last.t).toLocaleString())) : '')
        : popRow('Last job', 'No station entries yet'));
      openPop('#334155', 'MACHINE', body, { obj: c.g, dy: 3.6, machine: true });
    };
    const pickMachine = (cx, cy) => {
      const r = el.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const shown = o => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
      const hit = ray.intersectObjects(crews.map(c => c.g), true).find(h => shown(h.object));
      if (!hit) return null;
      for (let o = hit.object; o; o = o.parent) { const c = crews.find(cc => cc.g === o); if (c) return c.station || c.name ? c : null; }
      return null;
    };
    const showReadyPop = p => {
      const j = p.job, n = readyCartonsLeft(j), R = num(j._readyQty), D = shippedCartons(j), mil = !!j.stock_group_name;
      ui.pop.style.setProperty('--tone', '#166534');
      ui.pop.innerHTML =
        `<div class="saa-pop-h">${mil ? 'READY STORE' : 'READY TO SHIP'}<button title="Close" aria-label="Close">&times;</button></div>` +
        `<div class="saa-pop-b"><div class="saa-pop-size"><b>${mil ? esc(j.stock_group_name) : 'E-' + esc(j.id)}</b></div>` + (mil ? `<div class="saa-pop-row"><i>Job</i><b>E-${esc(j.id)}</b></div>` : '') +
        `<div class="saa-pop-row"><i>Product</i><b>${esc(j.name || '—')}</b></div>` +
        `<div class="saa-pop-row"><i>Company</i><b>${esc(j.client || '—')}</b></div>` +
        `<div class="saa-pop-row"><i>PO No.</i><b>${esc(j.ref || '—')}</b></div>` +
        (mil ? `<div class="saa-pop-row"><i>MIL Qty</i><b>${num(j._milQty) ? num(j._milQty).toLocaleString() : '—'}</b></div>` : `<div class="saa-pop-row"><i>PO Qty</i><b>${num(j.qty) ? num(j.qty).toLocaleString() : esc(j.qty || '—')}</b></div>`) +
        `<div class="saa-pop-row"><i>Ready Qty</i><b>${R ? R.toLocaleString() : '—'}</b></div>` +
        `<div class="saa-pop-row"><i>To deliver</i><b>${num(j._readyLeft) ? num(j._readyLeft).toLocaleString() : '—'}</b></div>` +
        `<div class="saa-pop-row bal"><i>Cartons</i><b>${n > 0 ? n.toLocaleString() : '—'}</b></div>` +
        (D ? `<div class="saa-pop-row"><i>Shipped</i><b>${D.toLocaleString()}</b></div>` : '') + '</div>';
      ui.pop.querySelector('button').onclick = ev => { ev.stopPropagation(); select(null); };
      popTarget = { obj: p.g, dy: (p.top || 1) + 2.4, ready: true };
      ui.pop.style.display = ''; ui.pop.style.animation = 'none'; void ui.pop.offsetWidth; ui.pop.style.animation = '';
      placeStockPop();
    };
    const placeStockPop = () => {
      if (!popTarget || !ui.pop || ui.pop.style.display === 'none') return;
      popTarget.obj.getWorldPosition(popV); popV.y += popTarget.dy; popV.project(camera);
      const w = host.clientWidth, h = host.clientHeight;
      if (popV.z > 1) { ui.pop.style.visibility = 'hidden'; return; }
      ui.pop.style.visibility = '';
      const x = Math.max(150, Math.min(w - 150, (popV.x + 1) / 2 * w)), y = Math.max(ui.pop.offsetHeight + 8, Math.min(h - 70, (1 - popV.y) / 2 * h));
      ui.pop.style.left = x + 'px'; ui.pop.style.top = y + 'px';
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
        if (pinch0 > 0) { zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch0 / d); pinch0 = d; }
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
        const sb = id == null ? pickStock(e.clientX, e.clientY) : null;
        if (sb != null) { if (selectedId != null) select(null); selectStock(sb === stockSel ? null : sb); }
        else { if (stockSel != null) selectStock(null); const mc = id == null ? pickMachine(e.clientX, e.clientY) : null; select(id); if (mc) showMachinePop(mc); }
        lastInput = clock;
      }
      drag = null;
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoomAt(e.clientX, e.clientY, 1 + Math.sign(dy) * Math.min(0.3, Math.abs(dy) * 0.002));
    }, { passive: false });

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
      if (!reduceMotion && selectedId == null && want.dist > 70 && clock - lastInput > 7) want.az = baseAz + Math.sin((clock - lastInput - 7) * 0.07) * 0.2;
      const k = 1 - Math.exp(-dt * 3.2);
      cam.target.lerp(want.target, k); cam.az += (want.az - cam.az) * k; cam.el += (want.el - cam.el) * k; cam.dist += (want.dist - cam.dist) * k;
      applyCamera();
      for (const T of stockTiles) T.sprite.position.y = T.y + (T.popped ? 0.5 : 0) + Math.sin(clock * 1.6 + T.phase) * 0.12;
      placeStockPop();
      // Pallets: pop in, glide between spots.
      for (const p of pallets.values()) {
        if (p.pop < 1) { p.pop = Math.min(1, p.pop + dt * 2.2); p.g.scale.setScalar(p.pop <= 0 ? 0.001 : Math.max(0.001, easeBack(p.pop))); }
        if (p.move && p.move.path) {
          const m = p.move, a = m.path[m.seg], b = m.path[m.seg + 1];
          if (!m.mover) m.mover = takeMover();
          const L = Math.max(0.001, a.distanceTo(b)), vert = Math.abs(b.y - a.y) > 0.5;
          m.segT = Math.min(1, m.segT + dt * (vert ? 1.6 : 2.6) / L);
          p.g.position.lerpVectors(a, b, m.segT); p.g.position.y += 0.12;
          if (!vert) { const dx = b.x - a.x, dz = b.z - a.z; if (dx * dx + dz * dz > 1e-6) m.rot = Math.atan2(dx, dz); }
          m.mover.position.set(p.g.position.x - Math.sin(m.rot) * 0.6, p.g.position.y - 0.12, p.g.position.z - Math.cos(m.rot) * 0.6);
          m.mover.rotation.y = m.rot; m.mover.visible = p.g.visible;
          if (m.segT >= 1) { m.seg++; m.segT = 0; }
          if (m.refill && m.seg >= Math.floor(m.path.length / 2)) { fillPallet(p); placeTag(p); m.refill = false; p.pendingFill = false; }
          if (m.seg >= m.path.length - 1) {
            p.g.position.copy(m.path[m.path.length - 1]);
            if (m.refill) { fillPallet(p); placeTag(p); p.pendingFill = false; }
            giveMover(m.mover); p.move = null;
          }
        } else if (p.move) {
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
      layoutTop();
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
      for (const j of d.added) { const place = jobPlace(j); if (place !== 'delivered' && place !== 'wait' && !pallets.has(j.id)) makePallet(j, place, first ? (n++) * 0.06 : 0); }
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
        if (!p) { if (mv.to !== 'delivered' && mv.to !== 'wait') makePallet(mv.job, mv.to, 0); continue; }
        if (mv.to === 'wait') { removePallet(p); continue; }
        if (mv.to === 'delivered') { if (!p.leaving) { p.leaving = true; enqueueDeparture(mv.job, 0, p.g.position.clone()); queue[queue.length - 1].onPicked = () => removePallet(p); } continue; }
        p.place = mv.to; p.pendingFill = true;
      }
      for (const p of pallets.values()) { const j = byId.get(p.job.id); if (j) { p.job = j; setTag(p); if (p.place === 'ready' && readyCartonsLeft(j) !== (p.readyN || 0)) p.pendingFill = true; } }
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
      setStock(items) { applyStock(items || []); },
      setOperators(list) { applyOperators(list || []); },
      setActive(on) {
        on = !!on;
        if (on === active) return;
        active = on;
        if (on) { last = performance.now(); raf = requestAnimationFrame(tick); resize(); }
        else if (raf) { cancelAnimationFrame(raf); raf = 0; }
        layoutTop();
      },
      destroy() {
        this.setActive(false);
        ro.disconnect();
        window.removeEventListener('resize', layoutTop);
        ui.top.remove();
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
    let real = null, pendingJobs = opts.jobs, pendingStock = opts.stock || [], pendingOps = opts.operators || [], wantActive = false, dead = false;
    const ctl = {
      company: opts.company,
      update(j) { if (real) real.update(j); else pendingJobs = j; },
      setStock(items) { if (real) real.setStock(items); else pendingStock = items || []; },
      setOperators(list) { if (real) real.setOperators(list); else pendingOps = list || []; },
      setActive(on) { wantActive = !!on; if (real) real.setActive(on); },
      destroy() { dead = true; if (real) real.destroy(); else host.innerHTML = ''; },
    };
    loadThree().then(THREE => {
      if (dead) return;
      host.innerHTML = '';
      real = createScene(THREE, host, Object.assign({}, opts, { jobs: pendingJobs, stock: pendingStock, operators: pendingOps }));
      ctl._debug = real._debug;
      real.setActive(wantActive);
    }).catch(() => {
      if (dead) return;
      host.innerHTML = '<div class="saa-msg">Couldn’t load the 3D view. Check the internet connection, then press Refresh.</div>';
    });
    return ctl;
  }

  window.SAAnimation = { mount, _test: { jobPlace, diffJobs, todaysShipments, slotFor, dayOf, shippedCartons, isBlocked, FLOORS, FLOOR_Y, RAISE, PLAN_P, TOWERS, stockLayout, INV } };
})();
