// Intégration : service worker complet face à une fausse API Gmail (aucun accès réseau).
import assert from 'node:assert/strict';

const b64 = s => Buffer.from(s).toString('base64url');
const msg = (id, labels, from, subject, html, threadId = 't_' + id) => ({ id, threadId, labelIds: labels, snippet: '', internalDate: '1792771200000',
  payload: { mimeType: 'text/html', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'To', value: 'soaresden@gmail.com' }], body: { data: b64(html) } } });
const store = [
  msg('w1', ['SPAM'], '#Wɑlmɑrt* <info@mgfizghn5qpsdjmx2f.com>', 'soaresden; You have received a payment 100$___pg', '<p>Y<span>ou won</span></p><p>CLAIM YOUR PRIZE TODAY</p><div style="display:none">' + 'filler '.repeat(200) + '</div>'),
  msg('w2', ['SPAM'], '#Wɑlmɑrt* <info@zzkq8x7pq.com>', 'soaresden; You have received a payment 750$___xx', '<p>other</p>'),
  msg('d1', ['SPAM'], 'DHL <noreply@dhl-suivi-colis.com>', 'Dernier rappel : votre colis est en attente de récupération', '<p>Payez les frais de douane maintenant</p>'),
  msg('k1', ['SPAM', 'L_CACA'], 'X <a@b.com>', 'déjà traité', '<p>x</p>'),
  msg('n1', ['INBOX'], 'Vraie Poste <info@laposte.fr>', 'Votre colis est en attente de récupération au bureau', '<p>vrai</p>'),
  msg('u1', ['SPAM'], 'Bob <qx9z2kk8p@gmail.com>', 'hi', '<p>ok</p>'),
  msg('c1', ['INBOX', 'L_CACA'], 'Promo <promo@crypto-gains.io>', 'Crypto gains', '<p>Get crypto gains now, big dick pills</p>'),
  msg('c2', ['INBOX'], 'Ami <ami@laposte.net>', 'Moby Dick', '<p>Tu as lu Moby Dick ?</p>'),
  msg('p1', ['INBOX'], 'U.S. Disbursement Office <ICU4Fh@icu4fh.pastintel.org.uk>', 'Household Inflation Relief Adjustment notice', '<p>Your family is among the beneficiaries of a direct cash credit</p>')
];
let filtersStore = [
  { id: 'f1', criteria: { query: '"crypto gains"' }, action: { addLabelIds: ['L_CACA'], removeLabelIds: ['INBOX'] } },
  { id: 'f2', criteria: { query: 'dick' }, action: { addLabelIds: ['L_CACA'], removeLabelIds: ['INBOX'] } },
  { id: 'f3', criteria: { query: '"big dick"' }, action: { addLabelIds: ['L_CACA'], removeLabelIds: ['INBOX'] } },
  { id: 'f4', criteria: { query: '"crypto gains"' }, action: { addLabelIds: ['L_CACA'], removeLabelIds: ['INBOX'] } }
];
const labels = [{ id: 'L_CACA', name: '###CACA###' }];
const text = m => Buffer.from(m.payload.body.data, 'base64url').toString().replace(/<[^>]+>/g, ' ');
const H = (m, n) => m.payload.headers.find(h => h.name === n).value;
function match(m, qs) {
  if (qs === 'in:spam') return m.labelIds.includes('SPAM');
  let r;
  if ((r = qs.match(/^subject:"(.*)"$/))) return H(m, 'Subject').toLowerCase().includes(r[1].toLowerCase());
  if ((r = qs.match(/^from:\((.*)\)$/))) return H(m, 'From').toLowerCase().includes(r[1].replace(/"/g, '').toLowerCase());
  if ((r = qs.match(/^\(?"?([^"()]*)"?\)?$/))) return new RegExp('\\b' + r[1] + '\\b', 'i').test(text(m) + ' ' + H(m, 'Subject'));
  return false;
}
const calls = [];
let nextId = 100;
globalThis.fetch = async (url, o = {}) => {
  const u = new URL(url); const p = u.pathname.replace('/gmail/v1/users/me/', ''); const method = o.method || 'GET';
  calls.push(method + ' ' + p + (u.searchParams.get('q') ? ' q=' + u.searchParams.get('q') : ''));
  const J = (d, s = 200) => ({ ok: s < 300, status: s, json: async () => d, text: async () => JSON.stringify(d) });
  if (p === 'profile') return J({ emailAddress: 'soaresden@gmail.com' });
  if (p === 'labels' && method === 'GET') return J({ labels });
  if (p === 'labels' && method === 'POST') { const l = { id: 'L_' + nextId++, name: JSON.parse(o.body).name }; labels.push(l); return J(l); }
  if (p === 'messages' && u.searchParams.get('labelIds')) {
    const l = u.searchParams.get('labelIds');
    return J({ messages: store.filter(m => m.labelIds.includes(l)).map(m => ({ id: m.id })) });
  }
  if (p === 'messages') {
    const q = u.searchParams.get('q'); const inc = u.searchParams.get('includeSpamTrash') === 'true';
    return J({ messages: store.filter(m => (inc || !m.labelIds.some(l => l === 'SPAM' || l === 'TRASH')) && match(m, q)).map(m => ({ id: m.id })) });
  }
  let r;
  if (p === 'messages/batchModify') { const b = JSON.parse(o.body); store.filter(m => b.ids.includes(m.id)).forEach(m => m.labelIds.push(...(b.addLabelIds || []))); return J({}); }
  if ((r = p.match(/^messages\/(\w+)$/))) return J(store.find(m => m.id === r[1]));
  if ((r = p.match(/^threads\/(\w+)$/))) return J({ id: r[1], messages: store.filter(m => m.threadId === r[1]) });
  if ((r = p.match(/^messages\/(\w+)\/trash$/))) { store.find(m => m.id === r[1]).labelIds = ['TRASH']; return J({}); }
  if (p === 'settings/filters' && method === 'GET') return J({ filter: filtersStore });
  if (p === 'settings/filters' && method === 'POST') { const f = { id: 'f' + nextId++, ...JSON.parse(o.body) }; filtersStore.push(f); return J(f); }
  if ((r = p.match(/^settings\/filters\/(\w+)$/)) && method === 'DELETE') {
    if (!filtersStore.some(f => f.id === r[1])) return J({ error: 'not found' }, 404);
    filtersStore = filtersStore.filter(f => f.id !== r[1]); return { ok: true, status: 204, json: async () => null, text: async () => '' };
  }
  return J({ error: '?' }, 404);
};

let onConnect;
const scopes = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.settings.basic'];
const session = {}, local = {}; let auths = 0;
const area = o => ({ get: async k => typeof k === 'string' ? { [k]: o[k] } : { ...k, ...o }, set: async v => Object.assign(o, v), remove: async k => { delete o[k]; } });
globalThis.chrome = {
  identity: { getRedirectURL: () => 'https://x.chromiumapp.org/',
    launchWebAuthFlow: async () => (auths++, 'https://x.chromiumapp.org/#access_token=t&expires_in=3599&scope=' + encodeURIComponent(scopes.join(' '))) },
  storage: { sync: { get: async d => d }, local: area(local), session: area(session) },
  runtime: { onConnect: { addListener: f => onConnect = f }, onMessage: { addListener() {} }, getManifest: () => ({ oauth2: { client_id: 'c', scopes } }) },
  action: { onClicked: { addListener() {} } }, tabs: {}
};
await import('../background.js');

// petit client du protocole { rid, cmd, args }
let handler; const pending = new Map(); let rid = 0;
onConnect({ name: 'gfm', postMessage: m => { if (m.type !== 'progress') pending.get(m.rid)(m); }, onMessage: { addListener: f => handler = f } });
const call = (cmd, args) => new Promise((res, rej) => { const id = ++rid; pending.set(id, m => m.type === 'error' ? rej(new Error(m.text)) : res(m.data)); handler({ rid: id, cmd, args }); });
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('✔', name); };

await test('dossier Spam : dangerosité, aperçu et filtres proposés', async () => {
  const d = await call('spam:analyze');
  assert.equal(d.skipped, 1);
  assert.deepEqual(Object.keys(d.mails).sort(), ['d1', 'u1', 'w1', 'w2']);
  assert.ok(d.mails.w1.danger.score > d.mails.d1.danger.score, 'le Walmart avec texte caché est plus dangereux');
  assert.match(d.mails.w1.html, /CLAIM YOUR PRIZE/);
  // que des mots, jamais l'expéditeur ; « votre colis est en attente de récupération » est écarté (vrai mail de La Poste).
  // À égalité de spams attrapés, la phrase la plus courte d'abord ; les phrases entières restent proposées.
  assert.deepEqual(d.proposals.map(p => p.alts[0].query), ['subject:"received a payment"', '"frais de douane"']);
  assert.ok(d.proposals[0].alts.some(a => a.cand.value === 'You have received a payment'));
  assert.ok(d.proposals[1].alts.some(a => a.cand.value === 'Payez les frais de douane maintenant'));
  assert.ok(d.proposals[1].alts.every(a => !/colis est en attente/.test(a.cand.value)));
  assert.equal(d.proposals[0].alts[0].total, 2);
  assert.deepEqual(d.uncovered, ['u1']);
  assert.ok(!('anthropicKey' in (d.settings || {})));
  const a = await call('spam:apply', { proposals: d.proposals.map(p => ({ cand: p.alts[0].cand, edited: false, coverIds: p.coverIds })), options: {} });
  assert.equal(a.trashed, 3);
  assert.equal(store.find(m => m.id === 'n1').labelIds[0], 'INBOX');
});

await test('le cache des filtres apprend les filtres créés depuis le dossier Spam', async () => {
  const s = await call('filters:status');
  assert.equal(s.count, 6);                         // 4 lus + 2 créés
  assert.equal(filtersStore.length, 6);
});

await test('mail ouvert : quels filtres, pourquoi, dangerosité', async () => {
  const d = await call('mail:analyze', { threadId: 't_c1' });
  assert.equal(d.mail.subject, 'Crypto gains');
  assert.deepEqual(d.mail.labels, ['###CACA###']);
  assert.deepEqual(d.matches.map(m => m.rule.id).sort(), ['f1', 'f2', 'f3', 'f4']);
  assert.match(d.matches.find(m => m.rule.id === 'f3').preview, /⟦big dick⟧/);
  assert.deepEqual(d.unexplained, []);
  assert.equal(typeof d.scam.score, 'number');
  assert.equal(d.defaultLabel, '###CACA###');
  const byMsg = await call('mail:analyze', { messageId: 'c1' });   // repli : id de message seulement
  assert.equal(byMsg.mail.threadId, 't_c1');
});

await test('mail ouvert : filtres proposés, le mail lui-même ne compte pas comme vrai mail', async () => {
  const d = await call('mail:propose', { threadId: 't_p1' });
  assert.ok(d.proposals.length > 0, 'un spam arrivé dans la boîte de réception a des propositions');
  assert.ok(d.proposals.some(p => p.query.startsWith('subject:"') && /Inflation Relief/.test(p.query)));
  assert.ok(d.proposals.every(p => p.total === 1 && !/pastintel|Disbursement Office/.test(p.query)), 'que des mots, jamais l’expéditeur');
  assert.equal(d.claude, false);
  assert.equal(d.labelName, '###CACA###');
});

await test('créer, refuser le doublon, supprimer', async () => {
  const c = await call('filter:create', { field: 'query', value: 'moby dick', target: 'Livres', archive: false });
  assert.deepEqual(c.rule.actions, ['🏷️ Livres']);
  await assert.rejects(call('filter:create', { field: 'query', value: 'moby dick', target: 'Livres' }), /existe déjà/);
  const del = await call('filter:delete', { id: c.rule.id });
  assert.equal(del.status.count, 6);
});

await test('simplification : doublons, « dick » trop large, application', async () => {
  const p = await call('simplify:plan');
  assert.deepEqual(p.duplicates.map(d => d.remove.map(r => r.id)), [['f4']]);
  assert.equal(p.overlaps[0].broad.id, 'f2');
  assert.deepEqual(p.overlaps[0].narrows.map(r => r.id), ['f3']);
  const t = await call('simplify:testRule', { id: 'f2' });
  assert.equal(t.count, 1);                         // « Moby Dick » de l'ami : dick est trop large
  assert.equal(t.samples[0].subject, 'Moby Dick');
  const b = await call('filters:backup');
  assert.equal((b.xml.match(/<entry>/g) || []).length, 6);
  const r = await call('simplify:apply', { ops: [{ type: 'delete', id: 'f4' }, { type: 'delete', id: 'f2' }] });
  assert.equal(r.ok, 2);
  assert.deepEqual(filtersStore.map(f => f.id).sort(), ['f1', 'f100', 'f101', 'f3'].sort());
  assert.equal(r.status.count, 4);
  assert.equal(local.gfmJob, undefined);
});

await test('tendances : historique gardé, spams lus une seule fois, sources', async () => {
  const before = calls.length;
  const a = await call('stats:run', { months: 12 });
  // w1, w2, d1 : mis à la corbeille par l'onglet Spams, mémorisés avant ; u1 (Spam) ; k1 et c1 (###CACA###)
  assert.equal(a.total, 6);
  assert.equal(a.fresh, 3);
  assert.deepEqual(a.sources.map(s => [s.name, s.count]), [['Spam', 5], ['###CACA###', 2]]);   // k1 est dans les deux
  store.splice(store.findIndex(m => m.id === 'u1'), 1);   // Gmail vide le Spam au bout de 30 jours
  const b = await call('stats:run', { months: 12 });
  assert.equal(b.fresh, 0);
  assert.equal(b.total, 6, 'un spam supprimé par Gmail reste dans l’historique');
  assert.equal(calls.slice(before).filter(c => /^GET messages\/\w+$/.test(c)).length, 3, 'en-têtes lus une seule fois');
  const onlyCaca = await call('stats:run', { months: 0, source: 'L_CACA', fetch: false });
  assert.equal(onlyCaca.total, 2);
  assert.equal(onlyCaca.unit, 'week');
});

await test('« J’ai traité » : libellé ###CACA### sur les spams de la carte', async () => {
  const r = await call('spam:done', { ids: ['c2'] });
  assert.equal(r.count, 1);
  assert.equal(r.labelName, '###CACA###');
  assert.ok(store.find(m => m.id === 'c2').labelIds.includes('L_CACA'));
});

assert.equal(auths, 1, 'une seule fenêtre de connexion Google');
console.log(`${n} tests d'intégration OK`);
