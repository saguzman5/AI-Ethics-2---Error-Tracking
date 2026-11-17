# Online Version

A free, always-on version of the system: these pages are hosted on GitHub Pages and use Supabase for the database, logins, photo storage and live updates. No server or computer of your own needs to stay on.

- `index.html` – sign-in page
- `app/` – worker reporting app
- `dashboard/` – management dashboard, admin and QR labels
- `spreadsheet/` – live spreadsheet
- `shared/` – styles and shared code. `backend.js` is the data layer; `common.js` holds the helpers.
- `config.js` – **your Supabase project URL and publishable key** (fill these in)

Database script: `../Database/supabase-setup.sql`. Step-by-step setup: `../Documentation/ONLINE_SETUP.md`.

The original version (`Source Code/`, run with `npm start`) keeps working unchanged on your Mac.
