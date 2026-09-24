cd "$(dirname "$0")"
run() { tag=$1 dir=$2 guard=$3; CORE=$PWD/engines/$dir/core.cjs WASM=$PWD/engines/$dir/core.wasm GUARD=$guard OUT=res-$tag.jsonl TAG=$tag- CONC=4 node run.mjs > log-$tag.txt 2>&1; echo "$tag: $(grep -c ' completed ' log-$tag.txt) completed, $(grep -cE ' timeout | crashed ' log-$tag.txt) timeout/crash"; }
run feb feb 1; run v010 0.1.0 1; run v020 0.2.0 1; run v031 0.3.1 1; run v050 0.5.0 1; run v050-noguard 0.5.0 0
