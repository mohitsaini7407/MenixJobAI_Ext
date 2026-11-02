
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
let overviewController = null;
let quickOverview = null;
let aiRefinementFailed = false;
let suggestionData = null;
let suggestionRequestPromise = null;
let suggestionController = null;
let tailoredWorkingCopy = '';

// Wake Render as soon as the extension document opens; this is intentionally fire-and-forget.
void fetch(`${DEFAULT_API}/health`).catch(() => {});
let resumePipelineRunning = false;
let pipelineRetryContext = null;
let pipelineLastState = null;
let restoreMonitorTimer = null;
let lastUploadedResumeHash = '';
const NAUKRI_SELECTORS = {
  resumeInputs: ['#attachCV', 'input[type="file"][name*="resume" i]', '.resume input[type="file"]', '[class*="resume" i] input[type="file"]', '[data-testid*="resume" i] input[type="file"]'],
  successText: ['resume uploaded', 'resume updated', 'successfully uploaded', 'updated successfully', 'resume has been uploaded']
};
const resumeProfileLookups = new Map();

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
const TECH_SKILL_GROUPS = `javascript|js;typescript|ts;python;java;c++;c#|c sharp;go language|golang;rust;php;ruby;kotlin;swift;scala;objective-c;dart;elixir;clojure;haskell;sql;html;css;sass;less;react|react.js|reactjs;angular;vue|vue.js;next.js|nextjs;nuxt; svelte;node.js|nodejs|node;express|express.js;nestjs;django;flask;fastapi;spring boot|spring;asp.net|.net;laravel;rails;graphql;rest api;grpc;websocket;redux;zustand;tailwind css|tailwind;bootstrap;webpack;vite;babel;jest;vitest;cypress;playwright;selenium;git;github;gitlab;docker;kubernetes|k8s;helm;terraform;ansible;jenkins;github actions;circleci;linux;bash;powershell;aws;azure;google cloud|gcp;cloud computing;serverless;lambda;ec2;s3;cloudfront;postgresql|postgres;mysql;mariadb;sqlite;mongodb|mongo;redis;elasticsearch;opensearch;cassandra;dynamodb;oracle database;sql server;neo4j;firebase;supabase;prisma;hibernate;jpa;apache kafka|kafka;rabbitmq;spark;apache spark;hadoop;airflow;dbt;etl;data warehousing;machine learning|ml;deep learning;natural language processing|nlp;computer vision;tensorflow;pytorch;scikit-learn|sklearn;pandas;numpy;opencv;generative ai;llm|large language model;prompt engineering;data analysis;data science;power bi;tableau;excel;looker;figma;agile;scrum;microservices;distributed systems;system design;api design;oauth;jwt;cybersecurity;penetration testing;unit testing;integration testing;test automation;accessibility;seo;wordpress;shopify;android;ios;react native;flutter;unity;unreal engine;blockchain;solidity;web3;networking;tcp/ip;dns;load balancing;nginx;apache;prometheus;grafana;datadog;open telemetry|opentelemetry;feature flags;content management system|cms;customer relationship management|crm;product analytics;financial modeling;investment analysis;portfolio management;business intelligence|bi;data visualization;requirements analysis;technical writing;project management;program management;product management;quality assurance|qa;software testing;computer science;object-oriented programming|oop;functional programming;design patterns;data structures;algorithms;data modeling;database design;data engineering;business development;advisory services;venture capital;private equity;financial services`.split(';').map(group => group.trim().split('|').map(alias => alias.trim())).filter(group => group[0]);

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
  const resume = ` ${cleanText(resumeText).toLowerCase()} `;
  const job = ` ${cleanText(jobDescription).toLowerCase()} `;
  const requiredSkills = TECH_SKILL_GROUPS.filter(group => group.some(alias => containsTerm(job, alias)));
  const matchedGroups = requiredSkills.filter(group => group.some(alias => containsTerm(resume, alias)));
  const matchedTechnical = matchedGroups.map(group => group[0]);
  const missingTechnical = requiredSkills.filter(group => !matchedGroups.includes(group)).map(group => group[0]);
  const keywords = [...new Set((cleanText(jobDescription).toLowerCase().match(/[a-z][a-z0-9+#.]{3,}/g) || []))]
    .filter(word => !new Set(['experience', 'required', 'preferred', 'candidate', 'candidates', 'years', 'year', 'ability', 'strong', 'excellent', 'including', 'working', 'knowledge', 'skills', 'responsibilities', 'qualification', 'qualifications']).has(word))
    .filter(word => !TECH_SKILL_GROUPS.some(group => group.some(alias => containsTerm(` ${word} `, alias))))
    .slice(0, 24);
  const matchedKeywords = keywords.filter(word => containsTerm(resume, word));
  const missingKeywords = keywords.filter(word => !containsTerm(resume, word)).slice(0, 8);
  const softTerms = ['communication', 'leadership', 'teamwork', 'problem solving', 'collaboration', 'adaptability', 'mentoring', 'critical thinking', 'time management'];
  const matchedSoft = softTerms.filter(term => containsTerm(job, term) && containsTerm(resume, term));
  const requiredYears = jobDescription.match(/\b(?:minimum|min\.?|at least)?\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\b/i)
    || jobDescription.match(/\b(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience\b/i);
  const candidateYears = resumeText.match(/\b(\d+(?:\.\d+)?)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience\b/i);
  const degreeRequired = /\b(?:bachelor|b\.?tech|b\.?e\.?|b\.?s\.?|master|m\.?tech|m\.?s\.?|ph\.?d|degree)\b/i.test(jobDescription);
  const degreeCandidate = cleanText(resumeText).match(/\b(?:B\.?Tech(?:nology)?|B\.?E\.?|B\.?Sc\.?|M\.?Tech(?:nology)?|M\.?E\.?|M\.?Sc\.?|M\.?B\.?A\.?|Ph\.?D|Bachelor(?:'s)?|Master(?:'s)?)\b[^\n,;]*/i);
  let experienceScore = null;
  if (requiredYears && candidateYears) {
    const minYears = Number(requiredYears[1]);
    experienceScore = minYears > 0 ? Math.min(100, Math.round(Number(candidateYears[1]) / minYears * 100)) : 100;
  }
  const educationScore = !degreeRequired ? null : degreeCandidate ? (containsTerm(job, 'related') || containsTerm(job, 'equivalent') ? 80 : 70) : 0;
  const scores = {
    skills: requiredSkills.length ? Math.round(matchedGroups.length / requiredSkills.length * 100) : null,
    experience: experienceScore,
    keywords: keywords.length ? Math.round(matchedKeywords.length / keywords.length * 100) : null,
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
    matchedSkills: { technical: matchedTechnical, soft: matchedSoft },
    equivalentSkills: [],
    missingSkills: missingTechnical,
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
  return `matchOverview:${await digestText(`${resumeHash}\n${normalizedJob}\ngemini-2.5-flash\noverview-v2`)}`;
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
  overviewController?.abort();
  overviewController = null;
  analysisPromise = null;
  quickOverview = null;
  aiRefinementFailed = false;
  suggestionData = null;
  suggestionController?.abort();
  suggestionController = null;
  suggestionRequestPromise = null;
  tailoredWorkingCopy = '';
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
  if (resumePipelineRunning) {
    button.disabled = true;
    button.textContent = `Working… (${pipelineLastState?.step || 1}/5)`;
    return;
  }
  if (pipelineLastState?.state === 'failed') {
    button.disabled = false;
    button.textContent = `Retry step ${pipelineLastState.step}`;
    return;
  }
  if (pipelineLastState?.state === 'done' && pipelineLastState.step === 5) {
    button.disabled = false;
    button.textContent = 'Done. Download again';
    return;
  }
  if (analysisPromise && !lastAnalysis) {
    button.disabled = true;
    button.textContent = 'Refining with AI…';
  } else if (analysisPromise && lastAnalysis) {
    button.disabled = false;
    button.textContent = '↓  Download Tailored Resume (DOCX)';
  } else if (aiRefinementFailed && !lastAnalysis) {
    button.disabled = false;
    button.textContent = 'Retry AI refinement';
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
    ,'fullName','autoUploadToNaukri','restoreMasterAfterApply'
  ]);

  apiBase = saved.apiBase || DEFAULT_API;

  $('apiBase').value = apiBase;
    $('fullNameInput').value = saved.fullName || '';
  $('autoUploadSetting').checked = saved.autoUploadToNaukri !== false;
  $('restoreMasterSetting').checked = saved.restoreMasterAfterApply === true;
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

$('aiSuggestionsDetails').addEventListener('toggle', () => {
  if ($('aiSuggestionsDetails').open && !suggestionData) void loadAiSuggestions();
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
}

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
$('retryPipelineBtn').addEventListener('click', () => {
  if (!pipelineRetryContext || resumePipelineRunning) return;
  runResumePipeline(pipelineRetryContext.job, pipelineRetryContext.startStep, pipelineRetryContext.file).catch(error => setStatus(error.message, 'error'));
});
$('restoreMasterBtn').addEventListener('click', async () => {
  if (resumePipelineRunning) return;
  const master = await readResumeFile('master');
  if (!master?.file) return setStatus('Master resume file is not available. Upload it again to restore.', 'error');
  await runResumePipeline(currentJobPayload(), 3, { id: 'master', filename: master.name || resumeFileName || 'MasterResume.docx', blob: master.file, restore: true });
});
$('autoUploadSetting').addEventListener('change', () => chrome.storage.local.set({ autoUploadToNaukri: $('autoUploadSetting').checked }));
$('restoreMasterSetting').addEventListener('change', () => chrome.storage.local.set({ restoreMasterAfterApply: $('restoreMasterSetting').checked }));

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
      apiBase,
      fullName: $('fullNameInput').value.trim(),
      autoUploadToNaukri: $('autoUploadSetting').checked,
      restoreMasterAfterApply: $('restoreMasterSetting').checked
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
    void lookupResumeProfile(data.text || '');

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
    void lookupResumeProfile(text);

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

async function loadAiSuggestions() {
  if (suggestionRequestPromise) return suggestionRequestPromise;
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
      const data = await api('/ai/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeText,
          resumeProfile: resumeProfileResult?.profile || null,
          resumeHash: resumeProfileResult?.resumeHash || await sha256Hex(cleanText(resumeText)),
          jobDescription,
          workingResume: tailoredWorkingCopy || resumeText,
          jobMeta: { title: cleanText($('jobTitleInput').value), company: cleanText($('companyInput').value), location: cleanText($('locationInput').value) }
        }),
        signal: controller.signal
      });
      if (controller.signal.aborted) return;
      suggestionData = data;
      renderAiSuggestions(data);
      $('suggestionsSummaryHint').textContent = data.cached ? 'Cached edits' : `${(data.suggestions || []).length} edits`;
    } catch (error) {
      if (controller.signal.aborted) return;
      container.replaceChildren();
      const message = document.createElement('p'); message.className = 'suggestions-error'; message.textContent = 'AI suggestions could not load.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'suggestion-action'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => { suggestionData = null; void loadAiSuggestions(); });
      container.append(message, retry);
      $('suggestionsSummaryHint').textContent = 'Unavailable';
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
    const actions = document.createElement('div'); actions.className = 'suggestion-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'suggestion-action'; copy.textContent = 'Copy'; copy.setAttribute('aria-label', `Copy suggestion ${index + 1}`);
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(suggestion.after || ''); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy unavailable'; } });
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'suggestion-action apply'; apply.textContent = 'Apply to resume'; apply.disabled = !suggestion.before;
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
      if (cachedEntry?.overview) {
        lastAnalysis = cachedEntry.overview;
        renderAnalysis(lastAnalysis, 'ai');
        if (cachedAge <= 24 * 60 * 60 * 1000) {
          setStatus('Refined by AI · cached result', 'success');
          return;
        }
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
        jobDescription,
        jobMeta
      };
      if (!resumeProfileResult?.profile) overviewRequest.resumeText = resumeText;
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
      lastAnalysis = normalizeOverviewResult(data);
      aiRefinementFailed = false;
      renderAnalysis(lastAnalysis, 'ai');
      await chrome.storage.local.set({ [cacheKey]: { overview: lastAnalysis, savedAt: Date.now() } });
      try {
        await saveAnalysisHistory({ overview: lastAnalysis, review: lastAnalysis, model: lastAnalysis.model, notice: '' });
      } catch (error) {
        console.warn('The analysis result could not be added to history:', error.message);
      }
      setStatus(lastAnalysis.cached ? 'Refined by AI · backend cache' : 'Refined by AI', 'success');
    } catch (error) {
      if (controller.signal.aborted) return;
      aiRefinementFailed = !lastAnalysis;
      if (lastAnalysis) {
        setStatus('AI refinement unavailable. Showing the last refined result.', 'info');
      } else {
        lastAnalysis = null;
        renderAnalysis(quickOverview, 'quick');
        setStatus('AI refinement unavailable. Retry when the backend is available.', 'error');
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

function normalizeOverviewResult(data) {
  if (data?.overview) data = data.overview;
  if (data?.scores && typeof data.scores === 'object') {
    const normalized = { ...data, scores: { ...data.scores } };
    normalized.matchScore = matchScoreFromComponents(normalized.scores);
    normalized.matchLevel = normalized.matchScore === null ? 'Not scored' : normalized.matchScore >= 80 ? 'Strong Match' : normalized.matchScore >= 65 ? 'Good Match' : normalized.matchScore >= 40 ? 'Partial Match' : 'Low Match';
    return normalized;
  }
  const rawText = data?.review?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n') || '';
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
  const score = result.matchScore;
  const quick = source === 'quick';
  const overview = $('matchOverview');
  overview.replaceChildren();

  const header = document.createElement('div');
  header.className = 'match-heading';
  const heading = document.createElement('h3'); heading.textContent = 'Match Overview';
  const state = document.createElement('span'); state.className = `overview-state ${quick ? 'quick' : 'refined'}`;
  state.textContent = quick ? 'Quick estimate' : 'Refined by AI';
  header.append(heading, state);
  overview.append(header);

  const layout = document.createElement('div'); layout.className = 'overview-layout';
  const ring = document.createElement('div'); ring.className = `score-ring-wrap ${quick ? 'quick-score' : ''}`;
  ring.setAttribute('role', 'img'); ring.setAttribute('aria-label', score === null ? 'Match score unavailable' : `Match score ${score} percent`);
  ring.innerHTML = '<svg class="score-ring-svg" viewBox="0 0 92 92" aria-hidden="true"><circle class="score-ring-track" cx="46" cy="46" r="41"/><circle class="score-ring-progress" cx="46" cy="46" r="41"/></svg>';
  const ringValue = document.createElement('strong'); ringValue.className = 'score-ring-value'; ringValue.textContent = score === null ? 'N/A' : `${score}%`;
  const circumference = 2 * Math.PI * 41;
  const ringProgress = ring.querySelector('.score-ring-progress');
  const startingScore = source === 'ai' ? quickOverview?.matchScore || 0 : 0;
  if (ringProgress) ringProgress.style.strokeDashoffset = String(circumference * (1 - startingScore / 100));
  window.requestAnimationFrame(() => { if (ringProgress) ringProgress.style.strokeDashoffset = String(circumference * (1 - (score ?? 0) / 100)); });
  ring.append(ringValue);

  const right = document.createElement('div'); right.className = 'overview-details';
  const level = document.createElement('div'); level.className = `overview-level ${score !== null && score >= 65 ? 'good' : 'caution'}`; level.textContent = result.matchLevel || 'Not scored'; right.append(level);
  const rows = [
    ['Skills', result.scores?.skills, 'Explicit technical requirements supported by the resume.'],
    ['Experience', result.scores?.experience, result.experience?.note || 'The job description does not provide enough experience information.'],
    ['Keywords', result.scores?.keywords, 'Required job terms found in the resume.'],
    ['Education', result.scores?.education, 'The job description does not specify an education requirement.']
  ];
  const metrics = document.createElement('div'); metrics.className = 'component-scores';
  rows.forEach(([label, value, reason]) => {
    const row = document.createElement('div'); row.className = 'component-score'; row.title = value === null || value === undefined ? reason : `${label}: ${value}%`;
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
  right.append(metrics);
  layout.append(ring, right); overview.append(layout);

  if (result.verdict) { const verdict = document.createElement('p'); verdict.className = 'overview-verdict'; verdict.textContent = result.verdict; overview.append(verdict); }
  if (Array.isArray(result.reasons) && result.reasons.length) {
    const reasons = document.createElement('ul'); reasons.className = 'overview-reasons';
    result.reasons.slice(0, 3).forEach(item => { const li = document.createElement('li'); li.textContent = item; reasons.append(li); });
    overview.append(reasons);
  }
  if (result.confidence) { const confidence = document.createElement('p'); confidence.className = 'confidence-note'; confidence.textContent = `Confidence: ${result.confidence}`; overview.append(confidence); }
  renderFitChecks(result.fitChecks || []);
  renderSkillBreakdown(result);
  updateActionBar();
}

function renderFitChecks(items) {
  const card = $('fitChecksCard'); const list = $('fitChecksList');
  list.replaceChildren();
  if (!items.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  items.forEach(item => {
    const row = document.createElement('div'); row.className = 'fit-check-row';
    row.setAttribute('role', 'group'); row.setAttribute('aria-label', `${item.type || 'Requirement'} ${item.status || 'warn'}`);
    const dot = document.createElement('span'); dot.className = `fit-dot ${['ok', 'warn', 'gap'].includes(item.status) ? item.status : 'warn'}`; dot.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div'); body.className = 'fit-check-copy';
    const title = document.createElement('strong'); title.textContent = item.type || 'Requirement';
    const detail = document.createElement('span'); detail.textContent = [item.note, item.required && `Required: ${item.required}`, item.candidate && `Resume: ${item.candidate}`].filter(Boolean).join(' · ');
    body.append(title, detail); row.append(dot, body); list.append(row);
  });
}

function renderSkillBreakdown(result) {
  const matched = result.matchedSkills || {};
  const tech = Array.isArray(matched.technical) ? matched.technical : [];
  const soft = Array.isArray(matched.soft) ? matched.soft : [];
  renderChipList($('matchedSkillsList'), tech, 'matched');
  renderChipList($('softSkillsList'), soft, 'soft');
  $('softSkillSummary').textContent = `+${soft.length} soft skill${soft.length === 1 ? '' : 's'}`;
  $('softSkillsDetails').classList.toggle('hidden', !soft.length);
  renderChipList($('equivalentSkillsList'), (result.equivalentSkills || []).map(item => `${item.required} → ${item.evidence}`), 'equivalent');
  const missing = result.missingSkills || [];
  $('missingSkillsHeading').textContent = `Missing technical skills (${missing.length})`;
  renderChipList($('missingSkillsList'), missing, missing.length ? 'missing' : 'none', 'None found');
  renderChipList($('missingKeywordsList'), result.missingKeywords || [], 'keyword', 'None found');
  $('matchedSkillsHeading').textContent = `Matched technical skills (${tech.length})`;
}

function renderChipList(list, values, tone, emptyText = 'None found') {
  list.replaceChildren();
  if (!values.length) {
    const item = document.createElement('li'); item.className = `skill-chip ${tone === 'none' ? 'none' : 'empty'}`; item.textContent = emptyText; list.append(item); return;
  }
  values.forEach(value => { const item = document.createElement('li'); item.className = `skill-chip ${tone}`; item.textContent = value; list.append(item); });
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
  const state = document.createElement('span'); state.className = 'overview-state quick';
  state.textContent = stateLabel;
  header.append(heading, state);
  const hint = document.createElement('p'); hint.className = 'overview-verdict';
  hint.textContent = 'A quick estimate appears when a job and resume are available.';
  overview.append(header, hint);
  $('fitChecksCard').classList.add('hidden');
  ['matchedSkillsList', 'softSkillsList', 'equivalentSkillsList', 'missingSkillsList', 'missingKeywordsList'].forEach(id => $(id).replaceChildren());
  $('matchedSkillsHeading').textContent = 'Matched technical skills';
  $('missingSkillsHeading').textContent = 'Missing technical skills';
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
// One-job resume pipeline. Uploading only populates Naukri's resume file input;
// this extension never submits an application or presses an upload/save button.
function setPipelineStep(step, state) {
  const row = document.querySelector(`[data-pipeline-step="${step}"]`);
  if (row) { row.dataset.state = state; row.setAttribute('aria-current', state === 'running' ? 'step' : 'false'); }
  pipelineLastState = { step, state };
  $('generateBtn').textContent = state === 'running' ? `Working… (${step}/5)` : state === 'done' && step === 5 ? 'Done. Download again' : `Working… (${step}/5)`;
}

function resetPipelineStepper() {
  $('pipelineStepper').classList.remove('hidden');
  document.querySelectorAll('[data-pipeline-step]').forEach(row => { delete row.dataset.state; row.removeAttribute('aria-current'); });
}

function delay(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }

function localPipelineFilename(fullName, masterText) {
  const source = fullName?.trim() || masterText.split(/\r?\n/).find(line => line.trim()) || 'Candidate';
  const firstPart = safeFilenamePart(source.split(/\s+/)[0]).replace(/_/g, '') || 'Candidate';
  const today = new Date();
  const date = [String(today.getDate()).padStart(2, '0'), String(today.getMonth() + 1).padStart(2, '0'), today.getFullYear()].join('-');
  return `${firstPart}_${date}.docx`;
}

async function downloadResumeBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    return await chrome.downloads.download({ url, filename: `MenixJobAI/${filename}`, saveAs: false, conflictAction: 'uniquify' });
  } finally { window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

async function generateResumeStep(job) {
  const masterText = $('resumeText').value.trim();
  const saved = await chrome.storage.local.get(['fullName']);
  const fullName = saved.fullName || $('fullNameInput').value.trim() || masterText.split(/\r?\n/).find(line => line.trim()) || '';
  const master = await readResumeFile('master');
  const requestBody = { resumeText: tailoredWorkingCopy || masterText, jobDescription: $('jobDescription').value.trim(), fullName };
  if (/\.docx$/i.test(master?.name || resumeFileName) && master?.file) {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(master.file); });
    requestBody.masterDocxBase64 = dataUrl;
    const originalLines = masterText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const tailoredLines = (tailoredWorkingCopy || masterText).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    requestBody.templateEdits = originalLines.flatMap((before, index) => {
      const after = tailoredLines[index];
      return after && after !== before ? [{ before, after }] : [];
    });
  }
  const response = await fetch(`${apiBase}/ai/tailor-docx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
  if (!response.ok) throw new Error(await responseError(response));
  const blob = await response.blob();
  return { blob, filename: localPipelineFilename(fullName, masterText), formatNote: response.headers.get('X-Resume-Format-Note') || '' };
}

async function saveResumeStep(file, job) {
  const generatedId = file.id || `generated-${Date.now()}`;
  const downloadId = file.downloadId || await downloadResumeBlob(file.blob, file.filename);
  const [downloadItem] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
  if (downloadItem?.filename) file.filename = downloadItem.filename.split(/[\\/]/).pop();
  await storeResumeFile(generatedId, file.blob, file.filename);
  generatedBlobUrl = URL.createObjectURL(file.blob);
  generatedFilename = file.filename;
  file.id = generatedId;
  file.downloadId = downloadId;
  const generatedAt = new Date().toISOString();
  generatedResumes = [{ id: generatedId, filename: file.filename, title: job.title, company: job.company, url: job.url, generatedAt, downloadId }, ...generatedResumes.filter(entry => entry.id !== generatedId)].slice(0, 10);
  await chrome.storage.local.set({ generatedResumes });
  populateGeneratedResumePicker();
  return { generatedAt, downloadId };
}

function isNaukriJob(url) {
  try { const parsed = new URL(url); return /(^|\.)naukri\.com$/i.test(parsed.hostname) && !/\/mnjuser\/(profile|login)/i.test(parsed.pathname); } catch { return false; }
}

async function getOrOpenNaukriProfile() {
  const matches = await chrome.tabs.query({ url: ['https://www.naukri.com/mnjuser/profile*', 'https://naukri.com/mnjuser/profile*'] });
  const existing = matches.find(tab => tab.id);
  if (existing) return { tabId: existing.id, opened: false };
  const tab = await chrome.tabs.create({ url: 'https://www.naukri.com/mnjuser/profile', active: false });
  if (!tab.id) throw new Error('Could not open the Naukri profile tab.');
  try { await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('Naukri profile did not finish loading in time.')); }, 25_000);
    const listener = (tabId, info) => { if (tabId === tab.id && info.status === 'complete') { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tab.id).then(current => { if (current.status === 'complete') { cleanup(); resolve(); } }).catch(error => { cleanup(); reject(error); });
  }); } catch (error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
  return { tabId: tab.id, opened: true };
}

async function uploadToNaukri(profile, file) {
  const tab = await chrome.tabs.get(profile.tabId);
  if (!tab.url || /naukri\.com\/(login|mnjuser\/login)/i.test(tab.url)) throw new Error('Log in to Naukri first');
  if (!/(^|\.)naukri\.com$/i.test(new URL(tab.url).hostname)) throw new Error('Naukri profile tab is no longer available.');
  const digest = await crypto.subtle.digest('SHA-256', await file.blob.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  const sessionState = chrome.storage.session ? await chrome.storage.session.get(['lastNaukriUploadedResumeHash']) : {};
  lastUploadedResumeHash = sessionState.lastNaukriUploadedResumeHash || lastUploadedResumeHash;
  if (lastUploadedResumeHash === hash) return { skippedDuplicate: true };
  const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file.blob); });
  const result = await chrome.scripting.executeScript({ target: { tabId: profile.tabId }, args: [dataUrl, file.filename, NAUKRI_SELECTORS], func: async (base64, filename, selectors) => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    let input = null;
    for (const selector of selectors.resumeInputs) { try { input = [...document.querySelectorAll(selector)].find(visible) || null; } catch {} if (input) break; }
    if (!input) {
      const resumeArea = [...document.querySelectorAll('section,article,[class*="resume" i],[id*="resume" i]')].find(el => visible(el) && /resume/i.test(el.innerText || ''));
      input = resumeArea ? [...resumeArea.querySelectorAll('input[type="file"]')].find(visible) || resumeArea.querySelector('input[type="file"]') : null;
    }
    if (!input) return { ok: false, error: 'Resume upload input was not found. Open the Resume section on Naukri and try again.' };
    const resumeArea = [...document.querySelectorAll('section,article,[class*="resume" i],[id*="resume" i]')].find(el => /resume/i.test(el.innerText || ''));
    const oldResumeName = (resumeArea?.innerText || '').split('\n').map(line => line.trim()).find(line => /\.docx$|\.pdf$/i.test(line)) || '';
    const binary = atob(base64); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], filename, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    const baselineText = (document.body?.innerText || '').toLowerCase();
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const text = (document.body?.innerText || '').toLowerCase();
      if (text !== baselineText && selectors.successText.some(phrase => text.includes(phrase))) return { ok: true, previousResumeName: oldResumeName };
      await sleep(300);
    }
    return { ok: false, error: 'Naukri did not confirm the resume update within 15 seconds. Check the profile and retry.' };
  }});
  const outcome = result?.[0]?.result;
  if (!outcome?.ok) throw new Error(outcome?.error || 'Naukri upload could not be verified.');
  lastUploadedResumeHash = hash;
  if (chrome.storage.session) await chrome.storage.session.set({ lastNaukriUploadedResumeHash: hash });
  return outcome;
}

async function confirmNaukriReplacement() {
  const saved = await chrome.storage.local.get(['naukriUploadConfirmedOnce']);
  if (saved.naukriUploadConfirmedOnce) return true;
  const dialog = $('uploadConfirmDialog');
  $('dontAskUploadAgain').checked = false;
  dialog.showModal();
  const confirmed = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  if (confirmed && $('dontAskUploadAgain').checked) await chrome.storage.local.set({ naukriUploadConfirmedOnce: true });
  return confirmed;
}

async function updatePipelineHistory(job, file, uploaded, failedStep = null) {
  const stored = await chrome.storage.local.get(['resumePipelineHistory']);
  const history = Array.isArray(stored.resumePipelineHistory) ? stored.resumePipelineHistory : [];
  history.unshift({ jobUrl: job.url, filename: file?.filename || '', previousResumeName: file?.previousResumeName || '', uploaded: Boolean(uploaded), timestamp: new Date().toISOString(), failedStep });
  await chrome.storage.local.set({ resumePipelineHistory: history.slice(0, 50) });
}

function watchForApplicationConfirmation(job) {
  if (restoreMonitorTimer) window.clearInterval(restoreMonitorTimer);
  restoreMonitorTimer = window.setInterval(async () => {
    if (resumePipelineRunning) return;
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const tab = tabs[0];
    if (!tab?.id || !tab.url || !isNaukriJob(tab.url)) return;
    const signals = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const text = (document.body?.innerText || '').toLowerCase();
      return ['application submitted successfully', 'successfully applied', 'application sent successfully', 'thank you for applying', 'your application has been submitted'].some(signal => text.includes(signal));
    }}).catch(() => []);
    if (!signals[0]?.result) return;
    window.clearInterval(restoreMonitorTimer); restoreMonitorTimer = null;
    const master = await readResumeFile('master');
    if (!master?.file) return setStatus('Application confirmed. Master resume file is unavailable, so automatic restore could not run.', 'error');
    setStatus('Naukri confirmed the application. Restoring your master resume…', 'success');
    await runResumePipeline(job, 3, { id: 'master', filename: master.name || resumeFileName || 'MasterResume.docx', blob: master.file, restore: true });
  }, 5000);
}

async function runResumePipeline(job, startStep = 1, existingFile = null) {
  if (resumePipelineRunning) return setStatus('A resume update is already running.', 'error');
  resumePipelineRunning = true;
  let file = existingFile;
  let profile = null;
  let originalTabId = null;
  let uploaded = Boolean(existingFile?.uploaded);
  let currentStep = startStep;
  let failure = null;
  $('generateBtn').disabled = true;
  $('fileResult').classList.add('hidden');
  $('retryPipelineBtn').classList.add('hidden');
  resetPipelineStepper();
  try {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    originalTabId = active[0]?.id || null;
    const autoUpload = !existingFile?.restore && $('autoUploadSetting').checked;
    const uploadEligible = autoUpload && isNaukriJob(job.url);
    if (startStep <= 1) {
      currentStep = 1; setPipelineStep(1, 'running');
      file = await generateResumeStep(job); setPipelineStep(1, 'done'); await delay(3000);
    }
    if (startStep <= 2) {
      currentStep = 2; setPipelineStep(2, 'running');
      const saved = await saveResumeStep(file, job); file.generatedAt = saved.generatedAt; setPipelineStep(2, 'done');
      if ($('autoUploadSetting').checked && isNaukriJob(job.url)) await delay(3000);
    }
    if (existingFile?.restore) {
      if (!await confirmNaukriReplacement()) throw new Error('Restore cancelled.');
      if (startStep <= 3) { currentStep = 3; setPipelineStep(3, 'running'); profile = await getOrOpenNaukriProfile(); setPipelineStep(3, 'done'); await delay(3000); }
      else profile = await getOrOpenNaukriProfile();
      if (startStep <= 4) { currentStep = 4; setPipelineStep(4, 'running'); const result = await uploadToNaukri(profile, file); file.previousResumeName = result.previousResumeName || file.previousResumeName; uploaded = true; setPipelineStep(4, 'done'); await delay(3000); }
      if (startStep <= 5) { currentStep = 5; setPipelineStep(5, 'running'); await finishReturnStep(profile, originalTabId); profile = null; setPipelineStep(5, 'done'); }
    } else if (uploadEligible) {
      if (!await confirmNaukriReplacement()) throw new Error('Upload cancelled. The tailored resume is saved in Downloads/MenixJobAI.');
      if (startStep <= 3) { currentStep = 3; setPipelineStep(3, 'running'); profile = await getOrOpenNaukriProfile(); setPipelineStep(3, 'done'); await delay(3000); }
      else profile = await getOrOpenNaukriProfile();
      if (startStep <= 4) { currentStep = 4; setPipelineStep(4, 'running'); const result = await uploadToNaukri(profile, file); file.previousResumeName = result.previousResumeName || file.previousResumeName; uploaded = true; setPipelineStep(4, 'done'); await delay(3000); }
      if (startStep <= 5) { currentStep = 5; setPipelineStep(5, 'running'); await finishReturnStep(profile, originalTabId); profile = null; setPipelineStep(5, 'done'); }
    } else {
      [3,4,5].forEach(step => setPipelineStep(step, 'pending'));
      $('fileResultText').textContent = $('autoUploadSetting').checked ? 'Saved to Downloads/MenixJobAI. Auto-upload is available on a Naukri job page.' : 'Saved to Downloads/MenixJobAI. Auto-upload is off.';
    }
    await updatePipelineHistory(job, file, uploaded);
    $('fileResult').classList.remove('hidden');
    $('openJobBtn').classList.toggle('hidden', !/^https?:\/\//i.test(job.url));
    $('restoreMasterBtn').classList.toggle('hidden', !uploaded || !await readResumeFile('master'));
    $('retryPipelineBtn').classList.add('hidden');
    const formatNote = file?.formatNote ? ` ${file.formatNote}` : '';
    $('fileResultText').textContent = uploaded ? `✓ ${file.filename} · Saved to Downloads/MenixJobAI · Uploaded to Naukri profile. Resume updated. Review it, then click Apply.${formatNote}` : `${$('fileResultText').textContent || `✓ ${file?.filename} · Saved to Downloads/MenixJobAI.`}${formatNote}`;
    setStatus(uploaded ? 'Resume updated. Review it, then click Apply.' : 'Tailored resume saved. Review it before applying.', 'success');
    if (uploaded && $('restoreMasterSetting').checked) watchForApplicationConfirmation(job);
  } catch (error) {
    failure = error;
    if (file && currentStep >= 5) { file.uploaded = true; uploaded = true; }
    const cancelled = /cancelled/i.test(error.message);
    if (!cancelled && currentStep >= 1 && currentStep <= 5) setPipelineStep(currentStep, 'failed');
    await updatePipelineHistory(job, file, uploaded, cancelled ? null : currentStep).catch(() => {});
    $('fileResult').classList.remove('hidden');
    $('fileResultText').textContent = cancelled ? `Upload cancelled. ${file ? `${file.filename} is saved to Downloads/MenixJobAI. ` : ''}Your Naukri profile was not changed.` : `${currentStep === 3 ? 'Open Naukri profile' : currentStep === 4 ? 'Upload resume' : currentStep === 5 ? 'Return to job' : currentStep === 2 ? 'Save resume' : 'Generate resume'} failed: ${error.message}. ${file ? `Your file is saved in Downloads/MenixJobAI (${file.filename}). ` : ''}${error.message.includes('Log in to Naukri first') ? 'Log in to Naukri first, then retry.' : 'You can upload it manually from Downloads/MenixJobAI.'}`;
    $('retryPipelineBtn').classList.toggle('hidden', cancelled || !file || currentStep < 3 || currentStep > 5);
    pipelineRetryContext = cancelled ? null : { job, startStep: currentStep, file };
    setStatus(cancelled ? 'Upload cancelled. Your Naukri profile was not changed.' : error.message, cancelled ? 'success' : 'error');
  } finally {
    if (profile?.opened && profile.tabId) await chrome.tabs.remove(profile.tabId).catch(() => {});
    if (originalTabId) await chrome.tabs.update(originalTabId, { active: true }).catch(() => {});
    resumePipelineRunning = false;
    $('generateBtn').disabled = false;
    if (failure && !/cancelled/i.test(failure.message)) $('generateBtn').textContent = `Retry step ${currentStep}`;
    else if (pipelineLastState?.step === 5) $('generateBtn').textContent = 'Done. Download again';
    updatePrimaryAction();
  }
}

async function finishReturnStep(profile, originalTabId) {
  if (profile?.opened) await chrome.tabs.remove(profile.tabId);
  if (originalTabId) {
    await chrome.tabs.update(originalTabId, { active: true });
    await chrome.scripting.executeScript({ target: { tabId: originalTabId }, func: () => {
      const old = document.getElementById('__menix_resume_updated_notice'); old?.remove();
      const note = document.createElement('div'); note.id = '__menix_resume_updated_notice'; note.textContent = 'Resume updated. Review it, then click Apply.';
      note.style.cssText = 'position:fixed;right:400px;top:16px;z-index:2147483646;padding:12px 16px;border-radius:10px;background:#123b27;color:#c5f7d5;font:600 14px system-ui;box-shadow:0 4px 18px #0005';
      document.documentElement.append(note); setTimeout(() => note.remove(), 10000);
    }}).catch(() => {});
  }
}

$('generateBtn').addEventListener('click', async () => {
  if (!lastAnalysis) { await analyzeCurrentMatch(false); return; }
  if (resumePipelineRunning) return;
  const job = currentJobPayload();
  if (generatedBlobUrl && generatedFilename) {
    try { await downloadResumeBlob(await (await fetch(generatedBlobUrl)).blob(), generatedFilename); setStatus(`Downloading ${generatedFilename}.`, 'success'); }
    catch (error) { setStatus(`Could not download the tailored resume: ${error.message}`, 'error'); }
    return;
  }
  if (!$('resumeText').value.trim()) return setStatus('Add your master resume before generating a tailored resume.', 'error');
  if (!$('jobDescription').value.trim()) return setStatus('Add the job description before generating a tailored resume.', 'error');
  await runResumePipeline(job);
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
