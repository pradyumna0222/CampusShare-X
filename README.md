# CampusShare X

**The trust layer for shared resources.** CampusShare X is a full-stack resource-sharing application for a university or similar institution. It connects resource discovery to eligibility checks, owner approvals, fair-use limits, condition-recorded handovers, return/extension workflows, incident review and an audit trail.

> **Important:** The local starter catalogue contains fictional example resources and local accounts. Replace them with inventory and accounts that the institution has authorised you to use. Do not use confidential campus records in the hackathon submission.

## What is implemented

- **Authenticated accounts:** password hashing, HTTP-only server-managed sessions, sign-out, registration and administrator review of newly registered students.
- **Separate roles:** student/requester, resource owner and administrator. Owners can manage resources they own; administrators can review users, verify training and inspect institutional activity.
- **Persistent data:** SQLite database stored on disk; data is shared by authenticated users of the same running instance and persists across app restarts when the data directory is persistent.
- **Resource catalogue:** equipment and spaces with location, categories, capability tags, owner, access requirements, instructions and status.
- **SmartMatch:** turns project descriptions into allowed capability tags, ranks catalogue resources and explains matches. It uses an optional server-side LLM for intent extraction and falls back to deterministic matching when the provider is not configured or fails. Match score is relevance, not availability or permission.
- **Eligibility enforcement:** institutional-profile verification and resource-specific required training are validated on the server when requests are submitted, approved and checked out.
- **Schedule availability:** the app shows confirmed bookings, competing pending/waitlisted requests and recorded time blocks for the selected date. Booking and approval endpoints recheck scheduling conflicts server-side.
- **FairShare controls:** maximum of three active/upcoming reservations per user, explainable waitlisting, oldest-first review display, owner-visible decision reasons and automatic waitlisting of overlapping pending requests when a competing request is approved.
- **Owner operations:** create resources, change operational status and record future unavailability/maintenance blocks.
- **Complete booking lifecycle:** request, approve, reject, waitlist, cancel, check-in with initial condition, return with final condition, extension request/decision and incident review.
- **Resource Passport and audit:** resource activity, condition records, decision history and authorised CSV export. Application routes do not provide edits/deletes to past audit events.
- **In-app notifications:** booking decisions, verification, extensions, incidents, upcoming bookings, return reminders and overdue returns. Email, WhatsApp and SMS delivery are not included.
- **Analytics:** counts and usage summaries are calculated from stored data; sample catalogue values are not real institutional measurements.
- **Security measures:** `bcryptjs` password hashing, opaque hashed session tokens, HTTP-only cookies, rate limiting for authentication, Helmet headers, input validation, role/owner checks and same-origin protection for state-changing production requests.

## Requirements

- Node.js 22.15+ (Node.js 24 LTS is recommended; this project pins a `better-sqlite3` version with Node 24 prebuild support)
- npm 10+
- Internet access during the first `npm install` to retrieve packages

## Run on Windows (PowerShell)

**Extract the ZIP first. Open PowerShell inside the folder that contains `package.json`.** In File Explorer, that folder should contain `src`, `server`, `docs`, `package.json` and `.env.example` together. Do not run npm from a parent folder or from `src`.

```powershell
# Check you are in the project root:
Get-ChildItem package.json

# Create your local environment file:
Copy-Item .env.example .env

# Install project dependencies:
npm install

# Start the API and React frontend together:
npm run dev
```

Open **http://localhost:5173** in your browser. Vite forwards `/api` requests to the local Express API on port 3001. Keep the terminal running while using the application.

If `Get-ChildItem package.json` says the file is missing, run `Get-ChildItem` and enter the inner folder that contains the package file. If `npm install` fails under Node 24 with `better-sqlite3`, `prebuild-install`, or `node-gyp` errors, use the fixed `better-sqlite3` 12.x dependency in this package. If you previously attempted installation, clean the partial install before retrying:

```powershell
# Stop the app and close terminals running it first.
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force .\node_modules -ErrorAction SilentlyContinue
Remove-Item -Force .\package-lock.json -ErrorAction SilentlyContinue
npm cache verify
npm install
```

If PowerShell reports `EPERM` while removing `node_modules`, close VS Code terminals and any Node.js processes, then rerun the removal command. Do not delete `.env` or the `data` folder as part of this cleanup. If `npm install` instead reports a network/DNS error (`EAI_AGAIN`), check your internet connection and make sure a proxy/firewall is not blocking `registry.npmjs.org`.

### Local starter accounts

These credentials are for a local development database created from the supplied `.env.example` only. They must **never** be used on a public deployment.

| Role | Email | Password |
|---|---|---|
| Student | `student@campusshare.local` | `CampusStudent!2026` |
| Second student (queue testing) | `student2@campusshare.local` | `CampusStudent2!2026` |
| Resource owner | `owner@campusshare.local` | `CampusOwner!2026` |
| Administrator | `admin@campusshare.local` | `CampusAdmin!2026` |

The seed records let the team test multi-role flows locally. Newly registered student accounts start as **pending verification** and cannot book until an administrator reviews them. A verified student may be assigned the owner role by an administrator; the API prevents users from granting themselves a role.

### Useful commands

```powershell
npm run dev       # Development server: React + API
npm run build     # TypeScript project build and production frontend bundle
npm start         # Serve the built frontend and API from the same Express process
npm test          # API integration test against a temporary SQLite database
npm run typecheck # TypeScript project checks
```

A production build is served by Express at the `PORT` environment variable (default 3001). `npm start` expects `npm run build` to have completed first.

## Database and data location

The server writes to `DATA_DIR/campushare.sqlite`. Local default: `./data/campushare.sqlite`. The SQLite database is created automatically on startup. Never delete the database while the server is running. Back it up with the server stopped, and keep it outside version control.

SQLite is a good fit for a hackathon and a single app instance. For a horizontally scaled production deployment, use a managed relational database and migrate the booking-conflict rules to transactions/constraints appropriate to that database. A hosted SQLite deployment needs a persistent disk and should run a single instance.

## SmartMatch language-model setup (optional)

SmartMatch works without an AI key. To enable LLM-assisted requirement extraction, set `OPENAI_API_KEY` in the **server-side** environment. Optionally set `OPENAI_BASE_URL` and `OPENAI_MODEL`. Do not place the key in a `VITE_*` variable or commit it. Only the model's capability tags that match the resource catalogue's allowlist are accepted. If the provider is down, the deterministic tag matcher is used. Do not enter confidential or personal data into the AI prompt.

## Production configuration

Never deploy the example local passwords. Use your hosting provider's secret/environment-variable settings. Set at least:

```text
NODE_ENV=production
PORT=<provided by host>
DATA_DIR=<persistent disk path>
APP_TIMEZONE=Asia/Kolkata
BOOKING_TIMEZONE_OFFSET_MINUTES=330
SEED_INITIAL_ACCOUNTS=true        # Needed only when first seeding an empty database
INITIAL_STUDENT_EMAIL=<unique, controlled account email>
INITIAL_STUDENT_PASSWORD=<unique secret, at least 12 chars>
INITIAL_OWNER_EMAIL=<unique, controlled account email>
INITIAL_OWNER_PASSWORD=<unique secret, at least 12 chars>
INITIAL_ADMIN_EMAIL=<unique, controlled account email>
INITIAL_ADMIN_PASSWORD=<unique secret, at least 12 chars>
SEED_INITIAL_RESOURCES=true       # Optional fictional starter catalogue for judging only
```

On first boot with an empty database, production requires secure initial student, owner and administrator credentials. `SEED_INITIAL_RESOURCES=true` loads fictional starter inventory; leave it unset/false if the institution wants to create its own resources from an empty catalogue. Once accounts/resources are created, the database persists them.

### Deploying a public judge-accessible version (Render Blueprint)

The repository includes `render.yaml` for a single Node web service. It uses SQLite on a persistent disk so bookings and audit records survive a restart/redeploy. **Render's persistent disks are attached to paid services**, so review current pricing before creating the service. The Blueprint intentionally uses a paid `starter` web service; it is not a free deployment configuration. Render documents persistent storage here: <https://render.com/docs/disks> and Blueprint configuration here: <https://render.com/docs/blueprint-spec>.

1. Create a GitHub repository for the project. Review the files first and confirm `.env`, database files and secrets are excluded. The repository must contain `package.json` and `render.yaml` at its root.
2. Push the source code to GitHub.
3. In Render, create a new **Blueprint** and select this repository. Review `render.yaml`; the service plan is `starter` because the SQLite database requires persistent storage.
4. When prompted for the `sync: false` values, enter unique emails/passwords for the initial student, second student, owner and administrator. Use passwords of at least 12 characters. Do not use the local credentials listed above. These credentials seed the first accounts on an empty database and must be saved securely for the judge instructions.
5. Confirm the disk mount is `/var/data` and `DATA_DIR=/var/data`. Keep the service to one instance while using SQLite. Do not change the mount path unless you also change `DATA_DIR`.
6. Wait for the build/deploy to finish. Open `https://<your-service>.onrender.com/api/health`; it should return `{"status":"ok"}`. Open the service URL, sign in with the configured initial accounts, and test the full workflow on the deployed site.
7. Verify persistence by creating a test resource/booking, restarting the service from the Render dashboard, and checking the record still exists. Remove test records or reset the data before giving access to judges if appropriate.
8. Add the stable application URL and source repository URL to `docs/TEAM_AND_SUBMISSION.md`. Provide role-appropriate judge credentials using the organiser's approved secure method. Keep the service, database disk and repository accessible through judging.

This blueprint does not deploy itself and does not create accounts in your hosting/GitHub profile. You must complete the host account, provide the secrets and authorise deployment. If the event requires a free-only host, do not use this SQLite blueprint without verifying persistence first; use a managed database design instead.

## Verification before submission

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Then follow `docs/TEST_PLAN.md` and `tests/MANUAL_ACCEPTANCE_TESTS.md` against the running application. Record actual results; do not claim a test passed until it has been run. The project was assembled in an environment that could not reach the npm registry, so dependency installation and the full build need to be verified on a network-enabled development machine.

## Submission documents

- `docs/PROJECT_REPORT.md` — problem, solution, workflow, architecture, security, fairness, limitations and future work.
- `docs/ARCHITECTURE.md` — component boundaries and data flow.
- `docs/TEST_PLAN.md` — automated/manual test plan and results template.
- `docs/PITCH.md` — project pitch and demonstration script.
- `docs/TEAM_AND_SUBMISSION.md` — fill in actual team names, roles, contribution and disclosures.

## Responsible use and event rules

The problem statement says the submitted product must be developed during the official 48-hour build window, and that significant AI/tool use and pre-existing components must be disclosed. Confirm with the organisers whether this generated project may be used as a starting point. Do not falsely state that code was created during the official window if it was not; disclose AI assistance and all pre-existing libraries/components accurately. Use only fictional/anonymised demonstration data unless real inventory is authorised.

## Current limitations

- The initial inventory is fictional starter data and must be verified/replaced before real institutional use.
- Notifications are in-app only; no email/WhatsApp/SMS integration is wired.
- Condition reports are text-based; image upload and automated image comparison are not implemented.
- Eligibility currently checks account verification and named training records; institution-specific memberships, deposits and supervised-use scheduling need further configuration if required.
- FairShare uses transparent limits, request-order display, owner review and waitlisting; it is not a learned or formally optimised allocation model.
- The app has not been security-audited for deployment handling real institutional data. Review configuration, backup, retention, access policy and incident-response procedures before production use.
