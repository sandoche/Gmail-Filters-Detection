# Gmail-Filters-Detection — « Traiter mes spams »

Extension Chrome (Manifest V3) pour Gmail.

> L’ancien add-on Google Apps Script d’origine est conservé dans [`legacy-apps-script/`](legacy-apps-script/).


Ajoute un bouton rouge **« Traiter mes spams »** en bas à droite de Gmail. Un clic :

1. lit tous les mails du dossier **Spam** (sauf ceux déjà étiquetés `###CACA###`) ;
2. pour chacun, cherche le critère de filtre le plus précis :
   - domaine d'expéditeur stable (les domaines aléatoires type `mgfizghn5qpsdjmx2f.com` sont écartés) ;
   - phrase exacte de l'objet (sans ton pseudo, les chiffres, les `____` ni les homoglyphes) ;
   - phrase exacte du corps ;
   - nom d'expéditeur affiché ;
3. **teste chaque critère dans la recherche Gmail** : il doit attraper le spam et **0 mail légitime** (hors Spam / Corbeille / `###CACA###`) ;
4. regroupe : un même critère peut couvrir plusieurs spams ;
5. si aucun critère sûr n'est trouvé, **demande à Claude** (si ta clé API est renseignée), puis re-teste ses propositions de la même façon ;
6. t'affiche la liste : tu peux décocher ou modifier chaque critère (une phrase modifiée est re-testée avant la création) ;
7. après **« Valider et appliquer »** : crée les filtres (libellé `###CACA###` + ne pas afficher dans la boîte de réception), puis **met à la corbeille** les spams traités.

« Appliquer aussi aux conversations correspondantes » est **décoché par défaut** (modifiable dans l'écran ou les options).

---

## Installation (une fois, ~10 min)

### 1. Charger l'extension
1. Clone ce dépôt dans ton dossier de travail (ex. `D:\DOCS\Documents\GitHub\Gmail-Filters-Detection`).
2. Ouvre `chrome://extensions`, active **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** → choisis le dossier du dépôt (celui qui contient `manifest.json`).
4. Vérifie que l'ID affiché est : **`ndmccgjpdbekpbjdiknmadiifhjchpdj`** (il est fixé par la clé du manifeste).

### 2. Créer l'accès à l'API Gmail (Google Cloud)
1. Va sur <https://console.cloud.google.com/> → **Nouveau projet** (ex. « Spam Filtreur »).
2. **API et services → Bibliothèque** → « Gmail API » → **Activer**.
3. **Google Auth Platform** (ou « Écran de consentement OAuth ») :
   - Type : **Externe** ; nom de l'appli : « Traiter mes spams » ; e-mail d'assistance : le tien.
   - **Audience → Utilisateurs test** → ajoute `soaresden@gmail.com`.
4. **Clients → Créer un client** → type **Extension Chrome** → *ID de l'élément* : `ndmccgjpdbekpbjdiknmadiifhjchpdj` → Créer.
5. Copie l'**ID client** (`xxxxx.apps.googleusercontent.com`).

### 3. Brancher l'ID client
1. Ouvre `manifest.json`, remplace `COLLE_ICI_TON_CLIENT_ID.apps.googleusercontent.com` par ton ID client.
2. Dans `chrome://extensions`, clique sur ↻ (recharger) sur l'extension.

### 4. (Optionnel) Claude en secours
Clic droit sur l'icône de l'extension → **Options** → colle ta clé API Anthropic (`sk-ant-…`) et vérifie le nom du modèle.
Sans clé, seules les règles locales sont utilisées.

### 5. Utilisation
Ouvre Gmail → bouton **Traiter mes spams** (ou clic sur l'icône de l'extension).
La première fois, Google demande l'autorisation (écran « Google n'a pas validé cette appli » → *Continuer* : c'est ton propre projet).

---

## Bon à savoir
- Autorisations demandées : `gmail.modify` (lire, étiqueter, mettre à la corbeille — **jamais de suppression définitive**) et `gmail.settings.basic` (créer les filtres).
- En mode « Test », Google peut redemander ton accord tous les 7 jours : c'est normal.
- Les spams sont mis à la **corbeille** (récupérables 30 jours), seulement après la création réussie du filtre qui les couvre.
- Les spams sans critère sûr restent dans le Spam, intacts.
- Gmail ne sait pas filtrer sur l'adresse de retour (`Return-Path`, le « via … ») : l'extension ne la propose donc pas comme critère.

## Tests

```bash
npm test
```

Les tests tournent sous Node 20+ avec une fausse API Gmail (aucun accès réseau).
