#!/bin/bash
# usage: run-list.sh <harness> <dir> <listfile> <out.jsonl> <limitSec>
H=$1; D=$2; L=$3; OUT=$4; LIM=$5
: > "$OUT"; mkdir -p "$OUT.err"
while read -r id; do
  f="$D/$id.stl"; [ -f "$f" ] || continue
  [ $(stat -c %s "$f") -lt 1000 ] && continue
  line=$("$H" "$f" "$LIM" 2> "$OUT.err/$id.txt"); code=$?
  if [ -n "$line" ]; then echo "$line" >> "$OUT"; else echo "{\"file\":\"$f\",\"outcome\":\"exit_$code\",\"err\":\"$(grep -m1 -E 'WATCHDOG|ERROR|Assertion|runtime error|terminate' "$OUT.err/$id.txt" | tr -d '"' | head -c 200)\"}" >> "$OUT"; fi
  [ -s "$OUT.err/$id.txt" ] || rm -f "$OUT.err/$id.txt"
done < "$L"
echo done >> "$OUT.done"
