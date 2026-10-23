// Tes filtres Gmail : index en cache, « pourquoi ce mail a ce filtre ? », création / suppression, simplification.
import { api, pool, listIds, settings, claude, log } from './gmail-api.js';
import { htmlToText, headerMap } from './analyzer.js';
import { messageAdapter } from './lib/gfm-message.js';
import { analyzeThread_, explainLabel_ } from './lib/gfm-match.js';
import { analyzeScam_ } from './lib/gfm-scam.js';
import { unionRaw_, buildIndexFromRaw_, filterSignature_, exportXml_, simplifyPlan_ } from './lib/gfm-filters.js';

const SYSTEM_LABELS = /^(INBOX|SPAM|TRASH|UNREAD|STARRED|IMPORTANT|SENT|DRAFT|CHAT|CATEGORY_.*)$/;

/* ───────── index des filtres (cache chrome.storage.local, relu à la demande) ───────── */

let raw = null;     // { builtAt, labels:[{id,name}], filters:[{id,criteria,action}], apiCount, unstable }
let index = null;

async function loadRaw() {
  if (!raw) raw = (await chrome.storage.local.get('gfmFilters')).gfmFilters || null;
  return raw;
}

async function saveRaw(r) {
  raw = r;
  index = buildIndexFromRaw_(r);
  await chrome.storage.local.set({ gfmFilters: r });
}

export function status() {
  return raw ? { count: raw.filters.length, apiCount: raw.apiCount || raw.filters.length, unstable: !!raw.unstable, builtAt: raw.builtAt } : null;
}

export async function getIndex(post) {
  if (index) return index;
  if (await loadRaw()) index = buildIndexFromRaw_(raw);
  else await reload({}, post);
  return index;
}

/**
 * Relit filtres et libellés depuis Gmail. Gmail renvoie parfois une liste tronquée (observé après un import
 * massif) : si elle compte moins de filtres que le cache, on garde l'union et rien ne disparaît — sauf
 * `replace`, qui fait confiance à la liste.
 */
export async function reload({ replace } = {}, post = () => {}) {
  post('Lecture de tes filtres Gmail…');
  const prev = await loadRaw();
  const [f, l] = await Promise.all([api('settings/filters'), api('labels')]);
  const fresh = {
    builtAt: Date.now(),
    labels: ((l && l.labels) || []).map(x => ({ id: x.id, name: x.name })),
    filters: ((f && f.filter) || []).map(x => ({ id: x.id, criteria: x.criteria || {}, action: x.action || {} })),
    apiCount: ((f && f.filter) || []).length
  };
  if (!replace && prev && fresh.filters.length < prev.filters.length) {
    const u = unionRaw_([fresh, prev]);
    u.apiCount = fresh.apiCount;
    u.unstable = true;
    log(`Liste Gmail incomplète ? ${fresh.apiCount} filtres contre ${prev.filters.length} en cache : union gardée.`);
    await saveRaw(u);
  } else {
    fresh.unstable = false;
    await saveRaw(fresh);
  }
  return status();
}

async function cacheAdd(filters, labels = []) {
  await loadRaw();
  if (!raw) return;
  const ids = new Set(filters.map(f => f.id));
  raw.filters = raw.filters.filter(f => !ids.has(f.id)).concat(filters.map(f => ({ id: f.id, criteria: f.criteria || {}, action: f.action || {} })));
  for (const lb of labels) if (!raw.labels.some(x => x.id === lb.id)) raw.labels.push({ id: lb.id, name: lb.name });
  await saveRaw(raw);
}

async function cacheRemove(ids) {
  await loadRaw();
  if (!raw) return;
  const gone = new Set(ids);
  raw.filters = raw.filters.filter(f => !gone.has(f.id));
  await saveRaw(raw);
}

/** Filtres créés ailleurs dans l'extension (dossier Spam) : le cache les apprend sans relire Gmail. */
export async function learnCreated(filters, label) {
  await cacheAdd(filters.filter(Boolean), label ? [label] : []);
}

const ruleView = r => ({ id: r.id, description: r.description, actions: r.actions, addLabels: r.addLabels, queryText: r.queryText });

/* ───────── mail ouvert : pourquoi ces filtres ? ───────── */

const threads = new Map();   // threadId → { adapters, result } (les 5 derniers, pour « Pourquoi ? » et Claude)

async function threadData(threadId) {
  if (threads.has(threadId)) return threads.get(threadId);
  const t = await api(`threads/${threadId}`, { params: { format: 'full' } });
  const d = { msgs: t.messages || [], adapters: (t.messages || []).map(messageAdapter) };
  threads.set(threadId, d);
  if (threads.size > 5) threads.delete(threads.keys().next().value);
  return d;
}

export async function analyzeMail({ threadId, messageId }, post) {
  const idx = await getIndex(post);
  post('Lecture du mail…');
  if (!threadId) threadId = (await api(`messages/${messageId}`, { params: { format: 'minimal' } })).threadId;
  threads.delete(threadId);            // toujours l'état actuel du fil (libellés modifiés entre-temps)
  const d = await threadData(threadId);
  if (!d.msgs.length) throw new Error('Fil vide ou introuvable.');
  post(`Test de tes ${idx.rules.length} filtres…`);
  const r = analyzeThread_(idx, d.adapters);
  const labelIds = [...new Set(d.msgs.flatMap(m => m.labelIds || []))];
  const labels = labelIds.filter(id => !SYSTEM_LABELS.test(id)).map(id => idx.labelsById[id] || id);
  const explained = new Set(r.matches.flatMap(m => m.rule.addLabels));
  const last = d.adapters[d.adapters.length - 1];
  const scam = analyzeScam_(last);
  const s = await settings();
  d.result = { r, labels, scam };
  return {
    mail: {
      threadId, from: last.getFrom(), subject: last.getSubject(), date: last.getDate().getTime(),
      count: d.msgs.length, labels, system: labelIds.filter(id => SYSTEM_LABELS.test(id))
    },
    matches: r.matches.map(m => ({ rule: ruleView(m.rule), reasons: m.reasons, preview: m.preview, messages: m.messages })),
    unexplained: labels.filter(l => !explained.has(l)),
    ruleCount: r.ruleCount, elapsedMs: r.elapsedMs,
    scam: { ...scam, links: scam.links.slice(0, 12) },
    status: status(),
    claude: !!s.anthropicKey,
    defaultLabel: s.labelName,
    labelNames: Object.keys(idx.labelsByName).filter(n => !SYSTEM_LABELS.test(idx.labelsByName[n])).sort((a, b) => a.localeCompare(b, 'fr'))
  };
}

export async function explainLabel({ threadId, label }, post) {
  const idx = await getIndex(post);
  const d = await threadData(threadId);
  const r = explainLabel_(idx, d.adapters, label);
  return { label, ruleCount: r.ruleCount, candidates: r.candidates.map(c => ({ rule: ruleView(c.rule), score: c.score, reason: c.reason, preview: c.preview })) };
}

/** Explication en clair par Claude, à partir de ce que le moteur a trouvé (rien n'est envoyé sans clic). */
export async function claudeExplain({ threadId }, post) {
  const s = await settings();
  const d = await threadData(threadId);
  if (!d.result) await analyzeMail({ threadId }, post);
  const { r, labels, scam } = d.result;
  const last = d.adapters[d.adapters.length - 1];
  post('Claude analyse le mail…');
  const prompt = `Tu aides quelqu'un à comprendre ses filtres Gmail. Explique-lui en français, simplement, en 3 à 6 phrases,
pourquoi ce mail a été trié ainsi (libellés, archivage, corbeille). Si un filtre paraît trop large (il risque d'attraper de
vrais mails), dis-le et propose une phrase plus précise. Si un libellé n'est expliqué par aucun filtre, dis ce qui est probable.
Ne répète pas la liste brute : interprète-la.

Mail : de ${last.getFrom()} — objet « ${last.getSubject()} »
Libellés : ${labels.join(', ') || 'aucun'}
Extrait : ${(last.getPlainBody() || htmlToText(last.getBody())).replace(/\s+/g, ' ').slice(0, 1500)}

Filtres qui le déclenchent (${r.matches.length}) :
${r.matches.slice(0, 15).map(m => `- ${m.rule.description} → ${m.rule.actions.join(', ')} (déclenché par : ${m.reasons.join(' ; ').replace(/✅ /g, '')})`).join('\n') || '- aucun'}

Indicateur spam : ${scam.score}/100 — ${scam.verdict}
${scam.findings.slice(0, 4).map(f => `- ${f.title}`).join('\n')}`;
  return { text: (await claude(s, prompt, 800)).trim() };
}

/* ───────── créer / tester / supprimer ───────── */

const searchOf = (field, value) => field === 'from' ? `from:(${value})` : field === 'subject' ? `subject:"${value}"` : `"${value}"`;

/** Mails attrapés par une recherche, hors Spam / Corbeille / libellés donnés : ce qu'un filtre toucherait « en vrai ». */
async function legitHits(query, excludeLabelIds = []) {
  const ids = await listIds(query, false, 60);
  const infos = await pool(ids, 4, id => api(`messages/${id}`, { params: { format: 'metadata', metadataHeaders: ['From', 'Subject'] } }));
  const legit = infos.filter(m => m && !(m.labelIds || []).some(l => excludeLabelIds.includes(l)));
  return {
    count: legit.length, capped: ids.length >= 60, query,
    samples: legit.slice(0, 5).map(m => { const h = headerMap(m.payload); return { from: (h.from || [''])[0], subject: (h.subject || [''])[0] }; })
  };
}

export async function testCriterion({ field, value, target }, post) {
  const idx = await getIndex(post);
  post('Recherche dans Gmail…');
  const exclude = target === '__TRASH__' ? [] : [idx.labelsByName[target]].filter(Boolean);
  return legitHits(searchOf(field, value), exclude);
}

export async function createFilter({ field, value, target, archive, markRead }, post) {
  const idx = await getIndex(post);
  value = String(value || '').trim().replace(/^"+|"+$/g, '');
  if (!value) throw new Error('Indique une phrase ou un expéditeur.');
  const criteria = field === 'from' ? { from: value } : field === 'subject' ? { subject: `"${value}"` } : { query: `"${value}"` };
  const action = { addLabelIds: [], removeLabelIds: [] };
  const newLabels = [];
  if (target === '__TRASH__') action.addLabelIds.push('TRASH');
  else {
    let id = idx.labelsByName[target];
    if (!id) {
      post(`Création du libellé ${target}…`);
      const c = await api('labels', { method: 'POST', body: { name: target, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
      id = c.id;
      newLabels.push({ id, name: target });
    }
    action.addLabelIds.push(id);
  }
  if (archive) action.removeLabelIds.push('INBOX');
  if (markRead) action.removeLabelIds.push('UNREAD');
  if (!action.removeLabelIds.length) delete action.removeLabelIds;

  const sig = filterSignature_(criteria, action);
  const dup = idx.rules.find(r => filterSignature_(r.criteria, r.rawAction) === sig);
  if (dup) throw new Error(`Ce filtre existe déjà : ${dup.description} → ${dup.actions.join(', ')}`);

  post('Création du filtre…');
  const created = await api('settings/filters', { method: 'POST', body: { criteria, action } });
  await cacheAdd([created], newLabels);
  return { rule: ruleView(index.rules.find(r => r.id === created.id)), status: status() };
}

export async function deleteFilter({ id }, post) {
  post('Suppression du filtre…');
  try {
    await api(`settings/filters/${id}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404) throw e;      // déjà supprimé : on met juste le cache à jour
  }
  await cacheRemove([id]);
  return { id, status: status() };
}

/* ───────── simplification ───────── */

export async function plan(_, post) {
  const idx = await getIndex(post);
  const p = simplifyPlan_(idx);
  return {
    total: p.total,
    status: status(),
    duplicates: p.duplicates.map(d => ({ keep: ruleView(d.keep), remove: d.remove.map(ruleView) })),
    overlaps: p.overlaps.map(o => ({ broad: ruleView(o.broad), narrows: o.narrows.map(ruleView) })),
    merges: p.merges.map(m => ({ criteria: m.criteria, action: m.action, actions: m.rules[0].actions, rules: m.rules.map(ruleView) })),
    job: (await chrome.storage.local.get('gfmJob')).gfmJob || null
  };
}

/** « dick » attrape-t-il de vrais mails ? (mails trouvés hors Spam / Corbeille / libellés posés par ce filtre) */
export async function testRule({ id }, post) {
  const idx = await getIndex(post);
  const rule = idx.rules.find(r => r.id === id);
  if (!rule) throw new Error('Filtre introuvable (supprimé entre-temps ?)');
  post(`Recherche de ${rule.queryText} dans Gmail…`);
  return legitHits(rule.queryText, rule.rawAction.addLabelIds || []);
}

export async function backup(_, post) {
  const idx = await getIndex(post);
  return { xml: exportXml_(idx), count: idx.rules.length };
}

/**
 * Applique une liste d'opérations validées, une par une (l'API Gmail freine les rafales) :
 *   { type: 'delete', id }  |  { type: 'merge', criteria, action, ids }  (crée le filtre fusionné, puis supprime ids)
 * La progression est gardée dans chrome.storage.local : si le navigateur coupe, « Reprendre » repart de là.
 */
export async function applyOps({ ops, resume }, post) {
  let job = resume ? (await chrome.storage.local.get('gfmJob')).gfmJob : { ops, next: 0, ok: 0, errors: [], startedAt: Date.now() };
  if (!job) throw new Error('Aucune simplification en cours.');
  const save = () => chrome.storage.local.set({ gfmJob: job });
  await save();
  while (job.next < job.ops.length) {
    const op = job.ops[job.next];
    post(`${job.next + 1} / ${job.ops.length} — ${op.type === 'merge' ? `fusion de ${op.ids.length} filtres` : 'suppression'}…`);
    try {
      if (op.type === 'merge') {
        if (!op.createdId) {
          const created = await api('settings/filters', { method: 'POST', body: { criteria: op.criteria, action: op.action } });
          op.createdId = created.id;
          await save();
          await cacheAdd([created]);
        }
        for (const id of op.ids) {
          try { await api(`settings/filters/${id}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
        }
        await cacheRemove(op.ids);
      } else {
        try { await api(`settings/filters/${op.id}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
        await cacheRemove([op.id]);
      }
      job.ok++;
    } catch (e) {
      job.errors.push(`${op.type === 'merge' ? op.criteria.query || op.criteria.from : op.id} : ${e.message}`.slice(0, 300));
    }
    job.next++;
    await save();
  }
  await chrome.storage.local.remove('gfmJob');
  return { ok: job.ok, errors: job.errors, total: job.ops.length, status: status() };
}
