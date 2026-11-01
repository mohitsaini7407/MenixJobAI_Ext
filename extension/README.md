# MenixJobAI Brave Extension

This is a Manifest V3 browser extension with a persistent side panel. It is designed for Brave (Chromium) and should also work in compatible Chrome versions.

## What it does

- Opens Menix AI in Brave's right-side panel.
- Lets you explicitly capture visible text from an open Naukri page after granting optional Naukri host access.
- Provides manual job-description and resume-text input as a fallback.
- Calls the existing Spring Boot backend for AI resume review.
- Extracts selectable text from uploaded PDF/DOCX resumes through a new backend endpoint.
- Generates a job-tailored DOCX through a new backend endpoint, using the filename `MohitSaini_YYYY-MM-DD.docx` (India date).
- Saves captured jobs through the existing `/api/jobs` endpoint.
- Opens the original job URL for you to upload the reviewed resume and submit manually.

It does not log into Naukri, access passwords/cookies, bypass anti-bot checks, click Apply, or submit applications.

## Install in Brave (developer/unpacked mode)

1. Start the MenixJobAI Spring Boot backend on `http://localhost:8080` and configure `GEMINI_API_KEY` in the backend environment.
2. Open Brave and visit `brave://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Choose this `extension` folder (the folder containing `manifest.json`).
6. Pin MenixJobAI from the Extensions menu.
7. Open Naukri in a tab and click the MenixJobAI toolbar icon. The side panel should appear.
8. In the side panel, keep the backend URL as `http://localhost:8080/api`.
9. Upload a selectable-text PDF/DOCX resume or paste resume text, then save it locally in the extension.
10. On a Naukri job page, click **Capture visible job**. Brave will ask permission to access Naukri pages; grant it if you want capture. Otherwise paste the job description manually.
11. Review the captured text, analyze, generate the DOCX, inspect it, then continue to the job URL and apply yourself.

## Backend configuration

Set `GEMINI_API_KEY` in the environment where Spring Boot runs. Do not place this key in extension files.

Windows PowerShell example:

```powershell
$env:GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
cd .\backend
mvn spring-boot:run
```

Use your existing PostgreSQL configuration. The backend uses `http://localhost:8080/api` by default.

## Limitations

- Naukri may block or change its page markup. The capture button reads visible page text only after a user action; manual paste is the reliable fallback.
- Scanned image-only PDFs may not contain selectable text. Use OCR separately or paste the resume text.
- AI-generated content must be checked for accuracy. The backend prompt explicitly forbids inventing experience or skills, but human review is still required.
- This is a local developer build, not a published Chrome Web Store/Brave store extension.
