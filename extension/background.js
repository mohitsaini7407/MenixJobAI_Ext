function isNaukriJobListingUrl(url) {
  try {
    const parsed = new URL(url || '');
    const isNaukri = parsed.hostname === 'naukri.com' || parsed.hostname.endsWith('.naukri.com');
    if (!isNaukri) return false;
    // Auto-pop ONLY on job listing URLs (e.g. /job-listings-...)
    return /^\/job-listings/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

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
  if (isNaukri && !isLogin && chrome.sidePanel.close && Number.isInteger(tabId)) {
    chrome.tabs.get(tabId).then(tab => {
      if (tab.windowId != null) chrome.sidePanel.close({ windowId: tab.windowId }).catch(() => {});
    }).catch(() => {});
  }
}

chrome.action.onClicked.addListener(tab => {
  if (!tab?.id || !tab.url) return;
  try {
    const parsed = new URL(tab.url);
    if (['http:', 'https:'].includes(parsed.protocol)) {
      toggleNaukriDock(tab.id, tab.url);
      return;
    }
  } catch {}
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
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  // Don't show dock on chrome internal or restricted extension pages
  if (/^(?:chrome|edge|brave|about):/i.test(parsed.protocol)) return;
  configurePanelForTab(tabId, url);
  // Keep the login unobstructed; open the panel on the profile so the user can manage resume upload.
  if (/^\/mnjuser\/login(\/|$)/i.test(parsed.pathname)) return;

  const token = crypto.randomUUID();
  const dockVersion = chrome.runtime.getManifest().version;
  const panelUrl = new URL(chrome.runtime.getURL('sidepanel.html'));
  panelUrl.searchParams.set('embedded', '1');
  panelUrl.searchParams.set('closeToken', token);
  panelUrl.searchParams.set('tabId', String(tabId));
  chrome.scripting.executeScript({
    target: { tabId },
    args: [true, panelUrl.href, token, dockVersion, forceRefresh, chrome.runtime.getURL('icons/icon48.png')],
    func: (shouldShow, extensionPanelUrl, closeToken, version, refresh, iconUrl) => {
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
      const originalRootStyles = ['width', 'max-width', 'margin-left', 'overflow-x', 'padding-left', 'padding-right', 'box-sizing'].map(property => ({
        property,
        value: root.style.getPropertyValue(property),
        priority: root.style.getPropertyPriority(property)
      }));
      const originalBodyStyles = body ? ['width', 'max-width', 'min-width', 'overflow-x', 'margin-left', 'margin-right', 'box-sizing'].map(property => ({
        property,
        value: body.style.getPropertyValue(property),
        priority: body.style.getPropertyPriority(property)
      })) : [];
      const availablePageWidth = window.innerWidth - dockWidth;
      const fixedHeaderStyles = [...document.querySelectorAll('header,[role="banner"]')]
        .filter(element => {
          const bounds = element.getBoundingClientRect();
          const position = getComputedStyle(element).position;
          return (position === 'fixed' || position === 'sticky') && bounds.top < 160 && bounds.width > availablePageWidth;
        })
        .map(element => ({
          element,
          styles: ['left', 'right', 'width', 'max-width', 'box-sizing'].map(property => ({
            property,
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property)
          }))
        }));
      const layoutStyle = document.createElement('style');
      layoutStyle.id = '__menixjobai_layout_fix';
      layoutStyle.textContent = `
        html { overflow-x: hidden !important; }
        body { width: auto !important; max-width: calc(100vw - ${dockWidth}px) !important; margin-right: ${dockWidth}px !important; margin-left: 0 !important; box-sizing: border-box !important; overflow-x: hidden !important; }
        /* keep page layout natural without squishing navbar */
        /* no universal min-width override */
        div.drawer, [class*="drawer" i], [class*="nI-gNb-drawer" i], [class*="profile-drawer" i], [class*="user-profile" i], .layer[class*="user" i], .naukri-drawer, div.chatbot_Drawer, [class*="chatbot_Drawer" i], div[class*="drawerRight" i], div[class*="rightDrawer" i], div[class*="RightDrawer" i] { right: ${dockWidth}px !important; z-index: 100000 !important; }
        [role="dialog"], .modal-container, .modal, .lightbox, [class*="modal-content" i] { z-index: 100000 !important; max-width: calc(100vw - ${dockWidth}px) !important; }
      `;
      document.documentElement.append(layoutStyle);
      const restoreStyles = (element, styles) => styles.forEach(({ property, value, priority }) => {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      });
      const restorePageLayout = () => {
        restoreStyles(root, originalRootStyles);
        if (body) restoreStyles(body, originalBodyStyles);
        fixedHeaderStyles.forEach(({ element, styles }) => restoreStyles(element, styles));
        layoutStyle.remove();
      };
      if (body) {
        // Keep page content beside the right dock
        body.style.setProperty('box-sizing', 'border-box', 'important');
        root.style.setProperty('box-sizing', 'border-box', 'important');
        root.style.removeProperty('width');
        root.style.removeProperty('max-width');
        body.style.setProperty('width', 'auto', 'important');
        body.style.setProperty('max-width', '100%', 'important');
        body.style.setProperty('min-width', '0', 'important');
        body.style.setProperty('overflow-x', 'hidden', 'important');
        body.style.setProperty('margin-left', '0', 'important');
        body.style.setProperty('margin-right', `${dockWidth}px`, 'important');
        fixedHeaderStyles.forEach(({ element }) => {
          element.style.setProperty('left', '0', 'important');
          element.style.setProperty('right', `${dockWidth}px`, 'important');
          element.style.setProperty('width', `calc(100vw - ${dockWidth}px)`, 'important');
          element.style.setProperty('max-width', `${availablePageWidth}px`, 'important');
          element.style.setProperty('box-sizing', 'border-box', 'important');
        });
      } else {
        const existingPadding = getComputedStyle(root).paddingRight || '0px';
        root.style.setProperty('box-sizing', 'border-box', 'important');
        root.style.setProperty('padding-right', `calc(${existingPadding} + ${dockWidth}px)`, 'important');
      }
      const dock = document.createElement('div');
      dock.id = '__menixjobai_dock';
      dock.dataset.menixVersion = version;
      dock.style.cssText = `position:fixed;top:0;right:0;bottom:0;width:${dockWidth}px;height:100vh;z-index:9999;background:#0b1017;border-left:1px solid #dbe4f0;overflow:hidden;transition:width 0.2s ease,height 0.2s ease,border-radius 0.2s ease;`;
      const frame = document.createElement('iframe');
      frame.title = 'MenixJobAI'; frame.src = extensionPanelUrl;
      frame.style.cssText = 'width:100%;height:100%;border:0;';

      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.id = '__menixjobai_expand_btn';
      expandBtn.setAttribute('aria-label', 'Open MenixJobAI');
      expandBtn.title = 'Click to open MenixJobAI';
      expandBtn.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:none;align-items:center;justify-content:center;cursor:pointer;background:#ffffff;border-radius:32px 0 0 32px;box-shadow:-4px 6px 24px rgba(0,0,0,0.3), 0 0 0 2px rgba(37,99,235,0.25);padding:0;outline:none;z-index:2147483647;transition:transform 0.15s ease,box-shadow 0.15s ease;';
      expandBtn.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#1d4ed8);box-shadow:0 3px 10px rgba(37,99,235,0.4);margin-left:6px;pointer-events:none;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 19V5L12 13L20 5V19" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
      expandBtn.onmouseenter = () => { expandBtn.style.transform = 'translateX(-4px)'; expandBtn.style.boxShadow = '-6px 8px 28px rgba(0,0,0,0.35), 0 0 0 2.5px rgba(37,99,235,0.4)'; };
      expandBtn.onmouseleave = () => { expandBtn.style.transform = 'none'; expandBtn.style.boxShadow = '-4px 6px 24px rgba(0,0,0,0.3), 0 0 0 2px rgba(37,99,235,0.25)'; };

      let isCollapsed = false;
      const toggleCollapse = () => {
        isCollapsed = !isCollapsed;
        if (isCollapsed) {
          dock.style.width = '64px';
          dock.style.height = '64px';
          dock.style.top = '140px';
          dock.style.right = '0';
          dock.style.left = 'auto';
          dock.style.bottom = 'auto';
          dock.style.borderRadius = '32px 0 0 32px';
          dock.style.boxShadow = 'none';
          dock.style.background = 'transparent';
          dock.style.border = 'none';
          dock.style.cursor = 'pointer';
          frame.style.display = 'none';
          expandBtn.style.display = 'flex';
          restorePageLayout();
        } else {
          dock.style.width = `${dockWidth}px`;
          dock.style.height = '100vh';
          dock.style.top = '0';
          dock.style.right = '0';
          dock.style.left = 'auto';
          dock.style.bottom = '0';
          dock.style.borderRadius = '0';
          dock.style.boxShadow = 'none';
          dock.style.background = '#0b1017';
          dock.style.borderLeft = '1px solid #dbe4f0';
          dock.style.borderRight = 'none';
          dock.style.cursor = 'default';
          expandBtn.style.display = 'none';
          frame.style.display = 'block';
          if (body) {
            body.style.setProperty('width', `calc(100vw - ${dockWidth}px)`, 'important');
            root.style.removeProperty('width');
          }
        }
      };

      const handleExpand = (e) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        if (isCollapsed) toggleCollapse();
      };
      expandBtn.addEventListener('click', handleExpand);
      expandBtn.addEventListener('pointerdown', handleExpand);
      expandBtn.addEventListener('mousedown', handleExpand);
      expandBtn.addEventListener('touchstart', handleExpand, { passive: false });

      const onMessage = event => {
        if (event.source !== frame.contentWindow) return;
        if (event.data?.type === 'MENIX_CLOSE_PANEL' && event.data?.token === closeToken) {
          dock.__menixCleanup?.();
          dock.remove();
        }
        if (event.data?.type === 'MENIX_MINIMIZE_PANEL' && event.data?.token === closeToken) {
          if (!isCollapsed) toggleCollapse();
        }
        if (event.data?.type === 'MENIX_EXPAND_PANEL' && event.data?.token === closeToken) {
          if (isCollapsed) toggleCollapse();
        }
      };
      dock.__menixCleanup = () => {
        window.removeEventListener('message', onMessage);
        restorePageLayout();
      };
      window.addEventListener('message', onMessage);
      dock.addEventListener('click', handleExpand);
      dock.addEventListener('pointerdown', handleExpand);
      dock.append(frame);
      dock.append(expandBtn);
      document.documentElement.append(dock);
    }
  }).catch(error => console.debug('MenixJobAI could not show the Naukri panel:', error));
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab?.url;
  if (changeInfo.url) manuallyClosedNaukriDocks.delete(tabId);
  if (url) configurePanelForTab(tabId, url);
  if ((changeInfo.status === 'complete' || changeInfo.url) && url) {
    const isNaukri = isNaukriJobListingUrl(url);
    // Only auto-open on Naukri, or on the specific company application tab of an active workflow
    let isCompanyAppTab = false;
    try {
      const stored = await chrome.storage.local.get(['activeResumeJobKey', 'resumeWorkflows']);
      const workflow = (stored.resumeWorkflows || []).find(w => w.jobKey === stored.activeResumeJobKey);
      isCompanyAppTab = Boolean(workflow && workflow.status === 'APPLICATION_IN_PROGRESS' && workflow.companyApplicationTabId === tabId);
    } catch {}

    if ((isNaukri || isCompanyAppTab) && !manuallyClosedNaukriDocks.has(tabId)) {
      showNaukriDock(tabId, url);
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.get(tabId).then(async tab => {
    if (tab?.id && tab.url) {
      configurePanelForTab(tab.id, tab.url);
      const isNaukri = isNaukriJobListingUrl(tab.url);
      let isCompanyAppTab = false;
      try {
        const stored = await chrome.storage.local.get(['activeResumeJobKey', 'resumeWorkflows']);
        const workflow = (stored.resumeWorkflows || []).find(w => w.jobKey === stored.activeResumeJobKey);
        isCompanyAppTab = Boolean(workflow && workflow.status === 'APPLICATION_IN_PROGRESS' && workflow.companyApplicationTabId === tab.id);
      } catch {}

      if ((isNaukri || isCompanyAppTab) && !manuallyClosedNaukriDocks.has(tab.id)) {
        showNaukriDock(tab.id, tab.url);
      }
    }
  }).catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async details => {
  if (details.frameId !== 0 || !details.url) return;
  const isNaukri = isNaukriJobListingUrl(details.url);
  let isCompanyAppTab = false;
  try {
    const stored = await chrome.storage.local.get(['activeResumeJobKey', 'resumeWorkflows']);
    const workflow = (stored.resumeWorkflows || []).find(w => w.jobKey === stored.activeResumeJobKey);
    isCompanyAppTab = Boolean(workflow && workflow.status === 'APPLICATION_IN_PROGRESS' && workflow.companyApplicationTabId === details.tabId);
  } catch {}

  if (isNaukri || isCompanyAppTab) {
    manuallyClosedNaukriDocks.delete(details.tabId);
    showNaukriDock(details.tabId, details.url);
  }
});

function showDockOnActiveNaukriTab(forceRefresh = false) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => {
    const tab = tabs[0];
    if (tab?.id && tab.url && isNaukriJobListingUrl(tab.url)) showNaukriDock(tab.id, tab.url, forceRefresh);
  }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => showDockOnActiveNaukriTab(true));
chrome.runtime.onStartup?.addListener(() => showDockOnActiveNaukriTab(true));
