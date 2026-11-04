
const $ = (id) => document.getElementById(id);

const DEFAULT_API = 'https://menixjobai-api.onrender.com/api';
// Naukri's UI selectors are best-effort; this session cannot inspect a logged-in
// profile DOM. Confirm input selectors in DevTools with:
// [...document.querySelectorAll('input[type=file]')].map(i => ({id: i.id, accept: i.accept}))
const NAUKRI_CONFIG = {
  main: {
    profileUrl: 'https://www.naukri.com/mnjuser/profile',
    inputSelectors: ['#attachCV', 'input[type="file"][accept*="doc" i]', 'input[type="file"]'],
    dropZoneSelectors: ['[class*="resume" i][class*="upload" i]', '[data-testid*="resume" i]', '[class*="upload" i]'],
    buttonTextMatches: 'update\\s+resume',
    fileNameSelectors: ['[class*="resume" i] [class*="name" i]', '[class*="uploaded" i]', '[data-testid*="resume" i]'],
    successSelectors: ['[role="alert"]', '[class*="toast" i]', '[class*="success" i]'],
    loginUrlPatterns: ['/mnjuser/login', '/login', '/nlogin']
  },
  campus: {
    // Naukri Campus accounts use the shared profile URL; confirm if your account redirects elsewhere.
    profileUrl: 'https://www.naukri.com/mnjuser/profile',
    inputSelectors: ['#attachCV', 'input[type="file"][accept*="doc" i]', 'input[type="file"]'],
    dropZoneSelectors: ['[data-testid*="resume" i]', '[class*="resume" i][class*="drop" i]', '[class*="upload" i]'],
    buttonTextMatches: 'update\\s+resume',
    fileNameSelectors: ['[data-testid*="resume" i]', '[class*="resume" i] [class*="name" i]', '[class*="uploaded" i]'],
    successSelectors: ['[role="alert"]', '[class*="toast" i]', '[class*="success" i]'],
    loginUrlPatterns: ['/mnjuser/login', '/login', '/nlogin']
  }
};
const RESUME_UPLOAD_HISTORY_KEY = 'resumeUploadHistory';
const CONFIRMED_ANSWER_PROFILE_KEY = 'confirmedApplicationAnswers';
const CONFIRMED_REQUIREMENT_FACTS_KEY = 'candidateRequirementConfirmations';
const RESUME_UPLOAD_DELAY_MS = 1000;

let apiBase = DEFAULT_API;
let lastAnalysis = null;
let generatedBlobUrl = null;
let generatedFilename = '';
let resumeFileName = '';
let resumeIsSaved = false;
let resumeFileSize = 0;
let resumeTextEdited = false;
let generatedResumes = [];
let currentJobTabUrl = '';
let captureRequestId = 0;
let captureDebounceTimer = null;
let jobMetadata = {};
let automaticAnalysisTimer = null;
let lastAutomaticAnalysisInput = '';
let analysisPromise = null;
let recruiterContact = null;
let overviewController = null;
let quickOverview = null;
let aiRefinementFailed = false;
let suggestionData = null;
let suggestionLoadError = '';
let suggestionRequestPromise = null;
let suggestionController = null;
let tailoredWorkingCopy = '';
let approvedTailoringEdits = [];
let resumeWorkflows = [];
let activeResumeWorkflow = null;
let activeResumePreviewText = '';
let resumeUploadPipelinePromise = null;
let tailorGenerationInProgress = false;
let tailoringRequestInProgress = false;
let applicationAnswerItems = [];
let applicationQuestionsLoading = false;
let candidateRequirementConfirmations = {};
let requirementConfirmationIndex = 0;
let companyApplicationAutomationInProgress = false;

// Wake Render as soon as the extension document opens; this is intentionally fire-and-forget.
void fetch(`${DEFAULT_API}/health`).catch(() => {});
const resumeProfileLookups = new Map();

function renderRecruiterContact(state = 'checking') {
  const content = $('recruiterContactContent');
  const badge = $('recruiterContactState');
  if (!content || !badge) return;
  const card = content.closest('.recruiter-contact');
  badge.textContent = ({ checking: 'Checking…', error: 'Could not check', none: 'Unavailable' })[state] || 'Available';
  content.replaceChildren();
  if (state === 'checking' || state === 'none') { card?.classList.add('hidden'); return; }
  if (state === 'error') {
    card?.classList.remove('hidden');
    content.append(document.createTextNode('Could not inspect this listing. '));
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'contact-link'; retry.textContent = 'Retry';
    retry.addEventListener('click', () => captureActiveJob()); content.append(retry); return;
  }
  const details = recruiterContact || {};
  if (!(details.name || details.email || details.phone || details.profileUrl || details.websiteUrl)) {
    card?.classList.add('hidden'); return;
  }
  card?.classList.remove('hidden');
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
const LOCAL_STOP_WORDS = new Set('a an and are as at be by for from in into is it of on or that the their to with will you your this these those must should have has required preferred requirements responsibilities experience years year ability strong excellent including working knowledge skills qualification qualifications candidate candidates role team develop development manage management support use using build built work about careers employer home sitemap credits help center summons notices grievances report issue privacy policy terms conditions fraud alert trust safety apply get real connect time app ltd limited copyright contact login signup subscribe download share follow'.split(' '));
const NON_SKILL_LABELS = new Set('about careers employer home sitemap credits help center summons notices grievances report issue privacy policy terms conditions fraud alert trust safety apply get real connect time app ltd limited copyright contact login signup subscribe download share follow'.split(' '));

// ------------------------------
// STATUS
// ------------------------------

function setStatus(message, type = 'info') {
  const el = $('status');

  if (!el) return;

  el.textContent = message;
  el.dataset.type = type;
  const visibleStatus = $('actionStatus');
  if (visibleStatus) {
    visibleStatus.textContent = message;
    visibleStatus.dataset.type = type;
    visibleStatus.classList.toggle('hidden', !message || message === 'Ready');
  }
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function matchScoreFromComponents(scores) {
  const weights = { skills: 0.45, keywords: 0.25, experience: 0.20, education: 0.10 };
  let total = 0;
  let weight = 0;
  Object.entries(weights).forEach(([key, value]) => {
    const score = scores?.[key];
    if (score === null || score === undefined || !Number.isFinite(Number(score))) return;
    total += Math.max(0, Math.min(100, Number(score))) * value;
    weight += value;
  });
  return weight ? Math.round(total / weight) : null;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function containsTerm(text, term) {
  const escaped = escapeRegex(term);
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

function localQuickScore(resumeText, jobDescription) {
  const resume = ` ${cleanText(resumeText).toLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, ' ')} `;
  const job = cleanText(jobDescription).toLowerCase();
  const jobLines = String(jobDescription || '').split(/[\r\n•;.!?]+/).map(line => line.toLowerCase().trim()).filter(Boolean);
  const requirementLines = jobLines.filter(line => /\b(?:must|required|preferred|requirement|responsibilit|qualification|experience with|knowledge of|proficien|certif|degree|build|manage|analy[sz]|deploy|design|operate|support)\b/.test(line));
  const relevantText = requirementLines.length ? requirementLines.join(' ') : jobLines.join(' ');
  const tokensFrom = text => [...new Set((text.match(/[\p{L}][\p{L}\p{N}+#.]{2,}/gu) || []).filter(word => !LOCAL_STOP_WORDS.has(word)))];
  const requirements = tokensFrom(relevantText).slice(0, 80);
  const allKeywords = tokensFrom(jobLines.join(' ')).slice(0, 100);
  const matchedTerms = requirements.filter(term => containsTerm(resume, term));
  const missingTerms = requirements.filter(term => !containsTerm(resume, term));
  const matchedKeywords = allKeywords.filter(term => containsTerm(resume, term));
  const missingKeywords = allKeywords.filter(term => !containsTerm(resume, term)).slice(0, 8);
  const requiredYears = jobDescription.match(/\b(?:minimum|min\.?|at least)?\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/i)
    || jobDescription.match(/\b(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience\b/i);
  const candidateYears = resumeText.match(/\b(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience\b/i);
  const degreeRequired = /\b(?:bachelor|b\.?tech|b\.?e\.?|b\.?s\.?|master|m\.?tech|m\.?s\.?|ph\.?d|degree)\b/i.test(jobDescription);
  const degreeCandidate = cleanText(resumeText).match(/\b(?:B\.?Tech(?:nology)?|B\.?E\.?|B\.?Sc\.?|M\.?Tech(?:nology)?|M\.?E\.?|M\.?Sc\.?|M\.?B\.?A\.?|Ph\.?D|Bachelor(?:'s)?|Master(?:'s)?)\b[^\r\n,;]*/i);
  let experienceScore = null;
  if (requiredYears && candidateYears) {
    const minYears = Number(requiredYears[1]);
    experienceScore = minYears > 0 ? Math.min(100, Math.round(Number(candidateYears[1]) / minYears * 100)) : 100;
  }
  const educationScore = !degreeRequired ? null : degreeCandidate ? (containsTerm(job, 'related') || containsTerm(job, 'equivalent') ? 80 : 70) : 0;
  const scores = {
    skills: requirements.length ? Math.round(matchedTerms.length / requirements.length * 100) : null,
    experience: experienceScore,
    keywords: allKeywords.length ? Math.round(matchedKeywords.length / allKeywords.length * 100) : null,
    education: educationScore
  };
  const score = matchScoreFromComponents(scores);
  return {
    scores,
    matchScore: score,
    matchLevel: score === null ? 'Not scored' : score >= 80 ? 'Strong Match' : score >= 65 ? 'Good Match' : score >= 40 ? 'Partial Match' : 'Low Match',
    confidence: 'low',
    verdict: 'Quick estimate based on matching resume and job-description terms.',
    reasons: [],
    matchedSkills: { technical: matchedTerms.slice(0, 24), soft: [] },
    equivalentSkills: [],
    missingSkills: missingTerms.slice(0, 24),
    missingKeywords,
    fitChecks: [],
    experience: {
      requiredMin: requiredYears ? Number(requiredYears[1]) : null,
      requiredMax: requiredYears?.[2] ? Number(requiredYears[2]) : requiredYears ? Number(requiredYears[1]) : null,
      candidateYears: candidateYears ? Number(candidateYears[1]) : null,
      note: requiredYears ? 'Estimated from visible years-of-experience text.' : 'The job description does not state an experience requirement.'
    },
    model: 'local-quick-estimate',
    cached: false,
    latencyMs: 0
  };
}

async function overviewCacheKey(resumeText, jobDescription) {
  const digestText = sha256Hex;
  const normalizedResume = cleanText(resumeText);
  const normalizedJob = cleanText(jobDescription
    .replace(/^\s*(?:about (?:the )?company|walk[- ]in (?:details|interview)|follow us|connect with us|privacy policy|terms of use)\b.*$/gim, ' ')
    .replace(/^\s*(?:home|jobs|login|sign up|download app)\s*(?:\|.*)?$/gim, ' ')
    .slice(0, 6000)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const resumeHash = await digestText(normalizedResume);
  return `matchOverview:${await digestText(`${resumeHash}\r\n${normalizedJob}\r\ngemini-2.5-flash\r\noverview-evidence-v4-noise-filter`)}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function lookupResumeProfile(resumeText, attempt = 0) {
  const normalized = cleanText(resumeText);
  if (!normalized) return null;
  const resumeHash = await sha256Hex(normalized);
  const localKey = `resumeProfile:${resumeHash}`;
  const saved = await chrome.storage.local.get([localKey]);
  if (saved[localKey]?.profile) return { profile: saved[localKey].profile, resumeHash };
  if (resumeProfileLookups.has(resumeHash)) return resumeProfileLookups.get(resumeHash);
  const lookup = (async () => {
    try {
      const result = await api('/ai/profile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText: normalized })
      });
      if (result.profile) {
        await chrome.storage.local.set({ [localKey]: { profile: result.profile, resumeHash, savedAt: Date.now() } });
        return { profile: result.profile, resumeHash };
      }
      if (attempt < 6) window.setTimeout(() => { void lookupResumeProfile(resumeText, attempt + 1); }, 1800);
    } catch { /* Raw resume text remains the fallback while the profile is unavailable. */ }
    return null;
  })();
  resumeProfileLookups.set(resumeHash, lookup);
  try { return await lookup; }
  finally { resumeProfileLookups.delete(resumeHash); }
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
  try { database.close(); } catch { /* The extension may be reloaded while IndexedDB work is finishing. */ }
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
    url: cleanText($('jobUrl').value),
    companyApplyUrl: cleanText(jobMetadata.companyApplyUrl)
  };
}

async function resumeWorkflowKey(job) {
  const normalized = `${job.url || ''}|${job.title || ''}|${job.company || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].slice(0, 16).map(value => value.toString(16).padStart(2, '0')).join('');
}

async function persistResumeWorkflow(workflow) {
  workflow.updatedAt = new Date().toISOString();
  resumeWorkflows = [workflow, ...resumeWorkflows.filter(item => item.jobKey !== workflow.jobKey)];
  activeResumeWorkflow = workflow;
  try {
    await chrome.storage.local.set({
      resumeWorkflows,
      activeResumeJobKey: workflow.jobKey,
      activeJobSnapshot: currentJobPayload(),
      activeJobAnalysis: lastAnalysis
    });
  } catch (error) {
    if (/extension context invalidated/i.test(String(error?.message || error))) return workflow;
    throw error;
  }
  renderResumeWorkflow();
}

async function activateResumeWorkflow(job = currentJobPayload(), tabId = null) {
  if (!job.url && !job.title) return;
  const key = await resumeWorkflowKey(job);
  activeResumeWorkflow = resumeWorkflows.find(item => item.jobKey === key) || {
    jobKey: key, jobUrl: job.url, title: job.title, company: job.company,
    status: 'JOB_DETECTED', selectedType: '', temporaryResumeId: '', temporaryResumeName: '',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  activeResumeWorkflow.jobUrl = job.url;
  activeResumeWorkflow.title = job.title;
  activeResumeWorkflow.company = job.company;
  if (job.companyApplyUrl) activeResumeWorkflow.companyApplyUrl = job.companyApplyUrl;
  if (tabId) activeResumeWorkflow.jobTabId = tabId;
  await persistResumeWorkflow(activeResumeWorkflow);
  await loadWorkflowResumePreview();
}

function renderResumeDocumentPreview(text) {
  const container = $('applyResumePreviewContent');
  container.replaceChildren();
  const lines = String(text || '').replace(/\r/g, '').split('\r\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return;
  if (lines.length === 1 && /^(?:loading|resume preview is unavailable|resume text preview is unavailable)/i.test(lines[0])) {
    const message = document.createElement('p');
    message.className = 'resume-document-message';
    message.textContent = lines[0];
    container.append(message);
    return;
  }

  const page = document.createElement('article');
  page.className = 'resume-document-page';
  const contactPattern = /@|\+?\d[\d\s().-]{7,}|linkedin\.com|github\.com|https?:\/\/|\b(?:jaipur|delhi|mumbai|bengaluru|bangalore|pune|hyderabad|gurugram|noida)\b/i;
  const headingNames = new Set([
    'summary', 'professional summary', 'profile', 'career objective', 'objective',
    'experience', 'work experience', 'professional experience', 'employment history',
    'education', 'technical skills', 'skills', 'core skills', 'projects',
    'personal projects', 'certifications', 'certificate', 'achievements', 'awards',
    'internships', 'internship', 'languages', 'publications', 'volunteer experience',
    'personal details', 'interests', 'additional information'
  ]);
  const cleanHeading = line => line.replace(/[:|]+$/, '').trim().toLowerCase();
  const looksLikeHeading = line => {
    const cleaned = cleanHeading(line);
    if (headingNames.has(cleaned)) return true;
    const letters = line.replace(/[^a-z]/gi, '');
    return line.length < 58 && letters.length > 2 && (line === line.toUpperCase() || /:$/.test(line));
  };
  const name = lines.shift();
  const nameHeading = document.createElement('h1');
  nameHeading.className = 'resume-document-name';
  nameHeading.textContent = name;
  page.append(nameHeading);

  const contactLines = [];
  while (lines.length && contactPattern.test(lines[0]) && contactLines.length < 4) contactLines.push(lines.shift());
  if (contactLines.length) {
    const contact = document.createElement('p');
    contact.className = 'resume-document-contact';
    contact.textContent = contactLines.join('  ·  ');
    page.append(contact);
  }

  let sectionBody = page;
  let bulletList = null;
  const flushList = () => { bulletList = null; };
  for (const line of lines) {
    if (looksLikeHeading(line)) {
      flushList();
      const section = document.createElement('section');
      section.className = 'resume-document-section';
      const heading = document.createElement('h2');
      heading.textContent = line.replace(/[:|]+$/, '').trim();
      section.append(heading);
      page.append(section);
      sectionBody = section;
      continue;
    }
    const bullet = line.match(/^(?:[•●▪◦*-]|\d+[.)])\s*(.+)$/);
    if (bullet) {
      if (!bulletList) {
        bulletList = document.createElement('ul');
        bulletList.className = 'resume-document-list';
        sectionBody.append(bulletList);
      }
      const item = document.createElement('li');
      item.textContent = bullet[1];
      bulletList.append(item);
      continue;
    }
    flushList();
    const paragraph = document.createElement('p');
    paragraph.className = 'resume-document-paragraph';
    paragraph.textContent = line;
    sectionBody.append(paragraph);
  }
  container.append(page);
}

async function tailorResumeForActiveJob(options = {}) {
  if (tailoringRequestInProgress || tailorGenerationInProgress) return;
  tailoringRequestInProgress = true;
  updatePrimaryAction();
  try { return await performTailoringForActiveJob(options); }
  catch (error) {
    if (activeResumeWorkflow) {
      await persistResumeWorkflow({
        ...activeResumeWorkflow,
        status: 'TAILORING_FAILED',
        lastError: error.message || 'Resume tailoring failed. Retry.'
      }).catch(() => {});
    }
    setStatus(error.message || 'Resume tailoring failed. Retry.', 'error');
    throw error;
  }
  finally {
    tailoringRequestInProgress = false;
    updatePrimaryAction();
  }
}

async function performTailoringForActiveJob({ applyAfter = false, forceRegenerate = false } = {}) {
  if (!activeResumeWorkflow) throw new Error('Open a Naukri job listing first.');
  const jobKey = activeResumeWorkflow.jobKey;
  const masterText = $('resumeText').value.trim();
  if (!masterText) throw new Error('Upload your Master Resume first.');
  if (!$('jobDescription').value.trim()) throw new Error('The job description was not captured. Open the job description or paste it, then retry.');
  const master = await readResumeFile('master');
  if (!master?.file || !/\.docx$/i.test(master.name || resumeFileName || '')) {
    throw new Error('To preserve the original design, use the Master Resume DOCX before tailoring.');
  }

  await persistResumeWorkflow({
    ...activeResumeWorkflow, selectedType: 'tailored', status: 'TAILORING_IN_PROGRESS',
    lastError: '', tailoringProgress: 'Preparing job analysis and resume suggestions.'
  });
  setStatus('Tailoring this resume for the selected job…', 'info');
  renderResumeWorkflow();

  // Keep score refinement running in the background. The local estimate is enough
  // to start tailoring while the overview request continues independently.
  if (!quickOverview) {
    quickOverview = localQuickScore(masterText, $('jobDescription').value.trim());
    renderAnalysis(quickOverview, 'quick');
  }
  if (!analysisPromise && !lastAnalysis) void analyzeCurrentMatch(true);
  let data = suggestionData;
  if (forceRegenerate || !data) data = await loadAiSuggestions({ forceRegenerate });
  if (activeResumeWorkflow?.jobKey !== jobKey) throw new Error('The selected job changed while tailoring. Open the intended job and retry.');
  if (!data) throw new Error(`AI tailoring could not finish: ${suggestionLoadError || 'check your connection and retry.'}`);

  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  await persistResumeWorkflow({
    ...activeResumeWorkflow,
    selectedType: 'tailored',
    status: 'TAILORING_REVIEW',
    tailoringSuggestions: suggestions,
    tailoringCautions: data.cautions || [],
    rejectedSuggestions: data.rejectedSuggestions || [],
    tailoringApplyAfter: Boolean(applyAfter),
    acceptedTailoringEditIndexes: suggestions.map((edit, index) => edit?.safeToApply === true && edit?.validation === 'verified' ? index : -1).filter(index => index >= 0),
    lastError: ''
  });
  renderResumeWorkflow();
  if (applyAfter || !unansweredTailoringRequirements(Array.isArray(lastAnalysis?.requirements) ? lastAnalysis.requirements : []).length) {
    setStatus('No confirmations needed. Continuing…', 'info');
    await generateApprovedTailoredResume();
    return;
  }
  $('tailoringReviewCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setStatus('Resume ready to tailor.', 'success');
}

async function handleTailorAction(applyAfter) {
  try {
    const workflow = activeResumeWorkflow;
    if (applyAfter) {
      const destinationUrl = workflow?.companyApplyUrl || jobMetadata.companyApplyUrl;
      let destination = null;
      try { if (destinationUrl) destination = new URL(destinationUrl); } catch { /* Continue to Naukri when no valid external URL was captured. */ }
      if (destination?.protocol === 'https:' && !/(^|\.)naukri\.com$/i.test(destination.hostname)) {
        const granted = await chrome.permissions.request({ origins: [`${destination.origin}/*`] });
        if (!granted) throw new Error('Allow access to the company application site, then click Tailor & Apply again.');
      }
    }
    if (workflow?.status === 'APPLICATION_IN_PROGRESS' && workflow.companyApplicationTabId) {
      const applicationTab = await chrome.tabs.get(workflow.companyApplicationTabId).catch(() => null);
      if (applicationTab?.id) {
        await chrome.tabs.update(applicationTab.id, { active: true });
        if (applicationTab.windowId != null) await chrome.windows.update(applicationTab.windowId, { focused: true }).catch(() => {});
        if (workflow.companySubmitClickedAt || workflow.companySubmitAttemptedAt) {
          setStatus('A submit attempt was already made. Check the company site before retrying.', 'info');
        } else {
          await autoFillCompanyApplication(applicationTab.id);
        }
      }
      return;
    }
    if (workflow?.status === 'TAILORING_REVIEW') {
      await generateApprovedTailoredResume();
      return;
    }
    if (workflow?.selectedType === 'master') {
      if (applyAfter) await chooseResumeForThisJob();
      else { await loadWorkflowResumePreview(); $('tailoredResumeSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      return;
    }
    if (workflow?.temporaryResumeId && applyAfter) {
      await chooseResumeForThisJob();
      return;
    }
    if (!applyAfter && workflow?.temporaryResumeId) {
      await loadWorkflowResumePreview();
      $('tailoredResumeSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    await tailorResumeForActiveJob({ applyAfter });
  } catch (error) {
    setStatus(error.message || 'Tailored resume could not be generated.', 'error');
  }
}

function renderTailoringReview(workflow = activeResumeWorkflow) {
  const card = $('tailoringReviewCard');
  if (!card) return;
  const open = workflow?.status === 'TAILORING_REVIEW';
  card.classList.toggle('hidden', !open);
  if (!open) return;
  const requirements = $('tailoringReviewRequirements');
  requirements.replaceChildren();
  const items = Array.isArray(lastAnalysis?.requirements) ? lastAnalysis.requirements : [];
  const matched = items.filter(item => ['EXACT_MATCH', 'EQUIVALENT_MATCH', 'RELATED_EXPERIENCE'].includes(item?.classification));
  const askItems = unansweredTailoringRequirements(items);
  const requirementHeading = document.createElement('div');
  requirementHeading.className = 'requirements-heading';
  const requirementTitle = document.createElement('strong'); requirementTitle.textContent = 'Job requirements';
  const requirementCount = document.createElement('span'); requirementCount.textContent = `${matched.length} matched · ${askItems.length} to confirm`;
  requirementHeading.append(requirementTitle, requirementCount);
  requirements.append(requirementHeading);
  const requirementList = document.createElement('div'); requirementList.className = 'requirements-list';
  items.slice(0, 24).forEach(item => {
    const row = document.createElement('article'); row.className = 'requirement-row';
    const title = document.createElement('strong'); title.textContent = item.name || 'Requirement';
    const status = String(item.classification || 'UNKNOWN').replaceAll('_', ' ').toLowerCase();
    const badge = document.createElement('span'); badge.className = `requirement-status ${['exact match', 'equivalent match', 'related experience'].includes(status) ? 'is-matched' : 'is-missing'}`;
    badge.textContent = status;
    const top = document.createElement('div'); top.className = 'requirement-row-heading'; top.append(title, badge); row.append(top);
    if (item.evidence) { const evidence = document.createElement('p'); evidence.textContent = item.evidence; row.append(evidence); }
    requirementList.append(row);
  });
  if (!items.length) { const loading = document.createElement('p'); loading.className = 'requirements-empty'; loading.textContent = 'Requirements are loading.'; requirementList.append(loading); }
  requirements.append(requirementList);

  if (askItems.length) {
    requirementConfirmationIndex = Math.min(requirementConfirmationIndex, askItems.length - 1);
    const item = askItems[requirementConfirmationIndex];
    const key = normalizeAnswerKey(item.name);
    const saved = candidateRequirementConfirmations[key] || {};
    const confirmation = document.createElement('section'); confirmation.className = 'tailoring-confirmation-step';
    const stepLabel = document.createElement('span'); stepLabel.className = 'confirmation-step-count'; stepLabel.textContent = `Confirm skill ${requirementConfirmationIndex + 1} of ${askItems.length}`;
    const question = document.createElement('strong'); question.className = 'confirmation-question'; question.textContent = item.name;
    const choices = document.createElement('div'); choices.className = 'confirmation-choice-list';
    [['practical', 'Practical experience'], ['basic', 'Basic knowledge'], ['no', 'No experience']].forEach(([value, label]) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'confirmation-choice'; button.textContent = label;
      button.setAttribute('aria-pressed', String(saved.status === value));
      button.addEventListener('click', async () => {
        choices.querySelectorAll('button').forEach(choice => { choice.disabled = true; });
        try {
          candidateRequirementConfirmations[key] = { name: item.name, status: value, details: '', updatedAt: new Date().toISOString() };
          await chrome.storage.local.set({ [CONFIRMED_REQUIREMENT_FACTS_KEY]: candidateRequirementConfirmations });
          if (requirementConfirmationIndex + 1 < askItems.length) {
            requirementConfirmationIndex += 1;
            renderTailoringReview(workflow);
          } else {
            requirementConfirmationIndex = 0;
            setStatus('Refreshing suggestions…', 'info');
            await tailorResumeForActiveJob({ applyAfter: Boolean(workflow.tailoringApplyAfter), forceRegenerate: true });
          }
        } catch (error) {
          choices.querySelectorAll('button').forEach(choice => { choice.disabled = false; });
          setStatus(error.message || 'Could not save that choice.', 'error');
        }
      });
      choices.append(button);
    });
    confirmation.append(stepLabel, question, choices);
    requirements.append(confirmation);
  }

  const editRoot = $('tailoringReviewEdits'); editRoot.replaceChildren();
  const suggestions = Array.isArray(workflow.tailoringSuggestions) ? workflow.tailoringSuggestions : [];
  const accepted = new Set(workflow.acceptedTailoringEditIndexes || []);
  suggestions.forEach((edit, index) => {
    const article = document.createElement('details'); article.className = 'tailoring-edit-card';
    const label = document.createElement('summary');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.tailoringEditIndex = String(index);
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.checked = accepted.has(index) && edit.safeToApply === true && edit.validation === 'verified';
    checkbox.disabled = edit.safeToApply !== true || edit.validation !== 'verified';
    checkbox.addEventListener('change', () => {
      const selectedIndexes = new Set(activeResumeWorkflow?.acceptedTailoringEditIndexes || []);
      if (checkbox.checked) selectedIndexes.add(index); else selectedIndexes.delete(index);
      if (activeResumeWorkflow) {
        activeResumeWorkflow.acceptedTailoringEditIndexes = [...selectedIndexes];
        void chrome.storage.local.set({ resumeWorkflows });
      }
    });
    const heading = document.createElement('span'); heading.textContent = `${String(edit.section || 'resume').replace(/^./, value => value.toUpperCase())}${edit.relatedRequirement ? ` · ${edit.relatedRequirement}` : ''} · ${Math.round((Number(edit.confidence) || 0) * 100)}% confidence`;
    label.append(checkbox, heading); article.append(label);
    const before = document.createElement('p'); before.textContent = `Before: ${edit.before || ''}`;
    const afterLabel = document.createElement('strong'); afterLabel.textContent = 'After';
    const after = document.createElement('textarea'); after.value = edit.after || ''; after.setAttribute('aria-label', `Proposed ${edit.section || 'resume'} text`); after.dataset.tailoringEditText = String(index);
    after.addEventListener('input', () => {
      if (activeResumeWorkflow?.tailoringSuggestions?.[index]) {
        activeResumeWorkflow.tailoringSuggestions[index].after = after.value;
        void chrome.storage.local.set({ resumeWorkflows });
      }
    });
    const reason = document.createElement('p'); reason.textContent = edit.reason || '';
    const evidence = document.createElement('p'); evidence.textContent = (edit.evidence || []).join('; ');
    if (!reason.textContent) reason.remove();
    if (!evidence.textContent) evidence.remove();
    article.append(before, afterLabel, after, reason, evidence); editRoot.append(article);
  });
}

function unansweredTailoringRequirements(items = []) {
  return items.filter(item => ['MISSING', 'UNKNOWN'].includes(item?.classification)
    && ['REQUIRED_SKILL', 'PREFERRED_SKILL', 'EXPERIENCE', 'PROJECT_RESPONSIBILITY', 'EDUCATION_CERTIFICATION'].includes(item?.category)
    && !candidateRequirementConfirmations[normalizeAnswerKey(item.name)]).slice(0, 8);
}

async function saveRequirementConfirmations(regenerate = false) {
  await chrome.storage.local.set({ [CONFIRMED_REQUIREMENT_FACTS_KEY]: candidateRequirementConfirmations });
  if (regenerate && activeResumeWorkflow) {
    await tailorResumeForActiveJob({ applyAfter: Boolean(activeResumeWorkflow.tailoringApplyAfter), forceRegenerate: true });
  } else setStatus('Your confirmed facts were saved in this browser.', 'success');
  return true;
}

function confirmedCandidateFacts({ positiveOnly = false } = {}) {
  return Object.values(candidateRequirementConfirmations).filter(item => item?.name && item?.status
    && (!positiveOnly || ['practical', 'basic'].includes(item.status)))
    .map(item => item.status === 'no'
      ? `Candidate explicitly confirmed no experience with ${item.name}.`
      : `Candidate explicitly confirmed ${item.status === 'practical' ? 'practical experience' : 'basic knowledge'} with ${item.name}.${item.details ? ` Details: ${item.details}` : ''}`);
}

async function generateApprovedTailoredResume() {
  const workflow = activeResumeWorkflow;
  if (workflow?.status !== 'TAILORING_REVIEW') return;
  if (!await saveRequirementConfirmations(false)) return;
  const selected = [...$('tailoringReviewEdits').querySelectorAll('[data-tailoring-edit-index]:checked')];
  const edits = [];
  let working = $('resumeText').value.trim();
  const allSuggestions = Array.isArray(workflow.tailoringSuggestions) ? workflow.tailoringSuggestions : [];
  const itemsToProcess = selected.length ? selected.map(control => {
    const idx = Number(control.dataset.tailoringEditIndex);
    return { source: allSuggestions[idx], text: $('tailoringReviewEdits').querySelector(`[data-tailoring-edit-text="${idx}"]`)?.value.trim() };
  }) : allSuggestions.filter(s => s && s.safeToApply === true && s.validation === 'verified').map(s => ({ source: s, text: s.after }));
  for (const { source, text } of itemsToProcess) {
    if (!source || source.safeToApply !== true || source.validation !== 'verified' || !source.before || !text) continue;
    if (!working.includes(source.before)) continue;
    working = working.replace(source.before, text);
    edits.push({ ...source, after: text });
  }
  approvedTailoringEdits = edits;
  tailoredWorkingCopy = working;
  const applyAfter = Boolean(workflow.tailoringApplyAfter);
  await persistResumeWorkflow({
    ...workflow, status: 'TAILORING_IN_PROGRESS', acceptedTailoringEditIndexes: selected.map(control => Number(control.dataset.tailoringEditIndex)),
    tailoringSuggestions: workflow.tailoringSuggestions.map((item, index) => {
      const acceptedEdit = edits.find(edit => edit.id === item.id);
      return acceptedEdit ? { ...item, after: acceptedEdit.after } : item;
    }), lastError: ''
  });
  setStatus('Generating a separate resume from the unchanged Master Resume…', 'info');
  try {
    await generateTemporaryResumeForActiveJob();
    if (activeResumeWorkflow?.temporaryResumeId) {
      $('tailoredResumeSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setStatus(`Tailored resume ready with ${edits.length} approved edit(s). The Master Resume is unchanged.`, 'success');
      if (applyAfter) await chooseResumeForThisJob();
    }
  } catch (error) { setStatus(`Could not generate the tailored DOCX: ${error.message}`, 'error'); }
}

function renderResumeWorkflow() {
  const workflow = activeResumeWorkflow;
  const hasJob = Boolean(workflow);
  const hasResumeSelection = Boolean(workflow?.selectedType === 'tailored' && workflow.temporaryResumeName)
    || Boolean(workflow?.selectedType === 'master' && resumeFileName);
  const tailoring = ['TAILORING_IN_PROGRESS', 'TAILORING_REVIEW', 'TAILORING_FAILED'].includes(workflow?.status);
  const hasSelectedFile = hasResumeSelection && workflow?.status !== 'MASTER_RESUME_RESTORED';
  const states = {
    JOB_DETECTED: 'Analyzing…',
    JD_ANALYZED: lastAnalysis ? `Match ${lastAnalysis.matchScore ?? 'N/A'}% · Choose a resume.` : 'Waiting for analysis.',
    TAILORING_IN_PROGRESS: 'Tailoring this resume for the selected job.',
    TAILORING_REVIEW: 'Review proposed resume edits.',
    TAILORING_FAILED: 'Tailoring needs a retry.',
    MASTER_RESUME_SELECTED: 'Master resume selected.',
    MASTER_RESUME_UPLOADED: 'Master resume uploaded and verified.',
    TAILORED_RESUME_GENERATED: 'Tailored resume ready.',
    WAITING_FOR_PROFILE_UPLOAD: 'Upload the resume on Naukri.',
    TEMPORARY_RESUME_UPLOADED: 'Resume uploaded.',
    APPLICATION_IN_PROGRESS: 'Application in progress.',
    APPLICATION_SUBMITTED: 'Submitted. Restore the master resume.',
    RESTORATION_PENDING: 'Restore and verify the master resume.',
    MASTER_RESUME_RESTORED: 'Master resume restored.',
    RESTORATION_FAILED: 'Restoration failed. Retry.',
    APPLICATION_CANCELLED: 'Cancelled. Restore the master resume.'
  };
  $('activeWorkflowStatus').textContent = workflow ? states[workflow.status] || workflow.status : 'Waiting for job analysis.';
  const canAnswerQuestions = Boolean(
    (workflow && ['APPLICATION_IN_PROGRESS', 'APPLICATION_SUBMITTED'].includes(workflow.status))
    || (/^https:\/\/(?:[^/]+\.)?naukri\.com\/job-listings?-/i.test(currentJobTabUrl) && Boolean(resumeFileName))
  );
  $('applicationAnswersSection').classList.toggle('hidden', !canAnswerQuestions);
  $('tailoredResumeSection').classList.toggle('hidden', !hasResumeSelection && !tailoring);
  $('activeWorkflowHeading').textContent = workflow?.selectedType === 'master' ? 'Master Resume for This Job' : 'Tailored Resume';
  $('applyResumePreview').classList.toggle('hidden', !hasResumeSelection && !tailoring);
  renderTailoringReview(workflow);
  $('activeResumePreview').classList.toggle('hidden', !hasResumeSelection);
  $('applyResumePreviewFilename').textContent = workflow?.selectedType === 'tailored' ? workflow.temporaryResumeName : workflow?.selectedResumeName || resumeFileName;
  const selectedName = workflow?.selectedType === 'tailored' ? workflow.temporaryResumeName : workflow?.selectedResumeName || resumeFileName;
  const fileType = /\.pdf$/i.test(selectedName || '') ? 'PDF' : 'DOC';
  $('tailoredResumeIcon').classList.toggle('pdf-file-icon', fileType === 'PDF');
  $('tailoredResumeIcon').classList.toggle('doc-file-icon', fileType === 'DOC');
  $('tailoredResumeIcon').innerHTML = createResumeFileIcon(fileType);
  const fileSize = workflow?.selectedType === 'tailored' ? workflow.temporaryResumeSize : resumeFileSize;
  const uploaded = ['TEMPORARY_RESUME_UPLOADED', 'MASTER_RESUME_UPLOADED', 'APPLICATION_IN_PROGRESS', 'APPLICATION_SUBMITTED'].includes(workflow?.status);
  const restored = workflow?.status === 'MASTER_RESUME_RESTORED';
  const uploading = workflow?.status === 'UPLOADING_RESUME';
  const fileState = restored ? 'Master resume restored' : uploading ? 'Uploading to Naukri' : uploaded ? 'Uploaded and verified on Naukri' : 'Saved in this browser';
  $('tailoredResumeStatus').textContent = `${fileSize ? `${Math.max(1, Math.round(fileSize / 1024))} KB · ` : ''}${fileState}${workflow?.validationNote ? ' · Validated' : ''}`;
  $('tailoredResumeStatus').title = workflow?.validationNote || '';
  renderResumeDocumentPreview(activeResumePreviewText || (hasResumeSelection ? 'Loading resume preview...' : ''));
  $('manualUploadGuide').classList.add('hidden');
  $('returnToJobBtn').classList.toggle('hidden', !hasJob || !workflow?.jobUrl);
  $('workflowError').textContent = workflow?.lastError || '';
  $('workflowError').classList.add('sr-only');
  $('viewTailoredResumeBtn').classList.toggle('hidden', !hasSelectedFile);
  $('downloadActiveResumeBtn').classList.toggle('hidden', !hasSelectedFile);
}

$('viewTailoredResumeBtn').addEventListener('click', () => {
  const preview = $('applyResumePreviewContent');
  const open = preview.classList.contains('hidden');
  preview.classList.toggle('hidden', !open);
  if (open) preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

function renderManualUploadGuide(workflow) {
  const guide = $('manualUploadGuide');
  guide.replaceChildren();
  const show = Boolean(workflow?.manualUploadNeeded);
  guide.classList.toggle('hidden', !show);
  if (!show) return;
  const downloadLocation = workflow.lastDownloadFolder ? `Downloads/${workflow.lastDownloadFolder}` : 'Downloads';
  const steps = [
    'Click “Update resume” on Naukri.',
    `If the upload did not start automatically, click Download, then choose ${workflow.temporaryResumeName || workflow.selectedResumeName || 'the selected resume'} from ${downloadLocation}.`,
    'Return here after Naukri confirms the upload.'
  ];
  steps.forEach(text => { const item = document.createElement('li'); item.textContent = text; guide.append(item); });
}

const SENSITIVE_QUESTION_PATTERN = /\b(?:gender|race|ethnicity|disability|veteran|military|sexual orientation|visa|work authorization|sponsor(?:ship)?|authorized to work|eligible to work|work permit|citizenship|nationality|criminal|background check|date of birth|birth date|age|consent|terms and conditions|declaration|attest)\b|\b(?:do you agree|confirm that you agree)\b/i;

function normalizeAnswerKey(value) {
  return cleanText(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

function mapApplicationQuestionField(question) {
  const text = normalizeAnswerKey(question);
  if (/full name|candidate name|your name|first name|last name/.test(text)) return 'fullName';
  if (/\bemail\b|email id/.test(text)) return 'email';
  if (/\bphone\b|\bmobile\b|contact number/.test(text)) return 'phone';
  if (/graduat|passing year|pass out|completion year|year of (?:your )?(?:degree|study)|when did you (?:complete|graduate)/.test(text)) return 'graduationYear';
  if (/highest qualification|highest education|degree|educational qualification|course|major|branch of study/.test(text)) return 'qualification';
  if (/college|university|institute|school name/.test(text)) return 'college';
  if (/current (?:city|location|residence)|where do you live|location/.test(text)) return 'currentLocation';
  if (/programming language|languages do you know/.test(text)) return 'programmingLanguages';
  if (/technical skills|skills do you know|technologies do you know|frameworks do you know/.test(text)) return 'technicalSkills';
  if (/how many years|total experience|years of experience|experience do you have/.test(text)) return 'totalExperience';
  if (/notice period|when can you join|joining date|available to join|immediate join|available immediately/.test(text)) return 'availability';
  if (/expected (?:salary|ctc|compensation)|salary expectation|expected pay/.test(text)) return 'expectedSalary';
  if (/current (?:salary|ctc)|present (?:salary|ctc)/.test(text)) return 'currentSalary';
  if (/relocat/.test(text)) return 'willingToRelocate';
  if (/work arrangement|work mode|work from (?:home|office)|on.?site|remote work/.test(text)) return 'preferredWorkArrangement';
  if (/write a message|message|cover letter|why should we hire|about yourself|note to recruiter|additional info/.test(text)) return 'coverLetter';
  return '';
}

function extractVerifiedResumeAnswer(fieldKey, resumeText) {
  const text = String(resumeText || '').replace(/\r/g, '');
  const lines = text.split('\r\n').map(line => line.replace(/^\s*[•*-]\s*/, '').trim()).filter(Boolean);
  const section = (start, end) => {
    const startIndex = lines.findIndex(line => new RegExp(`^${start}(?:\\s|$)`, 'i').test(line));
    if (startIndex < 0) return [];
    const remaining = lines.slice(startIndex + 1);
    const endIndex = remaining.findIndex(line => new RegExp(`^(?:${end})(?:\\s|$)`, 'i').test(line));
    return remaining.slice(0, endIndex < 0 ? remaining.length : endIndex);
  };
  if (fieldKey === 'fullName') return lines[0] || '';
  if (fieldKey === 'email') return text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/i)?.[0] || '';
  if (fieldKey === 'phone') return text.match(/\+?\d[\d ()-]{7,}\d/)?.[0]?.trim() || '';
  if (fieldKey === 'currentLocation') {
    const contactLine = lines.slice(1, 5).find(line => /\+?\d[\d ()-]{7,}\d/.test(line) && /[,|]/.test(line));
    return contactLine?.split('|')[0]?.trim() || '';
  }
  if (fieldKey === 'qualification' || fieldKey === 'college' || fieldKey === 'graduationYear') {
    const education = section('EDUCATION', 'CERTIFICATIONS|ACHIEVEMENTS|PROJECTS|SKILLS|EXPERIENCE');
    if (fieldKey === 'graduationYear') {
      const educationText = education.join(' ');
      const years = [...educationText.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]));
      return years.length ? String(Math.max(...years)) : '';
    }
    const degreeLine = education.find(line => /\b(?:B\.?Tech|B\.?E\.?|B\.?Sc\.?|M\.?Tech|M\.?E\.?|M\.?Sc\.?|MCA|BCA|Bachelor|Master|Ph\.?D)\b/i.test(line)) || '';
    if (fieldKey === 'qualification') return degreeLine.match(/\b(?:B\.?Tech(?:nology)?|B\.?E\.?|B\.?Sc\.?|M\.?Tech(?:nology)?|M\.?E\.?|M\.?Sc\.?|MCA|BCA|Bachelor(?:'s)?|Master(?:'s)?|Ph\.?D)\b[^|()]*/i)?.[0]?.trim() || '';
    return degreeLine.match(/\b(?:PIET|[A-Z][A-Za-z]+\s+(?:University|College|Institute)|Institute of [^,|]+|University of [^,|]+)/i)?.[0]?.trim() || '';
  }
  if (fieldKey === 'programmingLanguages') {
    const skills = section('SKILLS', 'EXPERIENCE|INTERNSHIP|PROJECTS|EDUCATION');
    const languageLine = skills.find(line => /^languages\s*:/i.test(line));
    return languageLine?.replace(/^languages\s*:\s*/i, '').trim() || '';
  }
  if (fieldKey === 'technicalSkills') {
    const skills = section('SKILLS', 'EXPERIENCE|INTERNSHIP|PROJECTS|EDUCATION');
    return skills.join('; ');
  }
  if (fieldKey === 'totalExperience') {
    const explicit = text.match(/\b(?:total |overall )?(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+)?experience\b/i);
    return explicit?.[1] ? `${explicit[1]}` : '1';
  }
  if (fieldKey === 'coverLetter') {
    const skills = extractVerifiedResumeAnswer('programmingLanguages', resumeText)
      || extractVerifiedResumeAnswer('technicalSkills', resumeText)
      || 'modern software frameworks, web application architecture, and scalable system design';
    const totalExp = extractVerifiedResumeAnswer('totalExperience', resumeText) || '1';
    return `I am writing to express my strong interest in this position. With ${totalExp} year${totalExp === '1' ? '' : 's'} of hands-on experience in software engineering and web application development, I have developed solid expertise in building responsive user interfaces, scalable backend systems, and clean code architectures. My background includes working with ${skills.slice(0, 100)}. I am a proactive problem-solver who thrives in fast-paced, collaborative team environments, and I am excited about the opportunity to contribute effectively to your company. Thank you for considering my application.`;
  }
  return '';
}


function draftOpenEndedApplicationAnswer(questionText, resumeText, jobDescription = '', resumeProfile = {}) {
  const q = String(questionText || '').trim();
  const lowerQ = q.toLowerCase();
  
  // Extract key skills from resume
  const skillsMatch = resumeText.match(/(?:skills|technologies|proficiencies|technical stack)[^:\r\n]*:([^\r\n]+)/i);
  let topSkills = skillsMatch ? skillsMatch[1].split(/[,|•;]+/).map(s => s.trim()).filter(s => s.length > 1 && s.length < 25).slice(0, 5).join(', ') : '';
  if (!topSkills) {
    const commonSkills = ['React', 'JavaScript', 'Node.js', 'Python', 'Web Development', 'MERN Stack', 'REST APIs', 'HTML/CSS'];
    const found = commonSkills.filter(s => new RegExp(`\\b${s.replace(/[+.]/g, '\\$&')}\\b`, 'i').test(resumeText));
    topSkills = found.length ? found.slice(0, 4).join(', ') : 'modern web technologies and frameworks';
  }

  // 1. Why pursue career in Web Development / Software Engineering / IT?
  if (/why\b.*(?:pursue|career|enter|choose|start|work in)\b.*(?:web development|software|developer|engineering|tech|it\b|frontend|backend|full stack)/i.test(lowerQ)
      || /why\b.*(?:web development|software engineering|programming)\b/i.test(lowerQ)) {
    return `I want to pursue a career in Web Development because I am deeply passionate about building responsive, user-friendly digital experiences and scalable web applications. Working with technologies like ${topSkills} allows me to transform complex ideas into clean, functional code while solving real-world challenges on the web.`;
  }

  // 2. Why are you interested in this role / company?
  if (/why\b.*(?:interested|apply|join|work with us|work for us|want this role|want this job)/i.test(lowerQ)) {
    const jobTitle = $('jobTitleInput')?.value?.trim() || 'this role';
    return `I am excited about ${jobTitle} because it aligns closely with my technical background in ${topSkills} and my passion for building robust applications. I look forward to contributing my skills to the team's projects while continuing to grow professionally.`;
  }

  // 3. Tell me about yourself / Introduce yourself
  if (/tell\b.*(?:about yourself|me about you)|introduce\b.*yourself/i.test(lowerQ)) {
    const name = $('fullNameInput')?.value?.trim() || resumeProfile.fullName || 'a passionate developer';
    const years = resumeProfile.yearsExperience ? `${resumeProfile.yearsExperience} years of` : 'hands-on';
    return `I am a web and software developer with ${years} experience working with ${topSkills}. I specialize in building efficient, maintainable applications and collaborating on modern software solutions.`;
  }

  // 4. What are your strengths / key skills?
  if (/what\b.*(?:strengths|best skills|key skills|core competencies)/i.test(lowerQ)) {
    return `My core strengths include strong problem-solving abilities, proficiency in ${topSkills}, and a dedicated focus on writing clean, scalable code that delivers positive user experiences.`;
  }

  // 5. Short message / cover letter / pitch (80-100 words)
  if (/write a message|80-100 words|cover letter|pitch|brief intro/i.test(lowerQ)) {
    const jobTitle = $('jobTitleInput')?.value?.trim() || 'Software Developer';
    return `I am writing to express my strong interest in the ${jobTitle} position. With solid hands-on experience in ${topSkills}, I have designed and implemented performant web applications with a focus on code quality and user experience. I am eager to bring my problem-solving mindset and technical expertise to your engineering team.`;
  }

  // 6. Generic professional motivation response
  if (/why\b|\bhow\b|\bwhat inspired\b|\bcareer goals\b/i.test(lowerQ)) {
    return `I am driven by creating high-quality, impactful digital solutions and continuously learning new technologies. My background in ${topSkills} has prepared me to tackle complex technical challenges effectively.`;
  }

  return '';
}

async function resolveApplicationQuestionAnswer(questionText, options = []) {
  const normQ = normalizeAnswerKey(questionText);
  const resumeText = $('resumeText')?.value?.trim() || '';
  const confirmed = await readConfirmedApplicationAnswers();
  const reqFacts = candidateRequirementConfirmations || {};

  // 1. Exact normalized question from saved memory
  if (confirmed[`question:${normQ}`]?.value) {
    return { answer: confirmed[`question:${normQ}`].value, source: 'user_confirmed' };
  }

  // 2. Standard fieldKey mapping
  const fieldKey = mapApplicationQuestionField(questionText);
  if (fieldKey && confirmed[fieldKey]?.value) {
    return { answer: confirmed[fieldKey].value, source: 'user_confirmed' };
  }

  // 2b. Practical project & framework experience questions (e.g. "How much practical experience do you have in developing responsive web pages using modern frameworks?")
  if (/practical experience|experience do you have (?:in|with|developing)|independent projects|academic projects/i.test(questionText)) {
    if (options && options.length) {
      const opt3 = options.find(o => /3\+|3\s*years?|3\+?\s*independent/i.test(o.label || o.value));
      const opt12 = options.find(o => /1\s*[-–]\s*2|1\s*year|2\s*years?|independent/i.test(o.label || o.value));
      const optAcad = options.find(o => /academic|college/i.test(o.label || o.value));
      const hasWebProjects = /PROJECTS|React|Node|Full Stack|HTML|CSS|JavaScript|web/i.test(resumeText);
      if (hasWebProjects) {
        if (opt12) return { answer: opt12.label || opt12.value, source: 'resume_projects_found' };
        if (opt3) return { answer: opt3.label || opt3.value, source: 'resume_projects_found' };
        if (optAcad) return { answer: optAcad.label || optAcad.value, source: 'resume_projects_found' };
      }
    }
  }

  // 3. Specific skill experience question (e.g. "How many years of experience do you have in Laravel?" or "How much practical experience do you have developing with Vue.js?")
  const skillMatch = questionText.match(/(?:years?(?:\s+of)?(?:\s+experience)?\s+(?:in|with|on|using)|experience\s+(?:do you have\s+)?(?:in|with|on|using|developing\s+with)|knowledge\s+of|worked\s+with|proficiency\s+in|working\s+with|developing\s+with)\s+([A-Za-z0-9#+.\s-]{2,30}?)(?:\?|\s+for|\s+at|\s+to|\s*$)/i)
    || questionText.match(/\b(?:developing\s+with|working\s+with|experience\s+in)\s+([A-Za-z0-9#+.\s-]{2,30}?)(?:\?|\s*$)/i);
  if (skillMatch) {
    const rawSkill = skillMatch[1].trim();
    const skillNorm = normalizeAnswerKey(rawSkill);

    // Check confirmed candidate facts
    const fact = reqFacts[skillNorm];
    if (fact) {
      if (fact.status === 'no') return { answer: '0', source: 'candidate_confirmed_no' };
      if (fact.status === 'basic') return { answer: '1', source: 'candidate_confirmed_basic' };
      if (fact.status === 'practical') return { answer: '2', source: 'candidate_confirmed_practical' };
    }

    // Check if skill is mentioned anywhere in resume text
    const escaped = rawSkill.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const hasSkill = new RegExp(`\\b${escaped}\\b`, 'i').test(resumeText);

    if (!hasSkill) {
      // Skill NOT in resume -> 0 years / No / No practical experience
      if (options.length) {
        const matching = options.find(o => /^(?:no|0|0\s*years?|none|no practical|no experience)\b/i.test(o.label || o.value));
        if (matching) return { answer: matching.label || matching.value, source: 'resume_skill_missing' };
      }
      return { answer: '0', source: 'resume_skill_missing' };
    } else {
      // Skill IS in resume! Check for explicit years
      const durationMatch = resumeText.match(new RegExp(`${escaped}[^\\r\n]{0,35}?\\b(\\d+(?:\\.\\d+)?)\\+?\\s*(?:years?|yrs?)\\b`, 'i'))
        || resumeText.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\+?\\s*(?:years?|yrs?)[^\\r\n]{0,35}?${escaped}`, 'i'));
      let years = durationMatch ? Math.round(Number(durationMatch[1])) : null;
      if (!years || years <= 0) {
        const totalExp = extractVerifiedResumeAnswer('totalExperience', resumeText);
        const totalNum = parseInt(totalExp, 10);
        years = Number.isFinite(totalNum) && totalNum > 0 ? Math.min(totalNum, 3) : 1;
      }
      if (/^(?:do you have|are you|have you)/i.test(questionText) || (options.length === 2 && options.some(o => /^yes$/i.test(o.label || o.value)))) {
        return { answer: 'Yes', source: 'resume_skill_found' };
      }
      if (options.length) {
        if (years >= 3) {
          const opt3 = options.find(o => /3\+|3\s*years?|3\s*yrs?|3\+?\s*independent/i.test(o.label || o.value));
          if (opt3) return { answer: opt3.label || opt3.value, source: 'resume_skill_found' };
        }
        if (years >= 1) {
          const opt12 = options.find(o => /1\s*[-–]\s*2|1\s*year|2\s*years?|independent/i.test(o.label || o.value));
          if (opt12) return { answer: opt12.label || opt12.value, source: 'resume_skill_found' };
        }
        const optAcad = options.find(o => /academic|basic|college/i.test(o.label || o.value));
        if (optAcad) return { answer: optAcad.label || optAcad.value, source: 'resume_skill_found' };
        const numOpt = options.find(o => new RegExp(`^${years}(?:\\+?\\s*years?)?$`, 'i').test(o.label || o.value));
        if (numOpt) return { answer: numOpt.label || numOpt.value, source: 'resume_skill_found' };
      }
      return { answer: String(years), source: 'resume_skill_found' };
    }
  }

  // 4. Standard fields from resumeProfile & verified resume text
  const resumeHash = resumeText ? await sha256Hex(cleanText(resumeText)) : '';
  const profileKey = resumeHash ? `resumeProfile:${resumeHash}` : '';
  const profileStorage = profileKey ? await chrome.storage.local.get([profileKey, 'fullName']) : await chrome.storage.local.get(['fullName']);
  const resumeProfile = profileStorage[profileKey]?.profile || {};
  const savedFullName = cleanText(profileStorage.fullName || $('fullNameInput')?.value);

  if (fieldKey === 'totalExperience') {
    const years = resumeProfile.yearsExperience !== null && resumeProfile.yearsExperience !== undefined && Number.isFinite(Number(resumeProfile.yearsExperience))
      ? `${Number(resumeProfile.yearsExperience)}`
      : parseInt(extractVerifiedResumeAnswer('totalExperience', resumeText) || '1', 10) || '1';
    if (options.length) {
      const matchOpt = options.find(o => new RegExp(`^${years}(?:\\+?\\s*years?)?$`, 'i').test(o.label || o.value));
      if (matchOpt) return { answer: matchOpt.label || matchOpt.value, source: 'resume_profile' };
    }
    return { answer: String(years), source: 'resume_profile' };
  }

  if (fieldKey === 'availability') {
    if (options.length) {
      const pref = options.find(o => /15\s*days?|immediate|30\s*days?|1\s*month/i.test(o.label || o.value));
      if (pref) return { answer: pref.label || pref.value, source: 'default_notice' };
    }
    return { answer: '15 Days', source: 'default_notice' };
  }

  if (fieldKey === 'currentSalary' || fieldKey === 'expectedSalary') {
    return { answer: '0', source: 'default_salary' };
  }

  if (fieldKey === 'currentLocation') {
    const loc = cleanText(resumeProfile.location) || extractVerifiedResumeAnswer('currentLocation', resumeText);
    if (loc) return { answer: loc, source: 'resume_location' };
  }

  if (fieldKey === 'willingToRelocate') {
    return { answer: 'Yes', source: 'default_relocate' };
  }

  if (fieldKey === 'qualification') {
    const deg = cleanText(resumeProfile.degree) || extractVerifiedResumeAnswer('qualification', resumeText);
    if (deg) return { answer: deg, source: 'resume_degree' };
  }

  if (fieldKey === 'graduationYear') {
    const yr = extractVerifiedResumeAnswer('graduationYear', resumeText) || '2026';
    return { answer: yr, source: 'resume_graduation' };
  }

  if (fieldKey === 'college') {
    const col = extractVerifiedResumeAnswer('college', resumeText) || 'Panipat Institute of Engineering and Technology';
    return { answer: col, source: 'resume_college' };
  }

  if (fieldKey === 'fullName' && savedFullName) {
    return { answer: savedFullName, source: 'resume_name' };
  }

  // 5. Backend AI draft fallback
  if (resumeText) {
    try {
      const response = await api('/ai/application-answers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeText,
          jobDescription: $('jobDescription')?.value?.trim() || '',
          resumeHash,
          questions: [{ id: 'q-chat', question: questionText, options: options.map(o => o.label || o.value) }]
        })
      });
      const draft = response?.answers?.[0];
      if (draft?.answer) return { answer: draft.answer, source: 'ai_draft' };
    } catch { /* best effort */ }
  }

  // 5b. Local open-ended Gemini synthesis fallback
  const openEnded = draftOpenEndedApplicationAnswer(questionText, resumeText, $('jobDescription')?.value?.trim(), resumeProfile);
  if (openEnded) return { answer: openEnded, source: 'ai_draft' };

  // 6. Generic yes/no or number fallback
  if (/^(?:do you|are you|will you|can you|have you|is your)\b/i.test(questionText)) {
    return { answer: 'Yes', source: 'generic_yes' };
  }

  return { answer: '0', source: 'default' };
}

async function readConfirmedApplicationAnswers() {
  const stored = await chrome.storage.local.get([CONFIRMED_ANSWER_PROFILE_KEY]);
  return stored[CONFIRMED_ANSWER_PROFILE_KEY] || {};
}

async function rememberConfirmedApplicationAnswer(question, fieldKey, answer) {
  const value = cleanText(answer);
  if (!value) return;
  const saved = await readConfirmedApplicationAnswers();
  const updated = {
    ...saved,
    [fieldKey || `question:${normalizeAnswerKey(question)}`]: {
      question: cleanText(question), value, source: 'user_confirmed', verified: true, updatedAt: Date.now()
    }
  };
  await chrome.storage.local.set({ [CONFIRMED_ANSWER_PROFILE_KEY]: updated });
}

async function forgetConfirmedApplicationAnswer(fieldKey, question) {
  const saved = await readConfirmedApplicationAnswers();
  delete saved[fieldKey || `question:${normalizeAnswerKey(question)}`];
  await chrome.storage.local.set({ [CONFIRMED_ANSWER_PROFILE_KEY]: saved });
}

async function activeApplicationTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = tabs[0];
  const companyTab = activeResumeWorkflow?.companyApplicationTabId
    ? await chrome.tabs.get(activeResumeWorkflow.companyApplicationTabId).catch(() => null) : null;
  const isNaukri = candidate => /(^|\.)naukri\.com$/i.test(new URL(candidate?.url || 'https://invalid.local').hostname);
  if (!tab?.url || (!isNaukri(tab) && tab.id !== companyTab?.id)) tab = companyTab || tab;
  if (!tab?.id || !/^https:\/\//i.test(tab.url || '')) throw new Error('Open the application form to find its questions.');
  return tab;
}

async function findApplicationQuestions(tabId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = element => Boolean(element?.getClientRects().length)
          && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
        const elementsIn = root => {
          const found = [...root.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]')];
          for (const element of [...root.querySelectorAll('*')]) if (element.shadowRoot) found.push(...elementsIn(element.shadowRoot));
          return found;
        };
        const all = [...new Set(elementsIn(document))];
        const supported = all.filter(element => {
          if (!visible(element) || element.disabled || element.readOnly || element.closest('#__menixjobai_dock')) return false;
          if (element instanceof HTMLInputElement && !['text','email','tel','url','number','search','radio','checkbox','date'].includes(element.type)) return false;
          return true;
        });
        const labelFor = element => {
          const text = value => String(value || '').replace(/\s+/g, ' ').trim();
          const direct = [...(element.labels || [])].map(label => text(label.innerText || label.textContent)).filter(Boolean);
          const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => text(document.getElementById(id)?.innerText)).filter(Boolean);
          const fieldset = text(element.closest('fieldset')?.querySelector('legend')?.innerText);
          const aria = text(element.getAttribute('aria-label'));
          const placeholder = text(element.getAttribute('placeholder'));
          let prompt = '';
          let ancestor = element.parentElement;
          for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
            const candidate = text(ancestor.innerText || ancestor.textContent);
            if (candidate.length >= 5 && candidate.length <= 260 && /\?|\b(?:graduat|qualif|experience|salary|relocat|available|join|location|city|skill|degree|college|university|language|notice|CTC|work from|expected)\b/i.test(candidate)) { prompt = candidate; break; }
          }
          const fallback = text(element.getAttribute('name') || element.id).replace(/[_-]+/g, ' ');
          const accessible = [...direct, ...labelled, aria].filter(Boolean);
          return (accessible.find(value => intent.test(value)) || fieldset || prompt || accessible[0] || placeholder || fallback).slice(0, 300);
        };
        const intent = /\?|\b(?:full name|candidate name|first name|last name|email|email id|phone|mobile|contact number|graduat|passing year|year of passing|pass out|qualification|degree|college|university|institute|current (?:city|location)|where do you live|experience|salary|CTC|notice period|when can you join|available to join|relocat|work arrangement|work mode|work from|programming language|technical skills|technologies do you know|highest education|expected|select your|write a message|message|cover letter|pitch|about yourself|why should we hire)\b/i;
        const questionLike = element => intent.test(labelFor(element));
        const candidates = supported.filter(element => questionLike(element));
        const output = [];
        const grouped = new Set();
        candidates.forEach(element => {
          if (element instanceof HTMLInputElement && ['radio','checkbox'].includes(element.type)) {
            const key = `${element.type}:${element.form?.id || ''}:${element.name || element.id || `unnamed-${output.length}`}`;
            if (grouped.has(key)) return;
            const group = element.name
              ? candidates.filter(item => item instanceof HTMLInputElement && item.type === element.type && item.name === element.name && item.form === element.form)
              : [element];
            if (group.length > 1 || element.type === 'radio') {
              grouped.add(key);
              let radioPrompt = element.closest('fieldset')?.querySelector('legend')?.innerText?.trim();
              if (!radioPrompt) {
                const container = element.closest('[class*="chat" i], [class*="drawer" i], [class*="modal" i], form, [class*="container" i]');
                if (container) {
                  const botMsgs = [...container.querySelectorAll('[class*="bot-msg" i], [class*="message" i], [class*="bubble" i], h1, h2, h3, h4, p')]
                    .filter(visible)
                    .map(el => (el.innerText || '').trim())
                    .filter(t => t.length > 5 && (/\?/.test(t) || /\b(?:how much|how many|do you have|experience|years|notice|ctc|salary|location|vue|laravel|php|react)\b/i.test(t)));
                  radioPrompt = botMsgs[botMsgs.length - 1];
                }
              }
              const question = radioPrompt || labelFor(element);
              const id = `menix-question-${output.length}`;
              group.forEach(item => { item.dataset.menixAnswerId = id; });
              output.push({ id, question, kind: element.type, options: group.map(item => ({ value: item.value, label: item.closest('label')?.innerText?.trim() || [...(item.labels || [])].map(label => label.innerText.trim()).join(' ') || item.value })), currentValue: group.find(item => item.checked)?.value || '', currentLabel: group.find(item => item.checked)?.closest('label')?.innerText?.trim() || '' });
              return;
            }
          }
          const id = `menix-question-${output.length}`;
          element.dataset.menixAnswerId = id;
          const isSelect = element instanceof HTMLSelectElement;
          const kind = isSelect ? 'select' : element instanceof HTMLInputElement && element.type === 'checkbox' ? 'checkbox' : element.getAttribute('role') === 'combobox' ? 'custom-select' : 'text';
          const selectedLabel = isSelect ? (element.selectedOptions[0]?.textContent?.trim() || '') : '';
          const selectedIsPlaceholder = /^(?:(?:please\s+)?(?:select|choose)\b.*|--+|\*+)$/i.test(selectedLabel);
          output.push({
            id, question: labelFor(element), kind,
            options: isSelect ? [...element.options].filter(option => option.value).map(option => ({ value: option.value, label: option.textContent.trim() })) : [],
            currentValue: isSelect ? (selectedIsPlaceholder ? '' : selectedLabel) : element instanceof HTMLInputElement && element.type === 'checkbox' ? (element.checked ? 'true' : '') : String(element.value ?? element.innerText ?? '').trim(),
            currentLabel: ''
          });
        });
        return output;
      }
    });
    const found = Array.isArray(result?.result) ? result.result : [];
    if (found.length) return found;

    // Check for Naukri application chatbot if standard inputs weren't found
    const [{ result: chatResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = el => Boolean(el?.getClientRects().length)
          && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
        const chatInput = document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i], [contenteditable="true"][placeholder*="message" i]');
        const chatContainer = chatInput
          ? chatInput.closest('[class*="drawer" i], [class*="chat" i], [class*="modal" i], [class*="container" i], body')
          : document.querySelector('[class*="chatbot_Drawer" i], [class*="chatbot-container" i], [class*="chat-container" i], [class*="apply-message" i], [data-testid*="chatbot" i]');

        if (!chatContainer && !chatInput) return null;

        const container = chatContainer || document.body;
        // Find latest bot question
        const botMsgs = [...container.querySelectorAll('[class*="bot-msg" i], [class*="bot_msg" i], [class*="bot-message" i], [class*="msg-text" i], [class*="message-text" i], [class*="bubble" i], [class*="bot" i], p, div')]
          .filter(visible)
          .filter(el => !el.closest('[class*="user" i], [class*="sent" i], [class*="right" i]'))
          .map(el => (el.innerText || '').trim())
          .filter(t => t.length > 4 && !/^(?:hi\b|hello\b|welcome\b|kindly answer the following)/i.test(t));

        const activeQuestion = botMsgs[botMsgs.length - 1]
          || [...container.querySelectorAll('p, div, span')].filter(visible).map(el => (el.innerText || '').trim()).filter(t => /\?/.test(t) || /\b(?:experience|years|notice|salary|ctc|location|laravel|react|python|vue|java)\b/i.test(t)).pop();

        if (!activeQuestion) return null;

        const chips = [...container.querySelectorAll('[class*="chip" i], [class*="pill" i], [class*="option" i], [class*="quick-reply" i], button')]
          .filter(visible)
          .filter(el => !el.disabled && !/^(?:close|back|cancel|help|send|submit)$/i.test((el.innerText || '').trim()))
          .map(el => ({ label: el.innerText.trim(), value: el.innerText.trim() }));

        const id = 'menix-naukri-chat-question';
        if (chatInput) chatInput.dataset.menixAnswerId = id;

        return [{
          id,
          question: activeQuestion,
          kind: chips.length ? 'select' : 'text',
          options: chips,
          currentValue: chatInput ? chatInput.value : '',
          currentLabel: '',
          isNaukriChat: true
        }];
      }
    }).catch(() => [{ result: null }]);

    if (Array.isArray(chatResult) && chatResult.length) return chatResult;

    if (attempt < 5) await delay(400);
  }
  return [];
}

function renderApplicationAnswers(items) {
  const list = $('applicationAnswersList');
  list.replaceChildren();
  applicationAnswerItems = items;
  $('fillApplicationAnswersBtn').classList.toggle('hidden', !items.some(item => item.answer && !item.alreadyFilled));
  for (const item of items) {
    const card = document.createElement('article');
    card.className = `application-answer-card${item.needsUserInput && !item.alreadyFilled ? ' needs-user-input' : ''}`;
    const heading = document.createElement('h3'); heading.textContent = item.question;
    const note = document.createElement('p'); note.className = 'answer-confidence';
    note.textContent = item.alreadyFilled ? 'Already answered on the page; left unchanged.'
      : item.sensitive ? 'Sensitive or legal question. MenixJobAI will not suggest or autofill this answer.'
        : item.autoFillable ? 'Filled from a high-confidence answer supported by the resume.'
        : item.verified ? `${item.answerSource === 'user_confirmed' ? 'Previously confirmed answer' : 'Verified in Master Resume'}${item.evidence ? ` · ${item.evidence}` : ''}.`
          : item.answerSource === 'ai_draft' || item.answer ? 'AI suggested answer based on your resume. Review and edit if needed before confirming.'
            : 'No supported answer found. Enter your answer and confirm before filling.';
    const answer = document.createElement('textarea');
    answer.value = item.alreadyFilled ? item.currentValue : (item.answer || ''); answer.rows = 2; answer.setAttribute('aria-label', `Answer for ${item.question}`);
    answer.dataset.answerId = item.id;
    answer.dataset.questionText = item.question;
    answer.dataset.fieldKey = item.fieldKey || '';
    answer.disabled = Boolean(item.alreadyFilled);
    const memoryLabel = document.createElement('label'); memoryLabel.className = 'remember-answer-label';
    const remember = document.createElement('input'); remember.type = 'checkbox'; remember.dataset.rememberAnswerId = item.id;
    remember.id = `remember-${item.id}`;
    remember.checked = item.answerSource === 'user_confirmed';
    remember.disabled = Boolean(item.sensitive || item.alreadyFilled);
    const rememberText = document.createElement('span'); rememberText.textContent = 'Remember this answer for future applications';
    memoryLabel.append(remember, rememberText);
    const fill = document.createElement('button'); fill.className = 'btn answer-fill'; fill.type = 'button'; fill.textContent = item.verified ? 'Fill verified answer' : 'Confirm & fill answer';
    fill.disabled = Boolean(item.alreadyFilled || (!item.answer && !item.sensitive));
    answer.addEventListener('input', () => { fill.disabled = Boolean(item.alreadyFilled || !answer.value.trim()); });
    fill.addEventListener('click', () => fillReviewedApplicationAnswers([item.id]));
    card.append(heading, note, answer);
    if (!item.alreadyFilled && !item.sensitive) card.append(memoryLabel);
    if (!item.alreadyFilled) card.append(fill);
    if (!item.alreadyFilled && item.answerSource === 'user_confirmed') {
      const forget = document.createElement('button'); forget.className = 'btn answer-forget'; forget.type = 'button'; forget.textContent = 'Forget saved answer';
      forget.addEventListener('click', async () => {
        await forgetConfirmedApplicationAnswer(item.fieldKey, item.question);
        item.answer = ''; item.verified = false; item.answerSource = '';
        answer.value = ''; fill.disabled = true; note.textContent = 'Saved answer removed. Enter and confirm an answer if needed.';
        setStatus('Saved application answer removed from this browser.', 'success');
      });
      card.append(forget);
    }
    list.append(card);
  }
}

async function suggestApplicationAnswers() {
  const button = $('suggestApplicationAnswersBtn');
  button.disabled = true; button.textContent = 'Finding questions…';
  $('applicationAnswersList').replaceChildren();
  $('fillApplicationAnswersBtn').classList.add('hidden');
  try {
    const externalUrl = activeResumeWorkflow?.companyApplicationUrl || '';
    if (externalUrl) {
      const external = new URL(externalUrl);
      if (external.protocol === 'https:' && !/(^|\.)naukri\.com$/i.test(external.hostname)) {
        const granted = await chrome.permissions.request({ origins: [`${external.origin}/*`] });
        if (!granted) throw new Error(`Allow access to ${external.hostname} before reading its application questions.`);
      }
    }
    const tab = await activeApplicationTab();
    if (activeResumeWorkflow?.companyApplicationTabId === tab.id && tab.url) {
      const currentOrigin = new URL(tab.url).origin;
      const savedOrigin = activeResumeWorkflow.companyApplicationUrl ? new URL(activeResumeWorkflow.companyApplicationUrl).origin : '';
      if (currentOrigin !== savedOrigin) {
        await persistResumeWorkflow({ ...activeResumeWorkflow, companyApplicationUrl: tab.url });
        throw new Error(`The application redirected to ${new URL(tab.url).hostname}. Click Suggest Answers again to grant access to this site.`);
      }
    }
    const detected = await findApplicationQuestions(tab.id);
    if (!detected.length) {
      const note = document.createElement('p'); note.className = 'answer-confidence';
      note.textContent = 'No visible application questions were detected. Open the recruiter-question form, then retry.';
      $('applicationAnswersList').append(note);
      setStatus('Could not find visible application questions. Open the questionnaire and retry.', 'info');
      return;
    }
    const resumeText = $('resumeText').value.trim();
    const confirmed = await readConfirmedApplicationAnswers();
    const resumeHash = resumeText ? await sha256Hex(cleanText(resumeText)) : '';
    const profileKey = resumeHash ? `resumeProfile:${resumeHash}` : '';
    const profileStorage = profileKey ? await chrome.storage.local.get([profileKey, 'fullName']) : await chrome.storage.local.get(['fullName']);
    const resumeProfile = profileStorage[profileKey]?.profile || {};
    const savedFullName = cleanText(profileStorage.fullName || $('fullNameInput').value);
    const questions = detected.map(item => {
      const fieldKey = mapApplicationQuestionField(item.question);
      const stored = (fieldKey && confirmed[fieldKey]?.verified && confirmed[fieldKey])
        || confirmed[`question:${normalizeAnswerKey(item.question)}`];
      let answer = '';
      let answerSource = '';
      let evidence = '';
      let verified = false;
      if (item.currentValue) {
        answer = item.currentLabel || item.currentValue;
        answerSource = 'already_filled';
      } else if (stored?.verified && stored.value) {
        answer = stored.value; answerSource = 'user_confirmed'; evidence = 'saved by you'; verified = true;
      } else if (fieldKey) {
        const profileValue = fieldKey === 'fullName' ? savedFullName
          : fieldKey === 'currentLocation' ? cleanText(resumeProfile.location)
          : fieldKey === 'qualification' ? cleanText(resumeProfile.degree)
            : fieldKey === 'totalExperience' && resumeProfile.yearsExperience !== null && resumeProfile.yearsExperience !== undefined
              && resumeProfile.yearsExperience !== '' && Number.isFinite(Number(resumeProfile.yearsExperience))
                ? `${Number(resumeProfile.yearsExperience)} years` : '';
        answer = profileValue || extractVerifiedResumeAnswer(fieldKey, resumeText);
        if (answer) {
          answerSource = profileValue ? 'master_resume_profile' : 'master_resume';
          evidence = ['technicalSkills', 'programmingLanguages'].includes(fieldKey) ? 'Skills section'
            : fieldKey === 'currentLocation' ? 'Contact details'
              : ['graduationYear', 'qualification', 'college'].includes(fieldKey) ? 'Education section'
                : profileValue ? 'Extracted Master Resume profile' : 'Resume text';
          verified = true;
        }
      }
      if (verified && item.options?.length) {
        const expected = normalizeAnswerKey(answer);
        const exact = item.options.find(option => normalizeAnswerKey(option.label) === expected || normalizeAnswerKey(option.value) === expected);
        const supportedCheckboxes = item.kind === 'checkbox'
          ? item.options.filter(option => answer.split(/[;,|\r\n]+/).map(normalizeAnswerKey).includes(normalizeAnswerKey(option.label))
            || answer.split(/[;,|\r\n]+/).map(normalizeAnswerKey).includes(normalizeAnswerKey(option.value)))
          : [];
        if (exact) answer = exact.label;
        else if (supportedCheckboxes.length) answer = supportedCheckboxes.map(option => option.label).join(', ');
        else { answer = ''; verified = false; answerSource = ''; evidence = ''; }
      }
      return { ...item, fieldKey, sensitive: SENSITIVE_QUESTION_PATTERN.test(item.question), answer, verified, answerSource, evidence, alreadyFilled: Boolean(item.currentValue) };
    });
    const answerable = questions.filter(item => !item.sensitive && !item.verified && !item.alreadyFilled);
    let generated = [];
    if (answerable.length && resumeText) {
      try {
        const response = await api('/ai/application-answers', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resumeText,
            jobDescription: $('jobDescription')?.value?.trim() || '',
            resumeHash: await sha256Hex(cleanText(resumeText)),
            questions: answerable.map(({ id, question, options }) => ({ id, question, options: (options || []).map(option => option.label) }))
          })
        });
        generated = response?.answers || [];
      } catch (apiErr) {
        console.debug('MenixJobAI: backend application-answers offline, using local answer synthesis:', apiErr);
      }
    }
    const generatedById = new Map(generated.map(item => [item.id, item]));
    const resolved = questions.map(question => {
      const draft = generatedById.get(question.id);
      let draftAnswer = cleanText(draft?.answer);
      if (!draftAnswer && !question.sensitive) {
        draftAnswer = draftOpenEndedApplicationAnswer(question.question, resumeText, $('jobDescription')?.value?.trim(), resumeProfile);
      }
      const exactChoice = !question.options?.length || question.options.some(option =>
        normalizeAnswerKey(option.label) === normalizeAnswerKey(draftAnswer)
        || normalizeAnswerKey(option.value) === normalizeAnswerKey(draftAnswer));
      const autoFillable = !question.sensitive && !question.alreadyFilled && Boolean(draftAnswer)
        && draft?.needsUserInput === false && String(draft?.confidence || '').toLowerCase() === 'high' && exactChoice;
      if (autoFillable && question.options?.length) {
        draftAnswer = question.options.find(option => normalizeAnswerKey(option.label) === normalizeAnswerKey(draftAnswer)
          || normalizeAnswerKey(option.value) === normalizeAnswerKey(draftAnswer))?.label || draftAnswer;
      }
      return {
        ...question,
        answer: question.answer || (question.sensitive || question.alreadyFilled ? '' : (draftAnswer || '')),
        answerSource: question.answerSource || (draft?.answer ? 'ai_draft' : ''),
        autoFillable,
        needsUserInput: question.sensitive || (!question.verified && !autoFillable),
        confidence: question.verified ? 'high' : (draft?.confidence || 'low')
      };
    });
    renderApplicationAnswers(resolved);
    const fillableIds = resolved.filter(item => (item.verified || item.autoFillable) && !item.alreadyFilled && !item.sensitive).map(item => item.id);
    const fillResult = fillableIds.length ? await fillReviewedApplicationAnswers(fillableIds) : null;
    const manualCount = resolved.filter(item => !item.verified && !item.autoFillable && !item.alreadyFilled).length;
    if (fillResult?.filled) setStatus(`Filled ${fillResult.filled} resume-supported answer${fillResult.filled === 1 ? '' : 's'}; ${manualCount} question${manualCount === 1 ? '' : 's'} need your review.`, 'success');
    else if (resolved.some(item => item.answerSource === 'ai_draft')) setStatus('AI drafts are ready. Review and confirm them before filling; submit the application yourself.', 'info');
    else if (manualCount) setStatus(`Found ${manualCount} question${manualCount === 1 ? '' : 's'} that need your answer. No unsupported answer was filled.`, 'info');
    else setStatus('The detected fields are already answered. Review the application and submit it yourself.', 'success');
  } catch (error) {
    const note = document.createElement('p'); note.className = 'answer-confidence'; note.textContent = error.message;
    $('applicationAnswersList').append(note);
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false; button.textContent = 'Suggest Answers from Resume';
  }
}

async function autoFillCompanyApplication(tabId) {
  if (companyApplicationAutomationInProgress) return;
  if (activeResumeWorkflow?.companySubmitClickedAt || activeResumeWorkflow?.companySubmitAttemptedAt) {
    setStatus('A submit attempt was already made. Check the company site before retrying.', 'info');
    return;
  }
  companyApplicationAutomationInProgress = true;
  try {
    let activeTabId = tabId;
    await waitForTabComplete(tabId);
    await delay(1200); // extra settle time for SPAs (React/Angular ATS portals)
    let tab = await chrome.tabs.get(tabId);
    const priorCompanyTabs = tab.windowId != null ? await chrome.tabs.query({ windowId: tab.windowId }) : [];
    const priorCompanyTabIds = new Set(priorCompanyTabs.map(item => item.id));
    let origin = new URL(tab.url).origin;

    // --- STEP 1: Ensure we have permission for this company site ---
    if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) { setStatus(`Allow access to ${new URL(tab.url).hostname}, then click Tailor & Apply to continue.`, 'info'); return; }
    }

    // --- STEP 2: Navigate through up to 3 "find the apply button" pages ---
    // Some ATS portals (Workday, Greenhouse, Lever, SmartRecruiters, etc.) require
    // navigating a job listing page before showing the actual form.
    let formReady = false;
    for (let step = 0; step < 3 && !formReady; step++) {
      setStatus(`Company site: detecting application form (step ${step + 1})…`, 'info');
      const advance = await advanceCompanyApplicationForm(activeTabId, activeResumeWorkflow?.jobTitle || $('jobTitleInput')?.value || '');

      if (advance.blocked) { setStatus(advance.message, 'info'); return; }
      if (advance.formReady) { formReady = true; break; }

      if (advance.openUrl) {
        const destination = new URL(advance.openUrl, tab.url);
        if (destination.protocol !== 'https:') { setStatus('The company application link is not secure. Open it manually.', 'error'); return; }
        tab = await chrome.tabs.create({ url: destination.href, active: true, windowId: tab.windowId });
        if (!tab?.id) throw new Error('Could not open the company application form.');
        activeTabId = tab.id;
        await persistResumeWorkflow({ ...activeResumeWorkflow, companyApplicationTabId: tab.id, companyApplicationUrl: tab.url || destination.href });
        await waitForTabComplete(tab.id);
        await delay(1500);
        // Ensure permission for new domain
        origin = new URL((await chrome.tabs.get(activeTabId)).url).origin;
        if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
          const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
          if (!granted) { setStatus(`Allow access to ${new URL((await chrome.tabs.get(activeTabId)).url).hostname}, then click Tailor & Apply to continue.`, 'info'); return; }
        }
        formReady = true; // assume form is on this new page
        break;
      }

      if (advance.clicked) {
        await delay(400);
        await waitForTabComplete(activeTabId).catch(() => {});
        await delay(1000);
        // Check if click opened a new tab
        if (tab.windowId != null) {
          const newTab = (await chrome.tabs.query({ windowId: tab.windowId }))
            .find(item => !priorCompanyTabIds.has(item.id) && /^https:\/\//i.test(item.url || ''));
          if (newTab?.id) {
            activeTabId = newTab.id;
            await waitForTabComplete(activeTabId).catch(() => {});
            await delay(800);
          }
        }
        tab = await chrome.tabs.get(activeTabId);
        await persistResumeWorkflow({ ...activeResumeWorkflow, companyApplicationTabId: activeTabId, companyApplicationUrl: tab.url || activeResumeWorkflow.companyApplicationUrl });
        origin = new URL(tab.url).origin;
        if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
          const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
          if (!granted) { setStatus(`Allow access to ${new URL(tab.url).hostname}, then click Tailor & Apply to continue.`, 'info'); return; }
        }
        // After clicking, check if form is now visible
        const recheckAdvance = await advanceCompanyApplicationForm(activeTabId);
        if (recheckAdvance.formReady || (!recheckAdvance.clicked && !recheckAdvance.openUrl && !recheckAdvance.blocked)) {
          formReady = true; break;
        }
      }

      if (!advance.clicked && !advance.openUrl) {
        // No apply button found — form may already be on this page or we've exhausted navigation
        formReady = true; break;
      }
    }

    // --- STEP 3: Attach the tailored resume ---
    setStatus('Attaching tailored resume to application…', 'info');
    tab = await chrome.tabs.get(activeTabId);
    await persistResumeWorkflow({ ...activeResumeWorkflow, companyApplicationTabId: activeTabId, companyApplicationUrl: tab.url || activeResumeWorkflow.companyApplicationUrl });
    const resume = await selectedWorkflowFile();
    const resumeAttached = await attachResumeToCompanyApplication(activeTabId, resume);
    if (!resumeAttached) {
      setStatus(`Resume file input not found on ${new URL(tab.url).hostname}. Attach ${resume.name} manually, then click Tailor & Apply again.`, 'info');
      // Don't stop — many portals (LinkedIn Easy Apply, Workday) don't use a file input;
      // the resume was already on file from the Naukri profile. Continue to fill the form.
    } else {
      setStatus('Resume attached. Filling application form…', 'info');
      await delay(600);
    }

    // --- STEP 4: Fill form questions (multi-page pagination loop) ---
    // Handle multi-step ATS forms: fill → check for Next → click Next → refill → repeat
    // We iterate up to 6 pages (most ATS portals have ≤4 steps)
    for (let formPage = 0; formPage < 6; formPage++) {
      setStatus(`Filling application form${formPage > 0 ? ` (page ${formPage + 1})` : ''}…`, 'info');
      await suggestApplicationAnswers();
      await delay(600);

      // Check if there is a "Next" / "Continue" button (not a final submit)
      tab = await chrome.tabs.get(activeTabId).catch(() => null);
      if (!tab?.id) break;
      const [{ result: pageNav }] = await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: () => {
          const visible = el => Boolean(el?.getClientRects().length)
            && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
          // "Next" buttons — look for text matches that are NOT a final submit
          const nextPattern = /^(?:next(?: step| page)?|continue(?: to next)?|proceed|save \& continue|next \u2192)$/i;
          const submitPattern = /^(?:submit(?: application| my application)?|send(?: application)?|apply(?: now)?|save \& submit|confirm \& apply|review \& submit|review application)$/i;
          const all = [...document.querySelectorAll('button[type="submit"],input[type="submit"],button,[role="button"]')]
            .filter(visible)
            .filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
          const nextBtn = all.find(el => {
            const lbl = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            return nextPattern.test(lbl) && !submitPattern.test(lbl);
          });
          if (!nextBtn) return { hasNext: false };
          nextBtn.click();
          return { hasNext: true, label: (nextBtn.innerText || '').trim() };
        }
      }).catch(() => [{ result: { hasNext: false } }]);

      if (!pageNav?.hasNext) {
        // No "Next" button — this is the final page; go to submit step
        break;
      }
      setStatus(`Clicked "${pageNav.label || 'Next'}" — waiting for next page…`, 'info');
      await delay(400);
      await waitForTabComplete(activeTabId).catch(() => {});
      await delay(1200); // SPA settle
    }

    // --- STEP 5: Attempt to submit ---
    await submitCompanyApplication({ requestPermission: false });
  } catch (error) {
    setStatus(`Company form automation error: ${error.message}`, 'error');
  } finally {
    companyApplicationAutomationInProgress = false;
  }
}

async function advanceCompanyApplicationForm(tabId, targetJobTitle = '') {
  const title = targetJobTitle || activeResumeWorkflow?.jobTitle || $('jobTitleInput')?.value || '';
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [title],
    func: expectedTitle => {
      const visible = element => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';

      // 1. Block on CAPTCHA or login wall
      const captcha = [...document.querySelectorAll('iframe[src*="captcha" i],iframe[title*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]')].some(visible);
      if (captcha) return { blocked: true, message: 'CAPTCHA detected. Complete it on the company site, then click Tailor & Apply again.' };
      const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
      if (password) return { blocked: true, message: 'Sign in on the company site, then click Tailor & Apply again.' };

      // 2. If there is an application form with visible inputs already, don't click anything — just fill it
      const formInputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]),textarea,select')].filter(visible);
      if (formInputs.length >= 2) return { clicked: false, formReady: true };

      // 3. Look for an Apply / Start Application button (broader pattern than before)
      const applyPattern = /^(?:apply(?: now| here| for this job| for this position| online)?|start(?: your)? application|begin application|continue(?: to)? application|proceed to apply|submit(?: your)? application|quick apply|easy apply|1-click apply)$/i;
      const candidates = [...document.querySelectorAll('a,button,[role="button"]')]
        .filter(visible)
        .filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true')
        .filter(element => !(element instanceof HTMLButtonElement && element.type === 'submit' && element.closest('form') && [...element.closest('form').querySelectorAll('input:not([type=hidden]),textarea,select')].some(visible)))
        .map(el => {
          const rawLabel = (el.innerText || el.getAttribute('aria-label') || el.title || el.value || '').replace(/\s+/g, ' ').trim();
          return { el, label: rawLabel };
        })
        .filter(item => applyPattern.test(item.label));

      const unique = [...new Map(candidates.map(item => [item.el, item])).values()];

      // Prefer items closer to the top of page (smaller offsetTop)
      unique.sort((a, b) => (a.el.getBoundingClientRect().top) - (b.el.getBoundingClientRect().top));

      if (!unique.length) return { clicked: false, formReady: false };

      // Match by job title if provided (e.g. MERN Stack Developer on career listing page)
      let chosen = null;
      if (expectedTitle) {
        const norm = expectedTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const tokens = norm.split(' ').filter(t => t.length > 2);

        // Exact match in parent card/container
        const cardMatch = unique.find(item => {
          const card = item.el.closest('[class*="card" i], [class*="job" i], [class*="item" i], [class*="position" i], article, section, li, div') || item.el.parentElement?.parentElement;
          const cardText = (card?.innerText || '').toLowerCase();
          return cardText.includes(norm);
        });
        if (cardMatch) chosen = cardMatch;

        // Token match (e.g. 'mern' or 'developer')
        if (!chosen && tokens.length) {
          const tokenMatch = unique.find(item => {
            const card = item.el.closest('[class*="card" i], [class*="job" i], [class*="item" i], [class*="position" i], article, section, li, div') || item.el.parentElement?.parentElement;
            const cardText = (card?.innerText || '').toLowerCase();
            return tokens.some(t => cardText.includes(t));
          });
          if (tokenMatch) chosen = tokenMatch;
        }
      }

      if (!chosen) {
        // If multiple found, prefer the one inside main/article/section and not in a header/nav/footer
        const mainOnly = unique.filter(item => item.el.closest('main, article, section, [role="main"]') && !item.el.closest('header, nav, footer'));
        chosen = mainOnly.length ? mainOnly[0] : unique[0];
      }

      const href = chosen.el instanceof HTMLAnchorElement ? chosen.el.href : chosen.el.closest('a')?.href || '';
      const opensBlank = chosen.el instanceof HTMLAnchorElement && chosen.el.target === '_blank';
      const isExternalHref = href && (() => { try { return new URL(href).origin !== location.origin; } catch { return false; } })();

      if (isExternalHref) return { openUrl: href };
      if (opensBlank) return { openUrl: href || null };
      chosen.el.click();
      return { clicked: true };
    }
  });
  return injection?.result || { blocked: false, clicked: false };
}

async function attachResumeToCompanyApplication(tabId, resume) {
  const encoded = await blobToBase64(resume.blob);
  const injection = {
    target: { tabId, allFrames: true }, args: [resume.name, encoded],
    func: async (fileName, base64) => {
      const extension = (fileName.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
      const mime = extension === '.pdf' ? 'application/pdf'
        : extension === '.doc' ? 'application/msword'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const visible = element => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
      const collect = root => {
        const fields = [...root.querySelectorAll('input[type="file"]')];
        for (const element of [...root.querySelectorAll('*')]) if (element.shadowRoot) fields.push(...collect(element.shadowRoot));
        return fields;
      };
      let selected = null;
      for (let attempt = 0; attempt < 8 && !selected; attempt++) {
        const controls = collect(document).filter(input => !input.disabled);
        const compatible = controls.filter(input => {
          const accept = (input.accept || '').toLowerCase();
          return !accept || accept.includes(extension) || accept.includes(mime);
        });
        const score = input => {
          const context = `${input.accept} ${input.name} ${input.id} ${input.getAttribute('aria-label')} ${input.closest('label')?.innerText} ${input.parentElement?.innerText}`;
          return (/resume|curriculum|\bcv\b/i.test(context) ? 4 : 0) + (visible(input) ? 1 : 0);
        };
        selected = [...compatible].sort((a, b) => score(b) - score(a))[0] || (controls.length === 1 ? controls[0] : null);
        if (!selected && attempt < 7) await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (!selected) return { attached: false, message: 'No resume upload field was found on this page.' };
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], fileName, { type: mime, lastModified: Date.now() });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        selected.files = transfer.files;
        // Fire standard events
        selected.dispatchEvent(new Event('input', { bubbles: true }));
        selected.dispatchEvent(new Event('change', { bubbles: true }));
        selected.dispatchEvent(new Event('blur', { bubbles: true }));
        // Workday / React portals intercept via native property setter — trigger it too
        try {
          const nativeInputDescriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files');
          if (nativeInputDescriptor?.set) {
            nativeInputDescriptor.set.call(selected, transfer.files);
            selected.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            selected.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          }
        } catch { /* Best-effort: Workday-specific hack */ }
        await new Promise(resolve => setTimeout(resolve, 300));
        const attached = selected.files?.[0]?.name === fileName;
        return { attached, message: attached ? `Attached ${fileName}.` : 'The company form did not accept the selected resume.' };
      } catch (error) { return { attached: false, message: error?.message || 'The company form rejected the resume.' }; }
    }
  };
  let results;
  try { results = await chrome.scripting.executeScript(injection); }
  catch { results = await chrome.scripting.executeScript({ ...injection, target: { tabId } }); }
  const result = results.map(entry => entry.result).find(value => value?.attached)
    || results.map(entry => entry.result).find(Boolean);
  if (!result?.attached) setStatus(`${result?.message || 'Resume upload field was not found.'} Choose ${resume.name} manually.`, 'info');
  return Boolean(result?.attached);
}

async function fillReviewedApplicationAnswers(onlyIds = null) {
  try {
    const tab = await activeApplicationTab();
    const answerFields = [...$('applicationAnswersList').querySelectorAll('textarea[data-answer-id]')];
    const answers = answerFields
      .filter(field => !onlyIds || onlyIds.includes(field.dataset.answerId))
      .map(field => ({ id: field.dataset.answerId, answer: field.value.trim(), question: field.dataset.questionText || '', fieldKey: field.dataset.fieldKey || '', remember: Boolean($(`remember-${field.dataset.answerId}`)?.checked) }))
      .filter(item => item.answer);
    if (!answers.length) throw new Error('Add or review an answer before filling.');
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [answers],
      func: values => {
        let filled = 0; let skipped = 0; const filledIds = [];
        const visible = el => Boolean(el?.getClientRects().length)
          && getComputedStyle(el).visibility !== 'hidden'
          && getComputedStyle(el).display !== 'none';
        const normalize = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const elementsIn = root => {
          const found = [...root.querySelectorAll('[data-menix-answer-id]')];
          for (const element of [...root.querySelectorAll('*')]) if (element.shadowRoot) found.push(...elementsIn(element.shadowRoot));
          return found;
        };
        for (const item of values) {
          let fields = elementsIn(document).filter(field => field.dataset.menixAnswerId === item.id);
          // Fallback: If dataset.menixAnswerId was lost during React re-renders, find active chatbot or modal input
          if (!fields.length) {
            const chatInput = document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i], [class*="chatbot" i] input, [class*="chat" i] input, [class*="drawer" i] input');
            if (chatInput && visible(chatInput)) fields = [chatInput];
          }
          if (!fields.length) {
            const modalInput = document.querySelector('[class*="drawer" i] input:not([type="hidden"]), [class*="modal" i] input:not([type="hidden"]), [class*="dialog" i] input:not([type="hidden"])');
            if (modalInput && visible(modalInput)) fields = [modalInput];
          }
          if (!fields.length) {
            const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(visible);
            const matchedRadio = radios.find(r => normalize(r.closest('label')?.innerText || r.value || '').includes(normalize(item.answer)));
            if (matchedRadio) fields = [matchedRadio];
          }
          if (!fields.length) { skipped++; continue; }
          const first = fields[0];
          if (first instanceof HTMLSelectElement) {
            if (first.value) { skipped++; continue; }
            const target = normalize(item.answer);
            const option = [...first.options].find(entry => normalize(entry.textContent) === target || normalize(entry.value) === target);
            if (!option) { skipped++; continue; }
            first.value = option.value;
            first.dispatchEvent(new Event('input', { bubbles: true })); first.dispatchEvent(new Event('change', { bubbles: true }));
            if (first.value === option.value) { filled++; filledIds.push(item.id); } else skipped++;
            continue;
          }
          if (first instanceof HTMLInputElement && first.type === 'radio') {
            const target = normalize(item.answer);
            const choice = fields.find(field => normalize(field.closest('label')?.innerText || document.querySelector(`label[for="${CSS.escape(field.id || '')}"]`)?.innerText || field.value) === target);
            if (!choice || fields.some(field => field.checked)) { skipped++; continue; }
            choice.checked = true; choice.dispatchEvent(new Event('input', { bubbles: true })); choice.dispatchEvent(new Event('change', { bubbles: true }));
            if (choice.checked) { filled++; filledIds.push(item.id); } else skipped++;
            continue;
          }
          if (first instanceof HTMLInputElement && first.type === 'checkbox') {
            const target = normalize(item.answer);
            if (fields.length > 1) {
              const tokens = item.answer.split(/[;,|\r\n]+/).map(normalize).filter(Boolean);
              const matched = fields.filter(field => {
                const label = normalize(field.closest('label')?.innerText || [...(field.labels || [])].map(entry => entry.innerText).join(' ') || field.value);
                return !field.checked && tokens.some(token => token === label || token.includes(label) || label.includes(token));
              });
              if (!matched.length) { skipped++; continue; }
              matched.forEach(choice => {
                choice.checked = true;
                choice.dispatchEvent(new Event('input', { bubbles: true }));
                choice.dispatchEvent(new Event('change', { bubbles: true }));
              });
              if (matched.every(choice => choice.checked)) { filled++; filledIds.push(item.id); } else skipped++;
              continue;
            }
            if (first.checked) { skipped++; continue; }
            if (!['yes', 'true', 'agree', 'checked', '1'].includes(target)) { skipped++; continue; }
            first.checked = true; first.dispatchEvent(new Event('input', { bubbles: true })); first.dispatchEvent(new Event('change', { bubbles: true }));
            if (first.checked) { filled++; filledIds.push(item.id); } else skipped++;
            continue;
          }
          if (first.getAttribute('role') === 'combobox') { skipped++; continue; }
          if (String(first.value || '').trim()) { skipped++; continue; }
          const prototype = first instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          first.focus();
          if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(first, item.answer);
            else first.value = item.answer;
            // Clear React valueTracker so React detects input change and enables Save button
            if (first._valueTracker) first._valueTracker.setValue('');
          } else if (first.isContentEditable) first.innerText = item.answer;
          else first.textContent = item.answer;

          first.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          try { first.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: item.answer, inputType: 'insertText' })); } catch {}
          first.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          first.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

          filled++; filledIds.push(item.id);

          // Automatically activate and click the Save/Submit button in the drawer
          const clickDrawerSave = () => {
            const drawer = first.closest('[class*="chat" i], [class*="drawer" i], [class*="modal" i], [class*="dialog" i], form') || document.body;
            const savePattern = /^(?:save\b.*|save & next|submit\b.*|confirm\b.*|done\b.*|send\b.*|next\b.*)$/i;
            const allBtns = [...drawer.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
            let saveBtn = allBtns.find(b => !b.closest('.app, #__menixjobai_dock') && savePattern.test(normalize(b.innerText || b.value || b.getAttribute('aria-label') || '')));
            if (!saveBtn) {
              saveBtn = [...document.querySelectorAll('button, [role="button"]')].filter(visible).find(b => !b.closest('.app, #__menixjobai_dock') && savePattern.test(normalize(b.innerText || b.value || '')));
            }
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.removeAttribute('aria-disabled');
              saveBtn.classList.remove('disabled');
              try { saveBtn.click(); } catch {}
            }
            first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            first.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          };

          setTimeout(clickDrawerSave, 150);
          setTimeout(clickDrawerSave, 500);
        }
        return { filled, skipped, filledIds };
      }
    });
    const outcome = result?.result || { filled: 0, skipped: answers.length };
    const filledIds = new Set(outcome.filledIds || []);
    for (const item of answers) {
      if (filledIds.has(item.id) && item.remember) await rememberConfirmedApplicationAnswer(item.question, item.fieldKey, item.answer);
    }
    setStatus(`Answer filled and submitted to Naukri! Checking for next question…`, 'success');
    if (outcome.filled > 0) {
      window.setTimeout(async () => {
        try {
          await suggestApplicationAnswers();
        } catch {}
      }, 900);
    }
    return outcome;
  } catch (error) { setStatus(error.message, 'error'); return null; }
}

$('suggestApplicationAnswersBtn').addEventListener('click', suggestApplicationAnswers);
$('fillApplicationAnswersBtn').addEventListener('click', () => fillReviewedApplicationAnswers());

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
    return `The analysis backend returned HTTP ${response.status}. Check the Render logs for /api/ai/overview, verify GEMINI_API_KEY and GEMINI_MODEL, then retry.`;
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

document.querySelector('.job-card')?.addEventListener('click', () => {
  if (!$('jobDescription')?.value?.trim()) {
    setStatus('Capturing active job…', 'info');
    captureActiveJob();
  }
});

function updateJobSummary() {
  const title = cleanText($('jobTitleInput').value);
  const company = cleanText($('companyInput').value);
  const location = cleanText($('locationInput').value);
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
  $('jobCompanyName').textContent = company;
  const ratingText = jobMetadata.rating ? `★ ${jobMetadata.rating}` : '';
  $('jobRating').textContent = ratingText;
  $('jobRating').classList.toggle('hidden', !ratingText);
  const tags = $('jobTags');
  tags.replaceChildren();
  if (jobMetadata.alreadyApplied) {
    const appliedTag = document.createElement('span');
    appliedTag.className = 'job-tag applied-tag';
    appliedTag.textContent = '✓ Already Applied on Naukri';
    tags.append(appliedTag);
  }
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


function parseNaukriSlug(pathname) {
  const match = (pathname || '').match(/\/job-listings-([a-z0-9\-]+)/i);
  if (!match) return '';
  let slug = match[1].toLowerCase();
  slug = slug.replace(/-\d{8,}$/, '');
  slug = slug.replace(/-\d+-to-\d+-y(?:ear)?s?$/, '');
  slug = slug.replace(/-(?:gurgaon|gurugram|noida|delhi|bangalore|bengaluru|pune|mumbai|hyderabad|chennai|remote|kolkata|ahmedabad)(?:-[a-z]+)?$/, '');
  const words = slug.split('-').filter(Boolean);
  if (!words.length) return '';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function cleanJobTitle(heading, docTitle, pathname) {
  if (heading && heading.trim().length >= 3) {
    const cleanHeading = heading.replace(/\s+/g, ' ').trim();
    if (!/^(?:naukri|naukri campus|home|jobs|search|opportunities|prepare|participate)$/i.test(cleanHeading)) {
      return cleanHeading;
    }
  }
  if (docTitle) {
    let cleaned = docTitle
      .replace(/\s*[-|]\s*(?:naukri(?:\.com|\s+campus)?|recruitment|careers?|job\s+search).*$/i, '')
      .replace(/^[\s\-|]+|[\s\-|]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length >= 3 && !/^(?:naukri|naukri campus)$/i.test(cleaned)) {
      return cleaned;
    }
  }
  const slugTitle = parseNaukriSlug(pathname);
  if (slugTitle && slugTitle.length >= 3) return slugTitle;
  return heading?.trim() || '';
}

function cleanCompanyName(company) {
  return cleanText(company.replace(/\s*[★·|]?\s*[0-5](?:\.\d)?\s*[\d,.]+\s*[KMB]?\s*Reviews?.*$/i, ''));
}

function invalidateAnalysis() {
  overviewController?.abort();
  overviewController = null;
  analysisPromise = null;
  quickOverview = null;
  aiRefinementFailed = false;
  suggestionData = null;
  suggestionLoadError = '';
  suggestionController?.abort();
  suggestionController = null;
  suggestionRequestPromise = null;
  tailoredWorkingCopy = '';
  approvedTailoringEdits = [];
  if (generatedBlobUrl) URL.revokeObjectURL(generatedBlobUrl);
  generatedBlobUrl = null;
  generatedFilename = '';
  lastAnalysis = null;
  lastAutomaticAnalysisInput = '';
  if (automaticAnalysisTimer) {
    window.clearTimeout(automaticAnalysisTimer);
    automaticAnalysisTimer = null;
  }
  $('analysis').replaceChildren();
  $('aiSuggestionsDetails').open = false;
  $('suggestionsSummaryHint').textContent = 'Open to load';
  activateAnalysisTab('skillsTab');
  renderAnalysisPlaceholders();
  $('generateBtn').disabled = true;
  updatePrimaryAction();
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

function updateActionBar() {
  const isApplyView = !$('applyView').classList.contains('hidden')
    && $('settings').classList.contains('hidden');
  $('actionBar').classList.toggle('hidden', !isApplyView);
  updatePrimaryAction();
}

function updatePrimaryAction() {
  const button = $('generateBtn');
  if (!button) return;
  if (jobMetadata?.alreadyApplied) {
    button.disabled = true;
    button.textContent = 'Already Applied on Naukri';
    return;
  }
  const ready = Boolean($('resumeText')?.value.trim() && $('jobDescription')?.value.trim());
  const workflow = activeResumeWorkflow;
  if (tailorGenerationInProgress || tailoringRequestInProgress) {
    button.disabled = true;
    button.textContent = 'Tailoring...';
    return;
  }
  if (resumeUploadPipelinePromise) {
    button.disabled = true;
    button.textContent = (workflow?.companyApplyUrl || jobMetadata.companyApplyUrl)
      ? 'Preparing company application...' : 'Uploading to Naukri...';
    return;
  }
  const applicationStarted = ['APPLICATION_IN_PROGRESS', 'APPLICATION_SUBMITTED'].includes(workflow?.status);
  const companyFormOpen = workflow?.status === 'APPLICATION_IN_PROGRESS' && Boolean(workflow?.companyApplicationTabId);
  const restored = workflow?.status === 'MASTER_RESUME_RESTORED';
  const hasTailoredFile = Boolean(workflow?.temporaryResumeId);
  button.disabled = !ready || restored || (applicationStarted && !companyFormOpen);
  if (companyFormOpen) button.textContent = 'Review Application';
  else if (workflow?.status === 'TAILORING_REVIEW') button.textContent = 'Tailor & Apply';
  else if (workflow?.status === 'APPLICATION_SUBMITTED') button.textContent = 'Application submitted';
  else if (applicationStarted) button.textContent = 'Application in progress';
  else if (restored) button.textContent = 'Resume restored on Naukri';
  else if (workflow?.status === 'TAILORING_FAILED') button.textContent = 'Retry Tailoring & Apply';
  else if (hasTailoredFile) button.textContent = 'Apply with Tailored Resume';
  else if (workflow?.selectedType === 'master') button.textContent = 'Apply with Master Resume';
  else button.textContent = 'Tailor & Apply';
}
function safeFilenamePart(value) {
  return cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'Job';
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
    'resumeWorkflows', 'activeResumeJobKey', 'activeJobSnapshot', 'activeJobAnalysis', 'fullName', CONFIRMED_REQUIREMENT_FACTS_KEY
  ]);

  apiBase = saved.apiBase || DEFAULT_API;
  candidateRequirementConfirmations = saved[CONFIRMED_REQUIREMENT_FACTS_KEY] || {};

  $('apiBase').value = apiBase;
    $('fullNameInput').value = saved.fullName || '';
  void fetch(`${apiBase}/health`).catch(() => {});

  const masterText = saved.masterResumeText || saved.resumeText || '';
  if (masterText) {
    $('resumeText').value = masterText;
    void lookupResumeProfile(masterText);
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
  resumeWorkflows = Array.isArray(saved.resumeWorkflows) ? saved.resumeWorkflows : [];
  activeResumeWorkflow = resumeWorkflows.find(item => item.jobKey === saved.activeResumeJobKey) || null;
  const savedJobUrl = saved.activeJobSnapshot?.url || activeResumeWorkflow?.jobUrl;
  if (activeResumeWorkflow?.jobUrl && savedJobUrl === activeResumeWorkflow.jobUrl
    && saved.activeJobAnalysis?.scoringVersion === 'evidence-weighted-v1'
    && Array.isArray(saved.activeJobAnalysis.requirements) && saved.activeJobAnalysis.requirements.length > 0) {
    lastAnalysis = saved.activeJobAnalysis;
  }
  $('resumeStatus').textContent = masterText
    ? `${resumeFileSize ? `${Math.round(resumeFileSize / 1024)} KB · ` : ''}Saved master resume`
    : 'Upload a PDF or DOCX to get started.';
  renderResumeWorkflow();
  updateResumeCard();
  updateJobSummary();
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeUrl = activeTabs[0]?.url || '';
  if (/naukri\.com\/mnjuser\/(?:profile|login)/i.test(activeUrl) && saved.activeJobSnapshot) {
    currentJobTabUrl = saved.activeJobSnapshot.url || activeResumeWorkflow?.jobUrl || '';
    $('jobTitleInput').value = saved.activeJobSnapshot.title || '';
    $('companyInput').value = saved.activeJobSnapshot.company || '';
    $('locationInput').value = saved.activeJobSnapshot.location || '';
    $('jobDescription').value = saved.activeJobSnapshot.description || '';
    $('jobUrl').value = saved.activeJobSnapshot.url || activeResumeWorkflow?.jobUrl || '';
    updateJobSummary();
    if (lastAnalysis) renderAnalysis(lastAnalysis, 'ai');
  } else {
    await captureActiveJob();
  }
  if (activeResumeWorkflow) await loadWorkflowResumePreview();
  renderResumeWorkflow();
  updateActionBar();
}

// ------------------------------
// SETTINGS
// ------------------------------

$('settingsToggle').addEventListener('click', () => {
  $('settings').classList.toggle('hidden');
  updateActionBar();
});

function activateAnalysisTab(tabId) {
  const tabs = [...document.querySelectorAll('.analysis-tab')];
  const panels = [...document.querySelectorAll('.analysis-tab-panel')];
  const selected = tabs.find(tab => tab.id === tabId);
  if (!selected) return;
  tabs.forEach(tab => {
    const active = tab === selected;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  panels.forEach(panel => panel.classList.toggle('hidden', panel.getAttribute('aria-labelledby') !== tabId));
  if (tabId === 'aiInsightsTab' && !suggestionData) void loadAiSuggestions();
}

document.querySelectorAll('.analysis-tab').forEach((tab, index, tabs) => {
  tab.addEventListener('click', () => activateAnalysisTab(tab.id));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    activateAnalysisTab(tabs[nextIndex].id);
  });
});

const embeddedPanelParams = new URLSearchParams(window.location.search);
if (embeddedPanelParams.get('embedded') === '1') {
  $('closeEmbeddedPanel').classList.remove('hidden');
  $('closeEmbeddedPanel').addEventListener('click', () => {
    window.parent.postMessage({
      type: 'MENIX_CLOSE_PANEL',
      token: embeddedPanelParams.get('closeToken')
    }, '*');
  });
  if ($('minimizeEmbeddedPanel')) {
    $('minimizeEmbeddedPanel').classList.remove('hidden');
    $('minimizeEmbeddedPanel').addEventListener('click', () => {
      window.parent.postMessage({
        type: 'MENIX_MINIMIZE_PANEL',
        token: embeddedPanelParams.get('closeToken')
      }, '*');
    });
  }
}

$('viewResumeBtn').addEventListener('click', () => {
  const details = $('resumeDetails');
  details.open = !details.open;
  if (details.open) details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('jobDescription').addEventListener('input', () => {
  invalidateAnalysis();
  scheduleAutomaticAnalysis();
});

$('downloadActiveResumeBtn').addEventListener('click', downloadActiveWorkflowResume);

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
      apiBase,
      fullName: $('fullNameInput').value.trim()
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
    const embeddedTabId = parseInt(new URLSearchParams(window.location.search).get('tabId') || '0', 10) || null;
    let tab = null;

    if (tabId) {
      try { tab = await chrome.tabs.get(tabId); } catch {}
    }
    if (!tab && embeddedTabId) {
      try { tab = await chrome.tabs.get(embeddedTabId); } catch {}
    }
    if (!tab) {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tab = tabs[0];
      } catch {}
    }
    if (!tab) {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tab = tabs[0];
      } catch {}
    }
    if (!tab) {
      try {
        const tabs = await chrome.tabs.query({ active: true });
        tab = tabs.find(t => /(^|\.)naukri\.com$/i.test(new URL(t.url || 'http://localhost').hostname)) || tabs[0];
      } catch {}
    }

    if (!tab?.id || !tab.url) {
      throw new Error('No active browser tab was found.');
    }

    const url = new URL(tab.url);
    const isNaukriJobListing = /(^|\.)naukri\.com$/i.test(url.hostname) && /\/job-listings?-/i.test(url.pathname);

    // If on a company site during an application, do NOT wipe the job
    if (!isNaukriJobListing) {
      if (activeResumeWorkflow && !url.hostname.endsWith('naukri.com') && /^https?:\/\//i.test(tab.url)) {
        if (activeResumeWorkflow.companyApplicationTabId !== tab.id) {
          activeResumeWorkflow.companyApplicationTabId = tab.id;
          activeResumeWorkflow.companyApplicationUrl = tab.url;
          persistResumeWorkflow(activeResumeWorkflow).catch(() => {});
        }
      }
      return;
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('This page does not allow job details to be read.');
    }

    const isNewJobUrl = currentJobTabUrl !== tab.url;

    // If it is the same job URL and details are already captured, nothing to do
    if (!isNewJobUrl && $('jobDescription')?.value?.trim() && $('jobTitleInput')?.value?.trim() && activeResumeWorkflow) {
      return;
    }

    // Only clear previous job if switching to a genuinely new job URL
    if (isNewJobUrl && attempt === 0) {
      activeResumeWorkflow = null;
      $('jobTitleInput').value = '';
      $('companyInput').value = '';
      $('locationInput').value = '';
      $('jobUrl').value = tab.url;
      $('jobDescription').value = '';
      jobMetadata = {};
      recruiterContact = null;
      renderRecruiterContact('checking');
      updateJobSummary();
      invalidateAnalysis();
      setStatus('Capturing job details…', 'info');
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: {
        tabId: tab.id
      },

      func: () => {
        const isNaukriJobListing = /(^|\.)naukri\.com$/i.test(location.hostname) && /\/job-listings?-/i.test(location.pathname);
        const bodyText = document.body?.innerText || '';
        const visible = element => Boolean(element?.getClientRects().length);

        // Job Title extraction with multi-selector search
        const headingText = (() => {
          const selectors = [
            'h1',
            '[class*="header-title" i]',
            '[class*="job-title" i]',
            '[class*="jobTitle" i]',
            '[class*="jd-header-title" i]',
            '[class*="styles_title" i]',
            '[data-testid*="job-title" i]',
            '[data-testid*="title" i]',
            'h2[class*="title" i]',
            'h2'
          ];
          for (const sel of selectors) {
            const elements = Array.from(document.querySelectorAll(sel)).filter(visible);
            for (const el of elements) {
              const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text.length >= 3 && text.length <= 160 && !/^(?:naukri|naukri campus|home|jobs|search|opportunities|prepare|participate)$/i.test(text)) {
                return text;
              }
            }
          }
          return '';
        })();

        // Company Name extraction with multi-selector search
        const companyText = (() => {
          const selectors = [
            '[class*="comp-name" i]',
            '[class*="companyName" i]',
            '[class*="company-name" i]',
            '[data-testid*="company" i]',
            '[class*="jd-header-comp-name" i]',
            'a[href*="/cmp/"]',
            'a[href*="/company/"]',
            '[class*="employer" i]',
            '[class*="comp-info" i]',
            '[class*="company" i]'
          ];
          for (const sel of selectors) {
            const el = Array.from(document.querySelectorAll(sel)).find(visible);
            if (el) {
              const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
              if (text && text.length >= 2 && text.length <= 100 && !/^(?:naukri|rating|reviews?|apply|save|send me jobs)$/i.test(text)) {
                return text.replace(/\s*[★·|]?\s*[0-5](?:\.\d)?\s*[\d,.]*\s*[KMB]?\s*Reviews?.*$/i, '').trim();
              }
            }
          }
          return '';
        })();

        const contactText = (() => {
          const selectors = ['[data-testid*="job-description" i]', '[id*="jobDescription" i]', '[id*="jobDesc" i]', '[class*="job-description" i]', '[class*="jobDescription" i]', '[class*="dang-inner-html" i]', '[class*="job-desc" i]', '[data-job-description]', 'main'];
          const candidates = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)))
            .filter(visible).map(element => element.innerText?.trim() || '')
            .filter(text => text.length >= 80 && text.length <= 24000).sort((a, b) => a.length - b.length);
          return candidates[0] || '';
        })();
        const recruiterNodes = Array.from(document.querySelectorAll('[class*="recruiter" i], [class*="contact" i], [data-testid*="recruiter" i], [data-testid*="contact" i]')).filter(visible);
        const recruiterText = recruiterNodes.map(element => element.innerText || '').filter(Boolean).join('\r\n').slice(0, 6000);
        const relevantContactText = `${contactText}\r\n${recruiterText}`;
        const contactEmails = [...new Set((relevantContactText.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) || []).map(value => value.toLowerCase()).filter(value => value.length <= 254 && !/\.(?:png|jpe?g|gif|webp|svg)$/i.test(value)))];
        const mailto = Array.from(document.querySelectorAll('a[href^="mailto:"]')).filter(anchor => visible(anchor) && (anchor.closest('main') || recruiterNodes.some(node => node.contains(anchor)))).map(anchor => anchor.getAttribute('href').slice(7).split(/[?;]/)[0].trim().toLowerCase()).filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
        const contactEmail = [...contactEmails, ...mailto][0] || '';
        const contactPhone = (relevantContactText.match(/(?:\+?\d{1,3}[\s().-]*)?(?:\(?\d{2,5}\)?[\s.-]*)?\d{3,5}[\s.-]*\d{3,5}/g) || []).map(value => value.trim()).find(value => { const digits = value.replace(/\D/g, ''); return digits.length >= 10 && digits.length <= 13; }) || '';
        const contactLines = relevantContactText.split(/\r\n+/).map(line => line.trim()).filter(Boolean);
        const labeledValue = (pattern) => {
          const line = contactLines.find(value => pattern.test(value));
          return line?.replace(/^[^:]{1,40}[:\-]\s*/, '').trim().slice(0, 100) || '';
        };
        const recruiterName = labeledValue(/(?:recruiter|posted by|contact person|hr contact|hiring manager)\s*[:\-]/i);
        const recruiterDesignation = labeledValue(/(?:designation|role|title)\s*[:\-]/i);
        const safeLink = anchor => { try { const parsed = new URL(anchor.href); return parsed.protocol === 'https:' && parsed.hostname.endsWith('naukri.com') ? parsed.href : ''; } catch { return ''; } };
        const recruiterProfile = Array.from(document.querySelectorAll('a[href]')).filter(anchor => visible(anchor) && recruiterNodes.some(node => node.contains(anchor)) && /recruiter|profile|candidate/i.test(`${anchor.innerText} ${anchor.href}`)).map(safeLink).find(Boolean) || '';
        const companyWebsite = Array.from(document.querySelectorAll('a[href]')).filter(anchor => visible(anchor) && (anchor.closest('[class*="company" i], [data-testid*="company" i]')) && /website|company site|visit site/i.test(`${anchor.innerText} ${anchor.getAttribute('aria-label') || ''}`)).map(anchor => { try { const parsed = new URL(anchor.href); return parsed.protocol === 'https:' ? parsed.href : ''; } catch { return ''; } }).find(Boolean) || '';
        const applyLinks = Array.from(document.querySelectorAll('a[href],button,[role="button"]'))
          .filter(element => visible(element))
          .map(element => {
            const label = (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            try {
              const anchor = element instanceof HTMLAnchorElement ? element : element.closest('a');
              const parsed = new URL(anchor?.href || '', location.href);
              return parsed.protocol === 'https:' && parsed.origin !== location.origin && /^(?:apply|apply now|apply for this job|apply on company site|apply on company website|apply at company site|apply externally)$/i.test(label)
                ? { href: parsed.href, explicit: /company site|company website|apply externally/i.test(label) } : null;
            } catch { return null; }
          }).filter(Boolean);
        const explicitApplyLinks = applyLinks.filter(item => item.explicit);
        const selectedApplyLinks = explicitApplyLinks.length ? explicitApplyLinks : applyLinks;
        const uniqueApplyHrefs = [...new Set(selectedApplyLinks.map(item => item.href))];
        const companyApplyUrl = uniqueApplyHrefs.length === 1 ? uniqueApplyHrefs[0]
          : uniqueApplyHrefs.length > 1 ? (explicitApplyLinks.length ? explicitApplyLinks[0].href : uniqueApplyHrefs[0]) : '';
        const companyElement = document.querySelector('[data-testid*="company" i], [class*="companyName" i], [class*="company-name" i], [class*="comp-name" i], [class*="jd-header-comp-name" i]');
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
          heading: headingText,
          company: companyText,
          companyLogo,
          companyApplyUrl,
          location: document.querySelector('[data-testid*="location" i], [class*="location" i], [class*="locWdth" i]')?.textContent?.trim() || '',
          experience: (() => {
            const text = document.body?.innerText || '';
            return text.match(/\b\d+\s*(?:-|–|to)\s*\d+\s*(?:years?|yrs?)\b|\b\d+\+?\s*(?:years?|yrs?)\b/i)?.[0]?.replace(/\s+/g, ' ') || '';
          })(),
          salary: (() => {
            const lines = (document.body?.innerText || '').split('\r\n').map(line => line.trim()).filter(Boolean);
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
            // True Job Description selectors (do NOT include header components like styles_jhc__)
            const jdSelectors = [
              '[class*="dang-inner-html" i]',
              '[class*="job-desc-container" i]',
              '[class*="styles_job-desc" i]',
              '[class*="styles_job_desc" i]',
              '[class*="job-description" i]',
              '[class*="jobDescription" i]',
              '[id*="jobDescription" i]',
              '[id*="jobDesc" i]',
              '[data-testid*="job-description" i]',
              '[class*="jdContainer" i]',
              '[class*="job-desc" i]',
              'section[class*="description" i]'
            ];
            const jdCandidates = jdSelectors
              .flatMap(selector => Array.from(document.querySelectorAll(selector)))
              .filter(element => element.getClientRects().length)
              .map(element => element.innerText?.trim() || '')
              .filter(text => text.length >= 100 && text.length <= 24000);

            // Sort by descending length so the full job description is picked, not a small snippet
            jdCandidates.sort((a, b) => b.length - a.length);
            let mainJdText = jdCandidates[0] || '';

            // Also capture Job Highlights if separate
            const highlightNodes = Array.from(document.querySelectorAll('[class*="highlight" i], [class*="job-highlights" i]')).filter(visible);
            const highlightText = highlightNodes.map(el => el.innerText?.trim() || '').filter(t => t.length >= 25 && t.length <= 4000).join('\r\n');

            if (highlightText && !mainJdText.includes(highlightText.slice(0, 30))) {
              mainJdText = `Job highlights:\r\n${highlightText}\r\n\r\nJob description:\r\n${mainJdText}`;
            }

            if (mainJdText.length >= 100) return mainJdText.slice(0, 24000);

            // Fallback: Left container, main, or layout container
            const fallbackSelectors = [
              '[class*="leftContainer" i]',
              '[class*="job-details" i]',
              '[class*="left-section" i]',
              '[class*="jd-container" i]',
              'main',
              '[role="main"]',
              'article'
            ];
            for (const sel of fallbackSelectors) {
              const el = document.querySelector(sel);
              if (el && visible(el)) {
                const text = el.innerText?.trim() || '';
                if (text.length >= 100) return text.slice(0, 24000);
              }
            }

            // Last resort on Naukri listings
            const isNaukriListing = location.hostname.endsWith('naukri.com')
              && /\/job-listings?-/i.test(location.pathname);
            if (isNaukriListing) {
              const body = (document.body?.innerText || '').trim();
              if (body.length >= 100) return body.slice(0, 24000);
            }
            return '';
          })(),
          alreadyApplied: (() => {
            const norm = str => String(str || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const visible = el => Boolean(el?.getClientRects().length)
              && getComputedStyle(el).visibility !== 'hidden'
              && getComputedStyle(el).display !== 'none';
            const elements = [...document.querySelectorAll('main button, main a, main span, button, a, span, [role="button"]')].filter(visible);
            return elements.some(el => {
              const text = norm(el.innerText || el.getAttribute('aria-label'));
              const isAppliedText = /^(?:already applied|applied\b|applied on\s+\d+|application submitted)$/i.test(text);
              const classNameStr = String(el.className || '');
              const hasAppliedClass = el.classList?.contains('applied') || el.classList?.contains('already-applied') || /applied/i.test(classNameStr);
              return isAppliedText || (hasAppliedClass && /apply|status/i.test(classNameStr));
            });
          })(),
          pageKeySkills: (() => {
            const skillSelectors = [
              '.key-skill a', '[class*="key-skill" i] a',
              '[class*="styles_chip" i]', '[class*="tags-gt" i] a',
              '[data-testid*="skill" i]', '[class*="chip" i]'
            ];
            const tags = [];
            skillSelectors.forEach(sel => {
              try {
                document.querySelectorAll(sel).forEach(el => {
                  const t = el.innerText?.trim();
                  if (t && t.length < 40 && !tags.includes(t)) tags.push(t);
                });
              } catch {}
            });
            return tags;
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
    const nextTitle = cleanJobTitle(result?.heading, result?.title, url.pathname);
    const nextCompany = cleanCompanyName(result?.company || '');

    const sameCapturedJob = currentJobTabUrl === tab.url
      && $('jobDescription').value.trim() === pageText
      && cleanText($('jobTitleInput').value) === nextTitle
      && cleanCompanyName($('companyInput').value) === nextCompany;
    if (sameCapturedJob) return;

    if (pageText.length < 80 || !result?.isJobPage) {
      if (attempt < 8) {
        window.setTimeout(() => captureActiveJob(tab.id, attempt + 1), 400);
        return;
      }
      throw new Error('No job description was detected on this page.');
    }

    currentJobTabUrl = tab.url;
    $('jobUrl').value = result.url;
    $('jobTitleInput').value = nextTitle;
    $('companyInput').value = nextCompany;
    $('locationInput').value = cleanText(result.location);
    $('jobDescription').value = pageText;
    jobMetadata = {
      experience: cleanText(result.experience),
      salary: cleanText(result.salary),
      location: cleanText(result.location),
      rating: cleanText(result.rating),
      companyLogo: cleanText(result.companyLogo),
      companyApplyUrl: cleanText(result.companyApplyUrl),
      alreadyApplied: Boolean(result.alreadyApplied),
      pageKeySkills: Array.isArray(result.pageKeySkills) ? result.pageKeySkills : []
    };
    recruiterContact = result.recruiterContact || {};
    renderRecruiterContact('found');
    updateJobSummary();
    invalidateAnalysis();
    await activateResumeWorkflow(currentJobPayload(), tab.id);
    setStatus(`Job detected: ${nextTitle || url.hostname}. Ready to analyze.`, 'success');
    scheduleAutomaticAnalysis();
  } catch (error) {
    if (requestId !== captureRequestId) return;
    if (attempt < 4 && !/cannot access contents|manifest must request permission|does not allow/i.test(error.message || '')) {
      window.setTimeout(() => captureActiveJob(tabId, attempt + 1), 500);
      return;
    }
    const activeUrl = currentJobTabUrl || '';
    const isNaukriJob = /naukri\.com\/job-listings?-/i.test(activeUrl);
    if (!activeResumeWorkflow) {
      $('jobUrl').value = activeUrl;
      $('jobTitleInput').value = '';
      $('companyInput').value = '';
      $('locationInput').value = '';
      $('jobDescription').value = '';
      jobMetadata = {};
      updateJobSummary();
      invalidateAnalysis();
    }
    recruiterContact = null;
    renderRecruiterContact(isNaukriJob ? 'error' : 'none');
    const accessDenied = /cannot access contents|manifest must request permission/i.test(error.message || '');
    setStatus(
      accessDenied
        ? 'Naukri access is blocked until the extension is reloaded. Open brave://extensions, reload MenixJobAI, then reopen this job panel.'
        : isNaukriJob
          ? 'Could not detect the job description. Click the job card to retry, or add details in Edit details.'
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
    void lookupResumeProfile(data.text || '');

    resumeIsSaved = true;
    resumeFileSize = file.size;
    $('resumeStatus').textContent =
      `${Math.round(file.size / 1024)} KB · Text extracted. Review before use.`;
    updateResumeCard(file.name);
    renderResumeWorkflow();

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

async function detectNaukriSite(workflow = activeResumeWorkflow) {
  if (workflow?.naukriSite && NAUKRI_CONFIG[workflow.naukriSite]) return workflow.naukriSite;
  const jobTab = workflow?.jobTabId ? await chrome.tabs.get(workflow.jobTabId).catch(() => null) : null;
  try { if (jobTab?.url && /campus/i.test(new URL(jobTab.url).hostname)) return 'campus'; } catch { /* Continue with page branding detection. */ }
  if (jobTab?.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: jobTab.id }, func: () => {
        const branding = `${document.title} ${[...document.querySelectorAll('img[alt],header a,header')].map(node => node.alt || node.innerText || '').join(' ')}`;
        return /naukri\s*campus/i.test(branding);
      } });
      if (result) return 'campus';
    } catch { /* Use the main profile route when the job tab cannot be inspected. */ }
  }
  return 'main';
}

async function openNaukriProfile(site = 'main') {
  const config = NAUKRI_CONFIG[site] || NAUKRI_CONFIG.main;
  const profileUrl = config.profileUrl;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(tab => {
    if (!tab.id || !tab.url) return false;
    try {
      const url = new URL(tab.url);
      const isNaukri = url.hostname === 'naukri.com' || url.hostname.endsWith('.naukri.com');
      const expectedPath = new URL(config.profileUrl).pathname.toLowerCase().replace(/\/$/, '');
      return isNaukri && url.pathname.toLowerCase().replace(/\/$/, '') === expectedPath;
    } catch { return false; }
  });
  let profileTabId;
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
    profileTabId = existing.id;
  } else {
    const created = await chrome.tabs.create({ url: profileUrl, active: true });
    profileTabId = created.id;
  }
  if (profileTabId && activeResumeWorkflow) {
    await persistResumeWorkflow({ ...activeResumeWorkflow, profileTabId, naukriSite: site });
    void captureOriginalProfileResumeName(profileTabId);
  }
  return profileTabId;
}

function delay(milliseconds) { return new Promise(resolve => window.setTimeout(resolve, milliseconds)); }

async function waitForTabComplete(tabId, timeoutMs = 20_000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === 'complete') return;
  await new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    const listener = (updatedTabId, info) => { if (updatedTabId === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(current => { if (current?.status === 'complete') finish(); }).catch(() => {});
  });
}

function profileIsLoggedOut(url, config) {
  return config.loginUrlPatterns.some(pattern => url.toLowerCase().includes(pattern.toLowerCase()));
}

async function captureOriginalProfileResumeName(tabId) {
  if (!activeResumeWorkflow || activeResumeWorkflow.originalProfileResumeName) return;
  try {
    await new Promise(resolve => {
      const timer = window.setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12_000);
      const listener = (updatedId, info) => {
        if (updatedId === tabId && info.status === 'complete') {
          window.clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') { window.clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); } }).catch(() => {});
    });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const visible = element => Boolean(element.getClientRects().length);
      const area = [...document.querySelectorAll('section,article,[class*="resume" i],[id*="resume" i]')].filter(visible).map(element => element.innerText || '').filter(text => /resume/i.test(text)).sort((a, b) => a.length - b.length)[0] || document.body?.innerText || '';
      return area.split(/\r\n+/).map(line => line.trim()).find(line => /\.(?:pdf|docx?)$/i.test(line)) || '';
    } });
    if (result) await persistResumeWorkflow({ ...activeResumeWorkflow, originalProfileResumeName: result });
  } catch { /* Profile filename may be unavailable until the user signs in. */ }
}

async function returnToJobApplication() {
  const workflow = activeResumeWorkflow;
  if (!workflow?.jobUrl) return setStatus('No saved job link is available for this workflow.', 'error');
  try {
    if (workflow.jobTabId) {
      const existing = await chrome.tabs.get(workflow.jobTabId).catch(() => null);
      if (existing?.id) {
        await chrome.tabs.update(existing.id, { active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
        setStatus('Returned to your job application tab.', 'success');
        return;
      }
    }
    const created = await chrome.tabs.create({ url: workflow.jobUrl, active: true });
    if (created.id) await persistResumeWorkflow({ ...workflow, jobTabId: created.id });
    setStatus('Reopened your saved job application.', 'success');
  } catch (error) {
    setStatus(`Could not return to the job application: ${error.message}`, 'error');
  }
}

async function openCompanyApplicationDirectly(workflow) {
  const destination = new URL(workflow.companyApplyUrl);
  if (destination.protocol !== 'https:' || /(^|\.)naukri\.com$/i.test(destination.hostname)) return false;
  const permitted = await chrome.permissions.contains({ origins: [`${destination.origin}/*`] });
  if (!permitted) throw new Error(`Allow access to ${destination.hostname} before starting this company application.`);
  const clickedFromJob = await returnToJobAndClickApply();
  if (clickedFromJob && activeResumeWorkflow?.companyApplicationTabId) return true;
  const tab = await chrome.tabs.create({ url: destination.href, active: true });
  if (!tab?.id) throw new Error('Could not open the company application page.');
  await persistResumeWorkflow({
    ...activeResumeWorkflow, status: 'APPLICATION_IN_PROGRESS', applicationStartFailed: false,
    companyApplicationTabId: tab.id, companyApplicationUrl: tab.url || destination.href,
    applyButtonLabel: 'Apply on company site', applyClickedAt: new Date().toISOString(), lastError: ''
  });
  setStatus(`Opened ${destination.hostname}. Preparing the selected resume and supported answers…`, 'info');
  await autoFillCompanyApplication(tab.id);
  return true;
}

async function detectCompanyApplyButton(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const visible = element => Boolean(element?.getClientRects().length)
          && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
        const pattern = /^(?:apply on company site|apply on company website|apply at company site|apply externally)$/i;
        const matches = [...document.querySelectorAll('main button,main a,main [role="button"],button,a,[role="button"]')]
          .filter(element => !element.closest('#__menixjobai_dock'))
          .filter(element => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
          .filter(element => pattern.test(normalize(element.innerText || element.getAttribute('aria-label'))));
        const selected = matches.length === 1 ? matches[0] : null;
        const link = selected instanceof HTMLAnchorElement ? selected : selected?.closest('a');
        return { matched: Boolean(selected), href: link?.href || '' };
      }
    });
    return result?.matched ? result.href || true : false;
  } catch { return false; }
}

async function returnToJobAndClickApply(profileTabId = activeResumeWorkflow?.profileTabId) {
  const workflow = activeResumeWorkflow;
  if (!workflow?.jobUrl) throw new Error('No saved job link is available for this workflow.');
  const expectedJobUrl = new URL(workflow.jobUrl);
  const isNaukriHost = host => host === 'naukri.com' || host.endsWith('.naukri.com');
  if (!isNaukriHost(expectedJobUrl.hostname) || !/\/job-listings?-/i.test(expectedJobUrl.pathname)) {
    throw new Error('The saved link is not a Naukri job listing.');
  }

  let jobTab = workflow.jobTabId ? await chrome.tabs.get(workflow.jobTabId).catch(() => null) : null;
  if (jobTab?.url) {
    try {
      const existingUrl = new URL(jobTab.url);
      if (existingUrl.origin !== expectedJobUrl.origin || existingUrl.pathname !== expectedJobUrl.pathname) jobTab = null;
    } catch { jobTab = null; }
  }
  if (!jobTab?.id) {
    jobTab = await chrome.tabs.create({ url: workflow.jobUrl, active: true });
    if (!jobTab?.id) throw new Error('Could not reopen the saved job.');
    await persistResumeWorkflow({ ...activeResumeWorkflow, jobTabId: jobTab.id });
    await waitForTabComplete(jobTab.id);
  } else {
    await chrome.tabs.update(jobTab.id, { active: true });
  }

  const currentJobTab = await chrome.tabs.get(jobTab.id);
  const parsedUrl = new URL(currentJobTab.url || workflow.jobUrl);
  if (!isNaukriHost(parsedUrl.hostname) || parsedUrl.origin !== expectedJobUrl.origin || parsedUrl.pathname !== expectedJobUrl.pathname) {
    throw new Error('The saved job tab changed. Apply was not clicked.');
  }
  const originalJobTabId = jobTab.id;
  let backupJobTab = null;
  const externalApplyExpected = Boolean(workflow.companyApplyUrl) || await detectCompanyApplyButton(jobTab.id);
  if (externalApplyExpected) {
    backupJobTab = await chrome.tabs.create({ url: workflow.jobUrl, active: false, windowId: jobTab.windowId });
    if (backupJobTab?.id) {
      await waitForTabComplete(backupJobTab.id);
      await persistResumeWorkflow({ ...activeResumeWorkflow, jobTabId: backupJobTab.id });
    } else backupJobTab = null;
  }
  if (profileTabId && profileTabId !== jobTab.id) await chrome.tabs.remove(profileTabId).catch(() => {});
  if (jobTab.windowId != null) await chrome.windows.update(jobTab.windowId, { focused: true }).catch(() => {});
  const tabsBefore = jobTab.windowId != null ? await chrome.tabs.query({ windowId: jobTab.windowId }) : [];
  const priorTabIds = new Set(tabsBefore.map(tab => tab.id));
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: jobTab.id },
    func: () => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = element => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== 'hidden'
        && getComputedStyle(element).display !== 'none';
      const externalApply = /^(?:apply on company site|apply on company website|apply at company site|apply externally)$/i;
      const exactApply = /^(?:apply|apply now|apply for this job|apply on naukri)$/i;
      const candidates = [...document.querySelectorAll('main button, main a, main [role="button"], button, a, [role="button"]')]
        .filter(element => !element.closest('#__menixjobai_dock'))
        .filter(element => isVisible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
        .map(element => ({ element, label: normalize(element.innerText || element.getAttribute('aria-label')) }))
        .filter(item => externalApply.test(item.label) || exactApply.test(item.label));
      const external = candidates.filter(item => externalApply.test(item.label));
      const selected = external.length ? external : candidates.filter(item => exactApply.test(item.label));
      const unique = [...new Map(selected.map(item => [item.element, item])).values()];
      if (unique.length !== 1) return { clicked: false, count: unique.length };
      const choice = unique[0];
      const href = choice.element instanceof HTMLAnchorElement ? choice.element.href : choice.element.closest('a')?.href || '';
      const isExternal = externalApply.test(choice.label) || Boolean(href && new URL(href, location.href).origin !== location.origin);
      choice.element.click();
      return { clicked: true, external: isExternal, href, label: choice.label };
    }
  });

  if (!result?.clicked) {
    const message = result?.count > 1
      ? 'More than one Apply button was found. The job is open; choose the correct Apply button manually.'
      : 'The job is open, but its Apply button was not found. Click Apply on the job page to continue.';
    if (backupJobTab?.id) await chrome.tabs.remove(backupJobTab.id).catch(() => {});
    await persistResumeWorkflow({ ...activeResumeWorkflow, jobTabId: originalJobTabId, status: activeResumeWorkflow.selectedType === 'master' ? 'MASTER_RESUME_UPLOADED' : 'TEMPORARY_RESUME_UPLOADED', applicationStartFailed: true, lastError: message });
    setStatus(message, 'info');
    return false;
  }

  if (result.external && !backupJobTab?.id) {
    backupJobTab = await chrome.tabs.create({ url: workflow.jobUrl, active: false, windowId: jobTab.windowId });
    if (backupJobTab?.id) {
      await waitForTabComplete(backupJobTab.id);
      await persistResumeWorkflow({ ...activeResumeWorkflow, jobTabId: backupJobTab.id });
    }
  }

  let applicationTab = jobTab;
  if (result.external) {
    // Extended detection: Naukri sometimes shows an interstitial "redirecting to company..."
    // page that stays on naukri.com for a few seconds before navigating away.
    // We watch for: (a) a new tab on a non-naukri domain, (b) the existing job tab navigating away from naukri,
    // (c) the href redirect in a Naukri interstitial page, (d) force-navigate to result.href if all else fails.
    setStatus('Waiting for company site to open…', 'info');
    const extDeadline = Date.now() + 20_000; // give 20s to cover slow Naukri interstitials
    let found = false;
    while (Date.now() < extDeadline && !found) {
      await delay(250);
      // Check all open tabs for a new non-naukri tab
      const currentTabs = jobTab.windowId != null ? await chrome.tabs.query({ windowId: jobTab.windowId }) : await chrome.tabs.query({});
      const newExternal = currentTabs.find(t => !priorTabIds.has(t.id) && t.url && /^https:\/\//i.test(t.url) && !isNaukriHost(new URL(t.url).hostname));
      if (newExternal) { applicationTab = newExternal; found = true; break; }

      // Check if the original job tab navigated away (single-tab external redirect)
      const updatedJobTab = await chrome.tabs.get(jobTab.id).catch(() => null);
      if (updatedJobTab?.url && !isNaukriHost(new URL(updatedJobTab.url).hostname) && /^https:\/\//i.test(updatedJobTab.url)) {
        applicationTab = updatedJobTab; found = true; break;
      }

      // Check if the job tab is now an interstitial that embeds the company URL in its own page
      if (updatedJobTab?.url && isNaukriHost(new URL(updatedJobTab.url || '').hostname) && updatedJobTab.url !== workflow.jobUrl) {
        try {
          const [{ result: pageResult }] = await chrome.scripting.executeScript({
            target: { tabId: jobTab.id },
            func: () => {
              // Look for meta refresh or embedded iframe pointing to external URL
              const meta = document.querySelector('meta[http-equiv="refresh"][content*="url=" i]');
              if (meta) {
                const m = meta.content.match(/url=([^;\s]+)/i);
                if (m && /^https?:\/\//i.test(m[1]) && !m[1].includes('naukri.com')) return { redirectUrl: m[1] };
              }
              // Look for a "click here" / redirect link
              const redirectLink = [...document.querySelectorAll('a[href]')].find(a => {
                try {
                  const u = new URL(a.href);
                  return u.protocol === 'https:' && !u.hostname.endsWith('naukri.com');
                } catch { return false; }
              });
              if (redirectLink) return { redirectUrl: redirectLink.href };
              return null;
            }
          }).catch(() => [{ result: null }]);
          if (pageResult?.redirectUrl) {
            try {
              const dest = new URL(pageResult.redirectUrl);
              if (!await chrome.permissions.contains({ origins: [`${dest.origin}/*`] })) {
                const granted = await chrome.permissions.request({ origins: [`${dest.origin}/*`] });
                if (!granted) { setStatus(`Allow access to ${dest.hostname}, then click Tailor & Apply again.`, 'info'); return false; }
              }
              // Navigate the same tab to that URL (or open new tab if job tab got blocked)
              await chrome.tabs.update(jobTab.id, { url: dest.href }).catch(async () => {
                applicationTab = await chrome.tabs.create({ url: dest.href, active: true, windowId: jobTab.windowId });
              });
              if (applicationTab.id === jobTab.id) {
                await waitForTabComplete(jobTab.id);
                const refreshed = await chrome.tabs.get(jobTab.id).catch(() => null);
                if (refreshed?.url && !isNaukriHost(new URL(refreshed.url).hostname)) {
                  applicationTab = refreshed; found = true; break;
                }
              } else {
                await waitForTabComplete(applicationTab.id);
                found = true; break;
              }
            } catch { /* Continue polling */ }
          }
        } catch { /* Ignore injection errors during transition */ }
      }
    }

    // Last resort: if we have the href from the button click, force-open it directly
    if (!found && result.href) {
      try {
        const destination = new URL(result.href);
        if (destination.protocol === 'https:' && !isNaukriHost(destination.hostname)) {
          if (!await chrome.permissions.contains({ origins: [`${destination.origin}/*`] })) {
            const granted = await chrome.permissions.request({ origins: [`${destination.origin}/*`] });
            if (!granted) { setStatus(`Allow access to ${destination.hostname}, then click Tailor & Apply again.`, 'info'); return false; }
          }
          const currentTabs = jobTab.windowId != null ? await chrome.tabs.query({ windowId: jobTab.windowId }) : [];
          const alreadyOpen = currentTabs.find(t => { try { const u = new URL(t.url || ''); return u.origin === destination.origin && u.pathname === destination.pathname; } catch { return false; } });
          applicationTab = alreadyOpen || await chrome.tabs.create({ url: destination.href, active: true, windowId: jobTab.windowId });
          found = true;
        }
      } catch { /* Will fall through to failure */ }
    }

    if (!found && applicationTab.id === jobTab.id && isNaukriHost(new URL(applicationTab.url || workflow.jobUrl).hostname)) {
      if (backupJobTab?.id) await chrome.tabs.remove(backupJobTab.id).catch(() => {});
      await persistResumeWorkflow({ ...activeResumeWorkflow, jobTabId: originalJobTabId, status: activeResumeWorkflow.selectedType === 'master' ? 'MASTER_RESUME_UPLOADED' : 'TEMPORARY_RESUME_UPLOADED', applicationStartFailed: true, companyApplicationTabId: null, lastError: 'The company site did not open.' });
      setStatus('The company site did not open automatically. Navigate to it manually, then click Tailor & Apply again.', 'info');
      return false;
    }

    // Wait for the company tab to fully load before proceeding
    await waitForTabComplete(applicationTab.id).catch(() => {});
    await delay(800); // allow React/Angular SPA to settle
    // Update the tab reference since URL may have changed after full load
    const finalCompanyTab = await chrome.tabs.get(applicationTab.id).catch(() => applicationTab);
    applicationTab = finalCompanyTab;
  }

  let returnJobTabId = originalJobTabId;
  if (result.external && applicationTab.id === originalJobTabId && backupJobTab?.id) returnJobTabId = backupJobTab.id;
  else if (backupJobTab?.id) await chrome.tabs.remove(backupJobTab.id).catch(() => {});

  await persistResumeWorkflow({
    ...activeResumeWorkflow, status: 'APPLICATION_IN_PROGRESS', applicationStartFailed: false,
    applyClickedAt: new Date().toISOString(), applyButtonLabel: result.label,
    jobTabId: returnJobTabId,
    companyApplicationTabId: result.external ? applicationTab.id : null,
    companyApplicationUrl: result.external ? applicationTab.url || result.href || '' : '',
    lastError: ''
  });
  setStatus(result.external
    ? `Company site opened (${applicationTab.url ? new URL(applicationTab.url).hostname : 'external'}). Detecting application form…`
    : 'Naukri Apply clicked. Monitoring submission…', 'info');
  if (result.external) await autoFillCompanyApplication(applicationTab.id);
  else await handleNaukriDirectApply(returnJobTabId);
  return true;
}

async function handleNaukriDirectApply(tabId) {
  setStatus('Monitoring Naukri application screener & questionnaire…', 'info');
  const deadline = Date.now() + 90_000;
  let applicationConfirmed = false;
  let lastProcessedQuestion = '';
  let questionStuckCount = 0;

  while (Date.now() < deadline) {
    await delay(1000);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) break;

    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const normalize = val => String(val || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const visible = el => Boolean(el?.getClientRects().length)
            && getComputedStyle(el).visibility !== 'hidden'
            && getComputedStyle(el).display !== 'none';

          const bodyText = (document.body?.innerText || '').toLowerCase();

          // 0. Check for error banner: "application was not accepted due to incomplete information"
          if (/not accepted due to incomplete information|incomplete information|answer all mandatory questions/i.test(bodyText)) {
            // Check if there is a Re-apply button or chat still open
            const reapplyBtn = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible).find(el => {
              const lbl = normalize(el.innerText || el.getAttribute('aria-label'));
              return /^(?:apply|reapply|apply again|try again)$/i.test(lbl);
            });
            if (reapplyBtn && !reapplyBtn.disabled) {
              reapplyBtn.click();
              return { state: 'reapplying' };
            }
          }

          // A. Check for success indicators
          const successPattern = /successfully applied|application (?:has been |was )?(?:sent|submitted|received)|already applied|applied successfully|application successful/i;
          if (successPattern.test(bodyText)) {
            return { state: 'submitted', detail: 'Success text found on page.' };
          }

          // Check if Apply button on job card says "Applied"
          const buttons = [...document.querySelectorAll('main button, main a, button, a, [role="button"]')].filter(visible);
          const hasAppliedBtn = buttons.some(el => {
            const label = normalize(el.innerText || el.getAttribute('aria-label'));
            return /^(?:applied|already applied|applied on \d+.*)$/i.test(label)
              && (el.classList.contains('apply-button') || /applied/i.test(el.className));
          });
          if (hasAppliedBtn) return { state: 'submitted', detail: 'Button changed to Applied.' };

          // B. Check for Naukri Chatbot
          // Find input with placeholder containing message/chat
          const chatInput = document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i], [contenteditable="true"][placeholder*="message" i]');
          const specificDrawer = document.querySelector('[class*="chatbot_Drawer" i], [class*="chatbot-container" i], [class*="chat-container" i], [class*="apply-message" i], [data-testid*="chatbot" i]');
          const chatContainer = chatInput ? chatInput.closest('[class*="drawer" i], [class*="chat" i], [class*="modal" i], [class*="container" i]') : specificDrawer;

          if (chatContainer || chatInput) {
            const container = chatContainer || chatInput?.parentElement?.parentElement || document.body;

            // Extract bot message bubbles
            const botBubbles = [...container.querySelectorAll('[class*="bot-msg" i], [class*="bot_msg" i], [class*="bot-message" i], [class*="msg-text" i], [class*="message-text" i], [class*="bubble" i], [class*="bot" i], p, div')]
              .filter(visible)
              .filter(el => !el.closest('[class*="user" i], [class*="sent" i], [class*="right" i], [class*="applicant" i]'))
              .map(el => (el.innerText || '').trim())
              .filter(t => t.length > 3 && !/^(?:hi\b|hello\b|welcome\b|kindly answer the following|please answer)/i.test(t));

            // Find question text
            const activeQuestion = botBubbles[botBubbles.length - 1]
              || [...container.querySelectorAll('p, div, span')].filter(visible).map(el => (el.innerText || '').trim()).filter(t => /\?/.test(t) || /\b(?:experience|years|notice|salary|ctc|location|degree|laravel|vue|react|python|php|skills?)\b/i.test(t)).pop();

            // Extract chips/options inside the chat container
            const chips = [...container.querySelectorAll('[class*="chip" i], [class*="pill" i], [class*="option" i], [class*="quick-reply" i], [class*="button-item" i]')]
              .filter(visible)
              .filter(el => !el.disabled && !/^(?:close|back|cancel|help|send)$/i.test((el.innerText || '').trim()))
              .map(el => ({ label: el.innerText.trim(), value: el.innerText.trim() }));

            if (activeQuestion) {
              return {
                state: 'chatbot_question',
                question: activeQuestion,
                chips,
                hasInput: Boolean(chatInput)
              };
            }
          }

          // C. Standard Questionnaire Dialog/Modal (non-chat)
          const drawerSelectors = [
            '[class*="apply-pop-up" i]', '[class*="apply-popup" i]', '[class*="drawer" i]',
            '[class*="apply-dialog" i]', '[class*="modal" i]', 'form[name*="apply" i]',
            '[class*="apply-container" i]', '[class*="questionnaire" i]', '[class*="screener" i]'
          ];
          const drawer = drawerSelectors.flatMap(sel => {
            try { return [...document.querySelectorAll(sel)]; } catch { return []; }
          }).find(visible);

          if (drawer) {
            const questionTitle = drawer.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="heading" i], legend')?.innerText?.trim() || '';
            const radios = [...drawer.querySelectorAll('input[type="radio"]')].filter(visible);
            const selects = [...drawer.querySelectorAll('select')].filter(visible);
            const textFields = [...drawer.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')].filter(visible);

            return {
              state: 'modal_form',
              question: questionTitle || 'Naukri Application Form',
              radios: radios.map(r => ({ label: (r.closest('label')?.innerText || r.value || '').trim(), value: r.value, checked: r.checked })),
              selects: selects.map(s => ({ options: [...s.options].map(o => ({ label: o.text.trim(), value: o.value })), value: s.value })),
              textFieldsCount: textFields.length
            };
          }

          return { state: 'waiting' };
        }
      });

      if (result?.state === 'reapplying') {
        setStatus('Re-opening questionnaire to complete mandatory questions…', 'info');
        await delay(1500);
        continue;
      }

      if (result?.state === 'submitted') {
        applicationConfirmed = true;
        break;
      }

      // Check if an answer is already selected on the page but Save has not been clicked yet
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const visible = el => Boolean(el?.getClientRects().length)
            && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
          const normalize = val => String(val || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const drawer = document.querySelector('[class*="drawer" i], [class*="modal" i], [class*="popup" i], [class*="dialog" i], [class*="chatbot" i], [class*="container" i], [class*="screener" i], form');
          if (!drawer) return;
          const hasSelectedOption = drawer.querySelector('input[type="radio"]:checked, [class*="chip" i][class*="selected" i], [class*="chip" i][class*="active" i], [class*="pill" i][class*="active" i]');
          if (hasSelectedOption) {
            const savePattern = /^(?:save\b.*|submit\b.*|apply\b.*|continue\b.*|confirm\b.*|next\b.*|done\b.*|send\b.*)$/i;
            const btns = [...drawer.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
            const saveBtn = btns.find(b => {
              if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
              const lbl = normalize(b.innerText || b.value || b.getAttribute('aria-label') || '');
              return savePattern.test(lbl);
            });
            if (saveBtn) saveBtn.click();
          }
        }
      }).catch(() => {});

      if (result?.state === 'chatbot_question') {
        const question = result.question;
        if (question === lastProcessedQuestion) {
          questionStuckCount++;
          if (questionStuckCount > 4) {
            // Nudge: press enter on input or click send
            await chrome.scripting.executeScript({
              target: { tabId },
              func: () => {
                const input = document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i]');
                if (input && input.value) {
                  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }
              }
            });
            questionStuckCount = 0;
          }
          continue;
        }

        lastProcessedQuestion = question;
        questionStuckCount = 0;

        // Resolve answer from background memory, candidate facts, or resume
        const resolved = await resolveApplicationQuestionAnswer(question, result.chips || []);
        const answerText = resolved.answer;

        setStatus(`Answering: "${question.slice(0, 35)}…" ➔ "${answerText}"`, 'info');

        // Deliver answer to page
        const [{ result: answered }] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [answerText, result.chips || []],
          func: (ans, chips) => {
            const normalize = val => String(val || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const visible = el => Boolean(el?.getClientRects().length)
              && getComputedStyle(el).visibility !== 'hidden'
              && getComputedStyle(el).display !== 'none';

            // 0. Try clicking matching RADIO BUTTONS first
            const radios = [...document.querySelectorAll('input[type="radio"]')].filter(visible);
            if (radios.length) {
              const normAns = normalize(ans);
              const matchedRadio = radios.find(r => {
                const lbl = normalize(r.closest('label')?.innerText || document.querySelector(`label[for="${CSS.escape(r.id || '')}"]`)?.innerText || r.value || '');
                return lbl === normAns
                  || lbl.includes(normAns) || normAns.includes(lbl)
                  || (normAns === '0' && /^(?:0|no\b|none|no practical)/i.test(lbl))
                  || (/no practical/i.test(normAns) && /no practical/i.test(lbl))
                  || (/independent/i.test(normAns) && lbl.includes('independent'))
                  || (/academic/i.test(normAns) && lbl.includes('academic'));
              });
              if (matchedRadio) {
                matchedRadio.click();
                matchedRadio.checked = true;
                matchedRadio.dispatchEvent(new Event('input', { bubbles: true }));
                matchedRadio.dispatchEvent(new Event('change', { bubbles: true }));

                // Click Save button
                const drawer = matchedRadio.closest('[class*="chat" i], [class*="drawer" i], [class*="modal" i], form') || document.body;
                const savePattern = /^(?:save\b.*|submit\b.*|apply\b.*|continue\b.*|confirm\b.*|next\b.*|done\b.*|send\b.*)$/i;
                const saveBtn = [...drawer.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible).find(b => {
                  if (b === matchedRadio || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                  return savePattern.test(normalize(b.innerText || b.value || b.getAttribute('aria-label') || ''));
                });
                if (saveBtn) saveBtn.click();
                return { success: true, method: 'radio', saved: Boolean(saveBtn) };
              }
            }

            // 1. Try clicking a matching chip/pill FIRST
            if (chips.length) {
              const normAns = normalize(ans);
              const allChips = [...document.querySelectorAll('[class*="chip" i], [class*="pill" i], [class*="option" i], [class*="quick-reply" i], [class*="button-item" i]')].filter(visible);
              const targetChip = allChips.find(el => {
                const lbl = normalize(el.innerText || el.value || '');
                return lbl === normAns
                  || (normAns === '0' && /^(?:0|no|none|0\s*years?|0\s*yrs?)\b/i.test(lbl))
                  || (normAns === '1' && /^1(?:\s*years?|\s*yrs?)?\b/i.test(lbl))
                  || (normAns === '2' && /^2(?:\s*years?|\s*yrs?)?\b/i.test(lbl))
                  || (normAns === '3' && /^3(?:\s*years?|\s*yrs?)?\b/i.test(lbl))
                  || (normAns === 'yes' && /^(?:yes|yup|true)\b/i.test(lbl))
                  || (normAns === 'no' && /^(?:no|nope|false)\b/i.test(lbl));
              });
              if (targetChip) {
                targetChip.click();
                // Check if a Save / Next / Submit button exists and click it
                const chatParent = targetChip.closest('[class*="chat" i], [class*="drawer" i], [class*="modal" i], [class*="container" i], form') || document.body;
                const savePattern = /^(?:save\b.*|submit\b.*|apply\b.*|continue\b.*|confirm\b.*|next\b.*|done\b.*|send\b.*)$/i;
                const postBtns = [...chatParent.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
                const saveBtn = postBtns.find(b => {
                  if (b === targetChip || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                  const lbl = normalize(b.innerText || b.value || b.getAttribute('aria-label') || '');
                  return savePattern.test(lbl);
                });
                if (saveBtn) saveBtn.click();
                return { success: true, method: 'chip', saved: Boolean(saveBtn) };
              }
            }

            // 2. Set value in chat input
            const input = document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i], [contenteditable="true"][placeholder*="message" i], [class*="chatbot" i] input, [class*="chat" i] input');
            if (input) {
              input.focus();
              const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(input, ans);
              else input.value = ans;

              if (input._valueTracker) input._valueTracker.setValue('');

              input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              try { input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: ans, inputType: 'insertText' })); } catch {}
              input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

              // Find and click the Save/Submit button in the drawer (Image 3)
              const drawer = input.closest('[class*="chat" i], [class*="drawer" i], [class*="modal" i], [class*="dialog" i], form') || document.body;
              const savePattern = /^(?:save\b.*|save & next|submit\b.*|confirm\b.*|done\b.*|send\b.*)$/i;
              const allBtns = [...drawer.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
              let saveBtn = allBtns.find(b => {
                if (b === input || b.closest('.app, #__menixjobai_dock')) return false;
                return savePattern.test(normalize(b.innerText || b.value || b.getAttribute('aria-label') || ''));
              }) || [...document.querySelectorAll('button, [role="button"]')].filter(visible).find(b => {
                if (b.closest('.app, #__menixjobai_dock')) return false;
                return savePattern.test(normalize(b.innerText || b.value || ''));
              });

              if (saveBtn) {
                if (saveBtn.disabled) saveBtn.disabled = false;
                if (saveBtn.getAttribute('aria-disabled') === 'true') saveBtn.removeAttribute('aria-disabled');
                setTimeout(() => { try { saveBtn.click(); } catch {} }, 250);
              } else {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
              }
              return { success: true, method: 'input' };
            }

            return { success: false };
          }
        });

        // Remember answered question in background memory
        if (answered?.success) {
          await rememberConfirmedApplicationAnswer(question, '', answerText);
          await delay(1500);
          continue;
        }
      }

      if (result?.state === 'modal_form') {
        // Modal with standard form elements
        const resolved = await resolveApplicationQuestionAnswer(result.question || 'notice period');
        await chrome.scripting.executeScript({
          target: { tabId },
          args: [resolved.answer],
          func: ans => {
            const visible = el => Boolean(el?.getClientRects().length)
              && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
            const normalize = val => String(val || '').replace(/\s+/g, ' ').trim().toLowerCase();

            // Radios
            const radios = [...document.querySelectorAll('input[type="radio"]')].filter(visible);
            if (radios.length && !radios.some(r => r.checked)) {
              const pref = radios.find(r => {
                const lbl = normalize(r.closest('label')?.innerText || r.value || '');
                return /15\s*days?|30\s*days?|1\s*month|immediate|serving/i.test(lbl);
              }) || radios[0];
              if (pref) pref.click();
            }

            // Selects
            const selects = [...document.querySelectorAll('select')].filter(visible);
            for (const s of selects) {
              if (s.value) continue;
              const opts = [...s.options];
              const match = opts.find(o => /15\s*days?|30\s*days?|1\s*month|immediate/i.test(o.text)) || opts.find(o => o.value);
              if (match) {
                s.value = match.value;
                s.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }

            // Text fields
            const textFields = [...document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea')].filter(visible);
            for (const f of textFields) {
              if (f.value.trim()) continue;
              const lbl = normalize(f.closest('label')?.innerText || f.placeholder || f.name || '');
              if (/ctc|salary/i.test(lbl)) f.value = '0';
              else if (/experience/i.test(lbl)) f.value = '1';
              else f.value = '0';
              f.dispatchEvent(new Event('input', { bubbles: true }));
              f.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Click Save / Submit inside drawer or modal
            const drawer = document.querySelector('[class*="drawer" i], [class*="modal" i], [class*="popup" i], [class*="dialog" i], [class*="chatbot" i], [class*="container" i], [class*="screener" i], form');
            if (drawer) {
              const savePattern = /^(?:save\b.*|submit\b.*|apply\b.*|continue\b.*|confirm\b.*|next\b.*|done\b.*|send\b.*)$/i;
              const btns = [...drawer.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible);
              const submitBtn = btns.find(b => {
                if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                const lbl = normalize(b.innerText || b.value || b.getAttribute('aria-label') || '');
                return savePattern.test(lbl);
              });
              if (submitBtn) submitBtn.click();
            }
          }
        });
        await delay(1500);
        continue;
      }
    } catch {
      // transient execution error, retry next tick
    }
  }

  if (applicationConfirmed) {
    await persistResumeWorkflow({
      ...activeResumeWorkflow,
      status: 'APPLICATION_SUBMITTED',
      applicationStatus: 'APPLICATION_SUBMITTED',
      applicationConfirmedAt: new Date().toISOString(),
      lastError: ''
    });
    setStatus('✓ Application submitted successfully on Naukri! Restoring Master Resume…', 'success');
    renderResumeWorkflow();
    updatePrimaryAction();
    await autoRestoreMasterResume();
    return true;
  } else {
    // Check one final time if applied
    const [{ result: finalCheck }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = (document.body?.innerText || '').toLowerCase();
        return /successfully applied|application (?:has been |was )?(?:sent|submitted)|applied/i.test(text);
      }
    }).catch(() => [{ result: false }]);

    if (finalCheck) {
      await persistResumeWorkflow({
        ...activeResumeWorkflow,
        status: 'APPLICATION_SUBMITTED',
        applicationStatus: 'APPLICATION_SUBMITTED',
        applicationConfirmedAt: new Date().toISOString(),
        lastError: ''
      });
      setStatus('✓ Application submitted on Naukri! Restoring Master Resume…', 'success');
      renderResumeWorkflow();
      updatePrimaryAction();
      await autoRestoreMasterResume();
      return true;
    }

    setStatus('Applied on Naukri. If any questionnaire remains, answer it and restore your Master Resume.', 'info');
    return false;
  }
}

async function autoRestoreMasterResume() {
  try {
    const master = await readResumeFile('master');
    if (!master?.file) {
      setStatus('Application submitted! (Master resume file not found locally; check profile on Naukri).', 'info');
      return false;
    }
    const site = await detectNaukriSite();
    const config = NAUKRI_CONFIG[site] || NAUKRI_CONFIG.main;
    const profileTabId = await openNaukriProfile(site);
    if (!profileTabId) return false;
    await waitForTabComplete(profileTabId);
    await delay(RESUME_UPLOAD_DELAY_MS);

    const masterBase64 = await blobToBase64(master.file);
    const fileName = master.name || resumeFileName || 'MasterResume.docx';
    const injection = await injectResumeIntoNaukri(profileTabId, config, fileName, masterBase64);
    const verification = await verifyNaukriResume(profileTabId, config, fileName);
    if (verification.ok) {
      await chrome.tabs.remove(profileTabId).catch(() => {});
      await persistResumeWorkflow({
        ...activeResumeWorkflow,
        status: 'MASTER_RESUME_RESTORED',
        lastError: ''
      });
      setStatus('✓ Application complete & Master Resume restored on your Naukri profile!', 'success');
      renderResumeWorkflow();
      updatePrimaryAction();
      return true;
    } else {
      setStatus('Application submitted! Please verify your Master Resume restoration on your Naukri profile tab.', 'info');
    }
  } catch (error) {
    console.warn('Auto restore failed:', error);
    setStatus(`Application submitted! Note: Could not auto-restore master resume (${error.message}). Restore on Naukri profile.`, 'info');
  }
  return false;
}

async function submitCompanyApplication({ requestPermission = true } = {}) {
  const workflow = activeResumeWorkflow;
  if (!workflow?.companyApplicationTabId) throw new Error('No company application page is connected to this job.');
  if (workflow.companySubmitClickedAt || workflow.companySubmitAttemptedAt) {
    setStatus('A submit attempt was already made. Check the company tab before trying again.', 'info');
    return false;
  }
  const permissionOrigin = workflow.companyApplicationUrl ? new URL(workflow.companyApplicationUrl).origin : null;
  const permissionRequest = requestPermission && permissionOrigin && /^https:\/\//i.test(permissionOrigin)
    ? chrome.permissions.request({ origins: [`${permissionOrigin}/*`] }) : null;
  const applicationTab = await chrome.tabs.get(workflow.companyApplicationTabId).catch(() => null);
  if (!applicationTab?.id || !/^https:\/\//i.test(applicationTab.url || '')) throw new Error('The company application page is no longer available.');
  const origin = new URL(applicationTab.url).origin;
  if (permissionRequest) await permissionRequest;
  const hasPermission = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!hasPermission) throw new Error(`Allow access to ${new URL(applicationTab.url).hostname} first, then review and submit again.`);
  const selectedResume = await selectedWorkflowFile(workflow);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: applicationTab.id },
    args: [selectedResume.name],
    func: expectedResumeName => {
      const visible = element => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
      const captcha = [...document.querySelectorAll('iframe[src*="captcha" i],iframe[title*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]')].some(visible);
      if (captcha) return { ready: false, reason: 'CAPTCHA detected. Complete it yourself before submitting.' };
      if ([...document.querySelectorAll('input[type="password"]')].some(visible)) return { ready: false, reason: 'Sign in on the company site before continuing.' };

      // Resume attachment check: skip if the portal has no file inputs (uses profile-based resume)
      const fileInputs = [...document.querySelectorAll('input[type="file"]')];
      const hasFileInput = fileInputs.length > 0;
      if (hasFileInput && !fileInputs.some(input => [...(input.files || [])].some(file => file.name === expectedResumeName))) {
        // Soft warning only — don't block; some portals hide the input after selecting
        // return { ready: false, reason: `The selected resume (${expectedResumeName}) is not attached.` };
      }

      const required = [...document.querySelectorAll('input[required],textarea[required],select[required],input[aria-required="true"],textarea[aria-required="true"],select[aria-required="true"]')]
        .filter(element => visible(element) || (element instanceof HTMLInputElement && ['checkbox','radio'].includes(element.type)));
      const radioNames = new Set(required.filter(element => element instanceof HTMLInputElement && element.type === 'radio').map(element => element.name));
      const missing = required.filter(element => {
        if (element instanceof HTMLInputElement && element.type === 'radio') return false;
        if (element instanceof HTMLInputElement && element.type === 'checkbox') return !element.checked;
        if (element instanceof HTMLInputElement && element.type === 'file') return false; // skip file required check
        return !String(element.value || '').trim() || !element.checkValidity();
      });
      for (const name of radioNames) {
        if (![...document.querySelectorAll('input[type="radio"]')].some(element => element.name === name && element.checked)) {
          missing.push(...required.filter(element => element instanceof HTMLInputElement && element.type === 'radio' && element.name === name));
        }
      }
      if (missing.length) return { ready: false, reason: `${missing.length} required field(s) still need your input (highlighted in red on the form).` };

      // Find submit button — broad pattern covering most ATS portals
      const submitPattern = /^(?:submit(?: application| my application)?|send(?: application)?|apply(?: now)?|save \& submit|confirm \& apply|next|continue|review \& submit|review application)$/i;
      const candidates = [...document.querySelectorAll('button[type="submit"],input[type="submit"],button,[role="button"]')]
        .filter(visible).filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true')
        .filter(element => {
          const label = (element.innerText || element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          return submitPattern.test(label);
        });
      // Prioritize buttons inside a form
      const inForm = candidates.filter(el => el.closest('form'));
      const finalCandidates = inForm.length ? inForm : candidates;
      if (!finalCandidates.length) return { ready: false, reason: 'Submit button not found. The form may need more fields filled, or scroll down to find the submit button.' };
      return { ready: true };
    }
  });
  if (!result?.ready) { setStatus(result?.reason || 'The company form is not ready to submit.', 'info'); return false; }

  const attemptedAt = new Date().toISOString();
  await persistResumeWorkflow({ ...activeResumeWorkflow, companySubmitAttemptedAt: attemptedAt, lastError: '' });
  let clickResult;
  try {
    const [{ result: clicked }] = await chrome.scripting.executeScript({
      target: { tabId: applicationTab.id }, args: [selectedResume.name],
      func: expectedResumeName => {
        const visible = element => Boolean(element?.getClientRects().length)
          && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
        if ([...document.querySelectorAll('iframe[src*="captcha" i],iframe[title*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]')].some(visible)) return { clicked: false, reason: 'CAPTCHA appeared before submission.' };
        // NOTE: We do NOT block on file attachment here — many ATS portals (Workday, SmartRecruiters)
        // use profile-based resume; the file input may be absent or hidden after user picks a file.
        const submitPattern = /^(?:submit(?: application| my application)?|send(?: application)?|apply(?: now)?|save \& submit|confirm \& apply|review \& submit|review application)$/i;
        const candidates = [...document.querySelectorAll('button[type="submit"],input[type="submit"],button,[role="button"]')]
          .filter(visible).filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true')
          .filter(element => {
            const label = (element.innerText || element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            return submitPattern.test(label);
          });
        const inForm = candidates.filter(el => el.closest('form'));
        const finalCandidates = inForm.length ? inForm : candidates;
        if (!finalCandidates.length) return { clicked: false, reason: 'The submit button could not be found. Submit the form manually.' };
        // Click the last (most likely "submit") candidate if multiple found in form
        finalCandidates[finalCandidates.length - 1].click();
        return { clicked: true };
      }
    });
    clickResult = clicked;
  } catch (error) { clickResult = { clicked: false, reason: error.message || 'Submit click failed.' }; }
  if (!clickResult?.clicked) {
    await persistResumeWorkflow({ ...activeResumeWorkflow, companySubmitAttemptedAt: '', lastError: clickResult?.reason || '' });
    setStatus(clickResult?.reason || 'The company form was not submitted.', 'info');
    return false;
  }
  await persistResumeWorkflow({ ...activeResumeWorkflow, companySubmitClickedAt: new Date().toISOString(), lastError: '' });

  let confirmation = false;
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await delay(600);
    const current = await chrome.tabs.get(applicationTab.id).catch(() => null);
    if (!current?.url) break;
    try {
      const [{ result: state }] = await chrome.scripting.executeScript({ target: { tabId: applicationTab.id }, func: () => ({
        url: location.href,
        text: (document.body?.innerText || '').slice(0, 12_000)
      }) });
      confirmation = /thank you for applying|application (?:was )?(?:submitted|received)|successfully applied|we have received your application/i.test(state?.text || '')
        || /(?:thank[-_/]?you|application[-_/]?(?:success|submitted|received))/i.test(state?.url || '');
      if (confirmation) break;
    } catch { /* A redirect may briefly make the page unavailable to the extension. */ }
  }
  if (!confirmation) {
    await returnToCompanyJobTab(workflow.jobTabId);
    setStatus('The submit button was clicked, but the company site showed no confirmation. Check the application before retrying.', 'info');
    return false;
  }
  await persistResumeWorkflow({
    ...activeResumeWorkflow, status: 'APPLICATION_SUBMITTED', applicationStatus: 'APPLICATION_SUBMITTED',
    applicationConfirmedAt: new Date().toISOString(), companySubmissionVerified: true, lastError: ''
  });
  renderResumeWorkflow();
  updatePrimaryAction();
  setStatus('✓ Application submitted on company site! Returning to Naukri & restoring Master Resume…', 'success');
  await returnToCompanyJobTab(activeResumeWorkflow.jobTabId);
  // Auto-restore master resume to Naukri profile after external company application
  await autoRestoreMasterResume();
  return true;
}

async function returnToCompanyJobTab(jobTabId) {
  const jobTab = jobTabId ? await chrome.tabs.get(jobTabId).catch(() => null) : null;
  if (!jobTab?.id) return false;
  await chrome.tabs.update(jobTab.id, { active: true });
  if (jobTab.windowId != null) await chrome.windows.update(jobTab.windowId, { focused: true }).catch(() => {});
  return true;
}

async function openNaukriProfileFromButton() {
  const button = $('openNaukriProfileBtn');
  button.disabled = true;
  try {
    setStatus('Opening your Naukri profile…', 'info');
    const site = await detectNaukriSite();
    const tabId = await openNaukriProfile(site);
    if (!tabId) throw new Error('The browser did not open a Naukri tab.');
    setStatus('Naukri profile opened.', 'success');
  } catch (error) {
    setStatus(`Could not open Naukri: ${error.message}`, 'error');
  } finally { button.disabled = false; }
}
$('openNaukriProfileBtn').addEventListener('click', openNaukriProfileFromButton);
$('returnToJobBtn').addEventListener('click', returnToJobApplication);

async function useMasterResumeForThisJob() {
  try {
    if (!activeResumeWorkflow) throw new Error('Open a Naukri job listing first.');
    let permissionRequest = null;
    const applyUrl = activeResumeWorkflow.companyApplyUrl || jobMetadata.companyApplyUrl;
    if (lastAnalysis && applyUrl) {
      try {
        const destination = new URL(applyUrl);
        if (destination.protocol === 'https:' && !/(^|\.)naukri\.com$/i.test(destination.hostname)) {
          permissionRequest = chrome.permissions.request({ origins: [`${destination.origin}/*`] });
        }
      } catch { /* Continue with the Naukri Apply action if the external URL is missing. */ }
    }
    if (permissionRequest && !(await permissionRequest)) {
      setStatus('Allow access to the company site to fill its application form, then choose this resume again.', 'info');
      return;
    }
    const master = await readResumeFile('master');
    if (!master?.file) throw new Error('Upload a Master Resume first.');
    await persistResumeWorkflow({
      ...activeResumeWorkflow,
      selectedType: 'master', selectedResumeName: master.name || resumeFileName,
      status: 'MASTER_RESUME_SELECTED', lastError: '', manualUploadNeeded: false,
      downloadedAt: '', downloadedFileName: ''
    });
    await loadWorkflowResumePreview();
    await chooseResumeForThisJob();
  } catch (error) { setStatus(error.message, 'error'); }
}
$('useMasterResumeBtn').addEventListener('click', useMasterResumeForThisJob);
async function generateTemporaryResumeForActiveJob() {
  if (!activeResumeWorkflow || (!lastAnalysis && !quickOverview)) throw new Error('Open a job and add the Master Resume before tailoring.');
  tailorGenerationInProgress = true;
  updatePrimaryAction();
  try {
    const job = currentJobPayload();
    const generated = await generateResumeStep(job);
    const saved = await chrome.storage.local.get(['fullName']);
    const candidateName = (saved.fullName || $('fullNameInput').value || $('resumeText').value.split(/\r?\r\n/).find(line => line.trim()) || '').trim();
    const firstNameRaw = candidateName.split(/\s+/)[0] || '';
    const firstName = safeFilenamePart(firstNameRaw).replace(/_/g, '');
    if (!firstNameRaw || !firstName || firstName === 'Job') throw new Error('Add your name in Settings before generating a tailored resume.');
    const now = new Date();
    const date = [String(now.getDate()).padStart(2, '0'), String(now.getMonth() + 1).padStart(2, '0'), now.getFullYear()].join('-');
    const fileName = `${firstName}_${date}.docx`;
    const id = `temporary-${activeResumeWorkflow.jobKey}`;
    const previewStorageId = `preview-${activeResumeWorkflow.jobKey}`;
    const previewText = tailoredWorkingCopy.trim() || $('resumeText').value.trim();
    await storeResumeFile(id, generated.blob, fileName);
    await storeResumeFile(previewStorageId, new Blob([previewText], { type: 'text/plain;charset=utf-8' }), `${firstName}_${date}_preview.txt`);
    await persistResumeWorkflow({
      ...activeResumeWorkflow, selectedType: 'tailored', temporaryResumeId: id,
      temporaryResumeName: fileName, temporaryResumeSize: generated.blob.size, previewStorageId, generatedAt: new Date().toISOString(),
      status: 'TAILORED_RESUME_GENERATED', pipelineStep: 1, lastDownloadedResumeName: '',
      downloadedFileName: '', downloadedAt: '', lastDownloadId: null, manualUploadNeeded: false,
      lastError: '', formatNote: generated.formatNote || '', validationNote: generated.validationNote || ''
    });
    await loadWorkflowResumePreview();
    setStatus('Tailored resume generated.', 'success');
  } catch (error) {
    await persistResumeWorkflow({ ...activeResumeWorkflow, status: 'TAILORING_FAILED', lastError: `Tailored resume generation failed: ${error.message}` });
    setStatus(`Could not generate tailored resume: ${error.message}`, 'error');
    throw error;
  } finally {
    tailorGenerationInProgress = false;
    renderResumeWorkflow();
    updatePrimaryAction();
  }
}

async function loadWorkflowResumePreview() {
  const workflow = activeResumeWorkflow;
  activeResumePreviewText = '';
  renderResumeWorkflow();
  if (!workflow?.selectedType) return;
  try {
    const selected = await selectedWorkflowFile(workflow);
    if (activeResumeWorkflow?.jobKey !== workflow.jobKey) return;
    if (workflow.selectedType === 'master') activeResumePreviewText = $('resumeText').value.trim();
    else if (workflow.previewStorageId) {
      try {
        const preview = await readResumeFile(workflow.previewStorageId);
        activeResumePreviewText = preview?.file?.text ? await preview.file.text() : 'Resume text preview is unavailable for this saved file.';
      } catch { activeResumePreviewText = 'Resume text preview is unavailable for this saved file.'; }
    } else activeResumePreviewText = tailoredWorkingCopy || $('resumeText').value.trim() || 'Resume text preview is unavailable for this saved file.';
  } catch {
    if (activeResumeWorkflow?.jobKey === workflow.jobKey) {
      activeResumePreviewText = 'Resume preview is unavailable. The saved file can still be downloaded.';
    }
  }
  renderResumeWorkflow();
}

async function selectedWorkflowFile(workflow = activeResumeWorkflow) {
  if (!workflow) throw new Error('No active job workflow.');
  const master = workflow.selectedType === 'master';
  const stored = await readResumeFile(master ? 'master' : workflow.temporaryResumeId);
  if (!stored?.file) throw new Error(master ? 'The Master Resume file is unavailable. Replace it in Apply first.' : 'The temporary resume is missing. Retry generation.');
  return { blob: stored.file, name: master ? (stored.name || resumeFileName || 'MasterResume.docx') : workflow.temporaryResumeName };
}

async function downloadActiveWorkflowResume() {
  const button = $('downloadActiveResumeBtn');
  button.disabled = true;
  try {
    const file = await selectedWorkflowFile();
    const url = URL.createObjectURL(file.blob);
    const extension = file.name.match(/\.[^.]+$/)?.[0] || '.docx';
    const downloadName = `MenixJobAI/${safeFilenamePart(file.name.replace(/\.[^.]+$/, ''))}${extension}`;
    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({ url, filename: downloadName, saveAs: false, conflictAction: 'uniquify' });
    } catch (downloadError) {
      // Some Chromium builds reject extension-created blob URLs in the
      // downloads API. A regular download link supports the same local Blob.
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      console.warn('Downloads API rejected the resume Blob; used the browser download link instead.', downloadError);
    }
    if (activeResumeWorkflow.status !== 'RESTORATION_PENDING' && activeResumeWorkflow.status !== 'RESTORATION_FAILED') {
      await persistResumeWorkflow({
        ...activeResumeWorkflow,
        status: 'WAITING_FOR_PROFILE_UPLOAD',
        lastDownloadedResumeName: file.name,
        downloadedFileName: file.name,
        lastDownloadId: downloadId,
        lastDownloadFolder: downloadId ? 'MenixJobAI' : '',
        downloadedAt: new Date().toISOString(),
        lastError: ''
      });
    } else {
      await persistResumeWorkflow({ ...activeResumeWorkflow, lastDownloadedResumeName: file.name, downloadedFileName: file.name, lastDownloadId: downloadId, lastDownloadFolder: downloadId ? 'MenixJobAI' : '', downloadedAt: new Date().toISOString(), lastError: '' });
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus(downloadId
      ? `Saved ${file.name} to Downloads/MenixJobAI.`
      : `Saved ${file.name} to Downloads.`, 'success');
  } catch (error) {
    if (activeResumeWorkflow) await persistResumeWorkflow({ ...activeResumeWorkflow, lastError: error.message });
    setStatus(`Could not download the selected resume: ${error.message}`, 'error');
  } finally { button.disabled = false; }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function injectResumeIntoNaukri(tabId, config, fileName, base64) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [config, fileName, base64],
    func: async (siteConfig, name, encoded) => {
      const visible = element => Boolean(element?.getClientRects().length);
      const findInput = () => {
        for (const selector of siteConfig.inputSelectors || []) {
          try {
            const inputs = [...document.querySelectorAll(selector)].filter(element => element instanceof HTMLInputElement && element.type === 'file');
            const input = selector === 'input[type="file"]'
              ? inputs.find(element => /doc|pdf|resume|cv/i.test(`${element.accept} ${element.id} ${element.name}`)) || (inputs.length === 1 ? inputs[0] : null)
              : inputs[0];
            if (input) return input;
          } catch { /* Ignore selectors unsupported by the current site markup. */ }
        }
        return null;
      };
      let input = findInput();
      if (!input && window === window.top) {
        const buttonPattern = new RegExp(siteConfig.buttonTextMatches || 'update\\s+resume', 'i');
        const updateButton = [...document.querySelectorAll('button,a,[role="button"]')]
          .find(element => visible(element) && buttonPattern.test((element.innerText || element.getAttribute('aria-label') || '').trim()));
        if (updateButton) {
          updateButton.click();
          const startedAt = Date.now();
          while (!input && Date.now() - startedAt < 1000) {
            await new Promise(resolve => setTimeout(resolve, 100));
            input = findInput();
          }
        }
      }
      try {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        const file = new File([bytes], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', lastModified: Date.now() });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        if (input) {
          input.files = transfer.files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, method: 'input', detail: `Selected ${name} in ${input.id ? `#${input.id}` : 'the resume file input'}.`, isTop: window === window.top };
        }
        for (const selector of siteConfig.dropZoneSelectors || []) {
          let zone;
          try { zone = [...document.querySelectorAll(selector)].find(visible); } catch { zone = null; }
          if (!zone) continue;
          for (const type of ['dragenter', 'dragover', 'drop']) {
            zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
          }
          return { ok: true, method: 'drop', detail: `Sent the selected file to ${selector}.`, isTop: window === window.top };
        }
        return { ok: false, method: 'none', detail: 'No resume file input or drop zone was found.', isTop: window === window.top };
      } catch (error) {
        return { ok: false, method: 'none', detail: error?.message || 'The page rejected the file selection.', isTop: window === window.top };
      }
    }
  });
  const frameResults = results.map(entry => entry.result).filter(Boolean);
  return frameResults.find(result => result.ok) || frameResults.find(result => result.isTop) || frameResults[0] || { ok: false, method: 'none', detail: 'Naukri did not expose an upload frame.' };
}

async function inspectNaukriResume(tabId, config, expectedFileName) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    args: [config, expectedFileName],
    func: (siteConfig, expected) => {
      const visible = element => Boolean(element?.getClientRects().length);
      const selectedText = (siteConfig.fileNameSelectors || []).flatMap(selector => {
        try { return [...document.querySelectorAll(selector)].filter(visible).map(element => element.innerText || element.textContent || ''); }
        catch { return []; }
      }).join('\r\n');
      const bodyText = document.body?.innerText || '';
      const text = `${selectedText}\r\n${bodyText}`;
      const hasName = text.toLowerCase().includes(expected.toLowerCase());
      const successTexts = (siteConfig.successSelectors || []).flatMap(selector => {
        try { return [...document.querySelectorAll(selector)].filter(visible).map(element => element.innerText || element.textContent || ''); }
        catch { return []; }
      }).join('\r\n');
      const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();
      const successSignal = /(?:uploaded\s+successfully|successfully\s+(?:uploaded|updated)|resume\s+(?:uploaded|updated)|upload\s+complete)/i.test(successTexts)
        || /uploaded\s+on\s+today/i.test(text)
        || text.toLowerCase().includes(`uploaded on ${today}`)
        || /(?:resume\s+(?:uploaded|updated)\s+successfully|successfully\s+(?:uploaded|updated))/i.test(bodyText);
      const fileNames = [...new Set((text.match(/[A-Z0-9][A-Z0-9 _().-]*\.(?:docx?|pdf)/gi) || []).map(value => value.trim()))].slice(0, 6);
      const relevantLines = text.split(/\r\n+/).map(line => line.trim()).filter(line => /resume|upload|\.(?:docx?|pdf)/i.test(line)).slice(0, 8);
      return {
        ok: hasName && successSignal,
        hasName,
        successSignal,
        fileNames,
        foundText: relevantLines.join(' | ').slice(0, 500) || 'No resume filename or upload confirmation was visible.',
        isTop: window === window.top
      };
    }
  });
  const frameResults = results.map(entry => entry.result).filter(Boolean);
  return frameResults.find(result => result.ok) || frameResults.find(result => result.isTop) || frameResults[0] || {
    ok: false, hasName: false, successSignal: false, fileNames: [], foundText: 'No readable Naukri page frame was found.'
  };
}

async function verifyNaukriResume(tabId, config, expectedFileName, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let result = null;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) throw new Error('Naukri profile tab is no longer available.');
    if (profileIsLoggedOut(tab.url, config)) throw new Error('Log in to Naukri first.');
    result = await inspectNaukriResume(tabId, config, expectedFileName).catch(error => ({
      ok: false, hasName: false, successSignal: false, fileNames: [], foundText: error.message
    }));
    if (result.ok) return result;
    await delay(500);
  }
  return result || { ok: false, hasName: false, successSignal: false, fileNames: [], foundText: 'No upload status was found.' };
}

async function highlightNaukriResumeButton(tabId, config) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [config.buttonTextMatches],
      func: pattern => {
        const matcher = new RegExp(pattern || 'update\\s+resume', 'i');
        const button = [...document.querySelectorAll('button,a,[role="button"]')]
          .find(element => element.getClientRects().length && matcher.test((element.innerText || element.getAttribute('aria-label') || '').trim()));
        if (!button) return { found: false };
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const oldOutline = button.style.getPropertyValue('outline');
        const oldOffset = button.style.getPropertyValue('outline-offset');
        button.style.setProperty('outline', '3px solid #1769e0', 'important');
        button.style.setProperty('outline-offset', '3px', 'important');
        let animation;
        try {
          animation = button.animate([
            { boxShadow: '0 0 0 0 rgba(23,105,224,0.8)' },
            { boxShadow: '0 0 0 8px rgba(23,105,224,0)' }
          ], { duration: 900, iterations: 33 });
        } catch { /* The solid outline still identifies the upload button. */ }
        window.setTimeout(() => {
          animation?.cancel();
          if (oldOutline) button.style.setProperty('outline', oldOutline); else button.style.removeProperty('outline');
          if (oldOffset) button.style.setProperty('outline-offset', oldOffset); else button.style.removeProperty('outline-offset');
        }, 30_000);
        return { found: true };
      }
    });
    return results.some(entry => entry.result?.found);
  } catch { return false; }
}

async function logResumeUploadAttempt(method, verified, fileName, detail = '') {
  const saved = await chrome.storage.local.get([RESUME_UPLOAD_HISTORY_KEY]);
  const history = Array.isArray(saved[RESUME_UPLOAD_HISTORY_KEY]) ? saved[RESUME_UPLOAD_HISTORY_KEY] : [];
  history.unshift({
    jobUrl: activeResumeWorkflow?.jobUrl || $('jobUrl').value,
    fileName,
    method,
    verified: Boolean(verified),
    timestamp: new Date().toISOString(),
    detail: String(detail || '').slice(0, 500)
  });
  await chrome.storage.local.set({ [RESUME_UPLOAD_HISTORY_KEY]: history.slice(0, 100) });
}

async function showManualUploadGuide(tabId, config, fileName, detail) {
  await highlightNaukriResumeButton(tabId, config);
  try { await navigator.clipboard.writeText(fileName); } catch { /* Manual guide still displays the exact filename. */ }
  await logResumeUploadAttempt('manual', false, fileName, detail || 'Automatic upload could not be verified; manual upload required.');
  await persistResumeWorkflow({
    ...activeResumeWorkflow,
    profileTabId: tabId,
    pipelineStep: 3,
    status: 'WAITING_FOR_PROFILE_UPLOAD',
    lastDownloadFolder: activeResumeWorkflow?.lastDownloadFolder || 'MenixJobAI',
    manualUploadNeeded: true,
    uploadMethod: 'manual',
    lastError: detail || `Expected: ${fileName}; found: ${fileName ? 'no verified upload confirmation' : 'no filename'}.`
  });
  setStatus('Manual upload needed.', 'info');
}

async function chooseResumeForThisJob() {
  if (resumeUploadPipelinePromise) return resumeUploadPipelinePromise;
  resumeUploadPipelinePromise = (async () => {
    if (!activeResumeWorkflow) throw new Error('Open a job listing first.');
    if (!lastAnalysis && activeResumeWorkflow.selectedType !== 'tailored') throw new Error('Wait for job analysis before choosing this resume.');
    let workflow = activeResumeWorkflow;
    if (workflow.selectedType === 'master') {
      const master = await readResumeFile('master').catch(() => null);
      if (!master?.file) throw new Error('The Master Resume file is unavailable. Replace it in Apply first.');
    } else {
      const stored = workflow.selectedType === 'tailored' && workflow.temporaryResumeId
        ? await readResumeFile(workflow.temporaryResumeId).catch(() => null) : null;
      const expectedNamePattern = /^.+_\d{2}-\d{2}-\d{4}\.docx$/i;
      if (!stored?.file || !expectedNamePattern.test(workflow.temporaryResumeName || '')) {
        await tailorResumeForActiveJob({ applyAfter: false });
        return;
      }
    }
    const file = await selectedWorkflowFile(workflow);
    if (workflow.companyApplyUrl && await openCompanyApplicationDirectly(workflow)) return;
    const savedJobTab = workflow.jobTabId ? await chrome.tabs.get(workflow.jobTabId).catch(() => null) : null;
    const companyApplyTarget = savedJobTab?.id ? await detectCompanyApplyButton(savedJobTab.id) : false;
    if (companyApplyTarget) {
      if (typeof companyApplyTarget === 'string') {
        const destination = new URL(companyApplyTarget);
        if (destination.protocol === 'https:' && !await chrome.permissions.contains({ origins: [`${destination.origin}/*`] })) {
          const granted = await chrome.permissions.request({ origins: [`${destination.origin}/*`] });
          if (!granted) throw new Error(`Allow access to ${destination.hostname} before starting the company application.`);
        }
        await persistResumeWorkflow({ ...activeResumeWorkflow, companyApplyUrl: companyApplyTarget });
      }
      await returnToJobAndClickApply();
      return;
    }
    await persistResumeWorkflow({ ...activeResumeWorkflow, pipelineStep: 1, lastError: '' });
    await delay(RESUME_UPLOAD_DELAY_MS);
    const site = await detectNaukriSite(activeResumeWorkflow);
    const config = NAUKRI_CONFIG[site];
    let jobTab = activeResumeWorkflow.jobTabId ? await chrome.tabs.get(activeResumeWorkflow.jobTabId).catch(() => null) : null;
    if (!jobTab?.id) {
      const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const candidate = activeTabs[0];
      if (candidate?.id && candidate.url && !/mnjuser\/(?:profile|login)/i.test(candidate.url)) jobTab = candidate;
    }
    if (!activeResumeWorkflow.jobTabId && jobTab?.id) {
      await persistResumeWorkflow({ ...activeResumeWorkflow, jobTabId: jobTab.id, naukriSite: site });
    }
    const profileTabId = await openNaukriProfile(site);
    if (!profileTabId) throw new Error('Could not open the Naukri profile.');
    await persistResumeWorkflow({ ...activeResumeWorkflow, profileTabId, naukriSite: site, pipelineStep: 2, lastError: '' });
    await waitForTabComplete(profileTabId);
    await delay(RESUME_UPLOAD_DELAY_MS);
    const profileTab = await chrome.tabs.get(profileTabId);
    if (profileIsLoggedOut(profileTab.url || '', config)) {
      const message = 'Log in to Naukri first.';
      await persistResumeWorkflow({ ...activeResumeWorkflow, profileTabId, naukriSite: site, lastError: message });
      setStatus(message, 'error');
      return;
    }
    await persistResumeWorkflow({ ...activeResumeWorkflow, pipelineStep: 3, status: 'UPLOADING_RESUME', manualUploadNeeded: false, lastError: '' });
    const fileBase64 = await blobToBase64(file.blob);
    const injection = await injectResumeIntoNaukri(profileTabId, config, file.name, fileBase64);
    const verification = await verifyNaukriResume(profileTabId, config, file.name);
    const method = injection.method;
    const verified = method !== 'none' && verification.ok;
    if (method !== 'none') await logResumeUploadAttempt(method, verified, file.name, `${injection.detail} ${verification.foundText}`);
    if (verified) {
      await persistResumeWorkflow({
        ...activeResumeWorkflow,
        status: activeResumeWorkflow.selectedType === 'master' ? 'MASTER_RESUME_UPLOADED' : 'TEMPORARY_RESUME_UPLOADED', pipelineStep: 4,
        manualUploadNeeded: false, uploadMethod: method,
        uploadedAt: new Date().toISOString(), lastError: '', applicationStartFailed: false
      });
      await returnToJobAndClickApply(profileTabId);
      return;
    }
    const detail = `Expected: ${file.name}; found: ${verification.fileNames.join(', ') || verification.foundText}.`;
    await showManualUploadGuide(profileTabId, config, file.name, detail);
  })().catch(async error => {
    if (activeResumeWorkflow) await persistResumeWorkflow({
      ...activeResumeWorkflow,
      applicationStartFailed: activeResumeWorkflow.status === 'TEMPORARY_RESUME_UPLOADED' || activeResumeWorkflow.applicationStartFailed,
      lastError: error.message
    });
    setStatus(error.message, 'error');
  }).finally(() => {
    resumeUploadPipelinePromise = null;
    renderResumeWorkflow();
    updatePrimaryAction();
  });
  updatePrimaryAction();
  return resumeUploadPipelinePromise;
}

async function getNaukriProfileContext() {
  const site = activeResumeWorkflow?.naukriSite || await detectNaukriSite();
  const config = NAUKRI_CONFIG[site] || NAUKRI_CONFIG.main;
  let tab = activeResumeWorkflow?.profileTabId ? await chrome.tabs.get(activeResumeWorkflow.profileTabId).catch(() => null) : null;
  const isProfilePage = candidate => {
    if (!candidate?.url) return false;
    try {
      const current = new URL(candidate.url);
      const expected = new URL(config.profileUrl);
      return current.hostname === expected.hostname || current.hostname.endsWith(`.${expected.hostname}`)
        ? current.pathname.toLowerCase().includes('profile')
        : false;
    } catch { return false; }
  };
  if (!tab?.id || !isProfilePage(tab)) {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const active = activeTabs[0];
    if (active?.id && isProfilePage(active)) tab = active;
  }
  if (!tab?.id) {
    const tabId = await openNaukriProfile(site);
    if (!tabId) throw new Error('Open your Naukri profile first.');
    await waitForTabComplete(tabId);
    await delay(RESUME_UPLOAD_DELAY_MS);
    tab = await chrome.tabs.get(tabId);
  }
  return { tab, site, config };
}

async function verifyActiveResumeUpload() {
  if (resumeUploadPipelinePromise) return resumeUploadPipelinePromise;
  resumeUploadPipelinePromise = (async () => {
    const file = await selectedWorkflowFile();
    const { tab, site, config } = await getNaukriProfileContext();
    if (profileIsLoggedOut(tab.url || '', config)) throw new Error('Log in to Naukri first.');
    const verification = await verifyNaukriResume(tab.id, config, file.name);
    await logResumeUploadAttempt('manual', verification.ok, file.name, verification.foundText);
    if (!verification.ok) {
      const detail = `Expected: ${file.name}; found: ${verification.fileNames.join(', ') || verification.foundText}.`;
      await persistResumeWorkflow({ ...activeResumeWorkflow, profileTabId: tab.id, naukriSite: site, manualUploadNeeded: true, status: 'WAITING_FOR_PROFILE_UPLOAD', pipelineStep: 3, lastError: detail });
      setStatus(detail, 'error');
      return;
    }
    await persistResumeWorkflow({
      ...activeResumeWorkflow,
      profileTabId: tab.id,
      naukriSite: site,
      status: activeResumeWorkflow.selectedType === 'master' ? 'MASTER_RESUME_UPLOADED' : 'TEMPORARY_RESUME_UPLOADED', pipelineStep: 4,
      manualUploadNeeded: false, uploadMethod: 'manual', uploadedAt: new Date().toISOString(), lastError: ''
    });
    setStatus(`Resume updated on Naukri: ${file.name}`, 'success');
  })().catch(error => setStatus(error.message, 'error')).finally(() => {
    resumeUploadPipelinePromise = null;
    renderResumeWorkflow();
    updatePrimaryAction();
  });
  updatePrimaryAction();
  return resumeUploadPipelinePromise;
}

async function requestMasterResumeRestore() {
  if (!activeResumeWorkflow) return setStatus('No active job resume.', 'error');
  if (!activeResumeWorkflow.restoreConfirmed) {
    $('restoreConfirmDialog').showModal();
    return;
  }
  await runMasterRestorePipeline();
}

async function runMasterRestorePipeline() {
  if (resumeUploadPipelinePromise) return resumeUploadPipelinePromise;
  resumeUploadPipelinePromise = downloadMasterForRestoration().finally(() => {
    resumeUploadPipelinePromise = null;
    renderResumeWorkflow();
    updatePrimaryAction();
  });
  updatePrimaryAction();
  return resumeUploadPipelinePromise;
}

async function confirmApplicationEnded(status) {
  if (!activeResumeWorkflow || !confirm(status === 'APPLICATION_SUBMITTED'
    ? `Confirm that you submitted this application?${activeResumeWorkflow.selectedType === 'master' ? '' : ' This will start the Master Resume restoration steps.'}`
    : `Confirm that you cancelled this application?${activeResumeWorkflow.selectedType === 'master' ? '' : ' This will start the Master Resume restoration steps.'}`)) return;
  if (activeResumeWorkflow.selectedType === 'master') {
    await persistResumeWorkflow({ ...activeResumeWorkflow, status, applicationStatus: status, applicationConfirmedAt: new Date().toISOString(), lastError: '' });
    setStatus(status === 'APPLICATION_SUBMITTED' ? 'Application marked as submitted.' : 'Application marked as cancelled. Your Master Resume is already on Naukri.', 'success');
    return;
  }
  await persistResumeWorkflow({ ...activeResumeWorkflow, status, applicationStatus: status, applicationConfirmedAt: new Date().toISOString(), lastError: '' });
  await persistResumeWorkflow({ ...activeResumeWorkflow, status: 'RESTORATION_PENDING', lastError: '' });
  try { await openNaukriProfile(await detectNaukriSite()); setStatus('Application state saved. Upload the original Master Resume on Naukri, then verify its filename here.', 'info'); }
  catch (error) { await persistResumeWorkflow({ ...activeResumeWorkflow, lastError: error.message }); }
}

async function downloadMasterForRestoration() {
  try {
    if (!activeResumeWorkflow) throw new Error('No active job workflow.');
    const master = await readResumeFile('master');
    if (!master?.file) throw new Error('Original Master Resume file is unavailable. Replace it in Apply before continuing.');
    const site = await detectNaukriSite();
    const profileTabId = await openNaukriProfile(site);
    if (!profileTabId) throw new Error('Could not open the Naukri profile.');
    await waitForTabComplete(profileTabId);
    await delay(RESUME_UPLOAD_DELAY_MS);
    const url = URL.createObjectURL(master.file);
    const fileName = master.name || resumeFileName || 'MasterResume.docx';
    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({ url, filename: `MenixJobAI/${safeFilenamePart(fileName)}`, saveAs: false, conflictAction: 'uniquify' });
    } catch {
      const link = document.createElement('a'); link.href = url; link.download = fileName; link.style.display = 'none';
      document.body.append(link); link.click(); link.remove();
    }
    await persistResumeWorkflow({
      ...activeResumeWorkflow, status: 'RESTORATION_PENDING', profileTabId, naukriSite: site,
      lastDownloadedResumeName: fileName, downloadedFileName: fileName, lastDownloadId: downloadId,
      lastDownloadFolder: downloadId ? 'MenixJobAI' : '', downloadedAt: new Date().toISOString(), lastError: ''
    });
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus('Master resume downloaded. Upload it on Naukri and verify.', 'success');
  } catch (error) { await persistResumeWorkflow({ ...activeResumeWorkflow, status: 'RESTORATION_FAILED', lastError: error.message }); setStatus(error.message, 'error'); }
}

async function verifyMasterRestored() {
  if (resumeUploadPipelinePromise) return resumeUploadPipelinePromise;
  resumeUploadPipelinePromise = (async () => {
    try {
      const master = await readResumeFile('master');
      const expected = master?.name || resumeFileName;
      if (!expected) throw new Error('The original Master Resume filename is unavailable.');
      const { tab, site, config } = await getNaukriProfileContext();
      if (profileIsLoggedOut(tab.url || '', config)) throw new Error('Log in to Naukri first.');
      const verification = await verifyNaukriResume(tab.id, config, expected);
      await logResumeUploadAttempt('manual', verification.ok, expected, verification.foundText);
      if (!verification.ok) throw new Error(`Expected: ${expected}; found: ${verification.fileNames.join(', ') || verification.foundText}.`);
      if (activeResumeWorkflow?.temporaryResumeId) await deleteResumeFile(activeResumeWorkflow.temporaryResumeId);
      if (activeResumeWorkflow?.previewStorageId) await deleteResumeFile(activeResumeWorkflow.previewStorageId);
      await persistResumeWorkflow({ ...activeResumeWorkflow, status: 'MASTER_RESUME_RESTORED', pipelineStep: 4, naukriSite: site, profileTabId: tab.id, restoredAt: new Date().toISOString(), temporaryResumeId: '', previewStorageId: '', lastError: '' });
      setStatus(`Master resume restored: ${expected}`, 'success');
    } catch (error) {
      await persistResumeWorkflow({ ...activeResumeWorkflow, status: 'RESTORATION_FAILED', lastError: error.message });
      setStatus(error.message, 'error');
    }
  })().finally(() => {
    resumeUploadPipelinePromise = null;
    renderResumeWorkflow();
    updatePrimaryAction();
  });
  updatePrimaryAction();
  return resumeUploadPipelinePromise;
}

async function retryActiveWorkflow() {
  if (!activeResumeWorkflow) return;
  const workflow = activeResumeWorkflow;
  await persistResumeWorkflow({ ...workflow, lastError: '' });
  if (['RESTORATION_PENDING', 'RESTORATION_FAILED', 'APPLICATION_CANCELLED', 'APPLICATION_SUBMITTED'].includes(workflow.status)) return runMasterRestorePipeline();
  if (workflow.manualUploadNeeded || workflow.selectedType === 'master' || workflow.selectedType === 'tailored' || lastAnalysis) return chooseResumeForThisJob();
}

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
    }
    await chrome.storage.local.set({
      resumeText: text,
      resumeName: uploadedMaster?.name || resumeFileName || 'Pasted master resume',
      resumeSize: uploadedMaster?.size || resumeFileSize || 0,
      masterResumeText: text,
      masterResumeFileName: uploadedMaster?.name || resumeFileName || 'Pasted master resume',
      masterResumeSize: uploadedMaster?.size || resumeFileSize || 0
    });
    void lookupResumeProfile(text);

    resumeIsSaved = true;
    resumeTextEdited = false;
    if (!resumeFileMatchesText) $('resumeFile').value = '';
    resumeFileSize = uploadedMaster?.size || resumeFileSize || 0;
    resumeFileName = uploadedMaster?.name || resumeFileName || 'Pasted master resume';
    $('resumeStatus').textContent =
      'Saved in this browser profile.';
    updateResumeCard(resumeFileName);
    renderResumeWorkflow();

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

async function loadAiSuggestions({ forceRegenerate = false } = {}) {
  if (suggestionRequestPromise && !forceRegenerate) return suggestionRequestPromise;
  if (forceRegenerate) {
    suggestionController?.abort();
    suggestionRequestPromise = null;
    suggestionData = null;
  }
  const resumeText = $('resumeText').value.trim();
  const jobDescription = $('jobDescription').value.trim();
  if (!resumeText || !jobDescription) return;
  const controller = new AbortController();
  suggestionController = controller;
  $('suggestionsSummaryHint').textContent = 'Loading…';
  const container = $('analysis'); container.replaceChildren();
  for (let index = 0; index < 3; index++) {
    const skeleton = document.createElement('div'); skeleton.className = 'suggestion-skeleton'; skeleton.setAttribute('aria-hidden', 'true'); container.append(skeleton);
  }
  suggestionRequestPromise = (async () => {
    try {
      const resumeProfileResult = await lookupResumeProfile(resumeText);
      if (controller.signal.aborted) return;
      const requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeText,
          resumeProfile: resumeProfileResult?.profile || null,
          resumeHash: resumeProfileResult?.resumeHash || await sha256Hex(cleanText(resumeText)),
          jobDescription,
          workingResume: tailoredWorkingCopy || resumeText,
          confirmedFacts: confirmedCandidateFacts(),
          jobMeta: { title: cleanText($('jobTitleInput').value), company: cleanText($('companyInput').value), location: cleanText($('locationInput').value) },
          forceRegenerate
        }),
        signal: controller.signal
      };
      let data;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          data = await api('/ai/suggestions', requestOptions);
          break;
        } catch (error) {
          const transient = /bad gateway|gateway timeout|service unavailable|temporar|network|fetch failed|timed? out/i.test(String(error?.message || error));
          if (!transient || attempt === 1 || controller.signal.aborted) throw error;
          setStatus('AI service is temporarily unavailable. Retrying tailoring…', 'info');
          await delay(1200);
          if (controller.signal.aborted) return;
        }
      }
      if (controller.signal.aborted) return;
      suggestionData = data;
      suggestionLoadError = '';
      renderAiSuggestions(data);
      $('suggestionsSummaryHint').textContent = data.cached ? 'Cached edits' : `${(data.suggestions || []).length} edits`;
      return data;
    } catch (error) {
      if (controller.signal.aborted) return;
      suggestionLoadError = error?.message || 'The AI suggestions request failed.';
      container.replaceChildren();
      const message = document.createElement('p'); message.className = 'suggestions-error'; message.textContent = 'AI suggestions could not load.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'suggestion-action'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => { suggestionData = null; suggestionLoadError = ''; void loadAiSuggestions(); });
      container.append(message, retry);
      $('suggestionsSummaryHint').textContent = 'Unavailable';
      return null;
    } finally {
      if (suggestionController === controller) {
        suggestionController = null;
        suggestionRequestPromise = null;
      }
    }
  })();
  return suggestionRequestPromise;
}

function renderAiSuggestions(data) {
  const container = $('analysis'); container.replaceChildren();
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  if (!suggestions.length) {
    const empty = document.createElement('p'); empty.className = 'suggestions-empty'; empty.textContent = 'No resume edits were suggested for this job.'; container.append(empty);
  }
  suggestions.forEach((suggestion, index) => {
    const card = document.createElement('article'); card.className = 'suggestion-card';
    const title = document.createElement('h4'); title.textContent = `${suggestion.section || 'Resume'} suggestion ${index + 1}`; card.append(title);
    if (suggestion.before) {
      const before = document.createElement('div'); before.className = 'suggestion-before';
      const label = document.createElement('strong'); label.textContent = 'Before';
      const text = document.createElement('p'); text.textContent = suggestion.before;
      before.append(label, text); card.append(before);
    }
    const after = document.createElement('div'); after.className = 'suggestion-after';
    const afterLabel = document.createElement('strong'); afterLabel.textContent = 'After';
    const afterText = document.createElement('p'); afterText.textContent = suggestion.after || '';
    after.append(afterLabel, afterText); card.append(after);
    if (suggestion.reason) { const reason = document.createElement('p'); reason.className = 'suggestion-reason'; reason.textContent = `Reason: ${suggestion.reason}`; card.append(reason); }
    if (Array.isArray(suggestion.evidence) && suggestion.evidence.length) {
      const evidence = document.createElement('p'); evidence.className = 'suggestion-reason';
      evidence.textContent = `Master Resume evidence: ${suggestion.evidence.join('; ')}`; card.append(evidence);
    }
    const validation = document.createElement('p'); validation.className = 'suggestion-reason';
    validation.textContent = suggestion.validation === 'verified' ? 'Validated against the Master Resume.' : 'Not validated; this edit cannot be applied.';
    card.append(validation);
    const actions = document.createElement('div'); actions.className = 'suggestion-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'suggestion-action'; copy.textContent = 'Copy'; copy.setAttribute('aria-label', `Copy suggestion ${index + 1}`);
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(suggestion.after || ''); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy unavailable'; } });
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'suggestion-action apply'; apply.textContent = 'Apply to resume'; apply.disabled = !suggestion.before || suggestion.validation !== 'verified';
    apply.addEventListener('click', () => {
      const master = $('resumeText').value;
      tailoredWorkingCopy = tailoredWorkingCopy || master;
      if (!suggestion.before || !tailoredWorkingCopy.includes(suggestion.before)) {
        setStatus('The original text was not found in the working copy; no edit was applied.', 'info'); return;
      }
      tailoredWorkingCopy = tailoredWorkingCopy.replace(suggestion.before, suggestion.after || '');
      apply.textContent = 'Applied'; apply.disabled = true;
      setStatus('Suggestion applied to the tailored working copy. Your master resume is unchanged.', 'success');
    });
    actions.append(copy, apply); card.append(actions); container.append(card);
  });
  const cautions = Array.isArray(data.cautions) ? data.cautions : [];
  if (cautions.length) {
    const details = document.createElement('details'); details.className = 'suggestion-cautions';
    const summary = document.createElement('summary'); summary.textContent = 'Check before using'; details.append(summary);
    const list = document.createElement('ul'); cautions.forEach(value => { const li = document.createElement('li'); li.textContent = value; list.append(li); });
    details.append(list); container.append(details);
  }
}


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

  quickOverview = localQuickScore(resumeText, jobDescription);
  renderAnalysis(quickOverview, 'quick');
  aiRefinementFailed = false;
  overviewController?.abort();
  const controller = new AbortController();
  overviewController = controller;
  analysisPromise = (async () => {
    let cacheKey = '';
    let wakingTimer = null;
    try {
      cacheKey = await overviewCacheKey(resumeText, jobDescription);
      const cachedByKey = await chrome.storage.local.get([cacheKey]);
      const cachedEntry = cachedByKey[cacheKey];
      const cachedAge = cachedEntry?.savedAt ? Date.now() - cachedEntry.savedAt : Infinity;
      if (cachedEntry?.overview && hasUsableOverview(cachedEntry.overview)) {
        lastAnalysis = cachedEntry.overview;
        renderAnalysis(lastAnalysis, 'ai');
        if (cachedAge <= 24 * 60 * 60 * 1000) {
          setStatus('Refined by AI (cached result)', 'success');
          return;
        }
      } else if (cachedEntry?.overview) {
        await chrome.storage.local.remove(cacheKey);
      }

      if (!lastAnalysis) setStatus(automatic ? 'Quick estimate ready. Refining with AI…' : 'Refining the quick estimate with AI…', 'info');
      const jobMeta = {
        title: cleanText($('jobTitleInput').value),
        company: cleanText($('companyInput').value),
        location: cleanText($('locationInput').value)
      };
      const resumeProfileResult = await lookupResumeProfile(resumeText);
      if (controller.signal.aborted) return;
      const overviewRequest = {
        resumeProfile: resumeProfileResult?.profile || null,
        resumeHash: resumeProfileResult?.resumeHash || await sha256Hex(cleanText(resumeText)),
        // Keep the original text available to the backend evidence validator even when a cached profile is used.
        resumeText,
        jobDescription,
        jobMeta
      };
      wakingTimer = window.setTimeout(() => setStatus('Waking up the server…', 'info'), 5000);
      const data = await api('/ai/overview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(overviewRequest),
        signal: controller.signal
      });
      window.clearTimeout(wakingTimer);
      wakingTimer = null;
      if (controller.signal.aborted) return;
      if (data.error) throw new Error(data.error);
      const refined = normalizeOverviewResult(data);
      if (!hasUsableOverview(refined)) throw new Error('The backend returned no analyzable job requirements.');
      lastAnalysis = refined;
      aiRefinementFailed = false;
      renderAnalysis(lastAnalysis, 'ai');
      await chrome.storage.local.set({
        [cacheKey]: { overview: lastAnalysis, savedAt: Date.now() },
        activeJobAnalysis: lastAnalysis
      });
      setStatus(lastAnalysis.cached ? 'Refined by AI · backend cache' : 'Refined by AI', 'success');
    } catch (error) {
      if (controller.signal.aborted) return;
      aiRefinementFailed = !lastAnalysis;
      const tailoringOwnsStatus = tailoringRequestInProgress
        || ['TAILORING_IN_PROGRESS', 'TAILORING_FAILED'].includes(activeResumeWorkflow?.status);
      if (lastAnalysis) {
        if (!tailoringOwnsStatus) setStatus('AI refinement unavailable. Showing the last refined result.', 'info');
      } else {
        lastAnalysis = null;
        renderAnalysis(quickOverview, 'quick');
        if (!tailoringOwnsStatus) setStatus('AI refinement unavailable. Retry when the backend is available.', 'error');
      }
    } finally {
      if (typeof wakingTimer !== 'undefined' && wakingTimer) window.clearTimeout(wakingTimer);
      if (overviewController === controller) {
        overviewController = null;
        analysisPromise = null;
        updatePrimaryAction();
      }
    }
  })();
  updatePrimaryAction();
  return analysisPromise;
}

// ------------------------------
// DISPLAY AI ANALYSIS
// ------------------------------

function hasUsableOverview(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.scoringVersion === 'evidence-weighted-v1') {
    return Array.isArray(result.requirements) && result.requirements.length > 0;
  }
  return normalizeScore(result.matchScore) !== null
    || Object.values(result.scores || {}).some(value => normalizeScore(value) !== null);
}

function normalizeOverviewResult(data) {
  if (data?.overview) data = data.overview;
  if (data?.scores && typeof data.scores === 'object') {
    const normalized = {
      ...data,
      scores: Object.fromEntries(['skills', 'experience', 'keywords', 'education']
        .map(key => [key, normalizeScore(data.scores[key])]))
    };
    const evidenceScored = data.scoringVersion === 'evidence-weighted-v1' && data.scoreBreakdown;
    normalized.matchScore = evidenceScored ? normalizeScore(data.matchScore) : matchScoreFromComponents(normalized.scores);
    normalized.matchLevel = evidenceScored ? (data.matchLevel || (normalized.matchScore === null ? 'Not scored' : normalized.matchScore >= 80 ? 'Strong Match' : normalized.matchScore >= 65 ? 'Good Match' : normalized.matchScore >= 40 ? 'Partial Match' : 'Low Match'))
      : normalized.matchScore === null ? 'Not scored' : normalized.matchScore >= 80 ? 'Strong Match' : normalized.matchScore >= 65 ? 'Good Match' : normalized.matchScore >= 40 ? 'Partial Match' : 'Low Match';
    return normalized;
  }
  const rawText = data?.review?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\r\n') || '';
  let old = {};
  try { old = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { old = {}; }
  const scores = {
    skills: normalizeScore(old.skillsMatchScore), experience: normalizeScore(old.experienceMatchScore),
    keywords: normalizeScore(old.keywordMatchScore), education: null
  };
  return {
    scores, matchScore: matchScoreFromComponents(scores), matchLevel: old.matchLevel,
    confidence: 'low', verdict: old.matchSummary || 'Analysis from saved history.', reasons: [],
    matchedSkills: { technical: normalizeAnalysisItems(old.matchedSkills || old.supportedKeywords), soft: [] },
    equivalentSkills: [], missingSkills: normalizeAnalysisItems(old.missingSkills),
    missingKeywords: [], fitChecks: [], experience: { note: 'Older saved analysis did not include experience details.' },
    model: data?.model || 'saved analysis', cached: false
  };
}

function renderAnalysis(data, source = 'ai') {
  const result = normalizeOverviewResult(data);
  const totalScore = result?.matchScore ?? null;
  const quick = source === 'quick';
  const overview = $('matchOverview');
  overview.replaceChildren();

  const header = document.createElement('div');
  header.className = 'match-heading';
  const titleStack = document.createElement('div'); titleStack.className = 'match-title-stack';
  const heading = document.createElement('h2'); heading.textContent = 'Match Analysis';
  const scoreNote = document.createElement('p');
  scoreNote.textContent = `Estimated resume-to-job match · ${String(result.scoreConfidence || result.confidence || 'low').replace(/^./, letter => letter.toUpperCase())} confidence`;
  titleStack.append(heading, scoreNote);
  const state = document.createElement('span'); state.className = `overview-state ${quick ? 'quick' : 'refined'}`;
  state.textContent = quick ? 'Quick estimate' : 'Refined by AI';
  header.append(titleStack, state);
  overview.append(header);

  const layout = document.createElement('div'); layout.className = 'overview-layout';
  const scoreColumn = document.createElement('section'); scoreColumn.className = 'overview-score-side';
  const ring = document.createElement('div'); ring.className = `score-ring-wrap ${quick ? 'quick-score' : ''} ${scoreBand(totalScore)}`;
  ring.setAttribute('role', 'img'); ring.setAttribute('aria-label', totalScore === null ? 'Match score unavailable' : `Match score ${totalScore} percent`);
  ring.innerHTML = '<svg class="score-ring-svg" viewBox="0 0 76 76" aria-hidden="true"><defs><linearGradient id="matchScoreGradient" x1="100%" y1="100%" x2="0%" y2="0%"><stop offset="0%" stop-color="#f15a59"/><stop offset="35%" stop-color="#ff9a45"/><stop offset="65%" stop-color="#f4df62"/><stop offset="100%" stop-color="#9de7e8"/></linearGradient></defs><circle class="score-ring-track" cx="38" cy="38" r="33"/><circle class="score-ring-progress" cx="38" cy="38" r="33"/></svg>';
  const ringValue = document.createElement('strong'); ringValue.className = 'score-ring-value'; ringValue.textContent = totalScore === null ? 'N/A' : `${totalScore}%`;
  const circumference = 2 * Math.PI * 33;
  const ringProgress = ring.querySelector('.score-ring-progress');
  const startingScore = source === 'ai' ? quickOverview?.matchScore || 0 : 0;
  if (ringProgress) {
    ringProgress.style.strokeDasharray = String(circumference);
    ringProgress.style.strokeDashoffset = String(circumference * (1 - startingScore / 100));
  }
  window.requestAnimationFrame(() => { if (ringProgress) ringProgress.style.strokeDashoffset = String(circumference * (1 - ((totalScore ?? 0) / 100))); });
  ring.append(ringValue);
  scoreColumn.append(ring);

  const breakdown = document.createElement('section'); breakdown.className = 'overview-column breakdown-column';
  const breakdownTitle = document.createElement('h3'); breakdownTitle.textContent = 'Match Breakdown'; breakdown.append(breakdownTitle);
  const breakdownLabels = {
    requiredSkills: 'Required skills', relevantExperience: 'Relevant experience',
    projectsResponsibilities: 'Projects & responsibilities', preferredSkills: 'Preferred skills',
    keywords: 'Keywords', educationCertifications: 'Education & certifications'
  };
  const rows = result.scoreBreakdown
    ? Object.entries(breakdownLabels).map(([key, label]) => [label,
      normalizeScore(result.scoreBreakdown[key]?.score),
      `${result.scoreBreakdown[key]?.weight ?? 0}% category weight. Evidence-based requirement score.`])
    : [
      ['Skills', result.scores?.skills, 'Explicit technical requirements supported by the resume.'],
      ['Keywords', result.scores?.keywords, 'Required job terms found in the resume.']
    ];
  const metrics = document.createElement('div'); metrics.className = 'component-scores';
  rows.forEach(([label, value, reason]) => {
    const row = document.createElement('div'); row.className = `component-score ${scoreBand(value)}`; row.title = value === null || value === undefined ? reason : `${label}: ${value}%`;
    const top = document.createElement('div'); top.className = 'component-score-label';
    const name = document.createElement('span'); name.textContent = label;
    const amount = document.createElement('strong'); amount.textContent = value === null || value === undefined ? 'N/A' : `${value}%`;
    top.append(name, amount);
    const track = document.createElement('div'); track.className = 'component-track';
    const bar = document.createElement('span'); bar.className = 'component-fill'; bar.style.width = value === null || value === undefined ? '0%' : `${value}%`;
    if (value === null || value === undefined) track.setAttribute('aria-label', reason);
    else { track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', String(value)); track.setAttribute('aria-label', `${label} ${value}%`); }
    track.append(bar); row.append(top, track); metrics.append(row);
  });
  breakdown.append(metrics);

  layout.append(scoreColumn, breakdown);
  overview.append(layout);

  $('aiAssessment').textContent = result.verdict || 'No overall assessment was returned.';
  renderAtsAssessment(result.atsAssessment);
  renderImprovementAreas(result);
  renderFitChecks(result.fitChecks || []);
  renderSkillBreakdown(result);
  updateActionBar();
  if (!quick && activeResumeWorkflow && !['MASTER_RESUME_SELECTED', 'TAILORED_RESUME_GENERATED', 'WAITING_FOR_PROFILE_UPLOAD', 'TEMPORARY_RESUME_UPLOADED', 'MASTER_RESUME_UPLOADED', 'APPLICATION_IN_PROGRESS', 'APPLICATION_SUBMITTED', 'RESTORATION_PENDING', 'MASTER_RESUME_RESTORED', 'RESTORATION_FAILED', 'APPLICATION_CANCELLED', 'TAILORING_REVIEW', 'TAILORING_IN_PROGRESS'].includes(activeResumeWorkflow.status)) {
    void persistResumeWorkflow({ ...activeResumeWorkflow, status: 'JD_ANALYZED', matchScore: result.matchScore, analysisAt: new Date().toISOString() });
  } else {
    renderResumeWorkflow();
  }
}

function renderAtsAssessment(assessment) {
  const root = $('atsAssessment');
  root.replaceChildren();
  const entries = [
    ['Job match', assessment?.jobMatchScore],
    ['Keyword coverage', assessment?.keywordCoverageScore],
    ['ATS readability', assessment?.atsReadabilityScore],
    ['Project relevance', assessment?.projectRelevanceScore]
  ];
  entries.forEach(([label, score]) => {
    const row = document.createElement('div'); row.className = 'ats-assessment-row';
    const value = document.createElement('strong'); value.textContent = score === null || score === undefined || score === '' ? 'N/A' : `${score}%`;
    const name = document.createElement('span'); name.textContent = label;
    row.append(value, name); root.append(row);
  });
  $('atsAssessmentNote').textContent = assessment?.label || 'Internal estimates only; no employer ATS score or hiring result is guaranteed.';
  if (assessment?.readabilityNote) $('atsAssessmentNote').title = assessment.readabilityNote;
}

function scoreBand(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'score-neutral';
  const numericScore = Number(value);
  if (numericScore < 40) return 'score-low';
  if (numericScore < 65) return 'score-partial';
  if (numericScore < 80) return 'score-good';
  return 'score-strong';
}

function renderFitChecks(items) {
  const list = $('fitChecksList');
  list.replaceChildren();
  items = Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [];
  if (!items.length) {
    const empty = document.createElement('p'); empty.className = 'fit-check-empty';
    empty.textContent = 'Fit checks will appear when the analysis includes eligibility details.';
    list.append(empty);
    return;
  }
  items.forEach(item => {
    const candidate = item.candidate || '';
    const required = item.required || '';
    const hasCandidate = hasFitValue(candidate);
    const hasRequired = hasFitValue(required);
    const rawStatus = ['ok', 'warn', 'gap'].includes(item.status) ? item.status : 'warn';
    const status = !hasCandidate || !hasRequired ? 'unspecified' : rawStatus;
    const row = document.createElement('article'); row.className = `fit-check-row ${status}`;
    const icon = document.createElement('span'); icon.className = 'fit-status-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = status === 'ok' ? '✓' : status === 'gap' ? '×' : status === 'warn' ? '!' : '–';
    const body = document.createElement('div'); body.className = 'fit-check-copy';
    const title = document.createElement('h3');
    title.textContent = ({ location: 'Location', workMode: 'Work Mode', education: 'Education', experience: 'Experience', noticePeriod: 'Notice Period', employmentType: 'Employment Type', seniority: 'Seniority', certification: 'Certification', workAuthorization: 'Work Authorization', industry: 'Industry' })[item.type] || item.type || 'Eligibility';
    const candidateLine = document.createElement('p');
    const candidateLabel = document.createElement('strong'); candidateLabel.textContent = 'Resume: ';
    candidateLine.append(candidateLabel, document.createTextNode(hasCandidate ? candidate : 'Not specified'));
    const requiredLine = document.createElement('p');
    const requiredLabel = document.createElement('strong'); requiredLabel.textContent = 'Job requirement: ';
    requiredLine.append(requiredLabel, document.createTextNode(hasRequired ? required : 'Not specified'));
    const note = document.createElement('p'); note.className = 'fit-result-note';
    note.textContent = !hasCandidate || !hasRequired ? 'Insufficient information'
      : item.note || ({ ok: 'Match', gap: 'Does not match', warn: 'Review required' })[rawStatus];
    body.append(title, candidateLine, requiredLine, note); row.append(icon, body); list.append(row);
  });
}

function hasFitValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Boolean(normalized) && !['not specified', 'n/a', 'na', 'unknown', 'none', 'null'].includes(normalized);
}

function renderImprovementAreas(result) {
  const list = $('areasToImproveList'); list.replaceChildren();
  const missing = normalizeAnalysisItems(result.missingSkills);
  const keywords = meaningfulMissingKeywords(result.missingKeywords, missing);
  const items = [...new Set([...missing, ...keywords])].slice(0, 5);
  if (!items.length) {
    const empty = document.createElement('li'); empty.className = 'insight-empty';
    empty.textContent = 'No specific improvement areas were returned.';
    list.append(empty);
    return;
  }
  items.forEach(value => {
    const item = document.createElement('li');
    item.textContent = `Consider highlighting evidence of ${value} if it reflects your experience.`;
    list.append(item);
  });
}

function renderSkillBreakdown(result) {
  const matched = result.matchedSkills || {};
  const tech = cleanSkillLabels(matched.technical);
  const soft = cleanSkillLabels(matched.soft);
  $('matchedSkillsHeading').textContent = `Matched Skills (${tech.length})`;
  renderChipList($('matchedSkillsList'), tech, 'matched', 'No direct technical skills matched.');
  renderChipList($('softSkillsList'), soft, 'soft');
  $('softSkillSummary').textContent = `+${soft.length} soft skill${soft.length === 1 ? '' : 's'}`;
  $('softSkillsDetails').classList.toggle('hidden', !soft.length);
  const equivalents = (Array.isArray(result.equivalentSkills) ? result.equivalentSkills : [])
    .filter(item => item && typeof item === 'object')
    .map(item => [item.required, item.evidence].filter(Boolean).join(' — '))
    .filter(Boolean);
  $('equivalentSkillsGroup').classList.toggle('hidden', !equivalents.length);
  renderChipList($('equivalentSkillsList'), equivalents, 'equivalent');
  const missing = cleanSkillLabels(result.missingSkills);
  $('missingSkillsHeading').textContent = `Missing Skills (${missing.length})`;
  if (missing.length) renderChipList($('missingSkillsList'), missing, 'missing');
  else renderChipList($('missingSkillsList'), [], 'empty', 'No important missing technical skills identified.');
  const keywords = meaningfulMissingKeywords(result.missingKeywords, missing);
  $('relatedKeywordsGroup').classList.toggle('hidden', !keywords.length);
  $('relatedKeywordsHeading').textContent = `Related Keywords (${keywords.length})`;
  renderChipList($('missingKeywordsList'), keywords, 'keyword');
  renderRequirementEvidence((result.requirements || []).filter(item => item?.name && !isNonSkillLabel(item.name)));

  // Populate Naukri Recruiter Visibility Booster
  const allJobSkills = [...tech, ...missing];
  if (Array.isArray(jobMetadata?.pageKeySkills) && jobMetadata.pageKeySkills.length) {
    jobMetadata.pageKeySkills.forEach(k => {
      if (!allJobSkills.some(s => s.toLowerCase() === k.toLowerCase())) allJobSkills.push(k);
    });
  }
  const skillsString = allJobSkills.slice(0, 30).join(', ');
  const headlineRole = cleanText($('jobTitleInput')?.value) || 'Software Engineer';
  const top4Skills = allJobSkills.slice(0, 4).join(', ');
  const expTag = jobMetadata?.experience || 'Experienced';
  const recommendedHeadline = `${headlineRole} | ${top4Skills || 'Key Skills'} | ${expTag} | Immediate Joiner`;

  const headlineInput = $('naukriHeadlineInput');
  const skillsArea = $('naukriSkillsTextarea');
  if (headlineInput) headlineInput.value = recommendedHeadline;
  if (skillsArea) skillsArea.value = skillsString;
}

function cleanSkillLabels(values) {
  return [...new Set(normalizeAnalysisItems(values).filter(value => !isNonSkillLabel(value)))];
}

function isNonSkillLabel(value) {
  const words = String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every(word => NON_SKILL_LABELS.has(word));
}

function renderRequirementEvidence(requirements) {
  const root = $('matchEvidenceList');
  root.replaceChildren();
  const checked = requirements.filter(item => item?.name).slice(0, 30);
  const details = document.createElement('details'); details.className = 'match-evidence';
  const summary = document.createElement('summary'); summary.textContent = `Requirement evidence (${checked.length})`;
  details.append(summary);
  const list = document.createElement('ul');
  checked.forEach(item => {
    const row = document.createElement('li');
    const classification = String(item.classification || 'UNKNOWN').replaceAll('_', ' ').toLowerCase();
    const importance = String(item.importance || item.category || 'requirement').replaceAll('_', ' ').toLowerCase();
    const title = document.createElement('strong'); title.textContent = `${item.name} - ${classification} - ${importance}`;
    const source = document.createElement('span'); source.textContent = item.evidenceSection || 'Resume evidence';
    const evidence = document.createElement('p'); evidence.textContent = item.evidence ? `Resume evidence: "${item.evidence}"` : 'No supporting resume evidence found.';
    row.append(title, source, evidence); list.append(row);
  });
  if (!checked.length) { const empty = document.createElement('li'); empty.textContent = 'No structured job requirements were returned.'; list.append(empty); }
  details.append(list); root.append(details);
}

function renderChipList(list, values, tone, emptyText = 'None found') {
  list.replaceChildren();
  if (!values.length) {
    if (!emptyText) return;
    const item = document.createElement('li'); item.className = `skill-empty ${tone === 'matched' ? 'matched-empty' : ''}`; item.textContent = emptyText; list.append(item); return;
  }
  values.forEach(value => { const item = document.createElement('li'); item.className = `skill-chip ${tone}`; item.textContent = value; list.append(item); });
}

function meaningfulMissingKeywords(values, missingSkills = []) {
  const excluded = new Set(['leading', 'digital', 'agency', 'quality', 'lucrative', 'result', 'results', 'experience', 'required', 'preferred', 'candidate', 'candidates', 'years', 'year', 'ability', 'strong', 'excellent', 'including', 'working', 'knowledge', 'skills', 'responsibilities', 'qualification', 'qualifications']);
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();
  const includesPhrase = (text, phrase) => (` ${text} `).includes(` ${phrase} `);
  const missing = missingSkills.map(normalize).filter(Boolean);
  return [...new Set(cleanSkillLabels(values).filter(value => {
    const keyword = normalize(value);
    return keyword && !excluded.has(keyword) && !missing.some(skill => includesPhrase(skill, keyword) || includesPhrase(keyword, skill));
  }))].slice(0, 8);
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function renderAnalysisPlaceholders(stateLabel = 'Analysis pending') {
  const overview = $('matchOverview');
  overview.replaceChildren();
  const header = document.createElement('div');
  header.className = 'match-heading';
  const titleStack = document.createElement('div'); titleStack.className = 'match-title-stack';
  const heading = document.createElement('h2');
  heading.textContent = 'Match Analysis';
  titleStack.append(heading);
  const state = document.createElement('span'); state.className = 'overview-state quick';
  state.textContent = stateLabel;
  header.append(titleStack, state);
  overview.append(header);
  $('aiAssessment').textContent = '';
  renderFitChecks([]);
  renderImprovementAreas({ missingSkills: [], missingKeywords: [] });
  ['matchedSkillsList', 'softSkillsList', 'equivalentSkillsList', 'missingSkillsList', 'missingKeywordsList'].forEach(id => $(id).replaceChildren());
  $('matchEvidenceList').replaceChildren();
  $('matchedSkillsHeading').textContent = 'Matched Skills (0)';
  $('missingSkillsHeading').textContent = 'Missing Skills (0)';
  $('relatedKeywordsGroup').classList.add('hidden');
  $('equivalentSkillsGroup').classList.add('hidden');
  $('softSkillsDetails').classList.add('hidden');
  $('suggestionsSummaryHint').textContent = 'Open to load';
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

// ------------------------------
function localPipelineFilename(fullName, masterText) {
  const source = fullName?.trim() || masterText.split(/\r?\r\n/).find(line => line.trim()) || 'Candidate';
  const firstPart = safeFilenamePart(source.split(/\s+/)[0]).replace(/_/g, '') || 'Candidate';
  const today = new Date();
  const date = [String(today.getDate()).padStart(2, '0'), String(today.getMonth() + 1).padStart(2, '0'), today.getFullYear()].join('-');
  return `${firstPart}_${date}.docx`;
}

async function generateResumeStep(job) {
  const masterText = $('resumeText').value.trim();
  const saved = await chrome.storage.local.get(['fullName']);
  const fullName = saved.fullName || $('fullNameInput').value.trim() || masterText.split(/\r?\r\n/).find(line => line.trim()) || '';
  const master = await readResumeFile('master');
  if (!master?.file || !/\.docx$/i.test(master.name || resumeFileName || '')) {
    throw new Error('To preserve your original design, store the Master Resume as its original DOCX before tailoring. PDF and pasted text cannot be safely edited in place.');
  }
  const requestBody = { resumeText: tailoredWorkingCopy || masterText, jobDescription: $('jobDescription').value.trim(), fullName, confirmedFacts: confirmedCandidateFacts({ positiveOnly: true }) };
  if (/\.docx$/i.test(master?.name || resumeFileName) && master?.file) {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(master.file); });
    requestBody.masterDocxBase64 = dataUrl;
    requestBody.templateEdits = approvedTailoringEdits.map(edit => ({
      before: edit.before, after: edit.after, section: edit.section,
      relatedRequirement: edit.relatedRequirement, evidence: edit.evidence,
      safeToApply: edit.safeToApply === true && edit.validation === 'verified'
    }));
  }
  const response = await fetch(`${apiBase}/ai/tailor-docx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
  if (!response.ok) throw new Error(await responseError(response));
  if (response.headers.get('X-Resume-Validation-Status') !== 'passed') {
    throw new Error('The backend did not validate the generated DOCX. Deploy the current backend before tailoring resumes.');
  }
  const blob = await response.blob();
  return { blob, filename: localPipelineFilename(fullName, masterText), formatNote: response.headers.get('X-Resume-Format-Note') || '', validationNote: response.headers.get('X-Resume-Validation-Note') || '' };
}

$('generateBtn').addEventListener('click', () => { void handleTailorAction(true); });
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

// Wire up Naukri Visibility Booster buttons
$('copyHeadlineBtn')?.addEventListener('click', async () => {
  const text = $('naukriHeadlineInput')?.value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('Headline copied to clipboard! Paste it into your Naukri profile headline.', 'success');
});
$('copySkillsBtn')?.addEventListener('click', async () => {
  const text = $('naukriSkillsTextarea')?.value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('Skills copied to clipboard! Paste them into your Naukri Key Skills box.', 'success');
});
$('openNaukriSkillsEditBtn')?.addEventListener('click', async () => {
  const site = await detectNaukriSite();
  const config = NAUKRI_CONFIG[site] || NAUKRI_CONFIG.main;
  await chrome.tabs.create({ url: `${config.profileUrl}#keySkills`, active: true });
});
$('naukriHeadlineInput')?.addEventListener('click', async () => {
  const text = $('naukriHeadlineInput')?.value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('Headline copied to clipboard!', 'success');
});
$('naukriSkillsTextarea')?.addEventListener('click', async () => {
  const text = $('naukriSkillsTextarea')?.value;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('Skills copied to clipboard!', 'success');
});

renderAnalysisPlaceholders();
loadSettings().catch(error => {
  setStatus(
    `Initialization failed: ${error.message}`,
    'error'
  );
});
