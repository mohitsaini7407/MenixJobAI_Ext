
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
let suggestionRequestPromise = null;
let suggestionController = null;
let tailoredWorkingCopy = '';
let resumeWorkflows = [];
let activeResumeWorkflow = null;
let activeResumePreviewText = '';
let resumeUploadPipelinePromise = null;
let tailorGenerationInProgress = false;
let applicationAnswerItems = [];
let applicationQuestionsLoading = false;

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
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
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

function renderResumeWorkflow() {
  const workflow = activeResumeWorkflow;
  const hasJob = Boolean(workflow);
  const hasResumeSelection = Boolean(workflow?.selectedType === 'tailored' && workflow.temporaryResumeName)
    || Boolean(workflow?.selectedType === 'master' && resumeFileName);
  const hasSelectedFile = hasResumeSelection && workflow?.status !== 'MASTER_RESUME_RESTORED';
  const states = {
    JOB_DETECTED: 'Analyzing…',
    JD_ANALYZED: lastAnalysis ? `Match ${lastAnalysis.matchScore ?? 'N/A'}% · Choose a resume.` : 'Waiting for analysis.',
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
  const canAnswerQuestions = Boolean(workflow && ['APPLICATION_IN_PROGRESS', 'APPLICATION_SUBMITTED'].includes(workflow.status));
  $('applicationAnswersSection').classList.toggle('hidden', !canAnswerQuestions);
  $('tailoredResumeSection').classList.toggle('hidden', !hasResumeSelection);
  $('activeWorkflowHeading').textContent = workflow?.selectedType === 'master' ? 'Master Resume for This Job' : 'Tailored Resume';
  $('applyResumePreview').classList.toggle('hidden', !hasResumeSelection);
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
  $('tailoredResumeStatus').textContent = `${fileSize ? `${Math.max(1, Math.round(fileSize / 1024))} KB · ` : ''}${fileState}`;
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

const SENSITIVE_QUESTION_PATTERN = /\b(?:gender|race|ethnicity|disability|veteran|military|sexual orientation|visa|work authorization|sponsor(?:ship)?|authorized to work|eligible to work|work permit|citizenship|nationality|criminal|background check|date of birth|birth date|age)\b/i;

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
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const visible = element => Boolean(element.getClientRects().length)
        && getComputedStyle(element).visibility !== 'hidden'
        && getComputedStyle(element).display !== 'none';
      const elementsIn = root => {
        const found = [...root.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]')];
        for (const element of [...root.querySelectorAll('*')]) if (element.shadowRoot) found.push(...elementsIn(element.shadowRoot));
        return found;
      };
      const controls = [...new Set(elementsIn(document))].filter(element => {
        if (!visible(element) || element.disabled || element.readOnly || element.closest('#__menixjobai_dock')) return false;
        if (element instanceof HTMLInputElement && !['text','email','tel','url','number','search','radio'].includes(element.type)) return false;
        if (element instanceof HTMLInputElement && element.type === 'radio') {
          const group = elementsIn(document).filter(item => item instanceof HTMLInputElement && item.type === 'radio' && item.name === element.name && item.form === element.form);
          return !group.some(item => item.checked);
        }
        if (element instanceof HTMLSelectElement) return !element.value || /^(?:select|choose|please)/i.test(element.selectedOptions[0]?.textContent?.trim() || '');
        if (element instanceof HTMLElement && element.isContentEditable) return !element.innerText.trim();
        return !String(element.value ?? element.innerText ?? '').trim();
      });
      const labelFor = element => {
        const explicit = [...(element.labels || [])].map(label => label.innerText || '').join(' ');
        const aria = element.getAttribute('aria-label') || '';
        const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
        const legend = element.closest('fieldset')?.querySelector('legend')?.innerText || '';
        const nearby = element.closest('label')?.innerText || '';
        const fallback = element.getAttribute('placeholder') || element.name || element.id || '';
        const nearbyPrompt = (() => {
          let node = element;
          for (let depth = 0; node?.parentElement && depth < 6; depth++, node = node.parentElement) {
            const siblings = [...node.parentElement.children];
            const index = siblings.indexOf(node);
            for (let i = index - 1; i >= 0; i--) {
              const text = (siblings[i].innerText || siblings[i].textContent || '').replace(/\s+/g, ' ').trim();
              const question = text.match(/[^?]{3,240}\?/g)?.at(-1)?.trim();
              if (question) return question;
            }
          }
          return '';
        })();
        return [explicit, nearby, legend, labelled, aria, nearbyPrompt, fallback].map(value => value.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 300);
      };
      const questions = [];
      const radioGroups = new Map();
      for (const element of controls) {
        if (element instanceof HTMLInputElement && element.type === 'radio') {
          const key = element.name || `radio-${questions.length}`;
          if (radioGroups.has(key)) continue;
          const group = elementsIn(document).filter(item => item instanceof HTMLInputElement && item.type === 'radio' && item.name === element.name && item.form === element.form && visible(item));
          const question = element.closest('fieldset')?.querySelector('legend')?.innerText || labelFor(element);
          const id = `menix-question-${questions.length}`;
          group.forEach(item => { item.dataset.menixAnswerId = id; });
          radioGroups.set(key, true);
          questions.push({ id, question, kind: 'radio', options: group.map(item => ({ value: item.value, label: item.closest('label')?.innerText?.trim() || document.querySelector(`label[for="${CSS.escape(item.id || '')}"]`)?.innerText?.trim() || item.value })) });
          continue;
        }
        const id = `menix-question-${questions.length}`;
        element.dataset.menixAnswerId = id;
        questions.push({
          id, question: labelFor(element),
          kind: element instanceof HTMLSelectElement ? 'select' : 'text',
          options: element instanceof HTMLSelectElement ? [...element.options].filter(option => option.value).map(option => ({ value: option.value, label: option.textContent.trim() })) : []
        });
      }
      return questions.filter(item => item.question);
    }
  });
  return Array.isArray(result?.result) ? result.result : [];
}

function renderApplicationAnswers(items) {
  const list = $('applicationAnswersList');
  list.replaceChildren();
  applicationAnswerItems = items;
  $('fillApplicationAnswersBtn').classList.toggle('hidden', !items.some(item => item.answer || item.needsUserInput));
  for (const item of items) {
    const card = document.createElement('article');
    card.className = `application-answer-card${item.needsUserInput ? ' needs-user-input' : ''}`;
    const heading = document.createElement('h3'); heading.textContent = item.question;
    const note = document.createElement('p'); note.className = 'answer-confidence';
    note.textContent = item.sensitive ? 'Sensitive question — answer this yourself.'
      : item.needsUserInput ? 'No supported answer found. Add your own answer to fill it.'
        : `AI draft · ${item.confidence} confidence · review before filling`;
    const answer = document.createElement('textarea');
    answer.value = item.answer || ''; answer.rows = 2; answer.setAttribute('aria-label', `Answer for ${item.question}`);
    answer.dataset.answerId = item.id;
    const fill = document.createElement('button'); fill.className = 'btn answer-fill'; fill.type = 'button'; fill.textContent = 'Fill this answer';
    fill.addEventListener('click', () => fillReviewedApplicationAnswers([item.id]));
    card.append(heading, note, answer, fill);
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
    if (!detected.length) throw new Error('No unanswered application questions were found.');
    const questions = detected.map(item => ({
      ...item,
      sensitive: SENSITIVE_QUESTION_PATTERN.test(item.question),
      question: item.question
    }));
    const answerable = questions.filter(item => !item.sensitive);
    let generated = [];
    if (answerable.length) {
      const resumeText = $('resumeText').value.trim();
      if (!resumeText) throw new Error('Upload a Master Resume to draft answers.');
      const response = await api('/ai/application-answers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeText,
          jobDescription: $('jobDescription').value.trim(),
          resumeHash: await sha256Hex(cleanText(resumeText)),
          questions: answerable.map(({ id, question, options }) => ({ id, question, options: (options || []).map(option => option.label) }))
        })
      });
      generated = response.answers || [];
    }
    const generatedById = new Map(generated.map(item => [item.id, item]));
    renderApplicationAnswers(questions.map(question => ({
      ...question, ...(generatedById.get(question.id) || {}),
      answer: generatedById.get(question.id)?.answer || '',
      needsUserInput: question.sensitive || generatedById.get(question.id)?.needsUserInput !== false,
      confidence: generatedById.get(question.id)?.confidence || 'low'
    })));
    const fillableIds = generated.filter(item => item.answer && !item.needsUserInput).map(item => item.id);
    const fillResult = fillableIds.length ? await fillReviewedApplicationAnswers(fillableIds) : null;
    const manualCount = questions.length - fillableIds.length;
    if (fillResult?.filled) setStatus(`Filled ${fillResult.filled} answer${fillResult.filled === 1 ? '' : 's'} from your resume. ${manualCount ? `${manualCount} question${manualCount === 1 ? '' : 's'} need your input.` : 'Review the form before submitting.'}`, 'success');
    else if (fillableIds.length) setStatus('Answers were drafted, but the page did not accept them. Enter them on the form manually.', 'info');
    else if (questions.length) setStatus(`Found ${questions.length} question${questions.length === 1 ? '' : 's'}, but your resume does not support an answer. Please answer them yourself.`, 'info');
  } catch (error) {
    const note = document.createElement('p'); note.className = 'answer-confidence'; note.textContent = error.message;
    $('applicationAnswersList').append(note);
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false; button.textContent = 'Suggest Answers from Resume';
  }
}

async function autoFillCompanyApplication(tabId) {
  try {
    await waitForTabComplete(tabId);
    await delay(700);
    const tab = await chrome.tabs.get(tabId);
    const origin = new URL(tab.url).origin;
    if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
      setStatus(`Company page opened. Allow ${new URL(tab.url).hostname} and click Suggest Answers to fill its form.`, 'info');
      return;
    }
    const resume = await selectedWorkflowFile();
    const resumeAttached = await attachResumeToCompanyApplication(tabId, resume);
    const detected = await findApplicationQuestions(tabId);
    if (!detected.length) {
      setStatus(resumeAttached ? 'Resume attached. Checking whether the company form is ready to submit.' : 'Company page opened, but its resume field needs a manual file selection.', 'info');
      if (resumeAttached) await submitCompanyApplication({ requestPermission: false });
      return;
    }
    const questions = detected.map(item => ({ ...item, sensitive: SENSITIVE_QUESTION_PATTERN.test(item.question) }));
    const answerable = questions.filter(item => !item.sensitive);
    let generated = [];
    if (answerable.length) {
      const resumeText = $('resumeText').value.trim();
      const response = await api('/ai/application-answers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeText, jobDescription: $('jobDescription').value.trim(),
          resumeHash: await sha256Hex(cleanText(resumeText)),
          questions: answerable.map(({ id, question, options }) => ({ id, question, options: (options || []).map(option => option.label) }))
        })
      });
      generated = response.answers || [];
    }
    const answersById = new Map(generated.map(item => [item.id, item]));
    renderApplicationAnswers(questions.map(question => ({
      ...question, ...(answersById.get(question.id) || {}), answer: answersById.get(question.id)?.answer || '',
      needsUserInput: question.sensitive || answersById.get(question.id)?.needsUserInput !== false,
      confidence: answersById.get(question.id)?.confidence || 'low'
    })));
    const fillableIds = generated.filter(item => item.answer && !item.needsUserInput).map(item => item.id);
    if (fillableIds.length) await fillReviewedApplicationAnswers(fillableIds);
    if (!resumeAttached) {
      setStatus('Resume-based answers were filled where supported. Choose the resume in the company form before submitting.', 'info');
      return;
    }
    if (!fillableIds.length) setStatus('Resume attached. No additional answers were supported by the resume; checking the required fields.', 'info');
    await submitCompanyApplication({ requestPermission: false });
  } catch (error) {
    setStatus(`Company form could not be filled automatically: ${error.message}`, 'error');
  }
}

async function attachResumeToCompanyApplication(tabId, resume) {
  const encoded = await blobToBase64(resume.blob);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId }, args: [resume.name, encoded],
    func: (fileName, base64) => {
      const controls = [...document.querySelectorAll('input[type="file"]')].filter(input => !input.disabled);
      if (!controls.length) return { attached: false, message: 'No file input was found.' };
      const extension = (fileName.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
      const selected = controls.find(input => !input.accept || input.accept.toLowerCase().includes(extension))
        || (controls.length === 1 ? controls[0] : null);
      if (!selected) return { attached: false, message: 'No resume-compatible file input was found.' };
      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const type = extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const file = new File([bytes], fileName, { type, lastModified: Date.now() });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        selected.files = transfer.files;
        selected.dispatchEvent(new Event('input', { bubbles: true }));
        selected.dispatchEvent(new Event('change', { bubbles: true }));
        return { attached: selected.files?.[0]?.name === fileName, message: selected.files?.[0]?.name || 'The site did not accept the selected file.' };
      } catch (error) { return { attached: false, message: error?.message || 'The site rejected the resume file.' }; }
    }
  });
  if (!result?.result?.attached) setStatus(`Select ${resume.name} in the company form to continue.`, 'info');
  return Boolean(result?.result?.attached);
}

async function fillReviewedApplicationAnswers(onlyIds = null) {
  try {
    const tab = await activeApplicationTab();
    const answers = [...$('applicationAnswersList').querySelectorAll('textarea[data-answer-id]')]
      .filter(field => !onlyIds || onlyIds.includes(field.dataset.answerId))
      .map(field => ({ id: field.dataset.answerId, answer: field.value.trim() }))
      .filter(item => item.answer);
    if (!answers.length) throw new Error('Add or review an answer before filling.');
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [answers],
      func: values => {
        let filled = 0; let skipped = 0;
        const normalize = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const elementsIn = root => {
          const found = [...root.querySelectorAll('[data-menix-answer-id]')];
          for (const element of [...root.querySelectorAll('*')]) if (element.shadowRoot) found.push(...elementsIn(element.shadowRoot));
          return found;
        };
        for (const item of values) {
          const fields = elementsIn(document).filter(field => field.dataset.menixAnswerId === item.id);
          if (!fields.length) { skipped++; continue; }
          const first = fields[0];
          if (first instanceof HTMLSelectElement) {
            if (first.value) { skipped++; continue; }
            const target = normalize(item.answer);
            const option = [...first.options].find(entry => normalize(entry.textContent) === target || normalize(entry.value) === target);
            if (!option) { skipped++; continue; }
            first.value = option.value;
            first.dispatchEvent(new Event('input', { bubbles: true })); first.dispatchEvent(new Event('change', { bubbles: true }));
            filled++; continue;
          }
          if (first instanceof HTMLInputElement && first.type === 'radio') {
            const target = normalize(item.answer);
            const choice = fields.find(field => normalize(field.closest('label')?.innerText || document.querySelector(`label[for="${CSS.escape(field.id || '')}"]`)?.innerText || field.value) === target);
            if (!choice || fields.some(field => field.checked)) { skipped++; continue; }
            choice.checked = true; choice.dispatchEvent(new Event('input', { bubbles: true })); choice.dispatchEvent(new Event('change', { bubbles: true }));
            filled++; continue;
          }
          if (String(first.value || '').trim()) { skipped++; continue; }
          const prototype = first instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) {
            const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            setter ? setter.call(first, item.answer) : first.value = item.answer;
          } else if (first.isContentEditable) first.innerText = item.answer;
          else first.textContent = item.answer;
          first.dispatchEvent(new Event('input', { bubbles: true })); first.dispatchEvent(new Event('change', { bubbles: true }));
          filled++;
        }
        return { filled, skipped };
      }
    });
    const outcome = result?.result || { filled: 0, skipped: answers.length };
    setStatus(`Filled ${outcome.filled} answer${outcome.filled === 1 ? '' : 's'}; ${outcome.skipped} field${outcome.skipped === 1 ? '' : 's'} left for you. Review the form; nothing was submitted.`, outcome.filled ? 'success' : 'info');
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
  if (tailorGenerationInProgress) {
    button.disabled = true;
    button.textContent = 'Tailoring Resume…';
    return;
  }
  if (resumeUploadPipelinePromise) {
    button.disabled = true;
    button.textContent = (activeResumeWorkflow?.companyApplyUrl || jobMetadata.companyApplyUrl)
      ? 'Preparing company application…' : 'Uploading to Naukri…';
    return;
  }
  if (analysisPromise && !lastAnalysis) {
    button.disabled = true;
    button.textContent = 'Refining with AI…';
  } else if (aiRefinementFailed && !lastAnalysis) {
    button.disabled = false;
    button.textContent = 'Retry AI refinement';
  } else if (!lastAnalysis) {
    const ready = Boolean($('resumeText')?.value.trim() && $('jobDescription')?.value.trim());
    button.disabled = !ready;
    button.textContent = ready ? 'Analyze Job Match' : 'Add Resume and Open a Job';
  } else {
    const workflow = activeResumeWorkflow;
    const applicationStarted = ['APPLICATION_IN_PROGRESS', 'APPLICATION_SUBMITTED'].includes(workflow?.status);
    const companyFormOpen = workflow?.status === 'APPLICATION_IN_PROGRESS' && Boolean(workflow?.companyApplicationTabId);
    const restored = workflow?.status === 'MASTER_RESUME_RESTORED';
    const uploaded = ['TEMPORARY_RESUME_UPLOADED', 'MASTER_RESUME_UPLOADED'].includes(workflow?.status);
    button.disabled = (applicationStarted && !companyFormOpen) || restored;
    button.textContent = companyFormOpen ? 'Submit & Return to Naukri'
      : workflow?.status === 'APPLICATION_SUBMITTED' ? 'Application submitted'
        : applicationStarted ? 'Application in progress'
      : restored ? 'Resume restored on Naukri'
          : uploaded && workflow?.applicationStartFailed ? 'Retry Apply'
            : workflow?.selectedType === 'master' ? 'Upload Master Resume & Apply'
              : 'Tailor Resume & Apply';
  }
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
    'resumeWorkflows', 'activeResumeJobKey', 'activeJobSnapshot', 'activeJobAnalysis', 'fullName'
  ]);

  apiBase = saved.apiBase || DEFAULT_API;

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
  if (activeResumeWorkflow?.jobUrl && savedJobUrl === activeResumeWorkflow.jobUrl && saved.activeJobAnalysis) {
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
    const tab = tabId
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

    if (!tab?.id || !tab.url) {
      throw new Error('No active browser tab was found.');
    }

    const url = new URL(tab.url);
    const isNaukriJobListing = /(^|\.)naukri\.com$/i.test(url.hostname) && /\/job-listings?-/i.test(url.pathname);
    if (activeResumeWorkflow?.jobTabId !== tab.id && !isNaukriJobListing && [
      'TEMPORARY_RESUME_UPLOADED', 'MASTER_RESUME_UPLOADED', 'APPLICATION_IN_PROGRESS',
      'APPLICATION_SUBMITTED', 'RESTORATION_PENDING', 'RESTORATION_FAILED'
    ].includes(activeResumeWorkflow?.status)) return;

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('This page does not allow job details to be read.');
    }
    // Profile navigation is part of the upload flow; keep the selected job and
    // resume visible while the user replaces the Naukri profile file.
    if (url.hostname.endsWith('naukri.com') && /^\/mnjuser\/(?:profile|login)(?:\/|$)/i.test(url.pathname)) return;
    if (activeResumeWorkflow?.status === 'APPLICATION_IN_PROGRESS'
      && activeResumeWorkflow.jobTabId === tab.id
      && url.hostname.endsWith('naukri.com')
      && tab.url !== activeResumeWorkflow.jobUrl
      && !isNaukriJobListing) return;
    // Returning from the profile is only for resume upload. Keep the saved job
    // snapshot and its analysis instead of treating it as a newly detected job.
    if (currentJobTabUrl === tab.url && activeResumeWorkflow?.jobUrl === tab.url
      && $('jobDescription').value.trim().length >= 100) return;
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
        const companyApplyUrl = uniqueApplyHrefs.length === 1 ? uniqueApplyHrefs[0] : '';
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
        companyApplyUrl,
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
      companyLogo: cleanText(result.companyLogo),
      companyApplyUrl: cleanText(result.companyApplyUrl)
    };
    recruiterContact = result.recruiterContact || {};
    renderRecruiterContact('found');
    updateJobSummary();
    invalidateAnalysis();
    await activateResumeWorkflow(currentJobPayload(), tab.id);
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
      return area.split(/\n+/).map(line => line.trim()).find(line => /\.(?:pdf|docx?)$/i.test(line)) || '';
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
    await persistResumeWorkflow({ ...activeResumeWorkflow, status: activeResumeWorkflow.selectedType === 'master' ? 'MASTER_RESUME_UPLOADED' : 'TEMPORARY_RESUME_UPLOADED', applicationStartFailed: true, lastError: message });
    setStatus(message, 'info');
    return false;
  }

  let applicationTab = jobTab;
  if (result.external) {
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      const currentTabs = jobTab.windowId != null ? await chrome.tabs.query({ windowId: jobTab.windowId }) : [];
      const opened = currentTabs.find(tab => !priorTabIds.has(tab.id) && tab.url && /^https:\/\//i.test(tab.url));
      if (opened) { applicationTab = opened; break; }
      const updatedJobTab = await chrome.tabs.get(jobTab.id).catch(() => null);
      if (updatedJobTab?.url && !isNaukriHost(new URL(updatedJobTab.url).hostname)) { applicationTab = updatedJobTab; break; }
      await delay(150);
    }
    if (applicationTab.id === jobTab.id && result.href && isNaukriHost(new URL(applicationTab.url || workflow.jobUrl).hostname)) {
      try {
        const destination = new URL(result.href);
        if (destination.protocol === 'https:' && !isNaukriHost(destination.hostname)) {
          const currentTabs = jobTab.windowId != null ? await chrome.tabs.query({ windowId: jobTab.windowId }) : [];
          const alreadyOpened = currentTabs.find(tab => !priorTabIds.has(tab.id) && tab.url === destination.href);
          applicationTab = alreadyOpened || await chrome.tabs.create({ url: destination.href, active: true, windowId: jobTab.windowId });
        }
      } catch { /* Keep the Naukri job tab active if its company link was not a valid HTTPS destination. */ }
    }
  }

  await persistResumeWorkflow({
    ...activeResumeWorkflow, status: 'APPLICATION_IN_PROGRESS', applicationStartFailed: false,
    applyClickedAt: new Date().toISOString(), applyButtonLabel: result.label,
    companyApplicationTabId: result.external ? applicationTab.id : null,
    companyApplicationUrl: result.external ? applicationTab.url || result.href || '' : '',
    lastError: ''
  });
  setStatus(result.external
    ? 'Company application opened. Review the form and submit it yourself.'
    : 'Naukri Apply opened. Review the application and submit it yourself.', 'success');
  if (result.external) await autoFillCompanyApplication(applicationTab.id);
  return true;
}

async function submitCompanyApplication({ requestPermission = true } = {}) {
  const workflow = activeResumeWorkflow;
  if (!workflow?.companyApplicationTabId) throw new Error('No company application page is connected to this job.');
  const permissionOrigin = workflow.companyApplicationUrl ? new URL(workflow.companyApplicationUrl).origin : null;
  const permissionRequest = requestPermission && permissionOrigin && /^https:\/\//i.test(permissionOrigin)
    ? chrome.permissions.request({ origins: [`${permissionOrigin}/*`] }) : null;
  const applicationTab = await chrome.tabs.get(workflow.companyApplicationTabId).catch(() => null);
  if (!applicationTab?.id || !/^https:\/\//i.test(applicationTab.url || '')) throw new Error('The company application page is no longer available.');
  const origin = new URL(applicationTab.url).origin;
  if (permissionRequest) await permissionRequest;
  const hasPermission = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!hasPermission) throw new Error(`Allow access to ${new URL(applicationTab.url).hostname} first, then review and submit again.`);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: applicationTab.id },
    func: () => {
      const visible = element => Boolean(element?.getClientRects().length)
        && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none';
      const captcha = [...document.querySelectorAll('iframe[src*="captcha" i],iframe[title*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]')].some(visible);
      if (captcha) return { ready: false, reason: 'CAPTCHA detected. Complete it yourself before submitting.' };
      const required = [...document.querySelectorAll('input[required],textarea[required],select[required],input[aria-required="true"],textarea[aria-required="true"],select[aria-required="true"]')]
        .filter(element => visible(element) || (element instanceof HTMLInputElement && ['file','checkbox','radio'].includes(element.type)));
      const radioNames = new Set(required.filter(element => element instanceof HTMLInputElement && element.type === 'radio').map(element => element.name));
      const missing = required.filter(element => {
        if (element instanceof HTMLInputElement && element.type === 'radio') return false;
        if (element instanceof HTMLInputElement && element.type === 'checkbox') return !element.checked;
        if (element instanceof HTMLInputElement && element.type === 'file') return !element.files?.length;
        return !String(element.value || '').trim();
      });
      for (const name of radioNames) {
        if (![...document.querySelectorAll('input[type="radio"]')].some(element => element.name === name && element.checked)) {
          missing.push(...required.filter(element => element instanceof HTMLInputElement && element.type === 'radio' && element.name === name));
        }
      }
      if (missing.length) return { ready: false, reason: `${missing.length} required field(s) still need your attention, including any consent and resume upload fields.` };
      const candidates = [...document.querySelectorAll('button[type="submit"],input[type="submit"],button,[role="button"]')]
        .filter(visible).filter(element => !element.disabled && element.getAttribute('aria-disabled') !== 'true')
        .filter(element => /^(?:submit|submit application|apply|apply now|send application)$/i.test((element.innerText || element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
      const unique = [...new Set(candidates)];
      if (unique.length !== 1) return { ready: false, reason: unique.length ? 'More than one submit button was found. Choose the correct one on the company page.' : 'Submit button was not found. Submit the form yourself on the company page.' };
      unique[0].click();
      return { ready: true };
    }
  });
  if (!result?.ready) { setStatus(result?.reason || 'The company form is not ready to submit.', 'info'); return false; }

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
    setStatus('Submit was clicked, but the company site did not show a clear confirmation. Check its page before leaving.', 'info');
    return false;
  }
  await persistResumeWorkflow({
    ...activeResumeWorkflow, status: 'APPLICATION_SUBMITTED', applicationStatus: 'APPLICATION_SUBMITTED',
    applicationConfirmedAt: new Date().toISOString(), companySubmissionVerified: true, lastError: ''
  });
  const jobTab = activeResumeWorkflow.jobTabId ? await chrome.tabs.get(activeResumeWorkflow.jobTabId).catch(() => null) : null;
  if (jobTab?.id) {
    await chrome.tabs.update(jobTab.id, { active: true });
    if (jobTab.windowId != null) await chrome.windows.update(jobTab.windowId, { focused: true }).catch(() => {});
  }
  setStatus(activeResumeWorkflow.selectedType === 'master'
    ? 'Application submitted. Returned to Naukri.'
    : 'Application submitted. Returned to Naukri; restore your Master Resume on your Naukri profile.', 'success');
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
  if (!activeResumeWorkflow || !lastAnalysis) return setStatus('Wait for job analysis before generating a tailored resume.', 'error');
  tailorGenerationInProgress = true;
  updatePrimaryAction();
  try {
    const job = currentJobPayload();
    const generated = await generateResumeStep(job);
    const saved = await chrome.storage.local.get(['fullName']);
    const candidateName = (saved.fullName || $('fullNameInput').value || $('resumeText').value.split(/\r?\n/).find(line => line.trim()) || '').trim();
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
      lastError: '', formatNote: generated.formatNote || ''
    });
    await loadWorkflowResumePreview();
    setStatus('Tailored resume generated.', 'success');
  } catch (error) {
    await persistResumeWorkflow({ ...activeResumeWorkflow, lastError: `Tailored resume generation failed: ${error.message}` });
    setStatus(`Could not generate tailored resume: ${error.message}`, 'error');
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
      }).join('\n');
      const bodyText = document.body?.innerText || '';
      const text = `${selectedText}\n${bodyText}`;
      const hasName = text.toLowerCase().includes(expected.toLowerCase());
      const successTexts = (siteConfig.successSelectors || []).flatMap(selector => {
        try { return [...document.querySelectorAll(selector)].filter(visible).map(element => element.innerText || element.textContent || ''); }
        catch { return []; }
      }).join('\n');
      const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toLowerCase();
      const successSignal = /(?:uploaded\s+successfully|successfully\s+(?:uploaded|updated)|resume\s+(?:uploaded|updated)|upload\s+complete)/i.test(successTexts)
        || /uploaded\s+on\s+today/i.test(text)
        || text.toLowerCase().includes(`uploaded on ${today}`)
        || /(?:resume\s+(?:uploaded|updated)\s+successfully|successfully\s+(?:uploaded|updated))/i.test(bodyText);
      const fileNames = [...new Set((text.match(/[A-Z0-9][A-Z0-9 _().-]*\.(?:docx?|pdf)/gi) || []).map(value => value.trim()))].slice(0, 6);
      const relevantLines = text.split(/\n+/).map(line => line.trim()).filter(line => /resume|upload|\.(?:docx?|pdf)/i.test(line)).slice(0, 8);
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
        await generateTemporaryResumeForActiveJob();
        workflow = activeResumeWorkflow;
        if (workflow?.selectedType !== 'tailored' || !workflow.temporaryResumeId) throw new Error(workflow?.lastError || 'Could not generate the tailored resume.');
      }
    }
    const file = await selectedWorkflowFile(workflow);
    if (workflow.companyApplyUrl && await openCompanyApplicationDirectly(workflow)) return;
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
      await chrome.storage.local.set({
        [cacheKey]: { overview: lastAnalysis, savedAt: Date.now() },
        activeJobAnalysis: lastAnalysis
      });
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
    const normalized = {
      ...data,
      scores: Object.fromEntries(['skills', 'experience', 'keywords', 'education']
        .map(key => [key, normalizeScore(data.scores[key])]))
    };
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
  const totalScore = result?.matchScore ?? null;
  const quick = source === 'quick';
  const overview = $('matchOverview');
  overview.replaceChildren();

  const header = document.createElement('div');
  header.className = 'match-heading';
  const titleStack = document.createElement('div'); titleStack.className = 'match-title-stack';
  const heading = document.createElement('h2'); heading.textContent = 'Match Analysis';
  titleStack.append(heading);
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
  const rows = [
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
  renderImprovementAreas(result);
  renderFitChecks(result.fitChecks || []);
  renderSkillBreakdown(result);
  updateActionBar();
  if (!quick && activeResumeWorkflow && !['MASTER_RESUME_SELECTED', 'TAILORED_RESUME_GENERATED', 'WAITING_FOR_PROFILE_UPLOAD', 'TEMPORARY_RESUME_UPLOADED', 'MASTER_RESUME_UPLOADED', 'APPLICATION_IN_PROGRESS', 'APPLICATION_SUBMITTED', 'RESTORATION_PENDING', 'MASTER_RESUME_RESTORED', 'RESTORATION_FAILED', 'APPLICATION_CANCELLED'].includes(activeResumeWorkflow.status)) {
    void persistResumeWorkflow({ ...activeResumeWorkflow, status: 'JD_ANALYZED', matchScore: result.matchScore, analysisAt: new Date().toISOString() });
  } else {
    renderResumeWorkflow();
  }
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
    title.textContent = ({ location: 'Location', workMode: 'Work Mode', education: 'Education', experience: 'Experience', noticePeriod: 'Notice Period' })[item.type] || item.type || 'Eligibility';
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
  const tech = normalizeAnalysisItems(matched.technical);
  const soft = normalizeAnalysisItems(matched.soft);
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
  const missing = normalizeAnalysisItems(result.missingSkills);
  $('missingSkillsHeading').textContent = `Missing Skills (${missing.length})`;
  if (missing.length) renderChipList($('missingSkillsList'), missing, 'missing');
  else renderChipList($('missingSkillsList'), [], 'empty', 'No important missing technical skills identified.');
  const keywords = meaningfulMissingKeywords(result.missingKeywords, missing);
  $('relatedKeywordsGroup').classList.toggle('hidden', !keywords.length);
  $('relatedKeywordsHeading').textContent = `Related Keywords (${keywords.length})`;
  renderChipList($('missingKeywordsList'), keywords, 'keyword');
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
  return [...new Set(normalizeAnalysisItems(values).filter(value => {
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
  const source = fullName?.trim() || masterText.split(/\r?\n/).find(line => line.trim()) || 'Candidate';
  const firstPart = safeFilenamePart(source.split(/\s+/)[0]).replace(/_/g, '') || 'Candidate';
  const today = new Date();
  const date = [String(today.getDate()).padStart(2, '0'), String(today.getMonth() + 1).padStart(2, '0'), today.getFullYear()].join('-');
  return `${firstPart}_${date}.docx`;
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

$('generateBtn').addEventListener('click', async () => {
  if (activeResumeWorkflow?.status === 'APPLICATION_IN_PROGRESS' && activeResumeWorkflow.companyApplicationTabId) {
    try { await submitCompanyApplication(); }
    catch (error) { setStatus(error.message, 'error'); }
    return;
  }
  let companyPermissionRequest = null;
  const companyApplyUrl = activeResumeWorkflow?.companyApplyUrl || jobMetadata.companyApplyUrl;
  if (lastAnalysis && companyApplyUrl) {
    try {
      const destination = new URL(companyApplyUrl);
      if (destination.protocol === 'https:' && !/(^|\.)naukri\.com$/i.test(destination.hostname)) {
        companyPermissionRequest = chrome.permissions.request({ origins: [`${destination.origin}/*`] });
      }
    } catch { /* Continue with the Naukri Apply action if no safe company URL was captured. */ }
  }
  if (companyPermissionRequest && !(await companyPermissionRequest)) {
    setStatus('Allow access to the company site to fill its application form, then click Tailor & Apply again.', 'info');
    return;
  }
  if (!lastAnalysis) { await analyzeCurrentMatch(false); return; }
  if (activeResumeWorkflow?.applicationStartFailed) {
    try { await returnToJobAndClickApply(activeResumeWorkflow.profileTabId); }
    catch (error) { setStatus(error.message, 'error'); }
    return;
  }
  renderResumeWorkflow();
  $('applyResumePreview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await chooseResumeForThisJob();
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
