# MenixJobAI

A fresh desktop job-search and application-management starter built with Electron, React, Spring Boot, PostgreSQL and Gemini.

## Included in this first runnable version
- Electron desktop shell with React/Vite renderer
- Spring Boot REST API
- PostgreSQL schema and Docker Compose
- Editable candidate profile and job-search preferences
- Job CRUD (create, list, update status, delete)
- Resume upload and local storage
- Gemini API configuration stored on backend
- Resume/JD analysis endpoint (suggestions only; user reviews output)
- Saved application Q&A memory
- Application tracker
- `.env.example`, `.gitignore`, setup instructions

## Requirements
- Node.js 20+
- Java 17+
- Maven 3.9+
- Docker Desktop (recommended) or PostgreSQL 15+

## 1. Configure environment
Copy `.env.example` to `.env` in the project root and edit values.
Never commit `.env` or your Gemini key.

## 2. Start PostgreSQL
```bash
docker compose up -d db
```

## 3. Start backend
```bash
cd backend
# Linux/macOS:
export DB_URL=jdbc:postgresql://localhost:5432/menixjobai
export DB_USERNAME=menix
export DB_PASSWORD=menix_local_password
export GEMINI_API_KEY=your_key_here
mvn spring-boot:run
```
Windows PowerShell:
```powershell
$env:DB_URL="jdbc:postgresql://localhost:5432/menixjobai"
$env:DB_USERNAME="menix"
$env:DB_PASSWORD="menix_local_password"
$env:GEMINI_API_KEY="your_key_here"
mvn spring-boot:run
```
Backend: http://localhost:8080/api/health

## 4. Start desktop app
In another terminal:
```bash
cd frontend
npm install
npm run dev
```
This starts the Vite UI at http://localhost:5173. For the Electron desktop shell:
```bash
npm run electron
```
Run `npm run build` to build the React UI.

## Gemini
Create a key at https://aistudio.google.com/apikey. Set `GEMINI_API_KEY` in the backend environment only.
The API uses a configurable model name (default `gemini-2.5-flash`). Availability and free-tier quotas vary by account/model. Do not send sensitive data unless you have reviewed Google's data-use terms. The current implementation sends only the resume text and job description supplied to the analysis endpoint.

## Important limitations
- Job discovery currently supports manual job entry. Live portal connectors are not enabled in this starter.
- No CAPTCHA bypass, bulk auto-apply, or hidden portal scraping is implemented.
- Resume tailoring produces suggestions; it does not invent experience or overwrite the master resume.
- Final submission is always a user action. The tracker status is manually editable until a verified integration exists.
- Resume file storage is local in `backend/uploads`; back it up and protect access.
- This is a local-development starter, not production-hardened multi-user software. Add authentication, authorization, encryption, migrations, audit logs and secure deployment before exposing it to the internet.

## Render production environment

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the Render service. `GEMINI_MODEL` currently accepts `gemini-2.5-flash`, `gemini-2.5-flash-lite`, or `gemini-2.5-pro`. Set `GEMINI_DIAGNOSTICS_TOKEN` to a long random secret; the admin-only Gemini configuration checks require it in the `X-Diagnostics-Token` request header. Never expose this token in the extension.

Set `DB_URL` (or Spring's standard `SPRING_DATASOURCE_URL`) to the PostgreSQL JDBC URL with TLS and bounded connection timeouts, for example `jdbc:postgresql://HOST:5432/DATABASE?sslmode=require&connectTimeout=10&socketTimeout=30`, and set `DB_USERNAME` and `DB_PASSWORD` separately. Do not paste Render's `postgres://...` URL into `DB_URL`; use the database host and name to form a `jdbc:postgresql://...` URL. Keep `DB_PASSWORD` out of logs and source control. Once the production tables exist, set `DDL_AUTO=none` on Render; local development defaults to `update`. The sample `.env.example` uses `sslmode=disable` only for the local Docker Compose PostgreSQL container, which does not enable TLS by default. There is no localhost database fallback in the app: set a URL for local development and Render.

The API health endpoint `/api/health` is a lightweight liveness check. `/api/health/deep` also checks PostgreSQL and should be used only when a database check is wanted. A scheduled GitHub Actions workflow pings the liveness endpoint every 10 minutes.
