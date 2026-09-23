# Rolebin

A personal job tracker that runs entirely in your browser. Save the jobs you find, move them through Saved → Applied → Interview → Offer (or Rejected), and keep notes on each one. Turn on sync to keep the same list on your phone and computer, stored in **your own** cloud storage.

**Live app:** https://gr33nops.github.io/rolebin/

No Rolebin account, no Rolebin server, no build step, no tracking.

## Using it

1. Copy a job link from LinkedIn, Indeed, a company careers page, wherever.
2. Click **+ Add Job** and paste it. Rolebin fills in the platform and warns you if you've already saved that posting.
3. Change the status straight from the job's card as things progress.
4. Filter by status, or search titles, companies, platforms and notes (`Ctrl+K` / `Cmd+K` jumps to search).

## Sync across devices

Click **Sync** in the header and pick where your list should live:

| Provider | What Rolebin can access | Stays signed in |
| --- | --- | --- |
| Google Drive | A hidden app-data folder only, not your files | About an hour at a time, then one tap on **Reconnect** |
| Dropbox | Its own `Apps/<app name>` folder only | Until you disconnect |
| OneDrive | Its own `Apps/<app name>` folder only | About a day, then **Reconnect** |
| GitHub Gist | Your gists, via a token you paste in | Until the token expires |

Do the same on your other devices with the same account. Everything is kept in one file, `rolebin.json`.

- **Changes sync automatically** a moment after you make them, when you come back to the tab, and when your connection returns. **Sync now** forces it.
- **Jobs already on a device are combined** with what's in the cloud when you connect, not replaced.
- **Edits on two devices:** the most recent edit to a job wins. A delete wins over edits made before it.
- **Offline:** everything keeps working and is stored in the browser. It syncs when you're back online.
- **Disconnect** stops syncing on that device. Your jobs stay in the browser, and the file stays in your cloud storage.
- If `rolebin.json` in your storage is damaged or isn't Rolebin data, Rolebin won't overwrite it and tells you instead.
- A secret gist is *unlisted, not private*: anyone with its URL can read it. Use Drive, Dropbox or OneDrive if that matters to you.

Sign-in tokens are kept in this browser's `localStorage`. Rolebin talks to the provider's API directly from the page; nothing goes through any other server.

### Setting up providers (site owner, one time)

Google Drive, Dropbox and OneDrive only let registered apps sign users in, so whoever hosts Rolebin registers it once with each provider and puts the resulting **public** client ID in [`config.js`](config.js). These IDs are not secrets. GitHub Gist needs no setup.

Throughout, the **redirect URI / origin** is where the site is hosted. For this repo:

- Origin: `https://gr33nops.github.io`
- Redirect URI: `https://gr33nops.github.io/rolebin/` (include the trailing slash)

Add `http://localhost:8000` / `http://localhost:8000/` as well if you want sync to work when running locally.

<details>
<summary><strong>Google Drive</strong></summary>

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (e.g. "Rolebin").
2. **APIs & Services → Library**: enable **Google Drive API**.
3. **Google Auth Platform / OAuth consent screen**: choose **External**, set the app name to Rolebin and add your email. Under **Data access / Scopes**, add `https://www.googleapis.com/auth/drive.appdata`.
4. **Audience**: while the app is in *Testing*, only the test users you list can sign in. Click **Publish app** so anyone can.
5. **Clients / Credentials → Create OAuth client ID** → *Web application*. Under **Authorized JavaScript origins** add `https://gr33nops.github.io`. No redirect URI is needed.
6. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) into `googleClientId` in `config.js`.

</details>

<details>
<summary><strong>Dropbox</strong></summary>

1. Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) → **Create app**.
2. Choose **Scoped access** and **App folder**. The name you pick becomes the folder name (`Apps/<name>`).
3. **Permissions** tab: tick `files.content.read` and `files.content.write`, then **Submit**.
4. **Settings** tab:
   - **OAuth 2 → Redirect URIs**: add `https://gr33nops.github.io/rolebin/`
   - **Allow public clients (Implicit Grant & PKCE)**: *Allow*
5. Copy the **App key** into `dropboxAppKey` in `config.js`.

New Dropbox apps start in development mode, which allows up to 500 users. Apply for production in the app's settings if you need more.

</details>

<details>
<summary><strong>OneDrive</strong></summary>

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/) → **App registrations → New registration**. A free Microsoft account works.
2. **Supported account types**: *Accounts in any organizational directory and personal Microsoft accounts*.
3. **Redirect URI**: platform **Single-page application (SPA)**, value `https://gr33nops.github.io/rolebin/`.
4. **API permissions → Add → Microsoft Graph → Delegated**: `Files.ReadWrite.AppFolder`, `User.Read`, `offline_access`.
5. Copy the **Application (client) ID** into `oneDriveClientId` in `config.js`.

</details>

Commit and push `config.js`; GitHub Pages redeploys and the provider becomes selectable.

## Back up your list

**Export backup (JSON)** in the footer downloads your list. **Import backup** restores a file and replaces the current list, after asking. With sync on, an import replaces the list on your other devices too.

## Details

- **Platform detection** recognises LinkedIn, Indeed, Glassdoor, Upwork, Wellfound, Greenhouse, Lever, Workable and Ashby. Any other link uses the domain name (`careers.airbnb.com` → `Airbnb`). You can always type your own.
- **Duplicate check** compares links after stripping `www.`, trailing slashes and tracking parameters (`utm_*`, `trk`, `ref`, `gclid`…), so the same posting shared twice is caught.
- **Only `http`/`https` links are accepted.** Imported backups and synced files are validated field by field; entries without a title are skipped. A Content Security Policy blocks scripts from anywhere except this site and Google's sign-in library.
- Follows your system light/dark setting.
- Storage keys: `rolebin_jobs_v1` (jobs), `rolebin_deleted_v1` (recent deletions, so they reach other devices), `rolebin_sync_v1` (sync connection).

## Run locally

Serve the folder (sync sign-in needs `http://localhost` or HTTPS, not `file://`):

```bash
python -m http.server 8000
```

Then visit http://localhost:8000.

## Files

```text
index.html    markup and dialogs
styles.css    styles, light and dark themes
config.js     public client IDs for cloud sync providers
store.js      job list, localStorage, merge rules for sync
app.js        rendering, forms, search, import/export
sync.js       cloud sync engine and providers
favicon.svg   tab icon
```

## Deployment

The site is served by GitHub Pages from the `main` branch root. Every push to `main` redeploys it.
