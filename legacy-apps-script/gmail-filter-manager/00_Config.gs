/**
 * Gmail Filter Manager — panneau latéral Gmail.
 * Pour le mail ouvert : quels filtres s'appliquent, à cause de quelle phrase / expéditeur,
 * suppression du filtre fautif, création d'un filtre depuis une phrase, indicateur spam.
 *
 * Les filtres sont lus via l'API Gmail (service avancé "Gmail" à activer : Services + → Gmail API),
 * puis gardés dans un cache persistant (fichier Drive) mis à jour au fil de l'eau ; l'API n'est
 * relue que sur demande (🔄 Recharger / refreshFilterIndex).
 */
const APP_CONFIG = {
  DEFAULT_LABEL: "###CACA###",       // libellé proposé par défaut à la création
  CACHE_TTL_SECONDS: 21600,          // CacheService (couche rapide) : 6 h — le fichier Drive, lui, ne périme pas
  CACHE_KEY: "filters_index_v4",
  CACHE_FOLDER: "Gmail Filter Manager (cache)",
  CACHE_FILE: "gfm_filters_cache.json",
  MAX_MATCHES_DISPLAYED: 30,
  DEBUG_INCLUDE_STACK: true
};

// cache mémoire de l'instance chaude
let __FILTER_INDEX = null;