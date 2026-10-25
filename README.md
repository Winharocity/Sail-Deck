# SailDeck

A self-hosted operating system for a sailing centre. One small container, no external services, data stays on your server.

| Area | What it does |
|---|---|
| **Safety board** | Live "on the water" board with countdown timers. Boats go out and come back with helm, crew count, destination and expected return. Overdue boats turn red and pulse. People-afloat count at a glance. |
| **Flag & conditions** | Log flag colour, wind, gusts, tide. A **red flag blocks new launches** unless a duty manager records an override reason (kept in the audit log). Warns when the reading is over 3 hours old. |
| **Fleet** | Dinghies, keelboats, RIBs, kayaks, SUPs. Defect reporting with severity; a **critical defect takes the boat out of service automatically** and it can't be signed out until resolved. Damage can be reported at sign-in. |
| **Bookings** | Hire, lessons, courses, racing. **Double-booking a boat is rejected.** |
| **People** | Members, students, instructors, volunteers: qualifications, emergency contact, **first-aid and membership expiry** with 30-day warnings on the board. |
| **Incident book** | Near misses through serious incidents with injuries, actions and status. CSV export for insurers and governing bodies. |
| **Admin** | Users (admin / staff), audit log, CSV exports, one-click consistent database backup. |

Stack: Node 22 (built-in SQLite, zero npm dependencies), vanilla JS front end. Works on a phone at the slipway.

## Deploy on Portainer

### Option A: Git repository stack (recommended)
1. Push this folder to a Git repo (GitHub, Gitea, GitLab, etc.).
2. Portainer > **Stacks > Add stack > Repository**. Enter the repo URL and compose path `docker-compose.yml`.
3. Under **Environment variables** add:
   - `ADMIN_PASSWORD` (required) - password for the first `admin` login
   - `CENTRE_NAME` - e.g. `Lakeside Sailing Club`
   - `TZ` - e.g. `Australia/Brisbane`
   - `SAILDECK_PORT` - host port, default `3000`
   - `SEED_DEMO` - `true` to load sample boats and people while you try it out
4. Tick **Re-pull image and redeploy** if offered, then **Deploy the stack**. Portainer builds the image from the Dockerfile.

### Option B: build on the Docker host, paste the compose file
1. Copy this folder to the host and run `docker build -t saildeck:latest .` in it (Portainer can also do this under **Images > Build a new image** by uploading the folder as a tar archive).
2. Portainer > **Stacks > Add stack > Web editor**, paste `docker-compose.yml` (the `build:` line is ignored here), add the environment variables above, deploy.

Then open `http://<host>:3000`, sign in as **admin** with your `ADMIN_PASSWORD`, and create staff logins under **Admin**.

> `ADMIN_PASSWORD` is only read the first time the app starts (empty database). Change it afterwards under Admin > Change my password.

## Updating
Rebuild the image (Option A: redeploy the stack with re-pull; Option B: rebuild the image and redeploy). The database lives in the `saildeck-data` volume and is untouched. Tables are created with `IF NOT EXISTS`.

## Backup and restore
- **Backup:** Admin > *Download database backup* (safe while running). Keep copies off the server.
- **Restore:** stop the stack, replace `saildeck.db` in the `saildeck-data` volume (delete any `saildeck.db-wal` / `-shm` files beside it), start the stack.

## HTTPS
Put it behind your existing reverse proxy (Nginx Proxy Manager, Traefik, Caddy). Forward `X-Forwarded-Proto: https`; SailDeck then marks the session cookie `Secure`. Don't expose plain HTTP to the internet.

## Security notes
- Passwords hashed with scrypt; sessions are random 256-bit tokens in HttpOnly, SameSite=Strict cookies (12h).
- Login attempts are rate limited per IP. State-changing requests from a foreign `Origin` are rejected.
- Deleting records and exports/backups are admin-only; every launch, sign-in, defect and delete is written to the audit log.
- Runs as a non-root user. All user text is HTML-escaped in the UI.
- This holds personal data (emergency contacts, possibly medical notes). Restrict access, back it up, and follow your local privacy rules.

## Safety disclaimer
SailDeck is a record-keeping and prompting tool. It does **not** replace a duty manager, a shore-based watch, radio checks, or your safety management plan. Overdue timers are only as good as the data entered.

## Configuration reference
| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | random, printed in container logs | First-run admin password |
| `CENTRE_NAME` | Harbour Sailing Centre | Shown in header and login |
| `PORT` | 3000 | Port inside the container |
| `DATA_DIR` | /data | Where `saildeck.db` lives |
| `SEED_DEMO` | false | Load sample data on first start |
| `TZ` | UTC | Container time zone (the UI uses each browser's local time) |

## Ideas for next steps
Public booking page, SMS/email alerts for overdue boats, QR-code boat tags for sign-out, race results and series scoring, junior-parent consent forms, kit/maintenance schedules (engine hours, rigging inspections), bar/kitchen till.
