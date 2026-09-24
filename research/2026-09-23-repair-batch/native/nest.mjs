// For each file: find closed components (no boundary edges) with negative signed volume whose bbox
// lies inside another closed positive-volume component's bbox => an inward-facing cavity shell that
// fixNormals would flip into a solid.
import { readFileSync } from "node:fs";
function parseStl(buf){ const n=buf.readUInt32LE(80); const tris=[]; if(buf.length===84+n*50){for(let i=0,o=84;i<n;i++,o+=50){const f=j=>buf.readFloatLE(o+12+j*4); tris.push([[f(0),f(1),f(2)],[f(3),f(4),f(5)],[f(6),f(7),f(8)]]);}} else {const txt=buf.toString("latin1"); const re=/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m,cur=[]; while((m=re.exec(txt))){cur.push([+m[1],+m[2],+m[3]]); if(cur.length===3){tris.push(cur);cur=[];}}} return tris; }
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2], cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
let filesWithCavity = 0, total = 0;
for (const f of process.argv.slice(2)) {
  const tris=parseStl(readFileSync(f)); const vid=new Map(), pos=[]; const faces=[];
  const id=p=>{const k=p.join(","); let i=vid.get(k); if(i===undefined){i=vid.size; vid.set(k,i); pos.push(p);} return i;};
  for(const t of tris){const a=id(t[0]),b=id(t[1]),c=id(t[2]); if(a===b||b===c||a===c) continue; faces.push([a,b,c]);}
  const und=new Map(); const uk=(a,b)=>a<b?a+"_"+b:b+"_"+a;
  faces.forEach((fc,fi)=>{for(let i=0;i<3;i++){const u=uk(fc[i],fc[(i+1)%3]); let l=und.get(u); if(!l){l=[]; und.set(u,l);} l.push(fi);}});
  // union-find by shared edge
  const par=new Int32Array(faces.length); for(let i=0;i<faces.length;i++) par[i]=i; const find=x=>{while(par[x]!==x){par[x]=par[par[x]]; x=par[x];} return x;};
  for(const fs of und.values()) for(let i=1;i<fs.length;i++){const a=find(fs[0]),b=find(fs[i]); if(a!==b) par[a]=b;}
  const comp=new Map(); faces.forEach((fc,fi)=>{const r=find(fi); let c=comp.get(r); if(!c){c={faces:0,vol:0,b:0,min:[1e30,1e30,1e30],max:[-1e30,-1e30,-1e30]}; comp.set(r,c);} c.faces++; const [a,b,d]=fc.map(i=>pos[i]); c.vol+=dot(a,cross(b,d))/6; for(const p of [a,b,d]) for(let k=0;k<3;k++){if(p[k]<c.min[k])c.min[k]=p[k]; if(p[k]>c.max[k])c.max[k]=p[k];}});
  for(const [u,fs] of und) if(fs.length===1) comp.get(find(fs[0])).b++;
  const cs=[...comp.values()]; const closedPos=cs.filter(c=>c.b===0&&c.vol>0);
  const cav=cs.filter(c=>c.b===0&&c.vol<0&&closedPos.some(o=>o!==c&&c.min.every((v,k)=>v>=o.min[k]-1e-6)&&c.max.every((v,k)=>v<=o.max[k]+1e-6)));
  const negClosed=cs.filter(c=>c.b===0&&c.vol<0).length;
  total++; if(cav.length) filesWithCavity++;
  console.log(`${f.split("/").pop()} comps=${cs.length} closedNeg=${negClosed} nestedCavities=${cav.length}${cav.length?"  <<< cavity volume "+cav.map(c=>(-c.vol).toFixed(0)).join(","):""}`);
}
console.log(`files with nested inward-facing closed shells: ${filesWithCavity}/${total}`);
