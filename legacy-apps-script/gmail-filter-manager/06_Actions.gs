/**
 * 06_Actions.gs — recharger / supprimer / créer des filtres (API Gmail, scope gmail.settings.basic).
 */

function reloadFiltersAction(e) {
  try {
    const t0 = Date.now();
    clearFilterCache();
    const idx = getFilterIndex_(true);
    let notice;
    if (idx.apiError) {
      notice = "⛔ L'API Gmail ne répond pas (« " + escapeHtml_(idx.apiError.substring(0, 90)) + " ») après 3 essais : je garde le cache (<b>" + idx.rules.length + "</b> filtres). " +
        "C'est transitoire, Gmail réorganise ses paramètres après l'import ; réessaie dans quelques minutes.";
    } else if (idx.unstable) {
      notice = "⚠️ L'API Gmail n'a renvoyé que <b>" + idx.apiCount + "</b> filtres, moins que le cache : je garde l'union (<b>" + idx.rules.length + "</b> filtres), rien n'est retiré. " +
        "Gmail est instable après un import massif ; pour faire le ménage quand ce sera stable, lance <b>refreshFilterIndex</b> dans l'éditeur (3 lectures de contrôle).";
    } else {
      notice = "🔄 " + idx.rules.length + " filtres relus depuis Gmail en " + Math.round((Date.now() - t0) / 1000) + " s.";
    }
    return navigateTo_(buildMainCard_(e.parameters.threadId, notice, { reload: true }));
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("reloadFiltersAction", err) +
      " — si c'est un dépassement des 30 s, lance refreshFilterIndex depuis l'éditeur Apps Script (limite 6 min), le panneau lira ensuite le cache."));
  }
}

/* ───────── import / export (panneau) ───────── */

function importFromXmlAction(e) {
  const threadId = e.parameters.threadId;
  try {
    const fileName = String(formValue_(e, "xmlFileName") || IMPORT_CONFIG.XML_FILE_NAME).trim();
    const running = getImportProgress_();
    if (running && !running.done) {
      return navigateTo_(buildMainCard_(threadId, "⏳ Un import est déjà en cours (" + running.next + "/" + running.total + "). Annule-le d'abord si tu veux repartir.", { io: true }));
    }
    prepareImport_(fileName);
    return continueImportAction(e);
  } catch (err) {
    return navigateTo_(buildMainCard_(threadId, "❌ " + escapeHtml_(safeErrorMessage_(err)), { io: true }));
  }
}

/** Une salve d'import (~20 s) puis retour au panneau ; planifie le déclencheur de secours s'il reste du travail. */
function continueImportAction(e) {
  const threadId = e.parameters.threadId;
  try {
    const p = importChunk_(IMPORT_CONFIG.PANEL_RUN_MS);
    let notice;
    if (p.done) {
      deleteImportTriggers_();               // le cache a été mis à jour au fil des créations
      notice = "✅ Import terminé : <b>" + p.created + "</b> créés, " + p.skipped + " ignorés, " + p.failed + " en échec.";
    } else {
      scheduleImportContinuation_();
      notice = "⏳ " + p.next + " / " + p.total + " traités (" + p.created + " créés). Clique <b>▶️ Continuer</b> pour la salve suivante — sinon la tâche de secours reprendra dans 1 h.";
    }
    return navigateTo_(buildMainCard_(threadId, notice, { io: true }));
  } catch (err) {
    const p = getImportProgress_();
    if (p) { p.lastError = safeErrorMessage_(err); p.done = true; setImportProgress_(p); }
    return navigateTo_(buildMainCard_(threadId, "❌ " + escapeHtml_(safeErrorMessage_(err)), { io: true }));
  }
}

function refreshImportStatusAction(e) {
  return navigateTo_(buildMainCard_(e.parameters.threadId, "", { io: true }));
}

function cancelImportAction(e) {
  const threadId = e.parameters.threadId;
  try {
    cancelImport_();
    return navigateTo_(buildMainCard_(threadId, "⏹️ Import annulé (les filtres déjà créés restent).", { io: true }));
  } catch (err) {
    return navigateTo_(buildMainCard_(threadId, "❌ " + escapeHtml_(safeErrorMessage_(err)), { io: true }));
  }
}

/** Génère delta.xml / delta.txt (filtres du XML absents de Gmail) pour import par l'écran Gmail. */
function generateDeltaAction(e) {
  const threadId = e.parameters.threadId;
  try {
    const fileName = String(formValue_(e, "xmlFileName") || IMPORT_CONFIG.XML_FILE_NAME).trim();
    const r = generateDeltaFile(fileName);
    const notice = r.count === 0
      ? "✅ Rien à importer : les " + r.total + " filtres du XML sont déjà dans Gmail (" + r.existing + " filtres)."
      : "📤 <b>" + r.count + "</b> filtres manquants (sur " + r.total + " ; " + r.existing + " déjà dans Gmail) → Drive / « " + escapeHtml_(r.folder) + " »" +
        "<br><a href=\"" + r.xmlUrl + "\">" + escapeHtml_(r.xmlName) + "</a> · <a href=\"" + r.txtUrl + "\">" + escapeHtml_(r.txtName) + "</a> (à renommer en .xml si le .xml est bloqué)" +
        "<br><font color=\"#5f6368\">Gmail → Paramètres → Filtres et adresses bloquées → Importer des filtres → tout cocher → Créer. Puis 🔄 Recharger.</font>";
    return navigateTo_(buildMainCard_(threadId, notice, { io: true }));
  } catch (err) {
    return navigateTo_(buildMainCard_(threadId, "❌ " + escapeHtml_(safeErrorMessage_(err)), { io: true }));
  }
}

function exportToXmlAction(e) {
  const threadId = e.parameters.threadId;
  try {
    const url = exportToXml();
    const idx = getFilterIndex_(false);
    return navigateTo_(buildMainCard_(threadId,
      "💾 Sauvegarde écrite : <b>" + idx.rules.length + "</b> filtres → Drive / « " + escapeHtml_(IMPORT_CONFIG.BACKUP_FOLDER) + " »" +
      "<br><a href=\"" + url + "\">Ouvrir le fichier</a>", { io: true }));
  } catch (err) {
    return navigateTo_(buildMainCard_(threadId, "❌ " + escapeHtml_(safeErrorMessage_(err)), { io: true }));
  }
}

/* ───────── suppression (en deux temps) ───────── */

function confirmDeleteAction(e) {
  try {
    const threadId = e.parameters.threadId;
    const filterId = e.parameters.filterId;
    const rule = findRule_(filterId);
    if (!rule) return navigateTo_(buildErrorCard_("Filtre introuvable (déjà supprimé ?) : " + filterId));

    const card = CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle("Supprimer ce filtre ?"))
      .addSection(
        CardService.newCardSection()
          .addWidget(CardService.newTextParagraph().setText("<b>Critère :</b> " + escapeHtml_(rule.description)))
          .addWidget(CardService.newTextParagraph().setText("<b>Actions :</b> " + escapeHtml_(rule.actions.join(" · "))))
          .addWidget(CardService.newTextParagraph().setText("<font color=\"#c5221f\">La suppression est définitive (les mails déjà traités ne changent pas).</font>"))
          .addWidget(
            CardService.newButtonSet()
              .addButton(
                CardService.newTextButton()
                  .setText("Oui, supprimer")
                  .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
                  .setBackgroundColor("#c5221f")
                  .setOnClickAction(action_("deleteFilterAction", { threadId: threadId, filterId: filterId }))
              )
              .addButton(
                CardService.newTextButton()
                  .setText("Annuler")
                  .setOnClickAction(action_("analyzeThreadAction", { threadId: threadId }))
              )
          )
      );
    return navigateTo_(card.build());
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("confirmDeleteAction", err)));
  }
}

function deleteFilterAction(e) {
  try {
    const threadId = e.parameters.threadId;
    const filterId = e.parameters.filterId;
    const rule = findRule_(filterId);

    if (isApiSlow_()) {
      // API lente : on ne risque pas les 30 s du panneau → file d'attente
      enqueueOp_({ type: "delete", filterId: filterId, desc: rule ? rule.description : filterId });
      return navigateTo_(buildMainCard_(threadId,
        "⏳ Suppression <b>mise en attente</b> (" + apiSpeedLabel_() + ") : " + escapeHtml_(rule ? rule.description : filterId) +
        "<br><font color=\"#5f6368\">Appliquée par le passage horaire, ou via ▶️ Appliquer maintenant.</font>", {}));
    }
    const t0 = Date.now();
    Gmail.Users.Settings.Filters.remove("me", filterId);
    recordApiLatency_(Date.now() - t0);
    cacheRemoveFilters_([filterId]);          // mise à jour incrémentale du cache (pas de relecture API)

    const thread = GmailApp.getThreadById(threadId);
    const result = analyzeThread_(thread);
    return navigateTo_(buildResultCard_(threadId, thread, result,
      "🗑️ Filtre supprimé : " + escapeHtml_(rule ? rule.description : filterId)));
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("deleteFilterAction", err)));
  }
}

function findRule_(filterId) {
  const idx = getFilterIndex_(false);
  for (let i = 0; i < idx.rules.length; i++) if (idx.rules[i].id === filterId) return idx.rules[i];
  return null;
}

/* ───────── création ───────── */

function createFilterAction(e) {
  try {
    const threadId = e.parameters.threadId;
    const phrase = String(formValue_(e, "phrase") || "").trim().replace(/^"+|"+$/g, "");
    const target = String(formValue_(e, "labelName") || APP_CONFIG.DEFAULT_LABEL);
    const options = formValues_(e, "options");

    if (!phrase) return navigateTo_(buildMainCard_(threadId, "⚠️ Indique une phrase.", { create: true }));

    const idx = getFilterIndex_(false);
    const action = { addLabelIds: [], removeLabelIds: [] };
    const newLabels = [];

    if (target === "__TRASH__") {
      action.addLabelIds.push("TRASH");
    } else {
      let labelId = idx.labelsByName[target];
      if (!labelId) {
        const created = Gmail.Users.Labels.create({ name: target, labelListVisibility: "labelShow", messageListVisibility: "show" }, "me");
        labelId = created.id;
        newLabels.push({ id: created.id, name: target });
      }
      action.addLabelIds.push(labelId);
    }
    if (options.indexOf("archive") >= 0) action.removeLabelIds.push("INBOX");
    if (options.indexOf("read") >= 0) action.removeLabelIds.push("UNREAD");
    if (!action.removeLabelIds.length) delete action.removeLabelIds;

    const query = '"' + phrase + '"';

    // doublon ?
    const dup = idx.rules.filter(function(r) {
      return normalizeFilterText_(r.criteria.query || "") === normalizeFilterText_(query);
    });
    if (dup.length) {
      return navigateTo_(buildMainCard_(threadId, "⚠️ Un filtre avec cette phrase existe déjà (" + escapeHtml_(dup[0].actions.join(" · ")) + ").", { create: true }));
    }

    if (isApiSlow_()) {
      enqueueOp_({ type: "create", filter: { criteria: { query: query }, action: action }, newLabels: newLabels,
                   desc: query + " → " + (target === "__TRASH__" ? "corbeille" : target) });
      return navigateTo_(buildMainCard_(threadId,
        "⏳ Filtre <b>mis en attente</b> (" + apiSpeedLabel_() + ") : " + escapeHtml_(query) + " → " + escapeHtml_(target === "__TRASH__" ? "corbeille" : target) +
        "<br><font color=\"#5f6368\">Créé par le passage horaire, ou via ▶️ Appliquer maintenant.</font>", { create: true }));
    }
    const t0 = Date.now();
    const created = Gmail.Users.Settings.Filters.create({ criteria: { query: query }, action: action }, "me");
    recordApiLatency_(Date.now() - t0);
    cacheAddFilter_(created, newLabels);       // mise à jour incrémentale du cache (pas de relecture API)

    return navigateTo_(buildMainCard_(threadId,
      "✅ Filtre créé : " + escapeHtml_(query) + " → " + escapeHtml_(target === "__TRASH__" ? "corbeille" : target) +
      "<br><i>Il s'appliquera aux prochains mails (Gmail n'applique pas les filtres au passé).</i>", { create: true }));
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("createFilterAction", err)));
  }
}

function formValue_(e, name) {
  const v = formValues_(e, name);
  return v.length ? v[0] : "";
}

function formValues_(e, name) {
  try {
    const fi = e.commonEventObject && e.commonEventObject.formInputs && e.commonEventObject.formInputs[name];
    if (fi && fi.stringInputs && fi.stringInputs.value) return fi.stringInputs.value.slice();
  } catch (x) {}
  try {
    const v = e.formInput && e.formInput[name];
    if (v == null) return [];
    return Array.isArray(v) ? v : [String(v)];
  } catch (x) {}
  return [];
}