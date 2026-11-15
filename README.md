# CareSync AI

CareSync AI is a responsive family-care coordination application. It includes a React/Vite client and FastAPI API with SQLite for local development and PostgreSQL support. Medication adherence, wellness routines, appointments, collaboration notes, and prescription review are stored separately.

CareSync AI starts with an empty database. Create an account and your own profile, or register and join another person's care team with their invitation code. Do not enter real patient information until you have completed a security, privacy, regulatory, and clinical review for your deployment.

## Requirements

- Python 3.11 or newer (Python 3.12 recommended)
- Node.js 20 or newer and npm
- SQLite for local use, or a PostgreSQL 14+ database for a hosted environment
- Optional: SMTP account for email delivery
- Tesseract OCR 5 with the English language model for local image OCR
- Optional: PostgreSQL 14+ database, SMTP account, or OpenFDA API key

## Local Setup (Windows PowerShell)

Open PowerShell in this project folder:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item _.env.example .env
```

Edit `.env`. Generate a unique signing secret:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Set the printed value as `SECRET_KEY`. Keep `.env` private and out of source control. The default database is a local SQLite file named `caresync.db`.

Install and start the frontend in a second PowerShell terminal:

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). Start the API in the first terminal:

```powershell
uvicorn main:app --reload --env-file .env
```

The API documentation is at `http://localhost:8000/docs`.

## First-time User Flow

1. Open the Vite URL and register with your email and a password of at least eight characters. Registration signs you in automatically.
2. Create a patient profile by entering the patient's name. The account that creates it controls sharing and permissions.
3. To join as family or caretaker, register your own account first, then enter the invitation code provided by the patient. The patient's invitation determines your role; access starts with limited permissions.
4. The dashboard and available actions reflect your role on the selected profile. The patient can invite people, grant or revoke permissions, and remove access from Care team.

The local database is empty until a user registers and creates a profile. No demo users, medicines, appointments, or health records are preloaded.

## Configuration and Where to Get It

- `SECRET_KEY`: generate locally with the command above. Never reuse the example placeholder or expose this value in frontend code.
- `DATABASE_URL`: SQLite needs no external account. For PostgreSQL, create a database with a provider such as Neon, Supabase, Render, or a managed cloud PostgreSQL service, then use a SQLAlchemy URL like `postgresql+psycopg://USER:PASSWORD@HOST:5432/DATABASE`. URL-encode special characters in the password.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`: obtain these from your email provider. For Gmail, enable two-step verification and create an App Password; do not use your normal account password. Common submission port is 587 with STARTTLS. Mailtrap is useful for non-delivery testing; SendGrid and other transactional email providers supply SMTP credentials and require a verified sender.
- `CORS_ORIGINS`: comma-separated frontend origins, for example `https://care.example.com`. Do not use `*` with credentials in a real deployment.
- `VITE_API_URL`: public API base URL only, for example `https://api.example.com`. Never put passwords, SMTP credentials, or signing secrets in a `VITE_` variable.
- `OCR_ENABLED=1`: enables local Tesseract analysis (enabled by default in `_.env.example`). Install Tesseract 5 and its English (`eng`) language data on the backend host. On Windows the app checks `C:\Program Files\Tesseract-OCR\tesseract.exe`; otherwise set `TESSERACT_CMD` or add Tesseract to `PATH`. Text PDFs are read directly and scanned PDFs are rasterized with PyMuPDF, up to `MAX_PDF_OCR_PAGES`. Tesseract is not a handwriting specialist; handwriting and low-quality scans may produce no or uncertain text. The UI shows extracted text and OCR engine confidence, which is not medicine-match confidence.
- Medicine matching uses the US National Library of Medicine RxNorm/RxNav REST API. Exact/normalized name matches can be verified; approximate RxNorm suggestions stay yellow until the patient explicitly confirms one. FDA label details come from the public openFDA drug-label API and link to DailyMed when a label set is available. These APIs require no key for basic use; `OPENFDA_API_KEY` is optional for higher rate limits. The application does not generate medical information with an LLM; missing fields remain explicitly unavailable.
- Prescription uploads and medicine identity matches remain separate from the active medication plan. No medicine is added and no dosage is changed from OCR or match confirmation. A database name match does not confirm that a prescription is correct for a specific patient; consult a qualified pharmacist or clinician.
- `UPLOAD_DIR`: private local storage path for prescription files. For deployment, use private object storage with encryption, access controls, retention limits, and backups rather than a public web directory.

When SMTP is unset, the notification centre records `not_sent_smtp_not_configured`; the application does not claim an email was sent. The scheduler checks medication and appointment reminders in the API process. Keep a single scheduler process or use a production job queue/leader lock when scaling multiple API workers.

## Tests and Production Build

```powershell
python -m pytest -q
npm run build
```

Tests cover registration/login, invitation single-use, patient isolation, patient-controlled permissions, medication scheduling and confirmation, appointments, routines, notes, handovers, and prescription review without automatic medication activation.

## Deployment Checklist

1. Use managed PostgreSQL and set `DATABASE_URL`, a generated `SECRET_KEY`, `CORS_ORIGINS`, SMTP variables, and `UPLOAD_DIR` in the hosting provider's secret/environment settings.
2. Deploy the API with `uvicorn main:app --host 0.0.0.0 --port $PORT` (adapt the port syntax to the host) and the frontend as a static Vite build. Set `VITE_API_URL` at frontend build time.
3. Use a platform that provides HTTPS, private networking where possible, encrypted database/storage, backups, log redaction, monitoring, and key rotation. Do not expose uploaded prescriptions through a public static-file server.
4. Configure a durable, single-instance scheduler or an external job queue before running multiple API workers.
5. Add production-grade distributed rate limiting, email delivery retries/webhooks, database migrations, secret rotation, account recovery, retention/deletion workflows, and operational alerting before serving real patients.

## Important Limitations

This repository is a functional development foundation, not a certified healthcare product or a claim of HIPAA/GDPR compliance. It does not replace professional medical advice. The current login throttle is process-local, database startup uses SQLAlchemy table creation plus a small compatibility migration rather than a full Alembic migration history, and local uploads are stored on disk. A qualified security/privacy review, threat model, reliable migrations, production storage, and jurisdiction-specific legal review are required before real health data is used.
