import { CONFIG, loadConfig } from "./batch/config.js";
import { scanAll, pathTo } from "./batch/lib.js";

/** Faction servers: backdooring these gets you invitations, so they go first. */
const FACTION_SERVERS = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z"];

/**
 * Backdoors every server you can, without Source-File 4, by typing the
 * commands into the game's terminal for you: `home; connect ...; backdoor`.
 *
 *   run backdoor.js
 *
 * It needs the Terminal screen open, and it only types into an empty
 * terminal, so it waits while you're typing. If you leave the Terminal it
 * pauses and carries on when you come back. It stops by itself when every
 * server you have the level for is done. w0r1d_d43m0n is skipped unless
 * backdoor.includeWorldDaemon is set, because backdooring it ends the BitNode.
 *
 * Touching the game's page costs 25 GB of RAM extra (the game charges for
 * it). If a game update changes the terminal, this stops working; the error
 * it prints will say so.
 * @param {NS} ns
 */
export async function main(ns) {
  loadConfig(ns);
  ns.disableLog("ALL");
  const doc = document; // the game charges 25 GB for this
  const state = { backdoored: [], current: null, remaining: 0, note: "", via: "terminal" };
  const report = () => {
    ns.clearPort(CONFIG.ports.singularity);
    ns.writePort(CONFIG.ports.singularity, { ...state, updated: Date.now() });
  };
  const failed = new Map();

  while (true) {
    const { hosts, parent } = scanAll(ns);
    const level = ns.getHackingLevel();
    const todo = hosts
      .filter((h) => {
        if (h === "home" || h.startsWith("hacknet-")) return false;
        if (h === "w0r1d_d43m0n" && !CONFIG.backdoor.includeWorldDaemon) return false;
        if ((failed.get(h) ?? 0) >= 3) return false;
        const s = ns.getServer(h);
        return !s.purchasedByPlayer && s.hasAdminRights && !s.backdoorInstalled && (s.requiredHackingSkill ?? 0) <= level;
      })
      .sort((a, b) => {
        const fa = FACTION_SERVERS.includes(a) ? 0 : 1;
        const fb = FACTION_SERVERS.includes(b) ? 0 : 1;
        return fa - fb || ns.getServerRequiredHackingLevel(a) - ns.getServerRequiredHackingLevel(b);
      });
    state.remaining = todo.length;
    if (todo.length === 0) {
      state.current = null;
      state.note = "all done";
      report();
      ns.tprint(`backdoor.js: done, ${state.backdoored.length} backdoored this run.`);
      return;
    }

    const host = todo[0];
    state.current = host;
    report();

    // Wait for an open, empty terminal that isn't busy.
    const input = await waitForTerminal(ns, doc, state, report);
    const cmd = ["home", ...pathTo(parent, host).map((h) => `connect ${h}`), "backdoor"].join("; ");
    if (!(await type(ns, input, cmd))) {
      failed.set(host, (failed.get(host) ?? 0) + 1);
      continue;
    }

    // A backdoor takes a quarter of the server's hack time.
    const deadline = Date.now() + ns.getHackTime(host) / 4 + 15000;
    while (!ns.getServer(host).backdoorInstalled && Date.now() < deadline) await ns.sleep(200);
    if (ns.getServer(host).backdoorInstalled) {
      state.backdoored.push(host);
      ns.print(`Backdoored ${host}`);
    } else {
      failed.set(host, (failed.get(host) ?? 0) + 1);
      ns.print(`WARNING: backdoor on ${host} didn't finish; will retry`);
    }
    state.current = null;
    report();
    // Back home, so the terminal is where you left it.
    const back = await waitForTerminal(ns, doc, state, report);
    await type(ns, back, "home");
  }
}

/** The terminal input, once it's on screen, empty and accepting commands. */
async function waitForTerminal(ns, doc, state, report) {
  for (;;) {
    const input = doc.getElementById("terminal-input");
    if (!input) state.note = "waiting: open the Terminal screen";
    else if (input.value !== "") state.note = "waiting: you're typing in the terminal";
    else if (input.disabled) state.note = "waiting: the terminal is busy";
    else {
      state.note = "";
      return input;
    }
    report();
    await ns.sleep(500);
  }
}

/** Type a command into the terminal and press Enter, through React's own handlers. */
async function type(ns, input, cmd) {
  const props = () => {
    const key = Object.keys(input).find((k) => k.startsWith("__reactProps"));
    return key ? input[key] : null;
  };
  const p = props();
  if (!p?.onChange) {
    ns.tprint("backdoor.js: couldn't find the terminal's input handler. A game update may have changed the terminal.");
    return false;
  }
  input.value = cmd;
  p.onChange({ target: input });
  // Let React re-render, so the Enter handler sees the new text.
  await ns.sleep(50);
  const q = props();
  if (!q?.onKeyDown) return false;
  await q.onKeyDown({ key: "Enter", preventDefault: () => {}, stopPropagation: () => {}, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  await ns.sleep(100);
  return true;
}
