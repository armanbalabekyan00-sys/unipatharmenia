# UniPath — Python edition

UniPath is the Python/Flask edition of the UniPath study-abroad planning site. It keeps the current site design and front-end interactions, and uses SQLite for local accounts, saved universities, contact requests and website chat.

## Run on Windows

Install Python 3.10 or newer, then open PowerShell in this folder:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:ADMIN_PASSWORD = "choose-a-private-password"
$env:APP_SECRET_KEY = "replace-with-a-long-random-secret"
python app.py
```

Open [http://localhost:8080](http://localhost:8080). The local admin page is `/admin`; its demo password is `unipath-demo-admin` unless you set `ADMIN_PASSWORD`. Replace it before making the site public.

Or double-click `run-windows.bat` to create the virtual environment, install dependencies and launch the app. Set environment variables first if you want a non-demo admin password, Google sign-in or email.

### Run Lighthouse locally

Lighthouse can audit the local site; the Flask server must be running during the audit. Double-click `run-windows.bat`, wait for the browser to open `http://127.0.0.1:8080/`, then open Chrome DevTools (`F12`) → **Lighthouse** → **Analyze page load**. Keep the separate server window open until the audit finishes. If Chrome says it cannot reach localhost, start the app first and use `http://127.0.0.1:8080/` instead of opening the HTML files directly.

## Features

- Responsive home, destination/program finder, program details, services, About, contact, sign-in, registration, account and admin pages.
- Search and filters across 22 destinations, 66 university profiles and 264 example programs, with tuition sorting, scholarships, pagination and favorites.
- Profile and study-goal saving, a persistent student shortlist, a free first UniPath session, and a demo booking flow that does not charge cards.
- A standard world map with 40 example university points; hover, keyboard focus or tap a point for its university, program and intake year. The map entries are examples, not verified applicant records.
- Website chat with conversation history and team replies in the admin inbox.
- Contact inbox, student-account table, password-reset email flow and optional Google Identity sign-in.
- English, Armenian and Russian translation using MyMemory by default, or Google Cloud Translation if configured.

## Configuration

Set environment variables in PowerShell before running, or copy `.env.example` as a reference (the app does not automatically load `.env` files):

| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Admin sign-in password. Set a unique secret before deployment. |
| `APP_SECRET_KEY` | Flask session-signing secret. Use a long random value in production. |
| `COOKIE_SECURE` | Set `true` behind HTTPS. |
| `UNIPATH_DATA_DIR` or `DATABASE_PATH` | Persistent SQLite database location. Defaults to `./data/unipath.sqlite3`. |
| `PUBLIC_URL` | Public site origin for canonical URLs and password-reset links. |
| `GOOGLE_CLIENT_ID` | Optional Google web client ID; authorize your local/deployed origin in Google Console. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` | Optional SMTP delivery for password resets and notifications. |
| `CONTACT_RECIPIENT` | Optional address for new contact notifications. |
| `GOOGLE_TRANSLATE_API_KEY` | Optional Google Translation API key; translation otherwise uses MyMemory. |

The SQLite database is stored in `data/` and persists across restarts. Back it up before making database or deployment changes. Password reset requires SMTP. Google sign-in requires a Google web client ID. The demo checkout does not collect or process payments.

## Docker

Build and run locally:

```powershell
docker build -t unipath-python .
docker run --name unipath-python -p 8080:8080 -e ADMIN_PASSWORD="choose-a-private-password" -e APP_SECRET_KEY="replace-this-secret" -v unipath-data:/app/data unipath-python
```

## Free Oracle Cloud deployment

For the Oracle Always Free VM, DuckDNS and HTTPS setup, follow [`deploy/oracle-cloud.md`](deploy/oracle-cloud.md). Only choose Oracle Console resources marked Always Free Eligible, and keep the SQLite data volume persistent.
