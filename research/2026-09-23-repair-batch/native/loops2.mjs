import { readFileSync } from "node:fs";
function parseStl(buf){ const n=buf.readUInt32LE(80); const tris=[]; if(buf.length===84+n*50){for(let i=0,o=84;i<n;i++,o+=50){const f=j=>buf.readFloatLE(o+12+j*4); tris.push([[f(0),f(1),f(2)],[f(3),f(4),f(5)],[f(6),f(7),f(8)]]);}} else {const txt=buf.toString("latin1"); const re=/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m,cur=[]; while((m=re.exec(txt))){cur.push([+m[1],+m[2],+m[3]]); if(cur.length===3){tris.push(cur);cur=[];}}} return tris; }
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]], dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2], len=a=>Math.sqrt(dot(a,a));
for (const f of process.argv.slice(2)) {
  const tris=parseStl(readFileSync(f)); const vid=new Map(), pos=[]; const faces=[];
  const id=p=>{const k=p.join(","); let i=vid.get(k); if(i===undefined){i=vid.size; vid.set(k,i); pos.push(p);} return i;};
  for(const t of tris){const a=id(t[0]),b=id(t[1]),c=id(t[2]); if(a===b||b===c||a===c) continue; faces.push([a,b,c]);}
  const und=new Map(); const uk=(a,b)=>a<b?a+"_"+b:b+"_"+a;
  faces.forEach((fc,fi)=>{for(let i=0;i<3;i++){const u=uk(fc[i],fc[(i+1)%3]); let l=und.get(u); if(!l){l=[];und.set(u,l);} l.push(fi);}});
  const par=new Int32Array(faces.length); for(let i=0;i<faces.length;i++) par[i]=i; const find=x=>{while(par[x]!==x){par[x]=par[par[x]]; x=par[x];} return x;};
  for(const fs of und.values()) for(let i=1;i<fs.length;i++){const a=find(fs[0]),b=find(fs[i]); if(a!==b) par[a]=b;}
  const compOfV=new Map(); faces.forEach((fc,fi)=>{const r=find(fi); for(const v of fc){ if(!compOfV.has(v)) compOfV.set(v,new Set()); compOfV.get(v).add(r);} });
  const compVerts=new Map(); for(const [v,cs] of compOfV) for(const c of cs){ if(!compVerts.has(c)) compVerts.set(c,[]); compVerts.get(c).push(v);} 
  const compB=new Map(); for(const [u,fs] of und) if(fs.length===1){const c=find(fs[0]); compB.set(c,(compB.get(c)||0)+1);} 
  const next=new Map(); faces.forEach(fc=>{for(let i=0;i<3;i++){const a=fc[i],b=fc[(i+1)%3]; if(und.get(uk(a,b)).length===1) next.set(b,a);}});
  const mn=[1e30,1e30,1e30],mx=[-1e30,-1e30,-1e30]; for(const p of pos) for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],p[k]); mx[k]=Math.max(mx[k],p[k]);} const diag=len(sub(mx,mn));
  console.log(`\n=== ${f.split("/").pop()} faces=${faces.length} comps=${compVerts.size} diag=${diag.toFixed(1)}`);
  const seen=new Set();
  for(const [s] of next){ if(seen.has(s)) continue; const loop=[]; let v=s,g=0; while(!seen.has(v)&&g++<1e6){seen.add(v); loop.push(v); v=next.get(v); if(v===undefined) break;}
    const P=loop.map(i=>pos[i]); let dia=0; for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++) dia=Math.max(dia,len(sub(P[i],P[j])));
    if (dia < 0.6*diag) continue; // only loops the outer-edge rule would skip
    const c=P.reduce((a,p)=>[a[0]+p[0],a[1]+p[1],a[2]+p[2]],[0,0,0]).map(x=>x/P.length);
    let n=[0,0,0]; for(let i=0;i<P.length;i++){const a=P[i],b=P[(i+1)%P.length]; n[0]+=(a[1]-b[1])*(a[2]+b[2]); n[1]+=(a[2]-b[2])*(a[0]+b[0]); n[2]+=(a[0]-b[0])*(a[1]+b[1]);} const nl=len(n); n=n.map(x=>x/(nl||1));
    const comp=[...compOfV.get(loop[0])][0]; const cv=compVerts.get(comp); let dp=0,dm=0; for(const vi of cv){const off=dot(sub(pos[vi],c),n); if(off>dp)dp=off; if(off<dm)dm=off;}
    const bEdges=compB.get(comp)||0;
    console.log(`  loop edges=${P.length} diameter=${(100*dia/diag).toFixed(0)}% of diag | component: verts=${cv.length} boundaryEdges=${bEdges}${bEdges===P.length?" (this loop is its only opening -> filling closes it)":""} | depth/diameter: +${(dp/dia).toFixed(2)} / -${(-dm/dia).toFixed(2)}`);
  }
}
