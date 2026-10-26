import { CONFIG } from "./config.js";
import { scanAll, pathTo, tryRoot, PORT_PROGRAMS, ownedPortPrograms } from "./lib.js";

/** Servers whose backdoor gets you a faction invite (or ends the BitNode). */
const BACKDOOR_TARGETS = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z", "w0r1d_d43m0n"];

/**
 * Rescans the network on a timer: roots everything it can with the port
 * openers you own, copies the workers onto every rooted server, and reports
 * what you could do next (programs to buy, backdoors to install).
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");
  const files = Object.values(CONFIG.workers);
  const port = CONFIG.ports.crawler;
  const firstRooted = new Set();

  while (true) {
    const { hosts, parent } = scanAll(ns);
    const level = ns.getHackingLevel();
    const rootedNow = [];
    const locked = [];

    for (const h of hosts) {
      if (h === "home") continue;
      const had = ns.hasRootAccess(h);
      if (tryRoot(ns, h)) {
        rootedNow.push(h);
        if (!had) firstRooted.add(h);
        if (ns.getServerMaxRam(h) > 0) ns.scp(files, h, "home");
      } else {
        locked.push({ host: h, ports: ns.getServerNumPortsRequired(h) });
      }
    }

    const owned = ownedPortPrograms(ns);
    const nextProgram = PORT_PROGRAMS.find((p) => !owned.includes(p)) ?? null;
    const unlockedByNext = nextProgram ? locked.filter((l) => l.ports === owned.length + 1).length : 0;

    const backdoors = BACKDOOR_TARGETS.filter(
      (h) =>
        h in parent &&
        ns.hasRootAccess(h) &&
        ns.getServerRequiredHackingLevel(h) <= level &&
        !ns.getServer(h).backdoorInstalled,
    ).map((h) => ({ host: h, command: ["home", ...pathTo(parent, h).map((p) => `connect ${p}`), "backdoor"].join("; ") }));

    ns.clearPort(port);
    ns.writePort(port, {
      updated: Date.now(),
      total: hosts.length - 1,
      rooted: rootedNow.length,
      newlyRooted: [...firstRooted].slice(-5),
      ownedPrograms: owned.length,
      nextProgram,
      unlockedByNext,
      formulas: ns.fileExists("Formulas.exe", "home"),
      backdoors,
    });
    await ns.sleep(CONFIG.crawlIntervalMs);
  }
}
