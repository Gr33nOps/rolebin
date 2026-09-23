# Rolebin

A personal job tracker that runs entirely in your browser. Save the jobs you find, move them through Saved → Applied → Interview → Offer (or Rejected), and keep notes on each one.

**Live app:** https://gr33nops.github.io/rolebin/

No account, no server, no build step, no tracking. Your list is stored in your browser's `localStorage` and never leaves your device.

## Using it

1. Copy a job link from LinkedIn, Indeed, a company careers page, wherever.
2. Click **+ Add Job** and paste it. Rolebin fills in the platform and warns you if you've already saved that posting.
3. Change the status straight from the job's card as things progress.
4. Filter by status, or search titles, companies, platforms and notes (`Ctrl+K` / `Cmd+K` jumps to search).

### Back up your list

Browser storage is tied to one browser on one device, and clearing site data erases it. Use **Export backup (JSON)** in the footer now and then. **Import backup** restores a file and replaces the current list (after asking).

## Details

- **Platform detection** recognises LinkedIn, Indeed, Glassdoor, Upwork, Wellfound, Greenhouse, Lever, Workable and Ashby. Any other link uses the domain name (`careers.airbnb.com` → `Airbnb`). You can always type your own.
- **Duplicate check** compares links after stripping `www.`, trailing slashes and tracking parameters (`utm_*`, `trk`, `ref`, `gclid`…), so the same posting shared twice is caught.
- **Only `http`/`https` links are accepted.** Imported backups are validated field by field; entries without a title are skipped.
- Follows your system light/dark setting.
- Storage key: `rolebin_jobs_v1`.

## Run locally

Open `index.html` directly, or serve the folder so it behaves like the hosted version:

```bash
python -m http.server 8000
```

Then visit http://localhost:8000.

## Files

```text
index.html    markup and dialogs
styles.css    styles, light and dark themes
app.js        state, storage, rendering, import/export
favicon.svg   tab icon
```

## Deployment

The site is served by GitHub Pages from the `main` branch root. Every push to `main` redeploys it.
