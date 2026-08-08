/**
 * Shared light/dark theme toggle.
 *
 * Each page's <head> carries a tiny inline anti-flash script (before any
 * stylesheet) that sets html[data-theme] from localStorage synchronously,
 * so the correct theme is already applied by the time this file loads.
 * This file only handles toggling + persisting after that.
 */
const Theme = {
  get: () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  set(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('apTheme', t);
  },
  toggle() {
    Theme.set(Theme.get() === 'dark' ? 'light' : 'dark');
  },
};

// Creates a toggle button, appends it to `container`, and wires it up.
// Returns the button element in case a caller wants to reposition it.
function mountThemeToggle(container) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost btn-sm theme-toggle';
  btn.setAttribute('aria-label', 'Toggle light/dark theme');
  const render = () => { btn.textContent = Theme.get() === 'dark' ? '☀️' : '🌙'; };
  render();
  btn.addEventListener('click', () => { Theme.toggle(); render(); });
  container.appendChild(btn);
  return btn;
}
