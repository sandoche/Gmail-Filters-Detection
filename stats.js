// Tendances des spams (dossier Spam + libellé des filtres anti-spam) : lit les en-têtes une seule fois
// par message (cache chrome.storage.local), puis calcule évolution, pics et points communs (lib/gfm-stats.js).
import { api, pool, settings, findLabel, claude } from './gmail-api.js';
import { statRecord, aggregate } from './lib/gfm-stats.js';

const MAX_MESSAGES = 3000;
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Return-Path', 'Authentication-Results', 'Received', 'List-Unsubscribe'];

async function idsOf(labelId, months, max) {
  const ids = [];
  let pageToken;
  do {
    const r = await api('messages', { params: { labelIds: labelId, q: `newer_than:${months}m`, includeSpamTrash: true, maxResults: 500, pageToken } });
    for (const m of (r && r.messages) || []) ids.push(m.id);
    pageToken = r && r.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

let last = null;   // dernières tendances calculées, pour Claude

export async function runStats({ months = 12 } = {}, post) {
  const s = await settings();
  const me = (await api('profile')).emailAddress;
  const label = await findLabel(s.labelName);
  post('Liste des spams…');
  const ids = [...new Set([...(await idsOf('SPAM', months, MAX_MESSAGES)), ...(label ? await idsOf(label.id, months, MAX_MESSAGES) : [])])].slice(0, MAX_MESSAGES);

  const cache = (await chrome.storage.local.get('gfmStats')).gfmStats || { me, records: {} };
  if (cache.me !== me) { cache.me = me; cache.records = {}; }
  const todo = ids.filter(id => !cache.records[id]);
  let done = 0;
  await pool(todo, 8, async id => {
    const m = await api(`messages/${id}`, { params: { format: 'metadata', metadataHeaders: HEADERS } });
    if (m) cache.records[id] = statRecord(m, me);
    if (++done % 25 === 0) post(`Lecture des en-têtes : ${done} / ${todo.length} nouveaux spams…`);
  });
  // on ne garde que les spams encore présents (les autres ont été supprimés ou sortis du spam)
  const keep = new Set(ids);
  for (const id of Object.keys(cache.records)) if (!keep.has(id)) delete cache.records[id];
  await chrome.storage.local.set({ gfmStats: cache });

  post('Calcul des tendances…');
  const weeks = Math.round(months * 4.35);
  last = { ...aggregate(Object.values(cache.records), me, { weeks }), months, me, labelName: s.labelName, fresh: todo.length, capped: ids.length >= MAX_MESSAGES };
  return { ...last, claude: !!s.anthropicKey };
}

/** Interprétation par Claude, à partir des seuls chiffres agrégés (aucun contenu de mail). */
export async function claudeStats(_, post) {
  if (!last) throw new Error('Lance d’abord l’analyse des tendances.');
  const s = await settings();
  post('Claude cherche le point commun…');
  const pct = x => Math.round(x * 100) + ' %';
  const list = l => l.map(x => `${x.value} (${pct(x.share)})`).join(', ') || '—';
  const prompt = `Voici des statistiques sur ${last.total} spams reçus par une personne en ${last.months} mois (dossier Spam + libellé « ${last.labelName} »).
Son adresse a fuité dans des bases de données. Explique-lui en français, en 5 à 8 phrases simples :
1) si le volume baisse, monte, ou vient par vagues (et ce qui semble causer les vagues) ;
2) le ou les points communs les plus parlants (surtout l'adresse exacte visée : une variante avec des points ou un « + » trahit la liste qui a fuité) ;
3) ce qu'elle peut faire concrètement (filtre sur l'adresse variante, sur un domaine ou une plateforme d'envoi, etc.).
Ne conclus rien que les chiffres ne montrent pas.

Semaines (du plus ancien au plus récent) : ${last.weeks.map(w => w.count).join(' ')}
4 dernières semaines : ${last.last4} spams, 4 précédentes : ${last.prev4}. Tendance : ${pct(last.monthlyTrend)} par mois.
Pics : ${last.peaks.map(p => `${new Date(p.week).toISOString().slice(0, 10)} : ${p.count} spams, dont ${pct(p.domainShare)} de ${p.domain}`).join(' ; ') || 'aucun'}
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
