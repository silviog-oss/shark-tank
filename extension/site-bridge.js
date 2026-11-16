// Runs on the Shark Tank website. Relays messages between the page and the extension.
const VERSION = chrome.runtime.getManifest().version;
const hello = () => window.postMessage({ source: 'sharktank-ext', type: 'hello', version: VERSION }, location.origin);

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.source !== 'sharktank-web') return;
  if (e.data.type === 'hello?') return hello();
  if (!e.data.id || !e.data.payload) return;
  chrome.runtime.sendMessage(e.data.payload, (resp) => {
    const fallback = { ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no response from extension' };
    window.postMessage({ source: 'sharktank-ext', id: e.data.id, resp: resp || fallback }, location.origin);
  });
});

hello();
document.addEventListener('DOMContentLoaded', hello);
