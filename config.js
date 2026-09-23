/**
 * Cloud sync setup for this copy of Rolebin.
 *
 * These are public app identifiers, not secrets: they are safe to commit and
 * every visitor's browser sees them. A provider with an empty value shows as
 * "not set up" in the sync dialog. GitHub Gist needs nothing here.
 *
 * README.md has step-by-step instructions for getting each one.
 */
window.ROLEBIN_CONFIG = {
  // Google Cloud Console > APIs & Services > Credentials > OAuth client ID (Web application)
  googleClientId: '',

  // dropbox.com/developers/apps > your app > Settings > App key
  dropboxAppKey: '',

  // Microsoft Entra admin center > App registrations > your app > Application (client) ID
  oneDriveClientId: ''
};
