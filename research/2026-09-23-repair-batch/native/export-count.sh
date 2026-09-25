#!/bin/bash
# For every wild + local file: export the repaired mesh from the committed build (new6) and the final build (new7), count zero-area faces both ways on input and outputs.
W=/tmp/claude-1000/-home-node-repos-meshfix-wasm/0dfba0e8-946d-49e0-a1ba-834c6a80737b/scratchpad; cd $W/native; mkdir -p $W/exports; OUT=$W/zerocount.tsv; : > $OUT
for f in $(sed 's|^|../thingi/files/|; s|$|.stl|' $W/../../e3cdd29e-bd25-4aa4-a393-71e1cd66f611/scratchpad/thingi/file_ids.txt 2>/dev/null) ~/.vaxis-backups/models/*.stl; do :; done
run() { f=$1; b=$(basename $f .stl); [ -f "$f" ] || return; [ $(stat -c %s "$f") -lt 1000 ] && return
  timeout 300 ./harness-export-new6 "$f" $W/exports/$b-new6.stl > /dev/null 2>&1; timeout 300 ./harness-export-new7 "$f" $W/exports/$b-new7.stl > /dev/null 2>&1
  i=$(./areacount "$f" 2>/dev/null | awk '{print $3" "$4}'); a=$(./areacount $W/exports/$b-new6.stl 2>/dev/null | awk '{print $3" "$4}'); c=$(./areacount $W/exports/$b-new7.stl 2>/dev/null | awk '{print $3" "$4}')
  echo "$b input:$i committed:$a final:$c" >> $OUT; }
for id in $(cat /home/node/repos/meshfix-wasm/research/2026-09-23-repair-batch/native/results/sample.txt); do run ../thingi/files/$id.stl; done
for f in ~/.vaxis-backups/models/*.stl; do run "$f"; done
echo done >> $OUT.done
