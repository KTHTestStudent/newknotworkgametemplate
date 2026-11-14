// ===== testfolder.js - Knotwork 4.0-alpha (MIT licence) =====
// Makes a TEST copy of a game whose story has test content in every knot
// that isn't written yet, so the game's side - every outcome and what it
// does - can be played and checked before the story exists. For the game's
// programmer and for checks; the copy is scratch, never the real story.
// Use it:  node tools/testfolder.js <out folder> [game folder]
// What it does, from ink/config.js and story/story.ink:
//   * copies the game folder to <out folder> (not .git, node_modules or
//     .local-runs);
//   * in the copy's story.ink, fills each knot that is only "-> DONE" (and
//     comments): an outcome knot gets a line "TEST <knot>." and one choice
//     per value in outcomeValues ("TEST <value>"), each sending that value
//     once, after the choices, with the knot's outcome hook - the
//     one-outcome contract. A knot without outcomeValues uses its default
//     (defaults), or is left empty and named. Any other knot the game starts
//     gets one line, "TEST <knot>.". Written knots are kept as they are.
//   * compiles it to the copy's ink/story.js (tools/inkc.js).
// Then, for example:  node <out folder>/tools/knotcheck.js <out folder>
// and open <out folder>/game.html. Exit 0 = made, 1 = it would not compile,
// 2 = a file is missing.
// Nothing here is loaded by the game. The lines it writes are test lines,
// marked TEST - never story prose.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const inkc = require("./inkc.js");

// The game's settings: var INK_CONFIG = {...} in ink/config.js.
function readConfig(file) {
  const box = {};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), box, { filename: file });
  const c = box.INK_CONFIG;
  if (!c || typeof c !== "object") throw new Error(file + " gives no INK_CONFIG");
  return c;
}

function inkValue(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error("an outcome value must be a string, a number or true / false: " + JSON.stringify(v));
}

function hookFor(conf, knot) {
  const o = conf.outcomes || {};
  for (const prefix in o) if (knot.indexOf(prefix) === 0) return o[prefix];
  return "";
}

// The lines for one knot that isn't written yet, or null to leave it.
function testLines(conf, knot) {
  const hook = hookFor(conf, knot);
  if (!hook) return ["TEST " + knot + "."];
  let values = (conf.outcomeValues || {})[knot];
  if (!Array.isArray(values) || !values.length) {
    const d = (conf.defaults || {})[knot];
    if (d === undefined) return null;
    values = [d];
  }
  const L = ["~ temp test_outcome = " + inkValue(values[0]), "TEST " + knot + "."];
  for (const v of values) {
    L.push("+ [TEST " + String(v) + "]");
    L.push("    ~ test_outcome = " + inkValue(v));
  }
  L.push("- ~ " + hook + "(" + JSON.stringify(knot) + ", test_outcome)");
  return L;
}

// Fills the empty knots of a story. Returns { text, filled, kept, skipped }.
function fillStory(src, conf) {
  const filled = [];
  const kept = [];
  const skipped = [];
  const knots = Array.isArray(conf.knots) ? conf.knots.map(String) : [];
  src = src.replace(/\r\n/g, "\n");
  for (const k of knots) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const head = new RegExp("^(={2,}\\s*" + esc + "\\s*=*[ \\t]*\\n)((?:[ \\t]*(?://[^\\n]*)?\\n)*)[ \\t]*->[ \\t]*DONE[ \\t]*(\\n|$)", "m");
    const m = head.exec(src);
    if (!m) {
      if (new RegExp("^={2,}\\s*" + esc + "\\s*=*[ \\t]*$", "m").test(src)) kept.push(k);
      else skipped.push(k + " (no such knot)");
      continue;
    }
    const L = testLines(conf, k);
    if (!L) {
      skipped.push(k + " (no outcomeValues and no default)");
      continue;
    }
    src = src.slice(0, m.index) + m[1] + m[2] + L.join("\n") + "\n-> DONE" + m[3] + src.slice(m.index + m[0].length);
    filled.push(k);
  }
  // An outcome hook the test lines call needs EXTERNAL and an ink stand-in
  // (for Inky's preview), as the kit's stories have them: add what's missing.
  const stand = [];
  for (const k of filled) {
    const h = hookFor(conf, k);
    if (!h || stand.indexOf(h) >= 0) continue;
    stand.push(h);
    if (!new RegExp("^\\s*EXTERNAL\\s+" + h + "\\s*\\(", "m").test(src)) src = "EXTERNAL " + h + "(name, outcome)\n" + src;
    if (!new RegExp("^={2,}\\s*function\\s+" + h + "\\s*\\(", "m").test(src)) src = src.replace(/\n*$/, "\n\n=== function " + h + "(name, outcome) ===\n~ return true\n");
  }
  const top = "// TEST STORY made by tools/testfolder.js from story/story.ink - scratch,\n// for checking the game; every line marked TEST is a test line.\n";
  return { text: top + src, filled: filled, kept: kept, skipped: skipped };
}

function copyGame(from, to) {
  const SKIP = [".git", "node_modules", ".local-runs"];
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.indexOf(e.name) >= 0) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (path.resolve(a) === path.resolve(to)) continue; // an out folder inside the game
    if (e.isDirectory()) copyGame(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

function main(args) {
  const out = args[0];
  const game = path.resolve(args[1] || ".");
  if (!out || out === "-h" || out === "--help") {
    console.log("node tools/testfolder.js <out folder> [game folder]");
    return out ? 0 : 2;
  }
  const confFile = path.join(game, "ink", "config.js");
  const inkFile = path.join(game, "story", "story.ink");
  for (const f of [confFile, inkFile]) {
    if (!fs.existsSync(f)) {
      console.log("testfolder: no " + path.relative(game, f) + " in " + game);
      return 2;
    }
  }
  if (path.resolve(out) === game) {
    console.log("testfolder: the out folder must not be the game folder");
    return 2;
  }
  const conf = readConfig(confFile);
  const r = fillStory(fs.readFileSync(inkFile, "utf8"), conf);
  copyGame(game, out);
  const outInk = path.join(out, "story", "story.ink");
  fs.writeFileSync(outInk, r.text);
  const code = inkc.compileFile(outInk, inkc.defaultFiles(out).out, true);
  console.log("testfolder: " + out);
  console.log("  filled with TEST content: " + (r.filled.join(", ") || "none"));
  if (r.kept.length) console.log("  written already, kept: " + r.kept.join(", "));
  if (r.skipped.length) console.log("  left as they are: " + r.skipped.join(", "));
  if (code) return code;
  console.log("  then: node " + path.join(out, "tools", "knotcheck.js") + " " + out);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { fillStory: fillStory, testLines: testLines, readConfig: readConfig };
