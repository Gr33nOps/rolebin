/**
 * Rolebin - Pure Vanilla JavaScript Application
 * Zero dependencies, works completely offline with localStorage
 */

(function () {
  'use strict';

  // Storage keys (legacy key is read once and migrated)
  const STORAGE_KEY = 'rolebin_jobs_v1';
  const LEGACY_STORAGE_KEY = 'job_tracker_data_v1';

  const STATUSES = ['Saved', 'Applied', 'Interview', 'Rejected', 'Offer'];

  // Application State
  let jobs = [];
  let currentFilter = 'All';
  let searchQuery = '';
  let pendingDeleteJobId = null;

  // DOM Elements
  const jobsList = document.getElementById('jobsList');
  const emptyState = document.getElementById('emptyState');
  const emptyMessage = document.getElementById('emptyMessage');
  const emptyHint = document.getElementById('emptyHint');
  const emptyAddBtn = document.getElementById('emptyAddBtn');
  const storageError = document.getElementById('storageError');

  // Search & Filter Elements
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const filterTabs = document.querySelectorAll('.filter-tab');

  // Job Modal Elements
  const jobModal = document.getElementById('jobModal');
  const jobForm = document.getElementById('jobForm');
  const modalTitle = document.getElementById('modalTitle');
  const addJobBtn = document.getElementById('addJobBtn');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const cancelModalBtn = document.getElementById('cancelModalBtn');
  const saveJobBtn = document.getElementById('saveJobBtn');

  // Form Fields
  const jobIdInput = document.getElementById('jobId');
  const jobTitleInput = document.getElementById('jobTitle');
  const jobCompanyInput = document.getElementById('jobCompany');
  const jobLinkInput = document.getElementById('jobLink');
  const jobPlatformInput = document.getElementById('jobPlatform');
  const jobStatusInput = document.getElementById('jobStatus');
  const jobNotesInput = document.getElementById('jobNotes');
  const duplicateWarning = document.getElementById('duplicateWarning');
  const titleError = document.getElementById('titleError');
  const linkError = document.getElementById('linkError');

  // Delete Modal Elements
  const deleteModal = document.getElementById('deleteModal');
  const deleteJobDetails = document.getElementById('deleteJobDetails');
  const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
  const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  const closeDeleteModalBtn = document.getElementById('closeDeleteModalBtn');

  // Backup Export / Import Elements
  const exportBtn = document.getElementById('exportBtn');
  const importBtn = document.getElementById('importBtn');
  const importFileInput = document.getElementById('importFileInput');

  // ==========================================================================
  // Storage Functions
  // ==========================================================================

  function generateId() {
    return 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  }

  function asString(value) {
    return typeof value === 'string' ? value : '';
  }

  // Coerce anything read from storage or an imported file into a well-formed job.
  // Returns null for entries that can't be a job (no title).
  function sanitizeJob(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const title = asString(raw.title).trim();
    if (!title) return null;

    return {
      id: asString(raw.id) || generateId(),
      title: title,
      company: asString(raw.company).trim(),
      link: asString(raw.link).trim(),
      platform: asString(raw.platform).trim(),
      status: STATUSES.includes(raw.status) ? raw.status : 'Saved',
      notes: asString(raw.notes).trim(),
      dateAdded: asString(raw.dateAdded)
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

  function loadJobs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
      jobs = raw === null ? [] : sanitizeJobList(JSON.parse(raw));
    } catch (e) {
      console.error('Failed to load jobs from localStorage:', e);
      jobs = [];
    }
  }

  function saveJobs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
      storageError.hidden = true;
      return true;
    } catch (e) {
      console.error('Failed to save jobs to localStorage:', e);
      storageError.hidden = false;
      return false;
    }
  }

  // ==========================================================================
  // URL & Platform Helpers
  // ==========================================================================

  // Parse user input as an http(s) URL, adding https:// when no scheme is given.
  // Returns null for anything else (e.g. javascript:, data:, garbage).
  function parseHttpUrl(url) {
    if (!url || typeof url !== 'string') return null;
    let trimmed = url.trim();
    if (!trimmed) return null;

    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      trimmed = 'https://' + trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      if (!parsed.hostname.includes('.')) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function normalizeUrl(url) {
    const parsed = parseHttpUrl(url);
    if (!parsed) return '';

    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'refId', 'trackingId', 'trk', 'ref', 'source', 'fbclid', 'gclid'
    ];
    trackingParams.forEach(param => parsed.searchParams.delete(param));

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    const search = parsed.searchParams.toString();

    return `${host}${path}${search ? '?' + search : ''}`.toLowerCase();
  }

  function detectPlatform(url) {
    const parsed = parseHttpUrl(url);
    if (!parsed) return '';

    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const knownPlatforms = [
      ['linkedin.com', 'LinkedIn'],
      ['indeed.com', 'Indeed'],
      ['glassdoor.com', 'Glassdoor'],
      ['upwork.com', 'Upwork'],
      ['wellfound.com', 'Wellfound'],
      ['angel.co', 'Wellfound'],
      ['greenhouse.io', 'Greenhouse'],
      ['lever.co', 'Lever'],
      ['workable.com', 'Workable'],
      ['ashbyhq.com', 'Ashby']
    ];

    for (const [domain, name] of knownPlatforms) {
      if (host === domain || host.endsWith('.' + domain)) return name;
    }

    const parts = host.split('.');
    const brandName = parts.length >= 2 ? parts[parts.length - 2] : host;
    return brandName.charAt(0).toUpperCase() + brandName.slice(1);
  }

  function findDuplicateJob(url, currentJobId) {
    const normalizedTarget = normalizeUrl(url);
    if (!normalizedTarget) return null;

    return jobs.find(job => {
      if (currentJobId && job.id === currentJobId) return false;
      return normalizeUrl(job.link) === normalizedTarget;
    });
  }

  function formatCurrentDate() {
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    return new Date().toLocaleDateString('en-US', options);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================

  function renderSummary() {
    const counts = { All: jobs.length };
    STATUSES.forEach(status => { counts[status] = 0; });
    jobs.forEach(job => { counts[job.status]++; });

    filterTabs.forEach(tab => {
      tab.querySelector('.count').textContent = counts[tab.dataset.filter];
    });
  }

  function renderJobs() {
    renderSummary();

    const query = searchQuery.toLowerCase();
    const filtered = jobs.filter(job => {
      if (currentFilter !== 'All' && job.status !== currentFilter) return false;
      if (!query) return true;

      return [job.title, job.company, job.platform, job.notes]
        .some(value => value.toLowerCase().includes(query));
    });

    if (filtered.length === 0) {
      jobsList.innerHTML = '';
      emptyState.hidden = false;

      const isFirstUse = jobs.length === 0;
      emptyMessage.textContent = isFirstUse
        ? 'No jobs saved yet.'
        : 'No jobs match your search or filter.';
      emptyHint.hidden = !isFirstUse;
      emptyAddBtn.hidden = !isFirstUse;
      return;
    }

    emptyState.hidden = true;
    jobsList.innerHTML = filtered.map(createJobCardHtml).join('');
  }

  function createJobCardHtml(job) {
    const statusClass = 'status-' + job.status.toLowerCase();
    const safeLink = parseHttpUrl(job.link);
    const id = escapeHtml(job.id);
    const title = escapeHtml(job.title);

    const meta = [];
    if (job.company) meta.push(`<span class="job-company">${escapeHtml(job.company)}</span>`);
    if (job.platform) meta.push(`<span>${escapeHtml(job.platform)}</span>`);
    if (job.dateAdded) meta.push(`<span class="job-date">Added ${escapeHtml(job.dateAdded)}</span>`);

    const options = STATUSES.map(status =>
      `<option value="${status}"${job.status === status ? ' selected' : ''}>${status}</option>`
    ).join('');

    return `
      <article class="job-card" data-id="${id}">
        <div class="job-card-top">
          <h3 class="job-title">${title}</h3>
          <select class="status-select ${statusClass}" data-action="status" data-id="${id}" aria-label="Status for ${title}">
            ${options}
          </select>
        </div>

        ${meta.length ? `<div class="job-meta">${meta.join('<span class="meta-dot" aria-hidden="true">&middot;</span>')}</div>` : ''}

        ${job.notes ? `<p class="job-notes">${escapeHtml(job.notes)}</p>` : ''}

        <div class="job-actions">
          ${safeLink ? `<a href="${escapeHtml(safeLink.href)}" target="_blank" rel="noopener noreferrer" class="link-btn">Open posting<span class="visually-hidden"> for ${title} (opens in new tab)</span> &nearr;</a>` : ''}
          <div class="actions-right">
            <button type="button" class="link-btn" data-action="edit" data-id="${id}">Edit<span class="visually-hidden"> ${title}</span></button>
            <button type="button" class="link-btn-danger" data-action="delete" data-id="${id}">Delete<span class="visually-hidden"> ${title}</span></button>
          </div>
        </div>
      </article>
    `;
  }

  // One delegated listener for every card, instead of re-binding after each render
  function handleListClick(e) {
    const button = e.target.closest('button[data-action]');
    if (!button) return;

    if (button.dataset.action === 'edit') openEditModal(button.dataset.id);
    if (button.dataset.action === 'delete') openDeleteModal(button.dataset.id);
  }

  function handleListChange(e) {
    const select = e.target.closest('select[data-action="status"]');
    if (select) updateJobStatus(select.dataset.id, select.value);
  }

  // ==========================================================================
  // Job Actions
  // ==========================================================================

  function updateJobStatus(jobId, newStatus) {
    const job = jobs.find(j => j.id === jobId);
    if (!job || !STATUSES.includes(newStatus)) return;

    job.status = newStatus;
    saveJobs();
    renderJobs();

    // Re-render replaced the select; keep keyboard focus where the user was
    const select = jobsList.querySelector(`select[data-id="${CSS.escape(jobId)}"]`);
    if (select) select.focus();
  }

  function resetFormMessages() {
    duplicateWarning.hidden = true;
    titleError.textContent = '';
    linkError.textContent = '';
    jobTitleInput.removeAttribute('aria-invalid');
    jobLinkInput.removeAttribute('aria-invalid');
  }

  function openAddModal() {
    jobForm.reset();
    jobIdInput.value = '';
    modalTitle.textContent = 'Add Job';
    saveJobBtn.textContent = 'Save Job';
    resetFormMessages();
    jobStatusInput.value = 'Saved';

    jobModal.showModal();
    jobTitleInput.focus();
  }

  function openEditModal(jobId) {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    jobForm.reset();
    jobIdInput.value = job.id;
    jobTitleInput.value = job.title;
    jobCompanyInput.value = job.company;
    jobLinkInput.value = job.link;
    jobPlatformInput.value = job.platform;
    jobStatusInput.value = job.status;
    jobNotesInput.value = job.notes;

    modalTitle.textContent = 'Edit Job';
    saveJobBtn.textContent = 'Save Changes';
    resetFormMessages();

    jobModal.showModal();
    jobTitleInput.focus();
  }

  function closeJobModal() {
    jobModal.close();
  }

  function openDeleteModal(jobId) {
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    pendingDeleteJobId = jobId;
    deleteJobDetails.textContent = job.company ? `${job.title} at ${job.company}` : job.title;
    deleteModal.showModal();
    cancelDeleteBtn.focus();
  }

  function closeDeleteModal() {
    deleteModal.close();
  }

  function executeDeleteJob() {
    if (!pendingDeleteJobId) return;

    jobs = jobs.filter(j => j.id !== pendingDeleteJobId);
    saveJobs();
    closeDeleteModal();
    renderJobs();
    addJobBtn.focus();
  }

  // ==========================================================================
  // Form Handling & Duplicate Checking
  // ==========================================================================

  function validateUrlAndDetectPlatform() {
    const rawUrl = jobLinkInput.value.trim();
    linkError.textContent = '';
    jobLinkInput.removeAttribute('aria-invalid');

    if (!rawUrl) {
      duplicateWarning.hidden = true;
      return;
    }

    const detected = detectPlatform(rawUrl);
    if (detected && !jobPlatformInput.value) {
      jobPlatformInput.value = detected;
    }

    duplicateWarning.hidden = !findDuplicateJob(rawUrl, jobIdInput.value);
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    resetFormMessages();

    const title = jobTitleInput.value.trim();
    const company = jobCompanyInput.value.trim();
    const link = jobLinkInput.value.trim();
    const platform = jobPlatformInput.value.trim();
    const status = STATUSES.includes(jobStatusInput.value) ? jobStatusInput.value : 'Saved';
    const notes = jobNotesInput.value.trim();
    const editingId = jobIdInput.value;

    let firstInvalid = null;

    if (!title) {
      titleError.textContent = 'Job title is required.';
      jobTitleInput.setAttribute('aria-invalid', 'true');
      firstInvalid = jobTitleInput;
    }

    if (link && !parseHttpUrl(link)) {
      linkError.textContent = 'Enter a web address, like https://company.com/jobs/123.';
      jobLinkInput.setAttribute('aria-invalid', 'true');
      firstInvalid = firstInvalid || jobLinkInput;
    } else if (link && findDuplicateJob(link, editingId)) {
      duplicateWarning.hidden = false;
      jobLinkInput.setAttribute('aria-invalid', 'true');
      firstInvalid = firstInvalid || jobLinkInput;
    }

    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const fields = {
      title: title,
      company: company,
      link: link,
      platform: platform || detectPlatform(link) || 'Direct',
      status: status,
      notes: notes
    };

    if (editingId) {
      const job = jobs.find(j => j.id === editingId);
      if (job) Object.assign(job, fields);
    } else {
      jobs.unshift(Object.assign({ id: generateId(), dateAdded: formatCurrentDate() }, fields));
    }

    saveJobs();
    closeJobModal();
    renderJobs();
  }

  // ==========================================================================
  // Filters & Search Handling
  // ==========================================================================

  function setFilter(filterName) {
    currentFilter = filterName;

    filterTabs.forEach(tab => {
      const isActive = tab.dataset.filter === filterName;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-pressed', String(isActive));
    });

    renderJobs();
  }

  function handleSearchInput(e) {
    searchQuery = e.target.value.trim();
    clearSearchBtn.hidden = !searchQuery;
    renderJobs();
  }

  function clearSearch() {
    searchInput.value = '';
    searchQuery = '';
    clearSearchBtn.hidden = true;
    searchInput.focus();
    renderJobs();
  }

  // ==========================================================================
  // Backup: Export / Import JSON
  // ==========================================================================

  function exportBackup() {
    const blob = new Blob([JSON.stringify(jobs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    const dateStr = new Date().toISOString().split('T')[0];
    downloadAnchor.href = url;
    downloadAnchor.download = `rolebin_backup_${dateStr}.json`;
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function importBackup(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
      try {
        const parsed = JSON.parse(event.target.result);
        if (!Array.isArray(parsed)) {
          alert('This file is not a Rolebin backup. Expected a list of jobs.');
          return;
        }

        const imported = sanitizeJobList(parsed);
        const skipped = parsed.length - imported.length;
        const skippedNote = skipped ? `\n${skipped} entr${skipped === 1 ? 'y' : 'ies'} without a title will be skipped.` : '';

        if (confirm(`Import ${imported.length} job${imported.length === 1 ? '' : 's'}? This replaces your current list of ${jobs.length}.${skippedNote}`)) {
          jobs = imported;
          saveJobs();
          setFilter('All');
        }
      } catch (err) {
        alert('Could not read this file. Make sure it is a JSON backup exported from Rolebin.');
      } finally {
        importFileInput.value = '';
      }
    };
    reader.onerror = function () {
      alert('Could not read this file.');
      importFileInput.value = '';
    };
    reader.readAsText(file);
  }

  // ==========================================================================
  // Initialization & Event Binding
  // ==========================================================================

  // Close a dialog when a click starts and ends on its backdrop.
  // The dialog element itself has no padding, so e.target === dialog only on the backdrop.
  function enableBackdropDismiss(dialog) {
    let pressedOnBackdrop = false;
    dialog.addEventListener('mousedown', e => { pressedOnBackdrop = e.target === dialog; });
    dialog.addEventListener('click', e => {
      if (pressedOnBackdrop && e.target === dialog) dialog.close();
      pressedOnBackdrop = false;
    });
  }

  function init() {
    loadJobs();
    renderJobs();

    addJobBtn.addEventListener('click', openAddModal);
    emptyAddBtn.addEventListener('click', openAddModal);

    closeModalBtn.addEventListener('click', closeJobModal);
    cancelModalBtn.addEventListener('click', closeJobModal);
    jobForm.addEventListener('submit', handleFormSubmit);

    // Runs however the dialog closes (button, Esc, backdrop)
    jobModal.addEventListener('close', () => {
      jobForm.reset();
      resetFormMessages();
    });

    jobLinkInput.addEventListener('input', validateUrlAndDetectPlatform);

    cancelDeleteBtn.addEventListener('click', closeDeleteModal);
    closeDeleteModalBtn.addEventListener('click', closeDeleteModal);
    confirmDeleteBtn.addEventListener('click', executeDeleteJob);
    deleteModal.addEventListener('close', () => { pendingDeleteJobId = null; });

    enableBackdropDismiss(jobModal);
    enableBackdropDismiss(deleteModal);

    jobsList.addEventListener('click', handleListClick);
    jobsList.addEventListener('change', handleListChange);

    searchInput.addEventListener('input', handleSearchInput);
    clearSearchBtn.addEventListener('click', clearSearch);

    filterTabs.forEach(tab => {
      tab.addEventListener('click', () => setFilter(tab.dataset.filter));
    });

    exportBtn.addEventListener('click', exportBackup);
    importBtn.addEventListener('click', () => importFileInput.click());
    importFileInput.addEventListener('change', importBackup);

    // Ctrl+K / Cmd+K focuses search (ignored while a dialog is open)
    window.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        if (jobModal.open || deleteModal.open) return;
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
