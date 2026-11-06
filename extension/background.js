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
      const dockWidth = 360;
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
        [role="dialog"], .modal-container, .modal, .lightbox, [class*="modal-content" i] { max-width: calc(100vw - ${dockWidth}px) !important; }
      `;
      // Only viewport-anchored (position:fixed) drawers must be pushed left of the dock.
      // Absolute/relative drawers already sit inside the narrowed <body>; offsetting them
      // again is what left a dock-sized gap between Naukri's profile card and the panel.
      const drawerSelector = 'div.drawer, [class*="drawer" i], [class*="profile-drawer" i], [class*="user-profile" i], .layer[class*="user" i], .naukri-drawer, div.chatbot_Drawer, [class*="chatbot_Drawer" i], div[class*="drawerRight" i], [class*="rightDrawer" i], [class*="RightDrawer" i]';
      const shiftedDrawers = new Map();
      const unshiftDrawer = element => {
        const saved = shiftedDrawers.get(element);
        if (!saved) return;
        restoreStyles(element, saved);
        shiftedDrawers.delete(element);
      };
      const syncDrawers = () => {
        document.querySelectorAll(drawerSelector).forEach(element => {
          if (element.closest('#__menixjobai_dock')) return;
          // Shift only side panels pinned to the right edge. Full-width fixed overlays/backdrops
          // must keep left/right untouched or they collapse to their content width.
          const isFixed = getComputedStyle(element).position === 'fixed';
          if (!isFixed) { unshiftDrawer(element); return; }
          if (shiftedDrawers.has(element)) return;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.width >= window.innerWidth * 0.8 || rect.right <= window.innerWidth - dockWidth) return;
          shiftedDrawers.set(element, ['left', 'right'].map(property => ({
            property,
            value: element.style.getPropertyValue(property),
            priority: element.style.getPropertyPriority(property)
          })));
          element.style.setProperty('left', 'auto', 'important');
          element.style.setProperty('right', `${dockWidth}px`, 'important');
        });
      };
      let drawerFrame = 0;
      const drawerObserver = new MutationObserver(() => {
        if (drawerFrame) return;
        drawerFrame = requestAnimationFrame(() => { drawerFrame = 0; syncDrawers(); });
      });
      const restoreStyles = (element, styles) => styles.forEach(({ property, value, priority }) => {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      });
      const restorePageLayout = () => {
        restoreStyles(root, originalRootStyles);
        if (body) restoreStyles(body, originalBodyStyles);
        fixedHeaderStyles.forEach(({ element, styles }) => restoreStyles(element, styles));
        drawerObserver.disconnect();
        if (drawerFrame) cancelAnimationFrame(drawerFrame);
        [...shiftedDrawers.keys()].forEach(unshiftDrawer);
        layoutStyle.remove();
      };
      const applyPageLayout = () => {
        if (!layoutStyle.isConnected) document.documentElement.append(layoutStyle);
        if (body) {
          body.style.setProperty('box-sizing', 'border-box', 'important');
          root.style.setProperty('box-sizing', 'border-box', 'important');
          root.style.removeProperty('width');
          root.style.removeProperty('max-width');
          body.style.setProperty('width', 'auto', 'important');
          body.style.setProperty('max-width', `calc(100vw - ${dockWidth}px)`, 'important');
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
        syncDrawers();
        drawerObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      };
      applyPageLayout();
      const dock = document.createElement('div');
      dock.id = '__menixjobai_dock';
      dock.dataset.menixVersion = version;
      dock.style.cssText = `position:fixed !important;top:0 !important;right:0 !important;bottom:0 !important;left:auto !important;width:${dockWidth}px !important;min-width:${dockWidth}px !important;max-width:${dockWidth}px !important;height:100vh !important;z-index:2147483647 !important;background:#0b1017 !important;border:none !important;border-left:1px solid #dbe4f0 !important;box-shadow:-4px 0 20px rgba(0,0,0,0.12) !important;box-sizing:border-box !important;overflow:hidden !important;margin:0 !important;padding:0 !important;transform:none !important;translate:none !important;transition:width 0.2s ease,height 0.2s ease,border-radius 0.2s ease;`;
      const frame = document.createElement('iframe');
      frame.title = 'MenixJobAI'; frame.src = extensionPanelUrl;
      frame.style.cssText = 'position:absolute !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100% !important;height:100% !important;min-width:100% !important;max-width:100% !important;border:none !important;margin:0 !important;padding:0 !important;box-sizing:border-box !important;display:block !important;';

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
          dock.style.setProperty('width', '64px', 'important');
          dock.style.setProperty('min-width', '64px', 'important');
          dock.style.setProperty('max-width', '64px', 'important');
          dock.style.setProperty('height', '64px', 'important');
          dock.style.setProperty('top', '140px', 'important');
          dock.style.setProperty('right', '0', 'important');
          dock.style.setProperty('left', 'auto', 'important');
          dock.style.setProperty('bottom', 'auto', 'important');
          dock.style.setProperty('border-radius', '32px 0 0 32px', 'important');
          dock.style.setProperty('box-shadow', 'none', 'important');
          dock.style.setProperty('background', 'transparent', 'important');
          dock.style.setProperty('border', 'none', 'important');
          dock.style.setProperty('cursor', 'pointer', 'important');
          frame.style.display = 'none';
          expandBtn.style.display = 'flex';
          restorePageLayout();
        } else {
          dock.style.setProperty('width', `${dockWidth}px`, 'important');
          dock.style.setProperty('min-width', `${dockWidth}px`, 'important');
          dock.style.setProperty('max-width', `${dockWidth}px`, 'important');
          dock.style.setProperty('height', '100vh', 'important');
          dock.style.setProperty('top', '0', 'important');
          dock.style.setProperty('right', '0', 'important');
          dock.style.setProperty('left', 'auto', 'important');
          dock.style.setProperty('bottom', '0', 'important');
          dock.style.setProperty('border-radius', '0', 'important');
          dock.style.setProperty('box-shadow', '-4px 0 20px rgba(0,0,0,0.12)', 'important');
          dock.style.setProperty('background', '#0b1017', 'important');
          dock.style.setProperty('border', 'none', 'important');
          dock.style.setProperty('border-left', '1px solid #dbe4f0', 'important');
          dock.style.setProperty('cursor', 'default', 'important');
          expandBtn.style.display = 'none';
          frame.style.display = 'block';
          applyPageLayout();
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
    // Auto-pop ONLY on Naukri job listing pages (https://www.naukri.com/job-listings*)
    const isNaukri = isNaukriJobListingUrl(url);
    if (isNaukri && !manuallyClosedNaukriDocks.has(tabId)) {
      showNaukriDock(tabId, url);
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.get(tabId).then(async tab => {
    if (tab?.id && tab.url) {
      configurePanelForTab(tab.id, tab.url);
      // Auto-pop ONLY on Naukri job listing pages (https://www.naukri.com/job-listings*)
      const isNaukri = isNaukriJobListingUrl(tab.url);
      if (isNaukri && !manuallyClosedNaukriDocks.has(tab.id)) {
        showNaukriDock(tab.id, tab.url);
      }
    }
  }).catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async details => {
  if (details.frameId !== 0 || !details.url) return;
  // Auto-pop ONLY on Naukri job listing pages (https://www.naukri.com/job-listings*)
  const isNaukri = isNaukriJobListingUrl(details.url);
  if (isNaukri) {
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