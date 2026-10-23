/**
 * 08_ImportExport.gs — import / export de masse via l'API (bien plus rapide que l'écran Gmail).
 *
 *  importFromXml()  : lit un mailFilters.xml déposé dans ton Drive et crée les filtres manquants.
 *                     Reprend là où il s'est arrêté si la limite de 6 min est atteinte (relancer).
 *  exportToXml()    : écrit une sauvegarde mailFilters_YYYY-MM-DD.xml dans un dossier Drive
 *                     "Gmail filtres - sauvegardes" (même format que l'export Gmail).
 *  generateDeltaFile() : ⭐ la voie rapide — écrit delta_<date>.xml (+ .txt) avec UNIQUEMENT les filtres
 *                     du XML source absents de Gmail ; tu importes ce petit fichier par l'écran Gmail
 *                     (~1 filtre/s, sans doublon). L'API, elle, est freinée à ~10 s par création.
 *  importStatus()   : où en est l'import en cours.
 *  importReset()    : oublie la progression (pour recommencer du début).
 *  listDuplicateFilters() / removeDuplicateFilters() : nettoyage des doublons.
 */

const IMPORT_CONFIG = {
  XML_FILE_NAME: "mailFilters_v3_separes.xml",   // nom exact du fichier dans Drive (n'importe quel dossier)
  BACKUP_FOLDER: "Gmail filtres - sauvegardes",
  MAX_RUN_MS: 270000,                            // éditeur / déclencheur : on s'arrête avant la limite de 6 min
  PANEL_RUN_MS: 18000,                           // bouton du panneau : limite Google 30 s → on vise 18 s par clic
  USE_BATCH: false,                              // false = création séquentielle (fiable, ~1/s). true = lots parallèles (Gmail les refuse souvent)
  BATCH_SIZE: 8,                                 // (mode batch) créations par requête batch
  PARALLEL_BATCHES: 4,                           // (mode batch) lots envoyés en parallèle
  SEQ_ROUND: 25,                                 // (mode séquentiel) créations par tour = fréquence des lignes de journal
  PROP_KEY: "import_progress_v3",
  PROP_FILE: "import_file_v3"
};

/* ───────────────────────── IMPORT ───────────────────────── */

/**
 * Point d'entrée éditeur + déclencheur de secours (horaire) : traite jusqu'à ~4 min 30 puis,
 * s'il reste du travail, replanifie un déclencheur dans 1 h (minimum autorisé pour un add-on).
 */
function importFromXml() {
  try {
    const p = importChunk_(IMPORT_CONFIG.MAX_RUN_MS);
    if (p && !p.done) scheduleImportContinuation_();
    else deleteImportTriggers_();
  } catch (err) {
    const p = getImportProgress_() || { total: 0, next: 0, created: 0, skipped: 0, failed: 0, errors: [] };
    p.lastError = safeErrorMessage_(err);
    p.lastRunAt = Date.now();
    p.done = true;
    setImportProgress_(p);
    deleteImportTriggers_();
    throw err;
  }
}

/**
 * Traite le fichier pendant au plus maxMs millisecondes, par lots parallèles (batch API Gmail).
 * Reprend à progress.next. Retourne la progression.
 */
function importChunk_(maxMs) {
  const t0 = Date.now();
  const props = PropertiesService.getUserProperties();

  const fileName = props.getProperty(IMPORT_CONFIG.PROP_FILE) || IMPORT_CONFIG.XML_FILE_NAME;
  log_("▶️ Import : recherche de « " + fileName + " » dans Drive…");
  const file = findDriveFileByName_(fileName);
  if (!file) throw new Error("Fichier introuvable dans Drive : " + fileName);
  const entries = parseFiltersXml_(file.getBlob().getDataAsString("UTF-8"));
  log_("📄 Fichier lu : " + entries.length + " filtres dans le XML (" + Math.round(file.getSize() / 1024) + " Ko)");

  let progress = getImportProgress_();
  const finishedOk = progress && progress.done && !progress.lastError;
  if (!progress || finishedOk || progress.fileId !== file.getId() || progress.total !== entries.length) {
    progress = { fileId: file.getId(), fileName: fileName, total: entries.length, next: 0, created: 0, skipped: 0, failed: 0, errors: [], startedAt: Date.now() };
  }
  progress.done = false;
  progress.lastError = "";
  progress.lastRunAt = Date.now();
  setImportProgress_(progress);

  // filtres déjà présents → signatures (doublons ignorés)
  log_("🔎 Lecture des filtres existants via l'API…");
  const idx = getFilterIndex_(true);
  const existing = {};
  idx.rules.forEach(function(r) { existing[filterSignature_(r.criteria, actionFromRule_(r))] = true; });
  const labelsByName = Object.assign({}, idx.labelsByName);
  log_("📋 " + idx.rules.length + " filtres déjà dans Gmail · reprise à la ligne " + (progress.next + 1) + "/" + entries.length +
       " · déjà " + progress.created + " créés / " + progress.skipped + " ignorés dans cet import · budget " + Math.round(maxMs / 1000) + " s");

  const useBatch = !!IMPORT_CONFIG.USE_BATCH;
  const BATCH = useBatch ? IMPORT_CONFIG.BATCH_SIZE : IMPORT_CONFIG.SEQ_ROUND;
  const PARALLEL = useBatch ? IMPORT_CONFIG.PARALLEL_BATCHES : 1;

  // tours adaptatifs : on ne lance un tour que si le précédent (×1,3) tient encore dans le budget
  let roundMs = 0;
  while (progress.next < entries.length && (Date.now() - t0) + roundMs * 1.3 < maxMs) {
    const roundStart = Date.now();
    // 1) prépare jusqu'à BATCH*PARALLEL requêtes à créer
    const toCreate = [];   // { req, sig }
    while (progress.next < entries.length && toCreate.length < BATCH * PARALLEL) {
      const e = entries[progress.next];
      progress.next++;
      let req = null;
      try { req = xmlEntryToApiFilter_(e, labelsByName); } catch (x) { progress.failed++; pushErr_(progress, progress.next + ": " + safeErrorMessage_(x)); continue; }
      if (!req) { progress.skipped++; continue; }
      const sig = filterSignature_(req.criteria, req.action);
      if (existing[sig]) { progress.skipped++; if (progress.skipped % 100 === 0) log_("👀 ligne " + progress.next + "/" + entries.length + " — " + progress.skipped + " déjà présents, ignorés"); continue; }
      existing[sig] = true;
      toCreate.push({ req: req, sig: sig, line: progress.next });
    }
    if (!toCreate.length) { setImportProgress_(progress); log_("⏭️ " + progress.next + "/" + entries.length + " — tour sans rien à créer (tout déjà présent)"); continue; }

    // 2) envoie : séquentiel (fiable) ou lots parallèles (optionnel)
    let results;
    if (useBatch) {
      const groups = [];
      for (let i = 0; i < toCreate.length; i += BATCH) groups.push(toCreate.slice(i, i + BATCH));
      log_("📤 lignes " + toCreate[0].line + "→" + toCreate[toCreate.length - 1].line + " : envoi de " + toCreate.length + " créations en " + groups.length + " lots parallèles…");
      results = sendFilterBatches_(groups);
    } else {
      log_("📤 lignes " + toCreate[0].line + "→" + toCreate[toCreate.length - 1].line + " : création de " + toCreate.length + " filtres un par un…");
      results = createSequentially_(toCreate, t0, maxMs);
    }

    // 3) comptabilise
    results.forEach(function(r, i) {
      if (r.ok) { progress.created++; return; }
      if (r.pending) { progress.next = toCreate[i].line - 1; delete existing[toCreate[i].sig]; return; } // non traité (temps) → repris au prochain passage
      if (/already exists|existe déjà/i.test(r.message)) { progress.skipped++; return; }
      progress.failed++;
      pushErr_(progress, toCreate[i].line + ": " + r.message);
      log_("❌ ligne " + toCreate[i].line + " : " + r.message + "  [" + (toCreate[i].req.criteria.query || toCreate[i].req.criteria.from || "") + "]");
    });

    progress.lastRunAt = Date.now();
    setImportProgress_(progress);
    roundMs = Date.now() - roundStart;
    const rate = toCreate.length / Math.max(1, roundMs / 1000);
    log_("⚙️ tour : " + toCreate.length + " envoyés en " + (roundMs / 1000).toFixed(1) + " s (" + rate.toFixed(1) + "/s) → total " +
         progress.next + "/" + entries.length + " · " + progress.created + " créés · " + progress.skipped + " ignorés · " + progress.failed + " échecs · " +
         Math.round((Date.now() - t0) / 1000) + " s écoulées");
  }

  if (progress.next >= entries.length) {
    progress.done = true;
    clearFilterCache();
    log_("✅ Terminé : " + progress.created + " créés, " + progress.skipped + " ignorés (déjà présents), " + progress.failed + " en échec.");
    if (progress.errors.length) log_("Erreurs :\n" + progress.errors.join("\n"));
  } else {
    log_("⏸️ Pause (budget temps atteint) : " + progress.next + "/" + entries.length + " traités — relance importFromXml pour continuer (ou attends le déclencheur de secours).");
  }
  progress.lastRunAt = Date.now();
  setImportProgress_(progress);
  return progress;
}

/**
 * Création une par une avec temporisation progressive si Gmail répond "trop de requêtes".
 * S'arrête proprement (pending) si le budget temps est atteint.
 */
function createSequentially_(items, t0, maxMs) {
  const out = [];
  let delayMs = 0;
  for (let i = 0; i < items.length; i++) {
    if (Date.now() - t0 > maxMs) { out.push({ ok: false, pending: true, message: "" }); continue; }
    let attempt = 0, done = false, lastMsg = "";
    while (!done && attempt < 4) {
      attempt++;
      try {
        const tc = Date.now();
        Gmail.Users.Settings.Filters.create(items[i].req, "me");
        out.push({ ok: true, status: 200, message: "" });
        done = true;
        log_("✔ ligne " + items[i].line + " créée en " + ((Date.now() - tc) / 1000).toFixed(1) + " s  " +
             String(items[i].req.criteria.query || items[i].req.criteria.from || "").substring(0, 60));
        if (delayMs > 0) delayMs = Math.max(0, delayMs - 250);   // ça passe → on réaccélère doucement
      } catch (x) {
        lastMsg = safeErrorMessage_(x);
        if (/already exists|existe déjà/i.test(lastMsg)) { out.push({ ok: false, status: 409, message: lastMsg }); done = true; }
        else if (/rate|quota|too many|concurrent|backend|internal/i.test(lastMsg)) {
          delayMs = Math.min(8000, delayMs ? delayMs * 2 : 1000);
          log_("🐢 Gmail freine (" + lastMsg.substring(0, 60) + ") → pause " + delayMs + " ms, essai " + attempt + "/4");
          Utilities.sleep(delayMs);
        } else { out.push({ ok: false, status: 400, message: lastMsg }); done = true; }
      }
    }
    if (!done) out.push({ ok: false, status: 429, message: lastMsg });
    if (delayMs > 0) Utilities.sleep(Math.min(delayMs, 2000));
  }
  return out;
}

/** Journal en direct dans l'éditeur (console.log s'affiche pendant l'exécution, Logger.log seulement à la fin). */
function log_(msg) {
  const stamp = Utilities.formatDate(new Date(), "Europe/Paris", "HH:mm:ss");
  console.log(stamp + "  " + msg);
}

function pushErr_(progress, msg) {
  if (progress.errors.length < 20) progress.errors.push(msg);
}

/**
 * Envoie plusieurs lots de créations en parallèle via l'endpoint batch de l'API Gmail
 * (UrlFetchApp.fetchAll). Retourne un tableau de résultats aligné sur la concaténation des lots.
 */
function sendFilterBatches_(groups) {
  const token = ScriptApp.getOAuthToken();
  const boundary = "batch_gfm_" + Date.now();

  const requests = groups.map(function(group) {
    const parts = group.map(function(item, i) {
      return "--" + boundary + "\r\n" +
        "Content-Type: application/http\r\n" +
        "Content-ID: <item" + i + ">\r\n\r\n" +
        "POST /gmail/v1/users/me/settings/filters\r\n" +
        "Content-Type: application/json\r\n\r\n" +
        JSON.stringify(item.req) + "\r\n";
    });
    return {
      url: "https://www.googleapis.com/batch/gmail/v1",
      method: "post",
      contentType: "multipart/mixed; boundary=" + boundary,
      headers: { Authorization: "Bearer " + token },
      payload: parts.join("") + "--" + boundary + "--\r\n",
      muteHttpExceptions: true
    };
  });

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (err) {
    // fallback total : séquentiel classique
    return groups.reduce(function(acc, group) {
      return acc.concat(group.map(function(item) {
        try { Gmail.Users.Settings.Filters.create(item.req, "me"); return { ok: true, status: 200, message: "" }; }
        catch (x) { return { ok: false, status: 0, message: safeErrorMessage_(x) }; }
      }));
    }, []);
  }

  const out = [];
  responses.forEach(function(resp, g) {
    const group = groups[g];
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    if (code !== 200) {
      // tout le lot a échoué (auth, quota…) → même erreur pour chaque item
      const msg = "batch HTTP " + code + " : " + body.substring(0, 200);
      group.forEach(function() { out.push({ ok: false, status: code, message: msg }); });
      return;
    }
    const parsed = parseBatchResponse_(body, group.length);
    parsed.forEach(function(p) { out.push(p); });
  });
  return out;
}

/** Découpe la réponse multipart et lit le statut HTTP de chaque sous-réponse (dans l'ordre d'envoi). */
function parseBatchResponse_(body, expected) {
  const out = [];
  const bm = body.match(/^--([^\r\n]+)/m);           // frontière annoncée dans la réponse
  const boundary = bm ? bm[1].replace(/--$/, "") : null;
  const parts = (boundary ? body.split("--" + boundary) : [body]).filter(function(p) { return /HTTP\/1\.1 \d{3}/.test(p); });
  parts.forEach(function(p) {
    const m = p.match(/HTTP\/1\.1 (\d{3})/);
    const status = m ? parseInt(m[1], 10) : 0;
    let message = "";
    if (status < 200 || status >= 300) {
      const jm = p.match(/"message"\s*:\s*"([^"]*)"/);
      message = jm ? jm[1] : ("HTTP " + status);
    }
    out.push({ ok: status >= 200 && status < 300, status: status, message: message });
  });
  while (out.length < expected) out.push({ ok: false, status: 0, message: "réponse batch incomplète" });
  return out.slice(0, expected);
}

function importStatus() {
  const p = getImportProgress_();
  log_(p ? (p.done ? "Dernier import terminé : " : "Import en cours : ") + JSON.stringify(p) : "Aucun import en cours.");
}

function importReset() {
  deleteImportTriggers_();
  PropertiesService.getUserProperties().deleteProperty(IMPORT_CONFIG.PROP_KEY);
  log_("Progression effacée.");
}

/* ── progression & tâche de fond ── */

function getImportProgress_() {
  try { return JSON.parse(PropertiesService.getUserProperties().getProperty(IMPORT_CONFIG.PROP_KEY) || "null"); }
  catch (e) { return null; }
}

function setImportProgress_(p) {
  PropertiesService.getUserProperties().setProperty(IMPORT_CONFIG.PROP_KEY, JSON.stringify(p));
}

/** Prépare un import (appelé par le panneau) : vérifie le fichier, garde la position si reprise. Retourne le nombre d'entrées. */
function prepareImport_(fileName) {
  const file = findDriveFileByName_(fileName);
  if (!file) throw new Error("Fichier introuvable dans ton Drive : « " + fileName + " » — dépose-le d'abord (glisser-déposer dans drive.google.com).");
  const entries = parseFiltersXml_(file.getBlob().getDataAsString("UTF-8"));
  if (!entries.length) throw new Error("Aucun <entry> dans « " + fileName + " » : ce n'est pas un export de filtres Gmail.");

  PropertiesService.getUserProperties().setProperty(IMPORT_CONFIG.PROP_FILE, fileName);
  const prev = getImportProgress_();
  const resume = prev && prev.fileId === file.getId() && prev.total === entries.length && prev.next > 0 && prev.next < entries.length;
  const progress = resume ? prev : { fileId: file.getId(), fileName: fileName, total: entries.length, next: 0, created: 0, skipped: 0, failed: 0, errors: [] };
  progress.done = false; progress.lastError = ""; progress.startedAt = Date.now(); progress.lastRunAt = 0;
  setImportProgress_(progress);
  return entries.length;
}

/** Déclencheur de secours : dans 1 h (minimum autorisé pour un add-on). */
function scheduleImportContinuation_() {
  deleteImportTriggers_();
  ScriptApp.newTrigger("importFromXml").timeBased().after(60 * 60 * 1000).create();
}

function deleteImportTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "importFromXml") ScriptApp.deleteTrigger(t);
  });
}

function cancelImport_() {
  deleteImportTriggers_();
  const p = getImportProgress_();
  if (p && !p.done) { p.done = true; p.errors = (p.errors || []).concat(["annulé par l'utilisateur"]); setImportProgress_(p); }
}

/* ───────────────────────── DOUBLONS ───────────────────────── */

/**
 * Liste les doublons (même critères + mêmes actions) sans rien supprimer. Éditeur → Journal.
 */
function listDuplicateFilters() {
  const groups = findDuplicateGroups_();
  let extra = 0;
  groups.forEach(function(g) { extra += g.length - 1; });
  log_(groups.length + " groupes de doublons, " + extra + " filtres en trop.");
  groups.slice(0, 50).forEach(function(g) { log_("×" + g.length + "  " + g[0].description + "  →  " + g[0].actions.join(", ")); });
  return extra;
}

/**
 * Supprime les doublons en gardant UN exemplaire par groupe (le plus ancien : id le plus petit).
 * Éditeur → Exécuter. Journal = bilan. Relancer si la limite de 6 min est atteinte.
 */
function removeDuplicateFilters() {
  const t0 = Date.now();
  const groups = findDuplicateGroups_();
  let removed = 0, failed = 0, remaining = 0;
  groups.forEach(function(g) {
    g.sort(function(a, b) { return a.id < b.id ? -1 : 1; });
    for (let i = 1; i < g.length; i++) {
      if (Date.now() - t0 > IMPORT_CONFIG.MAX_RUN_MS) { remaining++; continue; }
      try { Gmail.Users.Settings.Filters.remove("me", g[i].id); removed++; }
      catch (e) { failed++; log_("échec " + g[i].id + " : " + safeErrorMessage_(e)); }
    }
  });
  clearFilterCache();
  log_("🧹 " + removed + " doublons supprimés, " + failed + " échecs" + (remaining ? ", " + remaining + " restants (relance)" : "") + ".");
  return removed;
}

function findDuplicateGroups_() {
  const idx = getFilterIndex_(true);
  const bySig = {};
  idx.rules.forEach(function(r) {
    const sig = filterSignature_(r.criteria, actionFromRule_(r));
    (bySig[sig] = bySig[sig] || []).push(r);
  });
  return Object.keys(bySig).map(function(k) { return bySig[k]; }).filter(function(g) { return g.length > 1; });
}

/* ───────────────────────── EXPORT ───────────────────────── */

function exportToXml() {
  const idx = getFilterIndex_(true);
  const lines = [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    "\t<title>Mail Filters</title>"
  ];

  idx.rules.forEach(function(r) {
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
      else p.push(["label", idx.labelsById[id] || id]);
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

  const folder = getOrCreateFolder_(IMPORT_CONFIG.BACKUP_FOLDER);
  const name = "mailFilters_" + Utilities.formatDate(new Date(), "Europe/Paris", "yyyy-MM-dd_HHmm") + ".xml";
  const f = folder.createFile(name, lines.join("\n"), "text/xml");
  log_("💾 " + idx.rules.length + " filtres exportés → Drive/" + IMPORT_CONFIG.BACKUP_FOLDER + "/" + name + "  (" + f.getUrl() + ")");
  return f.getUrl();
}

/* ───────────────────────── XML DES MANQUANTS (import web rapide) ───────────────────────── */

/**
 * Éditeur → Exécuter. Compare le XML source (IMPORT_CONFIG.XML_FILE_NAME ou le dernier fichier importé)
 * aux filtres réellement présents dans Gmail, et écrit dans Drive un XML contenant UNIQUEMENT les
 * filtres manquants (doublons internes retirés). À importer ensuite par Gmail → Paramètres → Filtres →
 * Importer : ~1 filtre/s côté web, sans doublon puisque seuls les absents y figurent.
 * Arrête aussi l'import de fond (déclencheurs supprimés) pour ne pas créer en parallèle.
 */
function exportMissingToXml() { return generateDeltaFile(); }

/**
 * Génère delta.xml + delta.txt (même contenu) dans le dossier du fichier source.
 * Le .txt est là pour les postes qui bloquent le téléchargement des .xml : tu le récupères,
 * tu le renommes en .xml et tu l'importes dans Gmail.
 * @param {string=} fileName  nom du XML source (défaut : dernier importé, sinon IMPORT_CONFIG.XML_FILE_NAME)
 * @return {{count:number, xmlUrl:string, txtUrl:string, existing:number, total:number, dup:number, invalid:number, xmlName:string}}
 */
function generateDeltaFile(fileName) {
  cancelImport_();
  log_("⏹️ Import de fond arrêté (déclencheurs importFromXml supprimés).");

  const props = PropertiesService.getUserProperties();
  fileName = String(fileName || props.getProperty(IMPORT_CONFIG.PROP_FILE) || IMPORT_CONFIG.XML_FILE_NAME).trim();
  const file = findDriveFileByName_(fileName);
  if (!file) throw new Error("Fichier introuvable dans Drive : " + fileName);
  const entries = parseFiltersXml_(file.getBlob().getDataAsString("UTF-8"));
  log_("📄 " + fileName + " : " + entries.length + " filtres dans le XML");

  log_("🔎 Lecture des filtres présents dans Gmail…");
  const idx = getFilterIndex_(true);
  const existing = {};
  idx.rules.forEach(function(r) { existing[filterSignature_(r.criteria, actionFromRule_(r))] = true; });
  const labelsByName = Object.assign({}, idx.labelsByName);
  log_("📋 " + idx.rules.length + " filtres déjà dans Gmail");

  const missing = [];
  let dupInXml = 0, invalid = 0;
  entries.forEach(function(p) {
    let req = null;
    try { req = xmlEntryToApiFilter_(p, labelsByName); } catch (x) { invalid++; return; }
    if (!req) { invalid++; return; }
    const sig = filterSignature_(req.criteria, req.action);
    if (existing[sig]) { dupInXml++; return; }
    existing[sig] = true;
    missing.push(p);
  });

  const lines = [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    "\t<title>Mail Filters</title>"
  ];
  missing.forEach(function(p, i) {
    lines.push("\t<entry>");
    lines.push("\t\t<category term='filter'></category>");
    lines.push("\t\t<title>Mail Filter</title>");
    lines.push("\t\t<id>tag:mail.google.com,2008:filter:delta-" + (i + 1) + "</id>");
    lines.push("\t\t<content></content>");
    Object.keys(p).forEach(function(k) { lines.push("\t\t<apps:property name='" + xmlAttr_(k) + "' value='" + xmlAttr_(p[k]) + "'/>"); });
    lines.push("\t</entry>");
  });
  lines.push("</feed>");
  const xml = lines.join("\n");

  const parents = file.getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const stamp = Utilities.formatDate(new Date(), "Europe/Paris", "yyyy-MM-dd_HHmm");
  const baseName = "delta_" + stamp;
  // on retire les anciens delta pour ne pas se tromper de fichier
  const old = folder.getFiles();
  while (old.hasNext()) { const o = old.next(); if (/^delta(_\d{4}-\d{2}-\d{2}_\d{4})?\.(xml|txt)$/i.test(o.getName())) o.setTrashed(true); }
  const outXml = folder.createFile(baseName + ".xml", xml, "text/xml");
  const outTxt = folder.createFile(baseName + ".txt", xml, "text/plain");

  const res = { count: missing.length, xmlUrl: outXml.getUrl(), txtUrl: outTxt.getUrl(), existing: idx.rules.length, total: entries.length,
                dup: dupInXml, invalid: invalid, xmlName: baseName + ".xml", txtName: baseName + ".txt", folder: folder.getName() };
  log_("✅ " + res.count + " filtres manquants → " + res.xmlName + " et " + res.txtName + " (" + Math.round(outXml.getSize() / 1024) + " Ko) dans Drive / " + res.folder +
       " · " + dupInXml + " déjà présents ou en double ignorés · " + invalid + " invalides");
  log_("📎 XML : " + res.xmlUrl);
  log_("📎 TXT : " + res.txtUrl + "  (à renommer en .xml si le .xml est bloqué)");
  log_("➡️ Gmail → Paramètres → Filtres et adresses bloquées → Importer des filtres → ce fichier → tout cocher → Créer les filtres. " +
       "Puis listDuplicateFilters / removeDuplicateFilters, et 🔄 Recharger dans le panneau.");
  return res;
}

/* ───────────────────────── helpers ───────────────────────── */

function findDriveFileByName_(name) {
  const it = DriveApp.getFilesByName(name);
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f; // le plus récent
  }
  return best;
}

function getOrCreateFolder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** Parse un mailFilters.xml (export Gmail ou fichier généré) → [{props}] */
function parseFiltersXml_(xmlText) {
  const out = [];
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  let m;
  while ((m = entryRegex.exec(xmlText)) !== null) {
    const props = {};
    const propRegex = /<apps:property\b([^>]*?)\/>/gi;
    let pm;
    while ((pm = propRegex.exec(m[0])) !== null) {
      const name = readXmlAttr_(pm[1], "name");
      if (name) props[decodeXmlEntities_(name)] = decodeXmlEntities_(readXmlAttr_(pm[1], "value"));
    }
    out.push(props);
  }
  return out;
}

function readXmlAttr_(attrs, attrName) {
  const re = new RegExp("\\b" + attrName + "\\s*=\\s*(['\"])([\\s\\S]*?)\\1");
  const mm = attrs.match(re);
  return mm ? mm[2] : "";
}

function xmlAttr_(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/'/g, "&apos;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convertit une entrée XML en requête API {criteria, action}. Crée le libellé s'il n'existe pas. */
function xmlEntryToApiFilter_(p, labelsByName) {
  const criteria = {};
  if (p.from) criteria.from = p.from;
  if (p.to) criteria.to = p.to;
  if (p.subject) criteria.subject = p.subject;
  if (p.hasTheWord) criteria.query = p.hasTheWord;
  if (p.doesNotHaveTheWord) criteria.negatedQuery = p.doesNotHaveTheWord;
  if (p.hasAttachment === "true") criteria.hasAttachment = true;
  if (p.size && p.sizeOperator) {
    const unit = { s_sb: 1, s_skb: 1024, s_smb: 1048576 }[p.sizeUnit] || 1;
    criteria.size = Math.round(parseFloat(p.size) * unit);
    criteria.sizeComparison = p.sizeOperator === "s_sl" ? "larger" : "smaller";
  }
  if (!Object.keys(criteria).length) return null;

  const add = [], remove = [];
  if (p.label) {
    let id = labelsByName[p.label];
    if (!id) {
      const created = Gmail.Users.Labels.create({ name: p.label, labelListVisibility: "labelShow", messageListVisibility: "show" }, "me");
      id = created.id;
      labelsByName[p.label] = id;
      log_("🏷️ Libellé créé : " + p.label);
    }
    add.push(id);
  }
  if (p.shouldTrash === "true") add.push("TRASH");
  if (p.shouldStar === "true") add.push("STARRED");
  if (p.shouldAlwaysMarkAsImportant === "true") add.push("IMPORTANT");
  if (p.shouldArchive === "true") remove.push("INBOX");
  if (p.shouldMarkAsRead === "true") remove.push("UNREAD");
  if (p.shouldNeverSpam === "true") remove.push("SPAM");
  if (p.shouldNeverMarkAsImportant === "true") remove.push("IMPORTANT");

  const action = {};
  if (add.length) action.addLabelIds = add;
  if (remove.length) action.removeLabelIds = remove;
  if (p.forwardTo) action.forward = p.forwardTo;
  if (!Object.keys(action).length) return null; // filtre sans action : inutile

  return { criteria: criteria, action: action };
}

function actionFromRule_(r) {
  // reconstruit l'action API à partir de la règle indexée (01_Filters) — on relit le brut du cache
  return r.rawAction || {};
}

function filterSignature_(criteria, action) {
  const c = criteria || {}, a = action || {};
  return [
    normalizeFilterText_(c.from || ""), normalizeFilterText_(c.to || ""), normalizeFilterText_(c.subject || ""),
    normalizeFilterText_(c.query || ""), normalizeFilterText_(c.negatedQuery || ""),
    c.hasAttachment ? "att" : "", c.size ? (c.sizeComparison + c.size) : "",
    (a.addLabelIds || []).slice().sort().join(","), (a.removeLabelIds || []).slice().sort().join(","), a.forward || ""
  ].join("|");
}