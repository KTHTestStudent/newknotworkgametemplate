# About this template

KTHTestStudent/newknotworkgametemplate is the repository every new Knotwork game starts from, so that R8 and R10 of GDD.md hold from a game's first commit. This file is about the template, not about a game. In a game made from it, keep the "Copied files" table and delete the rest once setup is done.

## Starting a game from it

1. On GitHub, on this repository's page: "Use this template", then "Create a new repository". Owner KTHTestStudent, the game's name, Private. Leave "Include all branches" unticked.
2. Clone it into C:\Git and make `working` (the FULL-GUIDE in localsubagentresults, steps 2 and 4). Step 3, the setup files, is already done by the template.
3. Start a cloud session on the new repository with the new-game skill. It fills the [bracketed] fields in CLAUDE.md, HANDOFF.md and README.md, and checks the copied files against their sources.

A repository made this way starts with one commit and none of this repository's history.

## What is here

| File or folder | What it is | Written by |
| --- | --- | --- |
| GDD.md | The game design document template | The author; setup edits listed in its commits |
| CLAUDE.md, HANDOFF.md, README.md | Stubs with [fields] for the new game | Claude Fable 5.2, setup session, 2026-11-13 |
| disclosure.jsonc | Settings for dev/disclosure.js | Claude Fable 5.2, setup session, 2026-11-13 |
| .gitignore, .gitattributes | As the FULL-GUIDE's step 3 gives them, plus dist/ | Claude Fable 5.2, setup session, 2026-11-13 |
| LICENSE | MIT, the author's choice (2026-11-13) | Same text as Knotwork's |
| src/, data/, story/, specs/, tests/ | Empty, each held by a .gitkeep file | |
| The copied files | See the next table | |

## Copied files

Unedited copies. To change one, change it in its own repository, then copy it here again and update this table.

| Files | From | Version | Copied |
| --- | --- | --- | --- |
| run-local.sh, run-phases.js, LOCAL-SUBAGENTS.md, phase-plan.example.txt | KTHTestStudent/localsubagentresults, main | 14af116 (2026-11-05) | 2026-11-13 |
| ink/dialogue.js, ink/ink.js (inkjs 2.4.0), tools/ (ink-full.js, inkc.js, knotcheck.html, knotcheck.js, pack.html, pack.js, testfolder.js, viewer.html), LICENSE-INKJS.txt | KTHTestStudent/knotworkprivateprealpha, kit/ and template/ | Tag v4.0-alpha, 28ef2d4 (2026-10-26) | 2026-11-13 |
| dev/disclosure.js | KTHTestStudent/Auto-Disclosure-Tool, working | 00b9d2c (2026-11-13), md5 9a92f18c... | 2026-11-13 |

All were checked byte for byte against their sources on the day they were copied.

## Not in the template, on purpose

- A game page, ink/config.js, story/story.ink and ink/story.js: they belong to each game's skeleton and story contract.
- phase-runner.json: a game adds it with its skeleton (the spec, the phase file, the self-test command, the limits, and the pinned Ollama version the FULL-GUIDE asks for).
- A declarations file: GDD.md names one, but the Auto-Disclosure-Tool does not read one yet (its phase 3).

## Keeping it current

A game made from the template is a snapshot: later changes here don't reach it. When the runner, Knotwork or the disclosure tool changes, a cloud session copies the new files here on working-claude and updates the table above. The new-game skill compares a new game's copies with the sources, so a stale template shows up there.
