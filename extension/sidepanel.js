
const $ = (id) => document.getElementById(id);

const DEFAULT_API = 'https://menixjobai-api.onrender.com/api';

let apiBase = DEFAULT_API;
let lastAnalysis = null;
let generatedBlobUrl = null;
let generatedFilename = '';
let resumeFileName = '';
let resumeIsSaved = false;
let resumeFileSize = 0;
let resumeTextEdited = false;
let profileResume = null;
let generatedResumes = [];
let currentJobTabUrl = '';
let captureRequestId = 0;
let captureDebounceTimer = null;
let jobMetadata = {};
let automaticAnalysisTimer = null;
let lastAutomaticAnalysisInput = '';
let analysisPromise = null;
let recruiterContact = null;

function renderRecruiterContact(state = 'checking') {
  const content = $('recruiterContactContent');
  const badge = $('recruiterContactState');
  if (!content || !badge) return;
  badge.textContent = ({ checking: 'Checking…', error: 'Could not check', none: 'Unavailable' })[state] || 'Available';
  content.replaceChildren();
  if (state === 'checking') { content.textContent = 'Checking this job listing…'; return; }
  if (state === 'error') {
    content.append(document.createTextNode('Could not inspect this listing. '));
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'contact-link'; retry.textContent = 'Retry';
    retry.addEventListener('click', () => captureActiveJob()); content.append(retry); return;
  }
  const details = recruiterContact || {};
  if (!(details.name || details.email || details.phone || details.profileUrl || details.websiteUrl)) {
    content.textContent = 'No recruiter contact details found in this job listing.'; return;
  }
  const foundCount = [details.name, details.email, details.phone, details.profileUrl, details.websiteUrl].filter(Boolean).length;
  badge.textContent = foundCount > 1 ? 'Contact Found' : 'Partially Available';
  const entries = [
    ['Recruiter', details.name], ['Email', details.email], ['Phone', details.phone],
    ['Company', details.company], ['Designation', details.designation]
  ].filter(([, value]) => value);
  if (!entries.length && !details.profileUrl && !details.websiteUrl) {
    content.textContent = 'No recruiter contact details found in this job listing.'; return;
  }
  entries.forEach(([label, value]) => {
    const row = document.createElement('div'); row.className = 'contact-row';
    const key = document.createElement('strong'); key.textContent = `${label}:`;
    const text = document.createElement('span'); text.textContent = value;
    row.append(key, text);
    if (label === 'Email' || label === 'Phone') {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'contact-link'; button.textContent = `Copy ${label}`;
      button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(value); button.textContent = 'Copied'; } catch { button.textContent = 'Copy unavailable'; } }); row.append(button);
    }
    content.append(row);
  });
  for (const [label, value] of [['Open Recruiter Profile', details.profileUrl], ['Open Company Website', details.websiteUrl]]) {
    if (!value) continue;
    const link = document.createElement('a'); link.className = 'contact-link'; link.href = value; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label; content.append(link);
  }
}

const RESUME_DB_NAME = 'menixjobai-resumes';
const RESUME_STORE_NAME = 'files';

// ------------------------------
// STATUS
// ------------------------------

function setStatus(message, type = 'info') {
  const el = $('status');

  if (!el) return;

  el.textContent = message;
  el.dataset.type = type;
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function openResumeDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RESUME_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RESUME_STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local resume storage.'));
  });
}

async function storeResumeFile(id, file, name) {
  const database = await openResumeDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(RESUME_STORE_NAME, 'readwrite');
    transaction.objectStore(RESUME_STORE_NAME).put({ id, file, name });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not save resume file locally.'));
    transaction.onabort = () => reject(transaction.error || new Error('Resume file storage was interrupted.'));
  });
  database.close();
}

async function readResumeFile(id) {
  const database = await openResumeDatabase();
  const value = await new Promise((resolve, reject) => {
    const request = database.transaction(RESUME_STORE_NAME, 'readonly')
      .objectStore(RESUME_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Could not read the saved resume file.'));
  });
  database.close();
  return value;
}

async function deleteResumeFile(id) {
  const database = await openResumeDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(RESUME_STORE_NAME, 'readwrite');
    transaction.objectStore(RESUME_STORE_NAME).delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not remove the saved resume file.'));
  });
  database.close();
}

// ------------------------------
// JOB DATA
// ------------------------------

function currentJobPayload() {
  return {
    title: cleanText($('jobTitleInput').value) || 'Untitled job',
    company: cleanText($('companyInput').value),
    location: cleanText($('locationInput').value),
    description: $('jobDescription').value.trim(),
    url: cleanText($('jobUrl').value)
  };
}

// ------------------------------
// API REQUEST
// ------------------------------

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);

  if (!response.ok) {
    throw new Error(await responseError(response));
  }

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response;
}

async function responseError(response) {
  const body = await response.text();
  if (body) {
    try {
      const error = JSON.parse(body);
      const message = error.message || error.detail || error.title || error.error?.message;
      if (message) return message;
      if (typeof error.error === 'string' && error.error !== 'Internal Server Error') return error.error;
    } catch {
      if (!body.trim().startsWith('{') && !/(?:\bat\s+[\w.$]+\(|Exception|Error:)/i.test(body)) {
        return body.slice(0, 240);
      }
    }
  }
  if (response.status >= 500) {
    return `The analysis backend returned HTTP ${response.status}. The AI route is failing server-side. Check the Render service logs at this request time for /api/ai/tailor-review, verify GEMINI_API_KEY and GEMINI_MODEL, then redeploy the backend after fixing the logged cause.`;
  }
  return `Request failed (${response.status}). Please try again.`;
}

function updateResumeCard(fileName = resumeFileName) {
  resumeFileName = fileName || '';
  const hasResume = Boolean($('resumeText').value.trim());
  $('resumeName').textContent = resumeFileName || (hasResume ? 'Saved master resume' : 'No resume uploaded');
  const fileExtension = (resumeFileName.split('.').pop() || '').toLowerCase();
  const fileIcon = $('resumeFileIcon');
  const iconType = fileExtension === 'pdf' ? 'PDF' : ['doc', 'docx'].includes(fileExtension) ? 'DOC' : '';
  fileIcon.classList.toggle('pdf-file-icon', iconType === 'PDF');
  fileIcon.classList.toggle('doc-file-icon', iconType === 'DOC');
  fileIcon.classList.toggle('unknown-file-icon', !iconType);
  fileIcon.innerHTML = createResumeFileIcon(iconType || 'FILE');
  fileIcon.setAttribute('aria-label', iconType ? `${iconType} resume file` : 'Resume file');
  const sizeLabel = resumeFileSize ? `${Math.round(resumeFileSize / 1024)} KB · ` : '';
  $('resumeStatus').textContent = !hasResume
    ? 'Choose your master resume'
    : resumeIsSaved
      ? `${sizeLabel}Saved in this browser`
      : 'Unsaved changes · Save from resume details';
  $('masterResumeBadge').textContent = !hasResume
    ? 'Not saved'
    : resumeIsSaved
      ? '✓ Saved'
      : 'Unsaved';
  $('masterResumeBadge').classList.toggle('success-badge', hasResume && resumeIsSaved);
}

function updateProfileResumeCard() {
  $('profileResumeName').textContent = profileResume?.name || 'No profile resume selected';
  $('profileResumeStatus').textContent = profileResume
    ? `${profileResume.type || 'Resume file'} · Selected ${profileResume.selectedAt ? formatDate(profileResume.selectedAt) : 'now'}`
    : 'Choose a PDF or DOCX. Your master resume stays separate.';
  $('profilePreview').classList.toggle('hidden', !profileResume);
  $('downloadProfileResumeBtn').classList.toggle('hidden', !profileResume);
  $('profilePreviewMeta').textContent = profileResume
    ? `${profileResume.name} · ${profileResume.type || 'Unknown file type'}`
    : '';
  $('profilePreviewText').textContent = profileResume?.text
    ? `${profileResume.text.slice(0, 900)}${profileResume.text.length > 900 ? '…' : ''}`
    : 'Text preview is unavailable for this saved file. Verify the filename before uploading.';
  $('confirmProfileUploadBtn').disabled = !profileResume || !$('profileUploadConfirmed').checked;
}

function updateJobSummary() {
  const title = cleanText($('jobTitleInput').value);
  const company = cleanText($('companyInput').value);
  const location = cleanText($('locationInput').value);
  const hasDescription = Boolean($('jobDescription').value.trim());
  $('jobTitle').textContent = title || 'No job captured yet';
  $('companyMark').textContent = (company || title || 'J').slice(0, 1).toUpperCase();
  $('companyLogo').onerror = () => {
    $('companyLogo').classList.add('hidden');
    $('companyMark').classList.remove('hidden');
  };
  let companyLogo = '';
  try {
    const parsedLogoUrl = new URL(jobMetadata.companyLogo || '');
    if (parsedLogoUrl.protocol === 'https:') companyLogo = parsedLogoUrl.href;
  } catch {
    companyLogo = '';
  }
  if (companyLogo) {
    if ($('companyLogo').src !== companyLogo) $('companyLogo').src = companyLogo;
    $('companyLogo').classList.remove('hidden');
    $('companyMark').classList.add('hidden');
  } else {
    $('companyLogo').removeAttribute('src');
    $('companyLogo').classList.add('hidden');
    $('companyMark').classList.remove('hidden');
  }
  $('jobCompanyName').textContent = company || (hasDescription ? 'Job details detected on this page' : 'Open a job listing to detect its details');
  const ratingText = jobMetadata.rating ? `★ ${jobMetadata.rating}` : '';
  $('jobRating').textContent = ratingText;
  $('jobRating').classList.toggle('hidden', !ratingText);
  const tags = $('jobTags');
  tags.replaceChildren();
  const tagValues = [
    jobMetadata.experience || extractExperienceTags($('jobDescription').value)[0],
    jobMetadata.salary,
    jobMetadata.location || location
  ].filter(Boolean).filter((value, index, values) => {
    const normalize = item => item.toLowerCase().replace(/\b(?:years?|yrs?)\b/g, '').replace(/[^a-z0-9]/g, '');
    return values.findIndex(candidate => normalize(candidate) === normalize(value)) === index;
  }).slice(0, 3);
  tagValues.forEach(value => {
    const tag = document.createElement('span');
    tag.className = 'job-tag';
    tag.textContent = value;
    tags.append(tag);
  });
}

function createResumeFileIcon(type) {
  if (type === 'DOC') {
    return `<svg viewBox="0 0 496 512" width="27" height="28" role="img" aria-label="Microsoft Word document" xmlns="http://www.w3.org/2000/svg">
      <path fill="#41A5EE" d="M275.3 0H464c17.7 0 32 14.3 32 32v448c0 17.7-14.3 32-32 32H192V0z"/>
      <path fill="#2B7CD3" d="M192 0h272c17.7 0 32 14.3 32 32v104H192z"/>
      <path fill="#185ABD" d="M192 136h304v136H192z"/>
      <path fill="#103F91" d="M192 272h304v104H192z"/>
      <path fill="#0C2E6B" d="M192 376h304v104c0 17.7-14.3 32-32 32H192z"/>
      <rect x="0" y="112" width="304" height="288" rx="28" fill="#185ABD"/>
      <path fill="#fff" d="m59 196 31 0 24 126 32-126h34l32 126 25-126h31l-42 177h-34l-30-119-30 119H98z"/>
    </svg>`;
  }

  const accent = type === 'PDF' ? '#ef4444' : '#94a3b8';
  const label = type;
  return `<svg viewBox="0 0 32 36" width="25" height="28" role="img" aria-label="${label} file">
    <path d="M6 2.5h13l7 7V33H6z" fill="#f8fafc" stroke="${accent}" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M19 2.5v7h7" fill="#dbeafe" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M10 14h12M10 17h12" stroke="#94a3b8" stroke-width="1.2" stroke-linecap="round"/>
    <rect x="8" y="21" width="18" height="8" rx="1.8" fill="${accent}"/>
    <text x="17" y="26.8" fill="#fff" font-family="Arial,sans-serif" font-size="${label.length > 3 ? 5 : 6}" font-weight="700" text-anchor="middle">${label}</text>
  </svg>`;
}

function extractExperienceTags(description) {
  const match = description.match(/\b\d+\s*[-–]\s*\d+\s*(?:years?|yrs?)\b|\b\d+\+?\s*(?:years?|yrs?)\b/i);
  return match ? [match[0].replace(/\s+/g, ' ')] : [];
}

function cleanCompanyName(company) {
  return cleanText(company.replace(/\s*[★·|]?\s*[0-5](?:\.\d)?\s*[\d,.]+\s*[KMB]?\s*Reviews?.*$/i, ''));
}

function invalidateAnalysis() {
  if (generatedBlobUrl) URL.revokeObjectURL(generatedBlobUrl);
  generatedBlobUrl = null;
  generatedFilename = '';
  lastAnalysis = null;
  lastAutomaticAnalysisInput = '';
  if (automaticAnalysisTimer) {
    window.clearTimeout(automaticAnalysisTimer);
    automaticAnalysisTimer = null;
  }
  $('analysis').classList.add('hidden');
  $('analysis').replaceChildren();
  renderAnalysisPlaceholders();
  $('generateBtn').disabled = true;
  updatePrimaryAction();
  $('fileResult').classList.add('hidden');
  updateActionBar();
}

function scheduleAutomaticAnalysis() {
  const resumeText = $('resumeText').value.trim();
  const jobDescription = $('jobDescription').value.trim();
  if (!resumeText || !jobDescription || lastAnalysis) return;

  const inputKey = JSON.stringify([resumeText, jobDescription]);
  if (inputKey === lastAutomaticAnalysisInput) return;
  if (automaticAnalysisTimer) window.clearTimeout(automaticAnalysisTimer);
  automaticAnalysisTimer = window.setTimeout(() => {
    automaticAnalysisTimer = null;
    if (inputKey !== JSON.stringify([
      $('resumeText').value.trim(),
      $('jobDescription').value.trim()
    ])) return;
    lastAutomaticAnalysisInput = inputKey;
    void analyzeCurrentMatch(true);
  }, 350);
}

function switchView(viewId) {
  document.querySelectorAll('.view').forEach(view => {
    view.classList.toggle('hidden', view.id !== viewId);
  });
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === viewId);
  });
  updateActionBar();
  if (viewId === 'historyView') loadHistory().catch(error => setStatus(`Could not load history: ${error.message}`, 'error'));
  if (viewId === 'savedView') loadSavedJobs().catch(error => setStatus(`Could not load saved jobs: ${error.message}`, 'error'));
}

function updateActionBar() {
  const isApplyView = !$('applyView').classList.contains('hidden')
    && $('settings').classList.contains('hidden');
  $('actionBar').classList.toggle('hidden', !isApplyView);
  updatePrimaryAction();
}

function updatePrimaryAction() {
  const button = $('generateBtn');
  if (!button) return;
  if (analysisPromise) {
    button.disabled = true;
    button.textContent = 'Analyzing Resume…';
  } else if (!lastAnalysis) {
    const ready = Boolean($('resumeText')?.value.trim() && $('jobDescription')?.value.trim());
    button.disabled = !ready;
    button.textContent = ready ? '✦  Analyze & Tailor Resume' : 'Add Resume and Open a Job';
  } else {
    button.disabled = false;
    button.textContent = generatedBlobUrl ? '↓  Download Tailored Resume Again' : '↓  Download Tailored Resume (DOCX)';
  }
}

function updateJobApplicationButton() {
  const validJobUrl = /^https?:\/\//i.test(cleanText($('jobUrl').value));
  $('openJobBtn').classList.toggle('hidden', !validJobUrl);
}

function safeFilenamePart(value) {
  return cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Job';
}

async function openJobApplication() {
  const url = cleanText($('jobUrl').value);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return setStatus('This job does not have a valid application URL.', 'error');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return setStatus('Only HTTP or HTTPS job links can be opened.', 'error');
  }
  try {
    await chrome.tabs.create({ url: parsed.href, active: true });
    setStatus('Job application opened. Attach the downloaded resume and submit only after reviewing it.', 'success');
  } catch (error) {
    setStatus(`Could not open the job application: ${error.message}`, 'error');
  }
}

// ------------------------------
// LOAD SETTINGS
// ------------------------------

async function loadSettings() {
  const saved = await chrome.storage.local.get([
    'apiBase',
    'resumeText',
    'resumeName',
    'resumeSize',
    'masterResumeText',
    'masterResumeFileName',
    'masterResumeSize',
    'generatedResumes',
    'profileResume',
    'profileResumeUpdate'
  ]);

  apiBase = saved.apiBase || DEFAULT_API;

  $('apiBase').value = apiBase;

  const masterText = saved.masterResumeText || saved.resumeText || '';
  if (masterText) {
    $('resumeText').value = masterText;
    if (!saved.masterResumeText) {
      await chrome.storage.local.set({
        masterResumeText: masterText,
        masterResumeFileName: saved.resumeName || 'Pasted master resume',
        masterResumeSize: saved.resumeSize || 0
      });
    }
  }

  resumeFileName = saved.masterResumeFileName || saved.resumeName || '';
  resumeFileSize = saved.masterResumeSize || saved.resumeSize || 0;
  resumeIsSaved = Boolean(masterText);
  generatedResumes = Array.isArray(saved.generatedResumes) ? saved.generatedResumes : [];
  $('resumeStatus').textContent = masterText
    ? `${resumeFileSize ? `${Math.round(resumeFileSize / 1024)} KB · ` : ''}Saved master resume`
    : 'Upload a PDF or DOCX to get started.';
  if (saved.profileResume?.id) {
    try {
      const storedProfileResume = await readResumeFile(saved.profileResume.id);
      if (storedProfileResume?.file) {
        profileResume = {
          ...saved.profileResume,
          blob: storedProfileResume.file,
            selectedAt: saved.profileResume.selectedAt,
            text: saved.profileResume.id === 'master'
              ? masterText
            : ''
        };
      }
    } catch (error) {
      setStatus(`Saved profile resume could not be loaded: ${error.message}`, 'error');
    }
  }
  if (saved.profileResumeUpdate?.verification === 'user-confirmed') {
    $('profileConfirmationStatus').textContent =
      `Profile resume updated successfully. User-confirmed on ${formatDate(saved.profileResumeUpdate.confirmedAt)}; MenixJobAI did not independently verify the upload.`;
  }
  populateGeneratedResumePicker();
  updateProfileResumeCard();
  updateResumeCard();
  updateJobSummary();
  await captureActiveJob();
  updateActionBar();
}

function populateGeneratedResumePicker() {
  const select = $('generatedResumeSelect');
  select.replaceChildren(new Option('Choose generated resume', ''));
  generatedResumes.forEach(resume => {
    const option = new Option(
      `${resume.filename} · ${formatDate(resume.generatedAt)}`,
      resume.id
    );
    select.add(option);
  });
}

// ------------------------------
// SETTINGS
// ------------------------------

$('settingsToggle').addEventListener('click', () => {
  $('settings').classList.toggle('hidden');
  updateActionBar();
});

$('profileShortcut').addEventListener('click', () => {
  $('settings').classList.add('hidden');
  switchView('profileView');
});

$('profileActionShortcut').addEventListener('click', () => {
  $('settings').classList.add('hidden');
  switchView('profileView');
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

$('viewResumeBtn').addEventListener('click', () => {
  const details = $('resumeDetails');
  details.open = !details.open;
  if (details.open) details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('jobDescription').addEventListener('input', () => {
  invalidateAnalysis();
  scheduleAutomaticAnalysis();
});

$('jobUrl').addEventListener('input', updateJobApplicationButton);
$('openJobBtn').addEventListener('click', openJobApplication);

$('clearResumeBtn').addEventListener('click', async () => {
  if (!confirm('Clear the saved resume text from this browser?')) return;
  try {
    await chrome.storage.local.remove([
      'resumeText', 'resumeName', 'resumeSize',
      'masterResumeText', 'masterResumeFileName', 'masterResumeSize'
    ]);
    await deleteResumeFile('master');
    if (profileResume?.id === 'master') {
      profileResume = null;
      await chrome.storage.local.remove(['profileResume', 'profileResumeUpdate']);
      $('profileUploadConfirmed').checked = false;
      $('profileConfirmationStatus').textContent = 'Not confirmed';
      updateProfileResumeCard();
    }
    $('resumeText').value = '';
    $('resumeFile').value = '';
    resumeFileSize = 0;
    resumeIsSaved = false;
    $('resumeStatus').textContent = 'Upload a PDF or DOCX to get started.';
    updateResumeCard('');
    invalidateAnalysis();
    setStatus('Saved resume data cleared from this browser.', 'success');
  } catch (error) {
    setStatus(`Could not clear resume data: ${error.message}`, 'error');
  }
});

$('resumeText').addEventListener('input', () => {
  resumeTextEdited = true;
  resumeIsSaved = false;
  updateResumeCard();
  invalidateAnalysis();
  scheduleAutomaticAnalysis();
});

$('saveSettings').addEventListener('click', async () => {
  const value = $('apiBase').value.trim().replace(/\/+$/, '');

  // Accept HTTPS URLs such as Render backend URLs.
  // Also allow localhost for local development.
  const validUrl =
    /^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/api$/.test(value) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api$/.test(value);

  if (!validUrl) {
    return setStatus(
      'Enter a valid backend URL ending with /api.',
      'error'
    );
  }

  try {
    apiBase = value;

    await chrome.storage.local.set({
      apiBase
    });

    setStatus('Backend URL saved successfully.', 'success');
  } catch (error) {
    setStatus(`Could not save settings: ${error.message}`, 'error');
  }
});

// Read the active page after the extension action opens the side panel.
async function captureActiveJob(tabId = null, attempt = 0) {
  const requestId = ++captureRequestId;
  try {
    const tab = tabId
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

    if (!tab?.id || !tab.url) {
      throw new Error('No active browser tab was found.');
    }

    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('This page does not allow job details to be read.');
    }
    const pageChanged = currentJobTabUrl !== tab.url;
    currentJobTabUrl = tab.url;
    const isNaukriListing = url.hostname.endsWith('naukri.com') && /\/job-listings?-/i.test(url.pathname);
    if (isNaukriListing) { recruiterContact = null; renderRecruiterContact('checking'); }
    else { recruiterContact = null; renderRecruiterContact('none'); }
    if (pageChanged) {
      $('jobTitleInput').value = '';
      $('companyInput').value = '';
      $('locationInput').value = '';
      $('jobUrl').value = tab.url;
      $('jobDescription').value = '';
      jobMetadata = {};
      updateJobSummary();
      updateJobApplicationButton();
      invalidateAnalysis();
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },

      func: () => {
        const bodyText = document.body?.innerText || '';
        const visible = element => Boolean(element?.getClientRects().length);
        const contactText = (() => {
          const selectors = ['[data-testid*="job-description" i]', '[id*="jobDescription" i]', '[id*="jobDesc" i]', '[class*="job-description" i]', '[class*="jobDescription" i]', '[class*="dang-inner-html" i]', '[class*="job-desc" i]', '[data-job-description]', 'main'];
          const candidates = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)))
            .filter(visible).map(element => element.innerText?.trim() || '')
            .filter(text => text.length >= 80 && text.length <= 24000).sort((a, b) => a.length - b.length);
          return candidates[0] || '';
        })();
        const recruiterNodes = Array.from(document.querySelectorAll('[class*="recruiter" i], [class*="contact" i], [data-testid*="recruiter" i], [data-testid*="contact" i]')).filter(visible);
        const recruiterText = recruiterNodes.map(element => element.innerText || '').filter(Boolean).join('\n').slice(0, 6000);
        const relevantContactText = `${contactText}\n${recruiterText}`;
        const contactEmails = [...new Set((relevantContactText.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) || []).map(value => value.toLowerCase()).filter(value => value.length <= 254 && !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(value)))];
        const mailto = Array.from(document.querySelectorAll('a[href^="mailto:"]')).filter(anchor => visible(anchor) && (anchor.closest('main') || recruiterNodes.some(node => node.contains(anchor)))).map(anchor => anchor.getAttribute('href').slice(7).split(/[?;]/)[0].trim().toLowerCase()).filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
        const contactEmail = [...contactEmails, ...mailto][0] || '';
        const contactPhone = (relevantContactText.match(/(?:\+?\d{1,3}[\s().-]*)?(?:\(?\d{2,5}\)?[\s.-]*)?\d{3,5}[\s.-]*\d{3,5}/g) || []).map(value => value.trim()).find(value => { const digits = value.replace(/\D/g, ''); return digits.length >= 10 && digits.length <= 13; }) || '';
        const contactLines = relevantContactText.split(/\n+/).map(line => line.trim()).filter(Boolean);
        const labeledValue = (pattern) => {
          const line = contactLines.find(value => pattern.test(value));
          return line?.replace(/^[^:]{1,40}[:\-]\s*/, '').trim().slice(0, 100) || '';
        };
        const recruiterName = labeledValue(/(?:recruiter|posted by|contact person|hr contact|hiring manager)\s*[:\-]/i);
        const recruiterDesignation = labeledValue(/(?:designation|role|title)\s*[:\-]/i);
        const safeLink = anchor => { try { const parsed = new URL(anchor.href); return parsed.protocol === 'https:' && parsed.hostname.endsWith('naukri.com') ? parsed.href : ''; } catch { return ''; } };
        const recruiterProfile = Array.from(document.querySelectorAll('a[href]')).filter(anchor => visible(anchor) && recruiterNodes.some(node => node.contains(anchor)) && /recruiter|profile|candidate/i.test(`${anchor.innerText} ${anchor.href}`)).map(safeLink).find(Boolean) || '';
        const companyWebsite = Array.from(document.querySelectorAll('a[href]')).filter(anchor => visible(anchor) && (anchor.closest('[class*="company" i], [data-testid*="company" i]')) && /website|company site|visit site/i.test(`${anchor.innerText} ${anchor.getAttribute('aria-label') || ''}`)).map(anchor => { try { const parsed = new URL(anchor.href); return parsed.protocol === 'https:' ? parsed.href : ''; } catch { return ''; } }).find(Boolean) || '';
        const companyElement = document.querySelector('[data-testid*="company" i], [class*="companyName" i], [class*="company-name" i], [class*="comp-name" i], [class*="jd-header-comp-name" i]');
        const companyText = companyElement?.textContent?.trim() || '';
        const companyLogo = (() => {
          if (!companyElement || !companyText) return '';
          const companyName = companyText
            .replace(/\s*[★·|]?\s*[0-5](?:\.\d)?\s*[\d,.]+\s*[KMB]?\s*Reviews?.*$/i, '')
            .trim()
            .toLowerCase();
          const companyContainer = companyElement.closest('[class*="company" i], [data-testid*="company" i]')
            || companyElement.parentElement;
          const candidates = Array.from(document.querySelectorAll(
            'img[alt], img[title], [class*="companyLogo" i] img, [class*="company-logo" i] img, [data-testid*="company-logo" i] img'
          )).filter(image => image.getClientRects().length);
          const image = candidates
            .map(candidate => {
              const label = `${candidate.alt || ''} ${candidate.title || ''} ${candidate.getAttribute('aria-label') || ''}`.toLowerCase();
              const imageContext = `${candidate.className || ''} ${candidate.parentElement?.className || ''}`.toLowerCase();
              const nearCompany = Boolean(companyContainer?.contains(candidate));
              const nameMatches = companyName.length > 3 && label.includes(companyName);
              const logoIsExplicit = /logo/i.test(imageContext) || /logo/i.test(label);
              return { candidate, score: (nameMatches ? 4 : 0) + (nearCompany ? 2 : 0) + (logoIsExplicit ? 1 : 0) };
            })
            .filter(item => item.score >= 3)
            .sort((a, b) => b.score - a.score)[0]?.candidate;
          const imageUrl = image?.currentSrc || image?.src || '';
          try {
            const parsed = new URL(imageUrl, location.href);
            return parsed.protocol === 'https:' ? parsed.href : '';
          } catch {
            return '';
          }
        })();
        const ratingMatch = companyText.match(/([0-5](?:\.\d)?)\s*(?:★\s*)?[\d,.]+\s*[KMB]?\s+Reviews?\b/i)
          || bodyText.match(/\b([0-5](?:\.\d)?)\s*(?:★\s*)?[\d,.]+\s*[KMB]?\s+Reviews?\b/i);
        return {
        title: document.title,
        url: location.href,
        heading: document.querySelector('h1')?.textContent?.trim() || '',
        company: companyText,
        companyLogo,
        location: document.querySelector('[data-testid*="location" i], [class*="location" i], [class*="locWdth" i]')?.textContent?.trim() || '',
        experience: (() => {
          const text = document.body?.innerText || '';
          return text.match(/\b\d+\s*(?:-|–|to)\s*\d+\s*(?:years?|yrs?)\b|\b\d+\+?\s*(?:years?|yrs?)\b/i)?.[0]?.replace(/\s+/g, ' ') || '';
        })(),
        salary: (() => {
          const lines = (document.body?.innerText || '').split('\n').map(line => line.trim()).filter(Boolean);
          const salaryLine = lines.find(line => /(?:salary|ctc|₹|INR|Rs\.?)/i.test(line));
          if (salaryLine) {
            if (/not disclosed/i.test(salaryLine)) return 'Not Disclosed';
            const amount = salaryLine.match(/(?:₹|INR|Rs\.?)?\s*[\d,.]+\s*(?:-|–|to)\s*(?:₹|INR|Rs\.?)?\s*[\d,.]+\s*(?:LPA|lakhs?|per annum|\/year)?/i)
              || salaryLine.match(/(?:₹|INR|Rs\.?)\s*[\d,.]+(?:\s*(?:LPA|lakhs?|per annum|\/year))?/i);
            return amount?.[0]?.trim() || '';
          }
          return '';
        })(),
        rating: (() => {
          return ratingMatch?.[1] || '';
        })(),
        recruiterContact: {
          name: recruiterName,
          email: contactEmail,
          phone: contactPhone,
          company: companyText.replace(/\s*[★·|]?\s*[0-5](?:\.\d)?\s*[\d,.]+\s*[KMB]?\s+Reviews?.*$/i, '').trim(),
          designation: recruiterDesignation,
          profileUrl: recruiterProfile,
          websiteUrl: companyWebsite
        },
        text: (() => {
          const selectors = [
            '[data-testid*="job-description" i]',
            '[id*="jobDescription" i]',
            '[id*="jobDesc" i]',
            '[class*="job-description" i]',
            '[class*="jobDescription" i]',
            '[class*="dang-inner-html" i]',
            '[class*="job-desc" i]',
            '[data-job-description]',
            'main'
          ];
          const candidates = selectors
            .flatMap(selector => Array.from(document.querySelectorAll(selector)))
            .filter(element => element.getClientRects().length)
            .map(element => element.innerText?.trim() || '')
            .filter(text => text.length >= 100 && text.length <= 24000);
          const best = candidates.sort((a, b) => a.length - b.length)[0];
          if (best) return best;
          const isNaukriListing = location.hostname.endsWith('naukri.com')
            && /\/job-listings?-/i.test(location.pathname);
          if (isNaukriListing) {
            return (document.querySelector('main')?.innerText || document.body?.innerText || '').slice(0, 24000);
          }
          return '';
        })(),
        isJobPage: (() => {
          const text = `${document.title} ${bodyText}`.toLowerCase();
          const isNaukriJobListing = location.hostname.endsWith('naukri.com')
            && /\/job-listings?-/i.test(location.pathname);
          const indicators = [
            /job description/.test(text),
            /responsibilit(?:y|ies)/.test(text),
            /qualifications?/.test(text),
            /requirements?/.test(text),
            /experience required|years? of experience/.test(text),
            /apply now|apply for this job/.test(text),
            /employment type|job type/.test(text),
            /skills required/.test(text)
          ];
          return isNaukriJobListing || indicators.filter(Boolean).length >= 2;
        })()
        };
      }
    });

    if (requestId !== captureRequestId) return;
    const pageText = result?.text || '';
    if (pageText.length < 100 || !result?.isJobPage) {
      if (attempt < 3) {
        window.setTimeout(() => captureActiveJob(tab.id, attempt + 1), 650 * (attempt + 1));
        return;
      }
      throw new Error('No job description was detected on this page.');
    }

    $('jobUrl').value = result.url;
    $('jobTitleInput').value = cleanText(result.heading || result.title.replace(/\s*[-|].*$/, ''));
    $('companyInput').value = cleanCompanyName(result.company);
    $('locationInput').value = cleanText(result.location);
    $('jobDescription').value = pageText;
    jobMetadata = {
      experience: cleanText(result.experience),
      salary: cleanText(result.salary),
      location: cleanText(result.location),
      rating: cleanText(result.rating),
      companyLogo: cleanText(result.companyLogo)
    };
    recruiterContact = result.recruiterContact || {};
    renderRecruiterContact('found');
    updateJobSummary();
    updateJobApplicationButton();
    invalidateAnalysis();
    setStatus(`Job detected from ${url.hostname}. Ready to analyze.`, 'success');
    scheduleAutomaticAnalysis();
  } catch (error) {
    if (requestId !== captureRequestId) return;
    if (attempt < 3 && currentJobTabUrl && !/cannot access contents|manifest must request permission|does not allow/i.test(error.message || '')) {
      window.setTimeout(() => captureActiveJob(tabId, attempt + 1), 650 * (attempt + 1));
      return;
    }
    const activeUrl = currentJobTabUrl || '';
    const isNaukriJob = /naukri\.com\/job-listings?-/i.test(activeUrl);
    if (isNaukriJob || !activeUrl) {
      $('jobUrl').value = activeUrl;
      $('jobTitleInput').value = '';
      $('companyInput').value = '';
      $('locationInput').value = '';
      $('jobDescription').value = '';
      jobMetadata = {};
      updateJobSummary();
      updateJobApplicationButton();
      invalidateAnalysis();
    }
    recruiterContact = null;
    renderRecruiterContact(isNaukriJob ? 'error' : 'none');
    const accessDenied = /cannot access contents|manifest must request permission/i.test(error.message || '');
    setStatus(
      accessDenied
        ? 'Naukri access is blocked until the extension is reloaded. Open brave://extensions, reload MenixJobAI, then reopen this job panel.'
        : isNaukriJob
          ? 'Could not detect the job description. Add it in Edit details; the job link is already filled in.'
          : 'No supported job listing was detected. Open a Naukri job or enter details using Edit details.',
      'info'
    );
  }
}

// ------------------------------
// UPLOAD RESUME
// ------------------------------

$('resumeFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];

  if (!file) return;

  const form = new FormData();

  form.append('file', file);

  try {
    setStatus('Extracting text from your resume...');

    const data = await api('/resumes/extract-text', {
      method: 'POST',
      body: form
    });

    $('resumeText').value = data.text || '';
    resumeTextEdited = false;
    invalidateAnalysis();

    await storeResumeFile('master', file, file.name);
    await chrome.storage.local.set({
      resumeText: data.text || '',
      resumeName: file.name,
      resumeSize: file.size,
      masterResumeText: data.text || '',
      masterResumeFileName: file.name,
      masterResumeSize: file.size
    });

    resumeIsSaved = true;
    resumeFileSize = file.size;
    $('resumeStatus').textContent =
      `${Math.round(file.size / 1024)} KB · Text extracted. Review before use.`;
    updateResumeCard(file.name);

    setStatus(
      'Resume text extracted. Check it for accuracy.',
      'success'
    );
    scheduleAutomaticAnalysis();

  } catch (error) {
    setStatus(
      `Resume extraction failed: ${error.message}. You can paste resume text manually.`,
      'error'
    );
  }
});

async function selectProfileResume(blob, name, text, id, type = '') {
  await storeResumeFile(id, blob, name);
  const selectedAt = new Date().toISOString();
  profileResume = { id, name, text: text || '', type: type || 'Resume file', blob, selectedAt };
  await chrome.storage.local.set({
    profileResume: {
      id,
      name,
      type: profileResume.type,
      selectedAt
    },
    profileResumeUpdate: null
  });
  $('profileUploadConfirmed').checked = false;
  $('profileConfirmationStatus').textContent = 'Not confirmed';
  updateProfileResumeCard();
}

$('chooseProfileResumeBtn').addEventListener('click', () => $('profileResumeFile').click());

$('profileResumeFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const id = `profile-${Date.now()}`;
  let extractedText = '';
  let extractionWarning = '';
  try {
    setStatus('Reading selected profile resume...');
    const form = new FormData();
    form.append('file', file);
    const extracted = await api('/resumes/extract-text', { method: 'POST', body: form });
    extractedText = extracted.text || '';
  } catch (error) {
    extractionWarning = ` Text preview unavailable: ${error.message}`;
  }
  try {
    await selectProfileResume(
      file,
      file.name,
      extractedText,
      id,
      file.name.split('.').pop()?.toUpperCase() || file.type
    );
    setStatus(
      extractionWarning
        ? `Profile resume selected.${extractionWarning}`
        : 'Profile resume selected. Review the preview before uploading to Naukri.',
      extractionWarning ? 'info' : 'success'
    );
  } catch (error) {
    setStatus(`Could not save this profile resume locally: ${error.message}`, 'error');
  }
});

$('downloadProfileResumeBtn').addEventListener('click', async () => {
  if (!profileResume?.blob) return setStatus('Select a profile resume first.', 'error');
  try {
    const url = URL.createObjectURL(profileResume.blob);
    await chrome.downloads.download({
      url,
      filename: `MenixJobAI/${safeFilenamePart(profileResume.name.replace(/\.[^.]+$/, ''))}${profileResume.name.match(/\.[^.]+$/)?.[0] || '.docx'}`,
      saveAs: true
    });
    setStatus('Resume copy downloaded. Select it in Naukri’s normal file picker.', 'success');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    setStatus(`Could not download the selected resume: ${error.message}`, 'error');
  }
});

$('useMasterResumeBtn').addEventListener('click', async () => {
  try {
    const stored = await readResumeFile('master');
    if (!stored?.file) {
      return setStatus('The saved master resume has no local file copy. Select the original PDF or DOCX from your computer.', 'error');
    }
    await selectProfileResume(
      stored.file,
      stored.name || resumeFileName || 'Master resume',
      $('resumeText').value,
      'master',
      stored.name?.split('.').pop()?.toUpperCase()
    );
    setStatus('Master resume selected for the Naukri profile. It has not been uploaded.', 'success');
  } catch (error) {
    setStatus(`Could not load the master resume file: ${error.message}`, 'error');
  }
});

$('useGeneratedResumeBtn').addEventListener('click', async () => {
  const id = $('generatedResumeSelect').value;
  if (!id) return setStatus('Choose a previously generated resume first.', 'error');
  try {
    const metadata = generatedResumes.find(resume => resume.id === id);
    const stored = await readResumeFile(id);
    if (!metadata || !stored?.file) {
      return setStatus('The generated resume file is unavailable. Generate it again or select it from your computer.', 'error');
    }
    await selectProfileResume(
      stored.file,
      metadata.filename,
      '',
      id,
      'DOCX'
    );
    setStatus('Generated resume selected for the Naukri profile. It has not been uploaded.', 'success');
  } catch (error) {
    setStatus(`Could not load generated resume: ${error.message}`, 'error');
  }
});

$('cancelProfileResumeBtn').addEventListener('click', async () => {
  profileResume = null;
  $('profileResumeFile').value = '';
  $('profileUploadConfirmed').checked = false;
  $('profileConfirmationStatus').textContent = 'Not confirmed';
  await chrome.storage.local.remove(['profileResume', 'profileResumeUpdate']);
  updateProfileResumeCard();
  setStatus('Profile resume selection cancelled.', 'info');
});

$('openNaukriProfileBtn').addEventListener('click', async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://naukri.com/*', 'https://*.naukri.com/*'] });
    const existing = tabs.find(tab => tab.id);
    if (existing?.id) {
      await chrome.tabs.update(existing.id, { url: 'https://www.naukri.com/', active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: 'https://www.naukri.com/', active: true });
    }
    setStatus('Naukri opened. Sign in if needed, then navigate to your profile resume section.', 'success');
  } catch (error) {
    setStatus(`Could not open Naukri: ${error.message}`, 'error');
  }
});

$('profileUploadConfirmed').addEventListener('change', updateProfileResumeCard);

$('confirmProfileUploadBtn').addEventListener('click', async () => {
  if (!profileResume || !$('profileUploadConfirmed').checked) return;
  const confirmedAt = new Date().toISOString();
  try {
    await chrome.storage.local.set({
      profileResumeUpdate: {
        filename: profileResume.name,
        confirmedAt,
        verification: 'user-confirmed'
      }
    });
    $('profileConfirmationStatus').textContent =
      `Profile resume updated successfully. User-confirmed on ${formatDate(confirmedAt)}; MenixJobAI did not independently verify the upload.`;
    setStatus('Profile resume update recorded as user-confirmed.', 'success');
  } catch (error) {
    setStatus(`Could not save confirmation: ${error.message}`, 'error');
  }
});

// ------------------------------
// SAVE MASTER RESUME
// ------------------------------

$('saveResumeBtn').addEventListener('click', async () => {
  const text = $('resumeText').value.trim();
  const resumeFileMatchesText = !resumeTextEdited;
  const uploadedMaster = resumeFileMatchesText ? $('resumeFile').files?.[0] : null;

  if (!text) {
    return setStatus(
      'Paste or upload your master resume first.',
      'error'
    );
  }

  try {
    if (uploadedMaster) {
      await storeResumeFile('master', uploadedMaster, uploadedMaster.name);
    } else {
      await deleteResumeFile('master');
      if (profileResume?.id === 'master') {
        profileResume = null;
        await chrome.storage.local.remove(['profileResume', 'profileResumeUpdate']);
        $('profileUploadConfirmed').checked = false;
        $('profileConfirmationStatus').textContent = 'Not confirmed';
        updateProfileResumeCard();
      }
    }
    await chrome.storage.local.set({
      resumeText: text,
      resumeName: uploadedMaster?.name || 'Pasted master resume',
      resumeSize: uploadedMaster?.size || 0,
      masterResumeText: text,
      masterResumeFileName: uploadedMaster?.name || 'Pasted master resume',
      masterResumeSize: uploadedMaster?.size || 0
    });

    resumeIsSaved = true;
    resumeTextEdited = false;
    if (!resumeFileMatchesText) $('resumeFile').value = '';
    resumeFileSize = uploadedMaster?.size || 0;
    resumeFileName = uploadedMaster?.name || 'Pasted master resume';
    $('resumeStatus').textContent =
      'Saved in this browser profile.';
    updateResumeCard(resumeFileName);

    setStatus(
      'Master resume saved locally.',
      'success'
    );
    scheduleAutomaticAnalysis();

  } catch (error) {
    setStatus(
      `Could not save resume: ${error.message}`,
      'error'
    );
  }
});

// ------------------------------
// ANALYZE JOB AND RESUME
// ------------------------------

async function analyzeCurrentMatch(automatic) {
  if (analysisPromise) return analysisPromise;

  const resumeText = $('resumeText').value.trim();
  const jobDescription = $('jobDescription').value.trim();

  if (!resumeText) {
    if (automatic) return;
    return setStatus(
      'Add your master resume first.',
      'error'
    );
  }

  if (!jobDescription) {
    if (automatic) return;
    return setStatus(
      'Add the job description first.',
      'error'
    );
  }

  let progressTimer;
  let historyWarning = '';
  analysisPromise = (async () => {
    try {
      $('generateBtn').disabled = true;
      renderAnalysisPlaceholders('Analyzing…');
      setStatus(automatic ? 'Automatically analyzing this job against your saved resume…' : 'Analyzing job and resume…', 'info');
      const progress = [
        'Reading job details…',
        'Checking master resume…',
        'Analyzing compatibility…',
        'Preparing results…'
      ];
      let progressIndex = 0;
      $('generateBtn').textContent = progress[progressIndex];
      progressTimer = setInterval(() => {
        progressIndex = (progressIndex + 1) % progress.length;
        $('generateBtn').textContent = progress[progressIndex];
      }, 1400);

      const data = await api('/ai/tailor-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, jobDescription })
      });

      if (data.error) throw new Error(data.error);
      lastAnalysis = data;
      renderAnalysis(data);
      $('generateBtn').disabled = false;
      updatePrimaryAction();
      try {
        await saveAnalysisHistory(data);
      } catch (error) {
        historyWarning = `Analysis completed, but history could not be saved: ${error.message}`;
      }

      setStatus(historyWarning || 'Analysis complete. Review the suggestions before downloading your resume.',
        historyWarning ? 'error' : 'success');
    } catch (error) {
      renderAnalysisPlaceholders('Analysis failed');
      setStatus(`Analysis failed: ${error.message}`, 'error');
    } finally {
      clearInterval(progressTimer);
      analysisPromise = null;
      updatePrimaryAction();
    }
  })();
  updatePrimaryAction();
  return analysisPromise;
}

// ------------------------------
// DISPLAY AI ANALYSIS
// ------------------------------

function renderAnalysis(data) {
  const box = $('analysis');
  box.classList.remove('hidden');
  box.replaceChildren();
  const rawText =
    data.review?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('\n') ||
    '';
  let review = {};
  const jsonText = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (jsonText) {
    try {
      review = JSON.parse(jsonText);
    } catch {
      review = jsonText.startsWith('{') ? {} : { matchSummary: rawText.trim() };
    }
  }

  const header = document.createElement('div');
  header.className = 'match-heading';
  const heading = document.createElement('h3');
  heading.textContent = 'Match Overview';
  const ready = document.createElement('span');
  ready.className = 'match-state';
  ready.textContent = '✓ AI Review';
  header.append(heading, ready);
  const overview = $('matchOverview');
  overview.replaceChildren();
  overview.append(header);

  const supported = normalizeAnalysisItems(review.matchedSkills || review.supportedKeywords);
  const gaps = normalizeAnalysisItems(review.missingSkills || review.gapsToVerify);
  const overallScore = normalizeScore(review.matchScore);
  const skillsScore = normalizeScore(review.skillsMatchScore);
  const experienceScore = normalizeScore(review.experienceMatchScore);
  const keywordScore = normalizeScore(review.keywordMatchScore);
  const scoreValue = overallScore === null ? '—' : `${overallScore}%`;
  const scoreCard = document.createElement('div');
  scoreCard.className = 'match-score-card';
  const score = document.createElement('div');
  score.className = 'match-score-ring';
  const scoreText = document.createElement('strong');
  scoreText.textContent = scoreValue;
  const scoreLabel = document.createElement('span');
  scoreLabel.textContent = scoreValue === '—' ? 'Not scored' : 'AI estimate';
  score.append(scoreText, scoreLabel);
  const metrics = document.createElement('div');
  metrics.className = 'match-metrics';
  const matchBadge = document.createElement('span');
  matchBadge.className = 'match-state';
  matchBadge.textContent = typeof review.matchLevel === 'string' && review.matchLevel.trim()
    ? `✓ ${review.matchLevel.trim()}`
    : overallScore === null
      ? '✓ Analysis complete'
      : `✓ ${overallScore >= 80 ? 'Strong Match' : overallScore >= 65 ? 'Good Match' : overallScore >= 40 ? 'Partial Match' : 'Low Match'}`;
  metrics.append(matchBadge);
  appendMatchMetric(metrics, 'Skills match', formatScore(skillsScore));
  appendMatchMetric(metrics, 'Experience match', formatScore(experienceScore));
  appendMatchMetric(metrics, 'Keyword match', formatScore(keywordScore));
  scoreCard.append(score, metrics);
  overview.append(scoreCard);

  if (typeof review.matchSummary === 'string' && review.matchSummary.trim()) {
    const summary = document.createElement('p');
    summary.className = 'analysis-summary';
    summary.textContent = review.matchSummary.trim();
    overview.append(summary);
    if (summary.textContent.length > 150) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'summary-toggle';
      toggle.textContent = 'Read more';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        const expanded = summary.classList.toggle('expanded');
        toggle.textContent = expanded ? 'Show less' : 'Read more';
        toggle.setAttribute('aria-expanded', String(expanded));
      });
      overview.append(toggle);
    }
  }

  $('matchedSkillsList').replaceChildren();
  $('missingSkillsList').replaceChildren();
  $('matchedSkillsHeading').textContent = `Matched Skills (${supported.length})`;
  $('missingSkillsHeading').textContent = `Missing Skills (${gaps.length})`;
  populateSkillItems($('matchedSkillsList'), supported, 'matched');
  populateSkillItems($('missingSkillsList'), gaps, 'review');
  if (!supported.length) appendEmptySkillState($('matchedSkillsList'), 'No supported keywords returned');
  if (!gaps.length) appendEmptySkillState($('missingSkillsList'), 'No gaps to verify returned');

  const suggestions = [];
  if (typeof review.suggestedSummary === 'string' && review.suggestedSummary.trim()) {
    suggestions.push(review.suggestedSummary.trim());
  }
  if (Array.isArray(review.rewrittenBullets)) {
    suggestions.push(...review.rewrittenBullets.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()));
  }
  const reviewGaps = review.gapsToVerify || review.missingSkills;
  if (Array.isArray(reviewGaps)) {
    suggestions.push(...reviewGaps.filter(value => typeof value === 'string' && value.trim()).map(value => `Verify: ${value.trim()}`));
  }
  if (Array.isArray(review.cautions)) {
    suggestions.push(...review.cautions.filter(value => typeof value === 'string' && value.trim()).map(value => `Caution: ${value.trim()}`));
  }
  appendReviewList(box, 'AI Suggestions', suggestions);

  if (data.notice) {
    const notice = document.createElement('p');
    notice.className = 'analysis-notice';
    notice.textContent = data.notice;
    box.append(notice);
  }
  if (box.children.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'analysis-notice';
    empty.textContent = 'No structured suggestions were returned. Please retry the analysis.';
    box.append(empty);
  }
  updateActionBar();
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function formatScore(value) {
  return value === null ? 'N/A' : `${value}%`;
}

function renderAnalysisPlaceholders(stateLabel = 'Analysis pending') {
  const overview = $('matchOverview');
  overview.replaceChildren();
  const header = document.createElement('div');
  header.className = 'match-heading';
  const heading = document.createElement('h3');
  heading.textContent = 'Match Overview';
  const state = document.createElement('span');
  state.className = 'match-state pending';
  state.textContent = stateLabel;
  header.append(heading, state);

  const scoreCard = document.createElement('div');
  scoreCard.className = 'match-score-card';
  const score = document.createElement('div');
  score.className = 'match-score-ring pending';
  const value = document.createElement('strong');
  value.textContent = '—';
  const label = document.createElement('span');
  label.textContent = 'Not scored';
  score.append(value, label);
  const metrics = document.createElement('div');
  metrics.className = 'match-metrics';
  appendMatchMetric(metrics, 'Skills match', '—');
  appendMatchMetric(metrics, 'Experience match', '—');
  appendMatchMetric(metrics, 'Keyword match', '—');
  scoreCard.append(score, metrics);
  const hint = document.createElement('p');
  hint.className = 'analysis-notice';
  hint.textContent = stateLabel === 'Analyzing…'
    ? 'Comparing the saved resume with this job description…'
    : stateLabel === 'Analysis failed'
      ? 'Automatic analysis failed. Review the error below and retry when the backend is available.'
      : 'Scores are calculated automatically when a resume and job description are available.';
  overview.append(header, scoreCard, hint);

  $('matchedSkillsList').replaceChildren();
  $('missingSkillsList').replaceChildren();
  $('matchedSkillsHeading').textContent = 'Matched Skills';
  $('missingSkillsHeading').textContent = 'Missing Skills';
  appendEmptySkillState($('matchedSkillsList'), 'Matched keywords will appear after analysis');
  appendEmptySkillState($('missingSkillsList'), 'Gaps to verify will appear after analysis');
}

function normalizeAnalysisItems(values) {
  if (!Array.isArray(values)) return [];
  return values.map(value => {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
      return String(value.skill || value.keyword || value.name || '').trim();
    }
    return '';
  }).filter(Boolean);
}

function appendMatchMetric(parent, label, value) {
  const row = document.createElement('div');
  row.className = 'match-metric';
  const name = document.createElement('span');
  name.textContent = label;
  const result = document.createElement('strong');
  result.textContent = value;
  row.append(name, result);
  parent.append(row);
}

function populateSkillItems(list, values, tone) {
  values.forEach(value => {
    const item = document.createElement('li');
    item.className = `skill-${tone}`;
    const icon = document.createElement('span');
    icon.className = 'skill-icon';
    icon.textContent = tone === 'matched' ? '✓' : '○';
    const label = document.createElement('span');
    label.textContent = value;
    item.append(icon, label);
    list.append(item);
  });
}

function appendEmptySkillState(list, message) {
  const item = document.createElement('li');
  item.className = 'skill-empty';
  item.textContent = message;
  list.append(item);
}

function appendReviewText(parent, title, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  const section = document.createElement('section');
  section.className = 'analysis-result';
  const heading = document.createElement('h4');
  heading.textContent = title;
  const text = document.createElement('p');
  text.textContent = value.trim();
  section.append(heading, text);
  parent.append(section);
}

function appendReviewList(parent, title, values, tone = '') {
  if (!Array.isArray(values) || !values.length) return;
  const section = document.createElement('section');
  section.className = `analysis-result ${tone}`.trim();
  const heading = document.createElement('h4');
  heading.textContent = title;
  const list = document.createElement('ul');
  values.filter(value => typeof value === 'string' && value.trim()).forEach((value, index) => {
    const item = document.createElement('li');
    item.textContent = value.trim();
    if (index >= 3) item.classList.add('suggestion-extra');
    list.append(item);
  });
  if (!list.children.length) return;
  section.append(heading, list);
  if (list.children.length > 3) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'suggestion-toggle';
    toggle.textContent = `Show ${list.children.length - 3} more`;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      section.classList.toggle('suggestions-expanded', !expanded);
      toggle.textContent = expanded ? `Show ${list.children.length - 3} more` : 'Show less';
    });
    section.append(toggle);
  }
  parent.append(section);
}

async function saveAnalysisHistory(data) {
  const stored = await chrome.storage.local.get(['analysisHistory', 'analyzedJobs']);
  const entry = {
    id: `${Date.now()}`,
    title: cleanText($('jobTitleInput').value) || 'Untitled job',
    company: cleanText($('companyInput').value),
    location: cleanText($('locationInput').value),
    url: cleanText($('jobUrl').value),
    analyzedAt: new Date().toISOString(),
    jobDescription: $('jobDescription').value.trim(),
    jobMetadata: { ...jobMetadata },
    analysis: data
  };
  const history = [entry, ...(stored.analyzedJobs || stored.analysisHistory || [])].slice(0, 20);
  await chrome.storage.local.set({ analysisHistory: history, analyzedJobs: history });
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Date unavailable'
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function appendEmptyState(parent, message) {
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = message;
  parent.append(empty);
}

async function loadHistory() {
  const stored = await chrome.storage.local.get(['analysisHistory', 'analyzedJobs']);
  const analysisHistory = stored.analyzedJobs || stored.analysisHistory || [];
  const list = $('historyList');
  list.replaceChildren();
  if (!analysisHistory.length) {
    appendEmptyState(list, 'Your completed resume reviews will appear here.');
    return;
  }

  analysisHistory.forEach(entry => {
    const card = document.createElement('article');
    card.className = 'list-card';
    const title = document.createElement('h2');
    title.textContent = entry.title || 'Untitled job';
    const meta = document.createElement('p');
    meta.textContent = [
      entry.company,
      entry.location,
      `Analyzed ${formatDate(entry.analyzedAt)}`,
      entry.generatedResumeFilename ? `Resume: ${entry.generatedResumeFilename}` : ''
    ].filter(Boolean).join(' · ');
    const open = document.createElement('button');
    open.className = 'btn secondary';
    open.type = 'button';
    open.textContent = 'View analysis';
    open.addEventListener('click', () => {
      $('jobTitleInput').value = entry.title || '';
      $('companyInput').value = entry.company || '';
      $('locationInput').value = entry.location || '';
      $('jobUrl').value = entry.url || '';
      $('jobDescription').value = entry.jobDescription || '';
      jobMetadata = entry.jobMetadata || {
        location: entry.location || '',
        experience: extractExperienceTags(entry.jobDescription || '')[0] || ''
      };
      updateJobSummary();
      lastAnalysis = entry.analysis;
      renderAnalysis(entry.analysis);
      switchView('applyView');
      setStatus('Previous analysis reopened. Review it before downloading.', 'success');
    });
    card.append(title, meta, open);
    list.append(card);
  });
}

async function loadSavedJobs() {
  const list = $('savedList');
  list.replaceChildren();
  const jobs = await api('/jobs');
  if (!Array.isArray(jobs)) throw new Error('Backend returned an invalid saved-jobs list.');
  const savedJobs = jobs.filter(job => String(job.status).toUpperCase() === 'SAVED');
  if (!savedJobs.length) {
    appendEmptyState(list, 'Jobs you save will appear here.');
    return;
  }

  savedJobs.forEach(job => {
    const card = document.createElement('article');
    card.className = 'list-card';
    const title = document.createElement('h2');
    title.textContent = job.title || 'Untitled job';
    const meta = document.createElement('p');
    meta.textContent = [job.company, job.location, `Saved ${formatDate(job.createdAt)}`].filter(Boolean).join(' · ');
    const actions = document.createElement('div');
    actions.className = 'job-actions';
    const open = document.createElement('button');
    open.className = 'btn secondary';
    open.type = 'button';
    open.textContent = 'Open job';
    open.addEventListener('click', () => {
      $('jobTitleInput').value = job.title || '';
      $('companyInput').value = job.company || '';
      $('locationInput').value = job.location || '';
      $('jobUrl').value = job.originalUrl || job.applicationUrl || '';
      $('jobDescription').value = job.description || '';
      jobMetadata = {
        location: job.location || '',
        experience: extractExperienceTags(job.description || '')[0] || ''
      };
      invalidateAnalysis();
      updateJobSummary();
      switchView('applyView');
      setStatus('Saved job opened. Review its details before analysis.', 'success');
    });
    const remove = document.createElement('button');
    remove.className = 'btn text-button';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove "${job.title || 'this job'}" from saved jobs?`)) return;
      try {
        await api(`/jobs/${job.id}`, { method: 'DELETE' });
        await loadSavedJobs();
        setStatus('Saved job removed.', 'success');
      } catch (error) {
        setStatus(`Could not remove saved job: ${error.message}`, 'error');
      }
    });
    actions.append(open, remove);
    card.append(title, meta, actions);
    list.append(card);
  });
}

// ------------------------------
// GENERATE TAILORED DOCX
// ------------------------------

$('generateBtn').addEventListener('click', async () => {
  if (!lastAnalysis) {
    await analyzeCurrentMatch(false);
    return;
  }

  if (generatedBlobUrl && generatedFilename) {
    try {
      await chrome.downloads.download({
        url: generatedBlobUrl,
        filename: `MenixJobAI/${generatedFilename}`,
        saveAs: true
      });
      setStatus(`Downloading ${generatedFilename}.`, 'success');
    } catch (error) {
      setStatus(`Could not download the tailored resume: ${error.message}`, 'error');
    }
    return;
  }

  const resumeText = $('resumeText').value.trim();
  const jobDescription = $('jobDescription').value.trim();

  if (!resumeText) return setStatus('Add your master resume before generating a tailored resume.', 'error');
  if (!jobDescription) return setStatus('Add the job description before generating a tailored resume.', 'error');
  if (!lastAnalysis) {
    return setStatus(
      'Analyze the job and resume first.',
      'error'
    );
  }

  try {
    $('generateBtn').disabled = true;

    $('generateBtn').textContent = 'Generating DOCX...';

    const response = await fetch(
      `${apiBase}/ai/tailor-docx`,
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          resumeText,
          jobDescription,
          fullName: 'Mohit Saini'
        })
      }
    );

    if (!response.ok) {
      throw new Error(await responseError(response));
    }

    const blob = await response.blob();

    const job = currentJobPayload();
    const filename = [
      'MohitSaini',
      safeFilenamePart(job.company),
      safeFilenamePart(job.title),
      'Tailored.docx'
    ].join('_');
    const generatedId = `generated-${Date.now()}`;
    generatedBlobUrl = URL.createObjectURL(blob);
    generatedFilename = filename;
    await storeResumeFile(generatedId, blob, filename);
    const downloadId = await chrome.downloads.download({
      url: generatedBlobUrl,
      filename: `MenixJobAI/${filename}`,
      saveAs: true
    });
    const generatedAt = new Date().toISOString();
    const generatedEntry = {
      id: generatedId,
      filename,
      title: job.title,
      company: job.company,
      url: job.url,
      generatedAt,
      downloadId
    };
    generatedResumes = [generatedEntry, ...generatedResumes.filter(entry => entry.id !== generatedId)].slice(0, 10);
    await chrome.storage.local.set({ generatedResumes });
    populateGeneratedResumePicker();

    $('fileResult').classList.remove('hidden');
    $('fileResultText').textContent =
      `Downloaded ${filename}. Review it before attaching it to this job.`;
    $('openJobBtn').classList.toggle('hidden', !/^https?:\/\//i.test(job.url));
    const storedHistory = await chrome.storage.local.get(['analysisHistory', 'analyzedJobs']);
    const history = storedHistory.analyzedJobs || storedHistory.analysisHistory || [];
    const historyIndex = history.findIndex(entry => entry.url === job.url && entry.jobDescription === jobDescription);
    if (historyIndex >= 0) {
      history[historyIndex] = { ...history[historyIndex], generatedResumeFilename: filename, generatedAt };
      await chrome.storage.local.set({ analysisHistory: history, analyzedJobs: history });
    }

    setStatus(
      `Tailored resume downloaded. Review ${filename} before applying.`,
      'success'
    );

  } catch (error) {
    setStatus(
      `DOCX generation failed: ${error.message}`,
      'error'
    );

  } finally {
    $('generateBtn').disabled = false;

    updatePrimaryAction();
  }
});

function scheduleActiveJobCapture(tabId, delay = 250) {
  if (captureDebounceTimer) window.clearTimeout(captureDebounceTimer);
  captureDebounceTimer = window.setTimeout(() => {
    captureActiveJob(tabId).catch(error => {
      setStatus(`Could not refresh job details: ${error.message}`, 'error');
    });
  }, delay);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleActiveJobCapture(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && tab.url && (changeInfo.status === 'complete' || changeInfo.url)) {
    scheduleActiveJobCapture(tabId, changeInfo.status === 'complete' ? 200 : 100);
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  chrome.tabs.get(details.tabId)
    .then(tab => {
      if (tab.active) scheduleActiveJobCapture(tab.id, 300);
    })
    .catch(error => setStatus(`Could not refresh after page navigation: ${error.message}`, 'error'));
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  chrome.tabs.get(details.tabId)
    .then(tab => {
      if (tab.active) scheduleActiveJobCapture(tab.id, 300);
    })
    .catch(error => setStatus(`Could not refresh after page navigation: ${error.message}`, 'error'));
});

// ------------------------------
// INITIALIZE EXTENSION
// ------------------------------

renderAnalysisPlaceholders();
loadSettings().catch(error => {
  setStatus(
    `Initialization failed: ${error.message}`,
    'error'
  );
});
