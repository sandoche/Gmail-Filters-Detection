// Tendances des spams. Sources : dossier Spam, libellé des filtres anti-spam (###CACA###) et libellés choisis
// dans les options (ex. « scam »). Chaque message n'est lu qu'une fois (en-têtes seulement) et reste dans
// l'historique (chrome.storage.local) même quand Gmail le supprime : Spam et Corbeille se vident au bout de
// 30 jours, l'historique, lui, s'allonge à chaque analyse. Calculs : lib/gfm-stats.js.
import { api, pool, settings, findLabel, claude } from './gmail-api.js';
import { statRecord, aggregate } from './lib/gfm-stats.js';

const MAX_IDS = 50000;           // messages listés par source
const SAVE_EVERY = 250;          // sauvegarde en cours de lecture : une analyse coupée reprend où elle en était
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Return-Path', 'Authentication-Results', 'Received', 'List-Unsubscribe'];

async function idsOf(labelId, months) {
  const ids = [];
  let pageToken;
  do {
    const r = await api('messages', { params: { labelIds: labelId, q: months ? `newer_than:${months}m` : undefined, includeSpamTrash: true, maxResults: 500, pageToken } });
    for (const m of (r && r.messages) || []) ids.push(m.id);
    pageToken = r && r.nextPageToken;
  } while (pageToken && ids.length < MAX_IDS);
  return ids;
}

/** Sources analysées : Spam, le libellé des filtres, puis les libellés des options (« scam »…) qui existent. */
async function sourcesOf(s) {
  const r = await api('labels');
  const labels = (r && r.labels) || [];
  // « scam » trouve aussi « ►/02📜Admin/👿Scams » : comparaison sur le dernier niveau, sans émojis ni pluriel
  const loose = s => String(s).split('/').pop().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase().replace(/s$/, '');
  const byName = n => labels.find(l => l.name.toLowerCase() === n.trim().toLowerCase()) || labels.find(l => l.type === 'user' && loose(l.name) === loose(n));
  const out = [{ key: 'SPAM', name: 'Spam' }];
  const main = byName(s.labelName);
  if (main) out.push({ key: main.id, name: main.name });
  for (const n of String(s.statsLabels || '').split(',').filter(x => x.trim())) {
    const l = byName(n);
    if (l && !out.some(o => o.key === l.id)) out.push({ key: l.id, name: l.name });
  }
  return out;
}

async function loadCache(me) {
  const c = (await chrome.storage.local.get('gfmStats')).gfmStats;
  return c && c.me === me ? c : { me, records: {} };
}

let meCache = '';
async function myAddress() {
  if (!meCache) meCache = (await api('profile')).emailAddress;
  return meCache;
}

/** Spams traités depuis l'onglet Spams : mémorisés avant d'aller à la corbeille (messages format=full). */
export async function remember(messages) {
  if (!messages.length) return;
  const me = await myAddress();
  const cache = await loadCache(me);
  for (const m of messages) cache.records[m.id] = { ...statRecord(m, me), src: [...new Set([...((cache.records[m.id] || {}).src || []), 'SPAM'])] };
  await chrome.storage.local.set({ gfmStats: cache });
}

let last = null;   // dernières tendances calculées, pour Claude

/**
 * months : 3, 6, 12, 24, 60 ou 0 (tout) ; source : 'all' ou la clé d'une source ;
 * fetch=false : recalcul depuis l'historique seulement (changement de source ou de période, sans relire Gmail).
 */
export async function runStats({ months = 12, source = 'all', fetch = true } = {}, post) {
  const s = await settings();
  const me = await myAddress();
  const cache = await loadCache(me);
  const sources = await sourcesOf(s);
  let fresh = 0;

  if (fetch) {
    const member = new Map();     // id → sources où il se trouve aujourd'hui
    for (const src of sources) {
      post(`Liste des messages : ${src.name}…`);
      for (const id of await idsOf(src.key, months)) member.set(id, [...(member.get(id) || []), src.key]);
    }
    for (const [id, keys] of member) {
      const r = cache.records[id];
      if (r) r.src = [...new Set([...(r.src || []), ...keys])];
    }
    const todo = [...member.keys()].filter(id => !cache.records[id]);
    let done = 0;
    await pool(todo, 8, async id => {
      const m = await api(`messages/${id}`, { params: { format: 'metadata', metadataHeaders: HEADERS } });
      if (m) cache.records[id] = { ...statRecord(m, me), src: member.get(id) };
      done++;
      if (done % 25 === 0) post(`Lecture des en-têtes : ${done.toLocaleString('fr-FR')} / ${todo.length.toLocaleString('fr-FR')} nouveaux messages…`);
      if (done % SAVE_EVERY === 0) await chrome.storage.local.set({ gfmStats: cache });
    });
    fresh = todo.length;
    // rien n'est retiré : un spam supprimé par Gmail (Spam / Corbeille vidés après 30 jours) reste dans l'historique
    await chrome.storage.local.set({ gfmStats: cache });
  }

  post('Calcul des tendances…');
  const all = Object.values(cache.records);
  const records = source === 'all' ? all : all.filter(r => (r.src || []).includes(source));
  const historyFrom = all.reduce((m, r) => Math.min(m, r.t), Infinity);
  // au-delà de 2 ans (ou « tout ») : un point par mois, sinon par semaine
  const spanMonths = months || Math.min(120, Math.max(1, Math.ceil((Date.now() - historyFrom) / (30.44 * 86400000)) + 1));
  const unit = spanMonths > 24 ? 'month' : 'week';
  const periods = unit === 'month' ? spanMonths : Math.round(spanMonths * 4.35);
  const counts = {};
  for (const r of all) for (const k of r.src || []) counts[k] = (counts[k] || 0) + 1;

  last = {
    ...aggregate(records, me, { periods, unit }), months, me, source, fresh,
    labelName: s.labelName, historyFrom: isFinite(historyFrom) ? historyFrom : 0, stored: all.length,
    sources: sources.map(x => ({ ...x, count: counts[x.key] || 0 }))
  };
  return { ...last, claude: !!s.anthropicKey };
}

/** Interprétation par Claude, à partir des seuls chiffres agrégés (aucun contenu de mail). */
export async function claudeStats(_, post) {
  if (!last) throw new Error('Lance d’abord l’analyse des tendances.');
  const s = await settings();
  post('Claude cherche le point commun…');
  const pct = x => Math.round(x * 100) + ' %';
  const list = l => l.map(x => `${x.value} (${pct(x.share)})`).join(', ') || '—';
  const src = last.source === 'all' ? last.sources.map(x => x.name).join(' + ') : (last.sources.find(x => x.key === last.source) || {}).name;
  const prompt = `Voici des statistiques sur ${last.total} spams reçus par une personne (${last.months ? last.months + ' derniers mois' : 'tout son historique'}, sources : ${src}).
Son adresse a fuité dans des bases de données. Explique-lui en français, en 5 à 8 phrases simples :
1) si le volume baisse, monte, ou vient par vagues (et ce qui semble causer les vagues) ;
2) le ou les points communs les plus parlants (surtout l'adresse exacte visée : une variante avec des points ou un « + », ou un alias de relais, trahit la liste ou le site qui a fuité) ;
3) ce qu'elle peut faire concrètement (filtre sur l'adresse variante, désactiver un alias, filtre sur des mots, etc.).
Ne conclus rien que les chiffres ne montrent pas.

${last.unit === 'month' ? 'Mois' : 'Semaines'} (du plus ancien au plus récent) : ${last.series.map(w => w.count).join(' ')}
4 dernières semaines : ${last.last4} spams, 4 précédentes : ${last.prev4}. Tendance : ${pct(last.monthlyTrend)} par mois.
Pics : ${last.peaks.map(p => `${new Date(p.start).toISOString().slice(0, 10)} : ${p.count} spams, dont ${pct(p.domainShare)} de ${p.domain}`).join(' ; ') || 'aucun'}
Adresse visée : ${list(last.lists.to)} — types : ${list(last.toKinds)}
Domaines d'expédition : ${list(last.lists.fromDomain)}
Extensions : ${list(last.lists.tld)}
Serveurs (IP /24) : ${list(last.lists.ip24)}
Adresse de retour : ${list(last.lists.rp)}
Plateforme de désabonnement : ${list(last.lists.esp)}
Mots fréquents des objets : ${list(last.lists.words)}
Expéditeurs aléatoires : ${pct(last.randomShare)} · DMARC en échec : ${pct(last.dmarcFail)}`;
  return { text: (await claude(s, prompt, 900)).trim() };
}
