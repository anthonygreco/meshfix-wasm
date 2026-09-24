#!/bin/bash
# usage: run-check.sh <listfile-or-dir> <out.txt>
L=$1; OUT=$2; : > "$OUT"
if [ -d "$L" ]; then FILES=$(ls "$L"/*.stl); else FILES=$(sed "s|^|../thingi/files/|; s|$|.stl|" "$L"); fi
for f in $FILES; do [ -f "$f" ] || continue; [ $(stat -c %s "$f") -lt 1000 ] && continue
  r=$(${HARNESS:-./harness-check} "$f" 300 2>&1 | grep -E "^after|WATCHDOG" | awk -v f="$(basename $f)" '/WATCHDOG/{print f" WATCHDOG "$0; next} {split($0,a,"\\|"); if (a[2] !~ /badRing=0 badFaceRef=0 badPrevNext=0 badOpp=0 badBoundaryLoop=0 badVertexRot=0 badVHandle=0 badIdx=0/) print f" "$0}')
  [ -n "$r" ] && echo "$r" >> "$OUT"
done
echo done >> "$OUT.done"
