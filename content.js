// Panneau latéral dans Gmail (Shadow DOM, isolé du CSS de Gmail) :
//   « Ce mail »    pourquoi ce mail a ces filtres / libellés, dangerosité, créer ou supprimer un filtre ;
//   « Spams »      dangerosité de chaque spam, aperçu, filtres proposés (testés à 0 mail légitime) ;
//   « Simplifier » doublons, recoupements (« dick » / « big dick ») testés sur tes vrais mails, fusions.
// Toute la logique tourne dans le service worker (background.js) ; ici, uniquement l'affichage.
(() => {
  if (window.__spamFiltreur) return;
  window.__spamFiltreur = true;

  const log = (...a) => console.log('[Traiter mes spams]', ...a);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mark = s => esc(s).replace(/⟦/g, '<mark>').replace(/⟧/g, '</mark>');   // ⟦phrase⟧ → surlignage
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const fmtDate = t => t ? new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : m < 1440 ? `il y a ${Math.round(m / 60)} h` : `il y a ${Math.round(m / 1440)} j`; };
  const nameOf = from => { const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/); return m ? { name: m[1] || m[2], email: m[2] } : { name: from || '', email: from || '' }; };
  const gmailBase = () => location.origin + ((location.pathname.match(/^\/mail\/u\/\d+\//) || ['/mail/u/0/'])[0]);
  const searchUrl = q => `${gmailBase()}#search/${encodeURIComponent(q)}`;

  /* ───────── échanges avec le service worker ───────── */

  let port = null, rid = 0;
  const pending = new Map();
  const LOST = 'La connexion avec l’extension a été perdue (extension rechargée ou arrêtée). Recharge Gmail (F5) puis réessaie.';

  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'gfm' });
    port.onMessage.addListener(m => {
      const p = pending.get(m.rid);
      if (!p) return;
      if (m.type === 'progress') { log(m.text); p.onProgress && p.onProgress(m.text); return; }
      pending.delete(m.rid);
      m.type === 'error' ? p.reject(new Error(m.text)) : p.resolve(m.data);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      log('Connexion avec l’extension perdue.', chrome.runtime.lastError || '');
      for (const p of pending.values()) p.reject(new Error(LOST));
      pending.clear();
    });
    return port;
  }

  function call(cmd, args, onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++rid;
      pending.set(id, { resolve, reject, onProgress });
      try { connect().postMessage({ rid: id, cmd, args }); }
      catch (e) { pending.delete(id); reject(new Error('L’extension a été rechargée depuis l’ouverture de Gmail. Recharge Gmail (F5) puis réessaie.')); }
    });
  }

  /* ───────── interface ───────── */

  const host = document.createElement('div');
  host.id = 'spam-filtreur-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { font: 14px/1.45 "Google Sans Text", "Google Sans", Roboto, Arial, sans-serif; color: #1f1f1f;
      --primary: #0b57d0; --on-primary: #fff; --tonal: #d3e3fd; --on-tonal: #041e49; --surface: #fff; --soft: #f0f4f9;
      --line: #e1e3e1; --muted: #5e5e5e; --red: #b3261e; --red-soft: #fce8e6; --amber: #8c5000; --amber-soft: #fef7e0;
      --green: #146c2e; --green-soft: #e6f4ea; --mark: #fde293; }
    button { font: inherit; cursor: pointer; }
    .fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; align-items: center; gap: 8px;
      height: 48px; padding: 0 18px 0 14px; border: 0; border-radius: 16px; background: var(--tonal); color: var(--on-tonal);
      font-weight: 500; box-shadow: 0 1px 3px rgba(0,0,0,.3), 0 4px 8px 3px rgba(0,0,0,.15); transition: box-shadow .2s; }
    .fab:hover { box-shadow: 0 2px 3px rgba(0,0,0,.3), 0 6px 10px 4px rgba(0,0,0,.15); }
    .fab svg { width: 22px; height: 22px; }
    .drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(460px, 100vw); z-index: 2147483001;
      background: var(--surface); box-shadow: -4px 0 24px rgba(0,0,0,.18); display: flex; flex-direction: column;
      transform: translateX(105%); transition: transform .22s ease, width .22s ease; }
    .drawer.open { transform: none; }
    .drawer.wide { width: min(1080px, 100vw); }
    header { padding: 14px 12px 0 20px; }
    .top { display: flex; align-items: center; gap: 8px; }
    .top h1 { font: 500 18px/1.3 "Google Sans", Roboto, Arial, sans-serif; margin: 0; flex: 1; }
    .sub { color: var(--muted); font-size: 12px; margin: 2px 0 10px; }
    .icon { width: 36px; height: 36px; border-radius: 50%; border: 0; background: none; color: var(--muted); display: grid; place-items: center; }
    .icon:hover { background: var(--soft); }
    .icon svg { width: 20px; height: 20px; }
    nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 0 -12px 0 -20px; padding: 0 12px; }
    nav button { border: 0; background: none; padding: 10px 14px; color: var(--muted); font-weight: 500; border-bottom: 3px solid transparent; }
    nav button.on { color: var(--primary); border-bottom-color: var(--primary); }
    .body { flex: 1; overflow: auto; padding: 16px 20px 24px; }
    footer { border-top: 1px solid var(--line); padding: 12px 20px; display: flex; gap: 8px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
    footer .hint { flex: 1; color: var(--muted); font-size: 12px; }
    .btn { height: 36px; padding: 0 16px; border-radius: 18px; border: 1px solid #747775; background: none; color: var(--primary); font-weight: 500; }
    .btn:hover { background: rgba(11,87,208,.06); }
    .btn.filled { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
    .btn.filled:hover { background: #0842a0; }
    .btn.tonal { background: var(--tonal); color: var(--on-tonal); border-color: transparent; }
    .btn.danger { background: var(--red); color: #fff; border-color: var(--red); }
    .btn.small { height: 30px; padding: 0 12px; font-size: 13px; }
    .btn.text { border-color: transparent; padding: 0 10px; }
    .btn:disabled { opacity: .45; cursor: default; }
    .card { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; background: var(--surface); }
    .card.soft { background: var(--soft); border-color: transparent; }
    .card.off { opacity: .55; }
    .card.sel { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
    h2 { font: 500 15px/1.3 "Google Sans", Roboto, Arial, sans-serif; margin: 20px 0 10px; display: flex; align-items: center; gap: 8px; }
    h2:first-child { margin-top: 0; }
    h2 .count { font-size: 12px; color: var(--muted); font-weight: 400; }
    .desc { color: var(--muted); font-size: 12px; margin: -6px 0 10px; }
    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grow { flex: 1; min-width: 0; }
    .chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 10px; border-radius: 8px; font-size: 12px;
      background: var(--soft); color: #1f1f1f; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
    .chip.label { background: #e8def8; color: #1d192b; }
    .chip.ok { background: var(--green-soft); color: var(--green); }
    .chip.warn { background: var(--amber-soft); color: var(--amber); }
    .chip.bad { background: var(--red-soft); color: var(--red); }
    .chip.blue { background: var(--tonal); color: var(--on-tonal); }
    code, .mono { font-family: "Roboto Mono", Consolas, monospace; font-size: 12.5px; }
    .crit { background: var(--soft); border-radius: 6px; padding: 4px 8px; word-break: break-word; display: inline-block; }
    mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 2px; }
    .excerpt { font-size: 13px; color: #303030; background: #fffbea; border-left: 3px solid #f0c000; padding: 6px 10px; border-radius: 0 6px 6px 0; margin-top: 8px; }
    .reasons { margin: 6px 0 0; padding: 0; list-style: none; font-size: 13px; }
    .reasons li::before { content: "✓ "; color: var(--green); font-weight: 700; }
    .gauge { height: 8px; border-radius: 4px; background: #e9eef6; overflow: hidden; margin: 8px 0 6px; }
    .gauge > i { display: block; height: 100%; border-radius: 4px; }
    .score { font: 500 22px/1 "Google Sans", Roboto, Arial, sans-serif; }
    .badge { flex: none; width: 38px; height: 38px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 13px; color: #fff; }
    .finding { display: flex; gap: 10px; padding: 6px 0; border-top: 1px solid var(--line); font-size: 13px; }
    .finding:first-child { border-top: 0; }
    .finding > span:last-child { min-width: 0; overflow-wrap: anywhere; }
    .finding .pts { flex: none; width: 34px; text-align: right; color: var(--muted); font-size: 12px; padding-top: 1px; }
    .mailrow { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 10px; cursor: pointer; }
    .mailrow:hover { background: var(--soft); }
    .mailrow.sel { background: var(--tonal); }
    .mailrow .who { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mailrow .what { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { text-align: center; color: var(--muted); padding: 48px 16px; }
    .empty .big { font-size: 40px; margin-bottom: 8px; }
    .spinner { width: 28px; height: 28px; border: 3px solid var(--tonal); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .err { background: var(--red-soft); color: var(--red); border-radius: 12px; padding: 12px 14px; white-space: pre-wrap; margin-bottom: 10px; }
    .note { background: var(--amber-soft); color: #5c3b00; border-radius: 12px; padding: 10px 14px; margin-bottom: 10px; font-size: 13px; }
    .good { background: var(--green-soft); color: var(--green); border-radius: 12px; padding: 10px 14px; margin-bottom: 10px; }
    .claude { background: #f4effa; border-radius: 12px; padding: 12px 14px; white-space: pre-wrap; font-size: 13.5px; }
    input[type=text], select { height: 36px; border: 1px solid #747775; border-radius: 8px; padding: 0 10px; font: inherit; background: #fff; color: inherit; min-width: 0; }
    input[type=text]:focus, select:focus { outline: 2px solid var(--primary); outline-offset: -1px; border-color: transparent; }
    input.crit-edit { width: 100%; font-family: "Roboto Mono", Consolas, monospace; font-size: 12.5px; }
    label.check { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; cursor: pointer; }
    input[type=checkbox], input[type=radio] { accent-color: var(--primary); width: 16px; height: 16px; margin: 0; }
    details > summary { cursor: pointer; color: var(--primary); font-size: 13px; font-weight: 500; list-style: none; margin-top: 8px; }
    details > summary::-webkit-details-marker { display: none; }
    .choice { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border-radius: 8px; font-size: 13px; cursor: pointer; }
    .choice:hover { background: var(--soft); }
    .choice.reco { background: var(--green-soft); }
    .terms { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .tip { position: absolute; width: 220px; background: #1f1f1f; color: #fff; font-size: 12px; padding: 6px 10px; border-radius: 8px; pointer-events: none; z-index: 2; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
  <div class="ui">
    <button class="fab" data-act="toggle" title="Pourquoi ce filtre ? · Dangerosité des spams · Simplifier mes filtres">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z"/></svg>Filtres</button>
    <aside class="drawer" aria-label="Filtres Gmail">
      <header>
        <div class="top">
          <h1>Filtres Gmail</h1>
          <button class="icon" data-act="reload" title="Relire mes filtres depuis Gmail"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>
          <button class="icon" data-act="close" title="Fermer (Échap)"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
        </div>
        <div class="sub" id="status">…</div>
        <nav>
          <button data-tab="mail">Ce mail</button>
          <button data-tab="spam">Spams</button>
          <button data-tab="simp">Simplifier</button>
          <button data-tab="stats">Tendances</button>
        </nav>
      </header>
      <div class="body" id="body"></div>
      <footer id="footer" hidden></footer>
    </aside>
  </div>`;

  const $ = s => root.querySelector(s);
  const drawer = $('.drawer'), body = $('#body'), footer = $('#footer');

  const S = {
    tab: 'mail',
    status: null, statusError: '',
    mail: { key: '', loading: false, progress: '', error: '', data: null, explain: {}, claude: null, create: null, confirm: '', propose: null },
    spam: { loading: false, progress: '', error: '', data: null, sel: '', edits: {}, alt: {}, done: {}, off: new Set(), opts: null, busy: '', notice: null, images: false },
    simp: { loading: false, progress: '', error: '', plan: null, dupOff: new Set(), choice: {}, tests: {}, mergeOn: new Set(), report: null, backupDone: false },
    stats: { months: 12, source: 'all', loading: false, progress: '', error: '', data: null, claude: null }
  };

  /* ───────── contexte Gmail ───────── */

  // Fil ouvert : l'adresse se termine par l'identifiant du mail (#inbox/FMfcg…, #label/x/FMfcg…), et le titre
  // de la conversation (h2) porte l'id hexadécimal de l'API Gmail. Dans la liste des mails, chaque ligne porte
  // aussi un data-legacy-thread-id : on ne les prend jamais.
  function currentThread() {
    if (!/^[A-Za-z0-9]{16,}$/.test(location.hash.split('/').pop() || '')) return null;
    for (const el of document.querySelectorAll('h2[data-legacy-thread-id]')) {
      if (el.offsetParent !== null) return { threadId: el.getAttribute('data-legacy-thread-id') };
    }
    for (const el of document.querySelectorAll('[data-legacy-message-id]')) {
      if (el.offsetParent !== null && !el.closest('tr')) return { messageId: el.getAttribute('data-legacy-message-id') };
    }
    return null;
  }
  const inSpamFolder = () => /^#spam\b/.test(location.hash);

  /* ───────── rendu commun ───────── */

  function loading(text) {
    return `<div class="empty"><div class="spinner"></div>${esc(text || 'Chargement…')}</div>`;
  }

  function renderStatus() {
    const s = S.status;
    $('#status').innerHTML = S.statusError ? `<span style="color:var(--red)">${esc(S.statusError)}</span>`
      : !s ? 'Lecture de tes filtres…'
      : `${s.count.toLocaleString('fr-FR')} filtres · lus ${ago(s.builtAt)}` +
        (s.unstable ? ` · <span style="color:var(--amber)">⚠ Gmail n’en a renvoyé que ${s.apiCount} — <a href="#" data-act="replace">utiliser sa liste</a></span>` : '');
  }

  function render() {
    root.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
    drawer.classList.toggle('wide', S.tab === 'stats' && !!S.stats.data);
    footer.hidden = true;
    footer.innerHTML = '';
    if (S.tab === 'mail') renderMail();
    else if (S.tab === 'spam') renderSpam();
    else if (S.tab === 'simp') renderSimp();
    else renderStats();
    renderStatus();
  }

  function setFooter(html) { footer.innerHTML = html; footer.hidden = false; }

  function dangerBlock(d, full) {
    const findings = full ? d.findings : d.findings.slice(0, 3);
    const pts = f => f.points ? '+' + f.points : 'ℹ';
    return `<div class="card">
      <div class="row" style="flex-wrap:nowrap"><span class="score" style="color:${d.color}">${d.score}<span class="small muted">/100</span></span>
        <b style="color:${d.color}">${esc(d.verdict)}</b></div>
      <div class="gauge"><i style="width:${d.score}%;background:${d.color}"></i></div>
      ${d.auth && (d.auth.spf || d.auth.dmarc) ? `<div style="margin-bottom:6px"><span class="chip ${d.auth.dmarc === 'fail' ? 'bad' : d.auth.dmarc === 'pass' ? 'ok' : ''}" title="Authentification de l’expéditeur">SPF ${esc(d.auth.spf || '?')} · DKIM ${esc(d.auth.dkim || '?')} · DMARC ${esc(d.auth.dmarc || '?')}</span></div>` : ''}
      ${findings.length ? findings.map(f => `<div class="finding"><span class="pts">${pts(f)}</span><span>${f.icon} <b>${esc(f.title)}</b>${f.detail ? `<br><span class="muted small">${esc(f.detail)}</span>` : ''}</span></div>`).join('')
        : '<div class="muted small">Pas de texte caché, pas de mots découpés, expéditeur cohérent.</div>'}
      ${!full && d.findings.length > 3 ? `<details><summary>Voir les ${d.findings.length} indices</summary>${d.findings.slice(3).map(f => `<div class="finding"><span class="pts">${pts(f)}</span><span>${f.icon} <b>${esc(f.title)}</b>${f.detail ? `<br><span class="muted small">${esc(f.detail)}</span>` : ''}</span></div>`).join('')}</details>` : ''}
    </div>`;
  }

  /* ═════════════ onglet « Ce mail » ═════════════ */

  async function loadMail(force) {
    const ctx = currentThread();
    const key = ctx ? (ctx.threadId || ctx.messageId) : '';
    if (!ctx) { S.mail = { ...S.mail, key: '', data: null, error: '', loading: false }; render(); return; }
    if (!force && key === S.mail.key && (S.mail.data || S.mail.loading)) return;
    S.mail = { key, loading: true, progress: 'Lecture du mail…', error: '', data: null, explain: {}, claude: null, create: null, confirm: '', propose: S.mail.key === key ? S.mail.propose : null };
    render();
    try {
      const data = await call('mail:analyze', ctx, t => { S.mail.progress = t; if (S.tab === 'mail') render(); });
      if (S.mail.key !== key) return;            // l'utilisateur a changé de mail entre-temps
      S.mail.data = data;
      S.status = data.status;
    } catch (e) { if (S.mail.key === key) S.mail.error = e.message; }
    S.mail.loading = false;
    if (S.tab === 'mail') render();
  }

  function filterCard(m, i, n) {
    const r = m.rule;
    const confirm = S.mail.confirm === r.id;
    return `<div class="card">
      <div class="row small muted">Filtre ${i + 1}/${n}${m.messages && S.mail.data.mail.count > 1 ? ` · message${m.messages.length > 1 ? 's' : ''} #${m.messages.join(', #')}` : ''}</div>
      <div style="margin:6px 0"><code class="crit">${esc(r.description)}</code></div>
      <div class="row">${r.actions.map(a => `<span class="chip ${/^🏷️/.test(a) ? 'label' : /corbeille/.test(a) ? 'bad' : ''}">${esc(a)}</span>`).join('') || '<span class="chip">aucune action</span>'}</div>
      <ul class="reasons">${m.reasons.map(x => `<li>${esc(x.replace(/^✅ /, ''))}</li>`).join('')}</ul>
      ${m.preview ? `<div class="excerpt">${mark(m.preview)}</div>` : ''}
      <div class="row" style="margin-top:10px">
        <a class="btn small text" href="${esc(searchUrl(r.queryText))}" target="_blank" rel="noopener">Tous les mails qu’il attrape ↗</a>
        <span class="grow"></span>
        ${confirm ? `<span class="small" style="color:var(--red)">Supprimer définitivement ?</span>
          <button class="btn small text" data-act="del-cancel">Annuler</button>
          <button class="btn small danger" data-act="del-ok" data-id="${esc(r.id)}">Supprimer</button>`
        : `<button class="btn small" data-act="del" data-id="${esc(r.id)}">Supprimer ce filtre</button>`}
      </div>
    </div>`;
  }

  // Filtres proposés pour le mail ouvert : phrases testées dans la boîte (aucun vrai mail attrapé), à copier dans Gmail
  // (au-delà de 1 000 filtres, l'API refuse d'en créer ; l'interface de Gmail, non).
  function proposeBlock() {
    const p = S.mail.propose;
    if (!p) return `<div class="row" style="margin-bottom:10px"><button class="btn tonal" data-act="propose">✦ Proposer un filtre</button><span class="small muted grow">phrases de ce mail testées dans ta boîte : aucun vrai mail attrapé</span></div>`;
    if (p.loading) return `<div class="claude muted">${esc(p.progress || 'Recherche…')}</div>`;
    if (p.error) return `<div class="err">${esc(p.error)}</div><button class="btn small" data-act="propose">Réessayer</button>`;
    const d = p.data;
    const copyBtn = (i, text) => `<button class="btn small ${i === 'all' ? 'tonal' : 'filled'}" data-act="propose-copy" data-i="${i}">${p.copied === i ? '✓ Copié' : text}</button>`;
    let html = d.proposals.length ? `<div class="small muted" style="margin-bottom:8px">Copie une phrase, puis dans Gmail : ⋮ → <b>Filtrer les messages similaires</b> → vide « De », colle dans <b>« Contient les mots »</b> → libellé <b>${esc(d.labelName)}</b>.</div>` : '';
    html += d.proposals.map((x, i) => `<div class="card">
      <div class="row"><code class="crit grow">${esc(x.query)}</code>${x.cand.byClaude ? '<span class="chip">✦ Claude</span>' : ''}</div>
      <div class="row" style="margin-top:6px"><span class="small muted grow">${esc(x.cand.label || '')} · attrape ${plural(x.total, 'mail')} déjà reçu${x.total > 1 ? 's' : ''} (spam, corbeille, libellés) · 0 vrai mail</span>${copyBtn(i, 'Copier')}</div>
    </div>`).join('');
    if (d.proposals.length > 1) html += `<div class="row" style="margin-bottom:10px"><span class="small muted grow">ou toutes d’un coup, réunies par OR (un seul filtre)</span>${copyBtn('all', 'Tout copier en OR')}</div>`;
    if (!d.proposals.length) html += `<div class="note">Aucune phrase sûre : chacune attraperait aussi de vrais mails${d.rejected ? ` (${plural(d.rejected, 'phrase')} écartée${d.rejected > 1 ? 's' : ''})` : ''}. Sélectionne une phrase dans le mail et utilise le formulaire ci-dessous.</div>`;
    if (d.claudeError) html += `<div class="err">Claude : ${esc(d.claudeError)}</div>`;
    return html;
  }

  function createForm() {
    const c = S.mail.create;
    const d = S.mail.data;
    if (!c) return `<button class="btn tonal" data-act="create-open">＋ Créer un filtre depuis ce mail</button>`;
    const labels = d.labelNames || [];
    return `<div class="card soft">
      <div class="row" style="margin-bottom:8px">
        <select data-bind="create.field">
          ${[['query', 'Phrase dans le mail'], ['subject', 'Phrase dans l’objet'], ['from', 'Expéditeur']].map(([v, t]) => `<option value="${v}" ${c.field === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <input type="text" class="grow" data-bind="create.value" value="${esc(c.value)}" placeholder="sélectionne une phrase dans le mail, ou tape-la">
      </div>
      <div class="row" style="margin-bottom:8px">
        <span class="small muted">Action</span>
        <select data-bind="create.target" class="grow">
          ${[c.defaultLabel, ...labels.filter(l => l !== c.defaultLabel)].map(l => `<option value="${esc(l)}" ${c.target === l ? 'selected' : ''}>🏷️ ${esc(l)}</option>`).join('')}
          <option value="__TRASH__" ${c.target === '__TRASH__' ? 'selected' : ''}>🗑️ Corbeille</option>
        </select>
      </div>
      <div class="row" style="margin-bottom:10px">
        <label class="check"><input type="checkbox" data-bind="create.archive" ${c.archive ? 'checked' : ''}> Archiver</label>
        <label class="check"><input type="checkbox" data-bind="create.markRead" ${c.markRead ? 'checked' : ''}> Marquer comme lu</label>
      </div>
      ${c.error ? `<div class="err">${esc(c.error)}</div>` : ''}
      ${c.test ? (c.test.count ? `<div class="note">⚠ Ce filtre attraperait aussi <b>${c.test.count}${c.test.capped ? '+' : ''}</b> mail(s) hors spam :<br>${c.test.samples.map(s => `• ${esc(nameOf(s.from).name)} — ${esc(s.subject)}`).join('<br>')}</div>`
        : `<div class="good">✓ Aucun autre mail touché (hors Spam, Corbeille et ce libellé).</div>`) : ''}
      ${c.done ? `<div class="good">✓ Filtre créé : <code>${esc(c.done)}</code><br><span class="small">Il s’appliquera aux prochains mails.</span></div>` : ''}
      <div class="row">
        <span class="grow small muted">${c.busy ? esc(c.busy) : ''}</span>
        <button class="btn small text" data-act="create-close">Fermer</button>
        <button class="btn small" data-act="create-test" ${c.busy ? 'disabled' : ''}>Tester</button>
        <button class="btn small filled" data-act="create-go" ${c.busy ? 'disabled' : ''}>Créer le filtre</button>
      </div>
    </div>`;
  }

  // Pixels neutralisés par tracking.js dans le mail affiché, et liens qui passent par un compteur de clics.
  function trackingBlock(links) {
    const t = window.__gfmTracking;
    const visible = b => { const c = b.img.closest('.a3s, [data-legacy-message-id], [data-message-id]'); return b.img.isConnected && c && c.offsetParent !== null; };
    const blocked = t ? t.blocked.filter(visible) : [];
    const clickHosts = [...new Set((links || []).map(l => l.host).filter(h => h && t && t.CLICK_TRACKERS.test(h)))];
    let html = '<div class="card">';
    if (t && !t.enabled) html += `<div class="note">Le blocage des pixels de suivi est désactivé dans les <a href="#" data-act="options">options</a>.</div>`;
    html += blocked.length
      ? `<div class="row"><span class="chip ok">🛡 ${plural(blocked.length, 'pixel')} de suivi bloqué${blocked.length > 1 ? 's' : ''}</span><span class="small muted grow">l’expéditeur ne saura pas que tu as ouvert ce mail</span></div>
         ${blocked.map(b => `<div class="finding"><span class="pts">🛡</span><span><b>${esc(b.host || '?')}</b> — ${esc(b.reason)}<br><span class="muted small mono">${esc(b.url.slice(0, 90))}${b.url.length > 90 ? '…' : ''}</span></span></div>`).join('')}`
      : `<div class="small muted">Aucun pixel de suivi détecté dans ce mail.</div>`;
    if (clickHosts.length) html += `<div class="finding" style="margin-top:6px"><span class="pts">🔗</span><span><b>Liens pistés</b> : les liens passent par ${clickHosts.map(esc).join(', ')} — l’expéditeur saura si tu cliques.</span></div>`;
    return html + '</div>';
  }

  function renderMail() {
    const m = S.mail;
    if (m.loading) { body.innerHTML = loading(m.progress); return; }
    if (m.error) { body.innerHTML = `<div class="err">${esc(m.error)}</div><button class="btn" data-act="mail-retry">Réessayer</button>`; return; }
    if (!m.data) {
      body.innerHTML = `<div class="empty"><div class="big">📭</div><b>Ouvre un mail</b><br>pour voir quels filtres il déclenche, pourquoi, et s’il est dangereux.
        <div style="margin-top:20px" class="row" ><span class="grow"></span>
        <button class="btn tonal" data-tab="spam">Analyser le dossier Spam</button><button class="btn" data-tab="simp">Simplifier mes filtres</button><span class="grow"></span></div></div>`;
      return;
    }
    const d = m.data, mail = d.mail, who = nameOf(mail.from);
    const where = mail.system.includes('SPAM') ? ['Spam', 'bad'] : mail.system.includes('TRASH') ? ['Corbeille', 'bad'] : mail.system.includes('INBOX') ? ['Boîte de réception', 'blue'] : ['Archivé', ''];
    let html = `<div class="card soft">
      <div style="font:500 16px/1.35 'Google Sans',Roboto,Arial,sans-serif">${esc(mail.subject || '(sans objet)')}</div>
      <div class="small muted" style="margin:4px 0 8px">${esc(who.name)} &lt;${esc(who.email)}&gt; · ${esc(fmtDate(mail.date))}${mail.count > 1 ? ` · ${mail.count} messages` : ''}</div>
      <div class="row"><span class="chip ${where[1]}">${where[0]}</span>${mail.labels.map(l => `<span class="chip label">🏷️ ${esc(l)}</span>`).join('')}</div>
    </div>`;

    html += `<h2>Pourquoi ces filtres ? <span class="count">${plural(d.matches.length, 'filtre')} sur ${d.ruleCount.toLocaleString('fr-FR')} · ${d.elapsedMs} ms</span></h2>`;
    if (!d.matches.length) {
      html += `<div class="card"><b>Aucun de tes filtres ne correspond à ce mail.</b><div class="muted small" style="margin-top:4px">Libellé posé à la main, filtre supprimé ou modifié depuis l’arrivée du mail, ou nuance de Gmail (racines de mots, texte dans une image) que le moteur ne voit pas.</div></div>`;
    }
    html += d.matches.map((x, i) => filterCard(x, i, d.matches.length)).join('');

    if (d.unexplained.length) {
      html += `<h2>Libellé${d.unexplained.length > 1 ? 's' : ''} sans filtre exact <span class="count">${d.unexplained.length}</span></h2>
        <div class="muted small" style="margin:-4px 0 10px">Présent sur le mail, mais aucun filtre ne le déclenche à la lettre : Gmail est plus souple (racines de mots), ou le filtre a changé, ou le libellé a été posé à la main.</div>`;
      for (const l of d.unexplained) {
        const ex = m.explain[l];
        html += `<div class="card"><div class="row"><span class="chip label">🏷️ ${esc(l)}</span><span class="grow"></span>
          ${!ex ? `<button class="btn small" data-act="explain" data-label="${esc(l)}">Chercher le filtre probable</button>` : ''}</div>
          ${ex && ex.loading ? `<div class="muted small" style="margin-top:8px">Recherche…</div>` : ''}
          ${ex && ex.error ? `<div class="err" style="margin-top:8px">${esc(ex.error)}</div>` : ''}
          ${ex && ex.data ? (ex.data.candidates.length ? ex.data.candidates.map(c => `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)">
              <code class="crit">${esc(c.rule.description)}</code> <span class="chip ${c.score >= 3 ? 'ok' : 'warn'}">${c.score >= 3 ? 'très probable' : 'probable'}</span>
              <div class="small" style="margin-top:4px">${esc(c.reason)}</div>${c.preview ? `<div class="excerpt">${mark(c.preview)}</div>` : ''}</div>`).join('')
            : `<div class="muted small" style="margin-top:8px">Aucun des ${ex.data.ruleCount} filtres qui posent ce libellé n’a ses mots dans ce mail : il vient d’ailleurs (posé à la main, filtre supprimé, ou créé après ce mail).</div>`) : ''}
        </div>`;
      }
    }

    html += `<h2>Dangerosité</h2>${dangerBlock(d.scam, false)}`;
    if (d.scam.hiddenSample) html += `<details><summary>Ce que tu ne vois pas : texte caché (lu par les filtres)</summary><div class="card soft small" style="margin-top:8px">${esc(d.scam.hiddenSample)}</div></details>`;
    html += `<h2>Pistage</h2>${trackingBlock(d.scam.links)}`;

    html += `<h2>En clair</h2>`;
    if (!d.claude) html += `<div class="muted small">Ajoute ta clé API Anthropic dans les <a href="#" data-act="options">options</a> pour que Claude t’explique ce tri en quelques phrases.</div>`;
    else if (!m.claude) html += `<button class="btn tonal" data-act="claude">✦ Expliquer avec Claude</button> <span class="small muted">envoie l’expéditeur, l’objet et un extrait du mail à l’API Anthropic</span>`;
    else if (m.claude.loading) html += `<div class="claude muted">Claude réfléchit…</div>`;
    else if (m.claude.error) html += `<div class="err">${esc(m.claude.error)}</div>`;
    else html += `<div class="claude">${esc(m.claude.text)}</div>`;

    html += `<h2>Créer un filtre</h2>${proposeBlock()}${createForm()}`;
    body.innerHTML = html;
  }

  /* ═════════════ onglet « Spams » ═════════════ */

  async function loadSpam() {
    S.spam = { ...S.spam, loading: true, progress: 'Connexion à Gmail…', error: '', data: null, sel: '', edits: {}, alt: {}, done: {}, off: new Set(), busy: '', notice: null };
    render();
    try {
      const data = await call('spam:analyze', {}, t => { S.spam.progress = t; if (S.tab === 'spam') render(); });
      S.spam.data = data;
      S.spam.opts = { labelName: data.labelName, ...(data.settings || {}) };
      const ids = Object.keys(data.mails).sort((a, b) => data.mails[b].danger.score - data.mails[a].danger.score);
      S.spam.sel = ids[0] || '';
    } catch (e) { S.spam.error = e.message; }
    S.spam.loading = false;
    if (S.tab === 'spam') render();
  }

  function mailRow(id) {
    const v = S.spam.data.mails[id];
    if (!v) return '';
    const who = nameOf(v.from);
    return `<div class="mailrow ${S.spam.sel === id ? 'sel' : ''}" data-act="sel" data-id="${esc(id)}">
      <span class="badge" style="background:${v.danger.color}" title="${esc(v.danger.verdict)}">${v.danger.score}</span>
      <span class="grow"><div class="who">${esc(who.name)}</div><div class="what">${esc(v.subject)}</div></span>
    </div>`;
  }

  // Affiche le spam dans Gmail lui-même (derrière le panneau) : ⋮ → « Filtrer les messages similaires » y est à portée.
  function showInGmail(id) {
    const v = S.spam.data.mails[id];
    if (!v) return;
    S.spam.sel = id;
    location.hash = `#spam/${v.threadId}`;
  }

  function renderSpam() {
    const sp = S.spam;
    if (sp.loading) { body.innerHTML = loading(sp.progress); return; }
    if (sp.error) { body.innerHTML = `<div class="err">${esc(sp.error)}</div><button class="btn" data-act="spam-run">Réessayer</button>`; return; }
    if (!sp.data) {
      body.innerHTML = `<div class="empty"><div class="big">🛡️</div><b>Dossier Spam</b><br>Dangerosité de chaque spam, et filtres proposés pour qu’ils n’y arrivent plus — testés pour n’attraper aucun vrai mail.<div style="margin-top:20px"><button class="btn filled" data-act="spam-run">Analyser le dossier Spam</button></div></div>`;
      return;
    }
    const d = sp.data;
    const count = Object.keys(d.mails).length;
    if (!count) { body.innerHTML = `<div class="empty"><div class="big">✨</div><b>Rien à traiter</b><br>${d.total} mail(s) dans le Spam, ${d.skipped} déjà en ${esc(d.labelName)}.</div>`; return; }

    let list = `<div class="row small muted" style="margin-bottom:12px">${plural(count, 'spam')} à traiter · ${d.skipped} déjà en ${esc(d.labelName)} ignoré(s)</div>`;
    if (sp.notice) list += `<div class="${sp.notice.ok ? 'good' : 'err'}">${esc(sp.notice.text)}</div>`;
    if (d.proposals.length) list += `<h2>Filtres proposés <span class="count">${d.proposals.length} · 0 mail légitime chacun</span></h2>
      <div class="desc">Le premier choix attrape le plus de spams déjà reçus ; une phrase courte attrape aussi les variantes de la campagne.
        <b>Copier</b> copie la phrase et affiche le spam dans Gmail : ⋮ → <b>Filtrer les messages similaires</b> → vide « De », colle dans <b>« Contient les mots »</b> → libellé <b>${esc(d.labelName)}</b>.</div>`;
    for (const p of d.proposals) {
      const off = sp.off.has(p.pid);
      const cur = current(p);
      const kindOf = c => c.type === 'subject' ? 'Objet' : 'Texte';
      const reach = a => `${plural(a.total, 'spam')} déjà reçu${a.total > 1 ? 's' : ''}`;
      list += `<div class="card ${off ? 'off' : ''}">
        <div class="row"><input type="checkbox" data-act="pick" data-pid="${p.pid}" ${off ? '' : 'checked'} title="Inclure dans « Tout copier en OR »">
          <span class="chip blue">${kindOf(cur.cand)}</span>${cur.cand.byClaude ? '<span class="chip warn">✦ Claude</span>' : ''}<span class="chip ok">${reach(cur)}</span><span class="grow"></span>
          <a class="small" href="${esc(searchUrl(cur.query))}" target="_blank" rel="noopener">Tester dans Gmail ↗</a></div>
        <input type="text" class="crit-edit" style="margin:8px 0 4px" data-edit="${p.pid}" value="${esc(sp.edits[p.pid] ?? cur.cand.value)}" title="Modifiable : teste une phrase modifiée avec « Tester dans Gmail »">
        ${p.alts.length > 1 ? `<details style="margin:2px 0 6px" ${sp.alt[p.pid] !== undefined ? 'open' : ''}><summary>Choisir parmi ${p.alts.length} propositions</summary>
          ${p.alts.map((a, i) => `<label class="choice"><input type="radio" name="alt-${p.pid}" data-act="alt" data-pid="${p.pid}" value="${i}" ${(sp.alt[p.pid] || 0) === i ? 'checked' : ''}>
            <span class="grow"><span class="chip">${kindOf(a.cand)}</span> <code>${esc(a.cand.value)}</code><br><span class="small muted">${reach(a)} · 0 vrai mail</span></span></label>`).join('')}</details>` : ''}
        ${p.coverIds.slice(0, 3).map(mailRow).join('')}${p.coverIds.length > 3 ? `<div class="small muted" style="padding:2px 10px">… et ${p.coverIds.length - 3} autre${p.coverIds.length > 4 ? 's' : ''} spam${p.coverIds.length > 4 ? 's' : ''}</div>` : ''}
        <div class="row" style="margin-top:8px"><code class="small grow">${esc(spamCrit(p))}</code>
          <button class="btn small filled" data-act="spam-copy" data-pid="${p.pid}">${sp.copied === p.pid ? '✓ Copié' : 'Copier'}</button>
          <button class="btn small" data-act="spam-done" data-pid="${p.pid}" ${sp.busy ? 'disabled' : ''} title="Le filtre est collé dans Gmail : libellé ${esc(d.labelName)} sur ${p.coverIds.length > 1 ? 'ces spams' : 'ce spam'}, puis spam suivant">${sp.busy === p.pid ? '…' : 'J’ai traité'}</button></div>
      </div>`;
    }
    if (d.uncovered.length) {
      list += `<h2>Sans critère sûr <span class="count">${d.uncovered.length} · laissés tels quels</span></h2><div class="card">${d.uncovered.map(mailRow).join('')}</div>`;
      if (!d.claudeUsed) list += `<div class="muted small">Ajoute ta clé API Anthropic dans les <a href="#" data-act="options">options</a> pour que Claude propose des critères pour ceux-là.</div>`;
    }
    if (d.claudeError) list += `<div class="err">Claude : ${esc(d.claudeError)}</div>`;

    const keep = body.scrollTop;
    body.innerHTML = list;
    body.scrollTop = keep;      // on reste au même endroit après « Copier »
    const n = picked().length;
    setFooter(`<span class="hint" title="Au-delà de 1 000 filtres, l’API Gmail refuse d’en créer ; l’interface de Gmail, non.">À coller dans Gmail.</span>
      <button class="btn" data-act="spam-run">Relancer l’analyse</button>
      <button class="btn filled" data-act="spam-copy-all" ${n ? '' : 'disabled'}>${sp.copied === 'all' ? '✓ Copié' : n > 1 ? `Copier les ${n} en OR` : 'Copier la phrase cochée'}</button>`);
  }

  // Choix en cours d'une carte (le premier = celui qui attrape le plus de spams déjà reçus), phrase modifiée comprise
  const current = p => p.alts[S.spam.alt[p.pid] || 0];
  const picked = () => S.spam.data.proposals.filter(p => !S.spam.off.has(p.pid));
  function spamCrit(p) {
    const c = current(p).cand;
    const v = String(S.spam.edits[p.pid] ?? c.value).trim().replace(/^"|"$/g, '');
    return c.type === 'subject' ? `subject:"${v}"` : `"${v}"`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) { window.prompt('Copie cette phrase (Ctrl+C) :', text); return false; }
  }

  /* ═════════════ onglet « Simplifier » ═════════════ */

  async function loadPlan() {
    S.simp = { ...S.simp, loading: true, progress: 'Analyse de tes filtres…', error: '', plan: null, report: null, tests: {}, choice: {}, dupOff: new Set(), mergeOn: new Set() };
    render();
    try {
      S.simp.plan = await call('simplify:plan', {}, t => { S.simp.progress = t; if (S.tab === 'simp') render(); });
      S.status = S.simp.plan.status;
    } catch (e) { S.simp.error = e.message; }
    S.simp.loading = false;
    if (S.tab === 'simp') render();
  }

  function testBox(o) {
    const t = S.simp.tests[o.broad.id];
    if (!t) return `<button class="btn small" data-act="test-rule" data-id="${esc(o.broad.id)}">Tester sur mes mails</button>`;
    if (t.loading) return `<span class="small muted">Recherche dans Gmail…</span>`;
    if (t.error) return `<span class="small" style="color:var(--red)">${esc(t.error)}</span>`;
    return t.count ? `<div class="note" style="margin:8px 0 0">« ${esc(o.broad.description)} » attrape aussi <b>${t.count}${t.capped ? '+' : ''}</b> mail(s) hors spam :<br>${t.samples.map(s => `• ${esc(nameOf(s.from).name)} — ${esc(s.subject)}`).join('<br>')}</div>`
      : `<div class="good" style="margin:8px 0 0">✓ « ${esc(o.broad.description)} » n’attrape aucun mail hors spam : les filtres plus précis ne servent à rien.</div>`;
  }

  function renderSimp() {
    const s = S.simp;
    if (s.loading) { body.innerHTML = loading(s.progress); return; }
    if (s.error) { body.innerHTML = `<div class="err">${esc(s.error)}</div><button class="btn" data-act="plan">Réessayer</button>`; return; }
    if (s.report) {
      body.innerHTML = s.report.busy ? loading(s.report.busy) : `${s.saved ? `<div class="small muted">💾 Sauvegarde enregistrée : ${esc(s.saved)}</div>` : ''}
        <div class="good">✓ ${s.report.ok} / ${s.report.total} opération(s) appliquée(s). Tu as maintenant ${s.report.status.count.toLocaleString('fr-FR')} filtres.</div>
        ${s.report.errors.length ? `<div class="err">${s.report.errors.map(esc).join('\n')}</div>` : ''}`;
      if (!s.report.busy) setFooter(`<button class="btn filled" data-act="plan">Continuer la simplification</button>`);
      return;
    }
    if (!s.plan) { body.innerHTML = loading(); return; }
    const p = s.plan;
    const dupN = p.duplicates.reduce((n, d) => n + d.remove.length, 0);
    const mergeN = p.merges.reduce((n, m) => n + m.rules.length - 1, 0);
    const limit = (p.status && p.status.limit) || 1000;
    let html = `<div class="card soft"><div class="row"><span class="score">${p.total.toLocaleString('fr-FR')}</span><span class="grow">filtres aujourd’hui</span>
        <button class="btn small" data-act="export" title="Fichier réimportable dans Gmail, et utilisable par l'archiveur Thunderbird pour ranger les vieux mails">💾 Exporter mes filtres</button></div>
      <div class="small muted" style="margin-top:6px">${plural(dupN, 'doublon')} · ${plural(p.overlaps.length, 'recoupement')} à arbitrer · jusqu’à ${mergeN} filtres en moins par fusion.
      Avant toute modification, une sauvegarde XML de tous tes filtres est enregistrée dans tes téléchargements (réimportable dans Gmail → Paramètres → Filtres → Importer).</div>
      ${s.saved ? `<div class="small muted" style="margin-top:4px">💾 Sauvegarde enregistrée : ${esc(s.saved)}</div>` : ''}</div>`;
    if (p.total >= limit) html += `<div class="note">L’API Gmail, par laquelle passe l’extension, ne crée plus de filtre au-delà de ${limit.toLocaleString('fr-FR')} (« Too many filters ») ; tu en as ${p.total.toLocaleString('fr-FR')}.
      Les suppressions (doublons, recoupements) marchent ; les fusions et « Créer ce filtre » échoueront sans rien supprimer tant que tu es au-dessus.
      Doublons supprimés, il en resterait ${(p.total - dupN).toLocaleString('fr-FR')}.</div>`;
    if (p.job) html += `<div class="note">Une simplification a été interrompue : ${p.job.next} / ${p.job.ops.length} faites. <button class="btn small" data-act="resume">Reprendre</button></div>`;

    html += `<h2>Doublons</h2><div class="desc">mêmes critères, mêmes actions — on garde le plus ancien</div>`;
    html += p.duplicates.length ? p.duplicates.map((d, i) => `<label class="card row" style="cursor:pointer"><input type="checkbox" data-act="dup" data-i="${i}" ${s.dupOff.has(i) ? '' : 'checked'}>
        <code class="crit grow">${esc(d.keep.description)}</code><span class="chip">×${d.remove.length + 1}</span></label>`).join('')
      + `<div class="row"><span class="grow"></span><button class="btn filled small" data-act="apply-dup">Supprimer les doublons cochés</button></div>`
      : `<div class="muted small">Aucun doublon.</div>`;

    html += `<h2>Recoupements</h2><div class="desc">un filtre court attrape déjà ce qu’attrapent des filtres plus précis</div>`;
    if (p.overlaps.length) {
      html += `<div class="row" style="margin-bottom:10px"><span class="muted small grow">Teste chaque filtre court sur tes vrais mails pour savoir lequel garder.</span><button class="btn small" data-act="test-all">Tout tester</button></div>`;
      html += p.overlaps.map(o => {
        const t = s.tests[o.broad.id];
        const tested = t && !t.loading && !t.error;
        const reco = tested ? (t.count ? 'narrow' : 'broad') : '';
        const ch = s.choice[o.broad.id] || 'none';
        return `<div class="card">
          <div class="row"><code class="crit">${esc(o.broad.description)}</code><span class="small muted">couvre</span></div>
          <div class="terms">${o.narrows.map(n => `<code class="crit">${esc(n.description)}</code>`).join('')}</div>
          <div class="row small muted" style="margin-top:6px">${o.broad.actions.map(a => `<span class="chip">${esc(a)}</span>`).join('')}</div>
          <div style="margin-top:8px">${testBox(o)}</div>
          <div style="margin-top:8px">
            <label class="choice ${reco === 'broad' ? 'reco' : ''}"><input type="radio" name="ov-${esc(o.broad.id)}" data-act="choice" data-id="${esc(o.broad.id)}" value="broad" ${ch === 'broad' ? 'checked' : ''}>
              <span>Garder « ${esc(o.broad.description)} », supprimer ${plural(o.narrows.length, 'filtre')} plus précis${reco === 'broad' ? ' <b>(conseillé)</b>' : ''}</span></label>
            <label class="choice ${reco === 'narrow' ? 'reco' : ''}"><input type="radio" name="ov-${esc(o.broad.id)}" data-act="choice" data-id="${esc(o.broad.id)}" value="narrow" ${ch === 'narrow' ? 'checked' : ''}>
              <span>Trop large : supprimer « ${esc(o.broad.description)} », garder les phrases précises${reco === 'narrow' ? ' <b>(conseillé)</b>' : ''}</span></label>
            <label class="choice"><input type="radio" name="ov-${esc(o.broad.id)}" data-act="choice" data-id="${esc(o.broad.id)}" value="none" ${ch === 'none' ? 'checked' : ''}><span>Ne rien changer</span></label>
          </div></div>`;
      }).join('');
      html += `<div class="row"><span class="grow"></span><button class="btn filled small" data-act="apply-overlaps">Appliquer mes choix</button></div>`;
    } else html += `<div class="muted small">Aucun recoupement.</div>`;

    html += `<h2>Fusions</h2><div class="desc">filtres simples aux mêmes actions → un seul filtre « a OR b OR … »</div>`;
    if (p.merges.length) {
      html += p.merges.map((m, i) => `<div class="card ${s.mergeOn.has(i) ? '' : 'off'}">
          <label class="row" style="cursor:pointer"><input type="checkbox" data-act="merge" data-i="${i}" ${s.mergeOn.has(i) ? 'checked' : ''}>
            <b>${m.rules.length} filtres → 1</b><span class="grow"></span>${m.actions.map(a => `<span class="chip ${/^🏷️/.test(a) ? 'label' : ''}">${esc(a)}</span>`).join('')}</label>
          <details><summary>Voir le filtre fusionné</summary><div class="crit mono small" style="margin-top:8px">${esc(m.criteria.from ? 'from: ' + m.criteria.from : m.criteria.query)}</div></details>
        </div>`).join('');
      html += `<div class="row"><button class="btn small text" data-act="merge-all">Tout cocher</button><span class="grow"></span><button class="btn filled small" data-act="apply-merges">Fusionner les filtres cochés</button></div>`;
    } else html += `<div class="muted small">Rien à fusionner.</div>`;
    body.innerHTML = html;
  }

  // Enregistrée par le service worker (chrome.downloads) : un lien blob dans Gmail s'ouvre dans un onglet sous Brave.
  async function saveBackup(onProgress) {
    const b = await call('filters:saveBackup', { name: `mailFilters_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.xml` }, onProgress);
    S.simp.saved = `${b.filename} (${plural(b.count, 'filtre')})`;
  }

  async function applyOps(ops, resume) {
    if (!resume && !ops.length) return;
    S.simp.report = { busy: 'Sauvegarde de tes filtres…' };
    render();
    try {
      if (!S.simp.backupDone) {
        await saveBackup(t => { S.simp.report.busy = t; if (S.tab === 'simp') render(); });
        S.simp.backupDone = true;
      }
      S.simp.report = await call('simplify:apply', resume ? { resume: true } : { ops }, t => { S.simp.report.busy = t; if (S.tab === 'simp') render(); });
      S.status = S.simp.report.status;
    } catch (e) { S.simp.report = null; S.simp.error = e.message; }
    if (S.tab === 'simp') render();
  }

  async function testRule(id) {
    S.simp.tests[id] = { loading: true };
    if (S.tab === 'simp') render();
    try { S.simp.tests[id] = await call('simplify:testRule', { id }); }
    catch (e) { S.simp.tests[id] = { error: e.message }; }
    const t = S.simp.tests[id];
    if (!t.error && !S.simp.choice[id]) S.simp.choice[id] = t.count ? 'narrow' : 'broad';
    if (S.tab === 'simp') render();
  }

  /* ═════════════ onglet « Tendances » ═════════════ */

  async function loadStats(fetch = true) {
    S.stats = { ...S.stats, loading: true, progress: fetch ? 'Liste des spams…' : 'Calcul…', error: '', claude: null };
    render();
    try { S.stats.data = await call('stats:run', { months: S.stats.months, source: S.stats.source, fetch }, t => { S.stats.progress = t; if (S.tab === 'stats') render(); }); }
    catch (e) { S.stats.error = e.message; }
    S.stats.loading = false;
    if (S.tab === 'stats') render();
  }

  const pct = x => Math.round(x * 100) + ' %';
  const shortDate = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const monthYear = t => new Date(t).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const periodName = (d, t) => d.unit === 'month' ? monthYear(t) : `Semaine du ${shortDate(t)}`;

  // Barres par semaine ou par mois (une seule série : pas de légende), pics annotés, infobulle au survol.
  function trendChart(d) {
    const W = 640, H = 170, top = 22, base = H - 22, n = d.series.length;
    const max = Math.max(4, ...d.series.map(w => w.count));
    const step = W / n, bw = Math.max(1, step - (step > 4 ? 2 : 0.5));
    const peaks = new Map(d.peaks.map(p => [p.start, p]));
    let bars = '', hits = '', labels = '', ticks = '';
    d.series.forEach((w, i) => {
      const x = i * step + (step - bw) / 2;
      const h = w.count ? Math.max(2, (w.count / max) * (base - top)) : 0;
      if (h) {
        const r = Math.min(4, bw / 2, h), y = base - h;
        bars += `<path d="M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${base}Z" fill="#0b57d0"/>`;
      }
      const p = peaks.get(w.start);
      if (p) labels += `<text x="${x + bw / 2}" y="${base - h - 6}" text-anchor="middle" font-size="11" fill="#1f1f1f">${p.count}</text>`;
      const tip = `${periodName(d, w.start)} : ${plural(w.count, 'spam')}${p ? ` — pic : ${pct(p.domainShare)} venaient de ${p.domain}` : ''}`;
      hits += `<rect class="hit" x="${i * step}" y="0" width="${step}" height="${H}" fill="transparent" data-tip="${esc(tip)}"/>`;
      const dt = new Date(w.start);
      // repères : début de chaque mois (vue par semaine) ou de chaque année (vue par mois ; trimestres si < 3 ans)
      const tick = d.unit === 'week' ? dt.getDate() <= 7 : (n <= 36 ? dt.getMonth() % 3 === 0 : dt.getMonth() === 0);
      if (tick && i < n - 2) ticks += `<text x="${x}" y="${H - 6}" font-size="10" fill="#5e5e5e">${d.unit === 'week' || n <= 36 ? dt.toLocaleDateString('fr-FR', { month: 'short', ...(d.unit === 'month' ? { year: '2-digit' } : {}) }) : dt.getFullYear()}</text>`;
    });
    return `<div class="chart" style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Spams par ${d.unit === 'month' ? 'mois' : 'semaine'}">
        <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="#c4c7c5"/>
        <line x1="0" x2="${W}" y1="${top}" y2="${top}" stroke="#eceff1" stroke-dasharray="3 3"/>
        <text x="${W}" y="${top - 6}" text-anchor="end" font-size="10" fill="#5e5e5e">${max} / ${d.unit === 'month' ? 'mois' : 'semaine'}</text>
        ${bars}${labels}${ticks}${hits}
      </svg><div class="tip" hidden></div></div>`;
  }

  function barList(title, items, opts = {}) {
    if (!items.length) return '';
    return `<div class="card"><div style="font-weight:500;margin-bottom:8px">${title}</div>
      ${items.map(it => `<div style="margin:6px 0">
        <div class="row small" style="flex-wrap:nowrap"><span class="grow mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(it.value)}">${opts.link ? `<a href="${esc(searchUrl(opts.link(it.value)))}" target="_blank" rel="noopener">${esc(it.value)}</a>` : esc(it.value)}</span>
          <span class="muted">${it.count} · ${pct(it.share)}</span></div>
        <div class="gauge" style="margin:3px 0 0;height:6px"><i style="width:${Math.max(2, it.share * 100)}%;background:#0b57d0"></i></div></div>`).join('')}
      ${opts.note || ''}</div>`;
  }

  function renderStats() {
    const st = S.stats;
    const d = st.data;
    const head = `<div class="row" style="margin-bottom:10px"><span class="small muted">Période</span>
      <select data-bind="stats.months">${[[3, '3 mois'], [6, '6 mois'], [12, '12 mois'], [24, '2 ans'], [60, '5 ans'], [0, 'Tout l’historique']].map(([m, t]) => `<option value="${m}" ${st.months === m ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <button class="btn small" data-act="stats-run" ${st.loading ? 'disabled' : ''}>${d ? 'Actualiser' : 'Analyser'}</button></div>
      ${d ? `<div class="row" style="margin-bottom:12px">${[{ key: 'all', name: 'Tout', count: d.stored }, ...d.sources].map(x => `<button class="btn small ${st.source === x.key ? 'tonal' : 'text'}" data-act="stats-source" data-key="${esc(x.key)}">${esc(x.name)} <span class="muted">${x.count.toLocaleString('fr-FR')}</span></button>`).join('')}</div>` : ''}`;
    if (st.loading) { body.innerHTML = head + loading(st.progress); return; }
    if (st.error) { body.innerHTML = head + `<div class="err">${esc(st.error)}</div>`; return; }
    if (!d) {
      body.innerHTML = head + `<div class="muted small">Analyse le dossier Spam, le libellé des filtres et les libellés des options (ex. « scam »). Chaque spam lu reste dans l’historique, même après que Gmail l’a supprimé (Spam et Corbeille se vident au bout de 30 jours).</div>`;
      return;
    }
    if (!d.total) { body.innerHTML = head + `<div class="empty"><div class="big">🌤</div>Aucun spam sur la période.</div>`; return; }
    const ch = d.change4;
    // « hausse » / « baisse » seulement si l'écart dépasse le bruit (±10 % et au moins 5 spams)
    const dir = ch === null || Math.abs(d.last4 - d.prev4) < 5 ? 0 : ch <= -0.1 ? -1 : ch >= 0.1 ? 1 : 0;
    const trend = ch === null ? '' : `<span class="chip ${dir < 0 ? 'ok' : dir > 0 ? 'warn' : ''}">${dir < 0 ? '▼ en baisse' : dir > 0 ? '▲ en hausse' : '■ stable'} · ${d.prev4} → ${d.last4} sur 4 semaines</span>`;
    const variants = d.lists.to.filter(t => t.value !== d.me.toLowerCase() && !t.value.startsWith('('));
    let html = head + `<div class="card soft"><div class="row"><span class="score">${d.total.toLocaleString('fr-FR')}</span><span class="grow">spams ${d.months ? `sur ${d.months >= 24 ? d.months / 12 + ' ans' : d.months + ' mois'}` : 'en tout'} · ${d.last4} ces 4 dernières semaines</span>${trend}</div>
      <div class="small muted" style="margin-top:6px">Tendance de fond : ${d.monthlyTrend > 0 ? '+' : ''}${pct(d.monthlyTrend)} par mois${d.peaks.length ? ` · ${plural(d.peaks.length, 'vague')} repérée${d.peaks.length > 1 ? 's' : ''}` : ' · pas de vague marquée'}
      · historique depuis ${d.historyFrom ? monthYear(d.historyFrom) : '—'} (${d.stored.toLocaleString('fr-FR')} spams gardés${d.fresh ? `, dont ${d.fresh.toLocaleString('fr-FR')} nouveaux` : ''})</div></div>`;
    html += `<h2>Spams par ${d.unit === 'month' ? 'mois' : 'semaine'}</h2>${trendChart(d)}`;
    if (d.peaks.length) html += `<div class="card">${d.peaks.map(p => `<div class="finding"><span class="pts">🌊</span><span><b>${periodName(d, p.start)} : ${plural(p.count, 'spam')}</b> — ${pct(p.domainShare)} venaient de <a href="${esc(searchUrl('from:(' + p.domain + ')'))}" target="_blank" rel="noopener">${esc(p.domain)}</a></span></div>`).join('')}</div>`;

    html += `<h2>Points communs</h2>`;
    const commonText = c => c.field === 'words' ? esc(c.label.replace('%s', c.value))
      : c.field === 'tld' ? `expédiés depuis un domaine en <b class="mono">.${esc(c.value)}</b>`
      : `${esc(c.label)}${c.value ? ` <b class="mono">${esc(c.value)}</b>` : ''}`;
    html += d.commons.length ? `<div class="card">${d.commons.map(c => `<div class="finding"><span class="pts">${pct(c.share)}</span><span>${commonText(c)}</span></div>`).join('')}</div>`
      : `<div class="muted small">Rien ne revient dans plus d’un quart des spams : ils viennent d’horizons variés.</div>`;
    const isGmail = v => /@(gmail|googlemail)\.com$/.test(v.value);
    const spelled = variants.filter(isGmail), aliases = variants.filter(v => !isGmail(v));
    if (spelled.length) html += `<div class="note">📮 Une partie des spams vise ton adresse écrite autrement (${spelled.map(v => `<b class="mono">${esc(v.value)}</b>`).join(', ')}). Gmail ignore les points et le « + », mais pas les fichiers qui ont fuité : cette écriture désigne la liste d’origine.</div>`;
    if (aliases.length) html += `<div class="note">🔀 Des spams arrivent par des alias (${aliases.map(v => `<b class="mono">${esc(v.value)}</b> ×${v.count}`).join(', ')}). Un alias Relay / « Masquer mon adresse » n’a été donné qu’à un seul site : c’est ce site qui a fuité (ou revendu) l’adresse. Tu peux désactiver l’alias dans ton service de relais.</div>`;

    html += `<h2>En clair</h2>`;
    if (!d.claude) html += `<div class="muted small">Ajoute ta clé API Anthropic dans les <a href="#" data-act="options">options</a> pour que Claude interprète ces chiffres.</div>`;
    else if (!st.claude) html += `<button class="btn tonal" data-act="stats-claude">✦ Trouver le point commun avec Claude</button> <span class="small muted">envoie seulement les statistiques, pas tes mails</span>`;
    else if (st.claude.loading) html += `<div class="claude muted">Claude réfléchit…</div>`;
    else if (st.claude.error) html += `<div class="err">${esc(st.claude.error)}</div>`;
    else html += `<div class="claude">${esc(st.claude.text)}</div>`;

    html += `<h2>Détail</h2><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px">
      ${barList('Adresse visée', d.lists.to)}
      ${barList('Domaines d’expédition', d.lists.fromDomain, { link: v => `from:(${v})` })}
      ${barList('Serveurs d’envoi (IP /24)', d.lists.ip24)}
      ${barList('Plateformes d’envoi (adresse de retour)', d.lists.rp)}
      ${barList('Extensions de domaine', d.lists.tld.map(x => ({ ...x, value: '.' + x.value })))}
      ${barList('Mots des objets', d.lists.words, { link: v => `subject:(${v}) in:spam` })}
    </div>`;
    body.innerHTML = html;
  }

  // Infobulle du graphique
  root.addEventListener('mousemove', e => {
    const hit = e.target.closest && e.target.closest('rect.hit');
    const chart = e.target.closest && e.target.closest('.chart');
    const tip = chart && chart.querySelector('.tip');
    root.querySelectorAll('.chart .tip').forEach(t => { if (t !== tip) t.hidden = true; });
    if (!tip) return;
    if (!hit) { tip.hidden = true; return; }
    const box = chart.getBoundingClientRect();
    tip.textContent = hit.dataset.tip;
    tip.hidden = false;
    tip.style.left = Math.min(box.width - 220, Math.max(0, e.clientX - box.left - 110)) + 'px';
    tip.style.top = Math.max(0, e.clientY - box.top - 54) + 'px';
  });

  /* ───────── statut / actions générales ───────── */

  async function refreshStatus(reload, replace) {
    S.statusError = '';
    try { S.status = await call(reload ? 'filters:reload' : 'filters:status', { replace }); }
    catch (e) { S.statusError = e.message; }
    renderStatus();
  }

  function open(tab) {
    drawer.classList.add('open');
    S.tab = tab || (currentThread() ? 'mail' : inSpamFolder() ? 'spam' : S.tab);
    if (!S.status) refreshStatus();
    show(S.tab);
  }

  function show(tab) {
    S.tab = tab;
    render();
    if (tab === 'mail') loadMail();
    if (tab === 'spam' && !S.spam.data && !S.spam.loading && !S.spam.error) loadSpam();
    if (tab === 'simp' && !S.simp.plan && !S.simp.loading && !S.simp.error) loadPlan();
    if (tab === 'stats' && !S.stats.data && !S.stats.loading && !S.stats.error) loadStats();
  }

  const close = () => drawer.classList.remove('open');

  function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], obj)[last] = value;
  }

  root.addEventListener('click', async e => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { show(tabBtn.dataset.tab); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, d = S.mail.data;
    if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
    switch (act) {
      case 'toggle': drawer.classList.contains('open') ? close() : open(); break;
      case 'close': close(); break;
      case 'reload': await refreshStatus(true); if (S.tab === 'mail') loadMail(true); else if (S.tab === 'simp') loadPlan(); break;
      case 'replace': await refreshStatus(true, true); break;
      case 'options': chrome.runtime.sendMessage({ cmd: 'options' }).catch(() => {}); break;
      case 'mail-retry': loadMail(true); break;
      case 'del': S.mail.confirm = el.dataset.id; render(); break;
      case 'del-cancel': S.mail.confirm = ''; render(); break;
      case 'del-ok':
        try { await call('filter:delete', { id: el.dataset.id }); S.mail.confirm = ''; loadMail(true); }
        catch (err) { S.mail.error = err.message; render(); }
        break;
      case 'explain': {
        const label = el.dataset.label;
        S.mail.explain[label] = { loading: true }; render();
        try { S.mail.explain[label] = { data: await call('mail:explainLabel', { threadId: d.mail.threadId, label }) }; }
        catch (err) { S.mail.explain[label] = { error: err.message }; }
        if (S.tab === 'mail') render();
        break;
      }
      case 'claude':
        S.mail.claude = { loading: true }; render();
        try { S.mail.claude = await call('mail:claude', { threadId: d.mail.threadId }); }
        catch (err) { S.mail.claude = { error: err.message }; }
        if (S.tab === 'mail') render();
        break;
      case 'propose': {
        const key = S.mail.key;
        S.mail.propose = { loading: true, progress: 'Lecture du mail…' }; render();
        try {
          const data = await call('mail:propose', { threadId: d.mail.threadId }, t => { if (S.mail.key === key && S.mail.propose) { S.mail.propose.progress = t; if (S.tab === 'mail') render(); } });
          if (S.mail.key === key) S.mail.propose = { data };
        } catch (err) { if (S.mail.key === key) S.mail.propose = { error: err.message }; }
        if (S.tab === 'mail') render();
        break;
      }
      case 'propose-copy': {
        const p = S.mail.propose, all = p.data.proposals.map(x => x.query);
        const i = el.dataset.i === 'all' ? 'all' : +el.dataset.i;
        if (await copyText(i === 'all' ? all.join(' OR ') : all[i])) p.copied = i;
        render();
        break;
      }
      case 'create-open': {
        // des mots plutôt que l'expéditeur : la phrase sélectionnée dans le mail, sinon à saisir
        const sel = String(window.getSelection() || '').trim().replace(/\s+/g, ' ');
        S.mail.create = { field: 'query', value: sel, target: d.defaultLabel, defaultLabel: d.defaultLabel, archive: true, markRead: false };
        render();
        break;
      }
      case 'create-close': S.mail.create = null; render(); break;
      case 'create-test':
      case 'create-go': {
        const c = S.mail.create;
        c.error = ''; c.test = null; c.done = '';
        c.busy = act === 'create-test' ? 'Recherche dans Gmail…' : 'Création…'; render();
        try {
          if (act === 'create-test') c.test = await call('filter:test', c);
          else { const r = await call('filter:create', c); c.done = r.rule.description; S.status = r.status; loadMail(true); }
        } catch (err) { c.error = err.message; }
        c.busy = '';
        if (S.tab === 'mail' && S.mail.create) render();
        break;
      }
      case 'spam-run': loadSpam(); break;
      case 'spam-copy': {
        const p = S.spam.data.proposals.find(x => x.pid === el.dataset.pid);
        if (await copyText(spamCrit(p))) S.spam.copied = p.pid;
        showInGmail(p.coverIds[0]);
        render();
        break;
      }
      case 'spam-done': {
        const sp = S.spam, i = sp.data.proposals.findIndex(x => x.pid === el.dataset.pid), p = sp.data.proposals[i];
        sp.busy = p.pid; sp.notice = null; render();
        try {
          const r = await call('spam:done', { ids: p.coverIds });
          sp.data.proposals.splice(i, 1);
          p.coverIds.forEach(id => delete sp.data.mails[id]);
          sp.data.skipped += p.coverIds.length;
          sp.notice = { ok: true, text: `✓ ${plural(r.count, 'spam')} rangé${r.count > 1 ? 's' : ''} dans ${r.labelName}` };
          const next = sp.data.proposals[i] || sp.data.proposals[0];
          if (next) showInGmail(next.coverIds[0]);
        } catch (err) { sp.notice = { ok: false, text: err.message }; }
        sp.busy = '';
        if (S.tab === 'spam') render();
        break;
      }
      case 'spam-copy-all': if (await copyText(picked().map(spamCrit).join(' OR '))) S.spam.copied = 'all'; render(); break;
      case 'alt': S.spam.alt[el.dataset.pid] = +el.value; delete S.spam.edits[el.dataset.pid]; render(); break;
      case 'sel': showInGmail(el.dataset.id); render(); break;
      case 'pick': el.checked ? S.spam.off.delete(el.dataset.pid) : S.spam.off.add(el.dataset.pid); render(); break;
      case 'plan': loadPlan(); break;
      case 'stats-run': loadStats(); break;
      case 'stats-source': S.stats.source = el.dataset.key; loadStats(false); break;
      case 'stats-claude':
        S.stats.claude = { loading: true }; render();
        try { S.stats.claude = await call('stats:claude'); }
        catch (err) { S.stats.claude = { error: err.message }; }
        if (S.tab === 'stats') render();
        break;
      case 'resume': applyOps([], true); break;
      case 'export':
        try { await saveBackup(); }
        catch (err) { S.simp.error = err.message; }
        render();
        break;
      case 'dup': { const i = +el.dataset.i; el.checked ? S.simp.dupOff.delete(i) : S.simp.dupOff.add(i); break; }
      case 'merge': { const i = +el.dataset.i; el.checked ? S.simp.mergeOn.add(i) : S.simp.mergeOn.delete(i); render(); break; }
      case 'merge-all': S.simp.plan.merges.forEach((_, i) => S.simp.mergeOn.add(i)); render(); break;
      case 'choice': S.simp.choice[el.dataset.id] = el.value; break;
      case 'test-rule': testRule(el.dataset.id); break;
      case 'test-all': {
        const ids = S.simp.plan.overlaps.map(o => o.broad.id).filter(id => !S.simp.tests[id]);
        for (let i = 0; i < ids.length; i += 2) await Promise.all(ids.slice(i, i + 2).map(testRule));
        break;
      }
      case 'apply-dup':
        applyOps(S.simp.plan.duplicates.filter((_, i) => !S.simp.dupOff.has(i)).flatMap(g => g.remove.map(r => ({ type: 'delete', id: r.id }))));
        break;
      case 'apply-overlaps':
        applyOps(S.simp.plan.overlaps.flatMap(o => {
          const ch = S.simp.choice[o.broad.id];
          return ch === 'broad' ? o.narrows.map(n => ({ type: 'delete', id: n.id })) : ch === 'narrow' ? [{ type: 'delete', id: o.broad.id }] : [];
        }));
        break;
      case 'apply-merges':
        applyOps(S.simp.plan.merges.filter((_, i) => S.simp.mergeOn.has(i)).map(m => ({ type: 'merge', criteria: m.criteria, action: m.action, ids: m.rules.map(r => r.id) })));
        break;
    }
  });

  // Champs : on met l'état à jour sans tout redessiner (sinon le curseur saute).
  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.edit) S.spam.edits[t.dataset.edit] = t.value;
    if (t.dataset.bind) {
      const v = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.bind.startsWith('create.')) setPath(S.mail, t.dataset.bind, v);
      else if (t.dataset.bind.startsWith('opts.')) setPath(S.spam, t.dataset.bind, v);
      else if (t.dataset.bind === 'stats.months') S.stats.months = Number(v);
    }
  });
  root.addEventListener('change', e => { if (e.target.dataset.bind === 'create.field' || e.target.dataset.bind === 'create.target') render(); });

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open')) close(); });
  chrome.runtime.onMessage.addListener(m => { if (m.cmd === 'open') open(); });

  // Navigation dans Gmail : on suit le mail affiché (Gmail dessine le fil un peu après le changement d'adresse).
  window.addEventListener('hashchange', () => {
    if (!drawer.classList.contains('open') || S.tab !== 'mail') return;
    [300, 900, 2000].forEach(ms => setTimeout(() => loadMail(), ms));
  });
})();
