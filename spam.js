// Dossier Spam : dangerosité de chaque spam, filtres proposés (testés à 0 mail légitime), création après validation.
import { api, pool, listIds, findLabel, ensureLabel, settings, claude } from './gmail-api.js';
import { candidatesFor, summary, q, filterCriteria, key, greedyCover, headerMap, bodyText, bodyParts } from './analyzer.js';
import { messageAdapter } from './lib/gfm-message.js';
import { analyzeScam_ } from './lib/gfm-scam.js';

const MAX_HTML = 300000; // aperçu : au-delà, le HTML est coupé

// ---------- Validation d'un critère ----------
// covers : spams du lot attrapés ; legit : mails hors Spam/Corbeille/###CACA### attrapés.
function makeValidator(batchIds, spamLabelId) {
  const batch = new Set(batchIds);
  const labelCache = new Map();
  const cache = new Map();
  async function labelsOf(id) {
    if (!labelCache.has(id)) {
      labelCache.set(id, api(`messages/${id}`, { params: { format: 'metadata', metadataHeaders: ['From', 'Subject'] } })
        .then(m => { const h = headerMap(m.payload); return { labelIds: m.labelIds || [], from: (h.from || [''])[0], subject: (h.subject || [''])[0] }; }));
    }
    return labelCache.get(id);
  }
  return async function validate(cand) {
    const k = key(cand);
    if (cache.has(k)) return cache.get(k);
    const p = (async () => {
      const query = q(cand);
      const all = await listIds(query, true, 300);
      const covers = new Set(all.filter(id => batch.has(id)));
      if (!covers.size) return { cand, covers, legit: [], total: all.length, ok: false, reason: 'n’attrape pas ce spam' };
      const outside = await listIds(query, false, 40);
      const legit = [];
      for (const info of await pool(outside, 4, labelsOf)) {
        if (spamLabelId && info.labelIds.includes(spamLabelId)) continue;
        legit.push({ from: info.from, subject: info.subject });
      }
      return { cand, covers, legit, total: all.length, ok: legit.length === 0, reason: legit.length ? `${legit.length} mail(s) légitime(s)` : '' };
    })();
    cache.set(k, p);
    return p;
  };
}

// ---------- Claude (secours) ----------
async function claudeCandidates(msgs, s) {
  const items = msgs.slice(0, 15).map(m => {
    const sm = summary(m);
    return { id: m.id, from: sm.from, returnPath: sm.returnPath, subject: sm.subject, text: bodyText(m.payload).slice(0, 1200) };
  });
  const prompt = `Tu aides à créer des filtres Gmail anti-spam. Pour chaque spam ci-dessous, propose jusqu'à 4 critères Gmail
les plus précis possible, qui attrapent ce spam (et ses variantes) mais aucun vrai mail. Uniquement des mots, jamais
l'expéditeur (les spammeurs changent d'adresse et de domaine à chaque envoi, pas de texte).
Types autorisés :
- "subject" : phrase exacte présente telle quelle dans l'objet (sans le nom/adresse du destinataire, sans chiffres variables) ;
- "query"   : phrase exacte présente telle quelle dans le texte visible du mail.
Évite les homoglyphes (ɑ, і…), les identifiants, les montants. Réponds UNIQUEMENT en JSON :
{"results":[{"id":"...","candidates":[{"type":"subject","value":"..."}]}]}

Spams :
${JSON.stringify(items, null, 1)}`;
  const text = await claude(s, prompt);
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const out = [];
  for (const r of json.results || []) {
    for (const c of r.candidates || []) {
      if (!['subject', 'query'].includes(c.type) || !c.value) continue;
      const value = String(c.value).replace(/^"|"$/g, '').trim();
      if (value.length < 4) continue;
      out.push({ type: c.type, value, label: 'Proposé par Claude', byClaude: true });
    }
  }
  return out;
}

// Un spam tel que le panneau l'affiche : en-têtes, dangerosité, aperçu (le HTML est assaini côté page).
export function mailView(m) {
  const { plain, html } = bodyParts(m.payload);
  const r = analyzeScam_(messageAdapter(m));
  return {
    ...summary(m),
    threadId: m.threadId,
    date: Number(m.internalDate) || 0,
    html: html.slice(0, MAX_HTML),
    text: html ? '' : plain.slice(0, 50000),
    danger: {
      score: r.score, level: r.level, icon: r.icon, color: r.color, verdict: r.verdict,
      findings: r.findings.slice(0, 6), auth: { spf: r.auth.spf, dkim: r.auth.dkim, dmarc: r.auth.dmarc },
      hiddenSample: r.hiddenSample
    }
  };
}

// ---------- Analyse ----------
export async function analyzeSpam(post) {
  const s = await settings();
  post('Connexion à Gmail… (si une fenêtre Google s’ouvre, accepte toutes les autorisations)');
  const profile = await api('profile');
  const spamLabel = await findLabel(s.labelName);
  const spamLabelId = spamLabel && spamLabel.id;

  post('Lecture du dossier Spam…');
  const spamIds = await listIds('in:spam', true, s.maxSpams);
  const msgs = (await pool(spamIds, 5, id => api(`messages/${id}`, { params: { format: 'full' } }))).filter(Boolean);
  const todo = msgs.filter(m => !(spamLabelId && (m.labelIds || []).includes(spamLabelId)));
  const skipped = msgs.length - todo.length;
  const mails = {};
  for (const m of todo) mails[m.id] = mailView(m);
  const base = { mails, skipped, total: msgs.length, email: profile.emailAddress, labelName: s.labelName };
  if (!todo.length) return { ...base, proposals: [], uncovered: [] };

  const byId = new Map(todo.map(m => [m.id, m]));
  const validate = makeValidator(todo.map(m => m.id), spamLabelId);

  const uniq = new Map();
  for (const m of todo) for (const c of candidatesFor(m, profile.emailAddress)) if (!uniq.has(key(c))) uniq.set(key(c), c);
  const cands = [...uniq.values()];
  let done = 0;
  post(`${todo.length} spam(s) à traiter (${skipped} déjà en ${s.labelName} ignoré(s)). Test de ${cands.length} critère(s) dans Gmail…`);
  const results = await pool(cands, 3, async c => {
    const r = await validate(c);
    done++;
    if (done % 5 === 0) post(`Critères testés : ${done}/${cands.length}`);
    return r;
  });
  let { chosen, uncovered } = greedyCover(results.filter(r => r.ok), todo.map(m => m.id));
  let claudeError = '';

  if (uncovered.length && s.claudeMode === 'fallback' && s.anthropicKey) {
    post(`${uncovered.length} spam(s) sans critère sûr : je demande à Claude…`);
    try {
      const extra = await claudeCandidates(uncovered.map(id => byId.get(id)), s);
      const g2 = greedyCover((await pool(extra, 3, validate)).filter(r => r.ok), uncovered);
      chosen = chosen.concat(g2.chosen);
      uncovered = g2.uncovered;
    } catch (e) { claudeError = e.message; }
  }

  return {
    ...base,
    proposals: chosen.map((v, i) => ({ pid: 'p' + i, cand: v.cand, query: q(v.cand), total: v.total, coverIds: [...v.covers] })),
    uncovered,
    claudeError,
    claudeUsed: s.claudeMode === 'fallback' && !!s.anthropicKey,
    settings: { archive: s.archive, trashAfter: s.trashAfter, applyExisting: s.applyExisting }
  };
}

// ---------- Application ----------
export async function applySpam(payload, post) {
  const s = await settings();
  const opts = { ...s, ...(payload.options || {}) };
  post(`Libellé ${opts.labelName}…`);
  const labelId = await ensureLabel(opts.labelName);
  const report = [];
  const toTrash = new Set();

  for (const p of payload.proposals) {
    const cand = p.cand;
    try {
      if (p.edited) {
        post(`Re-vérification de ${q(cand)}…`);
        const v = await makeValidator(p.coverIds, labelId)(cand);
        if (!v.ok) { report.push({ query: q(cand), ok: false, msg: `annulé : ${v.reason}` }); continue; }
      }
      post(`Création du filtre ${q(cand)}…`);
      const action = { addLabelIds: [labelId] };
      if (opts.archive) action.removeLabelIds = ['INBOX'];
      let created = null;
      try {
        created = await api('settings/filters', { method: 'POST', body: { criteria: filterCriteria(cand), action } });
      } catch (e) {
        if (!(e.status === 400 && /exist/i.test(e.message))) throw e;
      }
      let applied = 0;
      if (opts.applyExisting) {
        const ids = await listIds(q(cand), false, 1000);
        for (let i = 0; i < ids.length; i += 500) {
          await api('messages/batchModify', { method: 'POST', body: { ids: ids.slice(i, i + 500), addLabelIds: [labelId], removeLabelIds: opts.archive ? ['INBOX'] : [] } });
        }
        applied = ids.length;
      }
      if (opts.trashAfter) p.coverIds.forEach(id => toTrash.add(id));
      report.push({ query: q(cand), ok: true, created, msg: `filtre créé${opts.applyExisting ? `, appliqué à ${applied} mail(s) existant(s)` : ''}` });
    } catch (e) {
      report.push({ query: q(cand), ok: false, msg: e.message });
    }
  }

  let trashed = 0;
  if (toTrash.size) {
    post(`Mise à la corbeille de ${toTrash.size} spam(s) traité(s)…`);
    await pool([...toTrash], 4, async id => { await api(`messages/${id}/trash`, { method: 'POST' }); trashed++; });
  }
  return { report, trashed, labelId, labelName: opts.labelName };
}
