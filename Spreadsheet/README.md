# Spreadsheet

The central database is the source of truth. Three spreadsheet options read from it:

1. **Live spreadsheet in the system** – `https://<server>/spreadsheet/`. Updates instantly, column filters, sorting, CSV/Excel download. Files: `index.html`, `spreadsheet.js`, `spreadsheet.css`.
2. **Google Sheets** – `google-sheets-sync.gs` mirrors the feed into an "Error Reports" tab every minute, with clickable photo links, severity/status colours and a filter row.
3. **Excel** – connect with Power Query (Data → From Web) to the feed URL and set "Refresh every 1 minute", or download a formatted `.xlsx` snapshot.

Columns: `error_ID, box_ID, order_ID, stage, error_type, severity, timestamp, status, photo_image, description`, followed by `requires_rework, resolved_at, resolution_notes, reported_by`. Timestamps use `YYYY-MM-DD HH:MM:SS` in the factory time zone.

Step-by-step setup: `../Documentation/SETUP.md`, section 5. The feed URL is under Dashboard → Admin → Spreadsheet connection.
