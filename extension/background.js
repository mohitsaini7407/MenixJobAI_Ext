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
  // Keep the profile upload page unobstructed while the pipeline interacts with its file input.
  if (/^\/mnjuser\/(profile|login)(\/|$)/i.test(parsed.pathname)) return;

  const token = crypto.randomUUID();
  const panelUrl = new URL(chrome.runtime.getURL('sidepanel.html'));
  panelUrl.searchParams.set('embedded', '1');
  panelUrl.searchParams.set('closeToken', token);
  chrome.scripting.executeScript({
    target: { tabId },
    args: [true, panelUrl.href, token],
    func: (shouldShow, extensionPanelUrl, closeToken) => {
      if (shouldShow && document.getElementById('__menixjobai_dock')) return;
      const oldDock = document.getElementById('__menixjobai_dock');
      oldDock?.__menixCleanup?.();
      oldDock?.remove();
      if (!shouldShow || !document.documentElement) return;
      const dock = document.createElement('div');
      dock.id = '__menixjobai_dock';
      dock.style.cssText = 'position:fixed;inset:0 0 0 auto;width:min(390px,100vw);height:100vh;z-index:2147483647;background:#0b1017;box-shadow:-8px 0 28px #0006;overflow:hidden;';
      const frame = document.createElement('iframe');
      frame.title = 'MenixJobAI'; frame.src = extensionPanelUrl;
      frame.style.cssText = 'width:100%;height:100%;border:0;';
      const onClose = event => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'MENIX_CLOSE_PANEL' || event.data?.token !== closeToken) return;
        dock.__menixCleanup?.();
        dock.remove();
      };
      dock.__menixCleanup = () => window.removeEventListener('message', onClose);
      window.addEventListener('message', onClose);
      dock.append(frame);
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

function showDockOnActiveNaukriTab() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => {
    const tab = tabs[0];
    if (tab?.id && tab.url) showNaukriDock(tab.id, tab.url);
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(showDockOnActiveNaukriTab);
chrome.runtime.onStartup?.addListener(showDockOnActiveNaukriTab);
