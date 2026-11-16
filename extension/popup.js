document.getElementById('grab').onclick = () => { chrome.tabs.create({ url: SHARKTANK_SITE + '?grab=1' }); window.close(); };
document.getElementById('open').onclick = () => { chrome.tabs.create({ url: SHARKTANK_SITE }); window.close(); };
