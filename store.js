/**
 * Rolebin store: the job list, deletion records, and localStorage persistence.
 * Shared by the UI (app.js) and cloud sync (sync.js).
 */

(function () {
  'use strict';

  const JOBS_KEY = 'rolebin_jobs_v1';
  const LEGACY_JOBS_KEY = 'job_tracker_data_v1';
  const DELETED_KEY = 'rolebin_deleted_v1';

  const STATUSES = ['Saved', 'Applied', 'Interview', 'Rejected', 'Offer'];

  // A deletion record lets a delete on one device reach the others. After this
  // long, any device that still syncs has seen it, so it can be dropped.
  const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

  let jobs = [];
  let deleted = [];
  let saveFailed = false;
  const listeners = new Set();

  // ==========================================================================
  // Validation
  // ==========================================================================

  function generateId() {
    return 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  }

  function asString(value) {
    return typeof value === 'string' ? value : '';
  }

  function asTime(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Coerce anything read from storage, the cloud, or an imported file into a
  // well-formed job. Returns null for entries that can't be a job (no title).
  function sanitizeJob(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const title = asString(raw.title).trim();
    if (!title) return null;

    const dateAdded = asString(raw.dateAdded);
    // Jobs saved before sync existed only have a display date
    const createdAt = asTime(raw.createdAt) || asTime(Date.parse(dateAdded));

    return {
      id: asString(raw.id) || generateId(),
      title: title,
      company: asString(raw.company).trim(),
      link: asString(raw.link).trim(),
      platform: asString(raw.platform).trim(),
      status: STATUSES.includes(raw.status) ? raw.status : 'Saved',
      notes: asString(raw.notes).trim(),
      dateAdded: dateAdded,
      createdAt: createdAt,
      updatedAt: asTime(raw.updatedAt) || createdAt
    };
  }

  function sanitizeJobList(list) {
    if (!Array.isArray(list)) return [];
    const seenIds = new Set();
    return list.map(sanitizeJob).filter(job => {
      if (!job) return false;
      if (seenIds.has(job.id)) job.id = generateId();
      seenIds.add(job.id);
      return true;
    });
  }

  function sanitizeTombstones(list) {
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    const latest = new Map();

    list.forEach(entry => {
      if (!entry || typeof entry.id !== 'string' || !entry.id) return;
      const deletedAt = asTime(entry.deletedAt);
      if (!deletedAt || now - deletedAt > TOMBSTONE_TTL_MS) return;
      latest.set(entry.id, Math.max(deletedAt, latest.get(entry.id) || 0));
    });

    return [...latest]
      .map(([id, deletedAt]) => ({ id, deletedAt }))
      .sort((a, b) => compareIds(a.id, b.id));
  }

  function compareIds(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // Newest first. Ties (old jobs added the same day) fall back to the id, which
  // embeds the creation timestamp, so every device orders the list the same way.
  function sortNewestFirst(list) {
    return list.sort((a, b) => (b.createdAt - a.createdAt) || compareIds(b.id, a.id));
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================

  function readJson(key) {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }

  function load() {
    try {
      jobs = sortNewestFirst(sanitizeJobList(readJson(JOBS_KEY) ?? readJson(LEGACY_JOBS_KEY)));
      deleted = sanitizeTombstones(readJson(DELETED_KEY));
    } catch (e) {
      console.error('Failed to load jobs from localStorage:', e);
      jobs = [];
      deleted = [];
    }
  }

  function persist() {
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
      localStorage.setItem(DELETED_KEY, JSON.stringify(deleted));
      saveFailed = false;
    } catch (e) {
      console.error('Failed to save jobs to localStorage:', e);
      saveFailed = true;
    }
  }

  // source: 'local' (the user changed something), 'remote' (sync pulled changes),
  // or 'external' (another tab changed storage)
  function commit(source) {
    persist();
    listeners.forEach(fn => fn(source));
  }

  // ==========================================================================
  // Operations
  // ==========================================================================

  function addJob(fields) {
    const now = Date.now();
    const job = sanitizeJob(Object.assign({}, fields, {
      id: generateId(),
      dateAdded: formatDate(now),
      createdAt: now,
      updatedAt: now
    }));
    if (!job) return null;

    jobs.unshift(job);
    commit('local');
    return job;
  }

  function updateJob(id, fields) {
    const index = jobs.findIndex(j => j.id === id);
    if (index === -1) return null;

    const job = sanitizeJob(Object.assign({}, jobs[index], fields, { id: id, updatedAt: Date.now() }));
    if (!job) return null;

    jobs[index] = job;
    commit('local');
    return job;
  }

  function deleteJob(id) {
    const remaining = jobs.filter(j => j.id !== id);
    if (remaining.length === jobs.length) return;

    jobs = remaining;
    deleted = sanitizeTombstones(deleted.concat({ id: id, deletedAt: Date.now() }));
    commit('local');
  }

  // Import a backup: it becomes the whole list, on this device and (via sync) everywhere.
  function replaceAll(list) {
    const now = Date.now();
    const incoming = sanitizeJobList(list).map(job => Object.assign(job, { updatedAt: now }));
    const keptIds = new Set(incoming.map(j => j.id));
    const removed = jobs.filter(j => !keptIds.has(j.id)).map(j => ({ id: j.id, deletedAt: now }));

    jobs = sortNewestFirst(incoming);
    deleted = sanitizeTombstones(deleted.filter(t => !keptIds.has(t.id)).concat(removed));
    commit('local');
  }

  // ==========================================================================
  // Sync support
  // ==========================================================================

  function snapshot() {
    return { app: 'rolebin', version: 1, savedAt: Date.now(), jobs: jobs, deleted: deleted };
  }

  // Fold a copy from the cloud into the local list. For each job the most
  // recently edited version wins; a delete wins over edits made before it.
  // Returns whether the cloud copy is missing anything and needs rewriting.
  function mergeRemote(remote) {
    const remoteJobs = sortNewestFirst(sanitizeJobList(remote ? remote.jobs : []));
    const remoteDeleted = sanitizeTombstones(remote ? remote.deleted : []);

    const mergedDeleted = sanitizeTombstones(deleted.concat(remoteDeleted));
    const deletedAt = new Map(mergedDeleted.map(t => [t.id, t.deletedAt]));

    const byId = new Map(jobs.map(j => [j.id, j]));
    remoteJobs.forEach(job => {
      const local = byId.get(job.id);
      if (!local || job.updatedAt > local.updatedAt) byId.set(job.id, job);
    });

    const mergedJobs = sortNewestFirst(
      [...byId.values()].filter(job => !(deletedAt.get(job.id) >= job.updatedAt))
    );

    const fingerprint = (j, d) => JSON.stringify([j, d]);
    const merged = fingerprint(mergedJobs, mergedDeleted);

    if (merged !== fingerprint(sortNewestFirst(jobs.slice()), deleted)) {
      jobs = mergedJobs;
      deleted = mergedDeleted;
      commit('remote');
    }

    return { needsPush: !remote || merged !== fingerprint(remoteJobs, remoteDeleted) };
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  // Keep tabs in step: another tab (or its sync) wrote to storage
  window.addEventListener('storage', e => {
    if (e.key === null || e.key === JOBS_KEY || e.key === DELETED_KEY) {
      load();
      listeners.forEach(fn => fn('external'));
    }
  });

  load();

  window.RolebinStore = {
    STATUSES: STATUSES,
    getJobs: () => jobs,
    findJob: id => jobs.find(j => j.id === id) || null,
    addJob: addJob,
    updateJob: updateJob,
    deleteJob: deleteJob,
    replaceAll: replaceAll,
    sanitizeJobList: sanitizeJobList,
    snapshot: snapshot,
    mergeRemote: mergeRemote,
    saveFailed: () => saveFailed,
    subscribe: fn => listeners.add(fn)
  };
})();
