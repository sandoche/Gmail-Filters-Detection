// Service worker : reçoit les demandes du panneau (content.js) et les confie à spam.js / filters.js.
import { log, logError } from './gmail-api.js';
import { analyzeSpam, applySpam } from './spam.js';
import * as filters from './filters.js';
import { runStats, claudeStats } from './stats.js';

const COMMANDS = {
  'spam:analyze': (_, post) => analyzeSpam(post),
  'spam:apply': async (args, post) => {
    const r = await applySpam(args, post);
    await filters.learnCreated(r.report.map(x => x.created), { id: r.labelId, name: r.labelName });
    return r;
  },
  'filters:status': async (_, post) => { await filters.getIndex(post); return filters.status(); },
  'filters:reload': filters.reload,
  'filters:backup': filters.backup,
  'mail:analyze': filters.analyzeMail,
  'mail:explainLabel': filters.explainLabel,
  'mail:claude': filters.claudeExplain,
  'filter:test': filters.testCriterion,
  'filter:create': filters.createFilter,
  'filter:delete': filters.deleteFilter,
  'simplify:plan': filters.plan,
  'simplify:testRule': filters.testRule,
  'simplify:apply': filters.applyOps,
  'stats:run': runStats,
  'stats:claude': claudeStats
};

// Protocole : { rid, cmd, args } → { rid, type: 'progress', text } … puis { rid, type: 'result', data } ou { rid, type: 'error', text }.
log('Service worker démarré.');
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'gfm') return;
  const send = m => { try { port.postMessage(m); } catch (_) { /* panneau fermé */ } };
  port.onMessage.addListener(async ({ rid, cmd, args }) => {
    log('Commande reçue :', cmd);
    const post = text => send({ rid, type: 'progress', text });
    try {
      if (!COMMANDS[cmd]) throw new Error(`Commande inconnue : ${cmd}`);
      send({ rid, type: 'result', data: await COMMANDS[cmd](args || {}, post) });
    } catch (e) {
      logError(`Erreur pendant « ${cmd} » :`, e);
      send({ rid, type: 'error', text: e.message || String(e) });
    }
  });
});

chrome.runtime.onMessage.addListener(m => { if (m && m.cmd === 'options') chrome.runtime.openOptionsPage(); });

chrome.action.onClicked.addListener(async tab => {
  if (tab.url && tab.url.startsWith('https://mail.google.com/')) {
    chrome.tabs.sendMessage(tab.id, { cmd: 'open' }).catch(() => {});
  } else {
    chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#spam' });
  }
});
