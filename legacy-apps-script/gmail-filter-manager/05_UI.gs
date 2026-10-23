/**
 * 05_UI.gs — cartes du panneau latéral.
 *
 * Carte principale = 5 zones :
 *   📧 MAIL EN COURS      (toujours ouverte)
 *   🕵️ INDICATEUR SPAM    (verdict visible, détail repliable)
 *   ➕ CRÉER UN FILTRE     (repliable)
 *   📦 IMPORT / EXPORT     (repliable)
 *   🔄 RECHARGER           (repliable)
 */

function getContextualAddOn(e) {
  try {
    if (!e || !e.gmail || !e.gmail.threadId) return buildErrorCard_("Aucun mail sélectionné");
    return buildMainCard_(e.gmail.threadId, "", {});
  } catch (err) {
    return buildErrorCard_(formatError_("getContextualAddOn", err));
  }
}

function returnToMainCard(e) {
  try {
    return navigateTo_(buildMainCard_(e.parameters.threadId, "", {}));
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("returnToMainCard", err)));
  }
}

/**
 * @param {string} threadId
 * @param {string} notice   message HTML affiché en haut (résultat d'une action)
 * @param {Object} open     zones à afficher dépliées : { create: true, io: true, reload: true }
 */
function buildMainCard_(threadId, notice, open) {
  open = open || {};
  const thread = GmailApp.getThreadById(threadId);
  const message = getLastMessageOfThread_(thread);
  const currentThreadLabels = thread.getLabels().map(function(l) { return l.getName(); });
  const index = getFilterIndex_(false);

  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle("Gmail Filter Manager")
      .setSubtitle(index.rules.length + " filtres · " + (index.fromCache ? "cache" : "lus à l'instant") + (index.unstable ? " · ⚠️ API instable" : "")));

  if (notice) {
    card.addSection(CardService.newCardSection()
      .addWidget(CardService.newDecoratedText().setText(notice).setWrapText(true)));
  }

  /* ── 0. modifications en attente (API lente) ──────── */
  try { const qs = buildQueueSection_(threadId); if (qs) card.addSection(qs); } catch (e) {}

  /* ── 1. MAIL EN COURS ─────────────────────────────── */
  card.addSection(
    CardService.newCardSection()
      .setHeader("📧 MAIL EN COURS")
      .addWidget(CardService.newDecoratedText().setTopLabel("De").setText(escapeHtml_(message.getFrom() || "")).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setTopLabel("Sujet").setText(escapeHtml_(message.getSubject() || "")).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setTopLabel("Libellés").setText(escapeHtml_(currentThreadLabels.join(", ") || "aucun")).setWrapText(true))
      .addWidget(
        CardService.newButtonSet().addButton(
          CardService.newTextButton()
            .setText("🔍 Pourquoi ces filtres ?")
            .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
            .setBackgroundColor("#1f73e6")
            .setOnClickAction(action_("analyzeThreadAction", { threadId: threadId }))
        )
      )
  );

  /* ── 2. INDICATEUR SPAM ───────────────────────────── */
  card.addSection(buildScamSection_(threadId, message, !!open.scam));

  /* ── 3. CRÉER UN FILTRE ───────────────────────────── */
  card.addSection(buildCreateSection_(threadId, index, !open.create));

  /* ── 4. IMPORT / EXPORT ───────────────────────────── */
  card.addSection(buildImportExportSection_(threadId, !open.io));

  /* ── 5. RECHARGER ─────────────────────────────────── */
  card.addSection(
    CardService.newCardSection()
      .setHeader("🔄 RECHARGER")
      .setCollapsible(true)
      .setNumUncollapsibleWidgets(open.reload ? 2 : 0)
      .addWidget(
        CardService.newButtonSet().addButton(
          CardService.newTextButton()
            .setText("🔄 Relire les filtres depuis Gmail")
            .setOnClickAction(action_("reloadFiltersAction", { threadId: threadId }))
        )
      )
      .addWidget(CardService.newTextParagraph().setText(
        "<font color=\"#5f6368\">Cache : " + (index.fromCache ? "oui, mis à jour il y a " + minutesAgo_(index.builtAt) + " min" : "non (API à l'instant)") +
        ". Le cache (fichier Drive) est tenu à jour automatiquement par les créations / suppressions faites ici ; " +
        "relis l'API uniquement après un import web ou une modification dans Paramètres → Filtres. " +
        "Si la relecture dépasse 30 s (beaucoup de filtres), lance <b>refreshFilterIndex</b> depuis l'éditeur, ou <b>installHourlyRefresh</b> pour l'automatiser toutes les heures.</font>"))
  );

  return card.build();
}

/* ───────── indicateur spam ───────── */

/** Jauge texte : ██████░░░░ 62/100 */
function scamGauge_(r) {
  const filled = Math.round(r.score / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return "<b><font color=\"" + r.color + "\">" + r.icon + " " + r.score + "/100</font></b> &nbsp;<font color=\"" + r.color + "\">" + bar + "</font>" +
    "<br>" + escapeHtml_(r.verdict) +
    (r.findings.length ? " · <font color=\"#5f6368\">" + r.findings.length + " indice" + (r.findings.length > 1 ? "s" : "") + "</font>" : "");
}

function buildScamSection_(threadId, message, expanded) {
  const section = CardService.newCardSection().setHeader("🕵️ INDICATEUR SPAM").setCollapsible(true);
  try {
    const r = analyzeScam_(message);
    section.addWidget(CardService.newDecoratedText().setText(scamGauge_(r)).setWrapText(true));
    r.findings.slice(0, 3).forEach(function(f) {
      section.addWidget(CardService.newDecoratedText()
        .setTopLabel("+" + f.points + " pts")
        .setText(f.icon + " " + escapeHtml_(f.title))
        .setWrapText(true));
    });
    section.addWidget(CardService.newButtonSet().addButton(
      CardService.newTextButton()
        .setText("🔎 Voir toutes les entourloupes")
        .setOnClickAction(action_("scamDetailAction", { threadId: threadId }))
    ));
    section.setNumUncollapsibleWidgets(expanded ? 2 + Math.min(3, r.findings.length) : 1);
  } catch (err) {
    section.addWidget(CardService.newTextParagraph().setText("<font color=\"#c5221f\">Analyse impossible : " + escapeHtml_(safeErrorMessage_(err)) + "</font>"));
    section.setNumUncollapsibleWidgets(1);
  }
  return section;
}

function scamDetailAction(e) {
  try {
    const threadId = e.parameters.threadId;
    const thread = GmailApp.getThreadById(threadId);
    const message = getLastMessageOfThread_(thread);
    return navigateTo_(buildScamCard_(threadId, message, analyzeScam_(message)));
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("scamDetailAction", err)));
  }
}

function buildScamCard_(threadId, message, r) {
  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle(r.icon + " Indicateur spam : " + r.score + "/100")
      .setSubtitle(r.verdict));

  card.addSection(
    CardService.newCardSection()
      .setHeader("📧 MAIL EN COURS")
      .addWidget(CardService.newDecoratedText().setTopLabel("De").setText(escapeHtml_(message.getFrom() || "")).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setTopLabel("Sujet").setText(escapeHtml_(message.getSubject() || "")).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setText(scamGauge_(r)).setWrapText(true))
  );

  const fs = CardService.newCardSection().setHeader("🕵️ ENTOURLOUPES DÉTECTÉES (" + r.findings.length + ")");
  if (!r.findings.length) {
    fs.addWidget(CardService.newTextParagraph().setText("Rien à signaler : pas de texte caché, pas de mots découpés, expéditeur cohérent" +
      (r.auth.raw ? ", SPF/DKIM/DMARC " + escapeHtml_((r.auth.spf || "?") + "/" + (r.auth.dkim || "?") + "/" + (r.auth.dmarc || "?")) : "") + "."));
  }
  r.findings.forEach(function(f) {
    fs.addWidget(CardService.newDecoratedText()
      .setTopLabel("+" + f.points + " pts")
      .setText("<b>" + f.icon + " " + escapeHtml_(f.title) + "</b>" + (f.detail ? "<br><font color=\"#5f6368\">" + escapeHtml_(f.detail) + "</font>" : ""))
      .setWrapText(true));
  });
  card.addSection(fs);

  const st = r.stats;
  const ts = CardService.newCardSection().setHeader("👀 CE QUE TU VOIS vs CE QUE LE FILTRE VOIT").setCollapsible(true).setNumUncollapsibleWidgets(1)
    .addWidget(CardService.newDecoratedText().setTopLabel("Chiffres")
      .setText(st.visibleChars + " car. visibles · <b>" + st.hiddenChars + " car. cachés</b> · " + st.links + " lien" + (st.links > 1 ? "s" : "") + " · " + st.images + " image" + (st.images > 1 ? "s" : "") +
        (r.auth.raw ? "<br>SPF " + escapeHtml_(r.auth.spf || "?") + " · DKIM " + escapeHtml_(r.auth.dkim || "?") + " · DMARC " + escapeHtml_(r.auth.dmarc || "?") : ""))
      .setWrapText(true))
    .addWidget(CardService.newDecoratedText().setTopLabel("Texte visible (lettres recollées)").setText(escapeHtml_(r.visibleSample || "—")).setWrapText(true))
    .addWidget(CardService.newDecoratedText().setTopLabel("Texte caché (invisible à l'écran, mais lu par les filtres)").setText(escapeHtml_(r.hiddenSample || "—")).setWrapText(true));
  card.addSection(ts);

  if (r.links.length) {
    const ls = CardService.newCardSection().setHeader("🔗 LIENS (" + st.links + ")").setCollapsible(true).setNumUncollapsibleWidgets(0);
    r.links.forEach(function(l) {
      ls.addWidget(CardService.newDecoratedText().setTopLabel(escapeHtml_(l.text || "(image / sans texte)")).setText(escapeHtml_(l.host || l.href)).setWrapText(true));
    });
    card.addSection(ls);
  }

  card.addSection(
    CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText("<font color=\"#5f6368\">Score = somme des ruses détectées (plafonné à 100). 0–14 ✅ propre · 15–39 ⚠️ douteux · 40+ 🚨 scam. " +
        "Un mail honnête n'a aucune raison de cacher du texte ou de découper ses mots.</font>"))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton().setText("🔍 Pourquoi ces filtres ?").setOnClickAction(action_("analyzeThreadAction", { threadId: threadId })))
        .addButton(CardService.newTextButton().setText("← Retour").setOnClickAction(action_("returnToMainCard", { threadId: threadId }))))
  );
  return card.build();
}

function buildCreateSection_(threadId, index, collapsed) {
  const labelNames = Object.keys(index.labelsByName).filter(function(n) {
    return !/^(CHAT|SENT|INBOX|IMPORTANT|TRASH|DRAFT|SPAM|STARRED|UNREAD|CATEGORY_.*)$/.test(n);
  }).sort();

  const dropdown = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setFieldName("labelName")
    .setTitle("Action du filtre");
  dropdown.addItem("🏷️ " + APP_CONFIG.DEFAULT_LABEL, APP_CONFIG.DEFAULT_LABEL, true);
  dropdown.addItem("🗑️ Corbeille", "__TRASH__", false);
  labelNames.forEach(function(n) {
    if (n !== APP_CONFIG.DEFAULT_LABEL) dropdown.addItem("🏷️ " + n, n, false);
  });

  return CardService.newCardSection()
    .setHeader("➕ CRÉER UN FILTRE")
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(collapsed ? 0 : 4)
    .addWidget(
      CardService.newTextInput()
        .setFieldName("phrase")
        .setTitle("Phrase exacte présente dans le mail")
        .setHint("sans guillemets — ex. colis est bloqué au dépôt")
    )
    .addWidget(dropdown)
    .addWidget(
      CardService.newSelectionInput()
        .setType(CardService.SelectionInputType.CHECK_BOX)
        .setFieldName("options")
        .addItem("Archiver (ne pas laisser en boîte de réception)", "archive", false)
        .addItem("Marquer comme lu", "read", false)
    )
    .addWidget(
      CardService.newButtonSet().addButton(
        CardService.newTextButton()
          .setText("➕ Créer le filtre")
          .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
          .setBackgroundColor("#188038")
          .setOnClickAction(action_("createFilterAction", { threadId: threadId }))
      )
    );
}

function buildImportExportSection_(threadId, collapsed) {
  const st = getImportProgress_();
  let status;
  if (!st) {
    status = "<font color=\"#5f6368\">Aucun import en cours.</font>";
  } else if (st.lastError) {
    status = "❌ La tâche de fond a échoué : <font color=\"#c5221f\">" + escapeHtml_(st.lastError) + "</font>" +
      "<br><font color=\"#5f6368\">" + st.next + " / " + st.total + " traités avant l'erreur. Corrige puis relance l'import (il reprend où il en était).</font>";
  } else if (st.done) {
    status = "✅ Dernier import terminé : <b>" + st.created + "</b> créés, " + st.skipped + " ignorés (déjà présents), " + st.failed + " en échec" +
      (st.errors && st.errors.length ? "<br><font color=\"#c5221f\">" + escapeHtml_(st.errors.slice(0, 3).join(" · ")) + "</font>" : "") +
      "<br><font color=\"#5f6368\">Clique 🔄 Recharger pour voir les nouveaux filtres.</font>";
  } else {
    status = "⏳ Import en cours : <b>" + st.next + " / " + st.total + "</b> traités — " + st.created + " créés, " + st.skipped + " ignorés" +
      (st.failed ? ", <font color=\"#c5221f\">" + st.failed + " échecs</font>" : "") + "." +
      "<br><font color=\"#5f6368\">Clique ▶️ Continuer pour la salve suivante (~20 s). Sans clic, la tâche de secours reprend dans 1 h.</font>";
  }
  const running = st && !st.done && !st.lastError;

  return CardService.newCardSection()
    .setHeader("📦 IMPORT / EXPORT")
    .setCollapsible(true)
    .setNumUncollapsibleWidgets(collapsed ? 0 : 6)
    .addWidget(
      CardService.newTextInput()
        .setFieldName("xmlFileName")
        .setTitle("Fichier XML dans ton Drive (nom exact)")
        .setValue(IMPORT_CONFIG.XML_FILE_NAME)
        .setHint("dépose le fichier dans Drive, n'importe quel dossier")
    )
    .addWidget(
      CardService.newButtonSet()
        .addButton(
          CardService.newTextButton()
            .setText("📤 Générer delta.xml")
            .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
            .setBackgroundColor("#188038")
            .setOnClickAction(action_("generateDeltaAction", { threadId: threadId }))
        )
        .addButton(
          CardService.newTextButton()
            .setText("📥 Importer (API, lent)")
            .setOnClickAction(action_("importFromXmlAction", { threadId: threadId }))
        )
        .addButton(
          CardService.newTextButton()
            .setText("💾 Exporter une sauvegarde")
            .setOnClickAction(action_("exportToXmlAction", { threadId: threadId }))
        )
        .addButton(
          CardService.newTextButton()
            .setText("🧰 Traceur console")
            .setOnClickAction(action_("showTracerAction", { threadId: threadId }))
        )
    )
    .addWidget(CardService.newDecoratedText().setTopLabel("État").setText(status).setWrapText(true))
    .addWidget(
      (function() {
        const bs = CardService.newButtonSet();
        if (running) {
          bs.addButton(CardService.newTextButton().setText("▶️ Continuer").setTextButtonStyle(CardService.TextButtonStyle.FILLED).setBackgroundColor("#1f73e6")
            .setOnClickAction(action_("continueImportAction", { threadId: threadId })));
        }
        bs.addButton(CardService.newTextButton().setText("🔁 Actualiser").setOnClickAction(action_("refreshImportStatusAction", { threadId: threadId })));
        if (running) {
          bs.addButton(CardService.newTextButton().setText("⏹️ Annuler").setOnClickAction(action_("cancelImportAction", { threadId: threadId })));
        }
        return bs;
      })()
    )
    .addWidget(CardService.newTextParagraph().setText(
      "<font color=\"#5f6368\"><b>Delta</b> : écrit delta.xml (+ .txt) avec seulement les filtres du fichier absents de Gmail → à importer par l'écran Gmail (rapide, sans doublon). " +
      "<b>Importer (API)</b> : crée les manquants un par un, ~10 s chacun (Gmail freine). " +
      "<b>Exporter</b> : sauvegarde datée dans Drive / « " + IMPORT_CONFIG.BACKUP_FOLDER + " ». " +
      "<b>Traceur</b> : code console pour suivre / mettre en pause / tuer l'import web de Gmail.</font>"));
}

/* ───────── analyse ───────── */

function analyzeThreadAction(e) {
  try {
    const threadId = e.parameters.threadId;
    const thread = GmailApp.getThreadById(threadId);
    const result = analyzeThread_(thread);
    return navigateTo_(buildResultCard_(threadId, thread, result, ""));
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("analyzeThreadAction", err)));
  }
}

function buildResultCard_(threadId, thread, result, notice) {
  const lastMessage = getLastMessageOfThread_(thread);
  const currentThreadLabels = thread.getLabels().map(function(l) { return l.getName(); });
  const n = result.matches.length;

  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle(n === 0 ? "Aucun filtre ne matche" : n + " filtre" + (n > 1 ? "s" : "") + " concerné" + (n > 1 ? "s" : ""))
      .setSubtitle(result.ruleCount + " filtres testés en " + result.elapsedMs + " ms"));

  if (notice) card.addSection(CardService.newCardSection().addWidget(CardService.newDecoratedText().setText(notice).setWrapText(true)));

  card.addSection(
    CardService.newCardSection()
      .setHeader("📧 MAIL EN COURS")
      .addWidget(CardService.newDecoratedText().setTopLabel("De").setText(escapeHtml_(lastMessage.getFrom() || "")).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setTopLabel("Sujet").setText(escapeHtml_(lastMessage.getSubject() || "")).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setTopLabel("Libellés" + (result.messageCount > 1 ? " · " + result.messageCount + " messages dans le thread" : ""))
        .setText(escapeHtml_(currentThreadLabels.join(", ") || "aucun")).setWrapText(true))
  );

  if (!n) {
    card.addSection(
      CardService.newCardSection()
        .setHeader("⚠️ RÉSULTAT")
        .addWidget(CardService.newTextParagraph().setText("Aucun de tes " + result.ruleCount + " filtres ne correspond à ce mail."))
        .addWidget(CardService.newTextParagraph().setText("<font color=\"#5f6368\"><i>Libellé posé à la main, filtre supprimé depuis, ou nuance Gmail (racines de mots, texte d'une image…) que ce moteur ne voit pas.</i></font>"))
    );
  }

  result.matches.slice(0, APP_CONFIG.MAX_MATCHES_DISPLAYED).forEach(function(m, i) {
    const rule = m.rule;
    const section = CardService.newCardSection()
      .setHeader("🎯 FILTRE " + (i + 1) + "/" + n)
      .addWidget(CardService.newDecoratedText().setTopLabel("Action").setText(escapeHtml_(rule.actions.join(" · ") || "aucune")).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setTopLabel("Critère du filtre").setText(escapeHtml_(rule.description)).setWrapText(true))
      .addWidget(CardService.newDecoratedText().setTopLabel("Déclenché par").setText(escapeHtml_(m.reasons.join("\n")).replace(/\n/g, "<br>")).setWrapText(true));

    if (result.messageCount > 1) {
      section.addWidget(CardService.newDecoratedText().setTopLabel("Message(s) du thread").setText("#" + m.messages.join(", #")));
    }
    if (m.preview) {
      section.addWidget(CardService.newDecoratedText().setTopLabel("Extrait du mail (phrase surlignée)").setText(renderHighlighted_(m.preview)).setWrapText(true));
    }
    section.addWidget(
      CardService.newButtonSet().addButton(
        CardService.newTextButton()
          .setText("🗑️ Supprimer ce filtre")
          .setOnClickAction(action_("confirmDeleteAction", { threadId: threadId, filterId: rule.id }))
      )
    );
    card.addSection(section);
  });

  if (n > APP_CONFIG.MAX_MATCHES_DISPLAYED) {
    card.addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText("… et " + (n - APP_CONFIG.MAX_MATCHES_DISPLAYED) + " autres.")));
  }

  /* libellés du thread qu'aucun filtre déclenché n'explique */
  const explained = {};
  result.matches.forEach(function(m) { m.rule.addLabels.forEach(function(l) { explained[l] = true; }); });
  const unexplained = currentThreadLabels.filter(function(l) { return !explained[l]; });
  if (unexplained.length) {
    const us = CardService.newCardSection().setHeader("❓ LIBELLÉ" + (unexplained.length > 1 ? "S" : "") + " NON EXPLIQUÉ" + (unexplained.length > 1 ? "S" : ""))
      .addWidget(CardService.newTextParagraph().setText("<font color=\"#5f6368\">Présent" + (unexplained.length > 1 ? "s" : "") + " sur le mail, mais aucun filtre ne le déclenche à la lettre. " +
        "Gmail est plus souple que ce moteur (racines de mots, apostrophes), ou le filtre a été modifié / supprimé depuis l'arrivée du mail, ou le libellé a été posé à la main.</font>"));
    unexplained.forEach(function(l) {
      us.addWidget(CardService.newDecoratedText().setText(escapeHtml_(l)).setWrapText(true)
        .setButton(CardService.newTextButton().setText("🔬 Pourquoi ?").setOnClickAction(action_("explainLabelAction", { threadId: threadId, label: l }))));
    });
    card.addSection(us);
  }

  card.addSection(
    CardService.newCardSection().addWidget(
      CardService.newButtonSet().addButton(
        CardService.newTextButton().setText("← Retour").setOnClickAction(action_("returnToMainCard", { threadId: threadId }))
      )
    )
  );

  return card.build();
}

/* ───────── « pourquoi ce libellé ? » ───────── */

function explainLabelAction(e) {
  try {
    const threadId = e.parameters.threadId, label = e.parameters.label;
    const thread = GmailApp.getThreadById(threadId);
    const r = explainLabel_(thread, label);
    const card = CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle("🔬 Pourquoi « " + label + " » ?").setSubtitle(r.ruleCount + " filtres posent ce libellé · " + r.candidates.length + " candidat" + (r.candidates.length > 1 ? "s" : "")));

    if (!r.candidates.length) {
      card.addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(
        "Aucun des " + r.ruleCount + " filtres qui posent ce libellé n'a ses mots dans ce mail, même approximativement.<br>" +
        "<font color=\"#5f6368\">Le libellé vient donc d'ailleurs : posé à la main, par un filtre supprimé ou modifié depuis, par un autre module, ou par un filtre créé après ce mail (Gmail n'applique pas les filtres au passé). " +
        "Si le cache est ancien, fais 🔄 Recharger et réessaie.</font>")));
    } else {
      card.addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(
        "<font color=\"#5f6368\">Filtres dont les mots sont <i>presque</i> là. Gmail rapproche les racines de mots (investissement ≈ investissements) et ignore l'ordre dans certains cas ; le plus probable est en tête.</font>")));
      r.candidates.forEach(function(c, i) {
        const s = CardService.newCardSection().setHeader("🎯 CANDIDAT " + (i + 1) + " · score " + c.score)
          .addWidget(CardService.newDecoratedText().setTopLabel("Critère du filtre").setText(escapeHtml_(c.rule.description)).setWrapText(true))
          .addWidget(CardService.newDecoratedText().setTopLabel("Action").setText(escapeHtml_(c.rule.actions.join(" · "))).setWrapText(true))
          .addWidget(CardService.newDecoratedText().setTopLabel("Pourquoi c'est proche").setText(escapeHtml_(c.reason)).setWrapText(true));
        if (c.preview) s.addWidget(CardService.newDecoratedText().setTopLabel("Extrait").setText(escapeHtml_(c.preview)).setWrapText(true));
        s.addWidget(CardService.newButtonSet().addButton(CardService.newTextButton().setText("🗑️ Supprimer ce filtre")
          .setOnClickAction(action_("confirmDeleteAction", { threadId: threadId, filterId: c.rule.id }))));
        card.addSection(s);
      });
    }
    card.addSection(CardService.newCardSection().addWidget(CardService.newButtonSet()
      .addButton(CardService.newTextButton().setText("← Filtres du mail").setOnClickAction(action_("analyzeThreadAction", { threadId: threadId })))
      .addButton(CardService.newTextButton().setText("← Accueil").setOnClickAction(action_("returnToMainCard", { threadId: threadId })))));
    return navigateTo_(card.build());
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("explainLabelAction", err)));
  }
}

/* ───────── helpers UI ───────── */

function action_(fn, params) {
  return CardService.newAction().setFunctionName(fn).setParameters(params || {}).setLoadIndicator(CardService.LoadIndicator.SPINNER);
}

function navigateTo_(card) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card))
    .build();
}

function buildErrorCard_(msg) {
  return CardService.newCardBuilder()
    .addSection(CardService.newCardSection().setHeader("❌ ERREUR").addWidget(CardService.newTextParagraph().setText(escapeHtml_(msg))))
    .build();
}

function minutesAgo_(ts) {
  return Math.max(0, Math.round((Date.now() - (ts || Date.now())) / 60000));
}