// Tendances des spams : évolution par semaine, pics, et ce que les spams ont en commun
// (adresse exacte visée, domaines, serveurs, plateformes d'envoi, mots des objets). Fonctions pures.
import { extractEmailAddress_, normalizeMailText_ } from './gfm-text.js';
import { registrable_, domainOf_, looksRandom_, parseAuth_ } from './gfm-scam.js';

const WEEK = 7 * 86400000;
const RELAY_ALIAS = /(^|\.)(mozmail\.com|privaterelay\.appleid\.com|duck\.com|simplelogin\.(co|com|io|fr)|slmail\.me|aleeas\.com|anonaddy\.(me|com)|addy\.io|passmail\.(net|com)|passinbox\.com|33mail\.com)$/i;
const STOP = new Set(('le la les un une des de du d l a au aux et ou en dans sur pour par avec ce cet cette ces vous votre vos ' +
  'nous notre nos je tu il elle est sont pas plus qui que se sa son ses the a an of to in on at for from by with and or is are ' +
  'be your you we our it this that not no now get has have will can re fw tr fwd').split(' '));

/** Adresse Gmail canonique : Gmail ignore les points et tout ce qui suit « + ». */
export function canonicalGmail(addr) {
  const [l, d] = String(addr || '').toLowerCase().trim().split('@');
  if (!d) return String(addr || '').toLowerCase();
  const dom = d === 'googlemail.com' ? 'gmail.com' : d;
  let local = l.split('+')[0];
  if (dom === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + dom;
}

/** Sous quelle forme ton adresse apparaît dans À / Cc — une variante trahit la liste qui a fuité. */
export function addressVariant(headerTo, me) {
  const mine = canonicalGmail(me);
  const addrs = String(headerTo || '').split(',').map(a => extractEmailAddress_(a).toLowerCase().trim()).filter(a => a.includes('@'));
  const hit = addrs.find(a => canonicalGmail(a) === mine);
  if (!hit) {
    // alias d'un service de relais (un alias par site : il désigne directement le site qui a fuité) ou autre adresse transférée
    // sinon : « À » affiche une adresse bidon et tu étais en copie cachée (l'enveloppe du mail, invisible, te visait)
    if (addrs.length) return RELAY_ALIAS.test(addrs[0].split('@')[1] || '')
      ? { address: addrs[0], kind: 'alias relais' }
      : { address: '(faux destinataire, envoyé en Cci)', kind: 'faux destinataire' };
    return { address: '(masquée : Cci ou liste)', kind: 'masquée' };
  }
  if (hit === me.toLowerCase()) return { address: hit, kind: 'exacte' };
  if (hit.split('@')[0].includes('+')) return { address: hit, kind: 'avec +' };
  if (hit.split('@')[0].replace(/\./g, '') === mine.split('@')[0] && hit.includes('.')) return { address: hit, kind: 'avec points' };
  return { address: hit, kind: 'autre écriture' };
}

/** Résumé d'un message (format=metadata) : ce qu'on garde en cache pour les tendances. */
export function statRecord(m, me) {
  const h = {};
  for (const x of (m.payload && m.payload.headers) || []) (h[x.name.toLowerCase()] = h[x.name.toLowerCase()] || []).push(x.value);
  const first = k => (h[k] || [''])[0];
  const fromRaw = first('from');
  const from = extractEmailAddress_(fromRaw).toLowerCase();
  const dom = domainOf_(from);
  const authRaw = (h['authentication-results'] || []).join(' ');
  const auth = parseAuth_(authRaw);
  // serveur d'envoi : IP vue par Gmail (Authentication-Results, sinon l'en-tête Received ajouté par mx.google.com)
  const rcv = (h.received || []).find(x => /by mx\.google\.com/i.test(x)) || '';
  const ip = (authRaw.match(/(?:client-ip=|designates )(\d{1,3}(?:\.\d{1,3}){3})/) || rcv.match(/\[(\d{1,3}(?:\.\d{1,3}){3})\]/) || [])[1] || '';
  const rp = domainOf_(extractEmailAddress_(first('return-path')).toLowerCase());
  const unsub = (first('list-unsubscribe').match(/https?:\/\/([^/>\s]+)/i) || [])[1] || '';
  const v = addressVariant([first('to'), first('cc')].filter(Boolean).join(', '), me);
  return {
    t: Number(m.internalDate) || 0,
    fromDomain: registrable_(dom) || '(inconnu)',
    tld: (dom.match(/\.([a-z0-9-]+)$/i) || [, '?'])[1].toLowerCase(),
    rp: rp ? registrable_(rp) : '',
    esp: unsub ? registrable_(unsub.toLowerCase()) : '',
    ip24: ip ? ip.split('.').slice(0, 3).join('.') + '.x' : '',
    to: v.address, toKind: v.kind,
    random: looksRandom_(from.split('@')[0], 8) || looksRandom_(dom.split('.')[0] || '', 6),
    dmarc: auth.dmarc || '', spf: auth.spf || '',
    name: fromRaw.replace(/<[^>]*>/g, '').replace(/"/g, '').trim().slice(0, 50),
    subject: first('subject').slice(0, 100)
  };
}

function startOfWeek(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // lundi
  return d.getTime();
}

function top(records, key, n = 8) {
  const c = new Map();
  for (const r of records) { const k = r[key]; if (k) c.set(k, (c.get(k) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count, share: count / records.length }));
}

function subjectWords(records, me, n = 15) {
  const mine = new Set([me.split('@')[0].toLowerCase(), ...me.split('@')[0].toLowerCase().split(/[._+-]/)]);
  const c = new Map();
  for (const r of records) {
    const seen = new Set();
    for (const w of normalizeMailText_(r.subject).split(' ')) {
      if (w.length < 3 || /\d/.test(w) || STOP.has(w) || mine.has(w) || seen.has(w)) continue;
      seen.add(w);
      c.set(w, (c.get(w) || 0) + 1);
    }
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count, share: count / records.length }));
}

/**
 * Tendances sur `periods` semaines ou mois (`unit`) : courbe, évolution récente, pics (vagues), points communs.
 * Un pic : période au-dessus de moyenne + 2 écarts-types (et ≥ 5 spams), avec le domaine qui l'explique.
 */
export function aggregate(records, me, { periods = 52, unit = 'week', now = Date.now() } = {}) {
  const week = unit === 'week';
  const end = week ? startOfWeek(now) + WEEK : new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 1).getTime();
  const start = week ? end - periods * WEEK : new Date(new Date(end).getFullYear(), new Date(end).getMonth() - periods, 1).getTime();
  const s0 = new Date(start);
  const indexOf = t => week ? Math.floor((t - start) / WEEK) : (new Date(t).getFullYear() - s0.getFullYear()) * 12 + new Date(t).getMonth() - s0.getMonth();
  const startAt = i => week ? start + i * WEEK : new Date(s0.getFullYear(), s0.getMonth() + i, 1).getTime();

  const rs = records.filter(r => r.t >= start && r.t < end);
  const series = Array.from({ length: periods }, (_, i) => ({ start: startAt(i), count: 0, byDomain: new Map() }));
  for (const r of rs) {
    const b = series[indexOf(r.t)];
    if (!b) continue;
    b.count++;
    b.byDomain.set(r.fromDomain, (b.byDomain.get(r.fromDomain) || 0) + 1);
  }
  const counts = series.map(s => s.count);
  // on ignore les périodes avant le premier spam connu (début de l'historique)
  const firstIdx = counts.findIndex(c => c > 0);
  const active = firstIdx < 0 ? [] : counts.slice(firstIdx);
  const mean = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
  const sd = active.length ? Math.sqrt(active.reduce((a, b) => a + (b - mean) ** 2, 0) / active.length) : 0;
  // 4 dernières semaines contre les 4 précédentes, quelle que soit l'unité du graphique
  const day = 86400000;
  const last4 = records.filter(r => r.t >= now - 28 * day && r.t < now).length;
  const prev4 = records.filter(r => r.t >= now - 56 * day && r.t < now - 28 * day).length;
  // pente (moindres carrés) sur les périodes actives, rapportée à la moyenne → % par mois
  let slope = 0;
  if (active.length >= 4) {
    const n = active.length, xm = (n - 1) / 2;
    let num = 0, den = 0;
    active.forEach((y, x) => { num += (x - xm) * (y - mean); den += (x - xm) ** 2; });
    slope = den ? num / den : 0;
  }
  const peaks = series
    .filter(s => s.count >= 5 && s.count > mean + 2 * sd)
    .sort((a, b) => b.count - a.count).slice(0, 4)
    .map(s => {
      const [d, c] = [...s.byDomain.entries()].sort((a, b) => b[1] - a[1])[0];
      return { start: s.start, count: s.count, domain: d, domainShare: c / s.count };
    });

  const share = f => rs.length ? rs.filter(f).length / rs.length : 0;
  const lists = {
    to: top(rs, 'to', 6), fromDomain: top(rs, 'fromDomain'), ip24: top(rs, 'ip24'), tld: top(rs, 'tld', 6),
    rp: top(rs, 'rp'), esp: top(rs, 'esp', 6), words: subjectWords(rs, me)
  };
  // points communs : ce qui revient dans au moins un quart des spams
  const LABEL = { to: 'envoyés à', fromDomain: 'expédiés depuis le domaine', ip24: 'venus des serveurs', tld: 'expédiés depuis un domaine en .', rp: 'avec une adresse de retour chez', esp: 'avec un lien de désabonnement chez', words: 'avec le mot « %s » dans l’objet' };
  const commons = [];
  for (const k of Object.keys(lists)) {
    for (const it of lists[k]) if (it.share >= 0.25 && !(k === 'to' && it.value === me.toLowerCase())) commons.push({ field: k, value: it.value, share: it.share, label: LABEL[k] });
  }
  const randomShare = share(r => r.random), dmarcFail = share(r => r.dmarc === 'fail');
  if (randomShare >= 0.25) commons.push({ field: 'random', value: '', share: randomShare, label: 'avec une adresse ou un domaine d’expédition aléatoire' });
  if (dmarcFail >= 0.25) commons.push({ field: 'dmarc', value: '', share: dmarcFail, label: 'refusés par le domaine affiché (DMARC fail)' });
  commons.sort((a, b) => b.share - a.share);

  return {
    total: rs.length, unit, series: series.map(s => ({ start: s.start, count: s.count })),
    mean, last4, prev4, change4: prev4 ? (last4 - prev4) / prev4 : null,
    monthlyTrend: mean ? slope * (week ? 4.33 : 1) / mean : 0,
    peaks, lists, commons,
    toKinds: top(rs, 'toKind', 5), randomShare, dmarcFail,
    first: rs.reduce((m, r) => Math.min(m, r.t), Infinity), last: rs.reduce((m, r) => Math.max(m, r.t), 0)
  };
}
