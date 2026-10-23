// Réglages par défaut (partagés par le service worker et la page d'options).
export const DEFAULTS = {
  labelName: '###CACA###',
  archive: true,          // ne pas afficher dans la boîte de réception
  applyExisting: false,   // « appliquer aussi aux conversations correspondantes » : décoché par défaut
  trashAfter: true,       // mettre les spams traités à la corbeille une fois le filtre créé
  claudeMode: 'fallback', // 'off' | 'fallback' (Claude seulement si les règles locales échouent)
  model: 'claude-sonnet-5-5',
  maxSpams: 100,
  blockTrackers: true     // neutraliser les pixels de suivi dans les mails affichés (tracking.js)
};
