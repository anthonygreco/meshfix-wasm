#!/bin/bash
W=/tmp/claude-1000/-home-node-repos-meshfix-wasm/0dfba0e8-946d-49e0-a1ba-834c6a80737b/scratchpad
N=$W/native; R=/home/node/repos/meshfix-wasm/research/2026-09-23-repair-batch
INC="-I/home/node/repos/meshfix-wasm/third_party/pmp-library/src -I/home/node/repos/meshfix-wasm/third_party/pmp-library/external/eigen-3.4.0 -I/home/node/repos/meshfix-wasm/third_party/happly"
cd $N; rm -rf res; mkdir -p res
echo "$(date) builds" >> $W/go.log
(g++ -std=c++20 -O2 -g -fopenmp $INC main-new7-check.cpp -o harness-new7-check -L$N/pmp-rel -lpmp -Wl,-rpath,$N/pmp-rel 2>&1 | grep error) &
(g++ -std=c++20 -fsanitize=address,undefined -fno-omit-frame-pointer -O1 -g -fopenmp $INC main-new7.cpp -o harness-new7-asan -L$N/pmp-asan -lpmp -Wl,-rpath,$N/pmp-asan 2>&1 | grep error) &
(g++ -std=c++20 -fsanitize=address,undefined -fno-omit-frame-pointer -O1 -g -fopenmp $INC main-new7-check.cpp -o harness-new7-check-asan -L$N/pmp-asan -lpmp -Wl,-rpath,$N/pmp-asan 2>&1 | grep error) &
(cd /home/node/repos/meshfix-wasm && bash scripts/build-wasm.sh > $W/wasm-build2.log 2>&1 && npm run build:ts >> $W/wasm-build2.log 2>&1; echo "exit=$?" >> $W/wasm-build2.log; cp dist/meshfix-core.js $N/core-new7.cjs; cp dist/meshfix-core.wasm $N/core-new7.wasm) &
# sweeps that need nothing new: new7 native outcome (wild, local, held-out), rel native + rel check on held-out
for c in 00 01 02 03; do (./run-list.sh ./harness-new7 ../thingi/files ../thingi/chunk-$c res/thingi-new7-$c.jsonl 300 > /dev/null 2>&1) & done
(./run-batch.sh ./harness-new7 ~/.vaxis-backups/models res/corpus-new7.jsonl 300 > /dev/null 2>&1) &
wait
echo "$(date) builds+first sweeps done" >> $W/go.log
# held-out lists in 4 chunks
split -n l/4 -d $W/heldout-ids.txt $W/heldout-chunk-
for c in 00 01 02 03; do
  (./run-list.sh ./harness-rel $W/heldout/files $W/heldout-chunk-$c res/heldout-rel-$c.jsonl 300 > /dev/null 2>&1; ./run-list.sh ./harness-new7 $W/heldout/files $W/heldout-chunk-$c res/heldout-new7-$c.jsonl 300 > /dev/null 2>&1) &
  (./run-check3.sh ./harness-new7-check ../thingi/chunk-$c ../thingi/files res/checkNew7-$c.txt 300 > /dev/null 2>&1; ./run-check3.sh ./harness-new7-check $W/heldout-chunk-$c $W/heldout/files res/checkNew7-heldout-$c.txt 300 > /dev/null 2>&1; ./run-check3.sh ./harness-check $W/heldout-chunk-$c $W/heldout/files res/checkRel-heldout-$c.txt 300 > /dev/null 2>&1) &
done
(./run-check3.sh ./harness-new7-check ~/.vaxis-backups/models x res/checkNew7-corpus.txt 300 > /dev/null 2>&1) &
(./run-batch.sh ./harness-new7-asan ~/.vaxis-backups/models res/corpus-new7-asan.jsonl 900 > /dev/null 2>&1) &
(cd /home/node/repos/meshfix-wasm && npm test > $W/vitest-new7.log 2>&1) &
(cd $R && CORE=$N/core-new7.cjs WASM=$N/core-new7.wasm ORDER=new OUT=native/results/res-new7-wasm.jsonl TAG=new7- CONC=2 node run.mjs > $W/log-new7-wasm.txt 2>&1) &
wait
echo "$(date) wave 2 done" >> $W/go.log
# wave 3: held-out WASM (0.5.0 and new7), held-out ASan (<20MB), perturbation (audit+asan)
(cd $R && DIR=$W/heldout/files CORE=$R/engines/0.5.0/core.cjs WASM=$R/engines/0.5.0/core.wasm GUARD=1 OUT=native/results/heldout-v050-wasm.jsonl TAG=hv050- CONC=3 node run.mjs > $W/log-heldout-v050.txt 2>&1) &
(cd $R && DIR=$W/heldout/files CORE=$N/core-new7.cjs WASM=$N/core-new7.wasm ORDER=new OUT=native/results/heldout-new7-wasm.jsonl TAG=hnew7- CONC=3 node run.mjs > $W/log-heldout-new7.txt 2>&1) &
find $W/heldout/files -name "*.stl" -size -20M | xargs -n1 basename | sed 's/.stl$//' | sort > $W/heldout-small.txt
split -n l/3 -d $W/heldout-small.txt $W/heldout-small-
for c in 00 01 02; do (./run-list.sh ./harness-new7-asan $W/heldout/files $W/heldout-small-$c res/heldout-new7-asan-$c.jsonl 900 > /dev/null 2>&1) & done
split -n l/4 -d $W/perturbed-ids.txt $W/perturbed-chunk-
for c in 00 01 02 03; do (./run-check3.sh ./harness-new7-check-asan $W/perturbed-chunk-$c $W/perturbed/files res/perturb-new7-checkasan-$c.txt 900 > /dev/null 2>&1) & done
wait
echo "$(date) wave 3 done" >> $W/go.log
echo ALLDONE >> $W/go.log
