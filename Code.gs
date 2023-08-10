var cachedFilters = null; // Variable pour stocker les filtres en cache

function getCachedFilters() {
  if (cachedFilters === null) {
    cachedFilters = Gmail.Users.Settings.Filters.list('me').filter;
  }
  return cachedFilters;
}

function clearCache() {
  var cache = CacheService.getScriptCache();
  cache.removeAll(); // Cette ligne vide tout le cache
}

function buildAddOn(e) {
  var messageId = e.gmail.messageId; // Récupère l'ID du mail actuel

  var cardSection = CardService.newCardSection();

  var emailIdText = CardService.newTextParagraph()
    .setText('<b>' + messageId + '</b>');

  cardSection.addWidget(emailIdText);

  var showApplicableButton = CardService.newTextButton()
    .setText('Which Filters are Applicable ?')
    .setOnClickAction(CardService.newAction().setFunctionName('showApplicableFilters')
    .setParameters({'idmail': messageId}));

  cardSection.addWidget(showApplicableButton);

  var card = CardService.newCardBuilder()
    .addSection(cardSection)
    .build();

  return card;
}

function showApplicableFilters(e) {
  var idmail = e.parameters.idmail;
  var applicableFilters = whyThisMail(idmail);

  var cardSection = CardService.newCardSection();

  var messageIdText = CardService.newTextParagraph()
    .setText(idmail);

  cardSection.addWidget(messageIdText);

  var applicableFiltersText = '';
  if (applicableFilters.length > 0) {
    applicableFilters.forEach(filter => {
      applicableFiltersText += filter + '\n';
    });
  } else {
    applicableFiltersText = 'No Applicable Filters.';
  }

  var filtersText = CardService.newTextParagraph()
    .setText(applicableFiltersText);

  cardSection.addWidget(filtersText);

  var card = CardService.newCardBuilder()
    .addSection(cardSection)
    .build();

  return card;
}


function whyThisMail(idmail) {
  var message = GmailApp.getMessageById(idmail);
  var body = message.getPlainBody();
  var filters = getCachedFilters();

  var applicableFilters = [];

  for (var i = 0; i < filters.length; i++) {
    var filter = filters[i];
    var criteria = filter.criteria;

    if (criteria && criteria.query) {
      var criterialean = criteria.query.replace(/"/g, "");
      var queryApplicable = doesTextContainsString(criterialean, body);

      if (queryApplicable) {
        applicableFilters.push(criterialean);
      }
    }
  }

  applicableFilters.sort();

  return applicableFilters;
}


function getFilteredFiltersHtml(idmail, isApplicable) {
  var message = GmailApp.getMessageById(idmail);
  var body = message.getPlainBody();
  var filters = getCachedFilters();

  var filtersHtml = '';
  for (var i = 0; i < filters.length; i++) {
    var filter = filters[i];
    var criteria = filter.criteria;

    if (criteria && criteria.query) {
      var criterialean = criteria.query.replace(/"/g, "");
      var queryApplicable = doesTextContainsString(criterialean, body);

      if ((isApplicable && queryApplicable) || (!isApplicable && !queryApplicable)) {
        filtersHtml += '<div>[ ] ' + criterialean + '</div>';
      }
    }
  }

  return filtersHtml;
}


function checkFilters() {
  var messageId = getCurrentMessageId();
  if (messageId) {
    whyThisMail(messageId);
  }
}

function getFilters() {
  var filters = Gmail.Users.Settings.Filters.list('me').filter;

  if (filters.length > 0) {
    for (var i = 0; i < filters.length; i++) {
      var filter = filters[i];
      //Logger.log('Filter ID: ' + filter.id);

      if (filter.criteria.query) {
        //Logger.log('Correspondance: ' + filter.criteria.query);
      } else {
        //Logger.log('No "Correspondance" specified for this filter.');
      }

      if (filter.action.addLabelIds) {
        var labelNames = getLabelNames(filter.action.addLabelIds);
        //Logger.log('Applied Label Names: ' + labelNames);
      } else {
        //Logger.log('No label applied for this filter.');
      }

      //Logger.log('------------------'); // Separate entries for clarity
    }
  } else {
    //Logger.log('Aucun filtre trouvé dans le compte.');
  }
}

function getLabelNames(labelIds) {
  var labelNames = [];
  for (var i = 0; i < labelIds.length; i++) {
    var label = Gmail.Users.Labels.get('me', labelIds[i]);
    if (label) {
      labelNames.push(label.name);
    }
  }
  return labelNames.join(', ');
}

function getCurrentMessageId() {
  var currentMessage = GmailApp.getCurrentMessage();
  if (currentMessage) {
    return currentMessage.getId();
  }
  return null;
}

function GSCRIPTwhyThisMail() {
  var idmail = 'msg-f:1773829072373142234';
  var message = GmailApp.getMessageById(idmail);
  var body = GmailApp.getMessageById(idmail).getPlainBody();
  var filters = getCachedFilters();

  Logger.log('Email ID : ' + idmail);
  Logger.log(body)

  var applicableFiltersCount = 0; // Initialize the count of applicable filters

  for (var i = 0; i < filters.length; i++) {
    var filter = filters[i];
    var criteria = filter.criteria;

    if (criteria && criteria.query) {
      var criterialean = criteria.query.replace(/"/g, "");
      var fromApplicable = !criteria.from || doesTextContainsString(body, criteria.from);
      var subjectApplicable = !criteria.subject || doesTextContainsString(body, criteria.subject);
      var queryApplicable = doesTextContainsString(criterialean, body);

      //Logger.log(criterialean,body)

      if (fromApplicable && subjectApplicable && queryApplicable) {
        var appliedLabelNames = getLabelNames(filter.action.addLabelIds);
        Logger.log('Correspondance: ' + criterialean + '\n' + 'Applied Label: ' + appliedLabelNames);
        applicableFiltersCount++; // Increment the count of applicable filters
      }
    }
  }

  if (applicableFiltersCount > 0) {
    Logger.log(applicableFiltersCount + ' Applicable Filters:');
  } else {
    Logger.log('No Applicable filters');
  }
}

function checkApplicableFilterForMail(idmail) {
  var message = GmailApp.getMessageById(idmail);
  var filters = getCachedFilters();

  for (var i = 0; i < filters.length; i++) {
    var filter = filters[i];
    var criteria = filter.criteria;

    if (criteria) {
      var fromApplicable = isFilterApplicable(criteria.from, message.getFrom());
      var toApplicable = isFilterApplicable(criteria.to, message.getTo());
      var subjectApplicable = isFilterApplicable(criteria.subject, message.getSubject());

      if (fromApplicable && toApplicable && subjectApplicable) {
        return {
          isApplicable: true,
          filterId: filter.id,
          filterCriteria: JSON.stringify(criteria),
          appliedLabelNames: getLabelNames(filter.action.addLabelIds)
        };
      }
    }
  }

  return {
    isApplicable: false
  };
}

function isFilterApplicable(filterValue, messageValue) {
  if (!filterValue) {
    return true; // No filter value specified, so it's applicable
  }

  var filterWords = filterValue.toLowerCase().split(' ');
  var messageWords = messageValue.toLowerCase().split(' ');

  return filterWords.every(word => messageWords.includes(word));
}


function GSCRIPTWhyThisMailCheck() {
  //var idmail = 'msg-f:1773829072373142234';
  var idmail = 'msg-f:1773836771915066428';
  var filterResult = checkApplicableFilterForMail(idmail);

  if (filterResult.isApplicable) {
    Logger.log('Applicable Filters for : ' + idmail );
    Logger.log('Criteria: ' + filterResult.filterCriteria + '\n' + 'Applied Labels: ' + filterResult.appliedLabelNames);
  } else {
    Logger.log('No applicable filter found.');
  }
}


function getCriteriaValues(filterCriteria) {
  var criteriaObj = JSON.parse(filterCriteria);
  var criteriaValues = [];

  if (criteriaObj.from) {
    criteriaValues.push('From: ' + criteriaObj.from);
  }
  if (criteriaObj.to) {
    criteriaValues.push('To: ' + criteriaObj.to);
  }
  if (criteriaObj.subject) {
    criteriaValues.push('Subject: ' + criteriaObj.subject);
  }
  // Add more conditions for other criteria fields if needed

  return criteriaValues.join(', ');
}


function doesTextContainsString(TexttoTest, FullText) {
  if (FullText.includes(TexttoTest)) {
    return true;
  } else {
    return false;
  }
}
