// Bouton « Traiter mes spams » + panneau de validation, injectés dans Gmail (Shadow DOM isolé du CSS de Gmail).
(() => {
  if (window.__spamFiltreur) return;
  window.__spamFiltreur = true;

  const host = document.createElement('div');
  host.id = 'spam-filtreur-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Google Sans", Roboto, Arial, sans-serif; }
    .fab { position: fixed; right: 24px; bottom: 24px; z-index: 2147483000; background: #c5221f; color: #fff;
      border: 0; border-radius: 24px; padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,.3); }
    .fab:hover { background: #a50e0e; }
    .back { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483001; display: none;
      align-items: center; justify-content: center; }
    .back.open { display: flex; }
    .panel { background: #fff; color: #202124; width: min(860px, 94vw); max-height: 88vh; border-radius: 12px;
      display: flex; flex-direction: column; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    header { padding: 16px 20px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; }
    header h2 { margin: 0; font-size: 18px; }
    .x { background: none; border: 0; font-size: 22px; cursor: pointer; color: #5f6368; }
    main { padding: 16px 20px; overflow: auto; font-size: 13px; }
    footer { font-size: 13px; padding: 12px 20px; border-top: 1px solid #e0e0e0; display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; align-items: center; }
    .btn { border: 1px solid #dadce0; background: #fff; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-size: 13px; }
    .btn.primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
    .btn:disabled { opacity: .5; cursor: default; }
    .prog { color: #5f6368; padding: 24px 0; text-align: center; }
    .card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
    .card.off { opacity: .5; }
    .row { display: flex; gap: 10px; align-items: center; }
    .crit { flex: 1; font-family: Consolas, monospace; font-size: 13px; padding: 6px 8px; border: 1px solid #dadce0; border-radius: 4px; }
    .tag { font-size: 11px; background: #e8f0fe; color: #1967d2; border-radius: 10px; padding: 2px 8px; white-space: nowrap; }
    .tag.ok { background: #e6f4ea; color: #137333; }
    .tag.claude { background: #fef7e0; color: #b06000; }
    ul { margin: 6px 0 0 26px; padding: 0; color: #5f6368; }
    li { margin: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .opts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; background: #f8f9fa; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; }
    .opts label { display: flex; gap: 6px; align-items: center; }
    .opts input[type=text] { padding: 4px 6px; border: 1px solid #dadce0; border-radius: 4px; }
    h3 { font-size: 14px; margin: 16px 0 8px; }
    .warn { color: #b06000; }
    .err { color: #c5221f; white-space: pre-wrap; }
    .good { color: #137333; }
    a { color: #1a73e8; }
  </style>
  <button class="fab" title="Analyser le dossier Spam et proposer des filtres">Traiter mes spams</button>
  <div class="back"><div class="panel">
    <header><h2>Traiter mes spams</h2><button class="x" title="Fermer">×</button></header>
    <main></main>
    <footer></footer>
  </div></div>`;

  const $ = s => root.querySelector(s);
  const back = $('.back'), main = $('main'), footer = $('footer');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let port = null, state = null;

  function connect() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'spam' });
    port.onDisconnect.addListener(() => { port = null; });
    port.onMessage.addListener(onMsg);
    return port;
  }

  function progress(text) { main.innerHTML = `<div class="prog">${esc(text)}</div>`; }

  function open() {
    back.classList.add('open');
    footer.innerHTML = '';
    progress('Analyse du dossier Spam…');
    connect().postMessage({ cmd: 'analyze' });
  }
  function close() { back.classList.remove('open'); }

  $('.fab').addEventListener('click', open);
  $('.x').addEventListener('click', close);
  back.addEventListener('click', e => { if (e.target === back) close(); });
  chrome.runtime.onMessage.addListener(m => { if (m.cmd === 'open') open(); });

  function onMsg(m) {
    if (m.type === 'progress') progress(m.text);
    else if (m.type === 'error') { main.innerHTML = `<p class="err">Erreur : ${esc(m.text)}</p>`; footer.innerHTML = `<button class="btn" id="retry">Réessayer</button>`; $('#retry').onclick = open; }
    else if (m.type === 'proposals') { state = m; renderProposals(); }
    else if (m.type === 'applied') renderReport(m.data);
  }

  function searchLink(query) {
    return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`;
  }

  function renderProposals() {
    const { data, settings: s } = state;
    let html = `<p>${data.total} mail(s) dans le Spam — ${data.skipped} déjà en <b>${esc(s.labelName)}</b> ignoré(s).</p>`;
    if (!data.proposals.length && !data.uncovered.length) {
      main.innerHTML = html + '<p class="good">Rien à traiter.</p>';
      footer.innerHTML = '<button class="btn" id="close2">Fermer</button>';
      $('#close2').onclick = close;
      return;
    }
    html += `<div class="opts">
      <label>Libellé <input type="text" id="o-label" value="${esc(s.labelName)}"></label>
      <label><input type="checkbox" id="o-archive" ${s.archive ? 'checked' : ''}> Ne pas afficher dans la boîte de réception</label>
      <label><input type="checkbox" id="o-trash" ${s.trashAfter ? 'checked' : ''}> Mettre à la corbeille les spams traités</label>
      <label><input type="checkbox" id="o-existing" ${s.applyExisting ? 'checked' : ''}> Appliquer aussi aux conversations correspondantes</label>
    </div>`;
    if (data.proposals.length) html += `<h3>Filtres proposés (${data.proposals.length})</h3>`;
    for (const p of data.proposals) {
      const tags = [
        `<span class="tag ok">0 mail légitime</span>`,
        `<span class="tag">${p.covers.length} spam(s) ici</span>`,
        p.cand.byClaude ? '<span class="tag claude">Claude</span>' : ''
      ].join(' ');
      html += `<div class="card" data-pid="${p.pid}">
        <div class="row">
          <input type="checkbox" class="acc" checked title="Créer ce filtre">
          <input class="crit" value="${esc(p.cand.value)}" data-orig="${esc(p.cand.value)}" title="${esc(p.cand.label)}">
          <span class="tag">${esc(p.cand.label)}</span>
        </div>
        <div class="row" style="margin-top:6px">${tags}
          <a href="${searchLink(p.query)}" target="_blank" rel="noopener">voir dans Gmail</a>
          <span style="color:#5f6368">${esc(p.query)}</span></div>
        <ul>${p.covers.map(c => `<li><b>${esc(c.from)}</b> — ${esc(c.subject)}</li>`).join('')}</ul>
      </div>`;
    }
    if (data.uncovered.length) {
      html += `<h3 class="warn">Sans critère sûr (${data.uncovered.length}) — laissés tels quels</h3>
        <ul>${data.uncovered.map(c => `<li><b>${esc(c.from)}</b> — ${esc(c.subject)}</li>`).join('')}</ul>`;
      if (!data.claudeUsed) html += `<p class="warn">Ajoute ta clé API Anthropic dans les options de l’extension pour que Claude propose des critères pour ceux-là.</p>`;
    }
    if (data.claudeError) html += `<p class="err">Claude : ${esc(data.claudeError)}</p>`;
    main.innerHTML = html;

    root.querySelectorAll('.card').forEach(card => {
      card.querySelector('.acc').addEventListener('change', e => card.classList.toggle('off', !e.target.checked));
    });

    footer.innerHTML = `<span style="flex:1;color:#5f6368">Rien n’est créé tant que tu n’as pas validé.</span>
      <button class="btn" id="cancel">Annuler</button>
      <button class="btn primary" id="go" ${data.proposals.length ? '' : 'disabled'}>Valider et appliquer</button>`;
    $('#cancel').onclick = close;
    $('#go').onclick = doApply;
  }

  function doApply() {
    const { data } = state;
    const proposals = [];
    root.querySelectorAll('.card').forEach(card => {
      if (!card.querySelector('.acc').checked) return;
      const p = data.proposals.find(x => x.pid === card.dataset.pid);
      const input = card.querySelector('.crit');
      const value = input.value.trim().replace(/^"|"$/g, '');
      if (!value) return;
      const edited = value !== input.dataset.orig;
      proposals.push({ cand: { ...p.cand, value }, edited, coverIds: p.coverIds });
    });
    if (!proposals.length) return;
    const options = {
      labelName: $('#o-label').value.trim() || state.settings.labelName,
      archive: $('#o-archive').checked,
      trashAfter: $('#o-trash').checked,
      applyExisting: $('#o-existing').checked
    };
    footer.innerHTML = '';
    progress('Création des filtres…');
    connect().postMessage({ cmd: 'apply', proposals, options });
  }

  function renderReport(r) {
    main.innerHTML = `<h3>Terminé</h3><ul style="margin-left:0;list-style:none">${r.report.map(x =>
      `<li class="${x.ok ? 'good' : 'err'}">${x.ok ? '✔' : '✖'} <code>${esc(x.query)}</code> — ${esc(x.msg)}</li>`).join('')}</ul>
      <p>${r.trashed} spam(s) mis à la corbeille.</p>`;
    footer.innerHTML = '<button class="btn primary" id="close3">Fermer</button>';
    $('#close3').onclick = close;
  }
})();
