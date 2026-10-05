# ender.money landing page

Static page in `public/` served by Workers static assets; `src/worker.ts` only handles `POST /api/waitlist`
(email only, plus a honeypot). Sign-ups go to their own D1 database, `ender-waitlist`.

```
public/        index.html, site.css, waitlist.js, favicon.svg, apple-touch-icon.png, og.png, _headers (security headers)
src/worker.ts  the waitlist API
migrations/    D1 schema
wrangler.jsonc Worker "ender-site"
```

## Local

```sh
bun run site:migrate:local   # once: creates the local D1 table
bun run site:dev             # http://localhost:8787
bun test site/               # handler tests (D1 stand-in on bun:sqlite)
```

## Deploy (run from the repo root)

1. Create the database and paste the printed `database_id` into `site/wrangler.jsonc` (replace `REPLACE_WITH_ENDER_WAITLIST_ID`):
   ```sh
   bunx wrangler d1 create ender-waitlist
   ```
2. Apply the schema: `bun run site:migrate:remote`
3. Deploy: `bun run site:deploy`
4. DNS (Cloudflare dashboard, zone ender.money). Routes only fire on proxied hostnames:
   - `ender.money`: the gateway's assetlinks route already needs a proxied record here; keep it. If there is none, add `AAAA ender.money 100::` (proxied).
   - `www`: add `AAAA www 100::` (proxied), or a proxied `CNAME www ender.money`.
5. Check:
   ```sh
   curl -sI https://ender.money/ | head -1                               # 200, from ender-site
   curl -s https://ender.money/.well-known/assetlinks.json | head -c 80  # still the gateway's JSON
   curl -s -X POST https://ender.money/api/waitlist -H 'content-type: application/json' -d '{"email":"you@example.com"}'
   ```

### Routes and the gateway

The site uses zone routes `ender.money/*` and `www.ender.money/*`. The gateway (`gateway/wrangler.jsonc`) keeps
`ender.money/.well-known/assetlinks.json` (zone route) and `api.ender.money` (custom domain). When several routes
match, Cloudflare picks the most specific pattern, so the gateway's exact assetlinks path wins over `ender.money/*`
and passkeys keep working. Don't switch the site to a custom domain on `ender.money`: a custom domain wants to own the
hostname's DNS record.

Optional: redirect `www` to the apex with a Cloudflare Redirect Rule (`www.ender.money/*` → `https://ender.money/${1}`, 301). The page's canonical link already points at the apex.

## Reading the list

```sh
bunx wrangler d1 execute ender-waitlist --remote -c site/wrangler.jsonc --command "SELECT email, datetime(created_at, 'unixepoch') FROM waitlist ORDER BY id"
```

## Optional: Cloudflare Turnstile

Off by default. To turn it on:

1. Create a Turnstile widget for `ender.money` and `www.ender.money` in the dashboard.
2. Put the **site key** in `public/index.html`: `<div id="wl-captcha" data-sitekey="...">`.
3. Set the **secret**: `bunx wrangler secret put TURNSTILE_SECRET -c site/wrangler.jsonc`
4. `bun run site:deploy`

With the secret set, the Worker rejects sign-ups without a valid token (`403 {"error":"captcha"}`). The CSP in `public/_headers` already allows `challenges.cloudflare.com`. To turn it off, delete the secret and clear the site key.

## API

`POST /api/waitlist`, `content-type: application/json`, body `{"email": "..."}` (≤ 4 KB).

| Response | When |
| --- | --- |
| `200 {"ok":true}` | stored, already on the list, or honeypot (`website`) filled. Nothing is echoed back. |
| `400 {"ok":false,"error":"email"}` | not an email address |
| `403 … "captcha"` | Turnstile on and the token is missing or invalid |
| `415 / 400 / 413 … "bad-request"` | not JSON, malformed, or too big |
| `429 … "rate-limited"` | over 5 requests a minute from one IP (`WAITLIST_LIMITER`) |
