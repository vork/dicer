import fs from 'node:fs'; import path from 'node:path'; import sharp from 'sharp';
const [die, setId, rot, ...idxs] = process.argv.slice(2);
const faces = JSON.parse(fs.readFileSync('public/dice/faces.json','utf8'))[die].faces;
const sets = JSON.parse(fs.readFileSync('public/dice/sets.json','utf8'));
const TEX = path.join('public/dice', sets.find(s=>s.id===setId).baseColor);
const {width,height} = await sharp(TEX).metadata();
const TILE=340, LABEL=30; const cols=Math.min(4, idxs.length); const rows=Math.ceil(idxs.length/cols);
const comps=[];
for (let k=0;k<idxs.length;k++){
  const i=+idxs[k]; const f=faces[i];
  const pu=(f.uvMax[0]-f.uvMin[0])*0.02, pv=(f.uvMax[1]-f.uvMin[1])*0.02;
  const l=Math.max(0,Math.round((f.uvMin[0]-pu)*width)), t=Math.max(0,Math.round((f.uvMin[1]-pv)*height));
  const r=Math.min(width,Math.round((f.uvMax[0]+pu)*width)), b=Math.min(height,Math.round((f.uvMax[1]+pv)*height));
  const crop=await sharp(TEX).extract({left:l,top:t,width:Math.max(2,r-l),height:Math.max(2,b-t)})
    .rotate(+rot,{background:'#101014'}).resize(TILE,TILE,{fit:'contain',background:'#101014'})
    .normalise().png().toBuffer();
  const c=k%cols, rw=Math.floor(k/cols);
  comps.push({input:crop,left:c*TILE,top:rw*(TILE+LABEL)+LABEL});
  comps.push({input:Buffer.from(`<svg width="${TILE}" height="${LABEL}"><rect width="${TILE}" height="${LABEL}" fill="#f5c542"/><text x="${TILE/2}" y="${LABEL-8}" font-family="monospace" font-size="20" font-weight="bold" fill="#101014" text-anchor="middle">face ${i}</text></svg>`),left:c*TILE,top:rw*(TILE+LABEL)});
}
const out=`.calibration/zoom-${die}-${rot}.png`;
await sharp({create:{width:cols*TILE,height:rows*(TILE+LABEL),channels:3,background:'#101014'}}).composite(comps).png().toFile(out);
console.log(out);
