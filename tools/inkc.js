// ===== inkc.js - Knotwork 4.0-alpha (MIT licence) =====
// Compiles story.ink to story.js on the command line, as Inky's
// File > Export story.js only... does: the inkjs 2.4.0 compiler
// (tools/ink-full.js), every visit counted, and the file written as
// "var storyContent = {...};". For checks and scripts (a Claude session, a
// test folder); the writer exports from Inky as usual - the two give the
// same bytes.
// Use it:  node tools/inkc.js [story.ink] [story.js]
//   In a game folder with no arguments: story/story.ink -> ink/story.js
//   (js/story.js in a multi-file game). INCLUDE files are found next to the
//   .ink file. Exit 0 = written, 1 = ink errors (listed, with line numbers),
//   2 = a file is missing.
// Nothing here is loaded by the game.
"use strict";
const fs = require("fs");
const path = require("path");

const INK_FULL = path.join(__dirname, "ink-full.js");

// Compiles ink source text. Returns { json, errors, warnings }: json is the
// compiled story (text) or "" when there are errors.
function compileInk(source, inkFile) {
  const inkjs = require(INK_FULL);
  const errors = [];
  const warnings = [];
  const dir = path.dirname(path.resolve(inkFile || "story.ink"));
  const fileHandler = {
    ResolveInkFilename: function (name) { return path.resolve(dir, name); },
    LoadInkFileContents: function (p) { return fs.readFileSync(p, "utf8").replace(/^﻿/, ""); }
  };
  const onError = function (msg, type) {
    // type 1 = a warning (ink's ErrorType.Warning); the others stop the export
    (type === 1 ? warnings : errors).push(String(msg).replace(/^(ERROR|WARNING): /, ""));
  };
  const options = new inkjs.CompilerOptions(inkFile ? path.basename(inkFile) : null, [], true, onError, fileHandler);
  let story = null;
  try {
    story = new inkjs.Compiler(source.replace(/^﻿/, ""), options).Compile();
  } catch (e) {
    if (!errors.length) errors.push(String(e.message || e));
  }
  if (errors.length || !story) return { json: "", errors: errors, warnings: warnings };
  return { json: story.ToJson(), errors: errors, warnings: warnings };
}

// The default files for a game folder (cwd).
function defaultFiles(folder) {
  const ink = path.join(folder, "story", "story.ink");
  const out = fs.existsSync(path.join(folder, "js")) && !fs.existsSync(path.join(folder, "ink", "config.js")) ? path.join(folder, "js", "story.js") : path.join(folder, "ink", "story.js");
  return { ink: ink, out: out };
}

// Compiles one file to another. Returns the exit code and prints what happened.
function compileFile(inkFile, outFile, quiet) {
  if (!fs.existsSync(inkFile)) {
    console.log("inkc: no ink file at " + inkFile);
    return 2;
  }
  if (!fs.existsSync(INK_FULL)) {
    console.log("inkc: tools/ink-full.js is missing - copy it from Knotwork's kit/tools/ next to inkc.js");
    return 2;
  }
  const r = compileInk(fs.readFileSync(inkFile, "utf8"), inkFile);
  for (const w of r.warnings) console.log("WARN  " + w);
  if (r.errors.length) {
    for (const e of r.errors) console.log("ERROR " + e);
    console.log("inkc: " + inkFile + " did not compile - " + r.errors.length + " error" + (r.errors.length > 1 ? "s" : "") + " (nothing written)");
    return 1;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, "var storyContent = " + r.json + ";");
  if (!quiet) console.log("inkc: " + inkFile + " -> " + outFile + (r.warnings.length ? " (" + r.warnings.length + " warning" + (r.warnings.length > 1 ? "s" : "") + ")" : ""));
  return 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "-h" || args[0] === "--help") {
    console.log("node tools/inkc.js [story.ink] [story.js]   (no arguments: story/story.ink -> ink/story.js)");
    process.exit(0);
  }
  const d = defaultFiles(process.cwd());
  process.exit(compileFile(args[0] || d.ink, args[1] || d.out));
}

module.exports = { compileInk: compileInk, compileFile: compileFile, defaultFiles: defaultFiles };
