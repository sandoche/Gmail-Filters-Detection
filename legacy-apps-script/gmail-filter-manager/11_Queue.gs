/**
 * 11_Queue.gs — file d'attente des créations / suppressions de filtres.
 *
 * Les actions du panneau sont limitées à 30 s par Google. Quand l'API Gmail est lente (30–60 s par
 * appel, comme après un import massif), Filters.create / remove dépassent ce délai et le panneau
 * « tourne dans le vide ». Dans ce cas les boutons ➕ / 🗑️ n'appellent plus l'API : ils déposent la
 * demande ici, et elle est appliquée par :
 *   - applyPendingChanges()  → éditeur (budget 5 min), aussi appelé à la fin de refreshFilterIndex
 *     (donc par le déclencheur horaire) ;
 *   - ▶️ Appliquer maintenant → panneau, une opération à la fois dans la limite des 25 s.
 * Quand l'API est redevenue rapide (mesuré par refreshFilterIndex), les boutons redeviennent directs.
 */

const QUEUE_CONFIG = {
  PROP_KEY: "gfm_pending_ops",
  PROP_API_MS: "gfm_api_ms",        // latence moyenne mesurée des appels API (ms)
  SLOW_MS: 8000,                    // au-delà : mode différé
  MAX_RUN_MS: 300000,               // applyPendingChanges (éditeur / déclencheur)
  PANEL_RUN_MS: 22000               // ▶️ Appliquer maintenant (panneau)
};

/* ───────── état ───────── */

function getQueue_() {
  try { return JSON.parse(PropertiesService.getUserProperties().getProperty(QUEUE_CONFIG.PROP_KEY) || "[]"); }
  catch (e) { return []; }
}
function setQueue_(q) {
  PropertiesService.getUserProperties().setProperty(QUEUE_CONFIG.PROP_KEY, JSON.stringify(q || []));
}
function enqueueOp_(op) {
  const q = getQueue_();
  op.id = "op" + Date.now() + "_" + Math.floor(Math.random() * 1000);
  op.at = Date.now();
  q.push(op);
  setQueue_(q);
  return op;
}

/** Latence API mémorisée (ms) ; mise à jour par refreshFilterIndex et par chaque opération appliquée. */
function recordApiLatency_(ms) {
  try {
    const props = PropertiesService.getUserProperties();
    const prev = parseFloat(props.getProperty(QUEUE_CONFIG.PROP_API_MS) || "0") || 0;
    const next = prev ? Math.round(prev * 0.5 + ms * 0.5) : Math.round(ms);   // moyenne glissante courte
    props.setProperty(QUEUE_CONFIG.PROP_API_MS, String(next));
  } catch (e) {}
}
function apiLatencyMs_() {
  try { return parseFloat(PropertiesService.getUserProperties().getProperty(QUEUE_CONFIG.PROP_API_MS) || "0") || 0; }
  catch (e) { return 0; }
}
/** Latence inconnue (jamais mesurée) = on considère l'API lente : mieux vaut différer que tourner dans le vide. */
function apiSpeedLabel_() { const ms = apiLatencyMs_(); return ms ? "API Gmail lente : " + Math.round(ms / 1000) + " s par appel" : "vitesse de l'API Gmail pas encore mesurée"; }
function isApiSlow_() { const ms = apiLatencyMs_(); return !ms || ms > QUEUE_CONFIG.SLOW_MS; }

/* ───────── application ───────── */

/** Applique une opération ; renvoie { ok, message }. Met le cache à jour. */
function applyOp_(op) {
  const t0 = Date.now();
  try {
    if (op.type === "create") {
      // Si une tentative précédente a été coupée (30 s du panneau) le filtre existe peut-être déjà côté Gmail :
      // on vérifie avant de recréer, sinon on ferait un doublon.
      if (op.cut) {
        const found = findExistingFilter_(op.filter);
        if (found) { cacheAddFilter_(found, op.newLabels || []); return { ok: true, message: "déjà créé lors d'un essai coupé" }; }
      }
      const created = Gmail.Users.Settings.Filters.create(op.filter, "me");
      cacheAddFilter_(created, op.newLabels || []);
    } else if (op.type === "delete") {
      Gmail.Users.Settings.Filters.remove("me", op.filterId);
      cacheRemoveFilters_([op.filterId]);
    } else {
      return { ok: false, message: "type inconnu " + op.type };
    }
    recordApiLatency_(Date.now() - t0);
    return { ok: true, message: "" };
  } catch (e) {
    const msg = safeErrorMessage_(e);
    recordApiLatency_(Date.now() - t0);
    if (op.type === "delete" && /not ?found|404/i.test(msg)) { cacheRemoveFilters_([op.filterId]); return { ok: true, message: "déjà supprimé" }; }
    if (op.type === "create" && /already exists|existe déjà/i.test(msg)) return { ok: true, message: "existait déjà" };
    return { ok: false, message: msg };
  }
}

/** Cherche dans Gmail (liste API) un filtre identique (même critère, mêmes libellés) ; renvoie le filtre ou null. */
function findExistingFilter_(filter) {
  const list = apiRetry_(function() { return Gmail.Users.Settings.Filters.list("me").filter || []; }, "Filters.list (contrôle doublon)");
  const q = normalizeFilterText_((filter.criteria && filter.criteria.query) || "");
  const add = ((filter.action && filter.action.addLabelIds) || []).slice().sort().join(",");
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (normalizeFilterText_((f.criteria && f.criteria.query) || "") !== q) continue;
    if (((f.action && f.action.addLabelIds) || []).slice().sort().join(",") !== add) continue;
    return f;
  }
  return null;
}

/**
 * Traite la file dans la limite de maxMs. Renvoie { done, failed, remaining, log[] }.
 * Une opération en erreur reste dans la file avec son message (visible dans le panneau) ; elle est
 * retentée au passage suivant, et abandonnée après 5 échecs.
 */
function processQueue_(maxMs) {
  const t0 = Date.now();
  const q = getQueue_();
  const out = { done: 0, failed: 0, remaining: 0, log: [] };
  let i = 0;
  while (i < q.length) {
    const op = q[i];
    if (Date.now() - t0 > maxMs) break;
    // marque « en cours » et persiste : si Google coupe l'exécution en plein appel, le passage suivant saura
    // que le filtre a peut-être été créé quand même (voir applyOp_).
    if (op.inflight) op.cut = true;
    op.inflight = Date.now();
    setQueue_(q);
    const r = applyOp_(op);
    delete op.inflight;
    if (r.ok) { out.done++; out.log.push("✔ " + op.desc + (r.message ? " (" + r.message + ")" : "")); q.splice(i, 1); }
    else {
      op.tries = (op.tries || 0) + 1; op.lastError = r.message;
      if (op.tries >= 5) { out.failed++; out.log.push("❌ abandonné après 5 essais : " + op.desc + " — " + r.message); q.splice(i, 1); }
      else { out.failed++; out.log.push("⚠️ " + op.desc + " — " + r.message + " (essai " + op.tries + "/5)"); i++; }
    }
    setQueue_(q);
  }
  out.remaining = q.length;
  setQueue_(q);
  return out;
}

/** Éditeur → Exécuter : applique toutes les modifications en attente (budget 5 min). */
function applyPendingChanges() {
  const q = getQueue_();
  if (!q.length) { Logger.log("File vide : rien à appliquer."); return; }
  Logger.log("▶️ " + q.length + " modification(s) en attente · latence API mesurée : " + Math.round(apiLatencyMs_() / 1000) + " s/appel");
  const r = processQueue_(QUEUE_CONFIG.MAX_RUN_MS);
  r.log.forEach(function(l) { Logger.log(l); });
  Logger.log("✅ " + r.done + " appliquée(s), " + r.failed + " en erreur, " + r.remaining + " restante(s)" + (r.remaining ? " — relance applyPendingChanges" : ""));
}

/** Éditeur → Exécuter : vide la file sans rien appliquer. */
function clearPendingChanges() {
  const n = getQueue_().length;
  setQueue_([]);
  Logger.log(n + " modification(s) en attente supprimée(s).");
}

/* ───────── panneau ───────── */

/** Section « ⏳ EN ATTENTE » (uniquement s'il y a quelque chose). */
function buildQueueSection_(threadId) {
  const q = getQueue_();
  if (!q.length) return null;
  const s = CardService.newCardSection().setHeader("⏳ EN ATTENTE (" + q.length + ")");
  q.slice(0, 6).forEach(function(op) {
    s.addWidget(CardService.newDecoratedText()
      .setTopLabel(op.type === "create" ? "➕ création" : "🗑️ suppression")
      .setText(escapeHtml_(op.desc) + (op.lastError ? "<br><font color=\"#c5221f\">" + escapeHtml_(op.lastError.substring(0, 90)) + "</font>" : ""))
      .setWrapText(true));
  });
  if (q.length > 6) s.addWidget(CardService.newTextParagraph().setText("… et " + (q.length - 6) + " autres."));
  s.addWidget(CardService.newTextParagraph().setText("<font color=\"#5f6368\">" + apiSpeedLabel_() + " : les modifications sont appliquées par le passage horaire, ou tout de suite ci-dessous (une par une, ~25 s).</font>"));
  s.addWidget(CardService.newButtonSet()
    .addButton(CardService.newTextButton().setText("▶️ Appliquer maintenant").setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor("#1f73e6")
      .setOnClickAction(action_("applyPendingAction", { threadId: threadId })))
    .addButton(CardService.newTextButton().setText("🗑️ Vider la file").setOnClickAction(action_("clearPendingAction", { threadId: threadId }))));
  return s;
}

function applyPendingAction(e) {
  const threadId = e.parameters.threadId;
  try {
    const r = processQueue_(QUEUE_CONFIG.PANEL_RUN_MS);
    const notice = (r.done ? "✔ " + r.done + " appliquée(s). " : "") + (r.failed ? "⚠️ " + r.failed + " en erreur. " : "") +
      (r.remaining ? "⏳ " + r.remaining + " restante(s) — reclique, ou laisse le passage horaire finir." : "✅ File vide.");
    return navigateTo_(buildMainCard_(threadId, notice, {}));
  } catch (err) {
    return navigateTo_(buildMainCard_(threadId, "❌ " + escapeHtml_(safeErrorMessage_(err)), {}));
  }
}

function clearPendingAction(e) {
  const threadId = e.parameters.threadId;
  const n = getQueue_().length;
  setQueue_([]);
  return navigateTo_(buildMainCard_(threadId, "🗑️ " + n + " modification(s) en attente supprimée(s).", {}));
}