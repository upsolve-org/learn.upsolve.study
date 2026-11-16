#!/bin/bash
# Compare a hash list (read from stdin) against the deployed tree.
cd /srv/learn || exit 1
while read -r h p; do
  [ -z "$h" ] && continue
  if [ -f "$p" ]; then
    a=$(sha256sum "$p" | cut -d' ' -f1 | tr 'a-f' 'A-F')
    if [ "$a" = "$h" ]; then echo "SAME $p"; else echo "DIFF $p"; fi
  else
    echo "MISSING $p"
  fi
done