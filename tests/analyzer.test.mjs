import * as A from '../analyzer.js';
const b64=s=>Buffer.from(s).toString('base64url');
const mk=(id,from,subject,html,extra=[])=>({id,labelIds:['SPAM'],snippet:'',payload:{mimeType:'text/html',headers:[{name:'From',value:from},{name:'Subject',value:subject},{name:'Authentication-Results',value:'mx.google.com; spf=pass; dmarc=fail'},...extra],body:{data:b64(html)}}});
const walmart=mk('w1','#Wɑlmɑrt* <info@mGfiZgHn5QPSDJMx2f.com>','soaresden; You have received a payment 100$__________pg',
 '<span>Y<span>o<span>u w<span>o<span>n a $100 Walmart Gift Card</span></span></span></span></span><br>CLAIM YOUR PRIZE TODAY<br>Act quickly, your time to participate has almost expired.<p>If you wish to unsubscribe, please click here</p>');
const dhl=mk('d1','DHL <noreply@dhl-suivi-colis.com>','⚠️ Dernier rappel : votre colis est en attente de récupération!','<p>Votre colis n° 4455 est bloqué au centre de tri. Payez les frais de douane.</p>');
const cloud=mk('c1','Cloud_Storage_Team <x8k2j@qwrtzpxk9.net>','Storage may be filling up – Get more space to avoid losing files','<p>Your cloud storage is almost full</p>');
for (const m of [walmart,dhl,cloud]) { console.log('---',A.summary(m).subject); for (const c of A.candidatesFor(m,'soaresden@gmail.com')) console.log(' ',c.type,'|',A.q(c),'|',JSON.stringify(A.filterCriteria(c))); }
const g=A.greedyCover([{cand:{type:'subject',value:'a b c'},covers:new Set(['1','2'])},{cand:{type:'from',value:'@x.com'},covers:new Set(['2','3'])},{cand:{type:'query',value:'z z z'},covers:new Set(['3'])}],['1','2','3','4']);
console.log('cover:',g.chosen.map(c=>c.cand.value+':'+[...c.covers]),'uncovered',g.uncovered);
