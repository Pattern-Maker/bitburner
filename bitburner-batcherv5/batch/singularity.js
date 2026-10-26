import { CONFIG } from "./config.js";
import { scanAll, pathTo } from "./lib.js";

/** Faction servers: backdooring these gets you invitations, so they go first. */
const FACTION_SERVERS = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z"];

/**
 * Needs Singularity (Source-File 4, or being in BitNode 4); start.js only
 * runs it when you have that.
 *
 * Backdoors: every rooted server you have the level for, faction servers
 * first. It connects hop by hop, installs the backdoor, then goes back home.
 * Your terminal follows it around while it works, so if you're typing in the
 * terminal at the time, `home` takes you back. w0r1d_d43m0n is skipped unless
 * you opt in, because backdooring it ends the BitNode.
 *
 * Home RAM: upgrades home when RAM is the bottleneck (same rule as buyer.js)
 * and home is no dearer per GB than cloud servers, or cloud servers are
 * all maxed out.
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  const sing = ns.singularity;
  const state = { backdoored: [], current: null, failed: {}, home: null };
  let lastBackdoorScan = 0;
  let lastHomeBuy = 0;

  const report = () => {
    ns.clearPort(CONFIG.ports.singularity);
    ns.writePort(CONFIG.ports.singularity, { ...state, updated: Date.now() });
  };

  while (true) {
    try {
      // ---- home RAM ----
      if (CONFIG.buy.enabled && CONFIG.buy.homeRam) {
        state.home = homeRam(ns, sing, lastHomeBuy);
        if (state.home.bought) lastHomeBuy = Date.now();
      }

      // ---- backdoors ----
      if (CONFIG.backdoor.enabled && Date.now() - lastBackdoorScan >= CONFIG.backdoor.intervalMs) {
        lastBackdoorScan = Date.now();
        const { hosts, parent } = scanAll(ns);
        const level = ns.getHackingLevel();
        const todo = hosts
          .filter((h) => {
            if (h === "home" || h.startsWith("hacknet-")) return false;
            if (h === "w0r1d_d43m0n" && !CONFIG.backdoor.includeWorldDaemon) return false;
            const s = ns.getServer(h);
            return !s.purchasedByPlayer && s.hasAdminRights && !s.backdoorInstalled && (s.requiredHackingSkill ?? 0) <= level;
          })
          // Faction servers first, then quickest (lowest level) first.
          .sort((a, b) => {
            const fa = FACTION_SERVERS.includes(a) ? 0 : 1;
            const fb = FACTION_SERVERS.includes(b) ? 0 : 1;
            return fa - fb || ns.getServerRequiredHackingLevel(a) - ns.getServerRequiredHackingLevel(b);
          });
        state.remaining = todo.length;
        for (const host of todo) {
          if ((state.failed[host] ?? 0) >= 3) continue;
          state.current = host;
          report();
          const ok = await backdoor(ns, sing, parent, host);
          if (ok) state.backdoored.push(host);
          else state.failed[host] = (state.failed[host] ?? 0) + 1;
          state.current = null;
          state.remaining--;
          report();
          // Home RAM shouldn't wait behind a long list of backdoors.
          if (CONFIG.buy.enabled && CONFIG.buy.homeRam) {
            state.home = homeRam(ns, sing, lastHomeBuy);
            if (state.home.bought) lastHomeBuy = Date.now();
          }
        }
      }
    } catch (e) {
      state.error = String(e?.message ?? e);
      try {
        sing.connect("home");
      } catch {
        /* already home */
      }
    }
    report();
    await ns.sleep(2000);
  }
}

async function backdoor(ns, sing, parent, host) {
  try {
    sing.connect("home");
    for (const hop of pathTo(parent, host)) {
      if (!sing.connect(hop)) {
        sing.connect("home");
        return false;
      }
    }
    await sing.installBackdoor();
    sing.connect("home");
    return ns.getServer(host).backdoorInstalled === true;
  } catch {
    sing.connect("home");
    return false;
  }
}

/** Upgrade home RAM once if it's worth it right now. */
function homeRam(ns, sing, lastBuyAt) {
  const cfg = CONFIG.buy;
  const b = ns.peek(CONFIG.ports.batcher);
  const cost = sing.getUpgradeHomeRamCost();
  const homeMax = ns.getServerMaxRam("home");
  const info = { cost, ram: homeMax * 2, bought: false };
  if (!isFinite(cost) || cost <= 0) return { ...info, note: "home RAM is at maximum" };
  if (b === "NULL PORT DATA" || !b.usage || !b.planStats || b.planStats.at <= lastBuyAt) return { ...info, note: "waiting for the batcher's plan" };
  const usedFrac = b.usage.capacity > 0 ? b.usage.used / b.usage.capacity : 1;
  if (usedFrac < cfg.minUsedFraction) return { ...info, note: `paused: only ${(usedFrac * 100).toFixed(0)}% of RAM in use` };

  // Compare with the cheapest cloud GB still available.
  const cloudMaxed =
    ns.cloud.getServerNames().length >= ns.cloud.getServerLimit() &&
    ns.cloud.getServerNames().every((h) => ns.getServerMaxRam(h) >= ns.cloud.getRamLimit());
  const cloudPerGB = ns.cloud.getServerCost(2) / 2;
  const homePerGB = cost / homeMax; // an upgrade doubles home RAM
  if (!cloudMaxed && homePerGB > cloudPerGB) return { ...info, note: "cloud servers are cheaper per GB for now" };
  if (cost > ns.getServerMoneyAvailable("home") * cfg.spendFraction) return { ...info, note: "saving up" };
  if (sing.upgradeHomeRam()) {
    ns.print(`Upgraded home RAM to ${ns.format.ram(homeMax * 2)} for $${ns.format.number(cost)}`);
    return { ...info, bought: true, note: `upgraded to ${ns.format.ram(homeMax * 2)}` };
  }
  return { ...info, note: "upgrade failed" };
}
