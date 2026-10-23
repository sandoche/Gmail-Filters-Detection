# Anciennes versions Apps Script / Legacy Apps Script versions

Remplacées par l'extension à la racine du dépôt. / Replaced by the extension at the root of the repository.

- `Code.gs`, `appsscript.json`, `manifest.json` : le premier add-on Gmail, qui détecte si un filtre peut s'appliquer au mail ouvert. / The first Gmail add-on, which detects whether a filter can apply to the open email.
  Installation : https://developers.google.com/gmail/add-ons/guides/quickstart
- `gmail-filter-manager/` : **Gmail Filters Manager** (2023–2026), panneau latéral Gmail : pourquoi ce mail a ce filtre, indicateur spam, création / suppression de filtres, import / export XML, doublons, file d'attente. Sa logique a été portée dans `lib/gfm-*.js`. / Gmail side panel: why this email has this filter, spam indicator, create / delete filters, XML import / export, duplicates, queue. Its logic was ported into `lib/gfm-*.js`.
