// Small DOM helpers.

export const byId = id => document.getElementById(id);

/** Set an element's text, skipping the DOM write when nothing changed (used every frame). */
export function setText(id, text) {
  const element = byId(id);
  text = String(text);
  if (element.textContent !== text) element.textContent = text;
}

export function setPressed(button, pressed) {
  button.setAttribute('aria-pressed', pressed);
}

/** Replace a select's options with [value, label] pairs. */
export function replaceOptions(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
}

export function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function focusCanvas() {
  byId('mapCanvas').focus({ preventScroll: true });
}

const TOAST_MS = 3800;
let toastTimer = null;

/** Show a short message at the bottom of the screen. */
export function toast(message) {
  const element = byId('toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), TOAST_MS);
}
