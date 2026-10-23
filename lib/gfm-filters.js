// Index des filtres Gmail, signatures, sauvegarde XML et simplification
// (port de legacy-apps-script/gmail-filter-manager/01_Filters.gs et 08_ImportExport.gs).
import { normalizeFilterText_, chooseAnchorToken_ } from './gfm-text.js';
import { parseGmailQuery_, collectLeaves_ } from './gfm-query.js';

/** Union par id de plusieurs lectures brutes ({labels, filters}) ; la première lecture donne la version d'un filtre. */
function unionRaw_(raws) {
  const seenF = {}, seenL = {};
  const out = { builtAt: Date.now(), labels: [], filters: [] };
  raws.forEach(function(r) {
    if (!r) return;
    (r.filters || []).forEach(function(f) { if (f && f.id && !seenF[f.id]) { seenF[f.id] = true; out.filters.push(f); } });
    (r.labels || []).forEach(function(l) { if (l && l.id && !seenL[l.id]) { seenL[l.id] = true; out.labels.push(l); } });
  });
  return out;
}

function buildIndexFromRaw_(raw) {
  const labelsById = {};
  const labelsByName = {};
  (raw.labels || []).forEach(function(l) {
    labelsById[l.id] = l.name;
    labelsByName[l.name] = l.id;
  });

  const rules = (raw.filters || []).map(function(f) {
    return buildRule_(f, labelsById);
  });

  // les filtres les plus "précis" d'abord (plus de critères / phrases longues)
  rules.sort(function(a, b) { return b.specificity - a.specificity; });

  return { rules: rules, labelsById: labelsById, labelsByName: labelsByName, builtAt: raw.builtAt || Date.now() };
}

function buildRule_(f, labelsById) {
  const c = f.criteria || {};
  const a = f.action || {};

  const queryParts = [];
  if (c.from) queryParts.push("from:(" + c.from + ")");
  if (c.to) queryParts.push("to:(" + c.to + ")");
  if (c.subject) queryParts.push("subject:(" + c.subject + ")");
  if (c.query) queryParts.push("(" + c.query + ")");
  if (c.negatedQuery) queryParts.push("-(" + c.negatedQuery + ")");
  const queryText = queryParts.join(" ");

  const ast = parseGmailQuery_(queryText);
  const leaves = collectLeaves_(ast);

  const anchorTokens = {};
  let anchorable = leaves.length > 0;
  leaves.forEach(function(leaf) {
    const t = chooseAnchorToken_(normalizeFilterText_(leaf.text));
    if (t) anchorTokens[t] = true; else anchorable = false;
  });

  // actions lisibles
  const actions = [];
  const addLabels = [];
  (a.addLabelIds || []).forEach(function(id) {
    if (id === "TRASH") actions.push("🗑️ corbeille");
    else if (id === "STARRED") actions.push("⭐ étoile");
    else if (id === "IMPORTANT") actions.push("❗ important");
    else if (id === "SPAM") actions.push("🚫 spam");
    else { const n = labelsById[id] || id; addLabels.push(n); actions.push("🏷️ " + n); }
  });
  (a.removeLabelIds || []).forEach(function(id) {
    if (id === "INBOX") actions.push("📥 archiver");
    else if (id === "UNREAD") actions.push("👁️ marquer lu");
    else if (id === "SPAM") actions.push("✅ jamais spam");
    else if (id === "IMPORTANT") actions.push("jamais important");
    else actions.push("− " + (labelsById[id] || id));
  });
  if (a.forward) actions.push("↪️ transférer à " + a.forward);

  const critDesc = [];
  if (c.from) critDesc.push("from: " + c.from);
  if (c.to) critDesc.push("to: " + c.to);
  if (c.subject) critDesc.push("subject: " + c.subject);
  if (c.query) critDesc.push(c.query);
  if (c.negatedQuery) critDesc.push("sans: " + c.negatedQuery);
  if (c.hasAttachment) critDesc.push("avec pièce jointe");
  if (c.size) critDesc.push("taille " + (c.sizeComparison === "larger" ? ">" : "<") + " " + c.size + " o");

  return {
    id: f.id,
    criteria: c,
    rawAction: a,
    queryText: queryText,
    ast: ast,
    leafCount: leaves.length,
    anchorTokens: anchorable ? anchorTokens : null,
    hasAttachment: !!c.hasAttachment,
    size: c.size || 0,
    sizeComparison: c.sizeComparison || "",
    actions: actions,
    addLabels: addLabels,
    isTrash: (a.addLabelIds || []).indexOf("TRASH") >= 0,
    description: critDesc.join(" · ") || "(sans critère)",
    specificity: queryText.length + (c.from ? 50 : 0) + (c.negatedQuery ? 20 : 0)
  };
}

function xmlAttr_(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/'/g, "&apos;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function actionFromRule_(r) {
  return r.rawAction || {};
}

/**
 * Texte d'un critère comparé au caractère près : seules la casse, les espaces en trop et les guillemets
 * extérieurs sont ignorés. Les accents, tirets, points et « _ » comptent (« érection » ≠ « erection »,
 * « Dating-Site » ≠ « dating site ») : des variantes voulues contre les spammeurs.
 */
function strictText_(s) {
  let x = String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (x.length >= 2 && x[0] === '"' && x[x.length - 1] === '"') x = x.slice(1, -1).trim();
  return x;
}

/** Signature exacte (critères au caractère près + actions) : sert aux doublons et au refus de recréer un filtre. */
function strictSignature_(criteria, action) {
  const c = criteria || {}, a = action || {};
  return [
    strictText_(c.from), strictText_(c.to), strictText_(c.subject), strictText_(c.query), strictText_(c.negatedQuery),
    c.hasAttachment ? "att" : "", c.size ? (c.sizeComparison + c.size) : "",
    (a.addLabelIds || []).slice().sort().join(","), (a.removeLabelIds || []).slice().sort().join(","), a.forward || ""
  ].join("|");
}

/** `needle` apparaît-il tel quel dans `hay`, comme mot entier (lettres, chiffres et « _ » font partie des mots) ? */
function containsExactWords_(hay, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^\\p{L}\\p{N}_])" + esc + "($|[^\\p{L}\\p{N}_])", "u").test(hay);
}

/* ───────── sauvegarde XML (réimportable par Gmail → Paramètres → Filtres → Importer) ───────── */

function exportXml_(index) {
  const lines = [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    "\t<title>Mail Filters</title>"
  ];
  index.rules.forEach(function(r) {
    const c = r.criteria;
    const a = actionFromRule_(r);
    const p = [];
    if (c.from) p.push(["from", c.from]);
    if (c.to) p.push(["to", c.to]);
    if (c.subject) p.push(["subject", c.subject]);
    if (c.query) p.push(["hasTheWord", c.query]);
    if (c.negatedQuery) p.push(["doesNotHaveTheWord", c.negatedQuery]);
    if (c.hasAttachment) p.push(["hasAttachment", "true"]);
    (a.addLabelIds || []).forEach(function(id) {
      if (id === "TRASH") p.push(["shouldTrash", "true"]);
      else if (id === "STARRED") p.push(["shouldStar", "true"]);
      else if (id === "IMPORTANT") p.push(["shouldAlwaysMarkAsImportant", "true"]);
      else p.push(["label", index.labelsById[id] || id]);
    });
    (a.removeLabelIds || []).forEach(function(id) {
      if (id === "INBOX") p.push(["shouldArchive", "true"]);
      else if (id === "UNREAD") p.push(["shouldMarkAsRead", "true"]);
      else if (id === "SPAM") p.push(["shouldNeverSpam", "true"]);
      else if (id === "IMPORTANT") p.push(["shouldNeverMarkAsImportant", "true"]);
    });
    if (a.forward) p.push(["forwardTo", a.forward]);
    if (c.size) { p.push(["size", String(c.size)]); p.push(["sizeOperator", c.sizeComparison === "larger" ? "s_sl" : "s_ss"]); p.push(["sizeUnit", "s_sb"]); }

    lines.push("\t<entry>");
    lines.push("\t\t<category term='filter'></category>");
    lines.push("\t\t<title>Mail Filter</title>");
    lines.push("\t\t<id>tag:mail.google.com,2008:filter:" + r.id + "</id>");
    lines.push("\t\t<content></content>");
    p.forEach(function(kv) { lines.push("\t\t<apps:property name='" + kv[0] + "' value='" + xmlAttr_(kv[1]) + "'/>"); });
    lines.push("\t</entry>");
  });
  lines.push("</feed>");
  return lines.join("\n");
}

/* ───────── simplification des filtres existants ───────── */

const MERGE_MAX_CHARS = 1000;   // longueur maximale d'un critère fusionné (Gmail refuse les critères trop longs)

/** Groupes de doublons (mêmes critères au caractère près + mêmes actions), le plus ancien (id le plus petit) en tête. */
function findDuplicateGroups_(index) {
  const bySig = {};
  index.rules.forEach(function(r) {
    const sig = strictSignature_(r.criteria, actionFromRule_(r));
    (bySig[sig] = bySig[sig] || []).push(r);
  });
  return Object.keys(bySig).map(function(k) { return bySig[k]; })
    .filter(function(g) { return g.length > 1; })
    .map(function(g) { return g.slice().sort(function(a, b) { return a.id < b.id ? -1 : 1; }); });
}

/** Filtre « simple » : un seul mot / une seule phrase dans un seul champ (from ou mots-clés), sans autre condition. */
function simpleTerm_(rule) {
  const c = rule.criteria;
  const fields = ["from", "to", "subject", "query"].filter(function(k) { return c[k]; });
  if (fields.length !== 1 || c.negatedQuery || c.hasAttachment || c.size) return null;
  if (!rule.ast || rule.ast.type !== "leaf") return null;          // déjà un OR, un ET ou une exclusion
  const needle = strictText_(rule.ast.text);
  if (!needle) return null;
  return { critKey: fields[0], text: rule.ast.text, quoted: rule.ast.quoted, needle: needle };
}

/**
 * Le terme court `b` attrape-t-il tout ce qu'attrape `a` (même champ) ? Seulement s'il y figure tel quel,
 * accents et ponctuation compris : « dick » couvre « big dick », mais « érection » ne couvre pas « erection muscle ».
 */
function termCovers_(b, a) {
  if (b.needle === a.needle || b.needle.length >= a.needle.length) return false;
  return b.critKey === "from" || b.critKey === "to" ? a.needle.indexOf(b.needle) >= 0 : containsExactWords_(a.needle, b.needle);
}

/**
 * Plan de simplification, sans rien modifier :
 *  - duplicates : mêmes critères et mêmes actions → on garde le plus ancien ;
 *  - overlaps   : un filtre court (« dick ») attrape déjà tout ce qu'attrapent des filtres plus précis
 *                 (« big dick »), même champ et mêmes actions. Qui garder dépend des vrais mails : si le court
 *                 n'attrape aucun mail légitime, les précis sont inutiles ; sinon il est trop large (testé côté
 *                 service worker par une recherche Gmail) ;
 *  - merges     : filtres simples restants (mots-clés ou expéditeur) aux mêmes actions → un seul filtre « a OR b OR … ».
 */
function simplifyPlan_(index) {
  const removed = {};
  const duplicates = findDuplicateGroups_(index).map(function(g) {
    g.slice(1).forEach(function(r) { removed[r.id] = true; });
    return { keep: g[0], remove: g.slice(1) };
  });

  const groups = {};
  index.rules.forEach(function(r) {
    if (removed[r.id]) return;
    const t = simpleTerm_(r);
    if (!t) return;
    const k = strictSignature_({}, actionFromRule_(r)) + "#" + t.critKey;
    (groups[k] = groups[k] || []).push({ rule: r, term: t });
  });

  const overlaps = [], merges = [];
  Object.keys(groups).forEach(function(k) {
    const items = groups[k].sort(function(x, y) { return x.term.needle.length - y.term.needle.length; });
    const kept = [];
    const byBroad = new Map();
    items.forEach(function(it) {
      const broad = kept.find(function(b) { return termCovers_(b.term, it.term); });
      if (!broad) { kept.push(it); return; }
      if (!byBroad.has(broad)) { byBroad.set(broad, { broad: broad.rule, narrows: [] }); overlaps.push(byBroad.get(broad)); }
      byBroad.get(broad).narrows.push(it.rule);
    });

    const critKey = kept.length ? kept[0].term.critKey : "";
    if (kept.length < 2 || (critKey !== "query" && critKey !== "from")) return;
    let chunk = [], len = 0;
    const flush = function() {
      if (chunk.length >= 2) {
        const value = chunk.map(function(it) { return it.term.quoted ? '"' + it.term.text + '"' : it.term.text; }).join(" OR ");
        const criteria = {}; criteria[critKey] = value;
        merges.push({ criteria: criteria, action: actionFromRule_(chunk[0].rule), rules: chunk.map(function(it) { return it.rule; }) });
      }
      chunk = []; len = 0;
    };
    kept.forEach(function(it) {
      const piece = it.term.text.length + 6;      // guillemets + « OR »
      if (len + piece > MERGE_MAX_CHARS) flush();
      chunk.push(it); len += piece;
    });
    flush();
  });

  return { duplicates: duplicates, overlaps: overlaps, merges: merges, total: index.rules.length };
}

export {
  unionRaw_,
  buildIndexFromRaw_,
  buildRule_,
  actionFromRule_,
  strictSignature_,
  exportXml_,
  findDuplicateGroups_,
  simplifyPlan_
};
