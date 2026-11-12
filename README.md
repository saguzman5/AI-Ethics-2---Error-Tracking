# Production Tracking & Error Reporting System

Factory workers scan a product's QR code on their phone and report an error with stage, type, severity, description and photo. The report goes into one central database. The live spreadsheet and the management dashboard read from that database and update within a second; managers move each report through **Open → Under Review → In Rework → Resolved** with notes, and every change is kept in a history.

## Quick start

1. Install **Node.js 22.13+** from <https://nodejs.org> (no other software or packages needed).
2. In a terminal:
   ```bash
   cd "AI Ethics/Source Code"
   npm start
   ```
3. Copy the manager password printed in the console, open <http://localhost:3000> and sign in as `admin`.
4. Optional: stop the server, run `npm run demo` to load sample data, and start again.

For phones, HTTPS, Google Sheets and Excel, see [Documentation/SETUP.md](Documentation/SETUP.md).

| Address | Who | What |
|---|---|---|
| `/app/` | workers (and managers) | Mobile error-reporting app |
| `/dashboard/` | managers | KPIs, charts, resolution tracking, report table |
| `/spreadsheet/` | managers | Live spreadsheet with filters, sorting, CSV/Excel download |
| `/dashboard/admin.html` | managers | Stages, error types, products, QR labels, users, spreadsheet feed |

## Folder structure

```
AI Ethics/
├── README.md                     This file
├── Mobile Application/           Worker app (served at /app/)
│   ├── index.html, app.css, app.js
│   ├── scanner.js                Camera QR scanning (native + jsQR fallback)
│   └── manifest.webmanifest      "Add to Home Screen" support
├── Database/
│   ├── schema.sql                Tables, constraints, triggers, reporting view
│   ├── README.md
│   └── data/                     Created on first start: production.db + photos/ (not in version control)
├── Spreadsheet/
│   ├── index.html, spreadsheet.js, spreadsheet.css   Live spreadsheet (served at /spreadsheet/)
│   ├── google-sheets-sync.gs     Google Sheets auto-sync script
│   └── README.md                 Google Sheets / Excel instructions
├── Dashboard/
│   ├── index.html, dashboard.js, dashboard.css, charts.js   Management dashboard
│   ├── admin.html, admin.js, admin.css                       Administration
│   └── labels.html, labels.js                                Printable QR labels
├── Shared/                       Login page, common styles, filter bar, report panel, logo
├── Source Code/                  Server
│   ├── package.json, .env.example
│   ├── src/                      server, routes, database access, auth, metrics, exports, QR, xlsx writer
│   ├── scripts/                  seed-demo, add-user, backup
│   ├── tests/                    e2e.test.js (API), ui-smoke.js (browser)
│   └── vendor/qrcode/            QR encoder (MIT, Kazuhiko Arase)
└── Documentation/
    ├── SETUP.md                  Installation, HTTPS, spreadsheet connections, backups
    ├── USER_GUIDE.md             How workers and managers use the system
    ├── METRICS.md                Exact formulas (rework rate etc.)
    ├── ARCHITECTURE.md           Design, database, security, API
    └── screenshots/              Screens captured by the automated browser test
```

## Tests

```bash
cd "AI Ethics/Source Code"
npm test                  # 12 end-to-end API scenarios
node tests/ui-smoke.js    # browser walkthrough (needs Chrome), saves screenshots
```
