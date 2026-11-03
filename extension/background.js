chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
  }
});

chrome.runtime.onStartup?.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);
  }
});

function isNaukriUrl(url) {
  try {
    const host = new URL(url || '').hostname;
    return host === 'naukri.com' || host.endsWith('.naukri.com');
  }
  catch { return false; }
}

function configurePanelForTab(tabId, url) {
  if (!chrome.sidePanel?.setOptions || !tabId) return;
  let parsed;
  try { parsed = new URL(url || ''); } catch { return; }
  const isNaukri = parsed.hostname === 'naukri.com' || parsed.hostname.endsWith('.naukri.com');
  const isLogin = isNaukri && /^\/mnjuser\/login(?:\/|$)/i.test(parsed.pathname);
  // Naukri pages use the in-page dock. Disable the native side panel there so
  // toolbar clicks and automatic opening cannot create two MenixJobAI panels.
  chrome.sidePanel.setOptions({ tabId, enabled: !isNaukri || isLogin, path: 'sidepanel.html' }).catch(() => {});
  if (isNaukri && !isLogin && chrome.sidePanel.close) {
    chrome.tabs.get(tabId).then(tab => {
      if (tab.windowId != null) chrome.sidePanel.close({ windowId: tab.windowId }).catch(() => {});
    }).catch(() => {});
  }
}

chrome.action.onClicked.addListener(tab => {
  if (!tab?.id || !tab.url) return;
  if (isNaukriUrl(tab.url) && !/^\/mnjuser\/login(?:\/|$)/i.test(new URL(tab.url).pathname)) {
    toggleNaukriDock(tab.id, tab.url);
    return;
  }
  if (tab.windowId != null && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(error => console.debug('MenixJobAI side panel could not open:', error));
  }
});

const manuallyClosedNaukriDocks = new Set();

function toggleNaukriDock(tabId, url) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const dock = document.getElementById('__menixjobai_dock');
      if (!dock) return false;
      dock.__menixCleanup?.();
      dock.remove();
      return true;
    }
  }).then(([result]) => {
    if (result?.result) {
      manuallyClosedNaukriDocks.add(tabId);
      return;
    }
    manuallyClosedNaukriDocks.delete(tabId);
    showNaukriDock(tabId, url);
  }).catch(error => console.debug('MenixJobAI could not toggle the Naukri panel:', error));
}

// Naukri job pages may auto-show the extension UI as an in-page dock. Reserve
// room in the page layout so the dock does not cover job content.
function showNaukriDock(tabId, url, forceRefresh = false) {
  let parsed;
  try { parsed = new URL(url || ''); } catch { return; }
  if (parsed.hostname !== 'naukri.com' && !parsed.hostname.endsWith('.naukri.com')) return;
  configurePanelForTab(tabId, url);
  // Keep the login unobstructed; open the panel on the profile so the user can manage resume upload.
  if (/^\/mnjuser\/login(\/|$)/i.test(parsed.pathname)) return;

  const token = crypto.randomUUID();
  const dockVersion = chrome.runtime.getManifest().version;
  const panelUrl = new URL(chrome.runtime.getURL('sidepanel.html'));
  panelUrl.searchParams.set('embedded', '1');
  panelUrl.searchParams.set('closeToken', token);
  chrome.scripting.executeScript({
    target: { tabId },
    args: [true, panelUrl.href, token, dockVersion, forceRefresh],
    func: (shouldShow, extensionPanelUrl, closeToken, version, refresh) => {
      const oldDock = document.getElementById('__menixjobai_dock');
      // Keep the existing iframe alive across tab activation and SPA navigation.
      // Recreating it discards its in-memory analysis while the user visits Profile.
      if (shouldShow && oldDock?.dataset.menixVersion === version && !refresh) return;
      oldDock?.__menixCleanup?.();
      oldDock?.remove();
      if (!shouldShow || !document.documentElement) return;
      const root = document.documentElement;
      const body = document.body;
      // Keep the dock compact and explicitly reduce the page content width.
      // A right margin alone does not shrink Naukri's 100%-wide app shell.
      const dockWidth = Math.min(360, Math.max(280, Math.floor(window.innerWidth * 0.32)));
      const originalRootStyles = ['width', 'max-width', 'overflow-x', 'padding-right', 'box-sizing'].map(property => ({
        property,
        value: root.style.getPropertyValue(property),
        priority: root.style.getPropertyPriority(property)
      }));
      const originalBodyStyles = body ? ['width', 'max-width', 'min-width', 'overflow-x', 'margin-left', 'margin-right', 'box-sizing'].map(property => ({
        property,
        value: body.style.getPropertyValue(property),
        priority: body.style.getPropertyPriority(property)
      })) : [];
      const layoutStyle = document.createElement('style');
      layoutStyle.id = '__menixjobai_layout_fix';
      layoutStyle.textContent = `html{width:calc(100vw - ${dockWidth}px)!important;max-width:calc(100vw - ${dockWidth}px)!important;overflow-x:hidden!important}body{width:100%!important;max-width:100%!important;min-width:0!important;overflow-x:hidden!important}body > *:not(#__menixjobai_dock){box-sizing:border-box!important;width:100%!important;max-width:100%!important;min-width:0!important}body > *:not(#__menixjobai_dock) *{min-width:0!important}`;
      document.documentElement.append(layoutStyle);
      const restoreStyles = (element, styles) => styles.forEach(({ property, value, priority }) => {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      });
      const restorePageLayout = () => {
        restoreStyles(root, originalRootStyles);
        if (body) restoreStyles(body, originalBodyStyles);
        layoutStyle.remove();
      };
      if (body) {
        // Force a narrower page layout so Naukri's full-width content reflows
        // into the space beside the dock rather than continuing underneath it.
        body.style.setProperty('box-sizing', 'border-box', 'important');
        root.style.setProperty('box-sizing', 'border-box', 'important');
        root.style.setProperty('width', `calc(100vw - ${dockWidth}px)`, 'important');
        root.style.setProperty('max-width', `calc(100vw - ${dockWidth}px)`, 'important');
        body.style.setProperty('width', '100%', 'important');
        body.style.setProperty('max-width', '100%', 'important');
        body.style.setProperty('min-width', '0', 'important');
        body.style.setProperty('overflow-x', 'hidden', 'important');
        body.style.setProperty('margin-left', '0', 'important');
        body.style.setProperty('margin-right', '0', 'important');
      } else {
        const existingPadding = getComputedStyle(root).paddingRight || '0px';
        root.style.setProperty('box-sizing', 'border-box', 'important');
        root.style.setProperty('padding-right', `calc(${existingPadding} + ${dockWidth}px)`, 'important');
      }
      const dock = document.createElement('div');
      dock.id = '__menixjobai_dock';
      dock.dataset.menixVersion = version;
      dock.style.cssText = `position:fixed;top:0;right:0;bottom:0;width:${dockWidth}px;height:100vh;z-index:2147483647;background:#0b1017;box-shadow:-8px 0 28px #0006;overflow:hidden;`;
      const frame = document.createElement('iframe');
      frame.title = 'MenixJobAI'; frame.src = extensionPanelUrl;
      frame.style.cssText = 'width:100%;height:100%;border:0;';
      const onClose = event => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'MENIX_CLOSE_PANEL' || event.data?.token !== closeToken) return;
        dock.__menixCleanup?.();
        dock.remove();
      };
      dock.__menixCleanup = () => {
        window.removeEventListener('message', onClose);
        restorePageLayout();
      };
      window.addEventListener('message', onClose);
      dock.append(frame);
      document.documentElement.append(dock);
    }
  }).catch(error => console.debug('MenixJobAI could not show the Naukri panel:', error));
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (changeInfo.url) manuallyClosedNaukriDocks.delete(tabId);
  if (url) configurePanelForTab(tabId, url);
  if ((changeInfo.status === 'complete' || changeInfo.url) && url && /(^|\.)naukri\.com\//i.test(url.replace(/^https?:\/\//i, ''))) {
    if (!manuallyClosedNaukriDocks.has(tabId)) showNaukriDock(tabId, url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => {
    if (tab?.id && tab.url) {
      configurePanelForTab(tab.id, tab.url);
      if (!manuallyClosedNaukriDocks.has(tab.id)) showNaukriDock(tab.id, tab.url);
    }
  }).catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  manuallyClosedNaukriDocks.delete(details.tabId);
  showNaukriDock(details.tabId, details.url);
});

function showDockOnActiveNaukriTab(forceRefresh = false) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => {
    const tab = tabs[0];
    if (tab?.id && tab.url) showNaukriDock(tab.id, tab.url, forceRefresh);
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => showDockOnActiveNaukriTab(true));
chrome.runtime.onStartup?.addListener(() => showDockOnActiveNaukriTab(true));
