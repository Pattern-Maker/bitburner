import { CONFIG, loadConfig } from "./config.js";
import { scanAll, Ledger, buildModel, prepNeeds, solveStream, prepShape, isPrepped, drainPort, growAfterHack, batchGaps } from "./lib.js";

/**
 * Continuous, multi-target HWGW batcher.
 *
 * Each target gets a "lane". A batching lane lands one batch every P ms, and
 * every worker is launched just in time (its landing time minus its own
 * duration), so RAM is only held while a worker is actually running.
 *
 * Replanning (once per pipeline cycle, or when RAM / rooted servers change):
 *   - rank targets by income, discounted by how long they'd take to prep
 *   - give the best target the threads its equilibrium needs, the next best
 *     what's left, and so on (spillover); unprepped targets get prep threads
 *   - new plans only apply to batches created afterwards: nothing already in
 *     flight is ever resized or moved
 *
 * Every hack reports how much it took. If a hack takes less than planned, the
 * target drifted (out-of-order landing, or a level-up the plan didn't see), so
 * that lane stops, lets its batches land, re-preps and carries on.
 * @param {NS} ns
 */
export async function main(ns) {
  loadConfig(ns);
  ns.disableLog("ALL");
  const cfg = CONFIG;
  const W = cfg.workers;
  const files = Object.values(W);
  for (const f of files) {
    if (!ns.fileExists(f, "home")) {
      ns.tprint(`ERROR batcher: missing worker ${f} on home`);
      return;
    }
  }
  const scriptRam = {
    hack: ns.getScriptRam(W.hack, "home"),
    grow: ns.getScriptRam(W.grow, "home"),
    weaken: ns.getScriptRam(W.weaken, "home"),
    share: W.share ? ns.getScriptRam(W.share, "home") : 0,
    xp: W.xp ? ns.getScriptRam(W.xp, "home") : 0,
  };
  const reportPorts = [];
  for (let i = 0; i < (cfg.ports.reportPorts ?? 1); i++) reportPorts.push(cfg.ports.reports + i);
  for (const p of reportPorts) ns.clearPort(p);
  const ledger = new Ledger(ns, cfg, scriptRam, files);

  const TICK = 10; // ms between loop passes; workers time themselves, so this only sets launch lookahead
  const st = {
    // Landing gap. Fixed at the safe minimum: the game resolves landings in
    // due-time order however late it runs, so the only thing that can break
    // a batch's order is a worker starting too late, and that's handled by
    // launching earlier (the buffer), not by spreading landings out.
    spacing: cfg.spacingMinMs,
    lags: [], // ms between launching a worker and it scheduling its landing
    lagP99: 0,
    miss: { landed: 0, missed: 0 },
    msPerExec: 1,
    lanes: new Map(), // target -> lane
    pids: new Map(), // pid -> { target, kind, threads, batch }
    hosts: [],
    lates: [],
    pendingExp: [], // { land, exp } from formulas, for level prediction
    pendingExpTotal: 0, // running sum of pendingExp, so prediction is O(1) per batch
    nextReplan: 0,
    capacity: 0,
    ramKey: "",
    useFormulas: false,
    batchSeq: 0,
    session: { start: Date.now(), money: 0, desyncs: 0, batches: 0, aborted: 0 },
    // Stalls: the whole game paused (background tab throttled, autosave, PC
    // asleep). Workers alive during one land late through no fault of the
    // timing, so their lateness is ignored.
    lastStallAt: 0,
    stalls: { count: 0, lastMs: 0, lastAt: 0 },
    // Spare RAM lent out. pids: pid -> { host, threads, kind: "share" | "xp",
    // target (xp), home }. reserve: share of threads kept unlent; it grows
    // each time batches had to reclaim lent RAM unexpectedly, and eases back.
    // graceUntil: a target just finished prepping and is filling its
    // pipeline, so reclaims until then are expected and don't grow the reserve.
    share: { pids: new Map(), threads: 0, xpThreads: 0, xpTarget: null, xpRate: 0, use: "share", why: "", reserve: cfg.share?.reserveFraction ?? 0.1, reclaims: 0, graceUntil: 0 },
    // Script cap, tuned at runtime (see tuneSlots).
    slots: { cap: cfg.maxWorkerScripts, phase: "idle", before: null, cooldown: 0, history: [] },
    drifts: [], // recent drifts, for report.js
    modeLog: [], // recent lane mode changes, for report.js
    incomeLog: [], // { t, money } in 10 s buckets for the last 30 minutes
    repairs: 0,
    stockGrow: new Set(), // servers whose grows run with { stock: true }
    gone: new Map(), // pid -> info: ended without a report yet (see sweep)
    lastSweepAt: 0,
    lostReports: 0,
    lostHackReports: 0,
    hackIncome: [], // { t, total } samples of the game's own hacking income count
  };
  // Home's share, in GB, as the ledger needs it to keep that RAM out of batching.
  Object.defineProperty(ledger, "homeShareHeld", { get: () => (st.share.homeThreads ?? 0) * scriptRam.share });
  // How early workers are launched: enough for the gaps, the launch loop
  // itself, and twice the worst launch lag measured.
  const buffer = () => 4 * st.spacing + Math.max(Math.ceil(st.msPerExec * 8) + 2 * TICK, Math.ceil(2 * st.lagP99));

  let lastRefresh = 0;
  let lastSweep = 0;
  let lastPublish = 0;

  let lastLoop = Date.now();
  while (true) {
    const now = Date.now();
    // The loop sleeps 10 ms; if it slept for a second or more, the game stalled.
    if (now - lastLoop > 1000) {
      st.lastStallAt = now;
      st.stalls.count++;
      st.stalls.lastMs = now - lastLoop;
      st.stalls.lastAt = now;
      st.lates = [];
    }
    lastLoop = now;

    // Keep free RAM current; notice purchases, upgrades and new roots.
    if (now - lastRefresh >= 200 || st.hosts.length === 0) {
      if (st.hosts.length === 0) st.hosts = scanAll(ns).hosts;
      ledger.refresh(st.hosts);
      const key = ledger.hosts.map((h) => `${h.host}:${h.maxRam}`).join(",");
      const formulas = ns.fileExists("Formulas.exe", "home");
      if (st.ramKey && (key !== st.ramKey || formulas !== st.useFormulas)) requestReplan(st);
      st.ramKey = key;
      st.useFormulas = formulas;
      lastRefresh = now;
    }

    handleReports(ns, cfg, st, reportPorts);

    // Planning runs a few ms per tick so it never delays launches.
    if (st.planner) stepPlanner(ns, cfg, st, ledger, 4);
    else if (now >= st.nextReplan) startReplan(ns, cfg, st, ledger, buffer());

    const execT0 = Date.now();
    let execs = 0;
    const ctx = tickContext(ns, st);
    for (const lane of [...st.lanes.values()]) {
      // One target's problem must never take the whole batcher down: record
      // it, let that lane's workers land, and carry on with the rest.
      try {
        execs += stepLane(ns, cfg, st, ledger, lane, now, buffer(), TICK, ctx);
      } catch (e) {
        st.lastError = { at: Date.now(), target: lane.target, message: String(e?.message ?? e) };
        ns.print(`ERROR on ${lane.target}: ${st.lastError.message}`);
        setMode(st, lane, "drain", "error");
        lane.firstLand = 0;
        cancelQueued(lane);
        requestReplan(st);
      }
    }
    if (execs > 0) st.msPerExec = 0.8 * st.msPerExec + 0.2 * Math.max(0.05, (Date.now() - execT0) / execs);

    if (now - lastSweep >= 500) {
      sweep(ns, st);
      lastSweep = now;
    }
    if (now - lastPublish >= 500) {
      publish(ns, cfg, st, ledger, buffer());
      lastPublish = now;
    }
    await ns.sleep(TICK);
  }
}

// ------------------------------------------------------------------ plan ---

/**
 * Start a replan. The cheap parts happen now; the expensive part (an income
 * curve per target) is spread across ticks by stepPlanner, so planning never
 * blocks launches long enough to make workers late.
 */
function startReplan(ns, cfg, st, ledger, b) {
  const now = Date.now();
  // Sharing isn't stopped here: shared RAM counts as free for planning, and
  // after the plan only the excess is taken back (see startSharing), so the
  // rep boost doesn't dip at every replan.
  st.hosts = scanAll(ns).hosts;
  // Companies whose shares stocks.js holds: grows on their servers push the price up.
  const sp = ns.peek(cfg.ports.stocks ?? 0);
  st.stockGrow = new Set(sp !== "NULL PORT DATA" && sp?.growServers ? sp.growServers : []);
  ledger.refresh(st.hosts);
  st.ramKey = ledger.hosts.map((h) => `${h.host}:${h.maxRam}`).join(",");
  st.capacity = ledger.capacityThreads();

  const pct = (arr) => {
    const sorted = [...arr].sort((a, c) => a - c);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return { p50: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1], n: sorted.length, at: now };
  };
  // Game lag: how late landings resolve. Shown for interest only, since it
  // can't reorder a batch.
  if (st.lates.length >= 20) {
    st.lateStats = pct(st.lates);
    st.lates = [];
  }
  // Launch lag sets the buffer: twice the worst 1% (or worst, with few samples).
  if (st.lags.length >= 20) {
    st.lagStats = pct(st.lags);
    st.lagP99 = Math.max(0, st.lags.length >= 100 ? st.lagStats.p99 : st.lagStats.max);
    st.lags = [];
  }
  st.missStats = { ...st.miss, at: now };
  st.miss = { landed: 0, missed: 0 };
  st.spacing = cfg.spacingMinMs;

  const level = ns.getHackingLevel();
  const valid = st.hosts.filter(
    (h) =>
      h !== "home" &&
      ns.hasRootAccess(h) &&
      ns.getServerMaxMoney(h) > 0 &&
      ns.getServerRequiredHackingLevel(h) <= level &&
      !ns.getServer(h).purchasedByPlayer,
  );
  // Quick pre-filter so curves are only built for the likeliest targets.
  const quick = (h) => (ns.getServerMaxMoney(h) * ns.hackAnalyzeChance(h)) / ns.getWeakenTime(h);
  const short = valid
    .map((h) => ({ h, q: quick(h) }))
    .sort((a, c) => c.q - a.q)
    .slice(0, cfg.maxTargets)
    .map((x) => x.h);
  for (const t of st.lanes.keys()) if (valid.includes(t) && !short.includes(t)) short.push(t);

  // Threads our draining/retiring lanes still hold are not free for anyone
  // else until those workers land.
  const held = new Map();
  for (const info of st.pids.values()) held.set(info.target, (held.get(info.target) ?? 0) + info.threads);
  let reserved = 0;
  for (const [t, lane] of st.lanes) if (lane.mode === "drain" || lane.mode === "retire" || lane.pre) reserved += held.get(t) ?? 0;
  const capacity = Math.max(0, st.capacity - reserved);

  const N = cfg.switchPaybackCycles;
  const cands = short.map((t) => {
    const m = buildModel(ns, t, st.useFormulas);
    m.hgw = cfg.batchType === "hgw";
    const lane = st.lanes.get(t);
    const ready = lane ? lane.mode === "batch" : isPrepped(ns, t);
    return {
      t,
      m,
      ready,
      batching: !!lane && lane.mode === "batch",
      need: ready ? null : prepNeeds(ns, m),
      weakenNow: ns.getWeakenTime(t),
      horizon: N * (m.weakenTime + b),
      curve: [],
    };
  });

  // Curve resolution: K chunks of the capacity.
  const K = Math.max(1, Math.min(cfg.planChunks, capacity));
  st.planner = {
    b,
    cands,
    capacity,
    K,
    chunk: capacity / K,
    // Scripts per batch: one per landing plus some for operations split
    // across servers.
    maxInFlight: Math.max(1, Math.floor(st.slots.cap / (cfg.batchType === "hgw" ? 4 : 5))),
    ci: 0,
    j: 0,
    started: now,
    ticks: 0,
  };
}

/** Income per ms a target would make with `budget` threads (0 if none). */
function curveValue(st, cfg, P, c, budget) {
  if (budget < 1) return 0;
  // Script slots are a second limited resource. Each chunk of threads comes
  // with the same share of the slots, so a target can't assume it has them all.
  const plan = solveStream(c.m, Math.floor(budget), st.spacing, P.b, slotShare(P, budget));
  if (!plan) return 0;
  let v = plan.rate;
  if (!c.ready) {
    // It has to be prepped first: discount by the prep time this budget implies.
    const rounds = c.need.total > 0 ? Math.ceil(c.need.total / Math.floor(budget)) : 0;
    v *= c.horizon / (c.horizon + rounds * c.weakenNow);
  }
  if (c.batching) v *= 1 + 1 / cfg.switchPaybackCycles; // keep what's running unless clearly beaten
  return v;
}

/** In-flight batch slots that go with a thread budget. */
function slotShare(P, budget) {
  return Math.max(1, Math.floor((P.maxInFlight * budget) / Math.max(1, P.capacity)));
}

/** Build curve points until this tick's time budget runs out. Returns true when done. */
function stepPlanner(ns, cfg, st, ledger, msBudget) {
  const P = st.planner;
  const t0 = Date.now();
  P.ticks++;
  while (P.ci < P.cands.length) {
    if (Date.now() - t0 >= msBudget) return false;
    const c = P.cands[P.ci];
    c.curve[P.j] = curveValue(st, cfg, P, c, P.j * P.chunk);
    // Past the point where more threads stop helping, the curve is flat:
    // fill the rest without solving.
    if (P.j >= 2 && c.curve[P.j] <= c.curve[P.j - 1] * (1 + 1e-9) && c.curve[P.j - 1] <= c.curve[P.j - 2] * (1 + 1e-9) && c.curve[P.j] > 0) {
      for (let k = P.j + 1; k <= P.K; k++) c.curve[k] = c.curve[P.j];
      P.j = P.K + 1;
    } else P.j++;
    if (P.j > P.K) {
      P.ci++;
      P.j = 0;
    }
  }
  finishPlan(ns, cfg, st, ledger);
  return true;
}

/**
 * Marginal allocation: hand out the capacity a chunk at a time, each to the
 * target that gains the most income from it. Because a batch needs a minimum
 * number of threads before it earns anything, each step looks ahead: it picks
 * the target and number of chunks with the best average gain per chunk.
 * At the end every target sits where one more chunk would earn about the
 * same anywhere, which is where income across all targets is highest.
 */
function finishPlan(ns, cfg, st, ledger) {
  const P = st.planner;
  st.planner = null;
  const now = Date.now();
  const b = P.b;
  const alloc = P.cands.map(() => 0); // chunks per candidate
  const capped = P.cands.map(() => false);
  let left = P.K;
  const allocate = () => {
    while (left > 0) {
      let best = null;
      P.cands.forEach((c, i) => {
        if (capped[i]) return;
        const a = alloc[i];
        const base = c.curve[a] ?? 0;
        for (let j = 1; j <= left && a + j <= P.K; j++) {
          const gain = ((c.curve[a + j] ?? 0) - base) / j;
          if (gain > 0 && (!best || gain > best.gain)) best = { i, j, gain };
        }
      });
      if (!best) break; // nobody gains from more threads
      alloc[best.i] += best.j;
      left -= best.j;
    }
  };
  allocate();
  // A target that still has to prep only uses its prep threads until it's
  // ready (then a replan gives it its batching share). Hand the rest to the
  // other targets meanwhile, so several prep at once and ready ones batch,
  // instead of everything waiting behind one big target's prep.
  for (let pass = 0; pass < P.cands.length; pass++) {
    let freed = 0;
    P.cands.forEach((c, i) => {
      if (capped[i] || c.ready || alloc[i] === 0) return;
      const keep = Math.max(1, Math.ceil(c.need.total / P.chunk));
      capped[i] = true;
      if (alloc[i] > keep) {
        freed += alloc[i] - keep;
        alloc[i] = keep;
      }
    });
    if (freed === 0) break;
    left += freed;
    allocate();
  }

  const order = P.cands.map((c, i) => ({ c, B: Math.floor(alloc[i] * P.chunk), v: c.curve[alloc[i]] ?? 0 })).sort((x, y) => y.v - x.v);
  let inFlightLeft = P.maxInFlight;
  const keep = new Set();
  for (const { c, B } of order) {
    if (B < 1) continue;
    let lane = st.lanes.get(c.t);
    if (lane) lane.pre = false; // unlocked: the planner owns it now
    if (lane && (lane.mode === "drain" || lane.mode === "retire")) {
      // Wanted again: once its workers have landed it re-preps with this budget.
      setMode(st, lane, "drain", "wanted again after retiring");
      lane.firstLand = 0;
      lane.m = c.m;
      lane.prepBudget = B;
      lane.budget = B;
      keep.add(c.t);
      continue;
    }
    if (c.ready) {
      const plan = solveStream(c.m, B, st.spacing, b, Math.min(inFlightLeft, slotShare(P, B)));
      if (!plan) continue;
      if (!lane) {
        lane = newLane(c.t, "batch");
        st.lanes.set(c.t, lane);
      }
      setMode(st, lane, "batch", "planned");
      lane.m = c.m;
      lane.plan = plan;
      lane.budget = B;
      inFlightLeft -= plan.inFlight;
      keep.add(c.t);
    } else {
      if (!lane) {
        lane = newLane(c.t, "prep");
        st.lanes.set(c.t, lane);
      }
      lane.m = c.m;
      lane.prepBudget = Math.min(B, c.need.total);
      lane.budget = B;
      keep.add(c.t);
    }
  }
  for (const [t, lane] of st.lanes) {
    if (!keep.has(t) && lane.mode !== "retire" && !lane.pre) {
      setMode(st, lane, "retire", "no longer worth its RAM");
      cancelQueued(lane);
    }
  }
  st.planStats = { ms: now - P.started, ticks: P.ticks, targets: P.cands.length, at: now };
  // How much of the capacity the plan can actually use. If a lot is left over,
  // RAM isn't what's limiting income (targets or script slots are), so buying
  // more would be wasted; the buyer reads this.
  let used = 0;
  for (const lane of st.lanes.values()) {
    if (!keep.has(lane.target)) continue;
    used += lane.mode === "batch" && lane.plan ? lane.plan.conc : lane.budget ?? 0;
  }
  // Why the plan stopped where it did: every considered target already gets
  // all the threads that still add income (saturated), the script slots ran
  // out, or the RAM did.
  const slotsUsed = P.maxInFlight - inFlightLeft;
  const limit = slotsUsed >= 0.9 * P.maxInFlight ? "slots" : left > 0 ? "targets" : "ram";
  const saturated = P.cands.filter((c, i) => alloc[i] > 0 && (c.curve[alloc[i] + 1] ?? c.curve[alloc[i]]) <= c.curve[alloc[i]] * (1 + 1e-9)).length;
  // Targets that would earn if they were prepped but didn't get threads this
  // time (usually because the best one needs prepping first and takes the
  // lot). Prep is cheap in threads, so spare RAM preps them meanwhile and the
  // next plan can spread out instead of waiting a whole prep for each.
  st.prepNext = P.cands
    .filter((c) => !c.ready && !keep.has(c.t) && (c.curve[P.K] ?? 0) > 0)
    .sort((a, c) => c.curve[P.K] - a.curve[P.K])
    .map((c) => ({ t: c.t, m: c.m, need: c.need }));
  st.usage = { used, capacity: st.capacity, slotsUsed, slots: P.maxInFlight, limit, targets: order.filter((x) => x.B >= 1).length, considered: P.cands.length, saturated };

  // Replan once per pipeline cycle (the shortest weaken time among lanes),
  // or straight away if something asked for one while this plan was built.
  const cycles = [...st.lanes.values()].filter((l) => l.m).map((l) => l.m.weakenTime + b);
  st.nextReplan = st.replanAsked ? now : now + Math.max(2000, Math.min(60000, ...cycles));
  st.replanAsked = false;
  tuneSlots(ns, cfg, st);
  startSharing(ns, cfg, st, ledger);
}

/**
 * Self-tuning script cap. More scripts allow more batches in flight, but a
 * busier game runs workers later, which widens the landing gap, and a wider
 * gap means each target lands batches less often. The planner's expected
 * income already reflects the measured gap, so this is a hill climb on it:
 * while slots are the limit, try 25% more; two plans later (once lateness
 * has been measured under the new load) keep it if expected income rose,
 * otherwise go back and wait a while before trying again. Stalls or heavy
 * lateness bring the cap down.
 */
function tuneSlots(ns, cfg, st) {
  if (!cfg.autoTuneSlots || !st.usage) return;
  const T = st.slots;
  let expected = 0;
  for (const lane of st.lanes.values()) if (lane.mode === "batch" && lane.plan) expected += lane.plan.rate;
  const log = (what) => {
    T.history.push({ at: Date.now(), cap: T.cap, what, expected: Math.round(expected * 1000) });
    if (T.history.length > 20) T.history.shift();
  };
  // The game is struggling (workers starting too late to land in their slot,
  // or launch lag past a second): back off whatever phase we're in.
  const M = st.missStats;
  const struggling = (M && M.landed >= 100 && M.missed / M.landed > 0.01) || st.lagP99 > 1000;
  if (struggling && T.cap > cfg.maxWorkerScripts) {
    T.cap = Math.max(cfg.maxWorkerScripts, Math.floor(T.cap * 0.8));
    T.phase = "idle";
    T.cooldown = 5;
    log("workers starting late, lowered");
    return;
  }
  if (T.phase === "probe1") {
    T.phase = "probe2"; // let lateness settle under the new load
    return;
  }
  if (T.phase === "probe2") {
    if (expected >= T.before.expected * 1.01) {
      log("kept: expected income rose");
      T.phase = "idle";
    } else {
      T.cap = T.before.cap;
      T.cooldown = 10;
      T.phase = "idle";
      log("reverted: no gain");
    }
    return;
  }
  if (T.cooldown > 0) {
    T.cooldown--;
    return;
  }
  if (st.usage.limit === "slots" && T.cap < cfg.maxWorkerScriptsLimit) {
    T.before = { cap: T.cap, expected };
    T.cap = Math.min(cfg.maxWorkerScriptsLimit, Math.ceil(T.cap * 1.25));
    T.phase = "probe1";
    log("trying more");
  }
}

/**
 * Lend the threads the plan can't use to factions. Never more than the
 * plan's spare (capacity minus what it uses, minus a reserve), so batches
 * still find room as the pipeline fills. Grow-style core bonuses apply, so
 * servers with more cores go first.
 */
function startSharing(ns, cfg, st, ledger) {
  const W = cfg.workers;
  if (!cfg.share?.enabled || !W.share || !st.usage) return;
  const R = ledger.scriptRam;
  if (!(R.share > 0)) return;
  // What every lane needs: the larger of its plan and what its workers hold
  // right now (batches from the previous plan, or a target that's draining).
  const held = new Map();
  for (const info of st.pids.values()) held.set(info.target, (held.get(info.target) ?? 0) + info.threads);
  let needed = 0;
  for (const lane of st.lanes.values()) {
    const h = held.get(lane.target) ?? 0;
    if (lane.mode === "batch" && lane.plan) needed += Math.max(lane.plan.conc, h);
    // A prepping target only needs its prep rounds until it's ready; the
    // rest of its budget is lent meanwhile and taken back when it starts
    // batching. A draining one will re-prep with its prep budget.
    else if (lane.mode === "prep" || lane.mode === "drain") needed += Math.max(lane.prepBudget ?? 0, h);
    else needed += h;
  }
  // Ease the reserve back towards the configured level after a quiet plan.
  st.share.reserve = Math.max(cfg.share.reserveFraction, st.share.reserve * 0.9);
  let spareThreads = st.usage.capacity - needed - st.share.reserve * st.usage.capacity;
  // Split it between hacking XP and faction rep.
  const use = spareUse(ns, cfg, st);
  // Spare RAM first preps the targets this plan would use if they were
  // ready: that's what turns into income soonest.
  spareThreads = prepRunnersUp(ns, st, spareThreads);
  // When it isn't levelling you up, spare RAM then preps the next server
  // you can't hack yet (weaken and grow only need root), so it batches the
  // moment your level reaches it. While XP is on, levelling gets you there
  // sooner than prepping saves, so XP comes first.
  if (cfg.share.prePrep !== false && use.xp === 0) spareThreads = startPrePrep(ns, st, spareThreads);
  const wantRam = Math.max(0, spareThreads * ledger.threadRam);

  const xpTarget = use.xp > 0 && R.xp > 0 ? pickXpTarget(ns, st) : null;
  const want = { xp: xpTarget ? wantRam * use.xp : 0 };
  want.share = wantRam - want.xp;
  st.share.use = xpTarget ? "xp" : "share";
  st.share.why = use.why;
  st.share.xpTarget = xpTarget;

  // Forget lent workers that have ended (killed by hand, say).
  for (const [pid, info] of [...st.share.pids]) if (!ns.isRunning(pid)) forgetLent(st, pid, info);
  ledger.refresh(st.hosts);
  // Top up or trim what's already lent, rather than restarting it.
  const haveRam = (kind) => {
    let r = 0;
    for (const info of st.share.pids.values()) if (!info.home && (info.kind ?? "share") === kind) r += info.threads * R[kind];
    return r;
  };
  for (const kind of ["share", "xp"]) {
    const have = haveRam(kind);
    if (have > want[kind] + R[kind]) stopSharing(ns, st, R, have - want[kind], kind, xpTarget);
  }
  ledger.refresh(st.hosts);
  shareHome(ns, cfg, st, ledger, R.share);
  const hosts = [...ledger.hosts].sort((a, c) => c.cores - a.cores || c.free - a.free);
  // Share threads go where the cores are (they count for more there); XP
  // threads get no core bonus, so they take what's left.
  lend(ns, st, hosts, "share", W.share, R.share, want.share - haveRam("share"), [], 1);
  if (xpTarget) {
    // In pieces, so a batch that needs RAM back can take a small piece
    // instead of losing a whole server's worth of exp in flight.
    const pieces = Math.max(1, Math.ceil(want.xp / R.xp / 32));
    lend(ns, st, hosts, "xp", W.xp, R.xp, want.xp - haveRam("xp"), [xpTarget], pieces);
  }
  st.share.xpRate = xpRate(ns, st, ledger);
}

/**
 * Give spare threads to prepping rooted servers above your hacking level,
 * the ones that unlock soonest first. Returns the threads left over.
 */
function startPrePrep(ns, st, spare) {
  const level = ns.getHackingLevel();
  // Only the next server you'll reach: further ones have much longer
  // weaken times now than they will once your level is near them, so
  // prepping them early ties up RAM that levels you faster as XP.
  for (const lane of st.lanes.values()) if (lane.pre && lane.req > 0) return spare;
  const locked = st.hosts
    .filter((h) => h !== "home" && !h.startsWith("hacknet-") && !st.lanes.has(h) && ns.hasRootAccess(h) && ns.getServerMaxMoney(h) > 0)
    .map((h) => ({ h, req: ns.getServerRequiredHackingLevel(h) }))
    .filter((x) => x.req > level && !ns.getServer(x.h).purchasedByPlayer && !isPrepped(ns, x.h))
    .sort((a, c) => a.req - c.req);
  for (const { h, req } of locked.slice(0, 1)) {
    if (spare < 1) break;
    const m = buildModel(ns, h, st.useFormulas);
    const need = prepNeeds(ns, m);
    if (need.total < 1) continue;
    const take = Math.floor(Math.min(need.total, spare));
    spare -= take;
    const lane = newLane(h, "prep");
    lane.pre = true;
    lane.req = req;
    lane.m = m;
    lane.prepBudget = take;
    lane.budget = take;
    st.lanes.set(h, lane);
    st.modeLog.push({ at: Date.now(), target: h, from: "-", to: "prep", why: `pre-prep: unlocks at hacking ${req}` });
    if (st.modeLog.length > 60) st.modeLog.shift();
  }
  return spare;
}

/** Prep the plan's runners-up (st.prepNext) with spare threads. Returns what's left. */
function prepRunnersUp(ns, st, spare) {
  for (const { t, m, need } of st.prepNext ?? []) {
    if (spare < 1) break;
    if (st.lanes.has(t) || !need || need.total < 1) continue;
    const take = Math.floor(Math.min(need.total, spare));
    spare -= take;
    const lane = newLane(t, "prep");
    lane.pre = true;
    lane.req = 0;
    lane.m = m;
    lane.prepBudget = take;
    lane.budget = take;
    st.lanes.set(t, lane);
    st.modeLog.push({ at: Date.now(), target: t, from: "-", to: "prep", why: "prepping a runner-up while the plan's targets prep" });
    if (st.modeLog.length > 60) st.modeLog.shift();
  }
  st.prepNext = [];
  return spare;
}

/** Start lent workers of one kind on free RAM, up to ramWanted. */
function lend(ns, st, hosts, kind, script, ram, ramWanted, args, pieceThreads) {
  let ramLeft = ramWanted;
  for (const h of hosts) {
    while (ramLeft >= ram) {
      let t = Math.floor(Math.min(h.free, ramLeft) / ram);
      if (t < 1) break;
      if (kind === "xp") t = Math.min(t, pieceThreads);
      const pid = ns.exec(script, h.host, { threads: t, temporary: true }, ...args);
      if (!(pid > 0)) break;
      st.share.pids.set(pid, { host: h.host, threads: t, kind, target: args[0] });
      if (kind === "xp") st.share.xpThreads += t;
      else st.share.threads += t;
      h.free -= t * ram;
      ramLeft -= t * ram;
    }
    if (ramLeft < ram) break;
  }
}

function forgetLent(st, pid, info) {
  st.share.pids.delete(pid);
  if ((info.kind ?? "share") === "xp") st.share.xpThreads = Math.max(0, st.share.xpThreads - info.threads);
  else st.share.threads = Math.max(0, st.share.threads - info.threads);
  if (info.home) st.share.homeThreads = Math.max(0, (st.share.homeThreads ?? 0) - info.threads);
}

/**
 * How much of the spare RAM goes to hacking XP (the rest shares), and why.
 * In "auto", XP while some server with money still needs a higher hacking
 * level than yours: levels unlock those targets, and every operation gets
 * faster as your level rises. Once nothing is level-locked, rep is the
 * better use.
 */
function spareUse(ns, cfg, st) {
  const mode = cfg.share.use ?? "share";
  const keepShare = Math.min(1, Math.max(0, cfg.share.xpShareFraction ?? 0.1));
  if (mode === "share") return { xp: 0, why: "share.use is \"share\"" };
  if (mode === "xp") return { xp: 1 - keepShare, why: "share.use is \"xp\"" };
  const level = ns.getHackingLevel();
  let locked = 0;
  let next = Infinity;
  for (const host of st.hosts) {
    if (host === "home" || host.startsWith("hacknet-")) continue;
    if (ns.getServerMaxMoney(host) <= 0) continue;
    const req = ns.getServerRequiredHackingLevel(host);
    if (req > level) {
      locked++;
      next = Math.min(next, req);
    }
  }
  if (locked === 0) return { xp: 0, why: "no server is locked behind your hacking level" };
  return { xp: 1 - keepShare, why: `${locked} servers need a higher hacking level (next at ${next})` };
}

/**
 * The server where a weaken thread earns the most exp per second: exp per
 * thread is 3 + 0.3 x its base security, and the time is its weaken time at
 * minimum security (scaled from the current one with the game's formula,
 * which is linear in required level x security, so no Formulas.exe needed).
 */
function pickXpTarget(ns, st) {
  const level = ns.getHackingLevel();
  let best = null;
  let current = null;
  for (const host of st.hosts) {
    if (host === "home" || host.startsWith("hacknet-")) continue;
    if (!ns.hasRootAccess(host) || ns.getServerMaxMoney(host) <= 0) continue;
    const req = ns.getServerRequiredHackingLevel(host);
    if (req > level) continue;
    const sec = ns.getServerSecurityLevel(host);
    const min = ns.getServerMinSecurityLevel(host);
    const time = (ns.getWeakenTime(host) * (2.5 * req * min + 500)) / (2.5 * req * sec + 500);
    const score = (3 + 0.3 * ns.getServerBaseSecurityLevel(host)) / time;
    if (!best || score > best.score) best = { host, score };
    if (host === st.share.xpTarget) current = score;
  }
  // Stay put unless the new one is clearly better: switching loses the exp
  // of workers in flight on the old one as they're replaced.
  if (best && current !== null && current * 1.1 >= best.score) return st.share.xpTarget;
  return best?.host ?? null;
}

/** Hacking exp per ms the XP workers give, for level prediction (Formulas.exe only). */
function xpRate(ns, st, ledger) {
  if (!st.useFormulas || st.share.xpThreads <= 0) return 0;
  const p = ns.getPlayer();
  const byTarget = new Map();
  for (const info of st.share.pids.values()) if (info.kind === "xp") byTarget.set(info.target, (byTarget.get(info.target) ?? 0) + info.threads);
  let rate = 0;
  for (const [t, threads] of byTarget) {
    const s = ns.getServer(t);
    if (!s || s.purchasedByPlayer) continue;
    s.hackDifficulty = s.minDifficulty;
    rate += (ns.formulas.hacking.hackExp(s, p) * threads) / ns.formulas.hacking.weakenTime(s, p);
  }
  return rate;
}

/**
 * Keep home's own share at the size the ledger set aside for it
 * (share.homeShareStart, then the 1:1 exchange). Grows as home RAM frees up,
 * shrinks by stopping the biggest home share workers.
 */
function shareHome(ns, cfg, st, ledger, shareRam) {
  const want = Math.floor(ledger.homeShareGB / shareRam);
  const homePids = () => [...st.share.pids.entries()].filter(([, i]) => i.home).sort((a, c) => c[1].threads - a[1].threads);
  let s = ns.getServer("home");
  const scripts = Math.min(cfg.homeReserveGB, s.maxRam * cfg.homeReserveMaxFraction);
  // Your own scripts come first: if they've eaten into the free RAM home
  // keeps for them, give share threads back (and re-share what's left below).
  let short = scripts - (s.maxRam - s.ramUsed);
  for (const [pid, info] of homePids()) {
    if ((st.share.homeThreads ?? 0) <= want && short <= 0) break;
    ns.kill(pid);
    forgetLent(st, pid, info);
    short -= info.threads * shareRam;
  }
  s = ns.getServer("home");
  const t = Math.min(want - (st.share.homeThreads ?? 0), Math.floor((s.maxRam - s.ramUsed - scripts) / shareRam));
  if (t < 1) return;
  const pid = ns.exec(cfg.workers.share, "home", { threads: t, temporary: true });
  if (pid > 0) {
    st.share.pids.set(pid, { host: "home", threads: t, home: true, kind: "share" });
    st.share.threads += t;
    st.share.homeThreads = (st.share.homeThreads ?? 0) + t;
  }
}

/**
 * Take lent RAM back: all of it, or (with ramNeeded) just enough. With a
 * kind, only that kind; XP workers not on the current XP target go first.
 * Otherwise the smallest single worker that covers the need, or the biggest
 * ones until it's covered, so as little as possible is stopped.
 */
function stopSharing(ns, st, R, ramNeeded = Infinity, kind = null, xpTarget = null) {
  const ramOf = (info) => info.threads * (R[info.kind ?? "share"] ?? 0);
  // A partial reclaim never touches home's dedicated share: batches can't use home then.
  let list = [...st.share.pids.entries()].filter(([, i]) => (ramNeeded === Infinity || !i.home) && (!kind || (i.kind ?? "share") === kind));
  if (ramNeeded !== Infinity) {
    const bigFirst = (a, c) => ramOf(c[1]) - ramOf(a[1]);
    const isStale = ([, i]) => i.kind === "xp" && xpTarget && i.target !== xpTarget;
    const stale = list.filter(isStale);
    if (stale.length) list = [...stale.sort(bigFirst), ...list.filter((e) => !isStale(e)).sort(bigFirst)];
    else {
      const cover = list.filter(([, i]) => ramOf(i) >= ramNeeded).sort((a, c) => ramOf(a[1]) - ramOf(c[1]))[0];
      list = cover ? [cover] : list.sort(bigFirst);
    }
  }
  let freed = 0;
  for (const [pid, info] of list) {
    if (freed >= ramNeeded) break;
    ns.kill(pid);
    forgetLent(st, pid, info);
    freed += ramOf(info);
  }
  if (st.share.pids.size === 0) {
    st.share.threads = 0;
    st.share.xpThreads = 0;
  }
}

/** Change a lane's mode, keeping a short log of why (for report.js). */
function setMode(st, lane, mode, why) {
  if (lane.mode === mode) return;
  st.modeLog.push({ at: Date.now(), target: lane.target, from: lane.mode, to: mode, why });
  if (st.modeLog.length > 60) st.modeLog.shift();
  lane.mode = mode;
}

/** Ask for a replan as soon as possible (after the one being built, if any). */
function requestReplan(st) {
  if (st.planner) st.replanAsked = true;
  else st.nextReplan = 0;
}

function newLane(target, mode) {
  return {
    target,
    mode,
    m: null,
    plan: null,
    prepBudget: 0,
    prep: null,
    nextLand: 0,
    lastLandEnd: 0,
    queues: { weaken: [], grow: [], hack: [] },
    batches: new Map(),
    pids: new Set(),
    money: 0,
    started: Date.now(),
    firstLand: 0, // when the first batch of this batching run lands
    income: [], // { t, amount } for the last minute, for the status window
    pctSamples: [],
    desyncs: 0,
  };
}

function cancelQueued(lane) {
  for (const q of Object.values(lane.queues)) {
    for (const op of q) op.batch.cancelled = true;
    q.length = 0;
  }
}

// ------------------------------------------------------------------ lanes ---

/** Values read once per tick and shared by every lane. */
function tickContext(ns, st) {
  return { player: st.useFormulas ? ns.getPlayer() : null, times: new Map(), level: ns.getHackingLevel() };
}

/**
 * Operation times at minimum security, which is what batch workers get (they
 * wait for security to come back down before starting). The live values
 * are read at whatever security the target has right now, and between a
 * batch's grow and weaken landing that's far above minimum, so they'd be
 * up to ~50% too long and workers would launch (and hold RAM) far too early.
 * The game's time is proportional to 2.5 x required level x security + 500,
 * so the live value scales exactly to minimum security.
 */
function times(ns, ctx, t, m) {
  let v = ctx.times.get(t);
  if (!v) {
    const sec = ns.getServerSecurityLevel(t);
    const req = (m.req ??= ns.getServerRequiredHackingLevel(t));
    const k = sec > m.minSec ? (2.5 * req * m.minSec + 500) / (2.5 * req * sec + 500) : 1;
    v = { hack: ns.getHackTime(t) * k, grow: ns.getGrowTime(t) * k, weaken: ns.getWeakenTime(t) * k };
    ctx.times.set(t, v);
  }
  return v;
}

function stepLane(ns, cfg, st, ledger, lane, now, b, TICK, ctx) {
  const t = lane.target;
  const look = now + 2 * TICK;
  let execs = 0;

  if (lane.mode === "retire" || lane.mode === "drain") {
    if (lane.pids.size === 0) {
      if (lane.mode === "retire") st.lanes.delete(t);
      else {
        setMode(st, lane, "prep", "workers landed, re-prep");
        lane.prep = null;
        requestReplan(st);
      }
    }
    return 0;
  }

  if (lane.mode === "prep") {
    if (lane.pids.size > 0) return 0; // a prep round is still landing
    if (isPrepped(ns, t) && lane.pre) {
      // Ready: a runner-up can be planned straight away; a locked server
      // waits for your level.
      const hackable = ns.getServerRequiredHackingLevel(t) <= ctx.level;
      st.modeLog.push({ at: now, target: t, from: "prep", to: "-", why: hackable ? "prepped ahead, replanning" : "pre-prepped, waiting for your level" });
      st.lanes.delete(t);
      if (hackable) requestReplan(st);
      return 0;
    }
    if (isPrepped(ns, t)) {
      setMode(st, lane, "batch", "prepped");
      // Its budget was lent out while it prepped; taking it back as the
      // pipeline fills is expected, not a sign of lending too much.
      st.share.graceUntil = Math.max(st.share.graceUntil, now + ns.getWeakenTime(t) + 2 * b);
      lane.firstLand = 0;
      lane.plan = null;
      lane.prep = null;
      requestReplan(st); // get it a batch plan
      return 0;
    }
    const m = lane.m;
    const need = prepNeeds(ns, m);
    // Size the round to what is free right now, then make sure all three parts
    // fit together before launching any: a grow without its weaken would push
    // security up with nothing to bring it back down. Halve until it fits.
    const freeNow = ledger.hosts.reduce((acc, h) => acc + Math.floor(h.free / ledger.threadRam), 0);
    let budget = Math.min(lane.prepBudget, need.total, freeNow);
    let shape = null;
    let pieces = null;
    for (let tries = 0; tries < 8 && budget >= 1; tries++, budget = Math.floor(budget / 2)) {
      shape = prepShape(budget, need, m);
      if (shape.total <= 0) break;
      pieces = ledger.planAll([
        { kind: "weaken", amount: shape.w1 },
        { kind: "weaken", amount: shape.w2 },
        { kind: "grow", amount: shape.g },
      ]);
      if (pieces) break;
    }
    lane.prep = shape;
    if (!shape || shape.total <= 0 || !pieces) return 0;
    const land = now + ns.getWeakenTime(t) + b;
    lane.prepLand = land + 2 * st.spacing;
    const batch = { id: ++st.batchSeq, cancelled: false, launched: new Set(), land };
    const s = st.spacing;
    // Weakens first: if the grow then fails to start, nothing is harmed.
    execs += launch(ns, cfg, st, ledger, lane, { kind: "weaken", amount: shape.w1, land, batch, tag: "W1", wait: false, pieces: pieces[0] });
    execs += launch(ns, cfg, st, ledger, lane, { kind: "weaken", amount: shape.w2, land: land + 2 * s, batch, tag: "W2", wait: false, pieces: pieces[1] });
    if (shape.w2 > 0 && !batch.launched.has("W2")) return execs;
    execs += launch(ns, cfg, st, ledger, lane, { kind: "grow", amount: shape.g, land: land + s, batch, tag: "G", wait: false, pieces: pieces[2] });
    if (st.useFormulas && ctx.player && m.server) {
      // Prep workers give exp too; count it so batches elsewhere predict levels right.
      const exp = ns.formulas.hacking.hackExp(m.server, ctx.player) * shape.total;
      st.pendingExp.push({ land, exp });
      st.pendingExpTotal += exp;
    }
    return execs;
  }

  // ---- batch mode: create batches just in time, then launch due workers ----
  const plan = lane.plan;
  if (!plan) return 0;
  const m = lane.m;
  const tm = times(ns, ctx, t, m);
  const s = st.spacing;
  const gaps = batchGaps(m);
  const P = Math.max(plan.P, gaps * s);

  for (;;) {
    // Earliest landing whose first weaken (landing at L + s) can still launch now.
    const L = Math.max(lane.nextLand, now + tm.weaken + b - s, lane.lastLandEnd + s);
    // Create the batch only when its first weaken is due to launch.
    if (L + s - tm.weaken - b > look) break;
    if (st.pids.size + queuedCount(st) + gaps > st.slots.cap) break;

    const pctNow = samplePct(ns, lane, now);
    const pct = predictPct(ns, st, lane, ctx, L, pctNow);
    const topUp = lane.topUp ?? 0;
    const shape = shapeAt(m, plan.h, pct, topUp, overshoot(lane));
    const repairing = topUp > 0;
    lane.topUp = 0;
    // Batches already in flight will keep landing on the short money until
    // this repair batch's grow lands; their shortfalls are expected, not new.
    if (repairing) lane.repairLand = Math.max(lane.repairLand ?? 0, L + 2 * s);
    const batch = {
      repair: repairing,
      // A repair batch's own hack still lands on the short money.
      expectShort: topUp,
      plannedF: Math.min(1, plan.h * pct),
      level: ctx.level,
      id: ++st.batchSeq,
      cancelled: false,
      launched: new Set(),
      expectedPerThread: pctNow * m.moneyMax, // money one hack thread should take at least
      land: L,
    };
    lane.batches.set(batch.id, batch);
    lane.queues.hack.push({ kind: "hack", amount: shape.h, land: L, batch, tag: "H" });
    if (m.hgw) {
      // H, G, W: the grow lands one gap after the hack, one weaken after both.
      batch.hgw = true;
      lane.queues.grow.push({ kind: "grow", amount: shape.g, land: L + s, batch, tag: "G" });
      lane.queues.weaken.push({ kind: "weaken", amount: shape.w2, land: L + 2 * s, batch, tag: "W2" });
    } else {
      lane.queues.weaken.push({ kind: "weaken", amount: shape.w1, land: L + s, batch, tag: "W1" });
      lane.queues.grow.push({ kind: "grow", amount: shape.g, land: L + 2 * s, batch, tag: "G" });
      lane.queues.weaken.push({ kind: "weaken", amount: shape.w2, land: L + 3 * s, batch, tag: "W2" });
    }
    // The model may predate buying Formulas.exe (no server object yet); the
    // next replan rebuilds it, until then level prediction just skips this batch.
    if (st.useFormulas && ctx.player && m.server) {
      const e = ns.formulas.hacking.hackExp(m.server, ctx.player);
      const exp = e * (shape.h * (m.chance + (1 - m.chance) / 4) + shape.g + shape.w1 + shape.w2);
      st.pendingExp.push({ land: L, exp });
      st.pendingExpTotal += exp;
    }
    if (!lane.firstLand) lane.firstLand = L;
    lane.nextLand = L + P;
    lane.lastLandEnd = L + (gaps - 1) * s;
    st.session.batches++;
  }

  // Launch every queued worker whose start time has come: weakens start
  // earliest, then grow, then hack.
  for (const kind of ["weaken", "grow", "hack"]) {
    const q = lane.queues[kind];
    while (q.length > 0 && q[0].land - tm[kind] - b <= look) {
      const op = q.shift();
      execs += launch(ns, cfg, st, ledger, lane, { ...op, wait: true, dur: tm[kind] });
    }
  }
  return execs;
}

function queuedCount(st) {
  let n = 0;
  for (const lane of st.lanes.values()) n += lane.queues.weaken.length + lane.queues.grow.length + lane.queues.hack.length;
  return n;
}

/** One batch's threads, with grow sized for the hack % expected at landing. */
function shapeAt(m, h, pct, topUp = 0, over = 1) {
  // over: how much more than predicted hacks have recently taken (level-ups
  // the prediction missed), so the grow covers that too.
  const f = Math.min(1 - 1 / m.moneyMax, h * pct * over);
  // topUp: the money is already short by this fraction (a drift), so grow
  // back from (1 - f)(1 - topUp) instead of (1 - f).
  const total = Math.min(1 - 1 / m.moneyMax, 1 - (1 - f) * (1 - topUp));
  if (m.hgw) {
    const g = growAfterHack(m, total, h * m.hackSec);
    return { h, g, w1: 0, w2: Math.ceil((h * m.hackSec + g * m.growSec) / m.weakenPer) };
  }
  const g = m.growThreads(total);
  return { h, g, w1: Math.ceil((h * m.hackSec) / m.weakenPer), w2: Math.ceil((g * m.growSec) / m.weakenPer) };
}

/**
 * How much more than planned this target's hacks have been taking: the 95th
 * percentile of actual / planned over recent healthy batches, never below 1.
 * Learned from the game, so no safety margin has to be guessed.
 */
function overshoot(lane) {
  const r = lane.overRatios;
  if (!r || r.length < 10) return 1;
  const sorted = [...r].sort((a, c) => a - c);
  return Math.max(1, sorted[Math.floor(sorted.length * 0.95)]);
}

/** Live hack % per thread, sampled only while the target is at min security. */
function samplePct(ns, lane, now) {
  const t = lane.target;
  if (ns.getServerSecurityLevel(t) <= lane.m.minSec + 1e-9) {
    const pct = ns.hackAnalyze(t);
    const last = lane.pctSamples[lane.pctSamples.length - 1];
    if (!last || now - last.t > 500) lane.pctSamples.push({ t: now, pct });
    const keepFrom = now - 2 * lane.m.weakenTime;
    while (lane.pctSamples.length > 2 && lane.pctSamples[0].t < keepFrom) lane.pctSamples.shift();
    return pct;
  }
  const last = lane.pctSamples[lane.pctSamples.length - 1];
  return last ? last.pct : lane.m.hackPct;
}

/**
 * Hack % a batch landing at time L will actually see. Levels rise while
 * batches are in flight, so a hack takes a little more than when it was
 * planned; the grow is sized for that.
 *  - With Formulas.exe: add up the exp every in-flight worker will give before
 *    L, turn that into a level, and ask the formula for that level's hack %.
 *  - Without: extrapolate from how fast hack % has been rising.
 */
function predictPct(ns, st, lane, ctx, L, pctNow) {
  const m = lane.m;
  if (st.useFormulas && ctx.player && m.server) {
    const p = ctx.player;
    // All exp still in flight. Some of it lands after L (other targets with
    // longer weakens), which slightly overstates the level: that only makes
    // the grow a little bigger, which is the safe direction.
    // Plus what the XP workers will have added by then.
    const pending = st.pendingExpTotal + st.share.xpRate * Math.max(0, L - Date.now());
    const sk = ns.formulas.skills;
    const gain = sk.calculateSkill(p.exp.hacking + pending, p.mults.hacking) - sk.calculateSkill(p.exp.hacking, p.mults.hacking);
    // One level of headroom: a level-up the prediction just misses then costs
    // a few spare grow threads instead of a re-prep.
    const future = { ...p, skills: { ...p.skills, hacking: p.skills.hacking + Math.max(0, gain) + 1 } };
    return Math.max(pctNow, ns.formulas.hacking.hackPercent(m.server, future));
  }
  const smp = lane.pctSamples;
  if (smp.length < 2) return pctNow;
  const a = smp[0];
  const z = smp[smp.length - 1];
  const slope = Math.max(0, (z.pct - a.pct) / Math.max(1, z.t - a.t));
  return pctNow + slope * Math.max(0, L - Date.now());
}

/** Launch one operation across as many servers as it needs. Returns exec count. */
function launch(ns, cfg, st, ledger, lane, op) {
  const { batch, kind } = op;
  if (batch.cancelled || op.amount <= 0) return 0;
  // Never start a hack unless its weakens and grow are already running, and
  // never a grow without the weaken that cleans up after it.
  if (op.wait && op.tag === "H" && !((batch.hgw || batch.launched.has("W1")) && batch.launched.has("W2") && batch.launched.has("G"))) {
    batch.cancelled = true;
    return 0;
  }
  if (op.wait && op.tag === "G" && !batch.launched.has("W2")) {
    batch.cancelled = true;
    return 0;
  }
  let pieces = op.pieces ?? ledger.plan(kind, op.amount);
  if (!pieces && st.share.pids.size > 0) {
    // Shared RAM is lent, not given: take back what this needs (with some
    // room to spare), lend less from now on, and try once more.
    const need = op.amount * ledger.scriptRam[kind] * 2;
    stopSharing(ns, st, ledger.scriptRam, need);
    // Expected while a just-prepped target fills its pipeline (its budget
    // was lent during the prep); otherwise lend less from now on.
    if (Date.now() > st.share.graceUntil) st.share.reserve = Math.min(0.5, st.share.reserve * 1.5);
    st.share.reclaims++;
    ledger.refresh(st.hosts);
    pieces = ledger.plan(kind, op.amount);
  }
  if (!pieces) {
    // Not enough RAM right now. Everything already launched for this batch
    // is harmless on its own, so just drop the rest of it.
    batch.cancelled = true;
    return 0;
  }
  // The slack this worker should have when it starts; what it actually has
  // tells us the launch lag.
  const plannedSlack = op.dur != null ? op.land - Date.now() - op.dur : null;
  // Workers wait (up to two gaps) for security to be back at minimum before
  // starting; prep workers don't, since security is high on purpose then.
  const minSec = op.wait ? lane.m.minSec : -1;
  // Security stays raised for one gap after a hack or grow lands (HWGW), or
  // two after a hack (HGW, until the batch's only weaken lands).
  const maxWait = (batch.hgw ? 3 : 2) * st.spacing;
  let ok = true;
  let n = 0;
  for (const p of pieces) {
    const args = [lane.target, op.land, batch.id, cfg.ports.reports + (batch.id % (cfg.ports.reportPorts ?? 1)), minSec, maxWait];
    if (kind === "grow" && st.stockGrow.has(lane.target)) args.push(true);
    const pid = ns.exec(cfg.workers[kind], p.host, { threads: p.threads, temporary: true }, ...args);
    n++;
    if (pid > 0) {
      st.pids.set(pid, { target: lane.target, kind, threads: p.threads, batch, prep: !op.wait, launchedAt: Date.now(), plannedSlack });
      lane.pids.add(pid);
    } else ok = false;
  }
  ledger.take(kind, pieces);
  if (op.tag === "H" && op.wait) {
    batch.hackPieces = pieces.map((p) => p.threads);
    batch.hackGot = 0;
    batch.hackReported = 0;
    batch.hackMissed = !ok;
  }
  if (ok) batch.launched.add(op.tag);
  else batch.cancelled = true; // partial op: build nothing on top of it
  return n;
}

// ---------------------------------------------------------------- reports ---

function handleReports(ns, cfg, st, ports) {
  const reports = [];
  for (const p of ports) for (const r of drainPort(ns, p)) reports.push(r);
  for (const r of reports) {
    // A report that arrives after sweep() saw its worker end still counts.
    const info = st.pids.get(r.pid) ?? st.gone.get(r.pid);
    st.pids.delete(r.pid);
    st.gone.delete(r.pid);
    const lane = st.lanes.get(r.target);
    if (lane) lane.pids.delete(r.pid);
    // Lateness only teaches us about timing if it was a batch worker (prep
    // isn't timing-critical) and the game didn't stall while it ran.
    // (The game also needs a moment after a stall to catch up on its backlog.)
    const fairTiming = info && !info.prep && info.launchedAt > st.lastStallAt + 3000;
    if (fairTiming && !r.aborted && r.late > 0) st.lates.push(r.late);
    if (st.lates.length > 2000) st.lates.splice(0, st.lates.length - 2000);
    if (fairTiming && typeof r.slack === "number" && info.plannedSlack != null) {
      st.lags.push(info.plannedSlack - r.slack);
      if (st.lags.length > 2000) st.lags.splice(0, st.lags.length - 2000);
      st.miss.landed++;
      if (r.slack < 0) st.miss.missed++;
    }
    if (r.type !== "H") continue;
    if (r.aborted) {
      st.session.aborted++;
      continue;
    }
    if (r.amount > 0) {
      const bucket = Math.floor(Date.now() / 10000) * 10000;
      const lastB = st.incomeLog[st.incomeLog.length - 1];
      if (lastB && lastB.t === bucket) lastB.money += r.amount;
      else {
        st.incomeLog.push({ t: bucket, money: r.amount });
        while (st.incomeLog.length && st.incomeLog[0].t < bucket - 1800000) st.incomeLog.shift();
      }
      st.session.money += r.amount;
      if (lane) {
        lane.money += r.amount;
        lane.income.push({ t: Date.now(), amount: r.amount });
      }
    }
    // Health check: once every hack piece of a batch has reported, together
    // they should have taken at least what was planned. Less means money
    // wasn't at max or security wasn't at min when they landed.
    if (lane && lane.mode === "batch" && info && info.batch.hackPieces) {
      const b = info.batch;
      b.hackGot += r.amount;
      b.hackReported++;
      if (r.amount <= 0) b.hackMissed = true; // a failed hack (chance) proves nothing
      if (b.hackReported === b.hackPieces.length && !b.hackMissed) {
        const pct = b.expectedPerThread / lane.m.moneyMax;
        // Pieces land one after another, each on what the previous left.
        const left = b.hackPieces.reduce((acc, t) => acc * Math.max(0, 1 - t * pct), 1);
        const expected = lane.m.moneyMax * (1 - left) * (1 - (b.expectShort ?? 0));
        const knownShort = !b.repair && (lane.repairLand ?? 0) > b.land;
        if (b.hackGot >= expected * 0.999 && b.plannedF > 0 && !b.repair) {
          // Healthy: learn how far actual hacks run over the plan.
          (lane.overRatios ??= []).push(b.hackGot / lane.m.moneyMax / b.plannedF);
          if (lane.overRatios.length > 200) lane.overRatios.shift();
        }
        if (knownShort) {
          // Landed before the repair arrived: expected, already being fixed.
        } else if (b.hackGot < expected * 0.999) {
          const short = 1 - b.hackGot / expected; // fraction the money was short by
          const now = Date.now();
          const drift = {
            at: now,
            target: lane.target,
            short: +short.toFixed(4),
            secOver: +(ns.getServerSecurityLevel(lane.target) - lane.m.minSec).toFixed(3),
            money: +(ns.getServerMoneyAvailable(lane.target) / lane.m.moneyMax).toFixed(4),
            levelUp: ns.getHackingLevel() - (b.level ?? ns.getHackingLevel()),
            late: Math.round(r.late),
            gap: st.spacing,
            repairBatch: !!b.repair,
            stalled: !fairTiming,
          };
          // A small money shortfall: keep batching, and have the next batch
          // grow back the missing money as well. Draining costs two weaken
          // times of no income; a repair costs a few extra grow threads.
          // Drain only if it's large, or repairs aren't fixing it (a repair
          // batch itself came up short).
          const repairable = short <= cfg.repairMaxShortfall && !b.repair && lane.m;
          if (repairable) {
            lane.topUp = Math.max(lane.topUp ?? 0, short);
            drift.action = "repair";
            st.repairs++;
          } else {
            drift.action = "re-prep";
            setMode(st, lane, "drain", "drift");
            lane.firstLand = 0;
            lane.desyncs++;
            st.session.desyncs++;
            cancelQueued(lane);
          }
          st.drifts.push(drift);
          if (st.drifts.length > 50) st.drifts.shift();
        }
      }
    }
  }
  // Exp from workers that have landed is already in the player's exp.
  const now = Date.now();
  if (st.pendingExp.length) {
    const kept = [];
    let total = 0;
    for (const e of st.pendingExp) {
      if (e.land > now) {
        kept.push(e);
        total += e.exp;
      }
    }
    st.pendingExp = kept;
    st.pendingExpTotal = total;
  }
  if (now - (st.lastBatchPrune ?? 0) > 1000) {
    st.lastBatchPrune = now;
    for (const lane of st.lanes.values()) {
      for (const [id, b] of lane.batches) if (b.land < now - 60000) lane.batches.delete(id);
    }
  }
}

/** Catch workers that ended without reporting (killed, crashed, full port). */
function sweep(ns, st) {
  // Workers seen ended at the previous sweep that still haven't reported:
  // their report was lost (a full port drops its oldest message).
  for (const [pid, info] of st.gone) {
    if (info.goneAt < st.lastSweepAt) {
      st.gone.delete(pid);
      st.lostReports++;
      if (info.kind === "hack") st.lostHackReports++;
    }
  }
  for (const [pid, info] of st.pids) {
    if (!ns.isRunning(pid)) {
      st.pids.delete(pid);
      st.lanes.get(info.target)?.pids.delete(pid);
      info.goneAt = Date.now();
      st.gone.set(pid, info);
    }
  }
  st.lastSweepAt = Date.now();
}

// ----------------------------------------------------------------- status ---

/** Income per second over the last minute (or since the first landing, if sooner). */
function recentRate(lane) {
  const now = Date.now();
  lane.income = lane.income.filter((e) => now - e.t <= 60000);
  if (!lane.firstLand || now <= lane.firstLand) return 0;
  const span = Math.min(60000, now - lane.firstLand);
  return (lane.income.reduce((a, e) => a + e.amount, 0) / span) * 1000;
}

function publish(ns, cfg, st, ledger, b) {
  const lanes = [...st.lanes.values()].map((l) => ({
    target: l.target,
    mode: l.mode,
    budget: l.budget ?? 0,
    plan:
      l.plan && l.mode === "batch"
        ? { h: l.plan.h, w1: l.plan.w1, g: l.plan.g, w2: l.plan.w2, f: l.plan.f, P: l.plan.P, conc: l.plan.conc, rate: l.plan.rate, inFlight: l.plan.inFlight }
        : null,
    prep: l.mode === "prep" ? l.prep : null,
    prepLand: l.prepLand ?? 0,
    pre: !!l.pre,
    req: l.req ?? 0,
    workers: l.pids.size,
    money: l.money,
    since: l.started,
    firstLand: l.firstLand,
    recentRate: recentRate(l),
    desyncs: l.desyncs,
    sec: ns.getServerSecurityLevel(l.target),
    minSec: ns.getServerMinSecurityLevel(l.target),
    cash: ns.getServerMoneyAvailable(l.target),
    maxCash: ns.getServerMaxMoney(l.target),
  }));
  // Hacking income as the game itself counts it, independent of reports.
  const now = Date.now();
  const total = ns.getMoneySources().sinceInstall.hacking;
  st.hackIncome.push({ t: now, total });
  while (st.hackIncome.length > 2 && st.hackIncome[0].t < now - 60000) st.hackIncome.shift();
  const first = st.hackIncome[0];
  const actualRate = now > first.t ? ((total - first.total) / (now - first.t)) * 1000 : 0;
  ns.clearPort(cfg.ports.batcher);
  ns.writePort(cfg.ports.batcher, {
    actualRate,
    actualSpan: now - first.t,
    lostReports: st.lostReports,
    lostHackReports: st.lostHackReports,
    updated: Date.now(),
    formulas: st.useFormulas,
    spacing: st.spacing,
    stalls: st.stalls,
    lateStats: st.lateStats ?? null,
    lagStats: st.lagStats ?? null,
    missStats: st.missStats ?? null,
    planStats: st.planStats ?? null,
    planning: !!st.planner,
    lastError: st.lastError ?? null,
    share: {
      threads: st.share.threads,
      homeThreads: st.share.homeThreads ?? 0,
      homeShareGB: ledger.homeShareGB,
      homeRam: ns.getServerMaxRam("home"),
      otherRam: ledger.otherRam,
      power: ns.getSharePower(),
      reserve: st.share.reserve,
      reclaims: st.share.reclaims,
      use: st.share.use,
      why: st.share.why,
      xpThreads: st.share.xpThreads,
      xpTarget: st.share.xpTarget,
    },
    level: ns.getHackingLevel(),
    modeLog: st.modeLog.slice(-20),
    incomeLog: st.incomeLog,
    usage: st.usage ?? null,
    buffer: b,
    capacity: st.capacity,
    totalRam: ledger.totalRam(),
    hosts: ledger.hosts.length,
    workers: st.pids.size,
    maxWorkers: st.slots.cap,
    slotTune: { phase: st.slots.phase, history: st.slots.history.slice(-6) },
    drifts: st.drifts.slice(-10),
    repairs: st.repairs,
    nextReplan: st.nextReplan,
    session: st.session,
    lanes,
  });
}
