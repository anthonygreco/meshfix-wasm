import csv, random, sys
used = set(l.strip() for l in open('/home/node/repos/meshfix-wasm/research/2026-09-23-repair-batch/native/results/sample.txt') if l.strip())
rows = list(csv.DictReader(open(f'{sys.argv[1]}/thingi/geometry_data.csv')))
def cats(r):
    c = []
    f = int(r['num_faces'])
    if r['vertex_manifold'] == '0': c.append('nmV')
    if r['edge_manifold'] == '0': c.append('nmE')
    if int(r['num_boundary_edges']) > 0: c.append('open')
    if int(r['num_geometrical_degenerated_faces']) + int(r['num_combinatorial_degenerated_faces']) > 0: c.append('degen')
    if int(r['num_duplicated_faces']) > 0: c.append('dup')
    if int(r['num_connected_components']) > 1: c.append('multi')
    if r['oriented'] == '0': c.append('unoriented')
    if int(r['num_self_intersections']) > 0: c.append('selfint')
    if not c: c.append('clean')
    return c
pool = [r for r in rows if r['file_id'] not in used and 0 < int(r['num_faces']) <= 2_000_000]
random.seed(20260924)
random.shuffle(pool)
# stratified: fill each category to a floor, then top up at random
floor = {'clean': 60, 'nmV': 25, 'nmE': 25, 'open': 40, 'degen': 25, 'dup': 20, 'multi': 25, 'unoriented': 20, 'selfint': 30}
picked, count = [], {k: 0 for k in floor}
for r in pool:
    cs = cats(r)
    if any(count[c] < floor[c] for c in cs):
        picked.append(r)
        for c in cs: count[c] += 1
    if len(picked) >= 300: break
for r in pool:
    if len(picked) >= 300: break
    if r not in picked: picked.append(r); 
for r in picked:
    for c in cats(r): count[c] = count.get(c, 0)
final = {}
for r in picked:
    for c in cats(r): final[c] = final.get(c, 0) + 1
sys.stderr.write(f"picked {len(picked)}  per-category: {final}\n")
sz = sum(int(r['num_faces']) for r in picked) * 50 / 1e6
sys.stderr.write(f"approx total MB: {sz:.0f}; max faces {max(int(r['num_faces']) for r in picked)}\n")
for r in picked: print(r['file_id'], ','.join(cats(r)), r['num_faces'])
