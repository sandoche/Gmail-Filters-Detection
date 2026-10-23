/**
 * 07_Utils.gs — utilitaires.
 */

function getLastMessageOfThread_(thread) {
  const messages = thread.getMessages();
  return messages[messages.length - 1];
}

function escapeHtml_(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeErrorMessage_(err) {
  if (!err) return "Erreur inconnue";
  if (err.message) return String(err.message);
  return String(err);
}

function formatError_(where, err) {
  let msg = "Erreur " + where + " : " + safeErrorMessage_(err);
  if (/Gmail is not defined/.test(msg)) {
    msg += " — active le service avancé Gmail : éditeur Apps Script → Services (+) → Gmail API → Ajouter.";
  }
  if (APP_CONFIG.DEBUG_INCLUDE_STACK && err && err.stack) {
    msg += " | " + String(err.stack).split("\n").slice(0, 3).join(" | ");
  }
  return msg;
}

function extractEmailAddress_(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  const m2 = s.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
  if (m2 && m2[0]) return m2[0].trim();
  return s;
}

/** Depuis l'éditeur : liste les filtres tels que lus par l'API (contrôle). */
function debugListFilters() {
  const idx = getFilterIndex_(true);
  Logger.log(idx.rules.length + " filtres");
  idx.rules.slice(0, 20).forEach(function(r) {
    Logger.log(r.id + " | " + r.description + " → " + r.actions.join(", "));
  });
}

/**
 * DIAGNOSTIC — Éditeur → Exécuter → Journal.
 * Vérifie, pour une phrase de filtre et un mail, où ça coince : filtre présent côté API ? dans le cache ?
 * dans l'index ? et le moteur le fait-il matcher sur le mail ?  Modifie les 2 constantes puis exécute.
 */
function diagnoseFilter() {
  const PHRASE = "Mon Petit Placement";                 // ← texte du filtre à chercher
  const SEARCH = "from:monpetitplacement.fr";           // ← recherche Gmail qui trouve le mail à tester

  const needle = PHRASE.toLowerCase();
  const has = function(f) { return JSON.stringify(f.criteria || {}).toLowerCase().indexOf(needle) >= 0; };

  // 1. API en direct
  const api = (Gmail.Users.Settings.Filters.list("me").filter) || [];
  const inApi = api.filter(has);
  Logger.log("1) API Gmail : " + api.length + " filtres · " + inApi.length + " contenant « " + PHRASE + " »" +
             (inApi.length ? " → " + inApi.map(function(f) { return f.id + " " + JSON.stringify(f.criteria) + " " + JSON.stringify(f.action); }).join(" | ") : ""));

  // 2. cache (Drive / CacheService)
  const raw = readCachedRaw_();
  const inCache = raw ? raw.filters.filter(has) : [];
  Logger.log("2) Cache : " + (raw ? raw.filters.length + " filtres (écrit " + new Date(raw.builtAt) + ") · " + inCache.length + " contenant la phrase" : "AUCUN cache"));

  // 3. index construit
  const idx = getFilterIndex_(false);
  const rules = idx.rules.filter(function(r) { return r.description.toLowerCase().indexOf(needle) >= 0; });
  Logger.log("3) Index : " + idx.rules.length + " règles (" + (idx.fromCache ? "cache" : "API") + ") · " + rules.length + " contenant la phrase");

  // 4. le mail
  const threads = GmailApp.search(SEARCH, 0, 1);
  if (!threads.length) { Logger.log("4) Aucun mail trouvé pour « " + SEARCH + " »"); return; }
  const msg = getLastMessageOfThread_(threads[0]);
  const mail = buildNormalizedMail_(msg);
  Logger.log("4) Mail : « " + msg.getSubject() + " » de " + msg.getFrom() + " · libellés : " + threads[0].getLabels().map(function(l) { return l.getName(); }).join(", "));
  Logger.log("   texte normalisé (250 premiers car.) : " + mail.searchableText.substring(0, 250));
  Logger.log("   phrase normalisée : « " + normalizeFilterText_(PHRASE) + " » · containsWholeWords_ direct : " + containsWholeWords_(mail.searchableText, normalizeFilterText_(PHRASE)));

  // 5. le moteur sur ces règles
  rules.forEach(function(r) {
    const m = matchRule_(r, mail);
    Logger.log("5) " + r.description + " → " + (m.matched ? "✅ MATCH" : "❌ pas de match") +
               " · ancres " + JSON.stringify(r.anchorTokens) + " présentes ? " + (r.anchorTokens ? anyAnchorPresent_(r.anchorTokens, mail.tokenSet) : "n/a") +
               " · AST " + JSON.stringify(r.ast));
  });
  if (!rules.length) Logger.log("5) Rien à tester : le filtre n'est pas dans l'index → relance refreshFilterIndex, puis diagnoseFilter à nouveau. S'il n'est pas non plus côté API (1), Gmail ne l'a plus.");
}