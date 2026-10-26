/**
 * XP worker: weakens one server forever. Hack, grow and weaken all give the
 * same hacking exp per thread, and weaken has no side effects (security can't
 * go below its minimum), so it's the safe way to turn idle RAM into levels.
 * The batcher starts these on spare RAM and stops them when it needs the RAM.
 * @param {NS} ns
 */
export async function main(ns) {
  const [target] = ns.args;
  while (true) await ns.weaken(target);
}
