#!/usr/bin/env node
// run-phases.js - runs a batch of local builder / fixer phases with no Claude
// session needed: for each phase in a plan file it writes the prompt, calls
// run-local.sh, checks the result, runs the self-test, and commits with the
// subject dev/disclosure.js reads ("phase N: builder, first try, ..." /
// "phase N: fixer try K, ..."). It stops at the first thing that needs a
// person, leaves the tree as the run left it, and says what to look at.
//
//   node run-phases.js plan.txt                 run the plan
//   node run-phases.js plan.txt --dry-run       check everything, run no model
//   node run-phases.js plan.txt --from 19       start at phase 19 of the plan
//        (after a stop: the tree must first give phase 18's line - no need
//        to trim the plan; if HEAD is phase 19's failed attempt, it goes on
//        with that phase's next fixer try - see AFTER A STOP)
//   node run-phases.js plan.txt --co-author "Claude Sonnet 5.5"
//        (only when a Claude Code session starts it: adds that model's
//        Co-Authored-By line to each commit; builder / fixer commits still
//        credit the local model - their subject says so)
//   node run-phases.js plan.txt --no-fixer      stop at the first mismatch
//   node run-phases.js plan.txt --no-early-finish   let every run end itself
//   node run-phases.js --ps-check               can the runner see dsh? (lists
//        any dsh running now; exit 0 none, 1 some, 2 no process list)
//
// Run it from Git Bash in the project folder, next to run-local.sh (the same
// folder LOCAL-SUBAGENTS.md lives in). It never pushes, never merges, and
// refuses to run on the project's shared branches.
//
// THE PLAN FILE - one line per phase, in order; # starts a comment:
//   start  SELF-TEST 11/26 FAIL: map path ask
//   7   SELF-TEST 14/26 FAIL: map map2 path
//   8   SELF-TEST 18/26 FAIL: ask nerve cards
//   9   SELF-TEST 26/26 PASS
//   replay-same-as  origin/working
// Each phase line: the phase number, then the self-test line the spec expects
// after that phase (exactly as the self-test prints it). The optional start
// line: the self-test line of the tree before the first phase (the stub
// commit's). The optional replay-same-as line: at the end, the self-test's
// replay lines must be the same as they are on that branch or commit.
//
// THE PROJECT (phase-runner.json next to this file, optional - these are the
// defaults, which fit Amontillado):
//   { "spec": "specs/AMONTILLADO-SPEC.txt", "phaseFile": "game.html",
//     "selftest": "node dev/selftest.js", "disclosure": "node dev/disclosure.js",
//     "protectedBranches": ["working", "main", "working-claude", "reference"],
//     "builderMinutes": 10, "fixerMinutes": 30, "fixerTries": 2,
//     "earlyFinish": true, "quietSeconds": 120, "checkSeconds": 15,
//     "stubComments": "auto", "ollamaVersion": "", "gpuCheck": true,
//     "keepDisplayOn": true }
// stubComments: R4, below - "auto" checks a block whose stub has a "STUBS for
// now" line, true every block, false none. ollamaVersion, gpuCheck,
// keepDisplayOn: OLLAMA and THE DISPLAY, below.
//
// OLLAMA (2026-11-03, cardtacticsgame NEXT 24b: Ollama's auto-updates brought
// driver crashes, and once a server that found no GPU). Before a batch, and
// in its dry run: Ollama must answer (GET /api/version, else ollama
// --version); with "ollamaVersion": "0.40.11" set, any other version refuses
// the batch (exit 2); with gpuCheck on (the default), a model already loaded
// with part of it on the CPU, or Ollama's log (server.log) saying its last
// start found no GPU (library=cpu), refuses it too (exit 5). Before each run
// the version must still be the batch's. While a run goes, every checkSeconds
// the runner reads GET /api/ps: when the loaded model's size_vram is below its
// size in two readings in a row (ollama ps: anything but "100% GPU"), it ends
// the run and stops the batch at once (exit 5) with the steps to restart
// Ollama. Ollama's version goes into each runs.csv row (its last column) and
// the report; commits carry no new trailer. The API is at OLLAMA_HOST, as for
// the ollama command (default 127.0.0.1:11434).
//
// THE DISPLAY (keepDisplayOn, default true): on Windows a hidden PowerShell
// child holds SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
// ES_DISPLAY_REQUIRED) while a batch runs, so the display doesn't turn off
// (which starts Modern Standby on the laptop). The runner ends it when it
// exits, Ctrl+C included, and it ends itself within 15 s when the runner's
// process is gone. Windows' own power settings are not touched.
//
// BEFORE EACH PHASE the self-test must give the previous phase's plan line
// (for the first phase: the plan's start line, or with --from N the plan's
// line for the phase before N). If it doesn't, the fault is in an earlier
// block or a hand commit's line, so the batch stops before any model runs.
// Also, a commit whose subject names a SELF-TEST line ("phase N: ...,
// SELF-TEST ...") must be the tree that prints it.
//
// AFTER A STOP (cardtacticsgame NEXT 10a): a phase's failed attempts are
// committed as "phase N: builder, first try, LINE (spec: EXPECTED)" and
// "phase N: fixer try K, ... (spec: ...)". When HEAD is such a commit for the
// first phase that runs (with --from N, or the plan's first phase), the
// runner never runs the builder over it again: it checks that only the
// PHASE N block changed since the commit before the builder's attempt, that
// that commit gives the line before phase N (a self-test in a temporary
// worktree), and goes on with fixer try K+1. With the tries used up, or after
// the fixer gives up or answers NOT A BUG / SPEC MISMATCH, it stops and
// prints the ways on with the real hash: git revert --no-edit <hash>..HEAD
// and --from N for a fresh builder run, or a hand fix committed with the
// self-test's own line and --from the next phase. HEAD being another phase's
// failed attempt, or a phase already committed with its plan line, stops
// with what to run instead.
//
// R4, THE STUB'S COMMENT LINES (cardtacticsgame NEXT 10b; the specs' rule
// R4): the block's whole comment lines (// or /* at the start, compared
// trimmed) must be the stub's - the block as it was before the builder - less
// its "STUBS for now" line, which must be gone; no other comment lines. A
// slip stops the phase like any other: nothing is committed, the report says
// which lines, and early finish waits until the comments are right.
//
// A PROBE THAT THREW (cardtacticsgame NEXT 10c): the self-test prints
// "probe error: NAME threw: MESSAGE" (or, from an older one, "console: probe
// NAME threw: MESSAGE"). Those lines go into the fixer prompt and don't count
// as page errors: the probe already counts as failing in the SELF-TEST line.
//
// EARLY FINISH (while a builder or fixer runs, every checkSeconds): when the
// phase file has changed and then stayed the same for quietSeconds, only its
// PHASE N block changed (no other file, no new file), and the self-test
// already prints the plan's line with no red banner or page errors, the
// runner ends the model's run and commits it as a normal success. Its commit
// body says so. Each state of the file is tested once.
//
// WHAT COUNTS AS A GOOD RUN (all of these, or the batch stops):
//   run-local.sh exits 0 (exit 4 = driver crash: restart Windows; exit 5 =
//     the model on the CPU: restart Ollama), or the runner ended it (early
//     finish or the time limit, below)
//   the model stayed all on the GPU (OLLAMA, above)
//   HEAD and the branch are where they were (the model made no commit or checkout)
//   no settings file (phase-runner.json, the plan, run-phases.js,
//     run-local.sh) changed that git sees
//   only the phase file changed, no new files, and only inside its PHASE N
//     block - the START / END lines and the block's last line,
//     PHASE_OK[N] = true;, untouched
//   the block's comment lines keep R4 (above)
//   no git command text in the answer or reasoning (run-local.sh's
//     "!! git command text" flag; for a run the runner ended, the same
//     search on the files it left)
// Then the self-test decides: its line must be the plan's expected line, with
// no red banner and no page errors. The answer's last line should be DONE
// PHASE N; without it, or when the run reached its time limit, the work is
// committed only if the self-test already gives the plan's line (the body
// says which), and otherwise the batch stops. With DONE PHASE N and another
// line, the builder's attempt is committed as it is (its subject says what
// it got) and the fixer gets up to fixerTries tries, each committed. A fixer
// that answers NOT A BUG or SPEC MISMATCH stops the batch (a builder's answer
// is never read as a verdict).
//
// ENDING A RUN (the time limit, an early finish, Ctrl+C): the runner lists the
// processes first, ends run-local.sh's whole tree and every dsh started since
// the run began (by its command line: on Windows, taskkill /T on the bash did
// not reach dsh's node.exe - RUNNER-TEST.md test 3), then lists again until
// none is left. Only then is the tree judged, so a dsh that can still write
// never sits behind a "changed nothing". A dsh still running after a run that
// ended by itself is ended too (a note). If one can't be ended, or the
// processes can't be listed, the batch stops and says what to run.
//
// Every commit carries Local-Model: (what Ollama had loaded at the end of
// the run) and Committed-By: run-phases.js, and --co-author's line if given.
//
// Exit codes: 0 every phase committed with its expected line (and the replay
// lines the same, if asked); 1 stopped - read the report; 2 setup problem
// (Ollama's version not the pinned one among them); 4 driver crash (restart
// Windows before any further run); 5 the model is, or would be, on the CPU
// (restart Ollama).
// (The stand-in kit, test/, sets RUNNER_OLLAMA_LOG for the log's place and
// RUNNER_FORCE_KEEP_AWAKE to its stand-in display child, run instead of
// PowerShell on any platform.)

"use strict";
const { spawn, spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ---- settings ---------------------------------------------------------------
const DEFAULTS = {
  spec: "specs/AMONTILLADO-SPEC.txt",
  phaseFile: "game.html",
  selftest: "node dev/selftest.js",
  disclosure: "node dev/disclosure.js",
  protectedBranches: ["working", "main", "working-claude", "reference"],
  builderMinutes: 10,
  fixerMinutes: 30,
  fixerTries: 2,
  earlyFinish: true,
  quietSeconds: 120,
  checkSeconds: 15,
  stubComments: "auto",
  ollamaVersion: "",
  gpuCheck: true,
  keepDisplayOn: true
};

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
function opt(n) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; }
const TAKES_VALUE = ["--co-author", "--from"];
const planPath = argv.find((a, i) => !a.startsWith("--") && !TAKES_VALUE.includes(argv[i - 1]));
const dryRun = flag("--dry-run");
const noFixer = flag("--no-fixer");
const coAuthor = opt("--co-author");
const fromPhase = opt("--from");

function die(msg, code) { console.error("run-phases: " + msg); process.exit(code || 2); }
function say(msg) { console.log(msg); }

if (!planPath && !flag("--ps-check")) die("usage: node run-phases.js <plan file> [--dry-run] [--from N] [--no-fixer] [--no-early-finish] [--co-author \"Claude Sonnet 5.5\"]  |  node run-phases.js --ps-check");
if (coAuthor && !/^Claude [A-Za-z]+ \d+(\.\d+)?$/.test(coAuthor)) die("--co-author takes a Claude model name, e.g. \"Claude Sonnet 5.5\"");
if (flag("--from") && !/^\d+$/.test(fromPhase || "")) die("--from takes a phase number from the plan, e.g. --from 19");

let cfg = Object.assign({}, DEFAULTS);
if (fs.existsSync("phase-runner.json")) {
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync("phase-runner.json", "utf8"))); }
  catch (e) { die("phase-runner.json: " + e.message); }
}
if (noFixer) cfg.fixerTries = 0;
if (flag("--no-early-finish")) cfg.earlyFinish = false;

// ---- small helpers ----------------------------------------------------------
function git(args, opts) {
  return execFileSync("git", args, Object.assign({ encoding: "utf8", maxBuffer: 1 << 26 }, opts || {})).replace(/\s+$/, "");
}
// The same while a model runs: no optional index lock, so the runner never
// holds .git/index.lock while the model works in the tree.
function gitQuiet(args) { return git(["--no-optional-locks"].concat(args)); }
// The stored text of a file at a commit, untrimmed (git() trims the end).
function gitShow(spec) { return execFileSync("git", ["show", spec], { encoding: "utf8", maxBuffer: 1 << 26 }); }
function gitOk(args) { return spawnSync("git", args, { encoding: "utf8" }).status === 0; }
function untracked() { return gitQuiet(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).sort(); }
function stamp() { const d = new Date(), p = n => String(n).padStart(2, "0"); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function lastLine(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !/^\s*```/.test(l));
  return (lines[lines.length - 1] || "").trim();
}
function readOr(file, dflt) { try { return fs.readFileSync(file, "utf8"); } catch (e) { return dflt; } }
// A file's content hash, or "" when it doesn't exist.
function hashOf(file) { try { return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex"); } catch (e) { return ""; } }
// The command line the project gives as a string ("node dev/selftest.js"),
// split on spaces - keep project commands free of quoted arguments.
function cmdParts(s, extra) { const p = s.trim().split(/\s+/); return { cmd: p[0], args: p.slice(1).concat(extra || []) }; }

// ---- the phase blocks --------------------------------------------------------
const START = n => "// ==== PHASE " + n + " START ====";
const END = n => "// ==== PHASE " + n + " END ====";
const OKLINE = n => "PHASE_OK[" + n + "] = true;";
// The file with the PHASE n block's inside taken out, or an error string.
// Line endings are made LF first: a Windows checkout has CRLF on disk while
// git show gives the stored LF text.
function outsideBlock(text, n) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const s = lines.findIndex(l => l.trim() === START(n));
  const e = lines.findIndex(l => l.trim() === END(n));
  if (s < 0 || e < 0 || e < s) return { error: "the PHASE " + n + " START / END lines are missing or out of order" };
  if (lines.filter(l => l.trim() === START(n)).length > 1 || lines.filter(l => l.trim() === END(n)).length > 1) return { error: "the PHASE " + n + " START or END line appears twice" };
  if ((lines[e - 1] || "").trim() !== OKLINE(n)) return { error: "the block's last line is no longer " + OKLINE(n) };
  return { outside: lines.slice(0, s + 1).concat(lines.slice(e)).join("\n") };
}
// The lines between the PHASE n START and END lines ([] when they're missing).
function blockLines(text, n) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const s = lines.findIndex(l => l.trim() === START(n)), e = lines.findIndex(l => l.trim() === END(n));
  return s >= 0 && e > s ? lines.slice(s + 1, e) : [];
}

// ---- R4: the stub's comment lines (cardtacticsgame NEXT 10b) --------------------
// The specs' rule R4: keep the comment lines above each function exactly as the
// stub has them, delete the block's "STUBS for now" line, add no other comments.
// Whole comment lines only (// or /* at the start, compared trimmed, so the
// indent doesn't count); a comment after code on the same line isn't seen.
// stubComments: "auto" checks a block whose stub has a "STUBS for now" line,
// true every block, false none.
const STUBS_RE = /^\/\/\s*STUBS for now\b/i;
const commentLines = lines => lines.map(l => l.trim()).filter(l => /^(\/\/|\/\*)/.test(l));
// What the built block's comment lines must be, from the stub's text, or null
// when the check is off for this block.
function stubRule(stubText, n) {
  const c = commentLines(blockLines(stubText, n));
  const on = cfg.stubComments === true || (cfg.stubComments === "auto" && c.some(l => STUBS_RE.test(l)));
  return on ? { want: c.filter(l => !STUBS_RE.test(l)) } : null;
}
// "" when the PHASE n block keeps R4, else what slipped, in a sentence.
function commentSlip(n, rule) {
  if (!rule) return "";
  const got = commentLines(blockLines(readOr(cfg.phaseFile, ""), n));
  if (got.length === rule.want.length && got.every((l, i) => l === rule.want[i])) return "";
  const cut = l => "\"" + (l.length > 90 ? l.slice(0, 87) + "..." : l) + "\"";
  const left = rule.want.slice(), extra = [];
  for (const l of got) { const i = left.indexOf(l); if (i >= 0) left.splice(i, 1); else extra.push(l); }
  const parts = [];
  const stubs = extra.filter(l => STUBS_RE.test(l));
  if (stubs.length) parts.push("kept the stub's \"STUBS for now\" line");
  const other = extra.filter(l => !STUBS_RE.test(l));
  if (left.length) parts.push("lost or changed " + left.length + " of the stub's comment line(s), first " + cut(left[0]));
  if (other.length) parts.push("has " + other.length + " comment line(s) the stub doesn't, first " + cut(other[0]));
  if (!parts.length) parts.push("has the stub's comment lines in another order");
  return "R4: the PHASE " + n + " block " + parts.join("; ");
}

// ---- settings files: a change during a run is said plainly ---------------------
// The files whose change mid-batch the runner can't take in: it read them at
// the start. Git-visible changes stop the batch (the next run-local.sh would
// refuse the dirty tree anyway); others (an untracked plan in prompts/, the
// untracked runner copies in Amontillado, dsh's settings) are a note.
let settingsFiles = [];
function snapshotSettings() {
  const own = path.relative(process.cwd(), __filename) || __filename;
  const files = ["phase-runner.json", planPath, own, "run-local.sh"];
  const home = process.env.USERPROFILE || "";
  const dsh = [
    [process.env.DSH_BUILDER_HOME || (home && path.join(home, ".dsh")), "dsh's builder settings"],
    [process.env.DSH_FIXER_HOME || (home && path.join(home, ".dsh-fixer")), "dsh's fixer settings"]
  ];
  const rel = f => path.relative(process.cwd(), path.resolve(f)).split(path.sep).join("/");
  settingsFiles = files.map(rel).filter((f, i, a) => a.indexOf(f) === i).map(f => ({ file: f, name: f, hash: hashOf(f), local: true }));
  dsh.forEach(([dir, name]) => { if (dir) { const f = path.join(dir, "settings.yaml"); settingsFiles.push({ file: f, name: name + " (" + f + ")", hash: hashOf(f), local: false }); } });
}
// The settings files changed since the snapshot: [{name, seenByGit}]; takes
// the new state as the snapshot, so each change is reported once.
function settingsChanged() {
  const out = [];
  let dirty = [];
  try { dirty = gitQuiet(["status", "--porcelain", "--untracked-files=all"]).split("\n").map(l => l.slice(3).trim()); } catch (e) { /* not fatal */ }
  for (const s of settingsFiles) {
    const h = hashOf(s.file);
    if (h === s.hash) continue;
    out.push({ name: s.name, seenByGit: s.local && dirty.includes(s.file) });
    s.hash = h;
  }
  return out;
}

// ---- ending a run for sure -------------------------------------------------------
// dsh is a node program behind npm's sh shim (on the laptop
// .../npm/node_modules/@deepseek-ai/dsh/lib/bin.js, run by node.exe). On
// Windows, taskkill /T on the bash that runs run-local.sh did not reach that
// node.exe (RUNNER-TEST.md test 3, 2026-10-26): the runner reported "the run
// changed nothing" while the orphan dsh went on, loaded the builder and edited
// game.html. So a stop lists the processes first, ends the run's whole tree
// AND any dsh started since the run began (found by its command line, so a
// broken parent link doesn't hide it), lists again until none is left, and
// only then is the tree judged. If one can't be ended, the batch stops and
// says what to run.
const DSH_MATCH = "/@deepseek-ai/dsh/";
const isDsh = p => p.cmd.replace(/\\/g, "/").toLowerCase().includes(DSH_MATCH);
const SLACK = 2500;                 // ms: start times from ps are whole seconds
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Every process: [{pid, ppid, start (ms since 1970; 0 unknown), cmd}], or null
// when the list can't be had. Windows: Win32_Process through PowerShell (the
// command line is what tasklist can't show: dsh is just "node.exe" there).
const PS_LIST = "$ErrorActionPreference='SilentlyContinue'; $t=[char]9; " +
  "Get-CimInstance Win32_Process | ForEach-Object { $s=0; if ($_.CreationDate) { $s=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; " +
  "$c=''; if ($_.CommandLine) { $c=$_.CommandLine -replace '[\\r\\n\\t]+',' ' }; " +
  "[Console]::Out.WriteLine([string]$_.ProcessId + $t + [string]$_.ParentProcessId + $t + [string]$s + $t + $c) }";
function listProcesses() {
  const list = [];
  if (process.platform === "win32") {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 60000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    for (const l of r.stdout.split(/\r?\n/)) {
      const f = l.split("\t");
      if (f.length < 4 || !/^\d+$/.test(f[0])) continue;
      list.push({ pid: Number(f[0]), ppid: Number(f[1]), start: Number(f[2]) || 0, cmd: f.slice(3).join(" ") });
    }
  } else {
    const r = spawnSync("ps", ["-eo", "pid=,ppid=,etimes=,stat=,args="], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 60000 });
    if (r.status !== 0 || !r.stdout) return null;
    const now = Date.now();
    for (const l of r.stdout.split("\n")) {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s(.*)$/);
      if (!m || m[4].startsWith("Z")) continue;           // a zombie is already gone
      list.push({ pid: Number(m[1]), ppid: Number(m[2]), start: now - Number(m[3]) * 1000, cmd: m[5] });
    }
  }
  return list.length ? list : null;
}
// The run's processes in a list: rootPid's tree (by parent; -1 for none),
// plus every dsh started since t0 that runs headless or lost its parent, and
// their trees. Never the runner itself.
function runProcesses(list, rootPid, t0) {
  const byPid = new Map(list.map(p => [p.pid, p]));
  const found = new Map();
  function walk(p) {
    if (found.has(p.pid) || p.pid === process.pid) return;
    found.set(p.pid, p);
    // a child is younger than its parent (a reused parent id is not a parent)
    list.filter(c => c.ppid === p.pid && c.pid !== p.pid && !(p.start && c.start && c.start < p.start - SLACK)).forEach(walk);
  }
  if (byPid.has(rootPid)) walk(byPid.get(rootPid));
  for (const p of list) {
    if (found.has(p.pid) || !isDsh(p) || (p.start && p.start < t0 - SLACK)) continue;
    const parent = byPid.get(p.ppid);
    const orphan = !parent || p.ppid <= 1 || (parent.start && p.start && parent.start > p.start + SLACK);
    if (orphan || /--profile\s+headless/.test(p.cmd)) walk(p);
  }
  return Array.from(found.values());
}
const stillThere = (list, p) => list.some(q => q.pid === p.pid && !(p.start && q.start && Math.abs(q.start - p.start) > SLACK));
function endPid(pid, hard) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(pid, hard ? "SIGKILL" : "SIGTERM"); } catch (e) { /* gone */ } }
}
// Ends what is left of a run and checks that nothing is. child: run-local.sh's
// bash, started at t0; stopping: the runner is ending it (else the run ended
// by itself, and only a dsh it left behind is looked for).
// Returns {ended: [process], left: [process], unchecked: bool}.
async function endRun(child, t0, stopping) {
  if (stopping && process.platform !== "win32") { try { process.kill(-child.pid, "SIGTERM"); } catch (e) { /* gone */ } }
  let list = listProcesses();
  if (!list) {
    if (stopping) { if (process.platform === "win32") endPid(child.pid, true); else { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { /* gone */ } } }
    return { ended: [], left: [], unchecked: true };
  }
  let targets = runProcesses(list, stopping ? child.pid : -1, t0);
  const ended = new Map();
  for (let round = 1; targets.length && round <= 3; round++) {
    targets.forEach(p => ended.set(p.pid, p));
    // dsh first (it is the one that writes), then the rest of the tree
    targets.slice().sort((a, b) => isDsh(b) - isDsh(a)).forEach(p => endPid(p.pid, round > 1));
    const until = Date.now() + 8000;
    let alive = targets;
    while (Date.now() < until) {
      await sleep(500);
      list = listProcesses();
      if (!list) return { ended: Array.from(ended.values()), left: alive, unchecked: true };
      alive = Array.from(ended.values()).filter(p => stillThere(list, p))
        .concat(runProcesses(list, -1, t0).filter(p => !ended.has(p.pid)));   // a dsh started meanwhile
      if (!alive.length) break;
    }
    targets = alive;
  }
  return { ended: Array.from(ended.values()), left: targets, unchecked: false };
}
// What to tell a person about processes, and what to run.
function procLines(ps) {
  return ps.map(function (p) {
    let c = p.cmd.replace(/\s+/g, " ").trim();
    const i = c.toLowerCase().indexOf("@deepseek-ai");
    // dsh: "node.exe .../@deepseek-ai/dsh/lib/bin.js --profile headless ..."
    if (i > 0) c = (c.match(/^"([^"]+)"|^(\S+)/) || ["", "node"]).slice(1).find(Boolean).split(/[\\/]/).pop() + " .../" + c.slice(i);
    return "      PID " + p.pid + "  " + c.slice(0, 110);
  }).join("\n");
}
function endByHand(ps, role) {
  const win = process.platform === "win32";
  const kill = ps.length ? (win ? ps.map(p => "taskkill //PID " + p.pid + " //T //F").join("; ") : "kill -9 " + ps.map(p => p.pid).join(" "))
    : (win ? "find dsh's node.exe (Task Manager, Details tab: right-click a column header, Select columns, Command line - the node.exe whose command line has @deepseek-ai/dsh) and end it with taskkill //PID <its PID> //T //F"
      : "find dsh (ps -ef | grep deepseek) and kill -9 <its PID>");
  return "In Git Bash: " + kill + "; then node run-phases.js --ps-check (or " + (win ? "tasklist | grep -i node" : "ps -ef | grep dsh") +
    ") until no dsh is left; then ollama stop " + role + ". Only then look at git status / git diff: until dsh is gone, " + cfg.phaseFile + " can still change.";
}
// The run going on now, for Ctrl+C.
let current = null;

// ---- running things -----------------------------------------------------------
// Runs a command with a time limit, echoing its output. watch(), if given,
// is called every cfg.checkSeconds while it runs; when it resolves true the
// run is ended early. gpuWatch(), if given, is called as often; when it
// resolves a text (the model on the CPU), the run is ended at once. It
// resolves only once endRun() has checked that nothing of the run is left (or
// found what is). Returns {code, out, timedOut, early, cpu (that text, or ""),
// ended: {ended, left, unchecked}}.
function run(cmd, args, minutes, watch, gpuWatch) {
  return new Promise(function (resolve) {
    const posix = process.platform !== "win32";
    const t0 = Date.now();
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: posix });
    let out = "", timedOut = false, early = false, done = false, busy = false, stopping = null, cpu = "", gbusy = false;
    function stopNow() {
      if (!stopping) {
        stopping = endRun(child, t0, true);
        // If bash's output never closes (something still holds it), go on
        // anyway once the processes are dealt with.
        stopping.then(() => setTimeout(() => finish({ code: -1, out }), 10000).unref());
      }
      return stopping;
    }
    current = { stop: stopNow, role: args[1] === "fixer" ? "fixer" : "builder" };
    child.stdout.on("data", d => { out += d; process.stdout.write(d); });
    child.stderr.on("data", d => { out += d; process.stderr.write(d); });
    const timer = minutes ? setTimeout(function () {
      if (done || early || cpu) return;
      timedOut = true;
      say("\n!! TIME LIMIT (" + minutes + " min) - stopping the run");
      stopNow();
    }, minutes * 60000) : null;
    const ticker = watch ? setInterval(async function () {
      if (done || busy || timedOut || early || cpu) return;
      busy = true;
      let stop = false;
      try { stop = await watch(); } catch (e) { say("  (early-finish check failed: " + (e.message || e) + ")"); }
      busy = false;
      if (stop && !done && !timedOut && !early && !cpu) { early = true; stopNow(); }
    }, cfg.checkSeconds * 1000) : null;
    const gpuTicker = gpuWatch ? setInterval(async function () {
      if (done || gbusy || timedOut || early || cpu) return;
      gbusy = true;
      let hit = "";
      try { hit = await gpuWatch(); } catch (e) { /* the next tick tries again */ }
      gbusy = false;
      if (hit && !done && !timedOut && !early && !cpu) {
        cpu = hit;
        say("\n!! MODEL ON THE CPU: " + hit + " - ending the run now");
        stopNow();
      }
    }, cfg.checkSeconds * 1000) : null;
    async function finish(r) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      if (gpuTicker) clearInterval(gpuTicker);
      // Also after a run that ended by itself: a dsh it left behind is ended.
      const ended = stopping ? await stopping : await endRun(child, t0, false);
      current = null;
      resolve(Object.assign(r, { timedOut, early, cpu, ended }));
    }
    child.on("close", function (code) { finish({ code: code === null ? -1 : code, out }); });
    child.on("error", function (e) { finish({ code: -1, out: out + String(e) }); });
  });
}

// The self-test: {line, failing, replay, banner, errors, raw}.
// A first run on a cold machine (a browser starting, files just checked out)
// can miss the line, so a run with no SELF-TEST line is tried once more.
async function selftest(folder) {
  let st = await selftestOnce(folder);
  if (!st.line) { say("  (the self-test printed no SELF-TEST line - trying once more)"); st = await selftestOnce(folder); }
  return st;
}
// The self-test's own output, for a person to read when it gives no line.
function rawLines(st) { return "    " + (st.raw.trim().split(/\r?\n/).slice(0, 25).join("\n    ") || "(no output at all)"); }
// Runs without blocking, so a model run's output keeps flowing meanwhile.
function selftestOnce(folder) {
  const c = cmdParts(cfg.selftest, folder ? [folder] : []);
  const cmd = c.cmd === "node" ? process.execPath : c.cmd;
  return new Promise(function (resolve) {
    let raw = "";
    let child;
    try { child = spawn(cmd, c.args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve(parseSelftest(String(e.message || e))); return; }
    child.stdout.on("data", d => { raw += d; });
    child.stderr.on("data", d => { raw += d; });
    child.on("error", e => { raw += "\n" + e.message; });
    child.on("close", () => resolve(parseSelftest(raw)));
  });
}
function parseSelftest(raw) {
  const lines = raw.split(/\r?\n/);
  const line = (lines.find(l => /^SELF-TEST /.test(l)) || "").trim();
  const fp = lines.find(l => /^failing probes: /.test(l));
  const failing = fp ? fp.replace(/^failing probes: /, "").trim() : "";
  const replay = [];
  const ri = lines.findIndex(l => l.trim() === "replay:");
  if (ri >= 0) for (let i = ri + 1; i < lines.length && /^\s{2}\S/.test(lines[i]); i++) replay.push(lines[i].trim());
  const bi = lines.findIndex(l => l.trim() === "RED BANNER:");
  const banner = [];
  if (bi >= 0) for (let i = bi + 1; i < lines.length && /^\s{2}\S/.test(lines[i]); i++) banner.push(lines[i].trim());
  // A probe that threw (cardtacticsgame NEXT 10c): the game logs "probe NAME
  // threw: MESSAGE" with console.error and the self-test prints it as "probe
  // error: NAME threw: MESSAGE" (an older self-test: "console: probe NAME
  // threw: ..."). The probe already counts as failing, so these lines are not
  // page errors; they go into the fixer prompt.
  const threw = [], errors = [];
  for (const l of lines.map(x => x.trim())) {
    const m = l.match(/^probe error: (\S+) threw: (.*)$/) || l.match(/^console: probe (\S+) threw: (.*)$/);
    if (m) threw.push({ probe: m[1], text: m[1] + " threw: " + m[2] });
    else if (/^(page error|console): /.test(l)) errors.push(l);
  }
  return { line, failing, replay, banner, errors, threw, raw };
}
// The plan's line, with no red banner and no page errors.
const isPlanLine = (st, expected) => st.line === expected && !st.banner.length && !st.errors.length;
const extras = st => (st.banner.length ? "  + RED BANNER" : "") + (st.errors.length ? "  + page errors" : "");
// The same inside a sentence.
const withExtras = st => (st.banner.length ? " with a red banner" : "") + (st.errors.length ? (st.banner.length ? " and" : " with") + " page errors" : "");

// Which model Ollama has loaded right now: "name id", or "".
function loadedModel() {
  const r = spawnSync("ollama", ["ps"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return "";
  const row = r.stdout.split(/\r?\n/).slice(1).find(l => l.trim());
  if (!row) return "";
  const cols = row.trim().split(/\s+/);
  return cols[0] + (cols[1] ? " " + cols[1] : "");
}

// ---- Ollama: its version and where the model is (2026-11-03) -------------------------
// On 11/02-03 the laptop's batches stopped three times with driver crashes,
// all on llama-server builds from Ollama 0.40.12-0.40.14, which auto-update
// had installed; and once the updater started a new server before its ROCm
// files were copied, so the builder ran on the CPU and wrote one line in 20
// minutes. The version is read and can be pinned; a model not all on the GPU
// ends the run at once.
// The API's address, as the ollama command reads OLLAMA_HOST (scheme, host,
// port; http://127.0.0.1:11434 by default). A server bound to every address
// (0.0.0.0) is asked at 127.0.0.1.
const OLLAMA_URL = (function () {
  let h = (process.env.OLLAMA_HOST || "").trim().replace(/\/+$/, "");
  if (!h) return "http://127.0.0.1:11434";
  let scheme = "http";
  const sm = h.match(/^(https?):\/\/(.*)$/i);
  if (sm) { scheme = sm[1].toLowerCase(); h = sm[2]; }
  let host = h, port = "11434";
  const pm = h.match(/^(.*):(\d+)$/);
  if (pm) { host = pm[1]; port = pm[2]; }
  if (!host || host === "0.0.0.0" || host === "[::]") host = "127.0.0.1";
  return scheme + "://" + host + ":" + port;
})();
// GET a path of Ollama's API: the parsed JSON, or null (no answer, not 200, not JSON).
function ollamaGet(p, ms) {
  return new Promise(function (resolve) {
    let settled = false;
    const fin = v => { if (!settled) { settled = true; resolve(v); } };
    try {
      const mod = OLLAMA_URL.startsWith("https") ? require("https") : require("http");
      const req = mod.get(OLLAMA_URL + p, { timeout: ms || 5000 }, function (res) {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", d => { body += d; });
        res.on("end", () => { if (res.statusCode !== 200) return fin(null); try { fin(JSON.parse(body)); } catch (e) { fin(null); } });
        res.on("error", () => fin(null));
      });
      req.on("timeout", () => { req.destroy(); fin(null); });
      req.on("error", () => fin(null));
    } catch (e) { fin(null); }
  });
}
// Ollama's version: {version, api} - the server's, from GET /api/version (api
// true), or from `ollama --version`'s "ollama version is 0.40.14"; {down,
// client} when only the command answered ("could not connect ... client
// version is X") or nothing did.
async function readOllamaVersion() {
  const j = await ollamaGet("/api/version", 5000);
  if (j && j.version) return { version: String(j.version).trim().replace(/^v/, ""), api: true };
  const r = spawnSync("ollama", ["--version"], { encoding: "utf8", timeout: 20000, windowsHide: true });
  const text = (r.stdout || "") + "\n" + (r.stderr || "");
  const m = text.match(/ollama version is\s+v?(\S+)/i);
  if (m) return { version: m[1], api: false };
  const c = text.match(/client version is\s+v?(\S+)/i);
  return { down: true, client: c ? c[1] : "" };
}
const pinned = () => String(cfg.ollamaVersion || "").trim().replace(/^v/, "");
// The models Ollama has loaded: [{name, size, vram}] (vram null when the API
// doesn't say), or null when the API doesn't answer.
async function loadedModels() {
  const j = await ollamaGet("/api/ps", 5000);
  if (!j || !Array.isArray(j.models)) return null;
  return j.models.map(m => ({ name: String(m.name || m.model || "?"), size: Number(m.size) || 0,
    vram: m.size_vram === undefined || m.size_vram === null ? null : Number(m.size_vram) || 0 }));
}
// Part of the model on the CPU: ollama ps shows anything but "100% GPU"
// ("100% GPU" is size_vram equal to size).
const onCpu = m => m.size > 0 && m.vram !== null && m.vram < m.size;
const gbOf = b => (b / 1e9).toFixed(1);
function cpuText(m) {
  return m.name + " - " + (m.vram ? gbOf(m.vram) + " of " + gbOf(m.size) + " GB on the GPU, " + Math.round((m.size - m.vram) / m.size * 100) + "% on the CPU"
    : "all " + gbOf(m.size) + " GB on the CPU, none on the GPU");
}
// What Ollama's log says it found when its server last started: its last
// "inference compute" line ({cpu, line, file}), or null when there is no log
// or no such line. A GPU start logs one line per GPU (library=ROCm ...); a
// start that found none logs "id=cpu library=cpu".
function ollamaLogCompute() {
  const file = process.env.RUNNER_OLLAMA_LOG || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Ollama", "server.log") : "");
  if (!file) return null;
  const lines = readOr(file, "").split(/\r?\n/).filter(l => /msg="?inference compute/.test(l));
  if (!lines.length) return null;
  const line = lines[lines.length - 1].trim();
  return { cpu: /\blibrary=cpu\b/i.test(line), line, file };
}
// The fields of a log line worth showing: library=ROCm compute=gfx1151 ...
const computeShort = l => (l.match(/\b(id|library|compute|name|total|available)=("[^"]*"|\S+)/g) || [l.slice(0, 120)]).join(" ");
// What to do when Ollama isn't using the GPU.
function restartSteps() {
  return "Quit Ollama from the tray (right-click its icon: Quit Ollama) and start it again from the Start menu, or restart Windows. Then check: ollama --version" +
    (pinned() ? " says " + pinned() : "") + ", and once a model is loaded, ollama ps shows 100% GPU under PROCESSOR (the dry run also checks Ollama's log for the GPU before any model loads)." +
    " If it keeps happening: \"gpuCheck\": false in phase-runner.json turns these checks off (LOCAL-SUBAGENTS.md hard rule 6).";
}
function versionStop(found, during) {
  return "Ollama is " + found + (during ? " now (" + during + " when the batch started)" : "") + ", but phase-runner.json's ollamaVersion is " + pinned() +
    " - an update came in (Ollama installs one when it starts, if auto-update is on). No model was run" + (during ? " for this phase" : "") + ". To go back: quit Ollama, install " +
    pinned() + " (OllamaSetup.exe from the v" + pinned() + " release on github.com/ollama/ollama/releases) and turn auto-update off (LOCAL-SUBAGENTS.md, Setup); " +
    "or, to run on " + found + ", change ollamaVersion in phase-runner.json and commit that.";
}
// The stop for a run whose model wasn't all on the GPU.
function cpuStop(role, n, what) {
  return (what ? "the " + role + "'s model was not all on the GPU (" + what + "), so the runner ended the run at once"
    : "run-local.sh found a model not all on the GPU (exit 5; its output above has ollama ps)") +
    ". Nothing was judged or committed for phase " + n + " (git status; git checkout -- " + cfg.phaseFile + " if the run left an edit). " + restartSteps() +
    " Then run the plan again with --from " + n + ".";
}
// The driver-crash stop names Ollama's version: the crashes of 10/27-11/03
// came with the llama-server builds of the updates 0.40.12-0.40.14.
async function crashStop(what, version) {
  const now = await readOllamaVersion();
  const changed = now.version && now.version !== version ? " (" + now.version + " now: an update came in)" : "";
  return "DRIVER CRASH (" + what + ") on Ollama " + (version || "?") + changed +
    (pinned() && version === pinned() && !changed ? " - the pinned version, so not an update: tell the author (the pin alone doesn't prevent this crash)"
      : " - an update may have come in: check ollama --version" + (pinned() ? " against the pinned " + pinned() : " (phase-runner.json can pin one: \"ollamaVersion\")")) +
    ". Restart Windows before any further run (LOCAL-SUBAGENTS.md hard rule 6).";
}
// The checks before a batch (also in a dry run): {stop, code} or {version, api, notes, compute}.
async function ollamaSetup() {
  const v = await readOllamaVersion();
  if (v.down) return { code: 2, stop: "Ollama isn't answering (GET " + OLLAMA_URL + "/api/version" + (v.client ? "; ollama --version gave only its client version, " + v.client : "; ollama --version gave nothing") +
    "). Start it from the tray or the Start menu, then check ollama --version. No model was run." };
  if (pinned() && v.version !== pinned()) return { code: 2, stop: versionStop(v.version) };
  const info = { version: v.version, api: v.api, notes: [], compute: "" };
  if (!v.api) info.notes.push("the runner can't reach Ollama's API at " + OLLAMA_URL + " (ollama --version answers), so it can't check during the runs that the model is on the GPU");
  if (!cfg.gpuCheck) return info;
  const ms = v.api ? await loadedModels() : null;
  const cpu = (ms || []).filter(onCpu);
  if (cpu.length) return { code: 5, stop: "Ollama has a model loaded with part of it on the CPU: " + cpu.map(cpuText).join("; ") +
    ". A run would use it there (on 2026-11-03 the builder wrote one line in 20 minutes on the CPU). No model was run. " + restartSteps() };
  const lg = ollamaLogCompute();
  if (lg) info.compute = computeShort(lg.line);
  const gpuLoaded = (ms || []).some(m => m.size > 0 && m.vram !== null && m.vram === m.size);
  if (lg && lg.cpu && !gpuLoaded) return { code: 5, stop: "Ollama found no GPU when its server last started: its log (" + lg.file + ") ends with \"" + computeShort(lg.line) +
    "\". Every model would run on the CPU (2026-11-03: an update started the server before its ROCm files were copied). No model was run. " + restartSteps() };
  return info;
}

// What run-local.sh checks after a run, for a run the runner ended (it was
// killed with run-local.sh, so its own checks never ran): the same searches
// as its grep lines, on the answer and reasoning files the run left.
const CRASH_RE = /ROCm error|llama-server process has terminated/;
const GITTEXT_RE = /\bgit\s+(log|show|diff|checkout|switch|restore|stash|reset|cat-file|blame|reflog|branch|worktree|fetch|pull|clone|grep)\b[^"`\\\n]{0,60}/g;
function gitTextIn(text) { return Array.from(new Set((text.match(GITTEXT_RE) || []).map(s => s.trim()))).slice(0, 3); }
// run-local.sh writes its runs.csv row after the run; for a run the runner
// ended, the runner writes it (exit "early", "limit" or "cpu"). The last
// column (2026-11-03) is Ollama's version; an older file's header gets it.
const CSV_HEADER = "run_id,role,label,exit,minutes,files_changed,diffstat,last_line,free_mb_start,free_mb_end,ollama_version";
function runsCsvRow(id, role, label, exitWord, mins, answer, version) {
  const q = s => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = path.join(".local-runs", "runs.csv");
  try {
    if (!fs.existsSync(csv)) fs.writeFileSync(csv, CSV_HEADER + "\n");
    else {
      const text = fs.readFileSync(csv, "utf8"), nl = text.indexOf("\n");
      const first = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, "");
      if (!/,ollama_version$/.test(first)) fs.writeFileSync(csv, first + ",ollama_version" + (nl < 0 ? "\n" : text.slice(nl).replace(/^\r?\n/, "\n")));
    }
    const files = gitQuiet(["diff", "--name-only"]).split("\n").filter(Boolean).join(" ");
    const stat = gitQuiet(["diff", "--shortstat"]);
    fs.appendFileSync(csv, [q(id), role, q(label), exitWord, mins, q(files), q(stat), q(lastLine(answer).slice(0, 200)), "", "", q(version || "?")].join(",") + "\n");
  } catch (e) { /* the report says what happened anyway */ }
}

// ---- prompts ---------------------------------------------------------------------
// The probes that threw, failing ones first, at most 6, each cut to 240 letters.
function threwText(st) {
  const failing = (st.failing || "").split(/\s+/).filter(Boolean);
  const rank = t => { const i = failing.indexOf(t.probe); return i < 0 ? failing.length : i; };
  const seen = new Set();
  return st.threw.slice().sort((a, b) => rank(a) - rank(b))
    .filter(t => !seen.has(t.text) && seen.add(t.text)).slice(0, 6)
    .map(t => t.text.length > 240 ? t.text.slice(0, 237) + "..." : t.text).join(" | ");
}
function builderPrompt(n) {
  return "Read " + cfg.spec + " and " + cfg.phaseFile + ", and do PHASE " + n + ".\n" +
    "Then stop. Follow the spec's RULES FOR THE MODEL: change only the PHASE " + n + " block of " +
    cfg.phaseFile + ", run no commands, create no files, and end your reply with the line: DONE PHASE " + n + "\n";
}
function fixerPrompt(n, expected, st) {
  return "Read ONLY these parts of " + cfg.spec + " (line numbers are in the LINE MAP at the top): the rules and API, PHASE " + n +
    ", and the FIXER PROMPT section. Then read only the PHASE " + n + " block of " + cfg.phaseFile + " (search for \"PHASE " + n +
    " START\") - the only part you may change - and fix it.\n" +
    "Symptom: after PHASE " + n + " the self-test says \"" + (st.line || "(no self-test line)") + "\" but the spec expects \"" + expected + "\"." +
    (st.failing ? " Failing probes: " + st.failing + "." : "") + "\n" +
    (st.threw && st.threw.length ? "Probes that threw an exception: " + threwText(st) + "\n" : "") +
    "Red banner / console error: " + (st.banner.concat(st.errors).join(" | ") || "none") + "\n" +
    "Self-test line: " + (st.line || "not run") + "\n" +
    "If the symptom describes something a LATER phase adds, reply \"NOT A BUG - PHASE <n>\" and change nothing.\n" +
    "If the expected line itself contradicts the phase's steps, reply \"SPEC MISMATCH: <quote both>\" and change nothing.\n" +
    "First compare the PHASE " + n + " block with the spec's steps line by line - most bugs are a missing or changed step. " +
    "Fix the root cause with the smallest edit, at most 2 edit calls. Run no commands and create no files: this run cannot test, " +
    "the self-test runs after you. Keep the block's last line " + OKLINE(n) + "\n" +
    "Reply with: CAUSE: <one sentence>  FIX: <one sentence>, then end your reply with the line: DONE PHASE " + n + "\n";
}

// ---- is the edit whole? ----------------------------------------------------------------
// HEAD and branch unmoved, no new files, only the phase file changed, and only
// inside its PHASE n block. Returns {} when whole, else {stop}.
function wholeEdit(n, before, beforeOutside) {
  const head = gitQuiet(["rev-parse", "HEAD"]), branch = gitQuiet(["branch", "--show-current"]);
  if (head !== before.head || branch !== before.branch) return { stop: "HEAD or the branch moved during the run (the model ran git?) - was " + before.branch + " " + before.head.slice(0, 7) + ", now " + (branch || "(detached)") + " " + head.slice(0, 7) };
  const newFiles = untracked().filter(f => !before.untracked.includes(f));
  if (newFiles.length) return { stop: "the run created files: " + newFiles.join(", ") };
  const changed = gitQuiet(["diff", "--name-only"]).split("\n").filter(Boolean);
  if (!changed.length) return { stop: "the run changed nothing", nothing: true };
  if (changed.some(f => f !== cfg.phaseFile)) return { stop: "the run changed other files: " + changed.join(", ") };
  const nowOutside = outsideBlock(fs.readFileSync(cfg.phaseFile, "utf8"), n);
  if (nowOutside.error) return { stop: nowOutside.error };
  if (nowOutside.outside !== beforeOutside.outside) return { stop: "the run changed " + cfg.phaseFile + " outside the PHASE " + n + " block (git diff shows where)" };
  return {};
}

// ---- one run of the builder or the fixer -------------------------------------------
// rule: stubRule() of the block's stub (the tree before the builder), or null.
async function attempt(n, role, tryNo, expected, prevSelftest, earlyOk, rule) {
  const label = role === "builder" ? "phase" + n : "phase" + n + "-fix" + tryNo;
  // Ollama must still be the batch's version (an update installs when Ollama
  // starts, so a restart mid-batch can bring one).
  const ov = await readOllamaVersion();
  if (ov.down) return { role, tryNo, label, mins: "", stop: "before phase " + n + "'s " + role + " run Ollama stopped answering (GET " + OLLAMA_URL + "/api/version, ollama --version). No model was run for it. Start Ollama from the tray, check ollama --version" + (pinned() ? " (" + pinned() + ")" : "") + ", then --from " + n + "." };
  if (ov.version !== ollamaInfo.version) return { role, tryNo, label, mins: "", stop: pinned() ? versionStop(ov.version, ollamaInfo.version) :
    "Ollama's version changed during the batch: " + ollamaInfo.version + " when it started, " + ov.version + " now - most likely an update came in when Ollama restarted. No model was run for phase " + n + ". " +
    "Check ollama --version; to keep one version, turn Ollama's auto-update off and pin it in phase-runner.json (\"ollamaVersion\": \"" + ollamaInfo.version + "\"), then --from " + n + "." };
  const promptFile = path.join("prompts", label + ".txt");
  fs.mkdirSync("prompts", { recursive: true });
  fs.writeFileSync(promptFile, role === "builder" ? builderPrompt(n) : fixerPrompt(n, expected, prevSelftest));

  const before = { head: git(["rev-parse", "HEAD"]), branch: git(["branch", "--show-current"]), untracked: untracked() };
  const beforeOutside = outsideBlock(gitShow("HEAD:" + cfg.phaseFile), n);
  if (beforeOutside.error) return { stop: "before the run, " + beforeOutside.error };

  const minutes = role === "builder" ? cfg.builderMinutes : cfg.fixerMinutes;
  const early = cfg.earlyFinish && earlyOk;
  say("\n=== PHASE " + n + ": " + role + (role === "fixer" ? " try " + tryNo : "") + " (limit " + minutes + " min" +
    (early ? "; early finish after " + cfg.quietSeconds + " s quiet with the plan's line" : "") + ")");
  const t0 = Date.now();

  // The early-finish check: each quiet state of the phase file is judged once.
  const w = { start: hashOf(cfg.phaseFile), last: "", since: t0, judged: "", hit: null };
  w.last = w.start;
  const watch = early ? async function () {
    const h = hashOf(cfg.phaseFile);
    if (h !== w.last) { w.last = h; w.since = Date.now(); return false; }
    if (h === w.start || Date.now() - w.since < cfg.quietSeconds * 1000) return false;
    const key = h + "|" + gitQuiet(["status", "--porcelain", "--untracked-files=all"]);
    if (key === w.judged) return false;
    w.judged = key;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    const whole = wholeEdit(n, before, beforeOutside);
    if (whole.stop) { say("\n  [early-finish check at " + mins + " min: not yet - " + whole.stop + "]"); return false; }
    const slip = commentSlip(n, rule);
    if (slip) { say("\n  [early-finish check at " + mins + " min: not yet - " + slip + "]"); return false; }
    const st = await selftestOnce();
    if (hashOf(cfg.phaseFile) !== h) return false;                  // written to meanwhile: judge it again later
    const quiet = Math.round((Date.now() - w.since) / 1000);
    if (!isPlanLine(st, expected)) { say("\n  [early-finish check at " + mins + " min: " + (st.line || "no self-test line") + extras(st) + " - not the plan's line yet]"); return false; }
    say("\n  [early-finish check at " + mins + " min: " + cfg.phaseFile + " the same for " + quiet + " s, only the PHASE " + n + " block changed, " + st.line + " - the plan's line. Ending the run.]");
    w.hit = { st, hash: h, quiet };
    return true;
  } : null;

  // The model on the GPU: once it is loaded, its size_vram must be its size.
  // Two readings in a row (checkSeconds apart) end the run.
  let cpuSeen = 0;
  const gpuWatch = cfg.gpuCheck && ollamaInfo.api ? async function () {
    const ms = await loadedModels();
    if (!ms) return "";                                   // no answer: no reading either way
    const cpu = ms.filter(onCpu);
    if (!cpu.length) { cpuSeen = 0; return ""; }
    return ++cpuSeen >= 2 ? cpu.map(cpuText).join("; ") : "";
  } : null;

  const r = await run("bash", ["run-local.sh", role, label, promptFile.split(path.sep).join("/")], minutes, watch, gpuWatch);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const res = { role, tryNo, mins, label, code: r.code, how: "", ollama: ov.version };
  const idMatch = r.out.match(/^== (\S+)/m);
  res.runId = idMatch ? idMatch[1] : label;
  const ansMatch = r.out.match(/answer: (\S+) \(/);
  res.answerFile = ansMatch ? ansMatch[1] : (idMatch ? path.join(".local-runs", res.runId + ".answer.txt").split(path.sep).join("/") : "");
  const reasoningFile = res.answerFile.replace(/answer\.txt$/, "reasoning.txt");
  const answer = res.answerFile ? readOr(res.answerFile, "") : "";
  // The Local-Model stamp: what Ollama has loaded at the end of the run,
  // read before anything unloads it.
  res.model = loadedModel();
  const endedByRunner = r.timedOut || r.early || !!r.cpu;
  res.endedByRunner = endedByRunner;
  res.endedHow = r.cpu ? "the model on the CPU" : r.early ? "early finish" : "time limit";
  if (endedByRunner && idMatch) runsCsvRow(res.runId, role, label, r.cpu ? "cpu" : r.early ? "early" : "limit", mins, answer, ov.version);

  // Nothing of the run may still be running when the tree is judged.
  const e = r.ended || { ended: [], left: [], unchecked: true };
  const dshEnded = e.ended.filter(isDsh);
  if (e.left.length) return Object.assign(res, { leftRunning: true, stop: "the " + role + " run was ended, but " + (e.left.length > 1 ? "these are" : "this is") +
    " still running and can still change " + cfg.phaseFile + ":\n" + procLines(e.left) + "\n    Nothing was judged or committed for phase " + n + ". " + endByHand(e.left, role) });
  if (e.unchecked && endedByRunner) return Object.assign(res, { leftRunning: true, stop: "the " + role + " run was ended, but the runner couldn't list the running processes to make sure dsh ended" +
    (process.platform === "win32" ? " (PowerShell's Get-CimInstance Win32_Process gave nothing)" : " (ps gave nothing)") + ". Nothing was judged or committed for phase " + n + ". " + endByHand([], role) });
  if (endedByRunner) say("\n  [run ended: " + e.ended.length + " process(es)" + (dshEnded.length ? ", dsh PID " + dshEnded.map(p => p.pid).join(", ") : ", no dsh among them") + "; none left running]");
  else if (dshEnded.length) {
    res.note = "dsh was still running after run-local.sh had ended (PID " + dshEnded.map(p => p.pid).join(", ") + "); the runner ended it before judging the run.";
    say("\n!! " + res.note);
  } else if (e.unchecked) say("\n  (couldn't list the running processes to check that no dsh outlived the run)");
  // A model on the CPU holds system memory until it is unloaded.
  if (r.timedOut || r.cpu || r.code === 5) spawnSync("ollama", ["stop", role], { stdio: "ignore" });

  // Settings files changed during the run, said plainly.
  const sc = settingsChanged();
  const seen = sc.filter(c => c.seenByGit), unseen = sc.filter(c => !c.seenByGit);
  if (unseen.length) {
    const note = unseen.map(c => c.name).join(", ") + " changed during the " + role + " run (git doesn't track it, so the run goes on). This batch keeps the settings and plan it read at the start; the change counts from the next batch.";
    res.note = (res.note ? res.note + " " : "") + note;
    say("\n!! " + note);
  }
  if (seen.length) {
    const names = seen.map(c => c.name);
    return Object.assign(res, { stop: names.join(" and ") + (names.length > 1 ? " were" : " was") + " changed during phase " + n + "'s " + role + " run" +
      " - most likely by a person or an editor (the prompt forbids the model to touch it). This batch read its settings at the start and still used them" +
      " (builder " + cfg.builderMinutes + " min, fixer " + cfg.fixerMinutes + " min, " + cfg.fixerTries + " fixer tries), and nothing was committed for phase " + n + "." +
      " To go on: commit the settings change on its own (git add " + names.join(" ") + "; git commit), then git checkout -- " + cfg.phaseFile +
      " and run the plan again with --from " + n + "." });
  }

  if (!endedByRunner) {
    if (r.code === 4) return Object.assign(res, { stop: await crashStop("run-local.sh exit 4", ov.version), crash: true });
    if (r.code === 5) return Object.assign(res, { stop: cpuStop(role, n, ""), cpu: true });
    if (r.code !== 0) return Object.assign(res, { stop: "run-local.sh exited " + r.code + " (see its output above)" });
  } else {
    const crash = (answer + "\n" + readOr(reasoningFile, "")).match(CRASH_RE);
    if (crash) return Object.assign(res, { stop: await crashStop(crash[0] + " in the run's files", ov.version), crash: true });
    if (r.cpu) return Object.assign(res, { stop: cpuStop(role, n, r.cpu), cpu: true });
  }

  // Where things are now.
  const whole = wholeEdit(n, before, beforeOutside);
  // Only the fixer is asked for a verdict; a builder quoting the spec's FIXER
  // PROMPT section is not one (the code review, 2026-10-30).
  const verdict = role === "fixer" && answer.split(/\r?\n/).map(l => l.trim()).find(l => /^(NOT A BUG|SPEC MISMATCH)/.test(l));
  if (verdict) {
    const changed = gitQuiet(["diff", "--name-only"]).split("\n").filter(Boolean);
    return Object.assign(res, { verdict: true, stop: "the fixer answered: " + verdict + (changed.length ? " (and changed " + changed.join(", ") + ")" : "") + (whole.stop && !whole.nothing ? " - and " + whole.stop : "") });
  }
  if (whole.stop) {
    if (r.timedOut) return Object.assign(res, { stop: "the " + role + " ran past its " + minutes + "-minute limit and was stopped, and " + whole.stop + " (a failed run: look at the files it left, then git checkout -- " + cfg.phaseFile + ")" });
    return Object.assign(res, { stop: whole.stop });
  }
  const gitText = endedByRunner ? gitTextIn(answer + "\n" + readOr(reasoningFile, "")) : (/^!! git command text/m.test(r.out) ? ["(run-local.sh's flag)"] : []);
  if (gitText.length) return Object.assign(res, { stop: (endedByRunner ? "the run's files hold git command text (" + gitText.join("; ") + ")" : "run-local.sh flagged git command text") +
    " - read " + (reasoningFile || "the reasoning file") + " to see whether the model ran it (LOCAL-SUBAGENTS.md step 3)" });

  const last = lastLine(answer);
  res.doneLine = last === "DONE PHASE " + n;

  // The self-test - also for a run the runner ended, and for an answer with
  // no DONE line. An early finish already tested this very file.
  let st;
  if (r.early && w.hit && hashOf(cfg.phaseFile) === w.hit.hash) st = w.hit.st;
  else st = await selftest();
  res.selftest = st;
  if (!st.line) return Object.assign(res, { stop: "the self-test printed no SELF-TEST line, so the run can't be judged (not sent to the fixer). Its output:\n" + rawLines(st) });
  res.match = isPlanLine(st, expected);
  say("self-test: " + st.line + extras(st) + (res.match ? "  - as expected" : "  - expected: " + expected));
  if (st.threw.length) say("  probes that threw: " + threwText(st));

  // R4 (cardtacticsgame NEXT 10b): a comment slip stops the phase like any
  // other slip, whatever the self-test says; nothing is committed.
  const slip = commentSlip(n, rule);
  if (slip) return Object.assign(res, { stop: slip + ". The self-test says \"" + st.line + "\"" + withExtras(st) + (res.match ? " - the plan's line" : ", not the plan's \"" + expected + "\"") +
    ". Nothing was committed for this " + role + " run (git diff shows the edit). To run it again: git checkout -- " + cfg.phaseFile + ", then --from " + n +
    (role === "fixer" ? " (it goes on with fixer try " + tryNo + ")" : "") + ". Keeping the edit with its comments put right is a hand edit to a model's block: the author's call." });

  if (r.early) {
    if (!res.match) return Object.assign(res, { stop: "the early finish ended the run, but " + cfg.phaseFile + " changed before it stopped and the self-test now says \"" + st.line + "\", not the plan's line (look at the edit; git checkout -- " + cfg.phaseFile + " to throw it away)" });
    res.how = "early";
    res.quiet = w.hit ? w.hit.quiet : cfg.quietSeconds;
  } else if (r.timedOut) {
    if (!res.match) return Object.assign(res, { stop: "the " + role + " ran past its " + minutes + "-minute limit and was stopped; its edit stayed inside the PHASE " + n + " block, but the self-test says \"" + st.line + "\"" + withExtras(st) + ", not the plan's \"" + expected + "\" (not committed; look at the edit, then git checkout -- " + cfg.phaseFile + ")" });
    res.how = "limit";
  } else if (!res.doneLine) {
    if (!res.match) return Object.assign(res, { stop: "the answer's last line is \"" + last.slice(0, 80) + "\", not DONE PHASE " + n + ", and the self-test says \"" + st.line + "\"" + withExtras(st) + ", not the plan's \"" + expected + "\" (not committed)" });
    res.how = "nodone";
  }
  res.lastLine = last;
  return res;
}

// Commits the phase file with the run's trailers; returns the short hash.
// Local-Model: what Ollama had loaded at the end of the run (name and id), so
// the credit doesn't rest on today's LOCAL list in dev/disclosure.js alone.
function commit(subject, body, res) {
  const lines = [subject, "", body, ""];
  if (res.model) lines.push("Local-Model: " + res.model);
  lines.push("Committed-By: run-phases.js");
  if (coAuthor) lines.push("Co-Authored-By: " + coAuthor + " <noreply@anthropic.com>");
  const msg = path.join(os.tmpdir(), "run-phases-msg-" + process.pid + ".txt");
  fs.writeFileSync(msg, lines.join("\n") + "\n");
  git(["add", "--", cfg.phaseFile]);
  git(["commit", "-q", "-F", msg]);
  fs.unlinkSync(msg);
  return git(["rev-parse", "--short", "HEAD"]);
}
// What the commit body says about how the run ended, when not by itself.
function howNote(r, n) {
  if (r.how === "early") return " Ended early by run-phases.js: " + cfg.phaseFile + " had stayed the same for " + r.quiet + " s, only the PHASE " + n + " block had changed, and the self-test already gave the plan's line.";
  if (r.how === "limit") return " Stopped by run-phases.js at the " + (r.role === "builder" ? cfg.builderMinutes : cfg.fixerMinutes) + "-minute limit with its edit whole: only the PHASE " + n + " block had changed and the self-test gave the plan's line.";
  if (r.how === "nodone") return " The answer did not end with DONE PHASE " + n + " (its last line: \"" + (r.lastLine || "").slice(0, 80) + "\"); the self-test gave the plan's line.";
  return "";
}

// ---- before a phase: the tree must give the previous phase's line ---------------
async function precheck(n, want, wantFrom) {
  const st = await selftest();
  if (!st.line) return { stop: "before phase " + n + " the self-test printed no SELF-TEST line. Its output:\n" + rawLines(st) };
  say("before phase " + n + ": " + st.line + extras(st) + (want ? (st.line === want ? "  - " + wantFrom + ", as the plan says" : "  - expected " + wantFrom + ": " + want) : ""));
  const subject = git(["log", "-1", "--format=%s"]);
  if (want && st.line !== want) return { stop: "before phase " + n + " the tree gives \"" + st.line + "\", not " + wantFrom + " \"" + want + "\" (HEAD: " + git(["log", "-1", "--format=%h"]) + " " + subject.slice(0, 70) + "). No model was run. The fault is in an earlier block or a commit's line, not phase " + n + "'s; or the branch isn't where this plan starts. Check the tree at that commit (a cloud session can help)." };
  // A commit whose subject names a SELF-TEST line must be the tree that prints it.
  const m = subject.match(/^phase \d+:.*?(SELF-TEST .*?)(?: \(spec: .*\))?$/);
  if (m && m[1].trim() !== st.line) return { stop: "HEAD's subject says \"" + m[1].trim() + "\" but the tree gives \"" + st.line + "\" (" + subject.slice(0, 60) + "...). No model was run. A hand commit's line must come from the self-test's own output: L=$(" + cfg.selftest + " | grep -m1 '^SELF-TEST'), then git commit --amend with \"$L\" in the subject - or, if the line is right, the block isn't: check it before going on." };
  return { line: st.line };
}

// ---- one phase: the builder, then up to fixerTries fixer runs ------------------------
// resume (from resumeFrom(), with --from N on a failed attempt at this phase):
// {base, tryNo, st} - skip the builder and go on with fixer try tryNo.
async function phase(n, expected, log, earlyOk, resume) {
  const tail = (r) => "Run " + (r.runId || r.label) + " by run-phases.js: " + r.mins + " min" + (r.selftest && r.selftest.failing ? "; failing probes: " + r.selftest.failing : "") + ".\nOnly the PHASE " + n + " block of " + cfg.phaseFile + " changed.";
  // The tree before the builder: its block is the stub R4 compares with.
  const base = resume ? resume.base : git(["rev-parse", "HEAD"]);
  const rule = stubRule(gitShow(base + ":" + cfg.phaseFile), n);
  let prev, k0;
  if (resume) {
    say("\n=== PHASE " + n + ": HEAD is this phase's failed attempt (" + resume.st.line + "), so the batch goes on with fixer try " + resume.tryNo + " - no new builder run over it");
    prev = resume.st;
    k0 = resume.tryNo;
  } else {
    const b = await attempt(n, "builder", 1, expected, null, earlyOk, rule);
    log.push(b);
    if (b.stop) return { stop: b.stop, crash: b.crash, cpu: b.cpu };
    if (b.match) {
      b.commit = commit("phase " + n + ": builder, first try, " + b.selftest.line, tail(b) + " The spec's expected line." + howNote(b, n), b);
      return { ok: true };
    }
    b.commit = commit("phase " + n + ": builder, first try, " + (b.selftest.line || "no self-test line") + " (spec: " + expected + ")",
      tail(b) + " Not the spec's line yet: committed as the builder left it, for the fixer.", b);
    if (!cfg.fixerTries) return { stop: "phase " + n + " got \"" + b.selftest.line + "\", not \"" + expected + "\" (--no-fixer). " + waysOn(n, base) };
    prev = b.selftest;
    k0 = 1;
  }
  for (let k = k0; k <= cfg.fixerTries; k++) {
    const f = await attempt(n, "fixer", k, expected, prev, earlyOk, rule);
    log.push(f);
    if (f.stop) return { stop: f.stop + (f.verdict ? " " + waysOn(n, base) : ""), crash: f.crash, cpu: f.cpu };
    f.commit = commit("phase " + n + ": fixer try " + k + ", " + (f.selftest.line || "no self-test line") + (f.match ? "" : " (spec: " + expected + ")"),
      tail(f) + (f.match ? " The spec's expected line." + howNote(f, n) : " Still not the spec's line."), f);
    if (f.match) return { ok: true };
    prev = f.selftest;
  }
  return { stop: "phase " + n + " still got \"" + prev.line + "\" after " + cfg.fixerTries + " fixer tries. " + waysOn(n, base) };
}

// ---- a phase's failed attempts (cardtacticsgame NEXT 10a) ---------------------------
// The runner commits a failed attempt as "phase N: builder, first try, LINE
// (spec: EXPECTED)" or "phase N: fixer try K, LINE (spec: EXPECTED)". After a
// stop, --from N must never run the builder over that block again and call it
// "first try" (cardtacticsgame b0d93ea -> cb94d67, 6514a7d -> 7da7cb5).
const ATTEMPT_RE = /^phase (\d+): (builder, first try|fixer try (\d+)), (.*?) \(spec: (.*)\)$/;
// Any other "phase N: ..., SELF-TEST ..." subject (a success, a hand fix).
const DONE_RE = /^phase (\d+):.*?(SELF-TEST .*)$/;
// The failed attempts at phase n on top of HEAD, newest first:
// [{hash, subject, fixer (try number, 0 for the builder), line}]; [] if HEAD isn't one.
function failedAttempts(n) {
  const chain = [];
  let rev = "HEAD";
  for (let i = 0; i < 50; i++) {
    let s;
    try { s = git(["log", "-1", "--format=%H%x09%s", rev, "--"]); } catch (e) { break; }
    const tab = s.indexOf("\t"), hash = s.slice(0, tab), subject = s.slice(tab + 1);
    const m = subject.match(ATTEMPT_RE);
    if (!m || Number(m[1]) !== n) break;
    chain.push({ hash, subject, fixer: m[3] ? Number(m[3]) : 0, line: m[4] });
    if (!m[3]) break;                       // the builder's attempt starts the chain
    rev = hash + "^";
  }
  return chain;
}
// How to go on when a phase's attempts are used up or the fixer gave a verdict.
// base: the commit before the builder's attempt (the block's stub).
function waysOn(n, base) {
  const b = git(["rev-parse", "--short", base]), hand = cfg.selftest + " | grep -m1 '^SELF-TEST'";
  return "Ways on (the person's call): (1) put the PHASE " + n + " block back to its stub and build it again - git revert --no-edit " + b + "..HEAD" +
    " (one revert commit per attempt, newest first; the attempts stay in the history), then node run-phases.js " + planPath + " --from " + n +
    " (a fresh builder run); or (2) fix the block by hand or in a cloud session, then L=$(" + hand + ") and git commit -am \"phase " + n + ": fixed by hand, $L\"," +
    " then --from the next phase. With a fixer verdict, the spec or the skeleton changes first (a cloud session), then (1).";
}
// Before the first phase that runs: is HEAD a failed attempt, or a phase
// already done? Returns {} (nothing special), {stop}, or {resume: {base,
// tryNo, st}, note}. want/wantFrom: the line the tree before phase n must give.
async function resumeFrom(n, want, wantFrom) {
  const subject = git(["log", "-1", "--format=%s"]);
  const head7 = git(["rev-parse", "--short", "HEAD"]);
  const am = subject.match(ATTEMPT_RE);
  if (am && Number(am[1]) !== n) {
    const m = Number(am[1]);
    return { stop: "HEAD (" + head7 + ") is phase " + m + "'s failed attempt (\"" + subject.slice(0, 90) + "\"), not a tree phase " + n + " can start from. No model was run." +
      (planAll.some(p => p.n === m) ? " To go on with phase " + m + ": --from " + m + " (its fixer goes on where it stopped)." : "") };
  }
  const sm = !am && subject.match(DONE_RE);
  if (sm) {
    const m = Number(sm[1]), all = planAll, i = all.findIndex(p => p.n === m), j = all.findIndex(p => p.n === n);
    if (i >= 0 && j >= 0 && i >= j && all[i].expected === sm[2].trim()) {
      const next = all[i + 1];
      return { stop: "HEAD (" + head7 + ") is phase " + m + "'s commit with its plan line, so phase " + n + " is already built. No model was run. " +
        (next ? "To go on: --from " + next.n + "." : "That is the plan's last phase: the plan is done.") };
    }
  }
  if (!am) return {};
  // HEAD is a failed attempt at phase n itself.
  const chain = failedAttempts(n);
  const builder = chain[chain.length - 1];
  const tries = chain.filter(a => a.fixer).map(a => a.fixer).reverse();     // oldest first
  if (!builder || builder.fixer || tries.some((t, i) => t !== i + 1))
    return { stop: "HEAD (" + head7 + ") is a failed attempt at phase " + n + ", but the runner can't find the builder's attempt and fixer tries 1, 2, ... under it (" +
      chain.map(a => a.hash.slice(0, 7) + " " + a.subject.slice(0, 50)).join("; ") + "). No model was run. Look at git log; a cloud session can help." };
  let base;
  try { base = git(["rev-parse", builder.hash + "^"]); }
  catch (e) { return { stop: "the commit before phase " + n + "'s builder attempt (" + builder.hash.slice(0, 7) + ") isn't in this clone (a shallow clone?). No model was run." }; }
  // Only the PHASE n block changed since the stub.
  const files = git(["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean);
  const before = outsideBlock(gitShow(base + ":" + cfg.phaseFile), n), now = outsideBlock(gitShow("HEAD:" + cfg.phaseFile), n);
  if (files.some(f => f !== cfg.phaseFile) || before.error || now.error || before.outside !== now.outside)
    return { stop: "HEAD is phase " + n + "'s failed attempt, but more than its PHASE " + n + " block changed since " + git(["rev-parse", "--short", base]) + " (" + (files.join(", ") || "nothing") + "). No model was run. Look at git diff " + git(["rev-parse", "--short", base]) + " HEAD." };
  // The tree now must be the one the attempt's subject names.
  const st = await selftest();
  if (!st.line) return { stop: "before phase " + n + " the self-test printed no SELF-TEST line. Its output:\n" + rawLines(st) };
  say("before phase " + n + ": " + st.line + extras(st) + "  - HEAD " + head7 + ", phase " + n + "'s failed attempt" + (tries.length ? " (after fixer try " + tries[tries.length - 1] + ")" : " (the builder's)"));
  if (st.line !== chain[0].line) return { stop: "HEAD's subject says \"" + chain[0].line + "\" but the tree gives \"" + st.line + "\". No model was run. Look at the block and the commit." };
  // The stub the attempts started from must give the line before phase n.
  if (want) {
    const wt = "../" + path.basename(process.cwd()) + "-stub-" + stamp();
    let bst = null, failed = "";
    try { git(["worktree", "add", "--detach", "--quiet", wt, base]); bst = await selftest(wt); }
    catch (e) { failed = String(e.message || e).trim(); }
    finally { spawnSync("git", ["worktree", "remove", "--force", wt], { stdio: "ignore" }); }
    if (failed) return { stop: "couldn't check out " + git(["rev-parse", "--short", base]) + " (the tree before phase " + n + "'s builder) to test it: " + failed };
    say("  the tree before its builder (" + git(["rev-parse", "--short", base]) + "): " + (bst.line || "no self-test line") + (bst.line === want ? "  - " + wantFrom + ", as the plan says" : "  - expected " + wantFrom + ": " + want));
    if (bst.line !== want) return { stop: "before phase " + n + "'s builder the tree (" + git(["rev-parse", "--short", base]) + ") gives \"" + (bst.line || "no self-test line") + "\", not " + wantFrom + " \"" + want + "\". No model was run. The fault is in an earlier block or a commit's line." };
  }
  if (tries.length >= cfg.fixerTries)
    return { stop: "phase " + n + "'s fixer tries are used up (" + tries.length + " of " + cfg.fixerTries + (noFixer ? ", --no-fixer" : "") + "); HEAD still gives \"" + st.line + "\". No model was run. " + waysOn(n, base) };
  return { resume: { base, tryNo: tries.length + 1, st }, line: st.line };
}

// ---- Ctrl+C: end the model's run too, not only the runner -------------------------
["SIGINT", "SIGTERM", "SIGHUP"].forEach(function (sig) {
  process.on(sig, async function () {
    if (!current) process.exit(130);
    if (current.interrupted) return;
    current.interrupted = true;
    say("\n!! " + sig + " - ending the model's run before exiting");
    const e = await current.stop();
    if (e.left.length) say("!! still running:\n" + procLines(e.left) + "\n" + endByHand(e.left, current.role));
    else if (e.unchecked) say("!! couldn't list the running processes to check. " + endByHand([], current.role));
    else say("  ended " + e.ended.length + " process(es); none left running. Nothing was committed for this run: git status / git diff to look.");
    process.exit(1);
  });
});

// ---- the display stays on while a batch runs (2026-11-03) -------------------------
// On AC power the laptop's display turns off after 5 minutes, which starts
// Modern Standby (Kernel-Power 506); runs went on through it, but 3 of the 5
// crash clusters of 11/02-03 came minutes after a wake. A hidden PowerShell
// child calls SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
// ES_DISPLAY_REQUIRED) every 15 s while the runner's process lives, and stops
// (Windows then forgets the request) once it is gone; the runner also ends it
// on exit, Ctrl+C included. The script goes as -EncodedCommand, so no quoting
// can break it. Windows' own power settings are not touched.
let awake = null;
function keepDisplayOn() {
  if (!cfg.keepDisplayOn) return "the display: as Windows' power settings say (keepDisplayOn: false)";
  // The stand-in kit's display child (a node script), on any platform; never PowerShell there.
  const fake = process.env.RUNNER_FORCE_KEEP_AWAKE || "";
  if (process.platform !== "win32" && !fake) return "";
  const script = "$ErrorActionPreference = 'Stop'\n" +
    "$k = Add-Type -Name RunPhasesAwake -Namespace RunPhases -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'\n" +
    "while (Get-Process -Id " + process.pid + " -ErrorAction SilentlyContinue) {\n" +
    "  [void]$k::SetThreadExecutionState([uint32]2147483651)   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED\n" +
    "  Start-Sleep -Seconds 15\n" +
    "}\n";
  try {
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    awake = fake ? spawn(process.execPath, [fake].concat(args), { stdio: "ignore", windowsHide: true })
      : spawn("powershell.exe", args, { stdio: "ignore", windowsHide: true });
  } catch (e) { awake = null; return "the display: couldn't start its PowerShell child (" + (e.message || e) + "); Windows' power settings decide"; }
  const child = awake;
  child.on("error", function (e) { if (awake === child) { awake = null; say("  (the display child couldn't start: " + (e.message || e) + "; Windows' power settings decide)"); } });
  child.on("exit", function () { if (awake === child) awake = null; });
  return "the display: kept on while the batch runs (a PowerShell child, PID " + child.pid + "; keepDisplayOn: false turns it off)";
}
function letDisplaySleep() { if (awake) { try { awake.kill(); } catch (e) { /* gone */ } awake = null; } }
process.on("exit", letDisplaySleep);

// node run-phases.js --ps-check: can the runner see dsh? Lists the processes
// it would end (any dsh running now) and how many processes it sees in all.
function psCheck() {
  const t = Date.now();
  const list = listProcesses();
  if (!list) die("couldn't list the running processes (" + (process.platform === "win32" ? "PowerShell's Get-CimInstance Win32_Process" : "ps") + " gave nothing): the runner can't make sure a stopped run has ended", 2);
  const dsh = list.filter(isDsh);
  say("run-phases --ps-check: " + list.length + " processes listed in " + ((Date.now() - t) / 1000).toFixed(1) + " s; " +
    (list.some(p => p.pid === process.pid && /run-phases/.test(p.cmd)) ? "this one found by its command line" : "this one NOT found by its command line - tell a Claude session"));
  say(dsh.length ? "dsh running now (" + dsh.length + "):\n" + procLines(dsh) + "\n" + endByHand(dsh, "builder") : "dsh running now: none");
  process.exit(dsh.length ? 1 : 0);
}

// ---- the batch ---------------------------------------------------------------------
let planAll = [];          // the whole plan, also with --from
let ollamaInfo = { version: "", api: false };   // Ollama at the batch's start
(async function main() {
  if (flag("--ps-check")) psCheck();
  // Setup checks.
  if (process.platform === "win32" && !process.env.MSYSTEM) die("run this from Git Bash (on Windows, another bash may be WSL's)");
  if (!fs.existsSync("run-local.sh")) die("run-local.sh is not in this folder - run from the project folder");
  if (!fs.existsSync(cfg.phaseFile) || !fs.existsSync(cfg.spec)) die("missing " + cfg.phaseFile + " or " + cfg.spec + " (phase-runner.json?)");
  let top;
  try { top = git(["rev-parse", "--show-toplevel"]); } catch (e) { die("not a git folder"); }
  if (path.resolve(top) !== path.resolve(process.cwd()) && fs.realpathSync(top) !== fs.realpathSync(process.cwd())) die("run from the top of the repository (" + top + ")");
  const branch = git(["branch", "--show-current"]);
  if (!branch) die("HEAD is detached - make a throwaway branch first");
  if (cfg.protectedBranches.includes(branch)) die("refusing to run on '" + branch + "' - make a throwaway branch (LOCAL-SUBAGENTS.md)");
  if (git(["status", "--porcelain", "--untracked-files=no"])) die("uncommitted changes - commit or stash first");
  if (![true, false, "auto"].includes(cfg.stubComments)) die("phase-runner.json: stubComments must be true, false or \"auto\"");
  if (!(cfg.quietSeconds > 0) || !(cfg.checkSeconds > 0)) die("phase-runner.json: quietSeconds and checkSeconds must be numbers above 0");
  if (typeof cfg.ollamaVersion !== "string") die("phase-runner.json: ollamaVersion takes a version in quotes, e.g. \"0.40.11\" (or leave it out)");
  if (typeof cfg.gpuCheck !== "boolean" || typeof cfg.keepDisplayOn !== "boolean") die("phase-runner.json: gpuCheck and keepDisplayOn must be true or false");
  // A headless dsh from an earlier run (one stopped by an older runner, or by
  // hand) could still write into this tree.
  const procs = listProcesses();
  if (!procs) say("run-phases: (couldn't list the running processes to check for a dsh left by an earlier run; node run-phases.js --ps-check tells why)");
  else {
    const old = procs.filter(p => isDsh(p) && /--profile\s+headless/.test(p.cmd));
    if (old.length) die("a headless dsh is already running - most likely left by an earlier, stopped run, and it can still change files:\n" + procLines(old) + "\n" + endByHand(old, "builder") + " Then start again.");
  }

  // The plan.
  if (!fs.existsSync(planPath)) die("no plan file: " + planPath);
  let plan = [];
  let replayRef = "", startLine = "";
  fs.readFileSync(planPath, "utf8").split(/\r?\n/).forEach(function (raw, i) {
    const l = raw.replace(/#.*$/, "").trim();
    if (!l) return;
    let m = l.match(/^replay-same-as\s+(\S+)$/);
    if (m) { replayRef = m[1]; return; }
    m = l.match(/^start\s+(SELF-TEST .+)$/);
    if (m) { startLine = m[1].trim(); return; }
    m = l.match(/^(\d+)\s+(SELF-TEST .+)$/);
    if (!m) die(planPath + " line " + (i + 1) + ": expected '<phase> SELF-TEST ...', 'start SELF-TEST ...' or 'replay-same-as <ref>'");
    plan.push({ n: Number(m[1]), expected: m[2].trim() });
  });
  if (!plan.length) die("the plan has no phases");
  planAll = plan.slice();
  if (new Set(plan.map(p => p.n)).size !== plan.length) die("a phase appears twice in the plan");
  // The line the tree must give before the first phase that runs.
  let firstWant = startLine, firstFrom = "the plan's start line";
  if (fromPhase) {
    const i = plan.findIndex(p => p.n === Number(fromPhase));
    if (i < 0) die("--from " + fromPhase + ": no phase " + fromPhase + " in " + planPath);
    if (i > 0) { firstWant = plan[i - 1].expected; firstFrom = "phase " + plan[i - 1].n + "'s line"; }
    plan = plan.slice(i);
  }
  const text = fs.readFileSync(cfg.phaseFile, "utf8");
  for (const p of plan) { const o = outsideBlock(text, p.n); if (o.error) die("phase " + p.n + ": " + o.error); }
  if (replayRef && !gitOk(["rev-parse", "--verify", "--quiet", replayRef + "^{commit}"])) die("replay-same-as: no such branch or commit: " + replayRef);
  snapshotSettings();

  // Ollama: answering, its version (the pinned one, if set), no model on the
  // CPU and a GPU found at its last start - also in a dry run.
  const oc = await ollamaSetup();
  if (oc.stop) die(oc.stop, oc.code);
  ollamaInfo = oc;

  say("run-phases: branch " + branch + ", " + plan.length + " phase(s)" + (fromPhase ? " from phase " + fromPhase : "") + ", builder limit " + cfg.builderMinutes + " min, fixer limit " + cfg.fixerMinutes + " min, " + cfg.fixerTries + " fixer tries");
  say("  early finish: " + (cfg.earlyFinish ? "on (checks every " + cfg.checkSeconds + " s; ends a run once " + cfg.phaseFile + " has been the same for " + cfg.quietSeconds + " s with the plan's line)" : "off"));
  if (firstWant) say("  before phase " + plan[0].n + ": " + firstWant + " (" + firstFrom + ")");
  plan.forEach(p => say("  phase " + p.n + " -> " + p.expected));
  if (replayRef) say("  replay lines at the end: the same as on " + replayRef);
  if (coAuthor) say("  commits carry Co-Authored-By: " + coAuthor);
  say("  Ollama " + ollamaInfo.version + (pinned() ? " (phase-runner.json's ollamaVersion)" : " (no version pinned: phase-runner.json's ollamaVersion)") +
    (ollamaInfo.compute ? "; its log: " + ollamaInfo.compute : ""));
  say("  the model on the GPU: " + (!cfg.gpuCheck ? "not checked (gpuCheck: false)" : ollamaInfo.api ? "checked every " + cfg.checkSeconds + " s during each run (" + OLLAMA_URL + "/api/ps)" : "NOT checked during the runs"));
  ollamaInfo.notes.forEach(t => say("  !! " + t));

  // The replay lines to compare with, from a temporary checkout of replayRef.
  let wantReplay = null;
  if (replayRef) {
    // A sibling folder named by a relative path: no temp-folder path for git
    // and Node to read differently on Windows. Removed again before going on.
    const wt = "../" + path.basename(process.cwd()) + "-replay-" + stamp();
    let st = null, failed = "";
    try {
      git(["worktree", "add", "--detach", "--quiet", wt, replayRef]);
      st = await selftest(wt);
    } catch (e) {
      failed = String(e.message || e).trim();
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", wt], { stdio: "ignore" });
    }
    if (failed) die("could not check out " + replayRef + " for the replay lines: " + failed);
    wantReplay = st.replay;
    say("  " + replayRef + ": " + (st.line || "(no self-test line)") + ", " + wantReplay.length + " replay line(s)");
    if (!wantReplay.length) die("no replay lines on " + replayRef + ". The self-test's output there:\n" + rawLines(st));
  }

  // The tree before the first phase (also in a dry run: a wrong hand-commit
  // line shows here, before any model runs).
  // HEAD may be this phase's failed attempt (go on with its fixer) or a phase
  // already done (NEXT 10a); otherwise the usual check.
  const rf = await resumeFrom(plan[0].n, firstWant, firstFrom);
  const pre = rf.stop ? { stop: rf.stop } : rf.resume ? { line: rf.line, resume: rf.resume } : await precheck(plan[0].n, firstWant, firstFrom);
  if (pre.stop && dryRun) die(pre.stop, 1);
  if (dryRun) {
    say("dry run: everything checks out; no model was run." + (pre.resume ? " Phase " + plan[0].n + " goes on with fixer try " + pre.resume.tryNo + " (HEAD is its failed attempt), not the builder." : ""));
    process.exit(0);
  }

  // The runs, with the display kept on.
  const awakeLine = keepDisplayOn();
  if (awakeLine) say("  " + awakeLine);
  const log = [];
  let result = pre.stop ? { stop: pre.stop } : { ok: true }, done = 0;
  let verified = pre.stop ? null : { head: git(["rev-parse", "HEAD"]), line: pre.line };
  for (let i = 0; i < plan.length && result.ok; i++) {
    const p = plan[i];
    if (i > 0) {
      // Before each later phase: the previous phase's plan line. The phase
      // just committed was judged on this very tree, so its line counts
      // unless HEAD has moved since.
      const want = plan[i - 1].expected, from = "phase " + plan[i - 1].n + "'s line";
      if (verified && verified.head === git(["rev-parse", "HEAD"])) {
        if (verified.line !== want) { result = { stop: "before phase " + p.n + " the tree gives \"" + verified.line + "\", not " + from + " \"" + want + "\"" }; break; }
      } else {
        const c = await precheck(p.n, want, from);
        if (c.stop) { result = { stop: c.stop }; break; }
        verified = { head: git(["rev-parse", "HEAD"]), line: c.line };
      }
    }
    // Early finish is off when the tree already gives this phase's line (a
    // phase the self-test can't tell from its stub).
    const earlyOk = !(verified && verified.line === p.expected);
    if (cfg.earlyFinish && !earlyOk) say("  (phase " + p.n + ": the tree already gives its line before the run, so no early finish for it)");
    result = await phase(p.n, p.expected, log, earlyOk, i === 0 ? pre.resume : null);
    if (!result.ok) break;
    verified = { head: git(["rev-parse", "HEAD"]), line: p.expected };
    done++;
  }

  // The replay check.
  let replayNote = "";
  if (result.ok && wantReplay) {
    const st = await selftest();
    const same = st.replay.length === wantReplay.length && st.replay.every((l, i) => l === wantReplay[i]);
    replayNote = same ? "replay lines: the same as on " + replayRef : "REPLAY LINES DIFFER from " + replayRef + ":\n    now:  " + st.replay.join("\n          ") + "\n    want: " + wantReplay.join("\n          ");
    if (!same) result = { stop: "the replay lines differ from " + replayRef };
  }

  // The report.
  const fixerRuns = log.filter(r => r.role === "fixer");
  const fixerCommits = fixerRuns.filter(r => r.commit);
  const HOW = { early: "  (ended early)", limit: "  (at the time limit, whole)", nodone: "  (no DONE line)" };
  const rows = log.map(r => "  " + r.label.padEnd(14) + String(r.mins || "-").padStart(5) + " min  " +
    (r.stop ? "STOPPED" + (r.selftest && r.selftest.line ? " (" + r.selftest.line + ")" : "") : (r.selftest ? r.selftest.line : "")) + (r.commit ? "  [" + r.commit + "]" : "") + (HOW[r.how] || ""));
  const report = ["", "=== run-phases report (" + stamp().replace(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)\d\d$/, "$1-$2-$3 $4:$5") + ", branch " + branch + ", Ollama " + ollamaInfo.version + (pinned() ? ", pinned" : "") + ")",
    "  phases done: " + done + " of " + plan.length + (fixerRuns.length ? " - the FIXER ran " + fixerRuns.length + " time" + (fixerRuns.length > 1 ? "s" : "") : ", no fixer calls")]
    .concat(rows);
  log.filter(r => r.note).forEach(r => report.push("  NOTE (" + r.label + "): " + r.note));
  const early = log.filter(r => r.how === "early");
  if (early.length) report.push("  Ended early: " + early.map(r => r.label).join(", ") + " - the file had stopped changing and already gave the plan's line (each commit body says so).");
  const stoppedRuns = log.filter(r => r.endedByRunner && !r.leftRunning);
  if (stoppedRuns.length) report.push("  Ended by the runner: " + stoppedRuns.map(r => r.label + " (" + (r.endedHow) + ")").join(", ") + " - each checked afterwards: no dsh left running.");
  if (replayNote) report.push("  " + replayNote);
  const leftRunning = log.some(r => r.leftRunning);
  if (!result.ok) report.push("  STOPPED: " + result.stop,
    leftRunning ? "  End those processes first (above). Then the tree is as the run left it: git status / git diff to look; git checkout -- " + cfg.phaseFile + " to throw an uncommitted change away."
      : log.length ? "  The tree is as the last run left it: git status / git diff to look; git checkout -- " + cfg.phaseFile + " to throw an uncommitted change away." : "  No model was run; the tree is as it was.",
    "  To go on from a phase after fixing things: node run-phases.js " + planPath + " --from <phase>");
  if (fixerCommits.length) report.push("  The fixer wrote code: the AI disclosure names it only if the author says so (the disclosure check below will ask).");
  say(report.join("\n"));

  if (cfg.disclosure && fs.existsSync(cmdParts(cfg.disclosure).args[0] || "")) {
    say("\n=== " + cfg.disclosure);
    const c = cmdParts(cfg.disclosure);
    const d = spawnSync(c.cmd === "node" ? process.execPath : c.cmd, c.args, { encoding: "utf8" });
    say(((d.stdout || "") + (d.stderr || "")).trim());
    if (d.error) say(d.error.message);
    say("(exit " + (d.status === null ? "?" : d.status) + (d.status === 2 ? " - the check couldn't run: its settings file or the folder, not the code" : "") + ")");
  }
  if (result.ok) {
    // Merge advice only when the branch holds working's newest commits; a
    // branch made from an older commit (a test of a past rebuild) would
    // conflict with working, or take it backwards, and is deleted instead.
    const n = log.filter(r => r.commit).length;
    const base = ["working", "origin/working"].find(b => gitOk(["rev-parse", "--verify", "--quiet", b]));
    const current = base && gitOk(["merge-base", "--is-ancestor", base, "HEAD"]);
    if (current) say("\nNext: look over the commits (git log --oneline -" + n + "). If this was real work: git checkout working, git merge " + branch + ", git push - and ask a cloud session for its check if it was a rebuild. If it was a test: git checkout working, git branch -D " + branch + ".");
    else say("\nNext: look over the commits (git log --oneline -" + n + "). DON'T MERGE this branch: it doesn't contain " + (base || "working") + "'s newest commits (a test, or made from an old commit). When you're done with it: git checkout working, git branch -D " + branch + ".");
  }

  try {
    fs.mkdirSync(".local-runs", { recursive: true });
    fs.writeFileSync(path.join(".local-runs", stamp() + "-batch.txt"), report.join("\n").trim() + "\n");
  } catch (e) { /* the report was printed anyway */ }
  process.exit(result.ok ? 0 : (result.crash ? 4 : result.cpu ? 5 : 1));
})().catch(e => { console.error(e && e.stack || e); process.exit(2); });
