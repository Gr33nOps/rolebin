/**
 * Rolebin cloud sync.
 *
 * Keeps the job list in one file, rolebin.json, in the user's own cloud
 * storage: Google Drive, Dropbox, OneDrive, or a GitHub Gist. There is no
 * Rolebin server; the browser talks to the provider directly, and the
 * Drive/Dropbox/OneDrive permissions only reach an app-specific folder.
 */

(function () {
  'use strict';

  const Store = window.RolebinStore;
  const config = window.ROLEBIN_CONFIG || {};

  const SYNC_KEY = 'rolebin_sync_v1';
  const OAUTH_PENDING_KEY = 'rolebin_oauth_pending';
  const FILE_NAME = 'rolebin.json';
  // Must match the redirect URI registered with Dropbox and Microsoft exactly
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');

  const LOCAL_CHANGE_DELAY_MS = 1500;
  const REFOCUS_SYNC_AFTER_MS = 30 * 1000;

  class AuthError extends Error {}
  class OfflineError extends Error {}

  // ==========================================================================
  // HTTP & OAuth helpers
  // ==========================================================================

  async function request(url, options) {
    let res;
    try {
      res = await fetch(url, Object.assign({ cache: 'no-store' }, options));
    } catch (e) {
      throw new OfflineError('Network request failed');
    }
    if (res.status === 401) throw new AuthError('Access expired');
    return res;
  }

  async function expectOk(res, action) {
    if (res.ok) return res;
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
    console.error(`${action} failed`, res.status, detail);
    throw new Error(`${action} failed (HTTP ${res.status}).`);
  }

  function bearer(token, extra) {
    return Object.assign({ Authorization: 'Bearer ' + token }, extra);
  }

  // Token endpoints answer 400 when a code or refresh token is no longer valid
  async function postTokenForm(url, params, action) {
    const res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });
    if (res.status === 400) throw new AuthError(`${action} was refused.`);
    await expectOk(res, action);
    return res.json();
  }

  function applyToken(state, token) {
    state.accessToken = token.access_token;
    // Refresh a minute early so a request never starts with a token about to expire
    state.expiresAt = Date.now() + ((Number(token.expires_in) || 3600) - 60) * 1000;
    if (token.refresh_token) state.refreshToken = token.refresh_token;
  }

  async function ensureFreshToken(state, refresh) {
    if (state.accessToken && Date.now() < state.expiresAt) return;
    if (!state.refreshToken) throw new AuthError('Signed out');
    applyToken(state, await refresh(state.refreshToken));
  }

  function base64Url(bytes) {
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomString(byteLength) {
    return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
  }

  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
  }

  // Authorization-code + PKCE sign-in: leaves the page, comes back with ?code=
  async function startRedirectSignIn(providerId, buildAuthorizeUrl) {
    const verifier = randomString(48);
    const csrfState = randomString(16);
    sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({ provider: providerId, state: csrfState, verifier: verifier }));
    location.assign(buildAuthorizeUrl(await pkceChallenge(verifier), csrfState));
  }

  // ==========================================================================
  // Providers
  // Each one: connect / finish sign-in, ensureToken, read() -> text|null,
  // write(text), account() -> label, disconnect().
  // ==========================================================================

  const googleDrive = {
    id: 'google',
    name: 'Google Drive',
    detail: 'Saved in a hidden app folder. Rolebin can’t see your other files.',
    configKey: 'googleClientId',
    scriptPromise: null,

    // Google's sign-in library must be loaded before the click that opens its popup
    prepare() {
      if (!this.scriptPromise) {
        this.scriptPromise = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://accounts.google.com/gsi/client';
          script.async = true;
          script.onload = resolve;
          script.onerror = () => {
            this.scriptPromise = null;
            reject(new OfflineError('Could not load Google sign-in'));
          };
          document.head.appendChild(script);
        });
      }
      return this.scriptPromise;
    },

    // Opens Google's popup, so it has to run inside a click handler
    requestToken(state) {
      return new Promise((resolve, reject) => {
        const oauth = window.google && window.google.accounts && window.google.accounts.oauth2;
        if (!oauth) {
          this.prepare().catch(() => {});
          reject(new Error('Google sign-in is still loading. Try again in a moment.'));
          return;
        }
        oauth.initTokenClient({
          client_id: config.googleClientId,
          scope: 'https://www.googleapis.com/auth/drive.appdata',
          login_hint: (state && state.account) || undefined,
          callback: resp => {
            if (resp.error) reject(new AuthError(resp.error_description || 'Google sign-in failed.'));
            else resolve(resp);
          },
          error_callback: err => {
            reject(new AuthError(err && err.type === 'popup_closed'
              ? 'The Google sign-in window was closed.'
              : 'Google sign-in failed. If a popup blocker is on, allow popups for this site.'));
          }
        }).requestAccessToken({ prompt: '' });
      });
    },

    async connect() {
      const state = { provider: this.id };
      applyToken(state, await this.requestToken(null));
      return state;
    },

    async reconnect(state) {
      applyToken(state, await this.requestToken(state));
      return state;
    },

    // Google gives browser apps short-lived tokens with no refresh token,
    // so after about an hour the user taps Reconnect.
    ensureToken(state) {
      if (!state.accessToken || Date.now() >= state.expiresAt) throw new AuthError('Google access expired');
    },

    async findFileId(state) {
      const q = encodeURIComponent(`name='${FILE_NAME}'`);
      const res = await expectOk(await request(
        `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)&pageSize=1`,
        { headers: bearer(state.accessToken) }
      ), 'Finding the Rolebin file in Google Drive');
      const data = await res.json();
      return data.files && data.files[0] ? data.files[0].id : null;
    },

    async read(state) {
      if (!state.fileId) state.fileId = await this.findFileId(state);
      if (!state.fileId) return null;

      const res = await request(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(state.fileId)}?alt=media`,
        { headers: bearer(state.accessToken) }
      );
      if (res.status === 404) {
        state.fileId = null;
        return null;
      }
      await expectOk(res, 'Reading from Google Drive');
      return res.text();
    },

    async write(state, body) {
      if (state.fileId) {
        const res = await request(
          `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(state.fileId)}?uploadType=media`,
          { method: 'PATCH', headers: bearer(state.accessToken, { 'Content-Type': 'application/json' }), body: body }
        );
        if (res.status !== 404) {
          await expectOk(res, 'Saving to Google Drive');
          return;
        }
        state.fileId = null;
      }

      const boundary = 'rolebin-' + randomString(12);
      const metadata = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;

      const res = await expectOk(await request(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        { method: 'POST', headers: bearer(state.accessToken, { 'Content-Type': `multipart/related; boundary=${boundary}` }), body: multipart }
      ), 'Creating the Rolebin file in Google Drive');
      state.fileId = (await res.json()).id;
    },

    async account(state) {
      const res = await request('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: bearer(state.accessToken) });
      if (!res.ok) return '';
      const data = await res.json();
      return (data.user && data.user.emailAddress) || '';
    },

    disconnect(state) {
      const oauth = window.google && window.google.accounts && window.google.accounts.oauth2;
      if (oauth && state.accessToken) oauth.revoke(state.accessToken, () => {});
    }
  };

  const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

  const dropbox = {
    id: 'dropbox',
    name: 'Dropbox',
    detail: 'Saved in its own app folder. Rolebin can’t see the rest of your Dropbox.',
    configKey: 'dropboxAppKey',

    connect() {
      return startRedirectSignIn(this.id, (challenge, csrfState) =>
        'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
          client_id: config.dropboxAppKey,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          token_access_type: 'offline',
          state: csrfState
        }));
    },

    reconnect() {
      return this.connect();
    },

    async finishSignIn(code, verifier) {
      const state = { provider: this.id };
      applyToken(state, await postTokenForm(DROPBOX_TOKEN_URL, {
        grant_type: 'authorization_code',
        code: code,
        client_id: config.dropboxAppKey,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
      }, 'Dropbox sign-in'));
      return state;
    },

    ensureToken(state) {
      return ensureFreshToken(state, refreshToken => postTokenForm(DROPBOX_TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.dropboxAppKey
      }, 'Refreshing Dropbox access'));
    },

    async read(state) {
      const res = await request('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: bearer(state.accessToken, { 'Dropbox-API-Arg': JSON.stringify({ path: '/' + FILE_NAME }) })
      });
      if (res.status === 409) {
        const err = await res.json().catch(() => ({}));
        if (String(err.error_summary || '').startsWith('path/not_found')) return null;
      }
      await expectOk(res, 'Reading from Dropbox');
      return res.text();
    },

    async write(state, body) {
      await expectOk(await request('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: bearer(state.accessToken, {
          'Dropbox-API-Arg': JSON.stringify({ path: '/' + FILE_NAME, mode: 'overwrite', mute: true }),
          'Content-Type': 'application/octet-stream'
        }),
        body: body
      }), 'Saving to Dropbox');
    },

    async account(state) {
      const res = await request('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: bearer(state.accessToken)
      });
      if (!res.ok) return '';
      return (await res.json()).email || '';
    },

    disconnect(state) {
      if (!state.accessToken) return;
      request('https://api.dropboxapi.com/2/auth/token/revoke', {
        method: 'POST',
        headers: bearer(state.accessToken)
      }).catch(() => {});
    }
  };

  const MS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0';
  const MS_SCOPES = 'Files.ReadWrite.AppFolder User.Read offline_access';
  const GRAPH_APP_FILE = `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${FILE_NAME}`;

  const oneDrive = {
    id: 'onedrive',
    name: 'OneDrive',
    detail: 'Saved in its own app folder. Rolebin can’t see the rest of your OneDrive.',
    configKey: 'oneDriveClientId',

    connect() {
      return startRedirectSignIn(this.id, (challenge, csrfState) =>
        `${MS_AUTH_URL}/authorize?` + new URLSearchParams({
          client_id: config.oneDriveClientId,
          response_type: 'code',
          response_mode: 'query',
          redirect_uri: REDIRECT_URI,
          scope: MS_SCOPES,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: csrfState
        }));
    },

    reconnect() {
      return this.connect();
    },

    async finishSignIn(code, verifier) {
      const state = { provider: this.id };
      applyToken(state, await postTokenForm(`${MS_AUTH_URL}/token`, {
        client_id: config.oneDriveClientId,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        scope: MS_SCOPES
      }, 'Microsoft sign-in'));
      return state;
    },

    ensureToken(state) {
      return ensureFreshToken(state, refreshToken => postTokenForm(`${MS_AUTH_URL}/token`, {
        client_id: config.oneDriveClientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: MS_SCOPES
      }, 'Refreshing OneDrive access'));
    },

    // Graph's /content answers with a redirect that browsers can't follow
    // cross-origin, so read the item's pre-authenticated download URL instead.
    async read(state) {
      const res = await request(GRAPH_APP_FILE, { headers: bearer(state.accessToken) });
      if (res.status === 404) return null;
      await expectOk(res, 'Reading from OneDrive');

      const downloadUrl = (await res.json())['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) return null;
      const file = await expectOk(await request(downloadUrl), 'Downloading from OneDrive');
      return file.text();
    },

    async write(state, body) {
      await expectOk(await request(`${GRAPH_APP_FILE}:/content`, {
        method: 'PUT',
        headers: bearer(state.accessToken, { 'Content-Type': 'application/json' }),
        body: body
      }), 'Saving to OneDrive');
    },

    async account(state) {
      const res = await request('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: bearer(state.accessToken) });
      if (!res.ok) return '';
      const data = await res.json();
      return data.mail || data.userPrincipalName || '';
    },

    disconnect() {
      // Microsoft has no token revocation endpoint for browser apps
    }
  };

  const GITHUB_API = 'https://api.github.com';
  const GIST_DESCRIPTION = 'Rolebin job tracker data';

  function githubHeaders(token, extra) {
    return Object.assign({
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, extra);
  }

  const gist = {
    id: 'gist',
    name: 'GitHub Gist',
    detail: 'Saved in a secret gist on your GitHub account. You paste in an access token.',
    configKey: null,
    usesToken: true,

    async connectWithToken(token) {
      const state = { provider: this.id, accessToken: token };

      const res = await request(`${GITHUB_API}/user`, { headers: githubHeaders(token) });
      await expectOk(res, 'Checking the GitHub token');
      state.account = (await res.json()).login || '';
      state.gistId = await this.findGist(state);
      return state;
    },

    async findGist(state) {
      for (let page = 1; page <= 10; page++) {
        const res = await expectOk(await request(
          `${GITHUB_API}/gists?per_page=100&page=${page}`,
          { headers: githubHeaders(state.accessToken) }
        ), 'Listing your gists');
        const list = await res.json();
        const match = list.find(g => g.description === GIST_DESCRIPTION && g.files && g.files[FILE_NAME]);
        if (match) return match.id;
        if (list.length < 100) break;
      }
      return null;
    },

    ensureToken(state) {
      if (!state.accessToken) throw new AuthError('No token');
    },

    async read(state) {
      if (!state.gistId) return null;

      const res = await request(`${GITHUB_API}/gists/${encodeURIComponent(state.gistId)}`, { headers: githubHeaders(state.accessToken) });
      if (res.status === 404) {
        state.gistId = null;
        return null;
      }
      await expectOk(res, 'Reading your gist');

      const file = (await res.json()).files[FILE_NAME];
      if (!file) return null;
      if (file.truncated) {
        return (await expectOk(await request(file.raw_url), 'Reading your gist')).text();
      }
      return file.content;
    },

    async write(state, body) {
      const payload = JSON.stringify({ description: GIST_DESCRIPTION, public: false, files: { [FILE_NAME]: { content: body } } });

      if (state.gistId) {
        const res = await request(`${GITHUB_API}/gists/${encodeURIComponent(state.gistId)}`, {
          method: 'PATCH',
          headers: githubHeaders(state.accessToken, { 'Content-Type': 'application/json' }),
          body: payload
        });
        if (res.status !== 404) {
          await expectOk(res, 'Saving to your gist');
          return;
        }
        state.gistId = null;
      }

      const res = await expectOk(await request(`${GITHUB_API}/gists`, {
        method: 'POST',
        headers: githubHeaders(state.accessToken, { 'Content-Type': 'application/json' }),
        body: payload
      }), 'Creating your gist');
      state.gistId = (await res.json()).id;
    },

    account(state) {
      return state.account || '';
    },

    disconnect() {
      // The user revokes the token on GitHub; we just forget it
    }
  };

  const PROVIDERS = [googleDrive, dropbox, oneDrive, gist];
  const providerById = id => PROVIDERS.find(p => p.id === id) || null;
  const isConfigured = provider => !provider.configKey || Boolean(config[provider.configKey]);

  // ==========================================================================
  // Sync engine
  // ==========================================================================

  // Connection: { provider, accessToken, expiresAt, refreshToken, fileId, gistId, account, lastSyncedAt }
  let connection = loadConnection();
  let status = connection ? 'idle' : 'off'; // off | idle | pending | syncing | offline | auth | error
  let statusMessage = '';
  let running = false;
  let queued = false;
  let changeTimer = null;

  function loadConnection() {
    try {
      const saved = JSON.parse(localStorage.getItem(SYNC_KEY));
      const provider = saved && providerById(saved.provider);
      return provider && isConfigured(provider) ? saved : null;
    } catch (e) {
      return null;
    }
  }

  function saveConnection() {
    try {
      if (connection) localStorage.setItem(SYNC_KEY, JSON.stringify(connection));
      else localStorage.removeItem(SYNC_KEY);
    } catch (e) {
      console.error('Failed to save sync settings:', e);
    }
  }

  function setStatus(next, message) {
    status = next;
    statusMessage = message || '';
    renderStatus();
  }

  // Never overwrite a file we can't understand; the user may have put it there
  function parseRemote(text) {
    if (text === null || !text.trim()) return null;

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`The ${FILE_NAME} file in your cloud storage isn’t valid JSON, so Rolebin left it alone. Fix or delete it, then sync again.`);
    }
    // A plain exported backup copied into the folder by hand
    if (Array.isArray(data)) return { jobs: data, deleted: [] };
    if (!data || typeof data !== 'object' || !Array.isArray(data.jobs)) {
      throw new Error(`The ${FILE_NAME} file in your cloud storage doesn’t look like Rolebin data, so Rolebin left it alone.`);
    }
    return data;
  }

  async function syncNow() {
    if (!connection) return;
    if (running) {
      queued = true;
      return;
    }

    const current = connection;
    const provider = providerById(current.provider);
    running = true;
    clearTimeout(changeTimer);
    changeTimer = null;
    setStatus('syncing');

    try {
      await provider.ensureToken(current);
      const remote = parseRemote(await provider.read(current));
      const { needsPush } = Store.mergeRemote(remote);
      if (needsPush) {
        await provider.write(current, JSON.stringify(Store.snapshot(), null, 2));
      }
      if (!current.account) {
        current.account = await Promise.resolve(provider.account(current)).catch(() => '');
      }
      current.lastSyncedAt = Date.now();
      if (connection !== current) return; // disconnected while this was running
      saveConnection();
      setStatus('idle');
    } catch (e) {
      if (connection !== current) return;
      saveConnection();
      if (e instanceof AuthError) {
        setStatus('auth', `${provider.name} needs you to sign in again before Rolebin can sync.`);
      } else if (e instanceof OfflineError) {
        setStatus('offline', navigator.onLine
          ? `Couldn’t reach ${provider.name}. Rolebin will try again when you come back to this tab.`
          : 'You’re offline. Changes are saved on this device and will sync when you’re back online.');
      } else {
        console.error('Sync failed:', e);
        setStatus('error', e.message);
      }
    } finally {
      running = false;
      if (queued && connection) {
        queued = false;
        syncNow();
      }
    }
  }

  function scheduleSync() {
    if (!connection || status === 'auth') return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(syncNow, LOCAL_CHANGE_DELAY_MS);
    if (!running) setStatus('pending');
  }

  async function useConnection(next) {
    connection = next;
    saveConnection();
    dialogView = 'main';
    dialogError = '';
    await syncNow();
  }

  function disconnect() {
    const provider = providerById(connection.provider);
    try { provider.disconnect(connection); } catch (e) { /* best effort */ }
    connection = null;
    queued = false;
    clearTimeout(changeTimer);
    saveConnection();
    dialogView = 'main';
    dialogError = '';
    setStatus('off');
  }

  // Back from Dropbox / Microsoft sign-in with ?code=...&state=...
  async function finishRedirectSignIn() {
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(OAUTH_PENDING_KEY)); } catch (e) { /* ignore */ }
    if (!pending) return false;

    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return false;

    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    history.replaceState(null, '', REDIRECT_URI + location.hash);

    const provider = providerById(pending.provider);
    if (!provider || params.get('state') !== pending.state) return false;

    openDialog();
    if (params.has('error')) {
      dialogError = params.get('error') === 'access_denied'
        ? `${provider.name} access wasn’t granted, so sync is still off.`
        : `${provider.name} sign-in failed: ${params.get('error_description') || params.get('error')}`;
      renderDialog();
      return true;
    }

    busy = true;
    renderDialog();
    try {
      await useConnection(await provider.finishSignIn(params.get('code'), pending.verifier));
    } catch (e) {
      dialogError = e instanceof OfflineError
        ? `Couldn’t reach ${provider.name} to finish signing in. Check your connection and try again.`
        : `${provider.name} sign-in didn’t complete. Try connecting again.`;
    } finally {
      busy = false;
      renderDialog();
    }
    return true;
  }

  // ==========================================================================
  // UI: header button, storage notes, sync dialog
  // ==========================================================================

  const syncBtn = document.getElementById('syncBtn');
  const syncLabel = document.getElementById('syncLabel');
  const storageNote = document.getElementById('storageNote');
  const footerNote = document.getElementById('footerNote');
  const syncModal = document.getElementById('syncModal');
  const syncBody = document.getElementById('syncBody');
  const closeSyncModalBtn = document.getElementById('closeSyncModalBtn');

  let dialogView = 'main'; // main | gist
  let dialogError = '';
  let busy = false;
  let gistTokenDraft = '';

  const STATUS_LABELS = {
    off: 'Sync',
    idle: 'Synced',
    pending: 'Syncing…',
    syncing: 'Syncing…',
    offline: 'Offline',
    auth: 'Reconnect',
    error: 'Sync error'
  };

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function timeAgo(ms) {
    if (!ms) return 'Not yet';
    const seconds = Math.round((Date.now() - ms) / 1000);
    if (seconds < 45) return 'Just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderStatus() {
    const provider = connection && providerById(connection.provider);

    syncBtn.dataset.status = status;
    syncLabel.textContent = STATUS_LABELS[status];
    syncBtn.title = provider
      ? `${provider.name}: ${status === 'idle' ? 'last synced ' + timeAgo(connection.lastSyncedAt).toLowerCase() : STATUS_LABELS[status].toLowerCase()}`
      : 'Sync your jobs across devices';

    if (provider) {
      storageNote.textContent = `synced with ${provider.name}`;
      footerNote.textContent = `Your list is saved in this browser and in your ${provider.name}. Rolebin has no server; this page talks to ${provider.name} directly.`;
    } else {
      storageNote.textContent = 'stored only in this browser';
      footerNote.textContent = 'Nothing leaves this device. Clearing site data erases your list, so turn on sync or export a backup now and then.';
    }

    if (syncModal.open) renderDialog();
  }

  function renderDialog() {
    // Rendering replaces the dialog's buttons; keep keyboard focus inside it
    const hadFocus = syncBody.contains(document.activeElement);
    const errorHtml = dialogError ? `<p class="warning-alert" role="alert">${escapeHtml(dialogError)}</p>` : '';

    if (connection) {
      syncBody.innerHTML = renderConnected();
    } else if (dialogView === 'gist') {
      syncBody.innerHTML = errorHtml + renderGistForm();
      const input = document.getElementById('gistToken');
      input.value = gistTokenDraft;
      if (!busy) input.focus();
      return;
    } else {
      syncBody.innerHTML = errorHtml + renderChooser();
    }

    if (hadFocus || document.activeElement === document.body) {
      const target = syncBody.querySelector('.btn-primary:not([disabled]), .provider-option:not([disabled]), button:not([disabled])');
      if (target) target.focus();
    }
  }

  function renderChooser() {
    const options = PROVIDERS
      .slice()
      .sort((a, b) => Number(isConfigured(b)) - Number(isConfigured(a)))
      .map(provider => {
        const available = isConfigured(provider);
        return `
          <li>
            <button type="button" class="provider-option" data-provider="${provider.id}"${available && !busy ? '' : ' disabled'}>
              <span class="provider-name">${escapeHtml(provider.name)}</span>
              <span class="provider-detail">${escapeHtml(available ? provider.detail : 'Not set up on this copy of Rolebin yet.')}</span>
            </button>
          </li>`;
      }).join('');

    return `
      <p class="sync-intro">Keep your list in your own cloud storage so it’s the same on your phone and computer. Rolebin reads and writes one file, <code>${FILE_NAME}</code>, and nothing else.</p>
      <p class="sync-intro">Jobs already on this device are combined with any already in the cloud.</p>
      ${busy ? '<p class="sync-intro" role="status">Connecting…</p>' : ''}
      <ul class="provider-list" aria-label="Choose where to sync">${options}</ul>
    `;
  }

  function renderGistForm() {
    return `
      <form id="gistForm" class="sync-form" novalidate>
        <p class="sync-intro">
          Create a GitHub token with the <strong>gist</strong> permission, then paste it here.
          <a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=Rolebin" target="_blank" rel="noopener noreferrer" class="link-btn">Create a token on GitHub<span class="visually-hidden"> (opens in new tab)</span> &nearr;</a>
        </p>
        <p class="warning-alert">A secret gist is unlisted, not private: anyone who gets its link can read it. The token is stored in this browser.</p>
        <div class="field">
          <label for="gistToken">GitHub token</label>
          <input type="password" id="gistToken" autocomplete="off" spellcheck="false" placeholder="ghp_… or github_pat_…" required${busy ? ' disabled' : ''}>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-sync-action="back"${busy ? ' disabled' : ''}>Back</button>
          <button type="submit" class="btn btn-primary"${busy ? ' disabled' : ''}>${busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      </form>
    `;
  }

  function renderConnected() {
    const provider = providerById(connection.provider);
    const where = connection.account
      ? `${escapeHtml(provider.name)} <span class="sync-account">(${escapeHtml(connection.account)})</span>`
      : escapeHtml(provider.name);
    const isBusy = busy || status === 'syncing';
    const problem = ['auth', 'error', 'offline'].includes(status)
      ? `<p class="warning-alert" role="alert">${escapeHtml(statusMessage)}</p>`
      : '';
    const primary = status === 'auth'
      ? `<button type="button" class="btn btn-primary" data-sync-action="reconnect"${busy ? ' disabled' : ''}>Reconnect to ${escapeHtml(provider.name)}</button>`
      : `<button type="button" class="btn btn-primary" data-sync-action="sync"${isBusy ? ' disabled' : ''}>${isBusy ? 'Syncing…' : 'Sync now'}</button>`;

    return `
      ${dialogError ? `<p class="warning-alert" role="alert">${escapeHtml(dialogError)}</p>` : ''}
      <dl class="sync-details">
        <div><dt>Saved to</dt><dd>${where}</dd></div>
        <div><dt>Last synced</dt><dd>${escapeHtml(timeAgo(connection.lastSyncedAt))}</dd></div>
      </dl>
      ${problem}
      <div class="modal-footer sync-footer">
        <button type="button" class="btn btn-secondary" data-sync-action="disconnect"${busy ? ' disabled' : ''}>Disconnect</button>
        ${primary}
      </div>
      <p class="field-hint">Disconnecting stops syncing on this device. Your jobs stay here, and the file stays in ${escapeHtml(provider.name)}.</p>
    `;
  }

  function openDialog() {
    dialogError = '';
    if (!connection) dialogView = 'main';
    if (isConfigured(googleDrive)) googleDrive.prepare().catch(() => {});
    renderDialog();
    if (!syncModal.open) syncModal.showModal();
  }

  async function runDialogAction(action) {
    dialogError = '';
    busy = true;
    renderDialog();
    try {
      await action();
    } catch (e) {
      dialogError = e instanceof OfflineError
        ? 'Couldn’t reach the service. Check your connection and try again.'
        : e.message || 'Something went wrong. Try again.';
    } finally {
      busy = false;
      renderDialog();
    }
  }

  function handleDialogClick(e) {
    const option = e.target.closest('.provider-option');
    if (option && !option.disabled) {
      const provider = providerById(option.dataset.provider);
      if (provider.usesToken) {
        dialogView = 'gist';
        dialogError = '';
        renderDialog();
        return;
      }
      runDialogAction(async () => {
        const next = await provider.connect();
        if (next) await useConnection(next); // redirect providers leave the page instead
      });
      return;
    }

    const button = e.target.closest('[data-sync-action]');
    if (!button || button.disabled) return;

    switch (button.dataset.syncAction) {
      case 'back':
        dialogView = 'main';
        dialogError = '';
        renderDialog();
        break;
      case 'sync':
        dialogError = '';
        syncNow();
        break;
      case 'disconnect':
        disconnect();
        break;
      case 'reconnect':
        runDialogAction(async () => {
          const provider = providerById(connection.provider);
          if (provider.usesToken) {
            disconnect();
            dialogView = 'gist';
            return;
          }
          const next = await provider.reconnect(connection);
          if (next) await useConnection(next);
        });
        break;
    }
  }

  function handleDialogSubmit(e) {
    if (e.target.id !== 'gistForm') return;
    e.preventDefault();

    const token = document.getElementById('gistToken').value.trim();
    gistTokenDraft = token;
    if (!token) {
      dialogError = 'Paste your GitHub token first.';
      renderDialog();
      return;
    }

    runDialogAction(async () => {
      try {
        await useConnection(await gist.connectWithToken(token));
        gistTokenDraft = '';
      } catch (err) {
        if (err instanceof AuthError) throw new Error('GitHub didn’t accept that token. Check it was copied in full and hasn’t expired.');
        throw err;
      }
    });
  }

  // ==========================================================================
  // Init
  // ==========================================================================

  function init() {
    syncBtn.addEventListener('click', openDialog);
    closeSyncModalBtn.addEventListener('click', () => syncModal.close());
    syncBody.addEventListener('click', handleDialogClick);
    syncBody.addEventListener('submit', handleDialogSubmit);

    let pressedOnBackdrop = false;
    syncModal.addEventListener('mousedown', e => { pressedOnBackdrop = e.target === syncModal; });
    syncModal.addEventListener('click', e => {
      if (pressedOnBackdrop && e.target === syncModal && !busy) syncModal.close();
      pressedOnBackdrop = false;
    });

    Store.subscribe(source => {
      if (source === 'local') scheduleSync();
    });

    document.addEventListener('visibilitychange', () => {
      if (!connection) return;
      if (document.visibilityState === 'hidden' && changeTimer) {
        syncNow(); // leaving the tab: don't wait out the delay
      } else if (document.visibilityState === 'visible' &&
                 Date.now() - (connection.lastSyncedAt || 0) > REFOCUS_SYNC_AFTER_MS) {
        syncNow();
      }
    });
    window.addEventListener('online', syncNow);

    renderStatus();

    if (connection && connection.provider === googleDrive.id) {
      googleDrive.prepare().catch(() => {});
    }

    finishRedirectSignIn().then(handled => {
      if (!handled && connection) syncNow();
    });
  }

  init();
})();
