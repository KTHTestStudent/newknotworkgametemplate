Local builder/fixer runs: follow LOCAL-SUBAGENTS.md.

Git: cloud sessions make working-claude from origin/working and push only there. Laptop sessions work on a branch made from working and [never push / may push their own build branch - the author's answer]. Sessions never push to working or main.

# CLAUDE.md - [working title]

Project rules for Claude sessions in this repo. Where this file differs from the route-check skill, this file wins. The design source is GDD.md, and its ten standing rules (R1 to R10) apply to all work here; a project changes one only through the Exceptions table in GDD.md section 10. **Start with HANDOFF.md** (START HERE down to the HISTORY line): where things stand and what's next.

Fields in [brackets] in this file are filled when the game is set up (the new-game skill). TEMPLATE.md says what came with the template and where each copied file is from.

## Who does what

GDD.md section 2 (Roles, and Routing: local first) is the full table. In short:

- Kenton Howard (the author): creative direction and every design decision, the story and its ink (written in Inky), all player-facing names, the AI disclosure's wording, playtesting, merges, tags and releases. Claude may review the ink (knotcheck, play runs) and point at problems; it never writes story prose or placeholder lines.
- Claude in the cloud: the design document from the author's direction, phase specs and test specs, stub knots (R1), verification, cloud checks and docs.
- The local builder and fixer: the game's code, one phase per fresh session, through the runner (LOCAL-SUBAGENTS.md). A cloud model takes a build task only for a reason logged in GDD.md section 2 (R7).

## What Claude never does here

- Write a sentence a player could read in the story, not even as a placeholder. Stub knots carry the knot name, the outcome wiring and a visible STUB marker only (GDD.md section 4).
- Edit story/story.ink after the design freeze.
- Open, view or upload art or audio made by the author's collaborators. Only ink and code go to an AI.
- Change the disclosure line's words. `node dev/disclosure.js --apply` may add a Claude model's name; any other name is the author's to add.
- Merge into working or main, tag, rebase, force-push or delete a branch without the author's OK.
- Edit a copied file (TEMPLATE.md lists them). Change it where it comes from, then copy it here again.

## Commits

Every commit ends with a `Co-Authored-By:` line naming the model that is actually running, from its own setup, never copied from an older commit. One change per commit, so the author can revert one before he merges.

## Build rules

- R2, R3: plain HTML, CSS and JS unless the engine test in GDD.md section 6 says Phaser; fully playable in a browser; ships to itch.io as a zip with no network calls.
- R4: every screen works by touch, by controller, and by keyboard and mouse. Code reads actions, never keys.
- R5: VFX, SFX and tutorial hooks are built in the same phase as the feature.
- R6: no value, name or string in `src/`. They live in `data/` definitions a person can edit by hand; ids never change.
- No image or audio file enters the repo without a row in GDD.md's Provenance table.
- [Game-specific rules, added with the skeleton.]

## Checks

- At the end of any session that committed code: `node dev/disclosure.js` (exit 0).
- After a story export: `node tools/knotcheck.js .` (Knotwork's), once ink/config.js and the story exist.
- Every phase: the list under "Checks run every phase" in GDD.md section 8. [The commands, added with the skeleton.]
- Keep the documents that quote the code in step with it: the specs, GDD.md, and the knot table against story/story.ink and ink/config.js.
- In Claude's cloud workspace, run node with `NODE_PATH=/opt/npm-tools/node_modules`.
- At the end of a session: update HANDOFF.md (the handoff skill).
