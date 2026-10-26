/**
 * Kill and delete leftover scripts on every server.
 *
 *   run cleanup.js                      preview: lists every worker.js it would remove
 *   run cleanup.js --go                 actually removes them
 *   run cleanup.js hack.js grow.js --go remove other names instead
 *   run cleanup.js --home --go          include home too (skipped by default)
 *
 * Names match the end of the file path, so "worker.js" also catches
 * "old/worker.js". Running copies are killed first, since the game won't
 * delete a running script.
 * @param {NS} ns
 */
export async function main(ns) {
  const flags = ns.flags([
    ["go", false],
    ["home", false],
  ]);
  const names = flags._.length > 0 ? flags._.map(String) : ["worker.js"];

  // Every reachable server, including ones you bought.
  const hosts = ["home"];
  for (let i = 0; i < hosts.length; i++) {
    for (const next of ns.scan(hosts[i])) if (!hosts.includes(next)) hosts.push(next);
  }

  let found = 0;
  let removed = 0;
  for (const host of hosts) {
    if (host === "home" && !flags.home) continue;
    if (!ns.hasRootAccess(host)) continue;
    const files = ns.ls(host).filter((f) => names.some((n) => f === n || f.endsWith("/" + n)));
    for (const file of files) {
      found++;
      if (!flags.go) {
        ns.tprint(`would remove  ${host}: ${file}`);
        continue;
      }
      ns.scriptKill(file, host);
      if (ns.rm(file, host)) removed++;
      else ns.tprint(`WARNING couldn't remove ${host}: ${file}`);
    }
  }

  if (!flags.go) ns.tprint(`Found ${found} file(s) matching ${names.join(", ")}. Run again with --go to remove them.`);
  else ns.tprint(`Removed ${removed} of ${found} file(s) matching ${names.join(", ")}.`);
}
