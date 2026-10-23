// Présente un message de l'API Gmail (format=full) avec les méthodes de GmailMessage (Apps Script)
// utilisées par le code porté : gfm-match.js et gfm-scam.js tournent ainsi sans modification.
import { headerMap, bodyParts } from '../analyzer.js';

export function messageAdapter(apiMsg) {
  const h = headerMap(apiMsg.payload);
  const first = k => (h[k] || [''])[0];
  const all = k => (h[k] || []).join(', ');
  const { plain, html } = bodyParts(apiMsg.payload);
  const headers = {};
  for (const k of Object.keys(h)) headers[k] = h[k][0];

  const attachments = [];
  (function walk(p) {
    if (!p) return;
    const disp = ((p.headers || []).find(x => x.name.toLowerCase() === 'content-disposition') || {}).value || '';
    if (p.filename && p.body && p.body.attachmentId && !/^inline/i.test(disp)) attachments.push({ name: p.filename, size: p.body.size || 0 });
    for (const c of p.parts || []) walk(c);
  })(apiMsg.payload);

  return {
    getId: () => apiMsg.id,
    getThreadId: () => apiMsg.threadId,
    getSubject: () => first('subject'),
    getFrom: () => first('from'),
    getTo: () => all('to'),
    getCc: () => all('cc'),
    getBcc: () => all('bcc'),
    getReplyTo: () => first('reply-to'),
    getDate: () => new Date(Number(apiMsg.internalDate) || Date.parse(first('date')) || 0),
    getPlainBody: () => plain,
    getBody: () => html || plain,          // comme GmailMessage.getBody() : le texte brut quand il n'y a pas de HTML
    getAttachments: () => attachments,
    getSizeEstimate: () => apiMsg.sizeEstimate || 0,
    getHeaders: () => headers,
    getLabelIds: () => apiMsg.labelIds || [],
    getSnippet: () => apiMsg.snippet || ''
  };
}
