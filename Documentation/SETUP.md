# Setup Guide

## 1. What you need

| Item | Required? | Notes |
|---|---|---|
| A computer or server to run the system | Yes | Windows, macOS or Linux. Any office PC works for a single factory; a small cloud VM (1 vCPU, 1 GB RAM) is enough for hundreds of reports a day. |
| **Node.js 22.13 or newer** (24 LTS recommended) | Yes | Download from <https://nodejs.org>. Nothing else needs installing: the system has **no npm dependencies** and uses Node's built-in SQLite database. |
| Phones or tablets with a camera | Yes | Any modern Android or iPhone browser. |
| HTTPS address for the server | Yes for in-app camera scanning on phones | Browsers only allow camera access on `https://` pages (or `localhost`). See section 4. |
| Google account | Only for Google Sheets sync | Free account is fine. |
| Microsoft Excel (desktop) | Only for Excel live connection | Excel 2016 or Microsoft 365. |

No API keys or paid accounts are required.

## 2. Install and start

```bash
cd "AI Ethics/Source Code"
npm start
```

On the first start the server:

1. creates the database in `AI Ethics/Database/data/production.db` and a `photos` folder next to it,
2. loads the default production stages and error types,
3. creates a manager account `admin` and **prints its password once in the console**. Copy it.

Open <http://localhost:3000> and sign in.

To choose the first password yourself, start with `ADMIN_PASSWORD="YourStrongPassword" npm start` (macOS/Linux) or `set ADMIN_PASSWORD=YourStrongPassword && npm start` (Windows cmd).

### Optional: demo data

```bash
npm run demo
```

This adds 12 orders, 480 boxes, about 210 error reports from the last 60 days and five demo accounts (`m.garcia` manager; `j.chen`, `a.okafor`, `l.novak`, `s.patel` workers). The shared demo password is printed in the console. Use demo data on a test copy only. To start fresh, stop the server and delete `Database/data/`.

## 3. Configuration

Copy `Source Code/.env.example` to `Source Code/.env` and edit. The most important settings:

| Setting | Default | Meaning |
|---|---|---|
| `TIMEZONE` | `UTC` | Factory time zone, e.g. `America/Chicago`, `Europe/Berlin`. All dates in the app, spreadsheet and exports use it. |
| `PUBLIC_URL` | (auto) | The address people use, e.g. `https://quality.example.com`. Used in QR labels and spreadsheet photo links. |
| `TRUST_PROXY` | `false` | Set `true` when behind a reverse proxy or tunnel that provides HTTPS. |
| `REQUIRE_PHOTO` | `false` | Make a photo mandatory for every report. |
| `AUTO_REGISTER_PRODUCTS` | `true` | If a QR code contains both Box ID and Order ID but the box is not registered yet, register it with the first report. Set `false` to only accept boxes registered by managers. |
| `DUPLICATE_WINDOW_MINUTES` | `30` | Warn a worker when the same box, stage and error type already has an unresolved report from this period. |

Restart the server after changing `.env`.

## 4. Making it available to phones (HTTPS)

Phones connect to the server over the network. For the in-app camera scanner the page must be served over HTTPS. Choose one option:

**Option A – Cloudflare Tunnel (quickest, free).** Install `cloudflared` on the server PC and run
`cloudflared tunnel --url http://localhost:3000`. It prints an `https://….trycloudflare.com` address. Set `PUBLIC_URL` to that address and `TRUST_PROXY=true`. For a permanent address, create a named tunnel with a free Cloudflare account.

**Option B – Reverse proxy on your own domain.** Put Caddy or nginx in front of the server. Caddy example (`Caddyfile`):
```
quality.example.com {
  reverse_proxy localhost:3000
}
```
Caddy obtains the certificate automatically. Set `PUBLIC_URL=https://quality.example.com` and `TRUST_PROXY=true`.

**Option C – Certificate directly in the server.** If your IT department provides a certificate for an internal host name, set `TLS_KEY_FILE` and `TLS_CERT_FILE` in `.env`. Self-signed certificates work only after the certificate is trusted on every phone.

**Without HTTPS** the system still works on the local network (`http://<server-ip>:3000`), but workers must use one of the scan fallbacks: the phone's own camera app (labels printed by the system open the worker app with the box pre-selected), **Scan from photo**, a Bluetooth/USB handheld scanner, or typing the Box ID.

### QR decoder note

Android Chrome, Edge and Samsung Internet decode QR codes natively. Other browsers (including iPhone Safari) use the open-source **jsQR** decoder. By default it is downloaded from `cdn.jsdelivr.net` the first time the camera opens. To serve it from your own server instead (for factories without internet access on the phones), run once in `Source Code`:

```bash
npm install
```

This installs only `jsqr` (optional dependency). The server detects it automatically.

## 5. Spreadsheet connection

The database is the master copy. Spreadsheets read from it; edits made in a spreadsheet are not written back.

| Spreadsheet | How it updates | Setup |
|---|---|---|
| **Built-in live spreadsheet** (`/spreadsheet/`) | Instantly (server push) | Nothing to set up. Sort by clicking a header, filter per column, download CSV or Excel. |
| **Google Sheets** | Every minute (Apps Script trigger) | See below. The server must be reachable from the internet over HTTPS (option A or B above). |
| **Excel (Power Query)** | Every minute while the file is open, and on open | See below. Works on the local network too. |
| **Excel file download** | Snapshot | Dashboard → Export Excel, or Spreadsheet → Download Excel. Includes an "Error Reports" sheet, a "Status History" sheet and an "About" sheet. |

### Google Sheets

1. In the dashboard open **Admin → Spreadsheet connection** and copy the feed URL.
2. Create a new Google Sheet → **Extensions → Apps Script**.
3. Paste the full contents of `Spreadsheet/google-sheets-sync.gs`, replace the value of `FEED_URL` with the copied URL, and save.
4. Choose the `setup` function and click **Run**. Approve the permissions (the script needs to fetch the URL and edit this spreadsheet).
5. Reload the sheet. The **Error Reports** tab is filled and refreshes every minute; a **Production Quality** menu offers "Refresh now". The **Sync Info** tab shows the last sync result.

### Excel

1. **Data → Get Data → From Other Sources → From Web**, paste the feed URL, click **OK**, then **Load**.
2. **Data → Queries & Connections**, right-click the query → **Properties** → tick **Refresh every 1 minute** and **Refresh data when opening the file**.
3. Use the Excel table's filter buttons to filter and sort. Photo links appear as plain URLs (copy one into a browser to open it). For clickable links, add a column with `=HYPERLINK([@photo_image],"View photo")`, or use the downloaded `.xlsx` file, where the links are already clickable.

The feed URL contains a secret key. Anyone with the URL can read the reports, so share it only with people who should see them. **Generate new key** (Admin → Spreadsheet connection) invalidates the old URL.

## 6. Accounts

- Managers create users under **Admin → Users**: name, username, role (worker or manager) and an initial password (at least 8 characters).
- Workers stay signed in on their phone for 30 days; managers for 1 day (configurable).
- Deactivating a user or resetting a password signs that user out everywhere.
- Lost all manager passwords? On the server run
  `npm run add-user -- newadmin manager "New Admin" "A-Strong-Password"`.

## 7. Backups

```bash
npm run backup
```

Creates `Database/backups/<timestamp>/` with a consistent copy of the database (safe while the server is running) and all photos. Schedule it daily (Windows Task Scheduler or cron) and copy the backups folder off the machine.

To restore, stop the server and copy `production.db` and the `photos` folder back into `Database/data/`.

## 8. Running as a service

- **Windows:** use NSSM (<https://nssm.cc>) to install `node "C:\path\AI Ethics\Source Code\src\server.js"` as a service.
- **Linux:** a systemd unit:
  ```ini
  [Unit]
  Description=Production Quality
  After=network.target
  [Service]
  WorkingDirectory=/opt/AI Ethics/Source Code
  ExecStart=/usr/bin/node src/server.js
  Restart=always
  User=quality
  [Install]
  WantedBy=multi-user.target
  ```

## 9. Testing

```bash
npm test                 # API end-to-end tests (12 scenarios)
node tests/ui-smoke.js   # optional browser test; needs Chrome (set CHROME=/path/to/chrome)
```

The browser test drives the worker app on a phone-sized screen and the dashboard, spreadsheet and admin pages, and saves screenshots to `Documentation/screenshots/`.
