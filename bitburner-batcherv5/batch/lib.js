/**
 * Shared helpers: network scanning, rooting, the RAM ledger, the model of a
 * target, and the solvers.
 *
 * The solver functions (batchShape, solveStream, prepShape) take plain
 * objects and never touch `ns`, so they can be reasoned about and tested on
 * their own.
 */

// ---------------------------------------------------------------- network --

/** Breadth-first scan of every reachable server. Returns hosts and a parent map. */
export function scanAll(ns) {
  const parent = { home: null };
  const queue = ["home"];
  for (let i = 0; i < queue.length; i++) {
    for (const next of ns.scan(queue[i])) {
      if (!(next in parent)) {
        parent[next] = queue[i];
        queue.push(next);
      }
    }
  }
  return { hosts: queue, parent };
}

/** Terminal commands to reach a host from home, e.g. for a manual backdoor. */
export function pathTo(parent, host) {
  const path = [];
  for (let h = host; h && h !== "home"; h = parent[h]) path.unshift(h);
  return path;
}

/** Port openers in the order you'd normally buy them. */
export const PORT_PROGRAMS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];

export function ownedPortPrograms(ns) {
  return PORT_PROGRAMS.filter((p) => ns.fileExists(p, "home"));
}

/** Open every port we can and nuke if enough are open. Returns root status. */
export function tryRoot(ns, host) {
  if (ns.hasRootAccess(host)) return true;
  const owned = new Set(ownedPortPrograms(ns));
  // Each call is written out so the game's RAM calculator can see it.
  if (owned.has("BruteSSH.exe")) ns.brutessh(host);
  if (owned.has("FTPCrack.exe")) ns.ftpcrack(host);
  if (owned.has("relaySMTP.exe")) ns.relaysmtp(host);
  if (owned.has("HTTPWorm.exe")) ns.httpworm(host);
  if (owned.has("SQLInject.exe")) ns.sqlinject(host);
  if (owned.size >= ns.getServerNumPortsRequired(host)) {
    try {
      ns.nuke(host);
    } catch {
      /* not enough ports after all */
    }
  }
  return ns.hasRootAccess(host);
}

// ------------------------------------------------------------- RAM ledger --

/**
 * Free RAM on every rooted server, kept up to date between refreshes by
 * subtracting what we launch. A refresh reads the live numbers again, so
 * anything bought, upgraded or finished shows up within one refresh.
 */
export class Ledger {
  constructor(ns, cfg, scriptRam, workerFiles) {
    this.ns = ns;
    this.cfg = cfg;
    this.scriptRam = scriptRam; // { hack, grow, weaken } GB per thread
    this.threadRam = Math.max(scriptRam.hack, scriptRam.grow, scriptRam.weaken);
    this.workerFiles = new Set(workerFiles);
    this.hosts = [];
    this.byName = new Map();
    this.coreCache = new Map();
  }

  /** How much more a grow or weaken thread does on a server with these cores. */
  coreRatio(cores) {
    let r = this.coreCache.get(cores);
    if (r === undefined) {
      r = this.ns.weakenAnalyze(1, cores) / this.ns.weakenAnalyze(1, 1);
      this.coreCache.set(cores, r);
    }
    return r;
  }

  refresh(hostNames) {
    const { ns, cfg } = this;
    this.hosts = [];
    this.byName.clear();
    for (const host of hostNames) {
      if (host.startsWith("hacknet-")) continue; // their RAM makes hashes
      const s = ns.getServer(host);
      if (!s.hasAdminRights || s.maxRam <= 0) continue;
      if (s.purchasedByPlayer && host !== "home" && !cfg.usePurchasedServers) continue;
      const reserve = host === "home" ? Math.min(cfg.homeReserveGB, s.maxRam * cfg.homeReserveMaxFraction) : 0;
      const h = {
        host,
        maxRam: s.maxRam,
        reserve,
        free: Math.max(0, s.maxRam - s.ramUsed - reserve),
        cores: s.cpuCores,
        ratio: this.coreRatio(s.cpuCores),
      };
      this.hosts.push(h);
      this.byName.set(host, h);
    }
  }

  /**
   * Worker threads the suite could use in total: free RAM plus RAM our own
   * workers hold right now (it comes back as they finish). RAM used by your
   * other scripts is left alone.
   */
  capacityThreads() {
    let total = 0;
    for (const h of this.hosts) {
      let ours = 0;
      for (const p of this.ns.ps(h.host)) {
        if (this.workerFiles.has(p.filename)) ours += p.threads * (this.scriptRam[kindOf(p.filename)] ?? this.threadRam);
      }
      total += Math.floor((h.free + ours) / this.threadRam);
    }
    return total;
  }

  totalRam() {
    return this.hosts.reduce((s, h) => s + h.maxRam, 0);
  }

  /**
   * Find room for one operation. Hack takes a fixed number of threads and
   * prefers servers with few cores. Grow and weaken take "units" (threads on a
   * 1-core server) and prefer servers with more cores, where each thread
   * counts for more. Returns [{host, threads}] without changing the ledger,
   * or null if it doesn't fit.
   */
  plan(kind, amount) {
    if (amount <= 0) return [];
    const ram = this.scriptRam[kind];
    const byCores = kind === "hack" ? (a, b) => a.cores - b.cores : (a, b) => b.cores - a.cores;
    const hosts = this.hosts.filter((h) => h.free >= ram).sort((a, b) => byCores(a, b) || b.free - a.free);
    const need = (h, left) => (kind === "hack" ? left : Math.ceil(left / h.ratio - 1e-9));
    const gain = (h, t) => (kind === "hack" ? t : t * h.ratio);
    // One server if any can take it all: fewest processes.
    for (const h of hosts) {
      const t = need(h, amount);
      if (Math.floor(h.free / ram) >= t) return [{ host: h.host, threads: t }];
    }
    const pieces = [];
    let left = amount;
    for (const h of hosts) {
      if (left <= 1e-9) break;
      const t = Math.min(Math.floor(h.free / ram), need(h, left));
      if (t <= 0) continue;
      pieces.push({ host: h.host, threads: t });
      left -= gain(h, t);
    }
    return left > 1e-9 ? null : pieces;
  }

  take(kind, pieces) {
    for (const p of pieces) {
      const h = this.byName.get(p.host);
      if (h) h.free -= p.threads * this.scriptRam[kind];
    }
  }

  /**
   * Plan several operations together: either all of them fit at once (and
   * the pieces for each are returned) or none do (null). Nothing is taken.
   */
  planAll(ops) {
    const saved = this.hosts.map((h) => h.free);
    const out = [];
    let ok = true;
    for (const op of ops) {
      const pieces = this.plan(op.kind, op.amount);
      if (!pieces) {
        ok = false;
        break;
      }
      this.take(op.kind, pieces);
      out.push(pieces);
    }
    this.hosts.forEach((h, i) => (h.free = saved[i]));
    return ok ? out : null;
  }
}

function kindOf(filename) {
  if (filename.endsWith("share.js")) return "share";
  if (filename.endsWith("hack.js")) return "hack";
  if (filename.endsWith("grow.js")) return "grow";
  return "weaken";
}

// ------------------------------------------------------------------ model --

/**
 * Everything the solver needs about one target, read from the game.
 * With Formulas.exe the values are for the prepped state (min security, max
 * money) whatever the server looks like now. Without it they come from the
 * live server, so they are exact once it's prepped and pessimistic before.
 */
export function buildModel(ns, target, useFormulas) {
  const base = {
    target,
    moneyMax: ns.getServerMaxMoney(target),
    minSec: ns.getServerMinSecurityLevel(target),
    weakenPer: ns.weakenAnalyze(1, 1), // security removed per weaken thread (1 core)
    hackSec: ns.hackAnalyzeSecurity(1), // security added per hack thread
    growSec: ns.growthAnalyzeSecurity(1), // security added per grow thread
  };
  if (useFormulas) {
    const fh = ns.formulas.hacking;
    const player = ns.getPlayer();
    const server = ns.getServer(target);
    server.hackDifficulty = server.minDifficulty;
    server.moneyAvailable = server.moneyMax;
    return {
      ...base,
      formulas: true,
      server,
      hackPct: fh.hackPercent(server, player),
      chance: fh.hackChance(server, player),
      hackTime: fh.hackTime(server, player),
      growTime: fh.growTime(server, player),
      weakenTime: fh.weakenTime(server, player),
      growThreads: (f) => {
        const s = { ...server, moneyAvailable: Math.max(0, base.moneyMax * (1 - f)) };
        return Math.ceil(fh.growThreads(s, player, base.moneyMax, 1));
      },
    };
  }
  return {
    ...base,
    formulas: false,
    hackPct: ns.hackAnalyze(target),
    chance: ns.hackAnalyzeChance(target),
    hackTime: ns.getHackTime(target),
    growTime: ns.getGrowTime(target),
    weakenTime: ns.getWeakenTime(target),
    growThreads: (f) => {
      const left = Math.max(1 - f, 1 / base.moneyMax);
      return Math.ceil(ns.growthAnalyze(target, 1 / left, 1));
    },
  };
}

/** Threads (1-core units) to bring a server from its current state to prepped. */
export function prepNeeds(ns, m) {
  const t = m.target;
  const secExcess = Math.max(0, ns.getServerSecurityLevel(t) - m.minSec);
  const money = ns.getServerMoneyAvailable(t);
  let g = 0;
  if (money < m.moneyMax) {
    if (m.formulas) {
      // Grow lands after the first weaken, so price it at min security.
      const s = { ...m.server, moneyAvailable: money };
      g = Math.ceil(ns.formulas.hacking.growThreads(s, ns.getPlayer(), m.moneyMax, 1));
    } else {
      g = Math.ceil(ns.growthAnalyze(t, m.moneyMax / Math.max(money, 1), 1));
    }
  }
  const w1 = Math.ceil(secExcess / m.weakenPer);
  const w2 = Math.ceil((g * m.growSec) / m.weakenPer);
  return { w1, g, w2, total: w1 + g + w2, secExcess };
}

// ----------------------------------------------------------------- solver --

/** Threads one HWGW batch needs if it hacks with `h` threads. */
export function batchShape(m, h, hackPct = m.hackPct) {
  const f = Math.min(1, h * hackPct); // fraction of money taken
  const g = m.growThreads(f); // threads to grow it back to max
  const w1 = Math.ceil((h * m.hackSec) / m.weakenPer); // undo hack's security
  const w2 = Math.ceil((g * m.growSec) / m.weakenPer); // undo grow's security
  return { h, f, g, w1, w2, total: h + w1 + g + w2 };
}

/**
 * The equilibrium for a continuous pipeline: one batch lands every P ms, and
 * each worker only holds RAM while it's actually running (plus a small launch
 * buffer). For a batch landing period P, the threads in use at any moment are
 *
 *   h·⌈(hackTime+b)/P⌉ + g·⌈(growTime+b)/P⌉ + (w1+w2)·⌈(weakenTime+b)/P⌉
 *
 * For each P, bisection finds the largest hack size whose full restoration
 * still fits the budget (the balance point). Income is f·money·chance / P,
 * and the P with the most income per second wins.
 *
 * P at its largest (one batch in flight) is "one batch using every thread";
 * smaller P splits the same threads into more, smaller batches.
 *
 * @param m           model from buildModel
 * @param budget      worker threads this target may use
 * @param spacing     ms between landings inside a batch
 * @param buffer      ms each worker is launched ahead of its start
 * @param maxInFlight most batches this target may have in flight (script cap)
 */
export function solveStream(m, budget, spacing, buffer, maxInFlight) {
  if (!(m.hackPct > 0) || !(m.moneyMax > 0) || !(m.chance > 0) || budget <= 0 || maxInFlight < 1) return null;

  const hMax = Math.max(1, Math.ceil(1 / m.hackPct) - 1); // keep f < 1
  // Shapes don't depend on the budget, so one cache per model is shared by
  // every solve the planner runs for this target.
  const cache = (m.shapeCache ??= new Map());
  const shape = (h) => {
    let s = cache.get(h);
    if (!s) cache.set(h, (s = batchShape(m, h)));
    return s;
  };
  // Each worker holds RAM from launch (buffer early) until it lands, and may
  // finish up to about one landing gap late; count both so the next batch's
  // workers never find the previous ones still holding their RAM.
  const Th = m.hackTime + buffer + 2 * spacing;
  const Tg = m.growTime + buffer + 2 * spacing;
  const Tw = m.weakenTime + buffer + 2 * spacing;
  const conc = (s, P) => s.h * Math.ceil(Th / P) + s.g * Math.ceil(Tg / P) + (s.w1 + s.w2) * Math.ceil(Tw / P);

  const balance = (P) => {
    if (conc(shape(1), P) > budget) return 0;
    if (conc(shape(hMax), P) <= budget) return hMax;
    let lo = 1; // fits
    let hi = hMax; // doesn't fit
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (conc(shape(mid), P) <= budget) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  const evaluate = (P) => {
    const h = balance(P);
    if (!h) return null;
    const s = shape(h);
    return {
      ...s,
      P,
      conc: conc(s, P),
      inFlight: Math.ceil(Tw / P),
      rate: (s.f * m.moneyMax * m.chance) / P, // $ per ms
    };
  };

  // Longest useful period: one batch at a time. Shortest: limited by the
  // landing gap and by how many batches may be in flight.
  const Pmax = Tw + 4 * spacing;
  const Pmin = Math.min(Pmax, Math.max(4 * spacing, Tw / maxInFlight));
  const Ps = [];
  for (let P = Pmin; P < Pmax; P *= 1.08) Ps.push(P);
  Ps.push(Pmax);

  let best = null;
  let bestIdx = 0;
  Ps.forEach((P, i) => {
    const r = evaluate(P);
    if (r && (!best || r.rate > best.rate)) {
      best = r;
      bestIdx = i;
    }
  });
  if (!best) return null;
  // Refine between the coarse neighbours of the winner.
  const lo = Ps[Math.max(0, bestIdx - 1)];
  const hi = Ps[Math.min(Ps.length - 1, bestIdx + 1)];
  for (let i = 1; i < 40; i++) {
    const r = evaluate(lo + ((hi - lo) * i) / 40);
    if (r && r.rate > best.rate) best = r;
  }
  return best;
}

/**
 * Threads to prep a target with a budget: weaken to minimum first, then the
 * largest grow whose own weaken still fits (bisection again).
 */
export function prepShape(budget, need, m) {
  const w1 = Math.min(budget, need.w1);
  const rem = budget - w1;
  const cost = (g) => g + Math.ceil((g * m.growSec) / m.weakenPer);
  let g = 0;
  if (need.g > 0 && cost(1) <= rem) {
    if (cost(need.g) <= rem) g = need.g;
    else {
      let lo = 1;
      let hi = need.g;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (cost(mid) <= rem) lo = mid;
        else hi = mid;
      }
      g = lo;
    }
  }
  const w2 = Math.ceil((g * m.growSec) / m.weakenPer);
  return { w1, g, w2, total: w1 + g + w2, complete: w1 >= need.w1 && g >= need.g };
}

// ------------------------------------------------------------------- misc --

export function isPrepped(ns, target) {
  return (
    ns.getServerSecurityLevel(target) <= ns.getServerMinSecurityLevel(target) + 1e-9 &&
    ns.getServerMoneyAvailable(target) >= ns.getServerMaxMoney(target) - 1e-6
  );
}

/** Drain every message currently waiting on a port. */
export function drainPort(ns, port) {
  const out = [];
  for (;;) {
    const msg = ns.readPort(port);
    if (msg === "NULL PORT DATA") break;
    out.push(msg);
  }
  return out;
}
