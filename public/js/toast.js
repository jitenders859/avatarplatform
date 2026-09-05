/**
 * Shared toast implementation — was copy-pasted verbatim between
 * public/js/api.js's toast() (customer app pages) and
 * public/js/admin/core.js's adminToast() (admin panel). Both now alias
 * this instead of maintaining two copies of the same function.
 */
function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type ? 'toast-' + type : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
