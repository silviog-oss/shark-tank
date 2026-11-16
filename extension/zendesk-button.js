// Adds a floating "🦈 Grab" button to Zendesk agent pages.
(() => {
  if (document.getElementById('sharktank-grab')) return;
  const b = document.createElement('button');
  b.id = 'sharktank-grab';
  b.textContent = '🦈 Grab ticket';
  b.title = 'Grab the next Shark Tank ticket';
  Object.assign(b.style, {
    position: 'fixed', left: '76px', bottom: '18px', zIndex: 2147483000,
    background: '#0b6e99', color: '#fff', border: '0', borderRadius: '22px',
    padding: '10px 16px', font: '600 14px system-ui, sans-serif', cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0,0,0,.25)',
  });
  b.onmouseenter = () => (b.style.background = '#08506f');
  b.onmouseleave = () => (b.style.background = '#0b6e99');
  b.onclick = () => window.open(SHARKTANK_SITE + '?grab=1', 'sharktank');
  document.body.appendChild(b);
})();
