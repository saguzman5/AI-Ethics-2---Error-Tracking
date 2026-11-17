# Online Version – Setup Guide (free, no computer needs to stay on)

The online version runs entirely on two free services:

- **Supabase** stores the database, logins and photos, and sends live updates.
- **GitHub Pages** hosts the pages (worker app, dashboard, spreadsheet, admin) at a permanent link such as `https://your-name.github.io/your-repo/`.

Total time: about 30 minutes. You need your GitHub account and a web browser.

---

## Part A – Create the Supabase project (5 min)

1. Go to **supabase.com** and click **Start your project**.
2. Choose **Continue with GitHub** and approve. No Google sign-in is needed.
3. Click **New project**:
   - **Name:** `production-quality`
   - **Database password:** click **Generate a password**, then **copy it and save it** in a safe place. You won't need it in the app, but Supabase can't show it again.
   - **Region:** the one closest to your factory.
   - Plan: **Free**.
4. Click **Create new project** and wait 1–2 minutes until the project dashboard appears.

## Part B – Create the database (3 min)

1. In the left menu, click **SQL Editor**.
2. Click **New query** (or the **+** button).
3. Open the file `Database/supabase-setup.sql` from the project on your Mac (right-click → **Open With → TextEdit**). Press **Command + A**, then **Command + C**.
4. Click in the Supabase editor, press **Command + V**, then click **Run** (bottom right).
5. You should see **"Setup complete"** in the results. If Supabase asks whether to run a query with "destructive operations", click **Run this query**. The script only removes and recreates its own rules.

If you see a red error instead, copy the message and send it to me.

## Part C – Create your logins (5 min)

**Your own manager login (do this first).** The first login ever created automatically becomes a manager.

1. Left menu → **Authentication** → **Users** → **Add user** → **Create new user**.
2. Enter your email address and a password of at least 8 characters.
3. Tick **Auto Confirm User**, then click **Create user**.

**Worker logins.** Repeat the same steps for each worker. Each new login starts as a worker. The email can be made up, for example `jchen@yourcompany.com`, because Supabase never emails these addresses. Tip: if every worker uses the same ending, such as `@yourcompany.com`, they can sign in with just `jchen` (see Part F).

**Close public sign-up**, so only logins you create can get in:

- Left menu → **Authentication** → **Sign In / Providers** (on some screens: **Providers** or **Settings**).
- Turn **off** "Allow new users to sign up", then click **Save**.

## Part D – Copy two values from Supabase (2 min)

You need two values. Keep the page open, or paste them into a note:

1. **Project URL.** Click the **Connect** button at the top of the project, or go to **Project Settings → Data API**. It looks like `https://abcdefghijklmnop.supabase.co`.
2. **Publishable key.** Go to **Project Settings → API Keys**. Copy the **Publishable key** (starts with `sb_publishable_`). If your project only shows "Legacy API keys", copy the **anon public** key instead.

Both values are meant to be public: what each person can see and do is enforced inside the database. **Never** copy the **secret** or **service_role** key anywhere.

## Part E – Prepare GitHub (3 min)

GitHub Pages is free for **public** repositories. The code contains no passwords or data, so making it public is safe. The reports and photos live in Supabase, not on GitHub.

1. Open your repository on **github.com** → **Settings** (top tab).
2. Scroll to the bottom (**Danger Zone**) → **Change visibility** → **Make public**, and confirm.
3. Still in Settings, click **Pages** in the left menu. Under **Build and deployment → Source**, choose **GitHub Actions**.

## Part F – Add the online version to your repository (5 min)

1. Download **`AI Ethics online update.zip`** from Kiro's file explorer. Safari unzips it into your **Downloads** folder as **`AI Ethics online update`**.
2. In Finder, right-click your **AI Ethics** folder (the one you added to GitHub Desktop) → **New Terminal at Folder**, then paste:
   ```
   ditto ~/Downloads/"AI Ethics online update" .
   ```
   This copies the new files into your project without deleting anything. If your Downloads folder is elsewhere, drag the `AI Ethics online update` folder into the terminal window instead of typing the path.
3. Open **GitHub Desktop**. The **Changes** list shows the new files, including `Online Version/` and `.github/workflows/publish-online-version.yml`.
4. Type `Add online version` in the **Summary** box, click **Commit to main**, then **Push origin**.

## Part G – Connect the pages to Supabase (3 min)

Edit this file on github.com, not in TextEdit. TextEdit can change quote marks and break the file.

1. On github.com, open your repository → **Online Version** → **config.js** → click the **pencil icon** (Edit).
2. Replace `PASTE-YOUR-PROJECT-URL-HERE` with your Project URL, and `PASTE-YOUR-PUBLISHABLE-KEY-HERE` with your publishable key. Keep the quote marks around them.
3. Optional: if worker logins all end in the same domain (e.g. `@yourcompany.com`), put `yourcompany.com` between the quotes of `LOGIN_EMAIL_DOMAIN`. Workers can then sign in with just their name, e.g. `jchen`.
4. Click **Commit changes…** → **Commit changes**.
5. Back in GitHub Desktop, click **Fetch origin**, then **Pull origin**, so your Mac has the same file.

## Part H – Open your link

1. On github.com, click the **Actions** tab. Wait until the newest **"Publish online version"** run shows a **green check** (about 1 minute). If it's red, click it, then **Re-run jobs**. If it fails again, send me the error.
2. Your link is shown under **Settings → Pages** ("Your site is live at …"). It looks like:
   ```
   https://your-username.github.io/your-repository-name/
   ```
3. Open it and sign in with your manager login from Part C.
4. Go to **Admin → Settings** and set your factory's **time zone** (e.g. `America/New_York` or `Europe/Madrid`), then click **Save settings**.
5. Go to **Admin → Products & QR labels** to register orders and boxes and print QR labels.
6. Send the link to workers. On phones, the camera scanner works directly because the link is https. In Safari, tap **Share → Add to Home Screen** to make it feel like an app.

---

## Optional: demo data

To try the dashboard with sample data: Supabase → **SQL Editor** → **New query** → paste `Database/supabase-demo-data.sql` → **Run**. It adds 12 demo orders, 480 boxes and about 200 reports, attributed to your existing logins.

To remove only the demo data later, run `Database/supabase-remove-demo-data.sql` the same way.

## Optional: Google Sheets

In the app, open **Admin → Spreadsheet connection** and follow the three steps shown there. The script to paste is `Spreadsheet/google-sheets-sync-online.gs`. Excel users can use **Download Excel (.xlsx)** on the Spreadsheet page.

## Day-to-day management

| Task | Where |
|---|---|
| Add a worker or manager | Supabase → Authentication → Users → Add user (tick Auto Confirm). Then set the role in the app under Admin → Users. |
| Remove someone's access | App → Admin → Users → untick **Active** → Save. Access stops immediately. |
| Reset a password | Supabase → Authentication → Users → click the user → **Send password recovery**. This only works with real email addresses. For made-up addresses, delete the login there and create it again (only possible if the person has no reports), or create a new login. |
| Change stages / error types | App → Admin → Stages & error types |
| Change time zone, photo requirement, duplicate warning | App → Admin → Settings |
| Back up the data | Supabase → Database → Backups is only included on paid plans. On the free plan, export regularly: Spreadsheet → Download Excel. |

## Free plan limits

- Supabase **pauses a free project after about 7 days without any use**. Daily use keeps it active. If it pauses, sign in to supabase.com and click **Restore project**; nothing is lost.
- Storage is about **500 MB** of database and **1 GB** of photos, which is roughly 3,000 photos at the app's compression. Check supabase.com/pricing for current limits.
- GitHub Pages and Supabase are both run by companies that may change their free plans in the future.

## Updating the app later

Change files on your Mac, then **Commit** and **Push** in GitHub Desktop. GitHub publishes the new version automatically within about a minute. If a change includes a new `supabase-setup.sql`, run it again in the SQL Editor. It's safe to re-run and keeps all data.

## Troubleshooting

| Message | Fix |
|---|---|
| "Setup not finished" on the sign-in page | `config.js` still contains `PASTE-…`. Redo Part G and wait for the green check in Actions. |
| "Incorrect username or password" | Check the login in Supabase → Authentication → Users. If you use short usernames, check `LOGIN_EMAIL_DOMAIN` in config.js. |
| "This login has no profile yet" | Run `supabase-setup.sql` again (Part B). |
| "Could not find the function …" or "relation … does not exist" | Part B wasn't completed. Run the setup script again. |
| Dashboard numbers don't update by themselves | They refresh at least every 30 seconds. For instant updates, check Supabase → Database → Publications → `supabase_realtime` includes `error_reports`. |
| The page shows GitHub's "404" | The Actions run hasn't finished or failed. Check Part H step 1, and check that Pages source is "GitHub Actions" (Part E). |
