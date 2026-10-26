/**
 * Updates every script from the GitHub repo.
 *
 *   run update.js            update if the repo has changed, then restart the suite
 *   run update.js --force    download everything even if nothing changed
 *   run update.js --check    only say whether an update is available
 *   run update.js --no-restart
 *
 * How it works:
 *  1. Asks GitHub for the latest commit on the branch. If it's the one already
 *     installed, there's nothing to do.
 *  2. Lists the files in that commit and finds the folder holding start.js:
 *     that folder maps to your home directory, so the repo can keep the
 *     scripts at its root or in a subfolder.
 *  3. Downloads every script and text file into a temporary folder first.
 *     Only if all of them arrive are they moved into place, so a failed
 *     download never leaves you with half old and half new scripts.
 *  4. Removes files it installed before that are no longer in the repo.
 *  5. Restarts start.js if it was running, so the new code takes over.
 *
 * Downloads use the exact commit (not the branch name), so GitHub's caching
 * can never hand you a stale file.
 * @param {NS} ns
 */

// Your repo. The repo must be public.
const OWNER = "Pattern-Maker";
const REPO = "bitburner";
const BRANCH = "main";

const STATE_DIR = "update/";
const TMP_DIR = "update/tmp/";
const VERSION_FILE = STATE_DIR + "version.txt"; // installed commit
const INSTALLED_FILE = STATE_DIR + "installed.txt"; // files installed last time
// Bitburner can only hold these file types.
const ALLOWED = [".js", ".jsx", ".ts", ".tsx", ".txt", ".json", ".css"];

export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([
    ["force", false],
    ["check", false],
    ["no-restart", false],
  ]);
  const api = `https://api.github.com/repos/${OWNER}/${REPO}`;

  // 1. Latest commit.
  const commit = await getJson(ns, `${api}/commits/${BRANCH}`, STATE_DIR + "commit.json");
  if (!commit?.sha) {
    ns.tprint(`ERROR: couldn't reach ${OWNER}/${REPO} on GitHub. Is the repo public, and the branch "${BRANCH}"?`);
    if (commit?.message) ns.tprint(`GitHub said: ${commit.message}`);
    return;
  }
  const sha = commit.sha;
  const installed = ns.read(VERSION_FILE).trim();
  const short = sha.slice(0, 7);
  const msg = (commit.commit?.message ?? "").split("\n")[0];
  if (installed === sha && !flags.force) {
    ns.tprint(`Already up to date (${short}: ${msg}).`);
    return;
  }
  if (flags.check) {
    ns.tprint(`Update available: ${installed ? installed.slice(0, 7) : "nothing installed"} -> ${short}: ${msg}`);
    return;
  }

  // 2. Files in that commit, and the folder that maps to home.
  const tree = await getJson(ns, `${api}/git/trees/${sha}?recursive=1`, STATE_DIR + "tree.json");
  if (!tree?.tree) {
    ns.tprint("ERROR: couldn't list the repo's files.");
    return;
  }
  const blobs = tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
  const starts = blobs.filter((p) => p === "start.js" || p.endsWith("/start.js")).sort((a, b) => a.split("/").length - b.split("/").length);
  if (starts.length === 0) {
    ns.tprint("ERROR: there's no start.js in the repo, so I can't tell which folder holds the scripts.");
    return;
  }
  const root = starts[0].slice(0, -"start.js".length); // "" or "folder/"
  const files = blobs
    .filter((p) => p.startsWith(root) && ALLOWED.some((ext) => p.endsWith(ext)))
    .map((p) => ({ repoPath: p, gamePath: p.slice(root.length) }))
    .filter((f) => !f.gamePath.startsWith(STATE_DIR));
  ns.tprint(`Updating to ${short}: ${msg}  (${files.length} files from ${root || "repo root"})`);

  // 3. Download everything to a temporary folder first.
  for (const old of ns.ls("home", TMP_DIR)) ns.rm(old, "home");
  const failed = [];
  for (const f of files) {
    const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/${f.repoPath.split("/").map(encodeURIComponent).join("/")}`;
    const ok = await ns.wget(url, TMP_DIR + f.gamePath, "home");
    if (!ok) failed.push(f.gamePath);
  }
  if (failed.length > 0) {
    ns.tprint(`ERROR: ${failed.length} file(s) didn't download, so nothing was changed: ${failed.join(", ")}`);
    return;
  }

  // Note whether the suite is running before anything changes.
  const wasRunning = ns.ps("home").some((p) => p.filename === "start.js");

  // ...then move them all into place.
  const changed = [];
  for (const f of files) {
    const fresh = ns.read(TMP_DIR + f.gamePath);
    if (ns.read(f.gamePath) !== fresh) changed.push(f.gamePath);
    ns.mv("home", TMP_DIR + f.gamePath, f.gamePath);
  }

  // 4. Remove files that were installed before but have left the repo.
  const now = new Set(files.map((f) => f.gamePath));
  const before = ns.read(INSTALLED_FILE).split("\n").filter(Boolean);
  const removed = [];
  for (const p of before) {
    if (now.has(p) || !ns.fileExists(p, "home")) continue;
    if (ns.ps("home").some((proc) => proc.filename === p)) {
      ns.tprint(`  kept ${p}: it was removed from the repo but is still running`);
      continue;
    }
    if (ns.rm(p, "home")) removed.push(p);
  }
  ns.write(INSTALLED_FILE, [...now].join("\n"), "w");
  ns.write(VERSION_FILE, sha, "w");

  ns.tprint(`Updated: ${changed.length} changed${removed.length ? `, ${removed.length} removed` : ""}, ${files.length - changed.length} unchanged.`);
  for (const p of changed) ns.tprint(`  updated ${p}`);
  for (const p of removed) ns.tprint(`  removed ${p}`);

  // 5. Restart so the new code is what runs.
  if (wasRunning && !flags["no-restart"] && changed.length > 0) {
    ns.tprint("Restarting start.js with the new scripts...");
    ns.scriptKill("start.js", "home");
    ns.spawn("start.js", { spawnDelay: 200 });
  } else if (changed.length > 0 && !wasRunning) {
    ns.tprint("Run start.js when you're ready.");
  }
}

/** Download a JSON file from a URL and parse it (null if that fails). */
async function getJson(ns, url, file) {
  if (!(await ns.wget(url, file, "home"))) return null;
  try {
    return JSON.parse(ns.read(file));
  } catch {
    return null;
  }
}
