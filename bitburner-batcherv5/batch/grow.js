/**
 * Grow worker. Args: target, plannedEnd (ms epoch), id, reportPort, minSec, maxWait.
 *
 * An operation's duration is fixed the moment it starts, from the target's
 * security at that moment. So if another batch has just raised security, this
 * waits until it's back at minimum before starting, for at most maxWait ms
 * (one landing gap or so). minSec < 0 means "don't wait" (used for prep,
 * where security is high on purpose).
 * The delay is then worked out here, so slow launches and level-ups don't
 * move the landing time.
 * @param {NS} ns
 */
export async function main(ns) {
  const [target, plannedEnd, id, port, minSec, maxWait] = ns.args;
  if (minSec >= 0) {
    const until = Date.now() + maxWait;
    while (ns.getServerSecurityLevel(target) > minSec + 1e-9 && Date.now() < until) await ns.sleep(1);
  }
  const delay = Math.max(0, plannedEnd - Date.now() - ns.getGrowTime(target));
  await ns.grow(target, { additionalMsec: delay });
  ns.writePort(port, { type: "G", pid: ns.pid, id, target, late: Date.now() - plannedEnd, aborted: false, amount: 0 });
}
