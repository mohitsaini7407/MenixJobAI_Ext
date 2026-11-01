const $ = (id) => document.getElementById(id);
const DEFAULT_API = 'http://localhost:8080/api';
let apiBase = DEFAULT_API;
let lastAnalysis = null;
let generatedBlobUrl = null;

function setStatus(message, type = 'info') {
  const el = $('status'); el.textContent = message;
  el.style.borderColor = type === 'error' ? '#9f4545' : type === 'success' ? '#17635d' : '#2c4567';
}
function cleanText(value) { return (value || '').replace(/\s+/g, ' ').trim(); }
function currentJobPayload() {
  return { title: cleanText($('jobTitleInput').value) || 'Untitled job', company: cleanText($('companyInput').value), location: cleanText($('locationInput').value), description: $('jobDescription').value.trim(), url: cleanText($('jobUrl').value) };
}
async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);
  if (!response.ok) throw new Error((await response.text()) || `Backend returned ${response.status}`);
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response;
}
async function loadSettings() {
  const saved = await chrome.storage.local.get(['apiBase','resumeText','resumeName']);
  apiBase = saved.apiBase || DEFAULT_API;
  $('apiBase').value = apiBase;
  if (saved.resumeText) $('resumeText').value = saved.resumeText;
  if (saved.resumeName) $('resumeStatus').textContent = `Loaded saved resume: ${saved.resumeName}`;
}
$('settingsToggle').addEventListener('click', () => $('settings').classList.toggle('hidden'));
$('saveSettings').addEventListener('click', async () => {
  const value = $('apiBase').value.trim().replace(/\/$/, '');
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api$/.test(value)) return setStatus('For this local build, use http://localhost:8080/api or http://127.0.0.1:8080/api.', 'error');
  apiBase = value; await chrome.storage.local.set({apiBase}); setStatus('Backend URL saved.', 'success');
});

$('captureBtn').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || !tab.url) throw new Error('No active tab found. Open a job page first.');
    const url = new URL(tab.url);
    if (url.hostname !== 'naukri.com' && !url.hostname.endsWith('.naukri.com')) throw new Error('Open a Naukri job page before capturing. You can still paste a description manually.');
    const granted = await chrome.permissions.request({origins:['https://www.naukri.com/*','https://*.naukri.com/*']});
    if (!granted) throw new Error('Page access was not granted. Paste the job description manually instead.');
    const [{result}] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:() => ({title:document.title,url:location.href,text:document.body?.innerText?.slice(0,24000)||'',heading:document.querySelector('h1')?.textContent?.trim()||''})});
    const pageText = result?.text || '';
    if (pageText.length < 100) throw new Error('Not enough visible page text was found. Use the manual paste option.');
    $('jobUrl').value = result.url;
    $('jobTitleInput').value = result.heading || result.title.replace(/\s*[-|].*$/, '');
    $('jobDescription').value = pageText;
    $('jobTitle').textContent = $('jobTitleInput').value || 'Naukri job page captured';
    $('jobMeta').textContent = `Captured visible page text from ${url.hostname}. Review and remove irrelevant page content before analysis.`;
    setStatus('Visible page text captured. Review the description before sending it to AI.', 'success');
  } catch (error) { setStatus(error.message, 'error'); }
});
$('clearJob').addEventListener('click', () => {
  ['jobTitleInput','companyInput','locationInput','jobUrl','jobDescription'].forEach(id => $(id).value='');
  $('jobTitle').textContent='No job captured yet'; $('jobMeta').textContent='Open a Naukri job and choose Capture visible job, or paste its details below.';
  $('analysis').classList.add('hidden'); $('generateBtn').disabled=true; $('continueBtn').disabled=true; lastAnalysis=null;
});
$('saveJobBtn').addEventListener('click', async () => {
  const job=currentJobPayload();
  if (!job.description) return setStatus('Add a job description before saving.', 'error');
  try {
    const saved=await api('/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:job.title,company:job.company,location:job.location,workMode:'Not specified',experience:'Not specified',source:'Naukri (user captured)',description:job.description.slice(0,12000),originalUrl:job.url,applicationUrl:job.url,status:'SAVED'})});
    setStatus(`Job saved in MenixJobAI${saved?.id?` (ID ${saved.id})`:''}.`, 'success');
  } catch(error) { setStatus(`Could not save job: ${error.message}`, 'error'); }
});
$('resumeFile').addEventListener('change', async (event) => {
  const file=event.target.files?.[0]; if(!file) return;
  const form=new FormData(); form.append('file',file);
  try {
    setStatus('Extracting text from your resume...');
    const data=await api('/resumes/extract-text',{method:'POST',body:form});
    $('resumeText').value=data.text||'';
    await chrome.storage.local.set({resumeText:data.text||'',resumeName:file.name});
    $('resumeStatus').textContent=`Extracted ${data.characters||0} characters from ${file.name}. Review the text.`;
    setStatus('Resume text extracted. Check it for accuracy.', 'success');
  } catch(error) { setStatus(`Resume extraction failed: ${error.message}. You can paste resume text manually.`, 'error'); }
});
$('saveResumeBtn').addEventListener('click', async () => {
  const text=$('resumeText').value.trim(); if(!text) return setStatus('Paste or upload your master resume first.', 'error');
  await chrome.storage.local.set({resumeText:text,resumeName:$('resumeFile').files?.[0]?.name||'Pasted master resume'});
  $('resumeStatus').textContent='Master resume saved in this Brave browser profile.';
  setStatus('Master resume saved locally.', 'success');
});
$('analyzeBtn').addEventListener('click', async () => {
  const resumeText=$('resumeText').value.trim(), jobDescription=$('jobDescription').value.trim();
  if(!resumeText) return setStatus('Add your master resume first.', 'error');
  if(!jobDescription) return setStatus('Add the job description first.', 'error');
  try {
    $('analyzeBtn').disabled=true; $('analyzeBtn').textContent='Analyzing...';
    const data=await api('/ai/tailor-review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resumeText,jobDescription})});
    if(data.error) throw new Error(data.error);
    lastAnalysis=data; renderAnalysis(data);
    $('generateBtn').disabled=false;
    setStatus('Analysis complete. Review all AI suggestions before generating a resume.', 'success');
  } catch(error) { setStatus(`Analysis failed: ${error.message}`, 'error'); }
  finally { $('analyzeBtn').disabled=false; $('analyzeBtn').textContent='✦ Analyze job & resume'; }
});
function renderAnalysis(data) {
  const box=$('analysis'); box.classList.remove('hidden');
  const raw=data.review?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('\n') || JSON.stringify(data.review||data,null,2);
  box.innerHTML=`<h3>AI review received</h3><p>${escapeHtml(data.notice||'Review every suggestion before using it.')}</p><pre></pre>`;
  box.querySelector('pre').textContent=raw;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
$('generateBtn').addEventListener('click', async () => {
  const resumeText=$('resumeText').value.trim(), jobDescription=$('jobDescription').value.trim();
  if(!lastAnalysis) return setStatus('Analyze the job and resume first.', 'error');
  try {
    $('generateBtn').disabled=true; $('generateBtn').textContent='Generating DOCX...';
    const response=await fetch(`${apiBase}/ai/tailor-docx`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resumeText,jobDescription,fullName:'Mohit Saini'})});
    if(!response.ok) throw new Error(await response.text()||`HTTP ${response.status}`);
    const blob=await response.blob(); if(generatedBlobUrl) URL.revokeObjectURL(generatedBlobUrl); generatedBlobUrl=URL.createObjectURL(blob);
    const disposition=response.headers.get('content-disposition')||''; const match=disposition.match(/filename="?([^";]+)"?/i);
    const filename=match?.[1]||`MohitSaini_${new Date().toISOString().slice(0,10)}.docx`;
    const link=document.createElement('a'); link.href=generatedBlobUrl; link.download=filename; link.click();
    $('fileResult').classList.remove('hidden'); $('fileResult').textContent=`Generated and downloaded: ${filename}. Review the document before applying.`;
    $('continueBtn').disabled=!currentJobPayload().url;
    setStatus('Tailored DOCX generated and downloaded. Review it before continuing.', 'success');
  } catch(error) { setStatus(`DOCX generation failed: ${error.message}`, 'error'); }
  finally { $('generateBtn').disabled=false; $('generateBtn').textContent='Generate tailored DOCX'; }
});
$('continueBtn').addEventListener('click', async () => {
  const url=currentJobPayload().url;
  if(!url || !/^https:\/\//i.test(url)) return setStatus('A valid HTTPS job URL is required.', 'error');
  await chrome.tabs.create({url,active:true});
  setStatus('Opened the job application page. Upload your reviewed resume and submit manually.', 'success');
});
loadSettings().catch(error=>setStatus(error.message,'error'));
