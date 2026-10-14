/**
 * The pay page at https://<label>.ender.my: the name, a QR and the text of the
 * public address (any wallet), and of the private address when there is one
 * (Ender only). Styled like the app (app/src/lib/theme.ts, ui/kit.tsx). Works
 * without JavaScript; a few inline lines add the copy buttons. Never shows a
 * phone number.
 */
import sigil from '@urbit/sigil-js/core';
import qrcode from 'qrcode-generator';
import { patp } from 'urbit-ob';
import { enderId, NAME_PARENT, validateLabel } from '../../protocol/names';
import type { Env } from './env';
import { byLabel } from './names';

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Dark modules on cream, one path, as the app's QR. */
const qr = (value: string) => {
  const q = qrcode(0, 'M');
  q.addData(value);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n} ${n}" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#F5F1ED"/><path d="${d}" fill="#141411"/></svg>`;
};

const STYLE = `
:root{--bg:#141411;--surface:#1E1D1A;--surface2:#2A2925;--line:rgba(245,241,237,.09);--fg:#F5F1ED;--fg2:rgba(245,241,237,.64);--fg3:rgba(245,241,237,.40);--accent:#CDC971;--accent-press:#B5B15C;--ink:#141411;color-scheme:dark}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:16px/1.4 Geist,system-ui,sans-serif;display:flex;justify-content:center;padding:16px 20px 32px}
main{width:100%;max-width:420px}
.brand{display:inline-flex;align-items:center;gap:10px;font:500 26px/1 Newsreader,Georgia,serif;letter-spacing:-.01em;color:var(--fg);text-decoration:none;margin:0 0 44px}
.brand svg{width:36px;height:36px}
h1{font:500 38px/44px Newsreader,Georgia,serif;letter-spacing:-.4px;margin:0;overflow-wrap:anywhere}
h1 span{color:var(--fg3)}
.meta{color:var(--fg2);margin:10px 0 0}
.profile{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px}
.avatar{width:88px;height:88px;border-radius:50%;display:grid;place-items:center;overflow:hidden;background:var(--surface2);font:500 40px/1 Newsreader,Georgia,serif;color:var(--accent);border:1px solid var(--line)}
.avatar svg{display:block;width:56px;height:56px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:20px;margin-top:44px}
.card>input{position:absolute;opacity:0;pointer-events:none}
.tabs{display:flex;gap:4px;padding:4px;background:var(--bg);border:1px solid var(--line);border-radius:999px}
.tabs label{flex:1;text-align:center;font:600 15px/40px Geist,sans-serif;color:var(--fg2);border-radius:999px;cursor:pointer}
#t-public:checked~.tabs label[for=t-public],#t-private:checked~.tabs label[for=t-private]{background:var(--surface2);color:var(--accent)}
#t-public:focus-visible~.tabs label[for=t-public],#t-private:focus-visible~.tabs label[for=t-private]{outline:2px solid var(--accent)}
#t-public:checked~.private,#t-private:checked~.public{display:none}
.qr{width:216px;margin:20px auto 16px;padding:18px;border-radius:28px;background:var(--fg)}
.qr svg{display:block;width:100%;height:auto}
code{display:block;font:14px/21px 'Geist Mono',ui-monospace,monospace;color:var(--fg);text-align:center;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
button{display:block;width:100%;height:56px;margin-top:16px;border:0;border-radius:999px;background:var(--accent);color:var(--ink);font:600 18px Geist,sans-serif;cursor:pointer}
button:active{background:var(--accent-press)}
button.ghost{background:var(--surface2);color:var(--fg);border:1px solid var(--line)}
.note{color:var(--fg3);font-size:14px;margin:12px 0 0;text-align:center}
`;

/** The Ender mark, as on ender.money (site/public/favicon.svg). */
const MARK = `<svg viewBox="0 0 96 96" aria-hidden="true"><rect x=".5" y=".5" width="95" height="95" rx="30" fill="#1E1D1A" stroke="rgba(245,241,237,.18)"/><g fill="none" stroke="#CDC971" stroke-linecap="round" stroke-linejoin="round"><path d="M26 30h44a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H44l-12 10v-10h-6a4 4 0 0 1-4-4V34a4 4 0 0 1 4-4z" stroke-width="3.5"/><path d="M53 39.5c-1.2-1.6-3-2.5-5-2.5-3 0-5 1.6-5 4s2.2 3.3 5 4 5 1.6 5 4-2 4-5 4c-2.2 0-4-1-5.2-2.6M48 34v3M48 53v3" stroke-width="3"/></g></svg>`;

const page = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#141411">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&family=Newsreader:opsz,wght@6..72,500&display=swap">
<style>${STYLE}</style>
</head>
<body><main>
<a class="brand" href="https://ender.money" aria-label="Ender home">${MARK}<span>Ender</span></a>
${body}
</main>${script}</body>
</html>`;

const COPY = `<script>
for (const b of document.querySelectorAll('button[data-copy]')) {
  b.hidden = false;
  b.onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);
    const t = b.textContent;
    b.textContent = 'Copied';
    setTimeout(() => (b.textContent = t), 1500);
  };
}
</script>`;

const panel = (id: string, value: string, note?: string) => `
<section class="panel ${id}">
  <div class="qr">${qr(value)}</div>
  <code id="${id}">${esc(value)}</code>
  <button type="button" data-copy="${id}" hidden>Copy</button>
  ${note ? `<p class="note">${note}</p>` : ''}
</section>`;

/**
 * The app's avatar (app/src/ui/Sigil.tsx): the Urbit sigil of the planet named by the address's first 32 bits, gold
 * on the disc. The label's first letter if it can't be drawn.
 */
const avatar = (label: string, address: string) => {
  try {
    const n = Number.parseInt(address.slice(2, 10), 16);
    const svg = sigil({ point: patp(n < 0x10000 ? n + 0x10000 : n), size: 56, background: '#2A2925', foreground: '#CDC971', detail: 'none', space: 'none' });
    return `<div class="avatar">${svg}</div>`;
  } catch {
    return `<div class="avatar">${esc(label[0]!.toUpperCase())}</div>`;
  }
};

/**
 * A profile: avatar and name, then Public / Private tabs (radio inputs and CSS, so they work without
 * JavaScript), each a QR, the address and Copy.
 */
export const renderNamePage = (label: string, info: { address: string; private?: string }) => {
  const name = esc(enderId(label));
  const tabs = info.private
    ? `<input type="radio" name="tab" id="t-public" checked><input type="radio" name="tab" id="t-private">
<div class="tabs"><label for="t-public">Public</label><label for="t-private">Private</label></div>`
    : '';
  return page(
    name,
    `<header class="profile">
  ${avatar(label, info.address)}
  <h1>${esc(label)}<span>.ender.my</span></h1>
</header>
<div class="card">
${tabs}
${panel('public', info.address)}
${info.private ? panel('private', info.private, 'Ender app only') : ''}
</div>`,
    COPY,
  );
};

export const renderNotFound = (host: string) =>
  page('Not found', `<h1>${esc(host)}</h1>\n<p class="meta">No one has this Ender ID.</p>`);

/** CSP: our own inline style and script, Google Fonts, nothing else. */
const html = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
    },
  });

/** A request to `<label>.ender.my` (`label`: the host's first part, as typed). An earlier label shows the account's current ID. */
export const payPage = async (env: Env, request: Request, label: string) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  if (new URL(request.url).pathname !== '/') return html(renderNotFound(`${label}.ender.my`), 404);
  const info = validateLabel(label) ? null : await byLabel(env, label);
  const current = info?.name?.slice(0, -`.${NAME_PARENT}`.length) ?? label.toLowerCase();
  return info ? html(renderNamePage(current, info), 200) : html(renderNotFound(`${label.toLowerCase()}.ender.my`), 404);
};
