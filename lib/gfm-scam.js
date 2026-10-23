// Indicateur spam : entourloupes techniques d'un mail, score 0–100
// (port de legacy-apps-script/gmail-filter-manager/09_Scam.gs).
import { normalizeMailText_, decodeXmlEntities_, stripHtmlToText_, extractEmailAddress_, safe_ } from './gfm-text.js';

const SCAM_CONFIG = {
  LEVELS: [                                   // seuils du verdict
    { min: 40, level: "scam",     icon: "🚨", color: "#c5221f", verdict: "Entourloupes manifestes — scam quasi certain" },
    { min: 15, level: "douteux",  icon: "⚠️", color: "#e37400", verdict: "Quelques ruses — mail douteux" },
    { min: 0,  level: "ok",       icon: "✅", color: "#188038", verdict: "Aucune entourloupe technique détectée" }
  ],
  SUSPICIOUS_TLDS: /\.(xyz|top|click|icu|buzz|cfd|sbs|rest|monster|quest|cyou|lol|work|link|zip|mov|bond|life|live|site|online|website|space|fun|shop|store|club|win|bid|loan|men|stream|download|racing|party|review|trade|date|faith|science|cricket|accountant|gq|ml|cf|tk|ga)$/i,
  FREE_MAIL: /(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|aol|proton(mail)?|icloud|me|gmx|laposte|orange|free|sfr|wanadoo|mail|yandex|zoho)\.(com|fr|net|me|ch|de|ru|be)$/i,
  BRANDS: ["paypal", "amazon", "lowe", "walmart", "costco", "home depot", "homedepot", "kohl", "cvs", "walgreens", "ace hardware", "best buy", "bestbuy", "geek squad",
           "mcafee", "norton", "microsoft", "apple", "google", "netflix", "disney", "spotify", "facebook", "meta", "instagram", "whatsapp",
           "ups", "fedex", "dhl", "usps", "chronopost", "colissimo", "la poste", "laposte", "mondial relay", "dpd", "gls",
           "orange", "sfr", "bouygues", "free", "ameli", "impots", "impôts", "caf", "cpf", "urssaf", "edf", "engie", "total", "antai", "ants",
           "carrefour", "leclerc", "lidl", "aldi", "auchan", "intermarche", "ikea", "dyson", "stanley", "ninja", "yeti", "milwaukee", "dewalt",
           "bank", "banque", "credit agricole", "bnp", "societe generale", "boursorama", "revolut", "n26", "visa", "mastercard", "coinbase", "binance", "ledger", "trezor", "metamask"],
  SHORTENERS: /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|is\.gd|tiny\.cc|shorturl\.at|rebrand\.ly|ow\.ly|buff\.ly|lnkd\.in|t\.ly|s\.id|v\.gd|clck\.ru|u\.to)$/i,
  // Services d'alias / de transfert : ils réécrivent l'expéditeur (« original@site.com [via Relay] <x@mozmail.com> »)
  // et ajoutent leur bannière. Les vérifications portent alors sur l'expéditeur d'origine.
  RELAYS: [
    { rx: /(^|\.)mozmail\.com$/i, name: "Firefox Relay" },
    { rx: /(^|\.)privaterelay\.appleid\.com$/i, name: "Apple « Masquer mon adresse »" },
    { rx: /(^|\.)duck\.com$/i, name: "DuckDuckGo Email" },
    { rx: /(^|\.)(simplelogin\.(co|com|io|fr)|slmail\.me|aleeas\.com|8alias\.com|8shield\.net|dralias\.com)$/i, name: "SimpleLogin" },
    { rx: /(^|\.)(anonaddy\.(me|com)|addy\.io|addymail\.com)$/i, name: "addy.io" },
    { rx: /(^|\.)(passmail\.(net|com)|passinbox\.com|passfwd\.com)$/i, name: "Proton Pass" },
    { rx: /(^|\.)33mail\.com$/i, name: "33mail" }
  ],
  RELAY_HOSTS: /(^|\.)(relay\.firefox\.com|firefox\.com|mozilla\.(org|com)|mozmail\.com|duckduckgo\.com|duck\.com|simplelogin\.(io|com)|addy\.io|anonaddy\.com|proton\.me|33mail\.com)$/i,
  // Plateformes d'envoi : leurs liens de suivi de clics affichent le site mais passent par chez elles (pas un piège).
  ESP_CLICK: /(^|\.)(list-manage\.com|sendgrid\.net|awstrack\.me|mandrillapp\.com|mjt\.lu|hubspotlinks\.com|hs-sites\.com|rs6\.net|createsend\d*\.com|sendib[tw]\d*\.com|brevo\.com|klaviyo(mail)?\.com|exacttarget\.com|sparkpostmail\.com|mailgun\.(org|net)|mailchimp\.com|mcsv\.net|cmail\d+\.com|e\.customeriomail\.com|customer\.io|mktotracking\.com|eloqua\.com|salesforce\.com|safelinks\.protection\.outlook\.com|urldefense\.com)$/i,
  MAX_SAMPLE: 320
};

/** Mail transféré par un service d'alias : { service, original } (original = adresse d'origine, ou ""). */
function relayInfo_(fromRaw) {
  const dom = domainOf_(extractEmailAddress_(fromRaw).toLowerCase());
  const relay = SCAM_CONFIG.RELAYS.find(function(r) { return r.rx.test(dom); });
  if (!relay) return null;
  const display = displayNameOf_(fromRaw);
  const inName = display.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
  const spelled = display.match(/([a-z0-9._%+\-]+)\s+at\s+([a-z0-9.\-]+\.[a-z]{2,})/i);     // DuckDuckGo, SimpleLogin : « x at site.com »
  return { service: relay.name, original: inName ? inName[0] : spelled ? spelled[1] + "@" + spelled[2] : "" };
}

/** Adresse comparable : Gmail ignore les points et ce qui suit « + » (googlemail.com = gmail.com). */
function canonicalAddress_(addr) {
  const p = String(addr || "").toLowerCase().trim().split("@");
  if (p.length !== 2) return String(addr || "").toLowerCase();
  const dom = p[1] === "googlemail.com" ? "gmail.com" : p[1];
  let local = p[0].split("+")[0];
  if (dom === "gmail.com") local = local.replace(/\./g, "");
  return local + "@" + dom;
}

/** Texte caché qui n'apparaît pas aussi en clair (une version mobile cachée sur ordinateur n'est pas une ruse). */
function uniqueHiddenText_(hidden, visible) {
  const vis = {};
  normalizeMailText_(visible).split(" ").forEach(function(w) { vis[w] = true; });
  return normalizeMailText_(hidden).split(" ").filter(function(w) { return w.length > 1 && !vis[w]; }).join(" ");
}

function analyzeScam_(message) {
  const t0 = Date.now();
  const html = safe_(function() { return message.getBody(); });
  const plain = safe_(function() { return message.getPlainBody(); });
  const subject = message.getSubject() || "";
  const relayedFrom = message.getFrom() || "";
  const relay = relayInfo_(relayedFrom);
  const fromRaw = relay && relay.original ? relay.original : relayedFrom;   // expéditeur d'origine si transféré par un alias
  const replyTo = safe_(function() { return message.getReplyTo(); });
  const toRaw = (message.getTo() || "") + " " + (message.getCc() || "");
  const headers = message.getHeaders();   // en-têtes en minuscules (voir gfm-message.js)

  const findings = [];
  const add = function(points, icon, title, detail) { findings.push({ points: points, icon: icon, title: title, detail: detail || "" }); };
  if (relay) add(0, "🔀", "Transféré par " + relay.service, relay.original ? "Expéditeur d'origine : " + relay.original + " — c'est lui qui est vérifié." : "Expéditeur d'origine inconnu.");

  /* ── 1. corps HTML : texte caché / visible ── */
  const body = splitHiddenVisible_(html);
  const visibleText = normalizeSpaces_(body.visible || (html ? "" : plain));
  const hiddenText = normalizeSpaces_(body.hidden);
  const visibleLen = visibleText.length;
  // on ne compte que le texte caché absent du texte visible (ni remplissage invisible, ni version mobile / aperçu)
  const hiddenLen = uniqueHiddenText_(hiddenText, visibleText + " " + subject).length;

  if (hiddenText.length > 0) {
    const kinds = Object.keys(body.kinds).join(", ");
    if (hiddenLen <= 200) {
      add(hiddenLen ? 3 : 0, "👻", "Un peu de texte caché (" + hiddenLen + " car. qui ne sont pas aussi visibles)",
        "Souvent un « pré-en-tête » légitime ou une version mobile du même texte. Procédé : " + kinds + ".");
    } else if (hiddenLen <= 1000) {
      add(12, "👻", "Texte caché : " + hiddenLen + " caractères invisibles",
        "Absents du texte visible : bien plus qu'un simple pré-en-tête. Procédé : " + kinds + ".");
    } else {
      add(25, "👻", "Gros bloc de texte caché : " + hiddenLen + " caractères invisibles",
        "Absents du texte visible : du remplissage pour paraître « normal » aux robots et diluer les mots-clés. Procédé : " + kinds + ".");
    }
    if (hiddenLen > visibleLen && visibleLen > 0) {
      add(8, "⚖️", "Plus de texte caché que de texte visible", hiddenLen + " car. cachés contre " + visibleLen + " visibles.");
    }
  }

  const spaced = detectSpacedLetters_(body.visibleHtml || html, visibleText);
  if (spaced.singleCharSpans >= 8) {
    add(20, "🔤", "Mots découpés lettre par lettre dans le code (" + spaced.singleCharSpans + " balises d'une lettre)",
      "À l'écran les lettres se touchent, mais pour un filtre le mot n'existe plus. Ex. : " + spaced.example);
  } else if (spaced.spacedRuns >= 2) {
    add(15, "🔤", "Lettres espacées (" + spaced.spacedRuns + " mots du type « R e a d y »)", "Ex. : " + spaced.example);
  }

  const zw = countZeroWidth_(html, subject);
  if (zw.total >= 3 || zw.inSubject) {
    add(zw.inSubject ? 18 : 12, "🫥", "Caractères de largeur nulle insérés dans les mots (" + zw.total + ")" + (zw.inSubject ? " — y compris dans le sujet" : ""),
      "Invisibles à l'œil, ils cassent les mots pour les filtres (U+200B, U+200C, U+00AD…).");
  }

  const homo = detectHomoglyphs_(visibleText + " " + subject);
  if (homo.mixedWords.length) {
    add(20, "🎭", "Mots mélangeant alphabets latin et cyrillique/grec (" + homo.mixedWords.length + ")",
      "Des lettres sosies remplacent les vraies : « " + homo.mixedWords.slice(0, 4).join(" », « ") + " ».");
  }
  if (homo.fancy >= 3) {
    add(15, "🎭", "Lettres « stylisées » Unicode (" + homo.fancy + ")",
      "Caractères mathématiques / pleine largeur (𝐂𝐨𝐧𝐟𝐢𝐫𝐦, Ｒｅｗａｒｄ) qui ressemblent à du texte mais n'en sont pas pour un filtre." + (homo.example ? " Ex. : " + homo.example : ""));
  }

  const busters = detectHashBusters_(visibleText, html);
  if (busters.randomWords >= 5) {
    add(10, "🎲", "Mots aléatoires servant de brouillage (" + busters.randomWords + ")", "Ex. : " + busters.examples.join(", "));
  }
  if (busters.commentChars >= 200) {
    add(8, "💬", "Commentaires HTML remplis de texte (" + busters.commentChars + " car.)", "Du texte que seul le code contient.");
  }

  /* ── 2. liens ── */
  // la bannière d'un service d'alias n'est pas le mail : ses liens sont ignorés
  const links = extractLinks_(html).filter(function(l) { return !(relay && l.host && SCAM_CONFIG.RELAY_HOSTS.test(l.host)); });
  const fromEmail = extractEmailAddress_(fromRaw).toLowerCase();
  const fromDomain = domainOf_(fromEmail);
  const fromReg = registrable_(fromDomain);
  let deceptive = 0, ipLinks = 0, shorteners = 0, jsLinks = 0, deceptiveEx = "";
  const hosts = {};
  links.forEach(function(l) {
    const esp = l.host && SCAM_CONFIG.ESP_CLICK.test(l.host);    // suivi de clics d'une plateforme d'envoi
    if (l.host && !esp) hosts[registrable_(l.host)] = true;
    if (/^javascript:/i.test(l.href)) jsLinks++;
    if (l.host && /^\d{1,3}(\.\d{1,3}){3}$/.test(l.host)) ipLinks++;
    if (l.host && SCAM_CONFIG.SHORTENERS.test(l.host)) shorteners++;
    const shown = (l.text.match(/\b((https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})\b/i) || [])[1];
    if (shown && l.host && !esp) {
      const shownHost = shown.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
      if (registrable_(shownHost) !== registrable_(l.host)) { deceptive++; if (!deceptiveEx) deceptiveEx = shown + " → " + l.host; }
    }
  });
  if (deceptive) add(25, "🪝", "Lien trompeur : le texte affiche un site, le lien va ailleurs (" + deceptive + ")", deceptiveEx);
  if (jsLinks) add(15, "🪝", "Lien javascript: (" + jsLinks + ")", "Jamais dans un mail honnête.");
  if (ipLinks) add(15, "🪝", "Lien vers une adresse IP brute (" + ipLinks + ")", "Pas de nom de domaine : serveur jetable.");
  if (shorteners) add(8, "🪝", "Lien raccourci (" + shorteners + ")", "Cache la vraie destination.");
  const hostList = Object.keys(hosts);
  if (hostList.length && fromReg && hostList.indexOf(fromReg) < 0 && !isBigPlatform_(hostList)) {
    add(5, "🔗", "Aucun lien ne pointe vers le domaine de l'expéditeur", "Expéditeur " + fromReg + " · liens vers " + hostList.slice(0, 4).join(", ") + (hostList.length > 4 ? "…" : ""));
  }

  /* ── 3. structure ── */
  const imgCount = (html.match(/<img\b/gi) || []).length;
  if (visibleLen < 80 && imgCount > 0 && hiddenText.length === 0) {
    add(15, "🖼️", "Mail quasiment sans texte : tout est dans une image", "Un filtre sur les mots ne peut rien y lire.");
  }
  if (/<meta[^>]+http-equiv=["']?refresh/i.test(html)) add(15, "↪️", "Redirection automatique (meta refresh)", "");
  if (/<form\b/i.test(html)) add(10, "📝", "Formulaire intégré dans le mail", "Saisie de données directement depuis le mail.");
  if (/<script\b/i.test(html)) add(10, "📜", "Script dans le mail", "Gmail le bloque, mais un mail honnête n'en met pas.");

  /* ── 4. expéditeur ── */
  const display = displayNameOf_(fromRaw);
  const emailInName = display.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i);
  if (emailInName && emailInName[0].toLowerCase() !== fromEmail) {
    add(25, "🎭", "Fausse adresse dans le nom d'affichage", "Affiche « " + emailInName[0] + " » mais envoyé par " + fromEmail);
  }
  const brand = brandInName_(display);
  if (brand && fromDomain && fromDomain.indexOf(brand.replace(/\s+/g, "")) < 0 && fromDomain.indexOf(brand.split(" ")[0]) < 0) {
    add(15, "🎭", "Se présente comme « " + brand.charAt(0).toUpperCase() + brand.slice(1) + " » mais le domaine ne correspond pas", "Nom : " + display + " · domaine réel : " + fromDomain);
  }
  if (fromDomain && SCAM_CONFIG.SUSPICIOUS_TLDS.test(fromDomain)) {
    add(10, "🌐", "Extension de domaine typique des envois jetables", fromDomain);
  }
  const local = extractEmailAddress_(fromRaw).split("@")[0] || "";   // casse d'origine (spEchQov)
  if (looksRandom_(local, 8)) add(8, "🎲", "Adresse d'expédition aléatoire", extractEmailAddress_(fromRaw));
  const domLabel = (fromDomain.split(".")[0] || "");
  if (looksRandom_(domLabel, 6)) add(10, "🎲", "Nom de domaine aléatoire", fromDomain);

  const replyEmail = extractEmailAddress_(replyTo || "").toLowerCase();
  const replyDomain = domainOf_(replyEmail);
  const viaRelay = function(d) { return relay && SCAM_CONFIG.RELAYS.some(function(r) { return r.rx.test(d); }); };
  if (replyEmail && replyDomain && registrable_(replyDomain) !== fromReg && !viaRelay(replyDomain)) {
    const free = SCAM_CONFIG.FREE_MAIL.test(replyDomain) && !SCAM_CONFIG.FREE_MAIL.test(fromDomain);
    add(free ? 20 : 10, "↩️", "Les réponses partent vers un autre domaine" + (free ? " (boîte gratuite)" : ""), "De : " + fromEmail + " · Répondre à : " + replyEmail);
  }
  const returnPath = extractEmailAddress_(headers["return-path"] || "").toLowerCase();
  const rpDomain = domainOf_(returnPath);
  if (returnPath && rpDomain && !relay && registrable_(rpDomain) !== fromReg && !isBigPlatform_([registrable_(rpDomain)])) {
    add(5, "📮", "Chemin de retour sur un autre domaine", "Return-Path : " + returnPath + " (courant chez les plateformes d'envoi, mais à noter)");
  }
  // « De : » est du texte libre : un mail peut afficher ta propre adresse sans venir de ton compte.
  const deliveredTo = extractEmailAddress_(headers["delivered-to"] || "").toLowerCase();
  const sentByMe = (message.getLabelIds ? message.getLabelIds() : []).indexOf("SENT") >= 0;
  if (deliveredTo && !sentByMe && !relay && canonicalAddress_(fromEmail) === canonicalAddress_(deliveredTo)) {
    add(30, "🎭", "Se fait passer pour toi : l'expéditeur affiché est ta propre adresse",
      "Le champ « De » n'est pas vérifié par le protocole mail : ton compte n'a rien envoyé (le mail n'est pas dans tes messages envoyés).");
  }
  const toAddrs = toRaw.split(/[,;]/).map(function(a) { return canonicalAddress_(extractEmailAddress_(a)); }).filter(function(a) { return a.indexOf("@") > 0; });
  if (/undisclosed|destinataires?\s+non/i.test(toRaw) || !toRaw.trim()) {
    add(5, "👥", "Destinataires masqués", "Ton adresse n'apparaît pas dans À / Cc.");
  } else if (deliveredTo && !relay && toAddrs.length && toAddrs.indexOf(canonicalAddress_(deliveredTo)) < 0) {
    add(10, "👥", "Faux destinataire : envoyé en copie cachée", "« À » affiche " + toAddrs.slice(0, 2).join(", ") + ", mais le mail a été remis à " + deliveredTo + ".");
  }

  /* ── 5. authentification (en-têtes ajoutés par Gmail) ── */
  const auth = parseAuth_(headers["authentication-results"] || headers["arc-authentication-results"] || "");
  if (auth.spf === "fail" || auth.spf === "softfail") add(15, "🛡️", "SPF " + auth.spf + " : le serveur n'est pas autorisé à envoyer pour ce domaine", "");
  if (auth.dkim === "fail") add(15, "🛡️", "DKIM fail : signature du mail invalide", "");
  else if (auth.dkim === "none" && auth.raw) add(5, "🛡️", "Pas de signature DKIM", "");
  if (auth.dmarc === "fail") add(20, "🛡️", "DMARC fail : le domaine affiché refuse ce mail", "");

  /* ── score ── */
  findings.sort(function(a, b) { return b.points - a.points; });
  const raw = findings.reduce(function(s, f) { return s + f.points; }, 0);
  const score = Math.min(100, raw);
  let lvl = SCAM_CONFIG.LEVELS[SCAM_CONFIG.LEVELS.length - 1];
  for (let i = 0; i < SCAM_CONFIG.LEVELS.length; i++) if (score >= SCAM_CONFIG.LEVELS[i].min) { lvl = SCAM_CONFIG.LEVELS[i]; break; }

  return {
    score: score,
    level: lvl.level, icon: lvl.icon, color: lvl.color, verdict: lvl.verdict,
    findings: findings,
    stats: { visibleChars: visibleLen, hiddenChars: hiddenLen, links: links.length, images: imgCount, hosts: hostList },
    auth: auth,
    visibleSample: sample_(reassembleSpaced_(visibleText)),
    hiddenSample: sample_(hiddenText),
    links: links.slice(0, 8),
    elapsedMs: Date.now() - t0
  };
}

const HIDDEN_STYLE_RULES = [
  { kind: "display:none",      rx: /display\s*:\s*none/i },
  { kind: "visibility:hidden", rx: /visibility\s*:\s*hidden/i },
  { kind: "taille 0",          rx: /font-size\s*:\s*(0(\.0+)?|1)(px|pt|em|%)?\s*(;|$|!)/i },
  { kind: "opacité 0",         rx: /opacity\s*:\s*0(\.0+)?\s*(;|$|!)/i },
  { kind: "hauteur 0",         rx: /max-height\s*:\s*0(px)?\s*(;|$|!)/i },
  { kind: "mso-hide",          rx: /mso-hide\s*:\s*all/i },
  { kind: "hors écran",        rx: /(left|top|text-indent|margin-left)\s*:\s*-\d{3,}/i }
];

const WHITE_TEXT_RX = /(^|[;\s])color\s*:\s*(#fff(fff)?|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|transparent)\s*(;|$|!)/i;

const HAS_BG_RX = /background(-color)?\s*:\s*(?!#fff(fff)?\b|white\b|transparent\b|none\b)[#a-z0-9(]/i;

/**
 * Sépare le HTML en texte visible et texte caché.
 * Renvoie { visible, hidden, visibleHtml, kinds:{procédé:true} }.
 */
function splitHiddenVisible_(html) {
  let x = String(html || "");
  const kinds = {};
  const hiddenParts = [];
  if (!x) return { visible: "", hidden: "", visibleHtml: "", kinds: kinds };

  // classes déclarées cachées dans <style>
  const hiddenClasses = {};
  (x.match(/<style[\s\S]*?<\/style>/gi) || []).forEach(function(block) {
    const rx = /\.([\w-]+)[^{]*\{([^}]*)\}/g; let m;
    while ((m = rx.exec(block))) {
      if (/display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px)?\s*(;|})|max-height\s*:\s*0/i.test(m[2])) hiddenClasses[m[1]] = true;
    }
  });

  // commentaires HTML (texte que seul le code contient — compté à part)
  x = x.replace(/<!--[\s\S]*?-->/g, " ");

  // balises ouvrantes avec style / class / color : on parcourt et on retire les éléments cachés
  const tagRx = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let out = "", pos = 0, m;
  while ((m = tagRx.exec(x))) {
    if (m.index < pos) continue;             // à l'intérieur d'un élément déjà retiré
    const tag = m[1].toLowerCase(), attrs = m[2];
    if (/^(style|script|head|title)$/.test(tag)) {
      const end = findElementEnd_(x, tagRx.lastIndex, tag);
      out += x.substring(pos, m.index); pos = end; tagRx.lastIndex = end; continue;
    }
    const kind = hiddenKindOf_(tag, attrs, hiddenClasses);
    if (!kind) continue;
    const end = findElementEnd_(x, tagRx.lastIndex, tag);
    const inner = stripHtmlToText_(x.substring(tagRx.lastIndex, end));
    const txt = normalizeSpaces_(decodeXmlEntities_(inner));
    if (txt) { hiddenParts.push(txt); kinds[kind] = true; }
    out += x.substring(pos, m.index);
    pos = end; tagRx.lastIndex = end;
  }
  out += x.substring(pos);

  return {
    visible: decodeXmlEntities_(stripHtmlToText_(out)),
    hidden: hiddenParts.join(" ¦ "),
    visibleHtml: out,
    kinds: kinds
  };
}

function hiddenKindOf_(tag, attrs, hiddenClasses) {
  const style = (attrs.match(/style\s*=\s*("([^"]*)"|'([^']*)')/i) || []);
  const st = style[2] || style[3] || "";
  if (st) {
    for (let i = 0; i < HIDDEN_STYLE_RULES.length; i++) if (HIDDEN_STYLE_RULES[i].rx.test(st)) return HIDDEN_STYLE_RULES[i].kind;
    if (WHITE_TEXT_RX.test(st) && !HAS_BG_RX.test(st) && tag !== "a") return "texte blanc";
  }
  const cls = (attrs.match(/class\s*=\s*("([^"]*)"|'([^']*)')/i) || []);
  const classes = (cls[2] || cls[3] || "").split(/\s+/);
  for (let j = 0; j < classes.length; j++) if (hiddenClasses[classes[j]]) return "classe cachée ." + classes[j];
  if (tag === "font" && /color\s*=\s*["']?(#fff(fff)?|white)\b/i.test(attrs)) return "texte blanc";
  if (/(^|\s)hidden(\s|=|$)/i.test(attrs)) return "attribut hidden";
  return "";
}

/** Index de fin de l'élément (après sa balise fermante), en tenant compte de l'imbrication. */
function findElementEnd_(html, from, tag) {
  if (/^(img|br|hr|input|meta|link|area|base|col|embed|source|track|wbr)$/.test(tag)) return from;
  const rx = new RegExp("<(/?)" + tag + "\\b[^>]*?(/?)>", "gi");
  rx.lastIndex = from;
  let depth = 1, m;
  while ((m = rx.exec(html))) {
    if (m[1] === "/") { depth--; if (depth === 0) return rx.lastIndex; }
    else if (m[2] !== "/") depth++;
  }
  return html.length;
}

function detectSpacedLetters_(html, visibleText) {
  const spans = (String(html || "").match(/<(span|font|b|i|u|em|strong)\b[^>]*>\s*[A-Za-z0-9]\s*<\/\1>/gi) || []).length;
  const runs = String(visibleText || "").match(/(?:^|\s)((?:[A-Za-z]\s){3,}[A-Za-z])(?=\s|$|[.,!?])/g) || [];
  let example = "";
  if (runs.length) example = runs[0].trim() + " → « " + runs[0].replace(/\s+/g, "") + " »";
  else if (spans) {
    const m = String(html).match(/(?:<(?:span|font|b|i|u|em|strong)\b[^>]*>\s*[A-Za-z0-9]\s*<\/(?:span|font|b|i|u|em|strong)>\s*){4,}/i);
    if (m) example = stripHtmlToText_(m[0]).replace(/\s+/g, " ").trim() + " → « " + stripHtmlToText_(m[0]).replace(/\s+/g, "") + " »";
  }
  return { singleCharSpans: spans, spacedRuns: runs.length, example: example };
}

function reassembleSpaced_(text) {
  return String(text || "").replace(/(?:^|(?<=\s))((?:[A-Za-z]\s){3,}[A-Za-z])(?=\s|$|[.,!?:;])/g, function(m) { return m.replace(/\s+/g, ""); });
}

function countZeroWidth_(body, subject) {
  const rx = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u034F\u2062\u2063\u2064]/g;
  const inBody = (String(body || "").match(rx) || []).length;
  const inSubj = (String(subject || "").match(rx) || []).length;
  return { total: inBody + inSubj, inSubject: inSubj > 0 };
}

function detectHomoglyphs_(s) {
  const text = String(s || "");
  const fancyMatches = text.match(/[\u{1D400}-\u{1D7FF}\uFF01-\uFF5E\u2460-\u24FF\u{1F100}-\u{1F1FF}\u{1F130}-\u{1F189}\u249C-\u24E9]/gu) || [];
  const words = text.match(/[\p{L}\p{M}]{3,}/gu) || [];
  const mixed = [];
  const seen = {};
  words.forEach(function(w) {
    const latin = /[A-Za-z]/.test(w), cyr = /[\u0400-\u04FF]/.test(w), grk = /[\u0370-\u03FF]/.test(w);
    if (latin && (cyr || grk) && !seen[w]) { seen[w] = true; mixed.push(w); }
  });
  let example = "";
  if (fancyMatches.length) {
    const m = text.match(/(?:[\u{1D400}-\u{1D7FF}\uFF01-\uFF5E\u2460-\u24FF\u{1F100}-\u{1F1FF}]\s?){3,}/u);
    if (m) example = m[0].trim();
  }
  return { fancy: fancyMatches.length, mixedWords: mixed, example: example };
}

function detectHashBusters_(visibleText, html) {
  const words = String(visibleText || "").match(/\b[A-Za-z0-9]{10,}\b/g) || [];
  const rnd = [];
  words.forEach(function(w) { if (looksRandom_(w, 10) && rnd.indexOf(w) < 0) rnd.push(w); });
  let commentChars = 0;
  (String(html || "").match(/<!--([\s\S]*?)-->/g) || []).forEach(function(c) {
    const t = c.replace(/<!--|-->/g, "").replace(/\[if[\s\S]*?\]>[\s\S]*?<!\[endif\]/gi, "").replace(/\s+/g, " ").trim();
    if (!/^\[if|^\s*$/.test(t)) commentChars += t.length;
  });
  return { randomWords: rnd.length, examples: rnd.slice(0, 4), commentChars: commentChars };
}

/** Chaîne « aléatoire » : longue, mélange lettres+chiffres ou quasi sans voyelles. */
function looksRandom_(s, minLen) {
  const w = String(s || "");
  if (w.length < (minLen || 8)) return false;
  if (/^[0-9]+$/.test(w)) return false;
  const letters = (w.match(/[a-z]/gi) || []).length;
  const digits = (w.match(/[0-9]/g) || []).length;
  const vowels = (w.match(/[aeiouy]/gi) || []).length;
  if (letters >= 4 && digits >= 2 && !/^(no-?reply|newsletter|info|contact|support|service|team|hello|mail|news|notification|noreply)/i.test(w)) return true;
  if (letters >= 8 && vowels / letters < 0.18) return true;
  // chiffre coincé entre des lettres (uhcci0tt, x9k2m) dans un mot pauvre en voyelles
  if (letters >= 5 && /[a-z][0-9][a-z]/i.test(w) && vowels / letters < 0.35) return true;
  // alternance majuscules/minuscules incohérente : spEchQov
  const caseSwitches = (w.match(/[a-z][A-Z]/g) || []).length;
  if (letters >= 6 && caseSwitches >= 2) return true;
  return false;
}

function extractLinks_(html) {
  const out = [];
  const rx = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(String(html || "")))) {
    const href = decodeXmlEntities_(m[2] || m[3] || "").trim();
    if (!href || /^(mailto|tel):/i.test(href) || href === "#") continue;
    const text = normalizeSpaces_(decodeXmlEntities_(stripHtmlToText_(m[4])));
    out.push({ href: href, host: hostOf_(href), text: text.substring(0, 80) });
    if (out.length >= 200) break;
  }
  return out;
}

function parseAuth_(s) {
  const raw = String(s || "");
  const pick = function(k) { const m = raw.match(new RegExp("\\b" + k + "=(\\w+)", "i")); return m ? m[1].toLowerCase() : ""; };
  return { raw: raw, spf: pick("spf"), dkim: pick("dkim"), dmarc: pick("dmarc") };
}

function normalizeSpaces_(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

function sample_(s) {
  const t = normalizeSpaces_(s);
  return t.length > SCAM_CONFIG.MAX_SAMPLE ? t.substring(0, SCAM_CONFIG.MAX_SAMPLE) + "…" : t;
}

function hostOf_(url) {
  const m = String(url || "").match(/^(?:https?:)?\/\/([^\/?#:]+)/i);
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

function domainOf_(email) {
  const i = String(email || "").indexOf("@");
  return i < 0 ? "" : email.substring(i + 1).toLowerCase().replace(/[>\s]/g, "");
}

/** Domaine « enregistrable » : lowes.com, amazon.co.uk, example.com.br. */
function registrable_(host) {
  const h = String(host || "").toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;      // adresse IP : telle quelle
  const p = h.split(".").filter(Boolean);
  if (p.length <= 2) return p.join(".");
  const sld = p[p.length - 2], tld = p[p.length - 1];
  if (/^(co|com|net|org|gov|edu|ac|gouv|asso)$/.test(sld) && tld.length === 2) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}

function displayNameOf_(fromRaw) {
  const s = String(fromRaw || "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  return m ? m[1].trim() : "";
}

function brandInName_(display) {
  const d = normalizeMailText_(display);
  if (!d) return "";
  for (let i = 0; i < SCAM_CONFIG.BRANDS.length; i++) {
    const b = normalizeMailText_(SCAM_CONFIG.BRANDS[i]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(^|[^a-z0-9])" + b + "([^a-z0-9]|$)", "i").test(d)) return SCAM_CONFIG.BRANDS[i];   // mot entier (« caf » ≠ « café »)
  }
  return "";
}

/** Plateformes d'envoi / hébergeurs de liens si courants qu'ils ne prouvent rien. */
function isBigPlatform_(hosts) {
  const rx = /^(google\.com|googleapis\.com|goo\.gl|youtube\.com|apple\.com|microsoft\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|mailchimp\.com|list-manage\.com|sendgrid\.net|sendinblue\.com|brevo\.com|mailjet\.com|klaviyo\.com|hubspot\.com|salesforce\.com|amazonses\.com|amazonaws\.com|cloudfront\.net|shopify\.com|unsubscribe\.com|substack\.com|medium\.com|notion\.so|slack\.com|zoom\.us)$/i;
  return hosts.length > 0 && hosts.every(function(h) { return rx.test(h); });
}

export {
  SCAM_CONFIG,
  analyzeScam_,
  HIDDEN_STYLE_RULES,
  WHITE_TEXT_RX,
  HAS_BG_RX,
  splitHiddenVisible_,
  hiddenKindOf_,
  findElementEnd_,
  detectSpacedLetters_,
  reassembleSpaced_,
  countZeroWidth_,
  detectHomoglyphs_,
  detectHashBusters_,
  looksRandom_,
  extractLinks_,
  parseAuth_,
  normalizeSpaces_,
  sample_,
  hostOf_,
  domainOf_,
  registrable_,
  displayNameOf_,
  brandInName_,
  isBigPlatform_
};
