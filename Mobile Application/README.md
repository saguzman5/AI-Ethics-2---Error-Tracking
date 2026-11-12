# Mobile Application (worker app)

Served by the server at `https://<server>/app/`. Workers open it in the phone browser and can add it to the home screen.

- `index.html` – the three screens: Scan → Details → Done, plus "My reports".
- `app.js` – form logic, validation, photo compression (max 1600 px JPEG), idempotent submission and retry.
- `scanner.js` – camera QR scanning using the native BarcodeDetector or jsQR.
- `app.css` – large touch targets for gloved hands and small screens.

How to use: `../Documentation/USER_GUIDE.md`. Camera/HTTPS requirements: `../Documentation/SETUP.md`, section 4.
