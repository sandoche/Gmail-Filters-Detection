/**
 * 04_Analyzer.gs — teste tous les filtres du compte sur un thread / message.
 */

function analyzeThread_(thread) {
  const startedAt = Date.now();
  const index = getFilterIndex_(false);
  const messages = thread.getMessages();

  // on regroupe par filtre : un filtre peut matcher plusieurs messages du thread
  const byFilterId = {};
  const order = [];
  let scanned = 0, skipped = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const mail = buildNormalizedMail_(msg);

    index.rules.forEach(function(rule) {
      if (rule.anchorTokens && !anyAnchorPresent_(rule.anchorTokens, mail.tokenSet)) { skipped++; return; }
      scanned++;
      const r = matchRule_(rule, mail);
      if (!r.matched) return;

      if (!byFilterId[rule.id]) {
        byFilterId[rule.id] = { rule: rule, reasons: r.reasons, preview: r.preview, messages: [] };
        order.push(rule.id);
      }
      byFilterId[rule.id].messages.push(i + 1);
    });
  }

  return {
    matches: order.map(function(id) { return byFilterId[id]; }),
    messageCount: messages.length,
    ruleCount: index.rules.length,
    scanned: scanned,
    skipped: skipped,
    fromCache: index.fromCache,
    builtAt: index.builtAt,
    elapsedMs: Date.now() - startedAt
  };
}

function anyAnchorPresent_(anchorTokens, tokenSet) {
  for (const k in anchorTokens) if (tokenSet[k]) return true;
  return false;
}

function matchRule_(rule, mail) {
  const r = evalQuery_(rule.ast, mail);
  if (!r.matched) return { matched: false };

  if (rule.hasAttachment && !mail.hasAttachment) return { matched: false };
  if (rule.size) {
    if (rule.sizeComparison === "larger" && !(mail.sizeBytes > rule.size)) return { matched: false };
    if (rule.sizeComparison === "smaller" && !(mail.sizeBytes < rule.size)) return { matched: false };
  }

  const seen = {};
  const hits = [];
  r.hits.forEach(function(leaf) {
    const d = describeLeaf_(leaf);
    if (!seen[d]) { seen[d] = true; hits.push(leaf); }
  });

  const reasons = hits.map(function(leaf) { return "✅ " + describeLeaf_(leaf); });
  if (!hits.length) reasons.push("✅ (critère sans texte : pièce jointe / taille / exclusion)");
  if (rule.hasAttachment) reasons.push("✅ pièce jointe");
  if (rule.size) reasons.push("✅ taille " + (rule.sizeComparison === "larger" ? ">" : "<") + " " + rule.size + " o");

  const first = hits.length ? hits[0] : null;
  let preview = (first && !first.field) ? extractPreviewAround_(mail.fullTextOriginalCase, normalizeFilterText_(first.text)) : "";
  hits.forEach(function(leaf) { if (!leaf.field) preview = markPhrase_(preview, leaf.text); });

  return { matched: true, hits: hits, reasons: reasons, preview: preview };
}

function buildNormalizedMail_(message) {
  const subject = message.getSubject() || "";
  const plainBody = safe_(function() { return message.getPlainBody(); });
  const htmlAsText = stripHtmlToText_(safe_(function() { return message.getBody(); }));
  const fromRaw = message.getFrom() || "";
  const toRaw = (message.getTo() || "") + "\n" + (message.getCc() || "") + "\n" + (message.getBcc() || "");

  const joinedOriginal = fromRaw + "\n" + toRaw + "\n" + subject + "\n" + plainBody + "\n" + htmlAsText;
  const normalizedAll = normalizeMailText_(joinedOriginal);
  const tokenSet = {};
  tokenizeForIndex_(normalizedAll).forEach(function(t) { tokenSet[t] = true; });

  let hasAttachment = false;
  try { hasAttachment = message.getAttachments({ includeInlineImages: false }).length > 0; } catch (e) {}

  return {
    fullTextOriginalCase: joinedOriginal,
    searchableText: normalizedAll,
    subject: normalizeMailText_(subject),
    fromText: normalizeMailText_(fromRaw),
    fromEmail: normalizeMailText_(extractEmailAddress_(fromRaw)),
    toText: normalizeMailText_(toRaw),
    tokenSet: tokenSet,
    hasAttachment: hasAttachment,
    sizeBytes: estimateMessageSizeBytes_(message)
  };
}

function safe_(fn) {
  try { return fn() || ""; } catch (e) { return ""; }
}

function estimateMessageSizeBytes_(message) {
  try {
    const apiMsg = Gmail.Users.Messages.get("me", message.getId(), { format: "minimal" });
    return apiMsg.sizeEstimate || 0;
  } catch (e) {
    return 0;
  }
}

/* ───────── « pourquoi ce libellé ? » : candidats approchants pour un libellé qu'aucun filtre n'explique ───────── */

/**
 * Pour un libellé présent sur le thread mais qu'aucun filtre ne déclenche exactement, cherche les filtres
 * qui posent ce libellé et dont les mots sont presque tous là (racines de mots, ordre différent, partiel).
 * @return {{ candidates: [{rule, score, reason, preview}], ruleCount: number }}
 */
function explainLabel_(thread, labelName) {
  const index = getFilterIndex_(false);
  const rules = index.rules.filter(function(r) {
    return r.addLabels.indexOf(labelName) >= 0 || (labelName === "TRASH" && r.isTrash);
  });
  const messages = thread.getMessages();
  const mails = messages.map(function(m) { return buildNormalizedMail_(m); });

  const out = [];
  rules.forEach(function(rule) {
    let best = null;
    mails.forEach(function(mail, mi) {
      if (matchRule_(rule, mail).matched) return;      // match exact : déjà listé dans « Pourquoi ces filtres ? »
      const r = approxMatchRule_(rule, mail);
      if (r && (!best || r.score > best.score)) { best = r; best.message = mi + 1; }
    });
    if (best) out.push({ rule: rule, score: best.score, reason: best.reason, preview: best.preview, message: best.message });
  });
  out.sort(function(a, b) { return b.score - a.score; });
  // on ne garde que le solide : racine de mot / phrase présente (3), ou tous les mots d'une phrase d'au moins 3 mots (2)
  const strong = out.filter(function(c) { return c.score >= 3 || (c.score === 2 && wordsOf_(normalizeFilterText_(c.rule.criteria.query || "")).length >= 3); });
  return { candidates: strong.slice(0, 8), ruleCount: rules.length };
}

/** Correspondance approchée d'une règle : renvoie {score, reason, preview} ou null. */
function approxMatchRule_(rule, mail) {
  const leaves = collectLeaves_(rule.ast);
  if (!leaves.length) return null;
  const mailTokens = wordsOf_(mail.searchableText);
  const mailSet = {};
  mailTokens.forEach(function(t) { mailSet[t] = true; });

  let total = 0, reasons = [], preview = "";
  leaves.forEach(function(leaf) {
    const needle = normalizeFilterText_(leaf.text);
    if (!needle) return;
    if (leaf.field === "from") {
      const dom = needle.split("@")[1] || "";
      if (mail.fromText.indexOf(needle) >= 0) { total += 3; reasons.push("expéditeur « " + leaf.text + " » présent"); }
      else if (dom && mail.fromEmail.indexOf(dom) >= 0) { total += 2; reasons.push("même domaine d'expéditeur (" + dom + ")"); }
      return;
    }
    const toks = wordsOf_(needle);
    if (!toks.length || !toks.some(function(t) { return /\p{L}{4,}/u.test(t); })) return;   // au moins un vrai mot de 4 lettres
    const stem = tokensInSequenceStemmed_(toks, mailTokens);
    if (stem) { total += 3; reasons.push(stem === toks.join(" ") ? "phrase « " + leaf.text + " » présente mot pour mot" : "racine de mot : « " + leaf.text + " » ≈ « " + stem + " »"); if (!preview) preview = extractPreviewAround_(mail.fullTextOriginalCase, stem.split(" ")[0]); return; }
    const present = toks.filter(function(t) { return mailSet[t] || (t.length >= 5 && mailTokens.some(function(m) { return m.length >= 5 && (m.indexOf(t) === 0 || t.indexOf(m) === 0) && Math.abs(m.length - t.length) <= 3; })); });
    if (!present.some(function(t) { return /\p{L}{4,}/u.test(t); })) return;               // que des petits mots / chiffres : pas significatif
    if (present.length === toks.length) { total += 2; reasons.push("tous les mots de « " + leaf.text + " » sont là, mais pas dans l'ordre / pas côte à côte"); if (!preview) preview = extractPreviewAround_(mail.fullTextOriginalCase, present[0]); }
    else if (present.length >= Math.max(1, Math.ceil(toks.length * 0.6))) { total += 1; reasons.push(present.length + "/" + toks.length + " mots de « " + leaf.text + " » présents (" + present.join(", ") + ")"); if (!preview) preview = extractPreviewAround_(mail.fullTextOriginalCase, present[0]); }
  });
  if (!total) return null;
  return { score: total, reason: reasons.join(" · "), preview: preview };
}

/** Mots (toutes écritures, cyrillique compris) d'un texte normalisé, sans les nombres seuls. */
function wordsOf_(s) {
  return String(s || "").split(/[^\p{L}\p{N}]+/u).filter(function(t) { return t && /\p{L}/u.test(t); });
}

/** Cherche la suite de mots (avec racines communes ≥ 5 lettres) dans les mots du mail ; renvoie la suite trouvée ou "". */
function tokensInSequenceStemmed_(toks, mailTokens) {
  const same = function(a, b) {
    if (a === b) return true;
    if (a.length < 5 || b.length < 5) return false;
    const p = Math.min(a.length, b.length);
    return a.substring(0, p) === b.substring(0, p) && Math.abs(a.length - b.length) <= 3;
  };
  for (let i = 0; i + toks.length <= mailTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < toks.length; j++) if (!same(toks[j], mailTokens[i + j])) { ok = false; break; }
    if (ok) return mailTokens.slice(i, i + toks.length).join(" ");
  }
  return "";
}

/** Test depuis l'éditeur : colle un texte et vois quels filtres le déclencheraient (Exécuter → Journal). */
function testTexte() {
  const texte = "UPS Access Point : votre colis est bloqué au dépôt, un accord de livraison est nécessaire";
  const from = "spEchQov@uhcci0tt.us";

  const joined = from + "\n\n" + texte;
  const mail = {
    fullTextOriginalCase: joined, searchableText: normalizeMailText_(joined),
    subject: "", fromText: normalizeMailText_(from), fromEmail: normalizeMailText_(from),
    toText: "", tokenSet: {}, hasAttachment: false, sizeBytes: 1000
  };
  tokenizeForIndex_(mail.searchableText).forEach(function(t) { mail.tokenSet[t] = true; });

  const index = getFilterIndex_(false);
  Logger.log(index.rules.length + " filtres chargés" + (index.fromCache ? " (cache)" : " (API)"));
  index.rules.forEach(function(rule) {
    const r = matchRule_(rule, mail);
    if (r.matched) Logger.log(rule.description + "  →  " + rule.actions.join(", ") + "  |  " + r.reasons.join(" "));
  });
}