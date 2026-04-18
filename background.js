'use strict';

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled.addListener(() => {
    console.log('Secure extension background worker installed');
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'OPEN_DASHBOARD') {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
      sendResponse({ ok: true });
      return true;
    }

    sendResponse({ ok: false, error: 'Unknown message' });
    return true;
  });
}
