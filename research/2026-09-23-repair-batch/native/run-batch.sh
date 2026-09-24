#!/bin/bash
# usage: run-batch.sh <harness> <dir> <out.jsonl> <limitSec> [maxMB]
H=$1; D=$2; OUT=$3; LIM=$4; MAXMB=${5:-1000}
: > "$OUT"; mkdir -p "$OUT.err"
for f in "$D"/*.stl "$D"/*.STL; do
  [ -f "$f" ] || continue
  mb=$(( $(stat -c %s "$f") / 1048576 )); [ "$mb" -gt "$MAXMB" ] && { echo "{\"file\":\"$f\",\"outcome\":\"skipped_size\"}" >> "$OUT"; continue; }
  b=$(basename "$f")
  line=$("$H" "$f" "$LIM" 2> "$OUT.err/$b.txt"); code=$?
  if [ -n "$line" ]; then echo "$line" >> "$OUT"; else echo "{\"file\":\"$f\",\"outcome\":\"exit_$code\",\"err\":\"$(grep -m1 -E 'WATCHDOG|ERROR|Assertion|runtime error' "$OUT.err/$b.txt" | tr -d '"' | head -c 200)\"}" >> "$OUT"; fi
  [ -s "$OUT.err/$b.txt" ] || rm -f "$OUT.err/$b.txt"
done
echo "batch done" >> "$OUT.done"
