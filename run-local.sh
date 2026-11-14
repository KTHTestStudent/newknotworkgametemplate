#!/usr/bin/env bash
# run-local.sh - one local-model run (builder or fixer) through dsh headless.
# Claude Code calls this from Git Bash in the project folder; you approve
# each call in Claude Code's permission prompt. Never put this script on an
# allow-list: the prompt IS the approval step.
#
#   bash run-local.sh builder "phase5" prompts/phase5.txt
#   bash run-local.sh fixer   "phase5-fix1" prompts/phase5-fix1.txt
#
# What it does: refuses to start on a dirty tree (so the diff is the model's),
# runs ONE headless dsh session, saves the model's answer and reasoning to
# .local-runs/, appends one row to .local-runs/runs.csv and prints a short
# summary. It does not commit - Claude commits after the self-test.
# Exit codes: dsh's own, or 2 usage / Ollama not the version phase-runner.json
# pins, 3 dirty tree, 4 driver crash (restart Windows), 5 a model not all on
# the GPU (restart Ollama; LOCAL-SUBAGENTS.md hard rule 6).
set -u

role="${1:?role: builder or fixer}"
label="${2:?label, e.g. phase5}"
promptfile="${3:?prompt file}"
DSH_BIN="${DSH_BIN:-dsh}"

case "$role" in
  builder) export DSH_HOME="${DSH_BUILDER_HOME:-$USERPROFILE/.dsh}" ;;
  fixer)   export DSH_HOME="${DSH_FIXER_HOME:-$USERPROFILE/.dsh-fixer}" ;;
  *) echo "role must be builder or fixer"; exit 2 ;;
esac
# Stay in the project folder; anything outside would need an approval that
# nobody can give in headless mode.
export DSH_PERMISSION_MODE=workspace-write

[ -f "$promptfile" ] || { echo "no prompt file: $promptfile"; exit 2; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "REFUSED: uncommitted changes. Commit or stash first so the diff is the model's."
  exit 3
fi

mkdir -p .local-runs
grep -qx '.local-runs/' .git/info/exclude 2>/dev/null || echo '.local-runs/' >> .git/info/exclude
stamp="$(date +%Y%m%d-%H%M%S)"
id="$stamp-$role-$label"
ans=".local-runs/$id.answer.txt"
rsn=".local-runs/$id.reasoning.txt"
cp "$promptfile" ".local-runs/$id.prompt.txt"

# Free physical memory in MB (Windows; empty elsewhere).
freemb() { powershell.exe -NoProfile -Command "[int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1024)" 2>/dev/null | tr -d '\r'; }
# Ollama's version: the server's ("ollama version is 0.40.14"), else
# "client X" when only the command answered, else "?".
ollama_version() {
  local t v
  t="$(ollama --version 2>&1 | tr -d '\r')"
  v="$(printf '%s\n' "$t" | sed -n 's/^ollama version is v\{0,1\}\([^ ]*\).*/\1/p' | head -n 1)"
  [ -n "$v" ] || v="$(printf '%s\n' "$t" | sed -n 's/.*client version is v\{0,1\}\([^ ]*\).*/client \1/p' | head -n 1)"
  printf '%s' "${v:-?}"
}
# Loaded models with part of them on the CPU: ollama ps rows whose PROCESSOR
# is "100% CPU" or "48%/52% CPU/GPU" (all on the GPU is "100% GPU").
cpu_rows() { ollama ps 2>/dev/null | tr -d '\r' | sed 1d | grep -E '[0-9]+%(/[0-9]+%)? CPU'; }
RESTART="Quit Ollama from the tray and start it again (or restart Windows); then ollama --version, and once a model is loaded, ollama ps must show 100% GPU (LOCAL-SUBAGENTS.md hard rule 6)."

# The version phase-runner.json pins ("ollamaVersion": "0.40.11"), if any.
ov="$(ollama_version)"
pin="$(sed -n 's/.*"ollamaVersion"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' phase-runner.json 2>/dev/null | head -n 1)"
if [ -n "$pin" ] && [ "$ov" != "$pin" ]; then
  echo "REFUSED: Ollama is $ov, but phase-runner.json's ollamaVersion is $pin - an update came in, or Ollama isn't running. Put $pin back (auto-update off), or change the pin. No model was run."
  exit 2
fi

# Unload the OTHER model first, so a swap never holds both for a moment.
other=fixer; [ "$role" = fixer ] && other=builder
ollama stop "$other" >/dev/null 2>&1

echo "== $id   (DSH_HOME=$DSH_HOME, ollama $ov)"
ollama ps 2>/dev/null | sed -n '1,3p'
# A model already loaded partly on the CPU would be used there.
cpu0="$(cpu_rows)"
if [ -n "$cpu0" ]; then
  echo "!! MODEL ON THE CPU before the run: $cpu0"
  echo "!! $RESTART No model was run."
  exit 5
fi
untracked_before="$(git ls-files --others --exclude-standard | sort)"
mem0="$(freemb)"
t0=$(date +%s)
"$DSH_BIN" --profile headless "$(cat "$promptfile")" >"$ans" 2>"$rsn"
code=$?
t1=$(date +%s)
mem1="$(freemb)"
mins=$(awk "BEGIN{printf \"%.1f\", ($t1-$t0)/60}")

stat="$(git diff --shortstat)"
# Changed tracked files, plus files the run CREATED (untracked now, not before).
newfiles="$(comm -13 <(printf '%s\n' "$untracked_before") <(git ls-files --others --exclude-standard | sort) | sed '/^$/d')"
files="$(git diff --name-only | tr '\n' ' ')"
[ -n "$newfiles" ] && files="$files$(printf '%s\n' "$newfiles" | sed 's/$/ (new)/' | tr '\n' ' ')"
# Last line of the answer, skipping blank lines and code-fence lines.
last="$(grep -v -E '^[[:space:]]*$|^[[:space:]]*```' "$ans" | tail -n 1 | cut -c1-200)"
crash="$(grep -m1 -E 'ROCm error|llama-server process has terminated' "$rsn" "$ans" 2>/dev/null)"
# Git commands that could read an old answer (history, other branches). The
# prompt forbids running anything (R3) but headless mode would not stop it,
# so flag any such text for a look. A hit may only be the model thinking.
gitseen="$(grep -h -o -E '\bgit[[:space:]]+(log|show|diff|checkout|switch|restore|stash|reset|cat-file|blame|reflog|branch|worktree|fetch|pull|clone|grep)\b[^"`\\]{0,60}' "$ans" "$rsn" 2>/dev/null | sort -u | head -n 3 | tr '\n' ';')"

# runs.csv: Ollama's version is the last column (2026-11-03); an older file's
# header gets it, and its older rows keep their ten columns.
csv=.local-runs/runs.csv
if [ ! -f "$csv" ]; then
  echo 'run_id,role,label,exit,minutes,files_changed,diffstat,last_line,free_mb_start,free_mb_end,ollama_version' > "$csv"
elif ! head -n 1 "$csv" | tr -d '\r' | grep -q ',ollama_version$'; then
  sed -i '1s/\r\{0,1\}$/,ollama_version/' "$csv"
fi
q() { printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"; }
echo "$(q "$id"),$role,$(q "$label"),$code,$mins,$(q "$files"),$(q "$stat"),$(q "$last"),$mem0,$mem1,$(q "$ov")" >> "$csv"

echo "exit: $code   minutes: $mins   free RAM MB: ${mem0:-?} -> ${mem1:-?}"
echo "changed: ${files:-NOTHING}   ${stat}"
echo "last line: ${last:-<empty>}"
echo "answer: $ans ($(wc -c <"$ans") bytes)   reasoning: $rsn ($(wc -c <"$rsn") bytes)"
[ -n "$gitseen" ] && echo "!! git command text in the run (look in the reasoning there): $gitseen"
if [ -n "$crash" ]; then
  echo "!! DRIVER CRASH: $crash"
  ov1="$(ollama_version)"
  [ "$ov1" != "$ov" ] && ov="$ov (now $ov1: an update came in)"
  if [ -n "$pin" ] && [ "$ov" = "$pin" ]; then
    echo "!! Ollama $ov, the pinned version (phase-runner.json): not an update - tell the author."
  else
    echo "!! Ollama $ov: an update may have come in - check ollama --version${pin:+ against the pinned $pin}."
  fi
  echo "!! Restart Windows before ANY further run (LOCAL-SUBAGENTS.md hard rule 6)."
  exit 4
fi
# The run's model partly on the CPU (it stays loaded after the run).
cpu1="$(cpu_rows)"
if [ -n "$cpu1" ]; then
  echo "!! MODEL ON THE CPU during the run: $cpu1"
  echo "!! The run doesn't count. $RESTART"
  exit 5
fi
exit "$code"
