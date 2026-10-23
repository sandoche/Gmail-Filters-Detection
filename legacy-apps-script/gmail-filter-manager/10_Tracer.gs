/**
 * 10_Tracer.gs — traceur console pour l'import web de Gmail (Paramètres → Filtres → Importer).
 * Le code JS est affiché dans le panneau (zone IMPORT / EXPORT → 🧪 Traceur) pour être copié-collé
 * dans la console du navigateur (F12) avant de cliquer « Créer les filtres ».
 * Il affiche un panneau flottant : compteur, vitesse, ETA, ⏸ Pause / ▶ Reprendre / ⏹ Stop (tue l'import
 * et retire la boîte « Création des filtres » de Gmail).
 */

const IMPORT_TRACER_JS = String.raw`(() => {
if (window.__imp) { console.log("traceur déjà actif — fais F5 pour installer cette version"); return; }
const S = window.__imp = { v: 5, stopped: false, n: 0, ok: 0, ko: 0, other: 0, refresh: 0, t0: 0, paused: false, debug: false, total: null, firstUrl: "", pending: [] };
const isMailPost = (u, m) => /mail\.google\.com/.test(String(u)) && String(m || "GET").toUpperCase() === "POST"
&& !/jserror|\/log\b|\/gen_204|play\.google|ogs\.google|clients\d\.google/.test(String(u));
const bodyText = body => {
try {
const s = typeof body === "string" ? body : (body && body.toString ? body.toString() : "");
try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch (e) { return s; }
} catch (e) { return ""; }
};
const phraseOf = d => {
const esc = d.match(/\\+"([^"\\]{2,80})\\+"/) || d.match(/\\u0022([^\\]{2,80})\\u0022/);
if (esc) return "« " + esc[1] + " »";
const f = d.match(/(?:from|de)\s*[:=]\s*([^&\s"]{3,60})/i);
return f ? "from " + f[1] : "";
};
const classify = d => {
const ph = phraseOf(d);
if (ph) return { kind: "create", phrase: ph };
if (/itemlist-ViewType/.test(d)) return { kind: "refresh", phrase: "" };
return { kind: "other", phrase: "" };
};
const readTotal = () => {
const cell = document.querySelector('td[jsname="Zpt3Fc"]');
if (cell && /^\d+$/.test(cell.textContent.trim())) { S.total = +cell.textContent.trim(); return; }
const t = (document.body && document.body.innerText) || "";
const m = t.match(/(\d+)\s*\/\s*cr[ée]{2}s\s*(\d+)/i);
if (m) S.total = +m[1];
};
const P = document.createElement("div");
P.id = "__impPanel";
P.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#202124;color:#fff;font:13px/1.5 system-ui,Arial;" +
"padding:12px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.4);min-width:260px";
const mk = (tag, id, css, text) => { const e = document.createElement(tag); if (id) e.id = id; if (css) e.style.cssText = css; if (text) e.textContent = text; return e; };
P.appendChild(mk("div", "__impTitle", "font-weight:600;margin-bottom:4px", "🟢 Traceur import — en attente"));
P.appendChild(mk("div", "__impLine", "color:#bdc1c6;margin-bottom:8px", "0 créé"));
P.appendChild(mk("div", "__impLast", "color:#8ab4f8;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px", "—"));
const row = mk("div", "", "display:flex;gap:6px");
const btn = "flex:1;padding:6px 8px;border:0;border-radius:6px;font-weight:600;cursor:pointer;";
row.appendChild(mk("button", "__impPause", btn + "background:#f9ab00;color:#202124", "⏸ Pause"));
row.appendChild(mk("button", "__impResume", btn + "background:#34a853;color:#fff;display:none", "▶ Reprendre"));
row.appendChild(mk("button", "__impStop", btn + "background:#ea4335;color:#fff", "⏹ Stop"));
P.appendChild(row);
document.body.appendChild(P);
const $ = id => document.getElementById(id);
function paint() {
const el = S.t0 ? (Date.now() - S.t0) / 1000 : 0, rate = el ? S.n / el : 0;
const eta = (S.total && rate) ? Math.max(0, Math.round((S.total - S.n) / rate / 60)) : null;
if (S.stopped) return;
$("__impTitle").textContent = S.paused ? "⏸ Import en pause (" + S.pending.length + " retenue" + (S.pending.length > 1 ? "s" : "") + ")" :
(S.t0 ? "🟢 Import en cours" : "🟢 Traceur actif — lance l'import");
$("__impLine").textContent = S.n + (S.total ? " / " + S.total : "") + " créé" + (S.n > 1 ? "s" : "") + (S.ko ? " · " + S.ko + " échec" + (S.ko > 1 ? "s" : "") : "") +
(rate ? " · " + rate.toFixed(1) + "/s" : "") + (eta != null ? " · reste ~" + eta + " min" : "");
}
readTotal(); paint();
setInterval(() => { readTotal(); paint(); }, 2000);
const report = (c, ok, ms, url) => {
if (c.kind === "refresh") { S.refresh++; return; }
if (c.kind === "other") { S.other++; if (S.other <= 3 || S.other % 50 === 0) console.log("⚙️ autre requête #" + S.other + " (" + ms + " ms) " + String(url).replace(/^https?:\/\/[^/]+/, "").slice(0, 60)); return; }
if (!S.t0) { S.t0 = Date.now() - ms; S.firstUrl = String(url).replace(/^https?:\/\/[^/]+/, "").slice(0, 90); console.log("🔗 endpoint créations : " + S.firstUrl); }
S.n++; ok ? S.ok++ : S.ko++;
const el = (Date.now() - S.t0) / 1000, rate = S.n / Math.max(1, el);
const eta = S.total ? Math.max(0, Math.round((S.total - S.n) / rate / 60)) : null;
console.log((ok ? "✔" : "❌") + " #" + S.n + (S.total ? "/" + S.total : "") + "  " + ms + " ms  " + c.phrase +
"  · " + rate.toFixed(2) + "/s" + (eta != null ? " · reste ~" + eta + " min" : ""));
$("__impLast").textContent = (ok ? "✔ " : "❌ ") + c.phrase;
paint();
};
const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return open.apply(this, arguments); };
XMLHttpRequest.prototype.send = function (body) {
if (isMailPost(this.__u, this.__m)) {
const d = bodyText(body), c = classify(d), xhr = this, u = this.__u;
if (S.debug) console.log("🐛 " + c.kind + " " + String(u).replace(/^https?:\/\/[^/]+/, "").slice(0, 60) + "\n" + d.slice(0, 300));
const go = () => {
const t = Date.now();
xhr.addEventListener("loadend", () => report(c, xhr.status >= 200 && xhr.status < 300, Date.now() - t, u));
return send.call(xhr, body);
};
if (S.stopped && c.kind === "create") { return; }
if (S.paused && c.kind === "create") { S.pending.push(go); paint(); return; }
return go();
}
return send.apply(this, arguments);
};
const f0 = window.fetch;
window.fetch = function (input, init) {
const u = typeof input === "string" ? input : (input && input.url), m = (init && init.method) || (input && input.method);
if (isMailPost(u, m)) {
const d = bodyText(init && init.body), c = classify(d), args = arguments, self = this;
if (S.debug) console.log("🐛 " + c.kind + " " + String(u).replace(/^https?:\/\/[^/]+/, "").slice(0, 60) + "\n" + d.slice(0, 300));
const go = () => {
const t = Date.now();
return f0.apply(self, args).then(r => { report(c, r.ok, Date.now() - t, u); return r; },
e => { report(c, false, Date.now() - t, u); throw e; });
};
if (S.stopped && c.kind === "create") { return new Promise(() => {}); }
if (S.paused && c.kind === "create") { return new Promise(res => { S.pending.push(() => res(go())); paint(); }); }
return go();
}
return f0.apply(this, arguments);
};
window.__pauseImport = () => { S.paused = true; $("__impPause").style.display = "none"; $("__impResume").style.display = ""; paint(); console.log("⏸ pause : la prochaine création est retenue dans le navigateur."); };
window.__resumeImport = () => { S.paused = false; $("__impPause").style.display = ""; $("__impResume").style.display = "none"; const q = S.pending.splice(0); q.forEach(fn => fn()); paint(); console.log("▶ reprise (" + q.length + " relâchée" + (q.length > 1 ? "s" : "") + ")."); };
const killGmailDialog = () => {
let removed = 0;
document.querySelectorAll('[role="dialog"]').forEach(d => {
if (/Création des filtres|Creating filters|Filtres créés/i.test(d.textContent || "")) { d.remove(); removed++; }
});
document.querySelectorAll("div").forEach(el => {
if (el === P || el.contains(P) || el.childElementCount > 2 || (el.textContent || "").trim()) return;
const cs = getComputedStyle(el);
if (cs.position !== "fixed" || cs.display === "none") return;
const r = el.getBoundingClientRect();
if (r.width >= innerWidth - 2 && r.height >= innerHeight - 2) { el.remove(); removed++; }
});
document.body.style.overflow = "";
document.querySelectorAll('[aria-hidden="true"]').forEach(el => { if (el.contains(P) || el.querySelector("form, table")) el.removeAttribute("aria-hidden"); });
return removed;
};
window.__stopImport = () => {
S.paused = true; S.stopped = true; S.pending.length = 0;
const k = killGmailDialog();
$("__impPause").style.display = "none"; $("__impResume").style.display = "none"; $("__impStop").textContent = "⏹ Arrêté";
$("__impTitle").textContent = "⏹ Import arrêté — " + S.n + " créé" + (S.n > 1 ? "s" : "");
console.log("⏹ stop : import tué, " + k + " élément(s) de la boîte Gmail retirés. " + S.n + " filtres créés. F5 avant de relancer un import.");
};
window.__importDebug = () => { S.debug = !S.debug; console.log("🐛 debug " + (S.debug ? "ON : le corps des prochaines requêtes s'affiche" : "OFF")); };
window.__importStats = () => {
const el = S.t0 ? (Date.now() - S.t0) / 1000 : 0;
console.log(S.n + " créations (" + S.ok + " ok, " + S.ko + " ko) en " + Math.round(el) + " s · " + (el ? (S.n / el).toFixed(2) : "0") + "/s · " +
S.refresh + " rafraîchissements · " + S.other + " autres · total annoncé par la page : " + (S.total || "?"));
};
$("__impPause").onclick = window.__pauseImport;
$("__impResume").onclick = window.__resumeImport;
$("__impStop").onclick = window.__stopImport;
console.log("🟢 traceur import v5 actif — lance l'import. Panneau en bas à droite : ⏸ Pause / ▶ Reprendre / ⏹ Stop. __importStats(), __importDebug() dans la console.");
})();`;

function tracerCardAction(e) {
  const threadId = e.parameters.threadId;
  try {
    return navigateTo_(buildTracerCard_(threadId, ""));
  } catch (err) {
    return navigateTo_(buildErrorCard_(formatError_("tracerCardAction", err)));
  }
}

/** Écrit aussi le traceur dans Drive (dossier des sauvegardes) pour le récupérer autrement que par copier-coller. */
function tracerToDriveAction(e) {
  const threadId = e.parameters.threadId;
  try {
    const folder = getOrCreateFolder_(IMPORT_CONFIG.BACKUP_FOLDER);
    const name = "traceur_import_web.js.txt";
    const old = folder.getFilesByName(name);
    while (old.hasNext()) old.next().setTrashed(true);
    const f = folder.createFile(name, IMPORT_TRACER_JS, "text/plain");
    return navigateTo_(buildTracerCard_(threadId, "💾 Déposé dans Drive / « " + escapeHtml_(IMPORT_CONFIG.BACKUP_FOLDER) + " » : <a href=\"" + f.getUrl() + "\">" + name + "</a>"));
  } catch (err) {
    return navigateTo_(buildTracerCard_(threadId, "❌ " + escapeHtml_(safeErrorMessage_(err))));
  }
}

function buildTracerCard_(threadId, notice) {
  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle("🧪 Traceur d'import web").setSubtitle("à coller dans la console (F12) de Gmail"));
  if (notice) card.addSection(CardService.newCardSection().addWidget(CardService.newDecoratedText().setText(notice).setWrapText(true)));
  card.addSection(
    CardService.newCardSection()
      .addWidget(CardService.newTextParagraph().setText(
        "1. Gmail → Paramètres → Filtres et adresses bloquées → Importer des filtres → choisis le fichier (delta_….xml), coche tout.<br>" +
        "2. F12 → onglet Console → colle le code ci-dessous → Entrée. Un panneau apparaît en bas à droite.<br>" +
        "3. Clique « Créer les filtres ». Le panneau affiche <b>créés / total · vitesse · ETA</b> et la dernière phrase.<br>" +
        "<b>⏸ Pause</b> gèle l'import (reprise possible), <b>⏹ Stop</b> le tue et retire la boîte de Gmail. F5 avant un nouvel import."))
      .addWidget(CardService.newTextInput().setFieldName("tracerCode").setTitle("Code à copier (clique dedans, Ctrl+A, Ctrl+C)").setMultiline(true).setValue(IMPORT_TRACER_JS))
      .addWidget(CardService.newButtonSet()
        .addButton(CardService.newTextButton().setText("💾 Déposer dans Drive").setOnClickAction(action_("tracerToDriveAction", { threadId: threadId })))
        .addButton(CardService.newTextButton().setText("← Retour").setOnClickAction(action_("returnToMainCard", { threadId: threadId }))))
  );
  return card.build();
}