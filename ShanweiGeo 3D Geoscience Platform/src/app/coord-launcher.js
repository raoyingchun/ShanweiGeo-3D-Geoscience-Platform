// Direct entry for the original COORD program; no coordinate calculation here.
(function () {
  'use strict';
  const entry = document.getElementById('utility-coordinates');
  if (!entry) return;
  let launching = false;
  async function launch() {
    if (launching) return;
    launching = true; entry.setAttribute('aria-busy', 'true');
    try {
      if (!window.electronAPI || !window.electronAPI.openCoordTool) throw new Error('Restart the desktop application before using this tool. ');
      const result = await window.electronAPI.openCoordTool();
      if (!result.ok) throw new Error(result.error || 'COORD Startup failed');
    } catch (error) {
      if (window.showTabModal) window.showTabModal({ title: 'COORD Startup failed', label: error.message });
      else window.alert(error.message);
    } finally { launching = false; entry.removeAttribute('aria-busy'); }
  }
  entry.addEventListener('click', launch);
  entry.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); launch(); }
  });
})();
