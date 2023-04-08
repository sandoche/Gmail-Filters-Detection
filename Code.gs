function buildAddOn(e) {
  // Vérifier si les données sont en cache
  var cache = CacheService.getScriptCache();
  var cacheKey = 'filtersData'; // Clé pour stocker les données en cache
  var cachedData = cache.get(cacheKey);

  if (cachedData) {
    // Utiliser les données en cache si disponibles
    var filters = JSON.parse(cachedData);
  } else {
    // Si les données ne sont pas en cache, les récupérer via l'API
    filters = Gmail.Users.Settings.Filters.list('me');
    // Stocker les données en cache pour une utilisation ultérieure
    cache.put(cacheKey, JSON.stringify(filters), 3600); // 1 heure de durée de vie du cache (en secondes)
  }

  var accessToken = e.messageMetadata.accessToken;
  GmailApp.setCurrentMessageAccessToken(accessToken);

  var messageId = e.messageMetadata.messageId;
  var message = GmailApp.getMessageById(messageId);
  var body = message.getBody()
  
  var sectionSelected = CardService.newCardSection()
    .setHeader("<font color=\"#ea545b\"><b>Applicable Filters</b></font>");       

  var sectionUnselected = CardService.newCardSection()
    .setHeader("<font color=\"#3DA80B\"><b>Unapplicable Filters</b></font>");     
  
  var checkboxGroupSelected = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('labelsselected');

  var checkboxGroupUnselected = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('labelsunselected');  
  
  var countSelected = 0;
  var countUnselected = 0;
  
  for(var i = 0; i < filters.filter.length; i++) {
    var query = filters.filter[i].criteria.query;
    var regex = new RegExp('"(.*)"', 'gi');
    var reg = regex.exec(query)
    Logger.log(query + ' ' + reg);
    if(reg) {
      query = reg[1]
    }
    
    if (query && doesTextContainsString(body, query)) {
      checkboxGroupSelected.addItem(query, query, doesTextContainsString(body, query));
      countSelected++;
    }
    else if (query && !doesTextContainsString(body, query)) {
      checkboxGroupUnselected.addItem(query, query, doesTextContainsString(body, query));
      countUnselected++;
    }
  }
  
  sectionSelected.addWidget(checkboxGroupSelected);
  sectionUnselected.addWidget(checkboxGroupUnselected);
  
  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
    .setTitle('Gmail Why Filters')
    .setImageUrl('http://images2.imagebam.com/f9/88/37/acf1091058702334.png'));
  
  if (countSelected > 0) {
    card = card.addSection(sectionSelected) 
  }
  
  if (countUnselected > 0) {
    card = card.addSection(sectionUnselected) 
  }
  
  card = card.build();

  return [card];
} 

function doesTextContainsString(text, string) {
 return text.toLowerCase().indexOf(string.toLowerCase()) > -1
}
