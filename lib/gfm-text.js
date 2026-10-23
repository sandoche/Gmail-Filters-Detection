// Normalisation du texte (port de legacy-apps-script/gmail-filter-manager/03_Text.gs et 07_Utils.gs).

function normalizeFilterText_(s) {
  let x = String(s || "").trim();
  if (x.length >= 2 && x.startsWith('"') && x.endsWith('"')) {
    x = x.substring(1, x.length - 1);
  }
  return normalizeMailText_(x);
}

function normalizeMailText_(s) {
  let x = String(s || "");
  x = decodeXmlEntities_(x);
  x = x.replace(/[\u2019\u2018\u02BC\u201B\u2032`\u00B4]/g, "'");   // apostrophes typographiques → ' (Gmail les confond)
  x = x.replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"');                 // guillemets typographiques → "
  x = x.replace(/[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g, "");            // caractères de largeur nulle / trait d'union conditionnel
  x = removeDiacritics_(x);
  x = x.replace(/[^\p{L}\p{N}]+/gu, " ");         // ponctuation, tirets, @, . → séparateurs (Gmail cherche des mots, pas des signes)
  x = x.replace(/\s+/g, " ").trim();
  return x.toLowerCase();
}

function decodeXmlEntities_(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}

function stripHtmlToText_(html) {
  let x = String(html || "");
  x = x.replace(/<style[\s\S]*?<\/style>/gi, " ");
  x = x.replace(/<script[\s\S]*?<\/script>/gi, " ");
  x = x.replace(/<br\s*\/?>/gi, " ");
  x = x.replace(/<\/p>/gi, " ");
  x = x.replace(/<[^>]+>/g, " ");
  return x;
}

function removeDiacritics_(s) {
  try {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch (e) {
    return s;
  }
}

function tokenizeForIndex_(s) {
  return String(s || "")
    .split(/[^a-z0-9]+/i)
    .map(function(t) { return t.trim().toLowerCase(); })
    .filter(function(t) { return t.length >= 3; });
}

function chooseAnchorToken_(normalizedPhrase) {
  const blacklist = {
    "avec": true, "pour": true, "dans": true, "vous": true, "votre": true,
    "your": true, "the": true, "and": true, "from": true, "this": true,
    "that": true, "have": true, "nous": true, "plus": true,
    "des": true, "une": true, "les": true, "sur": true, "est": true,
    "are": true, "not": true, "pas": true, "tout": true, "more": true
  };
  const tokens = tokenizeForIndex_(normalizedPhrase).filter(function(t) { return !blacklist[t]; });
  if (!tokens.length) return "";
  tokens.sort(function(a, b) { return b.length - a.length; });
  return tokens[0];
}

/** Extrait du texte original autour de la 1re occurrence (recherche sur texte normalisé). */
function extractPreviewAround_(originalText, normalizedNeedle) {
  const original = String(originalText || "");
  const normalizedOriginal = normalizeMailText_(original);
  const idx = normalizedOriginal.indexOf(normalizedNeedle);
  if (idx < 0) return "";
  const start = Math.max(0, idx - 120);
  const end = Math.min(original.length, idx + normalizedNeedle.length + 120);
  return "..." + original.substring(start, end).replace(/\s+/g, " ") + "...";
}

/**
 * Entoure chaque occurrence de la phrase (insensible à la casse, aux accents, aux _ - et
 * espaces multiples) avec les marqueurs ⟦ … ⟧ (U+27E6/27E7), que l'UI transforme en surlignage.
 */
function markPhrase_(text, needle) {
  const n = String(needle || "").trim();
  if (!n || !text) return text;
  const ACC = { a: "aàáâãäå", e: "eèéêë", i: "iìíîï", o: "oòóôõö", u: "uùúûü", c: "cç", n: "nñ", y: "yÿ" };
  const SEP = "[\\s_\\-–—]+";
  let rx = "";
  n.toLowerCase().split("").forEach(function(ch) {
    if (/[\s_\-–—]/.test(ch)) { if (!rx.endsWith(SEP)) rx += SEP; }
    else if (ACC[ch]) rx += "[" + ACC[ch] + ACC[ch].toUpperCase() + "]";
    else rx += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  try {
    return String(text).replace(new RegExp(rx, "gi"), function(m) { return "\u27E6" + m + "\u27E7"; });
  } catch (e) {
    return text;
  }
}

function extractEmailAddress_(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  const m2 = s.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
  if (m2 && m2[0]) return m2[0].trim();
  return s;
}

function safe_(fn) {
  try { return fn() || ""; } catch (e) { return ""; }
}

export {
  normalizeFilterText_,
  normalizeMailText_,
  decodeXmlEntities_,
  stripHtmlToText_,
  removeDiacritics_,
  tokenizeForIndex_,
  chooseAnchorToken_,
  extractPreviewAround_,
  markPhrase_,
  extractEmailAddress_,
  safe_
};
