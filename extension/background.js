chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  }
});

chrome.runtime.onStartup?.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  }
});

// Naukri job pages may auto-show the extension UI as an in-page dock. The
// browser's native sidePanel.open() requires a user gesture, so this dock is
// hosted by the page and uses the same extension sidepanel document.
function showNaukriDock(tabId, url) {
  let parsed;
  try { parsed = new URL(url || ''); } catch { return; }
  if (!parsed.hostname.endsWith('naukri.com')) return;

  const isJobListing = /\/job-listings?-/i.test(parsed.pathname);
  chrome.scripting.executeScript({
    target: { tabId },
    args: [isJobListing, chrome.runtime.getURL('sidepanel.html?embedded=1')],
    func: (shouldShow, panelUrl) => {
      if (shouldShow && document.getElementById('__menixjobai_dock')) return;
      document.getElementById('__menixjobai_dock')?.remove();
      if (!shouldShow || !document.documentElement) return;
      const dock = document.createElement('div');
      dock.id = '__menixjobai_dock';
      dock.style.cssText = 'position:fixed;inset:0 0 0 auto;width:min(390px,100vw);height:100vh;z-index:2147483647;background:#0b1017;box-shadow:-8px 0 28px #0006;';
      const close = document.createElement('button');
      close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', 'Close MenixJobAI');
      close.style.cssText = 'position:absolute;z-index:1;top:5px;right:5px;width:25px;height:25px;border:0;border-radius:50%;background:#293646;color:#fff;font:18px/1 sans-serif;cursor:pointer;';
      close.addEventListener('click', () => dock.remove());
      const frame = document.createElement('iframe');
      frame.title = 'MenixJobAI'; frame.src = panelUrl;
      frame.style.cssText = 'width:100%;height:100%;border:0;';
      dock.append(frame, close);
      document.documentElement.append(dock);
    }
  }).catch(error => console.debug('MenixJobAI could not show the Naukri panel:', error));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if ((changeInfo.status === 'complete' || changeInfo.url) && url && /(^|\.)naukri\.com\//i.test(url.replace(/^https?:\/\//i, ''))) {
    showNaukriDock(tabId, url);
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  showNaukriDock(details.tabId, details.url);
});
