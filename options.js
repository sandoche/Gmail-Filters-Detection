import { DEFAULTS } from './defaults.js';

const $ = id => document.getElementById(id);
const fields = Object.keys(DEFAULTS);

const s = await chrome.storage.sync.get(DEFAULTS);
const { anthropicKey = '' } = await chrome.storage.local.get('anthropicKey');
for (const k of fields) {
  const el = $(k);
  if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
}
$('anthropicKey').value = anthropicKey;

$('save').addEventListener('click', async () => {
  const out = {};
  for (const k of fields) {
    const el = $(k);
    out[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || DEFAULTS[k] : el.value.trim() || DEFAULTS[k];
  }
  await chrome.storage.sync.set(out);
  await chrome.storage.local.set({ anthropicKey: $('anthropicKey').value.trim() });
  $('ok').textContent = 'Enregistré ✔';
  setTimeout(() => { $('ok').textContent = ''; }, 2000);
});
