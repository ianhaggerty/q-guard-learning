// Signing in. The API (same site, under /api) says which sign-in methods it offers and who is
// signed in; signing in or out reloads the page, so the room connection starts again as the
// right player. Without the API (it is optional in development) everyone is a guest.

import { byId } from './dom.js';

async function json(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  return response.ok ? response.json() : null;
}

/** Fill in the top bar's account area. Resolves to the signed-in user, or null. */
export async function showAccount() {
  const area = byId('account');
  const [config, me] = await Promise.all([json('/api/auth/config').catch(() => null), json('/api/me').catch(() => null)]);
  if (me?.user) {
    const name = document.createElement('span');
    name.className = 'account-name';
    name.textContent = me.user.name || me.user.login;
    const out = document.createElement('button');
    out.className = 'quiet';
    out.textContent = 'Sign out';
    out.onclick = async () => {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      location.reload();
    };
    area.replaceChildren(name, out);
    return me.user;
  }
  const choices = [];
  if (config?.github) {
    const github = document.createElement('a');
    github.className = 'button';
    github.href = '/api/auth/github';
    github.textContent = 'Sign in with GitHub';
    choices.push(github);
  }
  if (config?.dev) {
    const form = document.createElement('form');
    form.className = 'dev-signin';
    form.innerHTML = '<input name="name" placeholder="dev name" aria-label="Development sign-in name" pattern="[A-Za-z0-9_-]{1,32}" required><button class="button outline">Dev sign-in</button>';
    form.onsubmit = event => {
      event.preventDefault();
      location.href = `/api/auth/dev?name=${encodeURIComponent(form.elements.name.value)}`;
    };
    choices.push(form);
  }
  area.replaceChildren(...choices);
  return null;
}
