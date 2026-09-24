// Component nesting + boundary-loop geometry from the raw STL (exact-weld, no face dropping).
import { readFileSync } from "node:fs";
const DIR = process.env.HOME + "/.vaxis-backups/models";
function parseStl(buf){ const n=buf.readUInt32LE(80); const tris=[]; if(buf.length===84+n*50){for(let i=0,o=84;i<n;i++,o+=50){const f=j=>buf.readFloatLE(o+12+j*4); tris.push([[f(0),f(1),f(2)],[f(3),f(4),f(5)],[f(6),f(7),f(8)]]);}} else {const txt=buf.toString("latin1"); const re=/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m,cur=[]; while((m=re.exec(txt))){cur.push([+m[1],+m[2],+m[3]]); if(cur.length===3){tris.push(cur);cur=[];}}} return tris; }
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]], dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2], cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]], len=a=>Math.sqrt(dot(a,a));
for (const f of process.argv.slice(2)) {
  const tris=parseStl(readFileSync(DIR+"/"+f)); const vid=new Map(), pos=[]; const faces=[];
  const id=p=>{const k=p.join(","); let i=vid.get(k); if(i===undefined){i=vid.size; vid.set(k,i); pos.push(p);} return i;};
  for(const t of tris){const a=id(t[0]),b=id(t[1]),c=id(t[2]); if(a===b||b===c||a===c) continue; faces.push([a,b,c]);}
  const und=new Map(); const uk=(a,b)=>a<b?a+"_"+b:b+"_"+a;
  faces.forEach((fc,fi)=>{for(let i=0;i<3;i++){const u=uk(fc[i],fc[(i+1)%3]); if(!und.has(u)) und.set(u,[]); und.get(u).push(fi);}});
  // components (by shared edge)
  const comp=new Int32Array(faces.length).fill(-1); const adj=faces.map(()=>[]); for(const fs of und.values()) for(const a of fs) for(const b of fs) if(a!==b) adj[a].push(b);
  let nc=0; for(let s=0;s<faces.length;s++){ if(comp[s]>=0) continue; const q=[s]; comp[s]=nc; while(q.length){const x=q.pop(); for(const y of adj[x]) if(comp[y]<0){comp[y]=nc; q.push(y);}} nc++; }
  const bb=Array.from({length:nc},()=>({min:[1e30,1e30,1e30],max:[-1e30,-1e30,-1e30],faces:0,vol:0,bEdges:0}));
  faces.forEach((fc,fi)=>{const c=bb[comp[fi]]; c.faces++; const [a,b,d]=fc.map(i=>pos[i]); c.vol+=dot(a,cross(b,d))/6; for(const p of [a,b,d]) for(let k=0;k<3;k++){c.min[k]=Math.min(c.min[k],p[k]); c.max[k]=Math.max(c.max[k],p[k]);}});
  for(const [u,fs] of und) if(fs.length===1) bb[comp[fs[0]]].bEdges++;
  console.log(`\n=== ${f}: ${faces.length} faces, ${nc} components`);
  bb.forEach((c,i)=>{ const inside=bb.findIndex((o,j)=>j!==i && c.min.every((v,k)=>v>=o.min[k]-1e-6) && c.max.every((v,k)=>v<=o.max[k]+1e-6)); console.log(`  comp${i}: faces=${c.faces} signedVol=${c.vol.toFixed(0)} boundaryEdges=${c.bEdges} bbox=[${c.min.map(v=>v.toFixed(1))}]..[${c.max.map(v=>v.toFixed(1))}]${inside>=0?"  NESTED inside comp"+inside:""}`); });
  // boundary loops: directed boundary halfedges (edge used once) → follow
  const next=new Map(); faces.forEach(fc=>{for(let i=0;i<3;i++){const a=fc[i],b=fc[(i+1)%3]; if(und.get(uk(a,b)).length===1) next.set(b,a);}}); // boundary halfedge reversed: from b to a
  const seen=new Set(); const mesh={min:[1e30,1e30,1e30],max:[-1e30,-1e30,-1e30]}; for(const p of pos) for(let k=0;k<3;k++){mesh.min[k]=Math.min(mesh.min[k],p[k]); mesh.max[k]=Math.max(mesh.max[k],p[k]);}
  const diag=len(sub(mesh.max,mesh.min));
  for(const [s] of next){ if(seen.has(s)) continue; const loop=[]; let v=s, guard=0; while(!seen.has(v)&&guard++<1e6){seen.add(v); loop.push(v); v=next.get(v); if(v===undefined) break;}
    const P=loop.map(i=>pos[i]); const c=P.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(x=>x/P.length);
    let n=[0,0,0]; for(let i=0;i<P.length;i++){const a=P[i],b=P[(i+1)%P.length]; n[0]+=(a[1]-b[1])*(a[2]+b[2]); n[1]+=(a[2]-b[2])*(a[0]+b[0]); n[2]+=(a[0]-b[0])*(a[1]+b[1]);} const nl=len(n); n=n.map(x=>x/(nl||1));
    let dia=0; for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++) dia=Math.max(dia,len(sub(P[i],P[j])));
    let maxDev=0, rs=[]; for(const p of P){const d=sub(p,c); const off=dot(d,n); maxDev=Math.max(maxDev,Math.abs(off)); rs.push(Math.sqrt(Math.max(0,dot(d,d)-off*off)));}
    const rm=rs.reduce((a,b)=>a+b,0)/rs.length, rv=Math.sqrt(rs.reduce((a,r)=>a+(r-rm)**2,0)/rs.length)/rm;
    // collinear runs: consecutive triples with ~zero area
    let collinear=0; for(let i=0;i<P.length;i++){const a=P[i],b=P[(i+1)%P.length],d=P[(i+2)%P.length]; const ar=len(cross(sub(b,a),sub(d,a)))/2; if(ar<1e-6*dia*dia) collinear++;}
    // depth of the whole mesh on each side of the loop plane (how far surface extends from the opening)
    let dPlus=0,dMinus=0; for(const p of pos){const off=dot(sub(p,c),n); if(off>dPlus) dPlus=off; if(off<dMinus) dMinus=off;}
    console.log(`  loop: edges=${P.length} diameter=${dia.toFixed(1)} (${(100*dia/diag).toFixed(0)}% of diag) planarDev=${(maxDev/dia).toFixed(3)} radiusVar=${rv.toFixed(3)} collinearTriples=${collinear} surfaceDepth +${dPlus.toFixed(1)}/${dMinus.toFixed(1)} centroid=[${c.map(x=>x.toFixed(1))}] n=[${n.map(x=>x.toFixed(2))}]`);
  }
}
