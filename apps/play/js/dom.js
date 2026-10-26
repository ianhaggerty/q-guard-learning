// Small DOM helpers.

export const byId = id => document.getElementById(id);

let toastTimer = 0;

/** Show a short message at the bottom of the page. */
export function toast(message) {
  const element = byId('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}
