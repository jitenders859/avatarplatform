/**
 * Shared marketing-site language switcher + translation runtime.
 *
 * Scope: the public marketing pages only (index, pricing, signup, login,
 * contact, characters, terms, forgot/reset-password) — not the logged-in
 * dashboard/app, not the admin panel, and not the embed widget (which
 * already has its own separate multi-language handling for the AI
 * conversation itself, unrelated to this).
 *
 * Pattern mirrors theme.js: each page's <head> carries a tiny inline
 * anti-flash script (before any stylesheet) that sets
 * html[lang]/html[dir] from localStorage synchronously, so the page never
 * flashes English before switching. This file handles applying
 * translations to the DOM and the switcher UI; the actual strings live in
 * per-language dictionary files (public/js/i18n/<code>.js), each of which
 * assigns into window.I18N_STRINGS[code] — loaded as plain <script> tags
 * (no bundler in this app), so load order is: i18n.js, then every
 * i18n/<code>.js, then this page's own <script> that calls I18N.init().
 *
 * How to add a language:
 *   1. Add an entry to I18N.LANGS below.
 *   2. Create public/js/i18n/<code>.js with the same keys as en.js.
 *   3. Add <script src="/js/i18n/<code>.js"></script> next to the others
 *      on every marketing page.
 *
 * How to add a translatable string to a page:
 *   - Static text: add data-i18n="key" to the element; applyTranslations()
 *     sets its textContent (safe — never innerHTML, so a translation can
 *     never inject markup).
 *   - Text that needs a <br> or similar simple inline markup (a headline
 *     wrapping across lines): use data-i18n-html="key" instead — sets
 *     innerHTML. Only ever use this for strings this app's own dictionary
 *     files author (never for anything derived from user/visitor input),
 *     since unlike data-i18n it does interpret markup.
 *   - An attribute (placeholder, aria-label, title, or a <meta> tag's
 *     content): add data-i18n-attr="attrName:key" (repeatable, comma-
 *     separated for more than one attribute on the same element).
 *   - Add the English string to i18n/en.js under that key, then the same
 *     key to every other language file (missing keys fall back to English
 *     rather than showing blank or a raw key).
 */
const I18N = {
  LANGS: [
    { code: 'en', name: 'English',  flag: '🇺🇸', dir: 'ltr' },
    { code: 'es', name: 'Español',  flag: '🇪🇸', dir: 'ltr' },
    { code: 'fr', name: 'Français', flag: '🇫🇷', dir: 'ltr' },
    { code: 'ar', name: 'العربية',  flag: '🇸🇦', dir: 'rtl' },
    { code: 'hi', name: 'हिन्दी',    flag: '🇮🇳', dir: 'ltr' },
  ],
  DEFAULT: 'en',
  STORAGE_KEY: 'apLang',

  get() {
    const saved = localStorage.getItem(I18N.STORAGE_KEY);
    return I18N.LANGS.some(l => l.code === saved) ? saved : I18N.DEFAULT;
  },

  langInfo(code) {
    return I18N.LANGS.find(l => l.code === code) || I18N.LANGS[0];
  },

  // Called both by the anti-flash inline snippet (before stylesheets, so
  // dir="rtl" is present before first paint) and by set() after a switch.
  applyDocumentAttrs(code) {
    const info = I18N.langInfo(code);
    document.documentElement.lang = info.code;
    document.documentElement.dir = info.dir;
  },

  set(code) {
    if (!I18N.LANGS.some(l => l.code === code)) return;
    localStorage.setItem(I18N.STORAGE_KEY, code);
    I18N.applyDocumentAttrs(code);
    I18N.applyTranslations();
  },

  /** Look up one string. Falls back to English, then to `fallback`/the key itself. */
  t(key, fallback) {
    const dict = window.I18N_STRINGS || {};
    const lang = I18N.get();
    return (dict[lang] && dict[lang][key])
      || (dict[I18N.DEFAULT] && dict[I18N.DEFAULT][key])
      || fallback
      || key;
  },

  applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = I18N.t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = I18N.t(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-attr]').forEach(el => {
      // data-i18n-attr="placeholder:key" or "content:key,title:otherKey"
      for (const pair of el.getAttribute('data-i18n-attr').split(',')) {
        const [attr, key] = pair.split(':').map(s => s.trim());
        if (attr && key) el.setAttribute(attr, I18N.t(key));
      }
    });
  },

  /** Mount the flag dropdown into `container`. Mirrors theme.js's mountThemeToggle shape. */
  init(container) {
    I18N.applyTranslations();
    if (container) mountLangSwitch(container);
  },
};

function mountLangSwitch(container) {
  const wrap = document.createElement('div');
  wrap.className = 'lang-switch';
  wrap.style.position = 'relative';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost btn-sm lang-switch-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.className = 'lang-switch-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  function render() {
    const current = I18N.langInfo(I18N.get());
    btn.innerHTML = '';
    const flagSpan = document.createElement('span');
    flagSpan.textContent = current.flag;
    flagSpan.setAttribute('aria-hidden', 'true');
    btn.appendChild(flagSpan);
    btn.appendChild(document.createTextNode(' ' + current.code.toUpperCase()));
    btn.setAttribute('aria-label', I18N.t('common.selectLanguage', 'Select language') + ': ' + current.name);

    menu.innerHTML = '';
    for (const lang of I18N.LANGS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'lang-switch-item' + (lang.code === current.code ? ' active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(lang.code === current.code));
      item.innerHTML = `<span aria-hidden="true">${lang.flag}</span> <span>${lang.name}</span>`;
      item.addEventListener('click', () => {
        I18N.set(lang.code);
        closeMenu();
        render();
      });
      menu.appendChild(item);
    }
  }

  function openMenu()  { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  function closeMenu() { menu.hidden = true;  btn.setAttribute('aria-expanded', 'false'); }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden ? openMenu() : closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  render();
  wrap.appendChild(btn);
  wrap.appendChild(menu);
  container.appendChild(wrap);
  return wrap;
}
