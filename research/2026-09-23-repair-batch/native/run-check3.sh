#!/bin/bash
# usage: run-check3.sh <harness> <listfile-or-dir> <filesdir> <out.txt> [limit]
# Reports any step whose audit line is not all-zero, any WATCHDOG, any nonzero AUDIT rebuilds/dropped, any sanitizer report.
H=$1; L=$2; D=$3; OUT=$4; LIM=${5:-300}; : > "$OUT"
if [ -d "$L" ]; then FILES=$(ls "$L"/*.stl "$L"/*.STL 2>/dev/null); else FILES=$(sed "s|^|$D/|; s|$|.stl|" "$L"); fi
for f in $FILES; do [ -f "$f" ] || continue; [ $(stat -c %s "$f") -lt 1000 ] && continue
  r=$("$H" "$f" "$LIM" 2>&1 | grep -E "^after|WATCHDOG|^AUDIT|runtime error|AddressSanitizer|Assertion" | awk -v f="$(basename $f)" '/WATCHDOG|runtime error|AddressSanitizer|Assertion/{print f" "$0; next} /^AUDIT/{ if ($0 !~ /rebuilds=0 dropped=0/) print f" "$0; next} {split($0,a,"\\|"); if (a[2] !~ /badRing=0 badFaceRef=0 badPrevNext=0 badOpp=0 badBoundaryLoop=0 badVertexRot=0 badVHandle=0 badIdx=0/) print f" "$0}')
  [ -n "$r" ] && echo "$r" >> "$OUT"
  echo "$(basename $f)" >> "$OUT.seen"
done
echo done >> "$OUT.done"
