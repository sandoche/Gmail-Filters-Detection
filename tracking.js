// Anti-pistage dans Gmail : neutralise les pixels de suivi avant qu'ils se chargent.
// Gmail affiche les images via son proxy (…googleusercontent.com/…#https://adresse-d-origine) : l'expéditeur ne voit
// pas ton IP, mais il sait que tu as ouvert le mail, et quand. On retire donc la source des images de pistage
// (services connus, images minuscules ou cachées) dès leur insertion dans la page.
// Chargé avant content.js (document_start) ; content.js lit window.__gfmTracking pour l'onglet « Ce mail ».
(() => {
  if (window.__gfmTracking) return;

  // Services de pistage connus (hôte + chemin de l'adresse d'origine).
  const KNOWN = [
    /(^|\.)mailtrack\.(io|net|com)\//, /(^|\.)mltrk\.io\//, /(^|\.)getnotify\.com\//, /(^|\.)yesware\.com\//, /(^|\.)bananatag\.com\//,
    /(^|\.)mailstat\.us\//, /(^|\.)saleshandy\.com\//, /(^|\.)mailtag\.io\//, /(^|\.)emltrk\.com\//, /(^|\.)mixmax\.com\/api\/track/,
    /(^|\.)streak\.com\/.*(pixel|track)/, /(^|\.)superhuman\.com\//, /(^|\.)frontapp\.com\/open/, /(^|\.)salesloft\.com\//,
    /(^|\.)outreach\.io\//, /(^|\.)hubspot(email|links)?\.(com|net)\/.*(open|track|e\d)/, /(^|\.)sidekickopen\d*\.com\//,
    /(^|\.)list-manage\.com\/track\/open/, /(^|\.)mandrillapp\.com\/track\/open/, /sendgrid\.net\/(wf\/)?open/,
    /(^|\.)mjt\.lu\/oo/, /(^|\.)sendib[tw]\d*\.com\//, /(^|\.)(trk\.)?klaviyo(mail)?\.com\/.*open/, /(^|\.)awstrack\.me\/I0\//,
    /(^|\.)createsend\d*\.com\/t\//, /(^|\.)rs6\.net\/on\.jsp/, /(^|\.)pstmrk\.it\/open/, /(^|\.)spgo\.io\/q\//,
    /(^|\.)track\.customer\.io\/e\/o\//, /(^|\.)via\.intercom\.io\/o\//, /(^|\.)exacttarget\.com\/.*open/,
    /(^|\.)litmus\.com\/(pixel|r)\//, /(^|\.)mailjet\.com\/.*open/, /(^|\.)sparkpostmail\.com\/q\//, /(^|\.)mailgun\.org\/o\//
  ];
  // Adresse qui ressemble à un compteur d'ouverture : /open, /track/open, /pixel, /beacon… avec un identifiant.
  const GENERIC = /\/(open|opened|track(ing)?\/open|wf\/open|pixel|beacon|e\/o|o)(\.gif|\.png|\.php|\.aspx)?(\/|\?|$)|[?&](open|pixel|beacon)=/i;

  const state = window.__gfmTracking = { enabled: true, blocked: [] };

  function originalUrl(src) {
    const i = src.indexOf('#');
    return /googleusercontent\.com\//.test(src) && i > 0 ? src.slice(i + 1) : src;
  }

  function px(v) {
    const m = String(v || '').match(/^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i);
    return m ? parseFloat(m[1]) : NaN;
  }

  /** Raison du blocage ('' si l'image est légitime). Utilisée aussi par l'aperçu des spams (content.js). */
  function trackerReason(url, img) {
    let u;
    try { u = new URL(url, location.href); } catch (e) { return ''; }
    if (!/^https?:$/.test(u.protocol)) return '';
    const where = u.hostname + u.pathname;
    if (KNOWN.some(rx => rx.test(where))) return 'service de pistage';
    if (img) {
      const st = img.getAttribute('style') || '';
      const w = Math.min(px(img.getAttribute('width')), px((st.match(/(^|;)\s*width\s*:\s*([^;]+)/i) || [])[2]));
      const h = Math.min(px(img.getAttribute('height')), px((st.match(/(^|;)\s*height\s*:\s*([^;]+)/i) || [])[2]));
      if ((w <= 3 && !(h > 3)) || (h <= 3 && !(w > 3))) return 'image invisible (' + (isNaN(w) ? '?' : w) + '×' + (isNaN(h) ? '?' : h) + ')';
      if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*(;|$)/i.test(st)) return 'image cachée';
    }
    if (GENERIC.test(u.pathname + u.search) && /[A-Za-z0-9_-]{16,}/.test(u.pathname + u.search)) return 'compteur d’ouverture';
    return '';
  }
  state.trackerReason = trackerReason;

  function check(img) {
    if (!state.enabled || img.dataset.gfmChecked) return;
    img.dataset.gfmChecked = '1';
    const src = img.getAttribute('src') || '';
    if (!src || /^(data|cid|blob):/i.test(src)) return;
    // seulement le contenu des mails (pas l'interface de Gmail : avatars, icônes…)
    if (!img.closest('.a3s, [data-message-id], [data-legacy-message-id]') || /\/\/(ssl\.gstatic|www\.gstatic|lh\d\.googleusercontent)\.com\//.test(src)) return;
    const url = originalUrl(src);
    const reason = trackerReason(url, img);
    if (!reason) return;
    img.removeAttribute('src');
    img.removeAttribute('srcset');
    img.dataset.gfmBlocked = reason;
    let host = '';
    try { host = new URL(url).hostname; } catch (e) {}
    state.blocked.push({ img, host, reason, url: url.slice(0, 300) });
  }

  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.tagName === 'IMG') check(node);
    else node.querySelectorAll && node.querySelectorAll('img').forEach(check);
  }

  // Liens qui passent par un compteur de clics : l'expéditeur saura si tu cliques (affiché, pas bloqué).
  state.CLICK_TRACKERS = /(^|\.)(list-manage\.com|ct\.sendgrid\.net|sendgrid\.net|mandrillapp\.com|mjt\.lu|hubspotlinks\.com|hs-sites\.com|awstrack\.me|rs6\.net|createsend\d*\.com|pstmrk\.it|spgo\.io|customer\.io|klaviyo(mail)?\.com|mailchimp\.com|sendib[tw]\d*\.com|exacttarget\.com|mailtrack\.io|mltrk\.io|yesware\.com|mixmax\.com|salesloft\.com|outreach\.io|eloqua\.com|mktotracking\.com|mkt\d+\.com|clicks?\.[a-z0-9-]+\.[a-z]{2,}|trk\.[a-z0-9-]+\.[a-z]{2,}|links?\.[a-z0-9-]+\.[a-z]{2,})$/i;

  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') { if (m.target.tagName === 'IMG') { delete m.target.dataset.gfmChecked; check(m.target); } }
      else m.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  // Mails déjà affichés (extension installée ou rechargée alors que Gmail était ouvert).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document.documentElement));
  else scan(document.documentElement);

  // Réglage (activé par défaut) : lu après coup, le blocage commence avant même de le connaître.
  try {
    chrome.storage.sync.get({ blockTrackers: true }, s => { state.enabled = s.blockTrackers !== false; });
  } catch (e) { /* page de test sans chrome.storage */ }
})();
