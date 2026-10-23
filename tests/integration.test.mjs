const b64=s=>Buffer.from(s).toString('base64url');
const msg=(id,labels,from,subject,html)=>({id,labelIds:labels,snippet:'',payload:{mimeType:'text/html',headers:[{name:'From',value:from},{name:'Subject',value:subject}],body:{data:b64(html)}}});
const store=[
 msg('w1',['SPAM'],'#Wɑlmɑrt* <info@mgfizghn5qpsdjmx2f.com>','soaresden; You have received a payment 100$___pg','<p>Y<span>ou won</span></p><p>CLAIM YOUR PRIZE TODAY</p>'),
 msg('w2',['SPAM'],'#Wɑlmɑrt* <info@zzkq8x7pq.com>','soaresden; You have received a payment 750$___xx','<p>other</p>'),
 msg('d1',['SPAM'],'DHL <noreply@dhl-suivi-colis.com>','Dernier rappel : votre colis est en attente de récupération','<p>Payez les frais de douane maintenant</p>'),
 msg('k1',['SPAM','L_CACA'],'X <a@b.com>','déjà traité','<p>x</p>'),
 msg('n1',['INBOX'],'Vraie Poste <info@laposte.fr>','Votre colis est en attente de récupération au bureau','<p>vrai</p>'),
 msg('u1',['SPAM'],'Bob <qx9z2kk8p@gmail.com>','hi','<p>ok</p>'),
];
const text=m=>Buffer.from(m.payload.body.data,'base64url').toString().replace(/<[^>]+>/g,' ');
const H=(m,n)=>m.payload.headers.find(h=>h.name===n).value;
function match(m,qs){
  if(qs==='in:spam') return m.labelIds.includes('SPAM');
  let r;
  if(r=qs.match(/^subject:"(.*)"$/)) return H(m,'Subject').toLowerCase().includes(r[1].toLowerCase());
  if(r=qs.match(/^from:\((.*)\)$/)) return H(m,'From').toLowerCase().includes(r[1].replace(/"/g,'').toLowerCase());
  if(r=qs.match(/^"(.*)"$/)) return text(m).toLowerCase().includes(r[1].toLowerCase());
  return false;
}
const calls=[];
globalThis.fetch=async(url,o={})=>{
  const u=new URL(url); const p=u.pathname.replace('/gmail/v1/users/me/',''); const method=o.method||'GET';
  calls.push(method+' '+p+(u.searchParams.get('q')?' q='+u.searchParams.get('q'):''));
  const J=(d,s=200)=>({ok:s<300,status:s,json:async()=>d,text:async()=>JSON.stringify(d)});
  if(p==='profile') return J({emailAddress:'soaresden@gmail.com'});
  if(p==='labels'&&method==='GET') return J({labels:[{id:'L_CACA',name:'###CACA###'}]});
  if(p==='messages'){ const q=u.searchParams.get('q'); const inc=u.searchParams.get('includeSpamTrash')==='true';
    return J({messages:store.filter(m=>(inc||!m.labelIds.some(l=>l==='SPAM'||l==='TRASH'))&&match(m,q)).map(m=>({id:m.id}))}); }
  let r;
  if(r=p.match(/^messages\/(\w+)$/)) return J(store.find(m=>m.id===r[1]));
  if(r=p.match(/^messages\/(\w+)\/trash$/)){ const m=store.find(m=>m.id===r[1]); m.labelIds=['TRASH']; return J({}); }
  if(p==='settings/filters') return J({id:'f',...JSON.parse(o.body)});
  return J({error:'?'},404);
};
let onConnect;
globalThis.chrome={identity:{getAuthToken:async()=>({token:'t'}),removeCachedAuthToken:async()=>{}},
 storage:{sync:{get:async d=>d},local:{get:async()=>({})}},
 runtime:{onConnect:{addListener:f=>onConnect=f}},action:{onClicked:{addListener(){}}},tabs:{}};
await import('../background.js');
const out=[]; let handler;
const port={name:'spam',postMessage:m=>out.push(m),onMessage:{addListener:f=>handler=f}};
onConnect(port);
await handler({cmd:'analyze'}); await new Promise(r=>setTimeout(r,50));
const prop=out.find(m=>m.type==='proposals'); if(!prop) {console.log(out);process.exit(1);}
console.log('settings key leaked?', 'anthropicKey' in prop.settings);
console.log(JSON.stringify(prop.data,(k,v)=>k==='covers'?v.map(c=>c.id):v,1));
await handler({cmd:'apply',proposals:prop.data.proposals.map(p=>({cand:p.cand,edited:false,coverIds:p.coverIds})),options:{}});
await new Promise(r=>setTimeout(r,50));
console.log(JSON.stringify(out.find(m=>m.type==='applied')));
console.log(calls.filter(c=>/filters|trash/.test(c)));
console.log('n1 still inbox:',store.find(m=>m.id==='n1').labelIds, 'u1:',store.find(m=>m.id==='u1').labelIds);
