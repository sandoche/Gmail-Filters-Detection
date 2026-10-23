// Moteur d'analyse local : propose des critères de filtre pour un spam.
// Fonctions pures (testables sous Node).

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr', 'hotmail.com', 'hotmail.fr',
  'outlook.com', 'outlook.fr', 'live.com', 'live.fr', 'msn.com', 'icloud.com', 'me.com',
  'aol.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'gmx.com',
  'gmx.fr', 'proton.me', 'protonmail.com', 'yandex.com', 'mail.ru', 'bbox.fr'
]);

const STOP = new Set(('a an the of to in on at for from by with and or is are be been was were it this that ' +
  'you your yours we our us i me my he she they them his her its as not no yes do does did have has had ' +
  'will can may just now here there all any le la les un une des de du d l à a au aux et ou en dans sur ' +
  'pour par avec ce cet cette ces vous votre vos nous notre nos je tu il elle ils elles est sont été être ' +
  'avoir a ont pas ne plus qui que quoi se sa son ses leur leurs y').split(' '));

const GENERIC = /unsubscribe|d[ée]sinscri|d[ée]sabonn|click here|cliquez ici|view (it )?in (your )?browser|privacy|confidentialit|all rights reserved|tous droits|copyright|si vous ne souhaitez|if you (no longer )?wish/i;

const WORD_RE = /^[A-Za-zÀ-ÖØ-öø-ÿŒœ'’]+$/;

export function decodeB64Url(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export function headerMap(payload) {
  const m = {};
  for (const h of (payload && payload.headers) || []) {
    const k = h.name.toLowerCase();
    (m[k] = m[k] || []).push(h.value);
  }
  return m;
}

export function parseAddress(value) {
  if (!value) return { name: '', email: '' };
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: value.trim().replace(/[<>]/g, '').toLowerCase() };
}

export function domainOf(email) {
  const i = (email || '').lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}

function entropy(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  let e = 0;
  for (const k in f) { const p = f[k] / s.length; e -= p * Math.log2(p); }
  return e;
}

// Un libellé (partie de domaine ou d'adresse) qui a l'air généré au hasard.
export function looksRandom(label) {
  const s = (label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.length < 8) return false;
  const digits = (s.match(/\d/g) || []).length;
  const vowels = (s.match(/[aeiouy]/g) || []).length;
  const letters = (s.match(/[a-z]/g) || []).length;
  const consRun = Math.max(0, ...(s.match(/[bcdfghjklmnpqrstvwxz]+/g) || ['']).map(x => x.length));
  let score = 0;
  if (digits >= 2 && letters >= 4) score++;
  if (letters && vowels / letters < 0.25) score++;
  if (consRun >= 5) score++;
  if (s.length >= 14 && entropy(s) > 3.6) score++;
  if (/\d[a-z]+\d/.test(s)) score++;
  return score >= 2;
}

export function domainLooksRandom(domain) {
  const parts = (domain || '').split('.').filter(Boolean);
  if (parts.length < 2) return true;
  return parts.slice(0, -1).some(looksRandom);
}

// Texte visible d'un HTML (sans DOMParser : utilisable dans un service worker).
export function htmlToText(html) {
  return (html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h\d|center|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Corps texte et HTML d'un message (format=full), pièces jointes exclues.
export function bodyParts(payload) {
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data) plain += decodeB64Url(p.body.data) + '\n';
    else if (p.mimeType === 'text/html' && p.body && p.body.data) html += decodeB64Url(p.body.data) + '\n';
    for (const c of p.parts || []) walk(c);
  })(payload);
  return { plain: plain.trim(), html: html.trim() };
}

export function bodyText(payload) {
  const { plain, html } = bodyParts(payload);
  return plain || htmlToText(html);
}

// Découpe un texte en suites de « vrais » mots (sans chiffres, sans homoglyphes, sans le nom de l'utilisateur).
export function cleanSegments(text, userTokens = []) {
  const banned = new Set(userTokens.map(t => t.toLowerCase()));
  const segments = [];
  let cur = [];
  const flush = () => { if (cur.length) segments.push(cur); cur = []; };
  const tokens = (text || '').normalize('NFC').split(/(\s+|[,;:!?.()\[\]{}"«»|\/_*#=+<>~^]+)/);
  for (const raw of tokens) {
    if (!raw) continue;
    if (/^\s+$/.test(raw)) continue;
    if (/^[,;:!?.()\[\]{}"«»|\/_*#=+<>~^]+$/.test(raw)) { flush(); continue; }
    const w = raw.replace(/^['’-]+|['’-]+$/g, '');
    if (!w || !WORD_RE.test(w) || banned.has(w.toLowerCase())) { flush(); continue; }
    cur.push(w);
  }
  flush();
  return segments;
}

function contentWords(words) {
  return words.filter(w => !STOP.has(w.toLowerCase()) && w.length > 2).length;
}

function phrasesFromSegments(segments, { min = 3, max = 7 } = {}) {
  const out = [];
  for (const seg of segments) {
    if (seg.length < min) continue;
    if (seg.length <= max) out.push(seg);
    else { out.push(seg.slice(0, max - 1)); out.push(seg.slice(-(max - 1))); }
  }
  return out
    .filter(ws => contentWords(ws) >= 2)
    .map(ws => ws.join(' '));
}

export function q(c) {
  if (c.type === 'subject') return `subject:"${c.value}"`;
  if (c.type === 'query') return `"${c.value}"`;
  if (c.type === 'from') return `from:(${c.value})`;
  return c.value;
}

export function filterCriteria(c) {
  if (c.type === 'subject') return { subject: `"${c.value}"` };
  if (c.type === 'query') return { query: `"${c.value}"` };
  if (c.type === 'from') return { from: c.value };
  return { query: c.value };
}

export function key(c) { return `${c.type}|${c.value.toLowerCase()}`; }

const TYPE_RANK = { from: 3, subject: 2, query: 1, fromname: 0 };
export function rank(c) { return TYPE_RANK[c.kind || c.type] ?? 0; }

// Candidats pour un message Gmail (format=full).
export function candidatesFor(msg, userEmail = '') {
  const h = headerMap(msg.payload);
  const from = parseAddress((h['from'] || [''])[0]);
  const subject = (h['subject'] || [''])[0];
  const local = (userEmail.split('@')[0] || '').toLowerCase();
  const userTokens = [local, ...local.split(/[._+-]/)].filter(t => t.length >= 3);
  const out = [];
  const seen = new Set();
  const add = c => { const k = key(c); if (!seen.has(k)) { seen.add(k); out.push(c); } };

  const dom = domainOf(from.email);
  const localPart = from.email.split('@')[0] || '';
  if (dom && !FREEMAIL.has(dom) && !domainLooksRandom(dom)) {
    add({ type: 'from', value: '@' + dom, label: `Expéditeur du domaine ${dom}` });
  } else if (dom && FREEMAIL.has(dom) && !looksRandom(localPart)) {
    add({ type: 'from', value: from.email, label: `Adresse ${from.email}` });
  }

  for (const p of phrasesFromSegments(cleanSegments(subject, userTokens))) {
    add({ type: 'subject', value: p, label: 'Phrase exacte dans l’objet' });
  }

  const body = bodyText(msg.payload);
  let n = 0;
  for (const line of body.split(/\n|(?<=[.!?])\s+/)) {
    if (n >= 4) break;
    if (GENERIC.test(line)) continue;
    for (const p of phrasesFromSegments(cleanSegments(line, userTokens), { min: 4, max: 8 })) {
      if (n >= 4) break;
      add({ type: 'query', value: p, label: 'Phrase exacte dans le mail' });
      n++;
    }
  }

  // Nom affiché (ex. « Cloud_Storage_Team ») : seulement s'il est propre et assez long.
  const nameWords = cleanSegments(from.name.replace(/_/g, ' '), userTokens).flat();
  if (nameWords.length >= 2 && nameWords.join(' ').length >= 10) {
    add({ type: 'from', kind: 'fromname', value: `"${nameWords.join(' ')}"`, label: 'Nom d’expéditeur affiché' });
  }

  return out.slice(0, 8);
}

export function summary(msg) {
  const h = headerMap(msg.payload);
  const auth = (h['authentication-results'] || []).join(' ');
  const dmarc = (auth.match(/dmarc=(\w+)/i) || [])[1] || '?';
  return {
    id: msg.id,
    from: (h['from'] || [''])[0],
    subject: (h['subject'] || [''])[0],
    returnPath: (h['return-path'] || [''])[0],
    dmarc,
    snippet: msg.snippet || ''
  };
}

// Couverture gloutonne : choisit le moins de critères possible pour couvrir les spams.
// valid : [{cand, covers:Set(ids du lot)}] — déjà filtrés (0 mail légitime, couvre au moins son spam).
export function greedyCover(valid, ids) {
  const left = new Set(ids);
  const chosen = [];
  while (left.size) {
    let best = null, bestGain = 0;
    for (const v of valid) {
      const gain = [...v.covers].filter(i => left.has(i)).length;
      if (!gain) continue;
      const better = !best || gain > bestGain ||
        (gain === bestGain && rank(v.cand) > rank(best.cand)) ||
        (gain === bestGain && rank(v.cand) === rank(best.cand) && v.cand.value.length > best.cand.value.length);
      if (better) { best = v; bestGain = gain; }
    }
    if (!best) break;
    chosen.push({ ...best, covers: new Set([...best.covers].filter(i => left.has(i))) });
    for (const i of best.covers) left.delete(i);
  }
  return { chosen, uncovered: [...left] };
}
