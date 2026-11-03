/*
 * web-only.js - browser build adjustments
 *
 * The desktop build can launch the external COORD program through the main
 * process. A browser cannot, so the entry point is removed here rather than
 * in the shared modules: the web build then stays a pure copy of the
 * application code with no divergent edits.
 *
 * Everything else (model parsing, the Python-free backends, the project
 * tree) works unchanged in the browser.
 */
(function () {
  'use strict';

  if (!window.__shanweiGeoIsWeb) return;   // desktop build: do nothing

  // --- remove the COORD launcher -----------------------------------------
  // The entry lives in the right-hand utility rail and opens the external
  // coordinate program, which only exists on Windows with the desktop app.
  const coordEntry = document.getElementById('utility-coordinates');
  if (coordEntry) {
    coordEntry.setAttribute('aria-disabled', 'true');
    coordEntry.classList.add('web-unavailable');
    coordEntry.title = 'The COORD coordinate program is available in the desktop build only';
    // Keep the element in place so the rail layout stays unchanged, but make
    // it inert.
    coordEntry.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (window.showTabModal) {
        window.showTabModal({
          title: 'COORD is not available in the browser build',
          label: 'The coordinate conversion tool launches a separate Windows program and is part of the desktop build only. Everything else works here.'
        });
      }
    }, true);
  }

  // --- note in the console ------------------------------------------------
  console.info('[web] browser build active: the COORD launcher is disabled');
})();
