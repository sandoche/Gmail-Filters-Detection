// Tests du code porté de Gmail Filters Manager (moteur de requêtes, filtres du mail, indicateur spam, XML).
import assert from 'node:assert/strict';
import { parseGmailQuery_, evalQuery_ } from '../lib/gfm-query.js';
import { normalizeMailText_ } from '../lib/gfm-text.js';
import { buildIndexFromRaw_, exportXml_, findDuplicateGroups_, simplifyPlan_ } from '../lib/gfm-filters.js';
import { analyzeThread_, explainLabel_ } from '../lib/gfm-match.js';
import { analyzeScam_ } from '../lib/gfm-scam.js';
import { messageAdapter } from '../lib/gfm-message.js';
import { canonicalGmail, addressVariant, statRecord, aggregate } from '../lib/gfm-stats.js';

const b64 = s => Buffer.from(s).toString('base64url');
const msg = (id, headers, html, extra = {}) => messageAdapter({
  id, threadId: 't' + id, labelIds: ['INBOX'], sizeEstimate: 2000, internalDate: '1792771200000',
  payload: { mimeType: 'text/html', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: b64(html) } },
  ...extra
});
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('✔', name); };

/* ── moteur de requêtes ── */
const mailOf = (subject, text, from = 'x@y.com') => ({
  subject: normalizeMailText_(subject), fromText: normalizeMailText_(from), fromEmail: normalizeMailText_(from),
  toText: '', searchableText: normalizeMailText_(from + ' ' + subject + ' ' + text)
});
test('phrase exacte, mots entiers, accents et apostrophes', () => {
  const ast = parseGmailQuery_('"colis est bloqué"');
  assert.equal(evalQuery_(ast, mailOf('', 'Votre COLIS est   bloque au dépôt')).matched, true);
  assert.equal(evalQuery_(ast, mailOf('', 'colis estbloqué')).matched, false);
  assert.equal(evalQuery_(parseGmailQuery_('"l\'offre"'), mailOf('', 'l’offre du jour')).matched, true);
});
test('OR, {…}, exclusion et champs', () => {
  const m = mailOf('Promo Walmart', 'gift card', 'info@walmart-promo.com');
  assert.equal(evalQuery_(parseGmailQuery_('from:(walmart OR amazon) -unsubscribe'), m).matched, true);
  assert.equal(evalQuery_(parseGmailQuery_('{paypal amazon}'), m).matched, false);
  assert.equal(evalQuery_(parseGmailQuery_('subject:promo -"gift card"'), m).matched, false);
});

/* ── filtres du mail ── */
const raw = {
  labels: [{ id: 'L1', name: '###CACA###' }, { id: 'L2', name: 'Colis' }],
  filters: [
    { id: 'f1', criteria: { query: '"colis est bloqué"' }, action: { addLabelIds: ['L1'], removeLabelIds: ['INBOX'] } },
    { id: 'f2', criteria: { from: '@dhl-suivi.com' }, action: { addLabelIds: ['L2'] } },
    { id: 'f3', criteria: { query: '"rien à voir"' }, action: { addLabelIds: ['TRASH'] } },
    { id: 'f0', criteria: { query: '"colis est bloqué"' }, action: { addLabelIds: ['L1'], removeLabelIds: ['INBOX'] } },
    { id: 'f4', criteria: { query: '"investissements immobiliers garantis"' }, action: { addLabelIds: ['L1'] } }
  ]
};
const index = buildIndexFromRaw_(raw);
const dhl = msg('m1', { From: 'DHL <noreply@dhl-suivi.com>', To: 'moi@gmail.com', Subject: 'Livraison' },
  '<p>Votre colis est bloqué au centre de tri. Investissement immobilier garanti !</p>');
test('les bons filtres, avec la raison et l’extrait surligné', () => {
  const r = analyzeThread_(index, [dhl]);
  assert.deepEqual(r.matches.map(m => m.rule.id).sort(), ['f0', 'f1', 'f2']);
  const f1 = r.matches.find(m => m.rule.id === 'f1');
  assert.match(f1.reasons[0], /colis est bloqué/);
  assert.match(f1.preview, /⟦colis est bloqué⟧/);
  assert.deepEqual(f1.rule.actions, ['🏷️ ###CACA###', '📥 archiver']);
});
test('« pourquoi ce libellé ? » retrouve le filtre approchant', () => {
  const r = explainLabel_(index, [dhl], '###CACA###');
  assert.equal(r.candidates[0].rule.id, 'f4');
  assert.match(r.candidates[0].reason, /racine de mot/);
});
test('doublons', () => {
  const g = findDuplicateGroups_(index);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].map(r => r.id), ['f0', 'f1']);
});

/* ── sauvegarde et simplification ── */
test('sauvegarde XML au format Gmail', () => {
  const xml = exportXml_(index);
  assert.equal((xml.match(/<entry>/g) || []).length, 5);
  assert.match(xml, /name='hasTheWord' value='"colis est bloqué"'/);
  assert.match(xml, /name='label' value='###CACA###'/);
  assert.match(xml, /name='shouldArchive' value='true'/);
});
test('simplification : doublons, recoupements « dick » / « big dick », fusion', () => {
  const caca = { addLabelIds: ['L1'], removeLabelIds: ['INBOX'] };
  const plan = simplifyPlan_(buildIndexFromRaw_({ labels: raw.labels, filters: [
    { id: 'a1', criteria: { query: 'dick' }, action: caca },
    { id: 'a2', criteria: { query: '"big dick"' }, action: caca },
    { id: 'a3', criteria: { query: '"dick pills now"' }, action: caca },
    { id: 'a4', criteria: { query: '"bigdick"' }, action: caca },                  // pas un mot entier : pas couvert
    { id: 'a5', criteria: { query: '"big dick"' }, action: { addLabelIds: ['TRASH'] } }, // autre action : pas couvert
    { id: 'a6', criteria: { query: '"crypto gains"' }, action: caca },
    { id: 'a7', criteria: { query: '"crypto gains"' }, action: caca },               // doublon de a6
    { id: 'a8', criteria: { query: '"dick" OR "viagra"' }, action: caca }            // déjà un OR : laissé tel quel
  ] }));
  assert.deepEqual(plan.duplicates.map(d => [d.keep.id, d.remove.map(r => r.id)]), [['a6', ['a7']]]);
  assert.equal(plan.overlaps.length, 1);
  assert.equal(plan.overlaps[0].broad.id, 'a1');
  assert.deepEqual(plan.overlaps[0].narrows.map(r => r.id).sort(), ['a2', 'a3']);
  assert.equal(plan.merges.length, 1);
  assert.deepEqual(plan.merges[0].rules.map(r => r.id).sort(), ['a1', 'a4', 'a6']);
  assert.equal(plan.merges[0].criteria.query, 'dick OR "bigdick" OR "crypto gains"');
  assert.deepEqual(plan.merges[0].action, caca);
});

/* ── indicateur spam ── */
test('scam : texte caché, lettres découpées, faux expéditeur, DMARC', () => {
  const scam = msg('s1', {
    From: '"PayPal Service" <spEchQov@uhcci0tt.us>', To: 'moi@gmail.com', Subject: 'Compte suspendu',
    'Authentication-Results': 'mx.google.com; spf=softfail; dkim=none; dmarc=fail'
  }, '<div style="display:none">' + 'lorem ipsum '.repeat(120) + '</div>' +
     '<span>V</span><span>e</span><span>r</span><span>i</span><span>f</span><span>i</span><span>e</span><span>z</span>' +
     '<a href="http://203.0.113.9/login">www.paypal.com</a>');
  const r = analyzeScam_(scam);
  assert.equal(r.level, 'scam');
  const titles = r.findings.map(f => f.title).join(' | ');
  for (const k of ['texte caché', 'lettre par lettre', 'Lien trompeur', 'adresse IP', 'Paypal', 'DMARC fail']) assert.match(titles, new RegExp(k, 'i'));
});
test('scam : un mail honnête reste propre', () => {
  const ok = msg('o1', { From: 'La Poste <info@laposte.fr>', To: 'moi@gmail.com', Subject: 'Votre colis',
    'Authentication-Results': 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' },
    '<p>Bonjour, votre colis arrive demain.</p><a href="https://www.laposte.fr/suivi">laposte.fr</a>');
  assert.equal(analyzeScam_(ok).level, 'ok');
});

/* ── tendances ── */
test('adresse visée : exacte, avec points, avec +, masquée', () => {
  const me = 'soaresden@gmail.com';
  assert.equal(canonicalGmail('S.Oares.Den+promo@googlemail.com'), me);
  assert.equal(addressVariant('Moi <soaresden@gmail.com>', me).kind, 'exacte');
  assert.deepEqual(addressVariant('x@y.com, s.oaresden@gmail.com', me), { address: 's.oaresden@gmail.com', kind: 'avec points' });
  assert.equal(addressVariant('soaresden+shop@gmail.com', me).kind, 'avec +');
  assert.equal(addressVariant('undisclosed-recipients:;', me).kind, 'masquée');
});
test('tendances : pic expliqué, baisse, point commun « adresse avec points »', () => {
  const me = 'soaresden@gmail.com';
  const now = new Date('2026-10-21T12:00:00Z').getTime(), W = 7 * 86400000;
  const rec = (weeksAgo, fromDomain, to = me) => ({ t: now - weeksAgo * W, fromDomain, tld: fromDomain.split('.').pop(), rp: '', esp: '', ip24: '', to, toKind: to === me ? 'exacte' : 'avec points', random: false, dmarc: '', subject: 'Votre colis est bloqué' });
  const rs = [];
  for (let w = 20; w >= 1; w--) for (let i = 0; i < (w > 10 ? 6 : 2); i++) rs.push(rec(w, 'divers' + (i % 3) + '.com'));
  for (let i = 0; i < 30; i++) rs.push(rec(12, 'pastintel.org.uk', 's.oaresden@gmail.com'));   // la vague
  const a = aggregate(rs, me, { weeks: 26, now });
  assert.equal(a.peaks.length, 1);
  assert.equal(a.peaks[0].domain, 'pastintel.org.uk');
  assert.ok(a.monthlyTrend < 0, 'le volume baisse');
  assert.ok(a.commons.some(c => c.field === 'words' && c.value === 'colis'));
  assert.ok(a.lists.to.some(t => t.value === 's.oaresden@gmail.com'));
});
test('statRecord lit les en-têtes utiles', () => {
  const r = statRecord({ internalDate: '1792771200000', payload: { headers: [
    { name: 'From', value: '"🟥 DHL" <HpwPSmQh@ioasj0su.us>' }, { name: 'To', value: 's.oaresden@gmail.com' },
    { name: 'Subject', value: 'Votre colis' }, { name: 'Return-Path', value: '<bounce@mail.sendgrid.net>' },
    { name: 'Authentication-Results', value: 'mx.google.com; spf=pass (google.com: domain of x designates 198.51.100.23 as permitted sender) dmarc=fail' },
    { name: 'List-Unsubscribe', value: '<https://u123.ct.sendgrid.net/unsub>' }] } }, 'soaresden@gmail.com');
  assert.deepEqual([r.fromDomain, r.tld, r.rp, r.esp, r.ip24, r.toKind, r.dmarc, r.random], ['ioasj0su.us', 'us', 'sendgrid.net', 'sendgrid.net', '198.51.100.x', 'avec points', 'fail', true]);
});

console.log(`${n} tests OK`);
