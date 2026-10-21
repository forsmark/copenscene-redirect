# copenscene-redirect

Forwards `copenscene.rocks` to where CopenScene is served, keeping the path.
GitHub Pages holds the certificate for the domain. See ADR 0013 and the
`site-availability` spec in `forsmark/copenscene`.

Before it forwards, the page reads `status.json` and then asks the site's
`/api/health`, within 3 seconds:

- `{"maintenance": true}` shows *CopenScene is down for maintenance. Back soon, after a quick
  changeover.* and does
  not forward. `scripts/site-status.mjs maintenance on|off` in
  `forsmark/copenscene` switches it.
- A health check that fails or answers anything but 200 shows *CopenScene
  isn't answering right now. Check again in a few minutes.*, with a button that
  checks again.
- A browser without script goes to the site's front page after a second.

`index.html` and `404.html` are the same page: Pages answers every path it has
no file for with `404.html`. `fonts/` holds a copy of the site's Archivo, so the
pages look like CopenScene while the site is down.

To move the site, change the address in both pages. The new host must answer
`/api/health` with `Access-Control-Allow-Origin: https://copenscene.rocks`, or
the page cannot read the check and shows the downtime page.

Test the page with `node --test`. It needs nothing installed.
