// Moteur d'analyse local : propose des critères de filtre pour un spam.
// Fonctions pures (testables sous Node).

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

// Sous-phrases courtes (fenêtres de `sizes` mots) : plus générales que la phrase entière, elles attrapent aussi
// les variantes d'une même campagne. On garde les `k` plus « parlantes » (le plus de mots porteurs de sens),
// sans mot vide en début ni en fin.
function shortPhrases(segments, { sizes = [3, 4], k = 4 } = {}) {
  const seen = new Set(), out = [];
  for (const seg of segments) {
    for (const n of sizes) {
      for (let i = 0; i + n <= seg.length; i++) {
        const ws = seg.slice(i, i + n);
        if (STOP.has(ws[0].toLowerCase()) || STOP.has(ws[n - 1].toLowerCase()) || contentWords(ws) < 2) continue;
        const p = ws.join(' ');
        if (seen.has(p.toLowerCase())) continue;
        seen.add(p.toLowerCase());
        out.push({ p, score: ws.filter(w => !STOP.has(w.toLowerCase())).reduce((s, w) => s + Math.min(w.length, 9), 0) });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || a.p.length - b.p.length).slice(0, k).map(x => x.p);
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

const TYPE_RANK = { subject: 2, query: 1 };
export function rank(c) { return TYPE_RANK[c.kind || c.type] ?? 0; }

// Candidats pour un message Gmail (format=full) : uniquement des mots (phrase exacte de l'objet ou du corps),
// jamais l'expéditeur — les spammeurs changent d'adresse et de domaine à chaque envoi, pas de texte.
export function candidatesFor(msg, userEmail = '') {
  const h = headerMap(msg.payload);
  const subject = (h['subject'] || [''])[0];
  const local = (userEmail.split('@')[0] || '').toLowerCase();
  const userTokens = [local, ...local.split(/[._+-]/)].filter(t => t.length >= 3);
  const out = [];
  const seen = new Set();
  const add = c => { const k = key(c); if (!seen.has(k)) { seen.add(k); out.push(c); } };

  const subjSegs = cleanSegments(subject, userTokens);
  for (const p of phrasesFromSegments(subjSegs)) add({ type: 'subject', value: p, label: 'Phrase exacte dans l’objet' });
  for (const p of shortPhrases(subjSegs)) add({ type: 'subject', value: p, label: 'Morceau de l’objet' });

  const body = bodyText(msg.payload);
  const bodySegs = [];
  let n = 0;
  for (const line of body.split(/\n|(?<=[.!?])\s+/)) {
    if (n >= 3) break;
    if (GENERIC.test(line)) continue;
    const segs = cleanSegments(line, userTokens);
    for (const p of phrasesFromSegments(segs, { min: 4, max: 8 })) {
      if (n >= 3) break;
      add({ type: 'query', value: p, label: 'Phrase exacte dans le mail' });
      bodySegs.push(...segs);
      n++;
    }
  }
  for (const p of shortPhrases(bodySegs, { sizes: [3, 4], k: 2 })) add({ type: 'query', value: p, label: 'Morceau du texte' });

  return out.slice(0, 12);
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

// Meilleur critère d'abord : celui qui attrape le plus de spams déjà reçus (`total` : Spam, corbeille, libellé),
// puis la phrase la plus courte (plus générale : elle attrape aussi les variantes de la campagne).
export function better(a, b) {
  return (b.total || 0) - (a.total || 0) || a.cand.value.length - b.cand.value.length || rank(b.cand) - rank(a.cand);
}

// Couverture gloutonne : choisit le moins de critères possible pour couvrir les spams.
// valid : [{cand, covers:Set(ids du lot), total}] — déjà filtrés (0 mail légitime, couvre au moins son spam).
export function greedyCover(valid, ids) {
  const left = new Set(ids);
  const chosen = [];
  while (left.size) {
    let best = null, bestGain = 0;
    for (const v of valid) {
      const gain = [...v.covers].filter(i => left.has(i)).length;
      if (!gain) continue;
      const isBetter = !best || gain > bestGain || (gain === bestGain && better(v, best) < 0);
      if (isBetter) { best = v; bestGain = gain; }
    }
    if (!best) break;
    chosen.push({ ...best, covers: new Set([...best.covers].filter(i => left.has(i))) });
    for (const i of best.covers) left.delete(i);
  }
  return { chosen, uncovered: [...left] };
}
