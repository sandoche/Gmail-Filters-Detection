function buildAddOn(e) {
  // Activate temporary Gmail add-on scopes.
  var filters = Gmail.Users.Settings.Filters.list('me');
  
  var accessToken = e.messageMetadata.accessToken;
  GmailApp.setCurrentMessageAccessToken(accessToken);

  var messageId = e.messageMetadata.messageId;
  var message = GmailApp.getMessageById(messageId);
  var body = message.getBody()
  
  var sectionSelected = CardService.newCardSection()
    .setHeader("<font color=\"#1257e0\"><b>Applicable filters</b></font>");       

  var sectionUnselected = CardService.newCardSection()
    .setHeader("<font color=\"#1257e0\"><b>Unapplicable filters</b></font>");     
  
  var checkboxGroupSelected = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('labels');

  var checkboxGroupUnselected = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('labels');  
  
  var countSelected = 0;
  var countUnselected = 0;
  
  for(var i = 0; i < filters.filter.length; i++) {
    var query = filters.filter[i].criteria.query;
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
    .setTitle('Filters')
    .setImageUrl('https://www.gstatic.com/images/icons/material/system/1x/label_googblue_48dp.png'));
  
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
  return text.indexOf(string) > -1
}
