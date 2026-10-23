// Accès Google : connexion OAuth (launchWebAuthFlow), API Gmail, API Claude. Partagé par spam.js et filters.js.
import { DEFAULTS } from './defaults.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const TOKEN_TIMEOUT_MS = 180000;

// Logs visibles dans chrome://extensions → « service worker » → Console.
export const log = (...a) => console.log('[Traiter mes spams]', ...a);
export const logError = (...a) => console.error('[Traiter mes spams]', ...a);

export async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const { anthropicKey = '' } = await chrome.storage.local.get('anthropicKey');
  return { ...DEFAULTS, ...s, anthropicKey };
}

// ---------- Gmail API ----------
// Connexion Google via launchWebAuthFlow : marche aussi sous Brave / Edge, sans compte connecté au navigateur.
// Client OAuth de type « Application Web », URI de redirection autorisée : chrome.identity.getRedirectURL().
let tokenCache = null;   // { token, expires }
let tokenPending = null; // une seule fenêtre Google à la fois, même si plusieurs appels attendent le jeton

async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expires) return tokenCache.token;
  if (!tokenCache) {
    // Le service worker peut être arrêté puis relancé par le navigateur : le jeton est gardé pour la session.
    const { gToken } = await chrome.storage.session.get('gToken');
    if (gToken && Date.now() < gToken.expires) { tokenCache = gToken; return gToken.token; }
  }
  if (!tokenPending) tokenPending = authorize().finally(() => { tokenPending = null; });
  return tokenPending;
}

async function dropToken() {
  tokenCache = null;
  await chrome.storage.session.remove('gToken');
}

async function authorize() {
  try {
    return await webAuth(false); // session Google ouverte et accord déjà donné : pas de fenêtre
  } catch (e) {
    log('Connexion silencieuse impossible, ouverture de la fenêtre Google…', e.message);
  }
  return webAuth(true);
}

async function webAuth(interactive) {
  const { client_id, scopes } = chrome.runtime.getManifest().oauth2;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: scopes.join(' '),
    include_granted_scopes: 'true'
  });
  log(interactive ? 'Ouverture de la fenêtre de connexion Google' : 'Connexion Google silencieuse', '— redirection :', chrome.identity.getRedirectURL());
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Pas de réponse de Google après ${TOKEN_TIMEOUT_MS / 1000} s. La fenêtre de connexion Google a peut-être été fermée ` +
      `ou est restée derrière le navigateur.`)), TOKEN_TIMEOUT_MS);
  });
  try {
    const redirect = await Promise.race([chrome.identity.launchWebAuthFlow({ url: url.href, interactive }), timeout]);
    const p = new URLSearchParams(new URL(redirect).hash.slice(1));
    if (p.get('error')) throw new Error(`Google a refusé la connexion : ${p.get('error')}`);
    const granted = (p.get('scope') || '').split(' ');
    log('Jeton Google obtenu. Autorisations :', granted);
    const missing = scopes.filter(s => !granted.includes(s));
    if (missing.length) {
      throw new Error(`Autorisation(s) non accordée(s) : ${missing.join(', ')}. Réessaie et coche toutes les cases sur l’écran Google.`);
    }
    tokenCache = { token: p.get('access_token'), expires: Date.now() + ((Number(p.get('expires_in')) || 3600) - 60) * 1000 };
    await chrome.storage.session.set({ gToken: tokenCache });
    return tokenCache.token;
  } catch (e) {
    if (interactive) logError('Échec de l’autorisation Google :', e);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function api(path, { method = 'GET', body, params } = {}, attempt = 0) {
  const token = await getToken();
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else if (v !== undefined) url.searchParams.set(k, v);
  }
  const t0 = Date.now();
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  log(method, path, '→', res.status, `(${Date.now() - t0} ms)`);
  if (res.status === 401 && attempt === 0) {
    await dropToken();
    return api(path, { method, body, params }, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
    return api(path, { method, body, params }, attempt + 1);
  }
  if (!res.ok) {
    const err = new Error(`Gmail ${res.status} : ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

export async function listIds(query, includeSpamTrash, max = 100) {
  const ids = [];
  let pageToken;
  do {
    const r = await api('messages', { params: { q: query, includeSpamTrash, maxResults: Math.min(500, max - ids.length), pageToken } });
    for (const m of (r && r.messages) || []) ids.push(m.id);
    pageToken = r && r.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

export async function findLabel(name) {
  const r = await api('labels');
  return ((r && r.labels) || []).find(l => l.name === name) || null;
}

export async function ensureLabel(name) {
  const l = await findLabel(name);
  if (l) return l.id;
  const c = await api('labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
  return c.id;
}

// ---------- Claude ----------
export async function claude(s, prompt, maxTokens = 2000) {
  if (!s.anthropicKey) throw new Error('Clé API Anthropic absente : ajoute-la dans les options de l’extension.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': s.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: s.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) throw new Error(`Claude ${res.status} : ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).map(c => c.text || '').join('');
}
