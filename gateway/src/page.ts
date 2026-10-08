/**
 * The pay page at https://<label>.ender.my: the name, a QR and the text of the
 * public address (any wallet), and of the private address when there is one
 * (Ender only). Styled like the app (app/src/lib/theme.ts, ui/kit.tsx). Works
 * without JavaScript; a few inline lines add the copy buttons. Never shows a
 * phone number.
 */
import qrcode from 'qrcode-generator';
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
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:16px/1.4 Geist,system-ui,sans-serif;display:flex;justify-content:center;padding:40px 20px 32px}
main{width:100%;max-width:420px}
.brand{font:500 22px/1 Newsreader,Georgia,serif;color:var(--fg2);margin:0 0 28px}
h1{font:500 38px/44px Newsreader,Georgia,serif;letter-spacing:-.4px;margin:0;overflow-wrap:anywhere}
h1 span{color:var(--fg3)}
.meta{color:var(--fg2);margin:10px 0 0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:20px;margin-top:20px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.head b{font-weight:600;font-size:18px}
.pill{font:500 14px/20px Geist,sans-serif;color:var(--fg2);border:1px solid var(--line);background:var(--surface2);border-radius:999px;padding:4px 12px}
.qr{width:216px;margin:20px auto 16px;padding:18px;border-radius:28px;background:var(--fg)}
.qr svg{display:block;width:100%;height:auto}
code{display:block;font:14px/21px 'Geist Mono',ui-monospace,monospace;color:var(--fg);text-align:center;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
button{display:block;width:100%;height:56px;margin-top:16px;border:0;border-radius:999px;background:var(--accent);color:var(--ink);font:600 18px Geist,sans-serif;cursor:pointer}
button:active{background:var(--accent-press)}
button.ghost{background:var(--surface2);color:var(--fg);border:1px solid var(--line)}
.note{color:var(--fg3);font-size:14px;margin:12px 0 0;text-align:center}
.foot{color:var(--fg3);font-size:14px;text-align:center;margin-top:28px}
.foot a{color:var(--accent);text-decoration:none}
`;

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
<p class="brand">Ender</p>
${body}
<p class="foot">Pay by text with <a href="https://ender.money">Ender</a></p>
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

const card = (id: string, title: string, pill: string, value: string, note: string, primary: boolean) => `
<section class="card">
  <div class="head"><b>${title}</b><span class="pill">${pill}</span></div>
  <div class="qr">${qr(value)}</div>
  <code id="${id}">${esc(value)}</code>
  <button type="button" data-copy="${id}" class="${primary ? '' : 'ghost'}" hidden>Copy</button>
  <p class="note">${note}</p>
</section>`;

export const renderNamePage = (label: string, info: { address: string; private?: string }) => {
  const name = esc(enderId(label));
  return page(
    name,
    `<h1>${esc(label)}<span>.ender.my</span></h1>
<p class="meta">Pay with any wallet: send AUSD on Monad to this address. Wallets that read ENS names can pay ${name} directly.</p>
${card('public', 'Public address', 'Monad', info.address, 'Payments here are public on Monad.', true)}
${info.private ? card('private', 'Private address', 'Ender only', info.private, 'Takes private payments from the Ender app only.', false) : ''}`,
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
