/**
 * Grow worker. Args: target, plannedEnd (ms epoch), id, reportPort.
 *
 * The game applies an operation's effect the moment its timer fires, and
 * timers fire in due-time order even when the game is running late. So the
 * landing is exact as long as the worker can still schedule it: it adds
 * whatever delay makes the operation end at plannedEnd. That spare time is
 * the "slack" it reports; negative slack means it started too late.
 * @param {NS} ns
 */
export async function main(ns) {
  const [target, plannedEnd, id, port, minSec = -1, maxWait = 0] = ns.args;
  // An operation's duration is fixed when it starts, from the security at
  // that moment. Just after another batch's hack or grow lands, security is
  // briefly raised (until its weaken lands, one gap later), and starting then
  // would make this take far longer than planned. So wait for minimum
  // security first, for at most maxWait ms.
  if (minSec >= 0) {
    const until = Date.now() + maxWait;
    while (ns.getServerSecurityLevel(target) > minSec + 1e-9 && Date.now() < until) await ns.sleep(1);
  }
  const slack = plannedEnd - Date.now() - ns.getGrowTime(target);
  // Starting too late shifts the landing later by -slack ms; the batcher
  // launches earlier when that happens.
  await ns.grow(target, { additionalMsec: Math.max(0, slack) });
  ns.writePort(port, { type: "G", pid: ns.pid, id, target, slack, late: Date.now() - plannedEnd, aborted: false, amount: 0 });
}
