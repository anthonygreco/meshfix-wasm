// For every corpus STL: weld exact-duplicate positions (as the reader does), then classify
// each edge by directed use count. An edge used twice in the SAME direction is a winding
// flip (fixable by re-orienting); an edge used 3+ times is genuinely non-manifold.
// Then simulate a consistent-orientation pass (BFS, flipping faces across 2-use edges)
// and count how many faces would still conflict.
import { readFileSync, readdirSync } from "node:fs";
const DIR = process.env.HOME + "/.vaxis-backups/models";
function parseStl(buf) {
  const n = buf.readUInt32LE(80); const tris = [];
  if (buf.length === 84 + n * 50) { for (let i=0,o=84;i<n;i++,o+=50){ const f=j=>buf.readFloatLE(o+12+j*4); tris.push([[f(0),f(1),f(2)],[f(3),f(4),f(5)],[f(6),f(7),f(8)]]); } }
  else { const txt=buf.toString("latin1"); const re=/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m,cur=[]; while((m=re.exec(txt))){cur.push([+m[1],+m[2],+m[3]]); if(cur.length===3){tris.push(cur);cur=[];}} }
  return tris;
}
const only = process.argv[2];
for (const f of readdirSync(DIR).filter(f=>f.endsWith(".stl")).sort()) {
  if (only && f !== only) continue;
  const tris = parseStl(readFileSync(DIR+"/"+f));
  const vid = new Map(); const faces = [];
  const id = p => { const k = p.join(","); let i = vid.get(k); if (i===undefined){ i=vid.size; vid.set(k,i);} return i; };
  for (const t of tris) { const a=id(t[0]),b=id(t[1]),c=id(t[2]); if (a===b||b===c||a===c) continue; faces.push([a,b,c]); }
  // directed edge use counts and undirected adjacency
  const dir = new Map(), und = new Map();
  const dk=(a,b)=>a+"_"+b, uk=(a,b)=>a<b?a+"_"+b:b+"_"+a;
  faces.forEach((fc,fi)=>{ for(let i=0;i<3;i++){ const a=fc[i],b=fc[(i+1)%3]; dir.set(dk(a,b),(dir.get(dk(a,b))||0)+1); const u=uk(a,b); if(!und.has(u)) und.set(u,[]); und.get(u).push(fi);} });
  let flipEdges=0, nmEdges=0, boundary=0, ok=0;
  for (const [u,fs] of und) { if (fs.length===1) boundary++; else if (fs.length>2) nmEdges++; else { const [a,b]=u.split("_"); if ((dir.get(dk(a,b))||0)===2 || (dir.get(dk(b,a))||0)===2) flipEdges++; else ok++; } }
  // BFS orientation fix across 2-use edges
  const orient = new Int8Array(faces.length); // 0 unknown, 1 keep, -1 flip
  const adj = faces.map(()=>[]);
  for (const [u,fs] of und) if (fs.length===2) { adj[fs[0]].push(fs[1]); adj[fs[1]].push(fs[0]); }
  const dirOf = (fc,a,b)=>{ for(let i=0;i<3;i++){ if(fc[i]===a&&fc[(i+1)%3]===b) return 1; if(fc[i]===b&&fc[(i+1)%3]===a) return -1;} return 0; };
  let flippedFaces=0, conflicts=0, comps=0;
  for (let s=0;s<faces.length;s++){ if(orient[s]) continue; comps++; orient[s]=1; const q=[s];
    while(q.length){ const fi=q.pop(); for(const nb of adj[fi]){ // shared edge
        const shared=faces[fi].filter(v=>faces[nb].includes(v)); if(shared.length<2) continue; const [a,b]=shared;
        const want = -dirOf(faces[fi],a,b)*orient[fi]; // neighbour must traverse opposite
        const has = dirOf(faces[nb],a,b);
        const need = has===want ? 1 : -1;
        if(!orient[nb]){ orient[nb]=need; if(need<0) flippedFaces++; q.push(nb);} else if(orient[nb]!==need) conflicts++; } } }
  console.log(`${f.padEnd(40)} faces=${faces.length} edges: ok=${ok} boundary=${boundary} flipPair=${flipEdges} 3+faces=${nmEdges} | reorient: comps=${comps} facesFlipped=${flippedFaces} conflicts=${conflicts}`);
}
