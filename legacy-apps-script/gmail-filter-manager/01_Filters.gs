/**
 * 01_Filters.gs — lecture des filtres Gmail (API), index en mémoire + cache persistant.
 *
 * Trois niveaux :
 *   1. __FILTER_INDEX : mémoire de l'exécution en cours.
 *   2. CacheService   : rapide, découpé en morceaux < 100 Ko, expire (CACHE_TTL_SECONDS).
 *   3. Fichier Drive  : « gfm_filters_cache.json », persistant, sans limite de taille — c'est la
 *                       référence ; il n'est réécrit que par un rechargement complet (API) ou par
 *                       une mise à jour incrémentale (filtre créé / supprimé depuis le panneau).
 * L'API n'est appelée que si aucun cache n'existe ou sur demande explicite (🔄 Recharger,
 * refreshFilterIndex dans l'éditeur).
 */

/** Index des filtres : { rules: [rule], labelsById: {}, labelsByName: {}, builtAt, fromCache, unstable, apiCount } */
function getFilterIndex_(forceRefresh) {
  if (!forceRefresh && __FILTER_INDEX) return __FILTER_INDEX;

  let raw = forceRefresh ? null : readCachedRaw_();
  let fromCache = !!raw;
  let apiError = "";

  if (!raw) {
    try {
      raw = fetchRawFromApiChecked_(false);
      writeCachedRaw_(raw);
    } catch (e) {
      // API en panne (ex. « Precondition check failed » pendant que Gmail réorganise) → on retombe sur le cache
      const fallback = readCachedRaw_();
      if (!fallback) throw e;
      apiError = safeErrorMessage_(e);
      Logger.log("⚠️ API indisponible (" + apiError + ") → cache conservé (" + fallback.filters.length + " filtres)");
      raw = fallback;
      fromCache = true;
    }
  }

  __FILTER_INDEX = buildIndexFromRaw_(raw);
  __FILTER_INDEX.fromCache = fromCache;
  __FILTER_INDEX.unstable = !!raw.unstable;
  __FILTER_INDEX.apiCount = raw.apiCount || 0;
  __FILTER_INDEX.apiError = apiError;
  return __FILTER_INDEX;
}

/**
 * Éditeur → Exécuter : rechargement complet depuis l'API, en mode VÉRIFIÉ.
 * La liste (Filters.list) oublie parfois tout un paquet de filtres — les anciens filtres de tri —
 * et ce de façon stable pendant des heures : recompter ne prouve rien. Ici, chaque filtre du cache
 * absent de la liste est interrogé individuellement (Filters.get) : il répond → il existe, on le garde ;
 * 404 → vraiment supprimé, on le retire. Seule cette fonction peut retirer un filtre du cache.
 */
function refreshFilterIndex() {
  const t0 = Date.now();
  __FILTER_INDEX = null;
  const prev = readCachedRaw_();
  const api = fetchRawFromApi_();
  const inList = {};
  api.filters.forEach(function(f) { inList[f.id] = true; });

  const tList = Date.now() - t0;
  const missing = prev ? prev.filters.filter(function(f) { return !inList[f.id]; }) : [];
  let kept = 0, gone = 0, unknown = 0, tVerify = 0, nVerify = 0;
  const keep = [];
  missing.forEach(function(f) {
    if (Date.now() - t0 > 300000) { unknown++; keep.push(f); return; }   // garde-fou 5 min : on garde sans vérifier
    const tv = Date.now();
    const v = verifyFilterExists_(f.id);
    tVerify += Date.now() - tv; nVerify++;
    if (v === true) { kept++; keep.push(f); }
    else if (v === false) { gone++; }
    else { unknown++; keep.push(f); }      // API en erreur : dans le doute on garde
  });
  Logger.log("⏱️ liste API en " + Math.round(tList / 1000) + " s · " + nVerify + " vérifications Filters.get en " + Math.round(tVerify / 1000) + " s" +
             (nVerify ? " (" + (tVerify / nVerify / 1000).toFixed(1) + " s/filtre)" : ""));
  try { recordApiLatency_(nVerify ? tVerify / nVerify : Math.min(tList, 60000) / 3); } catch (e) {}   // la liste est ~3× plus lourde qu'un appel unitaire

  const raw = { builtAt: Date.now(), labels: api.labels, filters: api.filters.concat(keep) };
  raw.apiCount = api.filters.length;

  // plus haut nombre de filtres jamais observé (liste ou cache) : tant que la liste est en dessous, elle est suspecte
  const hwm = updateHighWaterMark_(Math.max(api.filters.length, raw.filters.length));
  const belowHwm = raw.filters.length < hwm - gone;
  raw.unstable = kept > 0 || unknown > 0 || belowHwm;
  writeCachedRaw_(raw);
  __FILTER_INDEX = buildIndexFromRaw_(raw);
  __FILTER_INDEX.fromCache = false;
  __FILTER_INDEX.unstable = raw.unstable;
  __FILTER_INDEX.apiCount = raw.apiCount;

  Logger.log("liste API : " + api.filters.length + " filtres · cache précédent : " + (prev ? prev.filters.length : 0) +
             " · absents de la liste : " + missing.length + " → " + kept + " existent bel et bien (liste incomplète), " + gone + " vraiment supprimés" +
             (unknown ? ", " + unknown + " invérifiables (gardés)" : "") + " · maximum jamais observé : " + hwm);
  let verdict;
  if (kept > 0 || unknown > 0) verdict = " — la liste API est incomplète en ce moment, le cache a été complété filtre par filtre";
  else if (belowHwm) verdict = " — ⚠️ liste PROBABLEMENT INCOMPLÈTE : " + (hwm - raw.filters.length) + " filtres de moins que le maximum observé, et rien dans le cache pour les récupérer ; ils reviendront quand l'API les rendra (déclencheur horaire)";
  else verdict = " — liste API complète, cache = vérité";
  Logger.log((raw.unstable ? "⚠️ " : "✅ ") + raw.filters.length + " filtres dans le cache (" + Math.round((Date.now() - t0) / 1000) + " s), " +
             Object.keys(__FILTER_INDEX.labelsById).length + " libellés" + verdict);

  // modifications en attente (boutons du panneau en mode différé) : on les applique avec le temps qui reste
  try {
    if (typeof getQueue_ === "function" && getQueue_().length) {
      const left = 330000 - (Date.now() - t0);
      if (left > 20000) { const r = processQueue_(left); r.log.forEach(function(l) { Logger.log(l); }); Logger.log("⏳ file : " + r.done + " appliquée(s), " + r.remaining + " restante(s)"); }
    }
  } catch (e) { Logger.log("file d'attente : " + safeErrorMessage_(e)); }
  return __FILTER_INDEX;
}

/** Mémorise le plus grand nombre de filtres jamais vu (PropertiesService) et le renvoie. */
function updateHighWaterMark_(n) {
  try {
    const props = PropertiesService.getUserProperties();
    const prev = parseInt(props.getProperty("gfm_max_filters") || "0", 10) || 0;
    if (n > prev) { props.setProperty("gfm_max_filters", String(n)); return n; }
    return prev;
  } catch (e) { return n; }
}

/** Éditeur → Exécuter : fixe à la main le maximum de référence (ex. 1698 après une suppression volontaire). */
function setHighWaterMark() {
  const N = 1698;   // ← nombre de filtres que Gmail est censé avoir
  PropertiesService.getUserProperties().setProperty("gfm_max_filters", String(N));
  Logger.log("maximum de référence fixé à " + N);
}

/** true = le filtre existe, false = 404 (supprimé), null = erreur API (inconnu). */
function verifyFilterExists_(id) {
  try {
    const f = Gmail.Users.Settings.Filters.get("me", id);
    return !!(f && f.id);
  } catch (e) {
    const msg = safeErrorMessage_(e);
    if (/not ?found|404|introuvable|does not exist/i.test(msg)) return false;
    return null;
  }
}

/** Éditeur → Exécuter : compte les filtres côté API 3 fois à 20 s d'intervalle (pour voir si Gmail est stable). */
function countFiltersThreeTimes() {
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now();
    const resp = Gmail.Users.Settings.Filters.list("me");
    const n = (resp && resp.filter) ? resp.filter.length : 0;
    Logger.log("mesure " + i + " : " + n + " filtres (" + Math.round((Date.now() - t0) / 1000) + " s)");
    if (i < 3) Utilities.sleep(20000);
  }
}

/* ───────── API Gmail ───────── */

/**
 * Lecture API avec garde-fou. Filters.list renvoie parfois une liste TRONQUÉE et variable
 * (observé : 1612, 1699, 1497 à quelques minutes d'intervalle après un import massif).
 *
 *  - strict = false (panneau, < 30 s) : 1 lecture. Si elle rapporte MOINS de filtres que le cache, on ne
 *    remplace pas : on fait l'UNION (par id) du cache et de l'API, et on marque le résultat « unstable ».
 *    Un filtre ne disparaît donc jamais du cache à cause d'une lecture bancale.
 *  - strict = true (éditeur) : 3 lectures à 10 s. Toutes identiques → l'API fait foi (les filtres vraiment
 *    supprimés sortent du cache). Sinon → union des 3 lectures + du cache, « unstable ».
 */
function fetchRawFromApiChecked_(strict) {
  const prev = readCachedRaw_();
  const prevCount = prev && prev.filters ? prev.filters.length : 0;

  const reads = [fetchRawFromApi_()];
  if (strict) {
    for (let i = 1; i < 3; i++) { Utilities.sleep(10000); reads.push(fetchRawFromApi_()); }
    const counts = reads.map(function(r) { return r.filters.length; });
    const allSame = counts.every(function(c) { return c === counts[0]; });
    Logger.log("lectures API : " + counts.join(" / ") + (allSame ? " → stable" : " → INSTABLE") + " · cache précédent : " + prevCount);
    if (allSame) { const r = reads[0]; r.apiCount = counts[0]; r.unstable = false; return r; }
    const u = unionRaw_(reads.concat(prev ? [prev] : []));
    u.unstable = true; u.apiCount = Math.max.apply(null, counts);
    return u;
  }

  const r = reads[0];
  r.apiCount = r.filters.length;
  const hwm = updateHighWaterMark_(Math.max(r.filters.length, prevCount));
  if (r.filters.length < hwm && !prevCount) { r.unstable = true; return r; }   // pas de cache et liste sous le maximum connu : suspecte
  if (prevCount && r.filters.length < prevCount) {
    Logger.log("⚠️ API : " + r.filters.length + " filtres, le cache en avait " + prevCount + " → union (rien n'est retiré du cache)");
    const u = unionRaw_([r, prev]);
    u.unstable = true; u.apiCount = r.filters.length;
    return u;
  }
  r.unstable = false;
  return r;
}

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

/** Appel API avec 3 essais (2 s, 4 s) : « Precondition check failed » / « Backend Error » sont souvent transitoires. */
function apiRetry_(fn, what) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return fn(); }
    catch (e) {
      last = e;
      const msg = safeErrorMessage_(e);
      if (!/precondition|backend|internal|rate|quota|timed? ?out|unavailable/i.test(msg) || i === 2) throw e;
      Logger.log("⏳ " + what + " : " + msg.substring(0, 80) + " → nouvel essai " + (i + 2) + "/3");
      Utilities.sleep(2000 * (i + 1));
    }
  }
  throw last;
}

function fetchRawFromApi_() {
  const filtersResp = apiRetry_(function() { return Gmail.Users.Settings.Filters.list("me"); }, "Filters.list");
  const filters = (filtersResp && filtersResp.filter) ? filtersResp.filter : [];

  const labelsResp = apiRetry_(function() { return Gmail.Users.Labels.list("me"); }, "Labels.list");
  const labels = (labelsResp && labelsResp.labels) ? labelsResp.labels : [];

  return {
    builtAt: Date.now(),
    labels: labels.map(function(l) { return { id: l.id, name: l.name }; }),
    filters: filters.map(function(f) {
      return { id: f.id, criteria: f.criteria || {}, action: f.action || {} };
    })
  };
}

/* ───────── mises à jour incrémentales (pas de relecture API) ───────── */

/** Ajoute un filtre (objet API {id, criteria, action}) — ou un tableau de filtres — au cache et à l'index. */
function cacheAddFilter_(apiFilter, newLabels) {
  const list = Array.isArray(apiFilter) ? apiFilter : [apiFilter];
  const raw = readCachedRaw_() || fetchRawFromApiChecked_(false);
  const ids = {};
  list.forEach(function(f) { if (f && f.id) ids[f.id] = true; });
  raw.filters = raw.filters.filter(function(f) { return !ids[f.id]; });
  list.forEach(function(f) { if (f && f.id) raw.filters.push({ id: f.id, criteria: f.criteria || {}, action: f.action || {} }); });
  (newLabels || []).forEach(function(l) {
    if (!raw.labels.some(function(x) { return x.id === l.id; })) raw.labels.push({ id: l.id, name: l.name });
  });
  raw.builtAt = Date.now();
  writeCachedRaw_(raw);
  __FILTER_INDEX = buildIndexFromRaw_(raw);
  __FILTER_INDEX.fromCache = true;
  return __FILTER_INDEX;
}

/** Retire des filtres (par id) du cache et de l'index. */
function cacheRemoveFilters_(ids) {
  const raw = readCachedRaw_();
  if (!raw) { clearFilterCache(); return getFilterIndex_(true); }
  const gone = {};
  (ids || []).forEach(function(id) { gone[id] = true; });
  raw.filters = raw.filters.filter(function(f) { return !gone[f.id]; });
  raw.builtAt = Date.now();
  writeCachedRaw_(raw);
  __FILTER_INDEX = buildIndexFromRaw_(raw);
  __FILTER_INDEX.fromCache = true;
  return __FILTER_INDEX;
}

/* ───────── cache : CacheService (rapide) + fichier Drive (persistant) ───────── */

function writeCachedRaw_(raw) {
  const json = JSON.stringify(raw);
  // 1) Drive (référence)
  try {
    const f = getCacheFile_(true);
    f.setContent(json);
  } catch (e) {
    Logger.log("Cache Drive non écrit : " + e);
  }
  // 2) CacheService (rapide) — les morceaux d'abord, l'en-tête en dernier
  try {
    const cache = CacheService.getUserCache();
    const SIZE = 90000;
    const parts = [];
    for (let i = 0; i < json.length; i += SIZE) parts.push(json.substring(i, i + SIZE));
    const values = {};
    parts.forEach(function(p, i) { values[APP_CONFIG.CACHE_KEY + "_" + i] = p; });
    cache.putAll(values, APP_CONFIG.CACHE_TTL_SECONDS);
    cache.put(APP_CONFIG.CACHE_KEY + "_n", String(parts.length) + ":" + json.length, APP_CONFIG.CACHE_TTL_SECONDS);
  } catch (e) {
    Logger.log("CacheService non écrit : " + e);
  }
}

function readCachedRaw_() {
  // 1) CacheService
  try {
    const cache = CacheService.getUserCache();
    const head = String(cache.get(APP_CONFIG.CACHE_KEY + "_n") || "");
    const n = parseInt(head.split(":")[0], 10), len = parseInt(head.split(":")[1], 10);
    if (n) {
      const keys = [];
      for (let i = 0; i < n; i++) keys.push(APP_CONFIG.CACHE_KEY + "_" + i);
      const got = cache.getAll(keys);
      let json = "", ok = true;
      for (let i = 0; i < n; i++) { const part = got[keys[i]]; if (part == null) { ok = false; break; } json += part; }
      if (ok && (!len || json.length === len)) return JSON.parse(json);
    }
  } catch (e) {}
  // 2) fichier Drive
  try {
    const f = getCacheFile_(false);
    if (f) {
      const raw = JSON.parse(f.getBlob().getDataAsString("UTF-8"));
      if (raw && raw.filters) return raw;
    }
  } catch (e) {}
  return null;
}

function clearFilterCache() {
  __FILTER_INDEX = null;
  try {
    const cache = CacheService.getUserCache();
    const head = String(cache.get(APP_CONFIG.CACHE_KEY + "_n") || "");
    const n = parseInt(head.split(":")[0], 10) || 0;
    const keys = [APP_CONFIG.CACHE_KEY + "_n"];
    for (let i = 0; i < n; i++) keys.push(APP_CONFIG.CACHE_KEY + "_" + i);
    cache.removeAll(keys);
  } catch (e) {}
  // le fichier Drive est volontairement conservé : il sera réécrit par la prochaine lecture API
}

/** Fichier de cache dans Drive (dossier APP_CONFIG.CACHE_FOLDER). */
function getCacheFile_(create) {
  // valeurs de repli si 00_Config n'est pas à jour (sinon DriveApp lève « Invalid argument: name »)
  const folderName = APP_CONFIG.CACHE_FOLDER || "Gmail Filter Manager (cache)";
  const fileName = APP_CONFIG.CACHE_FILE || "gfm_filters_cache.json";
  const folderIt = DriveApp.getFoldersByName(folderName);
  let folder = folderIt.hasNext() ? folderIt.next() : null;
  if (!folder) { if (!create) return null; folder = DriveApp.createFolder(folderName); }
  const it = folder.getFilesByName(fileName);
  if (it.hasNext()) return it.next();
  return create ? folder.createFile(fileName, "{}", "application/json") : null;
}

/* ───────── construction de l'index ───────── */

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