import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
const src = readFileSync('qr-encoder.js','utf8');
const root = {};
new Function('globalThis','module', src).call(root, root, undefined);
const QR = root.PCQR;
const cases=[
 'HELLO',
 'https://www.punchclock.ca/?kiosk=bc8372da-6aed-4de6-acf0-b97224ed8bcc',
 'https://www.punchclock.ca/?kiosk=46b8b88f-78ba-4625-bd1b-e997b1c383d1',
 'https://www.punchclock.ca/?kiosk=00000000-0000-0000-0000-000000000000&x=padding-to-push-the-version-up-a-fair-bit-further',
 'a', 'Café Rivière — été 2026 ✓'
];
let pass=0;
for(const text of cases){
  let m; try{ m=QR.encode(text);}catch(e){ console.log('FAIL(throw)',e.message,JSON.stringify(text.slice(0,30))); continue; }
  const size=m.length, scale=4, quiet=4, dim=(size+quiet*2)*scale;
  const data=new Uint8ClampedArray(dim*dim*4).fill(255);
  for(let r=0;r<size;r++)for(let c=0;c<size;c++){
    if(!m[r][c])continue;
    for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
      const y=(r+quiet)*scale+dy,x=(c+quiet)*scale+dx,i=(y*dim+x)*4;
      data[i]=data[i+1]=data[i+2]=0;
    }
  }
  const out=jsQR(data,dim,dim);
  const ok=!!out && out.data===text;
  if(ok)pass++;
  console.log((ok?'PASS':'FAIL'), (size+'x'+size).padEnd(7), JSON.stringify(text.slice(0,48)), ok?'':('-> '+JSON.stringify(out&&out.data)));
}
console.log(pass+'/'+cases.length+' decoded');
