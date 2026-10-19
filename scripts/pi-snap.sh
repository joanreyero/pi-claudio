#!/usr/bin/env bash
# Snapshot pi's interactive TUI via tmux.
# Usage: pi-snap.sh [-w COLS] [-h ROWS] [-t WAIT_SECONDS] [-k "keys"] [-c CWD] [PROMPT]
#   -k  extra tmux send-keys sequence to send after the prompt finished (e.g. "C-o")
# Prints the captured pane (with ANSI colors stripped) to stdout.
set -euo pipefail
COLS=120; ROWS=45; WAIT=25; KEYS=""; CWD="$PWD"
while getopts "w:h:t:k:c:" o; do case $o in w) COLS=$OPTARG;; h) ROWS=$OPTARG;; t) WAIT=$OPTARG;; k) KEYS=$OPTARG;; c) CWD=$OPTARG;; esac; done
shift $((OPTIND-1))
PROMPT="${1:-}"
S="pisnap$$"
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x "$COLS" -y "$ROWS" -c "$CWD" "pi --no-session"
sleep 4
if [ -n "$PROMPT" ]; then
  tmux send-keys -t "$S" -l "$PROMPT"
  sleep 0.3
  tmux send-keys -t "$S" Enter
  # wait until the pane stops changing for 3 consecutive seconds (max WAIT)
  prev=""; stable=0
  for i in $(seq 1 "$WAIT"); do
    sleep 1
    cur=$(tmux capture-pane -p -t "$S")
    if [ "$cur" = "$prev" ]; then stable=$((stable+1)); else stable=0; fi
    prev="$cur"
    [ "$stable" -ge 3 ] && [ "$i" -gt 4 ] && break
  done
fi
if [ -n "$KEYS" ]; then tmux send-keys -t "$S" $KEYS; sleep 1; fi
echo "=== pane ${COLS}x${ROWS} ==="
tmux capture-pane -p -t "$S" -S -200 | sed 's/[[:space:]]*$//' | awk 'NF{p=1} p' | cat -s
if [ "${PI_SNAP_ANSI:-}" = "1" ]; then tmux capture-pane -p -e -t "$S" -S -200 > /tmp/pi-snap-ansi.txt; echo "(ansi saved to /tmp/pi-snap-ansi.txt)"; fi
tmux kill-session -t "$S"
