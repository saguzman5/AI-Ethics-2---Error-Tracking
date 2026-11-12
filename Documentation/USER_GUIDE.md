# User Guide

Open the system address in a browser (for example `https://quality.example.com`) and sign in. Workers go straight to the reporting app; managers go to the dashboard.

Screenshots of every screen are in `Documentation/screenshots/`.

---

## Production workers – reporting an error

**Tip:** on the phone, open the address and choose **Add to Home Screen** so the app opens like a normal app.

### 1. Scan the product
- The camera opens automatically. Point it at the QR label on the box. The phone vibrates when the code is read.
- The screen shows the **Box ID** and **Order ID** (and product name). If the box already has open reports, they are listed so you can avoid reporting the same issue twice.
- If the camera does not work, use one of these:
  - **Scan from photo**: take a picture of the label.
  - Type the Box ID (or scan it with a handheld scanner) and tap **Find**.
  - Open the phone's own camera app and point it at the label. It offers a link that opens the report form for that box.

### 2. Fill in the report (one screen)
- **Production stage**: tap where you found the error. The app remembers your stage for the next report.
- **Error type**: tap the category.
- **Severity**: Low, Medium, High or Critical.
- **What is wrong?**: a short description.
- **Photo**: **Take photo** or **Choose image**. You can remove and retake it.

Tap **Submit report**. Missing fields are highlighted in red with a message.

If the app says a similar report was submitted recently, check whether it is the same problem. Tap **Submit anyway** only if it is a different issue.

If the network fails, your answers are kept. Tap **Submit report** again. The app makes sure a retried report is only saved once.

### 3. Confirmation
You see the new **Error ID** (for example `ERR-000214`), the time, and status **Open**. Then choose:
- **Scan next product**, or
- **Report another issue on this box**.

**My reports** (top right) lists your last 20 reports and their current status. Workers cannot change reports after submitting them.

---

## Managers

### Dashboard (`/dashboard/`)
- **Filters** (top): period, dates, stage, error type, severity, status, Order ID, Box ID. Every KPI, chart and table follows the filters. Clicking a bar, slice or status tile also sets a filter. The filters are kept in the page address, so you can bookmark or share a filtered view.
- **KPIs**: total errors, unresolved errors, high & critical errors, rework rate, resolved errors.
- **Charts**: errors over time, severity, errors by stage, errors by type, and a ranked list of the most common errors.
- **Error resolution & rework**: counts per status, rework rate, average time to resolve, resolution rate, and a comparison of products produced, reported errors, affected products and products requiring rework. See `METRICS.md` for formulas.
- **Error reports** table: click a column header to sort, click a row to open the report. Critical reports are highlighted in red. **Export CSV / Export Excel** downloads the filtered list.
- The page updates by itself when reports are submitted or changed ("Live" indicator in the top bar).

### Working a report
Click a report to open the side panel:
- full details, description and photo (click the photo to open it full size),
- **Update status**: choose Open, Under Review, In Rework or Resolved, add a note about what was found or done, and tick **Product requires rework** if applicable. A note is required to resolve or reopen a report. Moving to In Rework ticks "requires rework" automatically.
- **Resolution history**: every status change with time, person and note.
- **Correct classification**: fix the stage, error type or severity if the worker picked the wrong one. The worker's original description, photo, box, order and time cannot be changed, and every correction is logged.

If another manager changed the same report a moment earlier, you get a message asking you to reload instead of overwriting their change.

### Spreadsheet (`/spreadsheet/`)
A live table with exactly the columns `error_ID, box_ID, order_ID, stage, error_type, severity, timestamp, status, photo_image, description`, plus `requires_rework` and `resolved_at`. Click a header to sort, use the row under the headers to filter each column, click an error ID to open the report, or download CSV/Excel. Changed rows flash yellow when they update.

For Google Sheets or Excel connections, see `SETUP.md`, section 5.

### Admin (`/dashboard/admin.html`)
- **Stages & error types**: add, rename, reorder (lower "Order" numbers appear first) or deactivate. Deactivated items disappear from the worker app but stay on old reports.
- **Products & QR labels**: register an order and either one Box ID or a number of boxes (IDs are generated as `BOX-<order>-0001`, …). Labels open in a printable page sized for 62 mm label stock; print them on any printer. Each order has a **Labels** button for reprinting.
- **Users**: create workers and managers, change roles, deactivate, reset passwords.
- **Spreadsheet connection**: the feed URL for Google Sheets / Excel and a button to generate a new key.
- **My password**: change your own password.

### Using your existing QR codes
If your boxes already have QR codes, the app accepts these formats:

| Format | Example |
|---|---|
| Box ID only | `BOX-000123` |
| URL with parameters | `https://anything/path?box=BOX-000123&order=PO-2026-001` |
| JSON | `{"box_id":"BOX-000123","order_id":"PO-2026-001"}` |
| Key/value | `BOX:BOX-000123;ORDER:PO-2026-001` |

A code with only a Box ID works for boxes registered in Admin. A code with both IDs also works for new boxes when `AUTO_REGISTER_PRODUCTS=true`.
