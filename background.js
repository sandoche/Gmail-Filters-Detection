// Service worker : OAuth Google, API Gmail, analyse en lot du dossier Spam, création des filtres.
import { DEFAULTS } from './defaults.js';
import { candidatesFor, summary, q, filterCriteria, key, greedyCover, headerMap, bodyText } from './analyzer.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';


async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const { anthropicKey = '' } = await chrome.storage.local.get('anthropicKey');
  return { ...DEFAULTS, ...s, anthropicKey };
}

// ---------- Gmail API ----------
async function getToken(interactive = true) {
  const r = await chrome.identity.getAuthToken({ interactive });
  return typeof r === 'string' ? r : r.token;
}

async function api(path, { method = 'GET', body, params } = {}, attempt = 0) {
  const token = await getToken(true);
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && attempt === 0) {
    await chrome.identity.removeCachedAuthToken({ token });
    return api(path, { method, body, params }, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
    return api(path, { method, body, params }, attempt + 1);
  }
  if (!res.ok) {
    const err = new Error(`Gmail ${res.status} : ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

async function listIds(query, includeSpamTrash, max = 100) {
  const ids = [];
  let pageToken;
  do {
    const r = await api('messages', { params: { q: query, includeSpamTrash, maxResults: Math.min(500, max - ids.length), pageToken } });
    for (const m of (r && r.messages) || []) ids.push(m.id);
    pageToken = r && r.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

async function findLabel(name) {
  const r = await api('labels');
  return ((r && r.labels) || []).find(l => l.name === name) || null;
}

async function ensureLabel(name) {
  const l = await findLabel(name);
  if (l) return l.id;
  const c = await api('labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
  return c.id;
}

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
les plus précis possible, qui attrapent ce spam (et ses variantes) mais aucun vrai mail.
Types autorisés :
- "subject" : phrase exacte présente telle quelle dans l'objet (sans le nom/adresse du destinataire, sans chiffres variables) ;
- "query"   : phrase exacte présente telle quelle dans le texte visible du mail ;
- "from"    : domaine d'expéditeur stable sous la forme "@domaine.tld" (jamais un domaine aléatoire ni un webmail).
Évite les homoglyphes (ɑ, і…), les identifiants, les montants. Réponds UNIQUEMENT en JSON :
{"results":[{"id":"...","candidates":[{"type":"subject","value":"..."}]}]}

Spams :
${JSON.stringify(items, null, 1)}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': s.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: s.model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error(`Claude ${res.status} : ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const out = [];
  for (const r of json.results || []) {
    for (const c of r.candidates || []) {
      if (!['subject', 'query', 'from'].includes(c.type) || !c.value) continue;
      const value = String(c.value).replace(/^"|"$/g, '').trim();
      if (value.length < 4) continue;
      out.push({ type: c.type, value, label: 'Proposé par Claude', byClaude: true });
    }
  }
  return out;
}

// ---------- Analyse ----------
async function analyze(post) {
  const s = await settings();
  post({ type: 'progress', text: 'Connexion à Gmail…' });
  const profile = await api('profile');
  const spamLabel = await findLabel(s.labelName);
  const spamLabelId = spamLabel && spamLabel.id;

  post({ type: 'progress', text: 'Lecture du dossier Spam…' });
  const spamIds = await listIds('in:spam', true, s.maxSpams);
  const msgs = (await pool(spamIds, 5, id => api(`messages/${id}`, { params: { format: 'full' } })))
    .filter(Boolean);
  const todo = msgs.filter(m => !(spamLabelId && (m.labelIds || []).includes(spamLabelId)));
  const skipped = msgs.length - todo.length;
  if (!todo.length) return { proposals: [], uncovered: [], skipped, total: msgs.length, email: profile.emailAddress };

  const byId = new Map(todo.map(m => [m.id, m]));
  const validate = makeValidator(todo.map(m => m.id), spamLabelId);

  const uniq = new Map();
  for (const m of todo) for (const c of candidatesFor(m, profile.emailAddress)) if (!uniq.has(key(c))) uniq.set(key(c), c);
  const cands = [...uniq.values()];
  let done = 0;
  post({ type: 'progress', text: `${todo.length} spam(s) à traiter (${skipped} déjà en ${s.labelName} ignoré(s)). Test de ${cands.length} critère(s) dans Gmail…` });
  const results = await pool(cands, 3, async c => {
    const r = await validate(c);
    done++;
    if (done % 5 === 0) post({ type: 'progress', text: `Critères testés : ${done}/${cands.length}` });
    return r;
  });
  let valid = results.filter(r => r.ok);
  let { chosen, uncovered } = greedyCover(valid, todo.map(m => m.id));
  let claudeError = '';

  if (uncovered.length && s.claudeMode === 'fallback' && s.anthropicKey) {
    post({ type: 'progress', text: `${uncovered.length} spam(s) sans critère sûr : je demande à Claude…` });
    try {
      const extra = await claudeCandidates(uncovered.map(id => byId.get(id)), s);
      const r2 = (await pool(extra, 3, validate)).filter(r => r.ok);
      const g2 = greedyCover(r2, uncovered);
      chosen = chosen.concat(g2.chosen);
      uncovered = g2.uncovered;
    } catch (e) { claudeError = e.message; }
  }

  const proposals = chosen.map((v, i) => ({
    pid: 'p' + i,
    cand: v.cand,
    query: q(v.cand),
    total: v.total,
    legit: v.legit.length,
    coverIds: [...v.covers],
    covers: [...v.covers].map(id => summary(byId.get(id)))
  }));
  return {
    proposals,
    uncovered: uncovered.map(id => summary(byId.get(id))),
    skipped, total: msgs.length, email: profile.emailAddress, claudeError,
    claudeUsed: s.claudeMode === 'fallback' && !!s.anthropicKey
  };
}

// ---------- Application ----------
async function apply(payload, post) {
  const s = await settings();
  const opts = { ...s, ...(payload.options || {}) };
  post({ type: 'progress', text: `Libellé ${opts.labelName}…` });
  const labelId = await ensureLabel(opts.labelName);
  const report = [];
  const toTrash = new Set();

  for (const p of payload.proposals) {
    const cand = p.cand;
    try {
      if (p.edited) {
        post({ type: 'progress', text: `Re-vérification de ${q(cand)}…` });
        const v = await makeValidator(p.coverIds, labelId)(cand);
        if (!v.ok) { report.push({ query: q(cand), ok: false, msg: `annulé : ${v.reason}` }); continue; }
      }
      post({ type: 'progress', text: `Création du filtre ${q(cand)}…` });
      const action = { addLabelIds: [labelId] };
      if (opts.archive) action.removeLabelIds = ['INBOX'];
      try {
        await api('settings/filters', { method: 'POST', body: { criteria: filterCriteria(cand), action } });
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
      report.push({ query: q(cand), ok: true, msg: `filtre créé${opts.applyExisting ? `, appliqué à ${applied} mail(s) existant(s)` : ''}` });
    } catch (e) {
      report.push({ query: q(cand), ok: false, msg: e.message });
    }
  }

  let trashed = 0;
  if (toTrash.size) {
    post({ type: 'progress', text: `Mise à la corbeille de ${toTrash.size} spam(s) traité(s)…` });
    await pool([...toTrash], 4, async id => { await api(`messages/${id}/trash`, { method: 'POST' }); trashed++; });
  }
  return { report, trashed };
}

// ---------- Messagerie ----------
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'spam') return;
  const post = m => { try { port.postMessage(m); } catch (_) { /* panneau fermé */ } };
  port.onMessage.addListener(async msg => {
    try {
      if (msg.cmd === 'analyze') { const { anthropicKey, ...pub } = await settings(); post({ type: 'proposals', data: await analyze(post), settings: pub }); }
      if (msg.cmd === 'apply') post({ type: 'applied', data: await apply(msg, post) });
    } catch (e) {
      post({ type: 'error', text: e.message || String(e) });
    }
  });
});

chrome.action.onClicked.addListener(async tab => {
  if (tab.url && tab.url.startsWith('https://mail.google.com/')) {
    chrome.tabs.sendMessage(tab.id, { cmd: 'open' }).catch(() => {});
  } else {
    chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#spam' });
  }
});
