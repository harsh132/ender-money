// Waitlist form: POST JSON to /api/waitlist, show the result inline.
(() => {
  const form = document.getElementById('wl');
  const status = document.getElementById('wl-status');
  const button = form.querySelector('button');
  const email = form.elements.email;
  const emailErr = document.getElementById('wl-email-err');
  const captcha = document.getElementById('wl-captcha');

  // Turnstile only when a site key is set in the page.
  if (captcha.dataset.sitekey) {
    captcha.className = 'cf-turnstile';
    captcha.dataset.theme = 'dark';
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true;
    document.head.append(s);
  }

  const badEmail = (on) => {
    email.setAttribute('aria-invalid', on ? 'true' : 'false');
    emailErr.hidden = !on;
    if (on) email.focus();
  };

  const messages = {
    'rate-limited': 'Too many tries. Wait a minute and try again.',
    captcha: 'Please complete the check above and try again.',
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = '';
    badEmail(false);
    if (!email.value.trim() || !email.checkValidity()) return badEmail(true);

    const data = Object.fromEntries(new FormData(form));
    button.disabled = true;
    button.textContent = 'Joining…';
    try {
      const res = await fetch('/api/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        document.getElementById('wl-form-wrap').hidden = true;
        const done = document.getElementById('wl-done');
        done.hidden = false;
        done.focus();
        return;
      }
      if (body.error === 'email') badEmail(true);
      else status.textContent = messages[body.error] ?? 'Something went wrong. Try again in a moment.';
      if (window.turnstile) window.turnstile.reset();
    } catch {
      status.textContent = "Couldn't reach Ender. Check your connection and try again.";
    } finally {
      button.disabled = false;
      button.textContent = 'Join the waitlist';
    }
  });
})();
