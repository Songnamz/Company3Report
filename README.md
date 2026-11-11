# ร้อย3 · ช่องทางแจ้งปัญหา / ข้อเสนอแนะ (self-hosted)

Migrated from Google Apps Script (original server code kept in `reference-Code.gs`).

- Public form: https://message.songnam.xyz/
- Admin: https://message.songnam.xyz/admin
- Cloudflare Tunnel → `http://localhost:8090` → `r3message-nginx` → `r3message-app:3000`

## Layout

| Path | What |
|---|---|
| `server.js` | Node 22 server, no npm dependencies (`node:http` + built-in `node:sqlite`) |
| `views/` | `Index.html`, `Admin.html`, `Styles.html`: the original Apps Script pages, nearly unchanged |
| `public/gas-shim.js` | Makes `google.script.run.fn()` in the pages call `POST /api/fn` |
| `views/Login.html` | Student "log in with LINE" page |
| `data/r3.db` | SQLite database (reports, students, sessions, LINE webhook log) |
| `data/images/` | Uploaded images, served at `/i/<id>` |
| `nginx/default.conf` | Reverse proxy: real client IP from Cloudflare, upload size limit, API rate limit |
| `.env` | Secrets (LINE token, SALT, admin hash). Never commit it |

## Common tasks

```sh
docker compose up -d --build                          # deploy / update after editing files
docker compose logs -f                                # logs (LINE send results show here)
docker compose exec app node server.js set-password 'NEW_PASSWORD'
docker compose exec app node server.js test-line  # send a test card to the LINE group
```

**Backup:** copy the `data/` folder. For a consistent DB copy while the app is running:
`docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/r3.db').exec(\"VACUUM INTO '/data/backup.db'\")"`

## Student login (LINE Login)

Students must log in with LINE before they can upload or submit. The report stores the student's LINE
userId, display name and profile picture at the time of sending. The teacher-group card and the admin page show them.

- Needs a **LINE Login channel** (separate from the Messaging API bot, under the same Provider so userIds match).
- Callback URL in that channel: `https://message.songnam.xyz/auth/callback`
- Put its Channel ID / Channel secret in `.env` (`LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET`), then `docker compose up -d`.
- Routes: `/login` → LINE, `/auth/callback`, `/logout`. Student sessions last `STUDENT_SESSION_DAYS` (default 30).

## Teacher ↔ student chat

- **Teacher → student:** in the teacher group, long-press a report card (or a forwarded student message) → *Reply*.
  The bot pushes the text to the student's 1:1 chat and confirms in the group.
- **Student → teacher:** the student types in their chat with the bot. It's forwarded to the teacher group for their
  most recent report with activity in the last `CHAT_DAYS` days (default 14), or to the report whose bot message they quoted.
- **Admin page:** shows each report's conversation and has a reply box.
- Requires: webhook URL `https://message.songnam.xyz/webhook` on the Messaging API channel, and
  `LINE_CHANNEL_SECRET` = **Messaging API** channel secret. Without the secret, chat is disabled (forged events would
  otherwise let anyone message students as a teacher).
- Students are asked to add the bot as a friend at login (`bot_prompt=aggressive`). That needs the LINE Login channel's
  *Linked LINE Official Account* set to the bot. The bot can't message students who aren't friends or who blocked it.
- Tables: `replies` (conversation), `line_msgs` (LINE message id → report, for matching quote-replies).

## PWA (install on phone)

- `public/manifest.webmanifest` (students, start `/`) and `public/admin.webmanifest` (teachers, start `/admin`).
- `public/sw.js`: pages always come from the network (login state must be fresh), with an offline page as fallback.
  Static files are cache-first; `/api`, login, `/i/` and the webhook bypass it. Bump `VERSION` in `sw.js` when the static files change.
- `public/pwa.js`: registers the service worker; shows an install banner (Android: install button,
  iOS: "Share → Add to Home Screen" hint), hidden in LINE's in-app browser and once installed.
- **Login inside the installed app:** iOS opens LINE Login in an overlay that doesn't share cookies with the app.
  So in standalone mode the button goes to `/login?pwa=1`. After sign-in a 6-digit code is shown (5 min, one-time),
  and the student types it into the app (`pwaRedeem` API). On Android the cookie is shared, so returning to the app is enough.
- Icons in `public/icons/` were generated from `logo.jpg` (navy background, gold ring).
- Cloudflare must **skip** the bot challenge for `/manifest.webmanifest`, `/admin.webmanifest`, `/sw.js`,
  `/offline.html` and `/icons/*`. Install and icon fetches don't carry the challenge cookie.

## LINE

- Notifications are pushed to `LINE_TO` using `LINE_TOKEN`.
- Images are public at unguessable URLs (`LINE_IMAGES=true`) so LINE can display them.
  Set `LINE_IMAGES=false` to make images admin-only.
- Optional webhook: set the channel's webhook URL to `https://message.songnam.xyz/webhook`
  (and `LINE_CHANNEL_SECRET` in `.env`). Events are logged to the `line_log` table, which is
  useful for finding a new groupId.
