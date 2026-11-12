# Management Dashboard

Served at `https://<server>/dashboard/` (managers only).

- `index.html`, `dashboard.js`, `dashboard.css` – KPIs, charts, resolution & rework section, report table, live updates.
- `charts.js` – dependency-free SVG charts (line, bars, donut).
- `admin.html`, `admin.js`, `admin.css` – stages, error types, products, users, spreadsheet feed.
- `labels.html`, `labels.js` – printable QR labels.

The report detail panel and filter bar are shared with the spreadsheet (`../Shared/`). Metric formulas: `../Documentation/METRICS.md`.
