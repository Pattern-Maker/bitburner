import { CONFIG } from "./batch/config.js";
import { scanAll } from "./batch/lib.js";

const CORE = ["batch/crawler.js", "batch/batcher.js", "batch/status.js"];
const EXTRAS = ["batch/buyer.js", "batch/singularity.js"];

/**
 * One script to run everything. Stops old copies, clears leftover workers,
 * starts the crawler, waits for its first pass, then starts the batcher and
 * status window. Afterwards it stays running and restarts anything that dies.
 * @param {NS} ns
 */
export async function main(ns) {
  ns.disableLog("ALL");

  // Singularity (backdoors, home RAM) needs Source-File 4 or BitNode 4.
  const reset = ns.getResetInfo();
  const hasSingularity = reset.currentNode === 4 || (reset.ownedSF.get(4) ?? 0) > 0;
  const SERVICES = [...CORE, "batch/buyer.js", ...(hasSingularity ? ["batch/singularity.js"] : [])];
  for (const s of EXTRAS) ns.scriptKill(s, "home");

  for (const s of SERVICES) ns.scriptKill(s, "home");
  const { hosts } = scanAll(ns);
  for (const h of hosts) for (const w of Object.values(CONFIG.workers)) ns.scriptKill(w, h);
  for (const p of Object.values(CONFIG.ports)) ns.clearPort(p);

  if (!launch(ns, SERVICES[0])) return;
  // Wait for the crawler's first pass so the batcher sees rooted servers.
  while (ns.peek(CONFIG.ports.crawler) === "NULL PORT DATA") await ns.sleep(200);
  if (!launch(ns, SERVICES[1])) return;
  launch(ns, SERVICES[2], "--tail");
  for (const s of SERVICES.slice(3)) launch(ns, s);
  ns.tprint("Batching suite started. The status window shows what it's doing.");
  if (!hasSingularity) ns.tprint("No Singularity (Source-File 4), so backdoors and home RAM stay manual.");

  // Restart anything that stops, but give up on a script that keeps crashing
  // (3 times in 2 minutes) instead of throwing up an error dialog every 5 s.
  const restarts = {};
  const gaveUp = new Set();
  const warned = new Set();
  while (true) {
    await ns.sleep(5000);
    // Match by filename only: isRunning() also compares arguments, and status
    // runs with "--tail".
    const running = new Set(ns.ps("home").map((p) => p.filename));
    for (const s of SERVICES) {
      if (gaveUp.has(s) || running.has(s)) continue;
      const now = Date.now();
      restarts[s] = (restarts[s] ?? []).filter((t) => now - t < 120000);
      if (restarts[s].length >= 3) {
        gaveUp.add(s);
        ns.tprint(`ERROR: ${s} keeps crashing, so it won't be restarted. Fix the error it shows, then run start.js again.`);
        continue;
      }
      const pid = ns.run(s);
      if (pid > 0) {
        restarts[s].push(now);
        warned.delete(s);
        ns.tprint(`Restarted ${s}`);
      } else if (!warned.has(s)) {
        ns.tprint(`WARNING: ${s} stopped and there isn't enough RAM on home to restart it.`);
        warned.add(s);
      }
    }
  }
}

function launch(ns, script, ...args) {
  const pid = ns.run(script, 1, ...args);
  if (pid === 0) {
    const need = ns.getScriptRam(script, "home");
    const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
    ns.tprint(`ERROR: couldn't start ${script}. It needs ${ns.format.ram(need)}, home has ${ns.format.ram(free)} free.`);
    return false;
  }
  return true;
}
