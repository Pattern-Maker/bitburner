/**
 * Share worker: lends this script's RAM to your factions. While you do
 * faction work, reputation gain is multiplied by 1 + ln(shared threads) / 25.
 * The batcher starts these on spare RAM and stops them when it needs the
 * RAM back.
 * @param {NS} ns
 */
export async function main(ns) {
  while (true) await ns.share();
}
