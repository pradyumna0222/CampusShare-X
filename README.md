# CampusShare X

**The trust layer for shared resources.** CampusShare X is a full-stack resource-sharing web application for university campuses, research hubs, and institutional makerspaces. It connects resource discovery to eligibility enforcement, owner approvals, FairShare quotas, condition-recorded handovers, return/extension workflows, incident review, and a tamper-evident audit trail.

---

## Technology Stack

- **Frontend:** React 18 + TypeScript + Vite + Vanilla CSS design system + Lucide icons.
- **Backend:** Node.js 24 LTS + Express.js API.
- **Database:** PostgreSQL (production: [Neon Serverless PostgreSQL](https://neon.tech/); local/testing: `@electric-sql/pglite` embedded WASM PostgreSQL or local PostgreSQL instance).
- **Driver & Pool:** `pg` (Node-Postgres) connection pool with SSL encryption and row-level locking for conflict prevention.
- **Hosting:** [Render](https://render.com/) Free Web Service (`plan: free`) with same-origin frontend and API routing. Zero persistent disk cost.
- **Custom Domain:** Ready for custom `.xyz` domain mapping via DNS CNAME / ALIAS records.

---

## What is Implemented

- **Authenticated accounts:** Bcrypt password hashing, opaque random session tokens stored as SHA-256 hashes in PostgreSQL, HTTP-only SameSite cookies, sign-out, registration, and administrator institutional review.
- **Role-based access control (RBAC):** Student/requester, resource owner, and campus administrator. Owners manage only resources they own; administrators review users, verify training, and inspect institutional audit logs.
- **Persistent PostgreSQL database:** Versioned database migrations (`server/db/migrations/`) executed automatically on startup or via `npm run migrate`. Data survives all container restarts, redeployments, and host rebuilds.
- **Resource catalogue:** Hardware, equipment, and bookable spaces with locations, categories, capability tags, owners, safety requirements, instructions, and operational statuses.
- **SmartMatch AI:** Translates project descriptions into allowed capability tags, ranks catalogue items, and explains matches. Employs an optional server-side LLM for intent extraction with deterministic fallback when unconfigured. Match score reflects capability relevance, never bypassing availability or safety rules.
- **Strict eligibility enforcement:** Institutional verification and required training certifications are validated on the server at submission, approval, and check-in.
- **Concurrency & conflict prevention:** Calendar slots are re-evaluated inside PostgreSQL transactions with row-level locking (`SELECT ... FOR UPDATE`), preventing race conditions and simultaneous conflicting bookings.
- **FairShare controls:** Maximum of three active/upcoming reservations per user, transparent waitlisting, oldest-first review queues, and automatic waitlisting of overlapping pending requests when a competing request is approved.
- **Owner operations:** Register resources, update operational status, and schedule future unavailability/maintenance blocks.
- **Complete booking lifecycle:** Request, owner decision, waitlist, cancellation, check-in with initial condition report, return with final condition report, extension request/decision, and incident review.
- **Audit trail & CSV export:** Tamper-evident audit logs of all lifecycle actions with role-authorized CSV download (`/api/audit.csv`).
- **In-app notifications:** Real-time updates for approvals, waitlist updates, reminders, due returns, overdue notices, and incident resolutions.
- **Production security:** Helmet HTTP security headers, authentication rate limiter, input validation, same-origin guards for state-changing requests, and strict rejection of sample passwords in production.

---

## Local Development (Windows PowerShell)

### Prerequisites

- **Node.js:** 22.15+ (Node.js 24 LTS recommended)
- **npm:** 10+
- **Git**

### Step-by-Step Setup

```powershell
# 1. Verify you are in the project root containing package.json:
Get-ChildItem package.json

# 2. Switch to the Neon/Render deployment branch:
git checkout deploy/free-neon-render

# 3. Create your local environment configuration:
Copy-Item .env.example .env

# 4. Install dependencies:
npm install

# 5. Run database migrations:
npm run migrate

# 6. Start the API server and Vite frontend concurrently:
npm run dev
```

Open **http://localhost:5173** in your browser. Vite proxies `/api` calls to the Express server on port 3001.

### Local Starter Accounts

| Role | Email | Password |
|---|---|---|
| Student | `student@campusshare.local` | `CampusStudent!2026` |
| Second student (queue testing) | `student2@campusshare.local` | `CampusStudent2!2026` |
| Resource owner | `owner@campusshare.local` | `CampusOwner!2026` |
| Campus administrator | `admin@campusshare.local` | `CampusAdmin!2026` |

> **Note:** These credentials are for local development and test databases only. The application refuses to start in production if sample passwords are used.

### Verification Commands

```powershell
# Run the complete automated PostgreSQL test suite (10 test suites covering auth, RBAC, concurrency, and persistence):
npm test

# Run TypeScript typechecks:
npm run typecheck

# Build the production frontend bundle:
npm run build

# Start the production server locally:
npm start
```

---

## Deploying to Render Free with Neon PostgreSQL

Follow these steps to deploy CampusShare X completely free with persistent data storage.

### Phase 1: Create the Free Neon PostgreSQL Database

1. Go to **[https://neon.tech](https://neon.tech)** and sign up for a free account.
2. Click **Create Project**.
3. Name your project (e.g., `campushare-x-db`) and select the cloud region closest to your users (e.g., `AWS / us-east-2` or `eu-central-1`).
4. Keep PostgreSQL version at **16** (default) and click **Create Project**.
5. In the Neon dashboard **Connection Details** widget:
   - Select **Pooled connection** (uses PgBouncer, optimized for serverless).
   - Copy the connection string. It will look like:
     ```text
     postgresql://neondb_owner:YOUR_PASSWORD@ep-sample-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
     ```
6. Save this string securely. **Never commit this string to GitHub.**

---

### Phase 2: Deploy to Render Free

1. Push your updated code to your GitHub repository:
   ```powershell
   git push -u origin deploy/free-neon-render
   ```
2. Go to **[https://render.com](https://render.com)** and sign in.
3. Click **New +** and select **Blueprint**.
4. Connect your GitHub account and select your `CampusShare-X` repository.
5. Select the `deploy/free-neon-render` branch.
6. Render will automatically read `render.yaml`. Verify that:
   - **Service Name:** `campushare-x`
   - **Environment:** `Node`
   - **Plan:** `Free` (No persistent disk requested)
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
7. In the environment variables prompt (`sync: false`), supply your production values:

| Variable | Value | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require` | Your Neon connection string |
| `INITIAL_STUDENT_EMAIL` | `student@yourcampus.edu` | Unique production student email |
| `INITIAL_STUDENT_PASSWORD` | `<UniqueStrongPassword12+>` | Minimum 12 characters |
| `INITIAL_STUDENT2_EMAIL` | `student2@yourcampus.edu` | Unique second student email |
| `INITIAL_STUDENT2_PASSWORD` | `<UniqueStrongPassword12+>` | Minimum 12 characters |
| `INITIAL_OWNER_EMAIL` | `owner@yourcampus.edu` | Unique production owner email |
| `INITIAL_OWNER_PASSWORD` | `<UniqueStrongPassword12+>` | Minimum 12 characters |
| `INITIAL_ADMIN_EMAIL` | `admin@yourcampus.edu` | Unique production administrator email |
| `INITIAL_ADMIN_PASSWORD` | `<UniqueStrongPassword12+>` | Minimum 12 characters |
| `OPENAI_API_KEY` | *(Optional)* | For LLM SmartMatch capability extraction |

8. Click **Apply**.
9. Render will clone the repository, run `npm install`, compile the React frontend bundle (`npm run build`), apply PostgreSQL migrations (`server/db/migrations/001_initial_schema.sql`), seed initial accounts, and start Express on port 10000.

---

### Phase 3: Verify the Live Deployment

1. Check the health check endpoint in PowerShell:
   ```powershell
   # Replace with your Render URL:
   $AppUrl = "https://campushare-x.onrender.com"
   Invoke-RestMethod -Uri "$AppUrl/api/health" -Method Get
   ```
   Expected response:
   ```json
   {
     "status": "ok",
     "service": "CampusShare X API",
     "database": "connected",
     "timestamp": "2026-10-29T..."
   }
   ```
2. Open the URL in your browser and sign in using your configured administrator credentials.
3. Test creating a booking or approving a resource request.
4. **Test Database Persistence Across Restarts:**
   - In the Render Dashboard, click **Manual Deploy** -> **Clear build cache & deploy** or restart the service.
   - After the service restarts, reload your browser and confirm that all accounts, bookings, and audit records remain intact.

---

### Phase 4: Connecting a Custom `.xyz` Domain

Once your Render Free service is running, you can connect your purchased `.xyz` domain (e.g., `campushare.xyz` or `app.campushare.xyz`).

1. **In Render Dashboard:**
   - Navigate to your `campushare-x` Web Service.
   - Click **Settings** in the left sidebar.
   - Scroll to **Custom Domains** and click **Add Custom Domain**.
   - Enter your domain (e.g. `app.campushare.xyz` or `campushare.xyz`) and click **Save**.
   - Render will display the DNS target, typically:
     ```text
     campushare-x.onrender.com
     ```
2. **In Your Domain Registrar (Namecheap, Porkbun, Cloudflare, GoDaddy, etc.):**
   - Go to your domain's **DNS Management** / **Advanced DNS** settings.
   - **For a subdomain (recommended, e.g. `app.campushare.xyz`):**
     - **Type:** `CNAME`
     - **Host / Name:** `app`
     - **Value / Target:** `campushare-x.onrender.com`
     - **TTL:** `Automatic` or `300`
   - **For an apex domain (e.g. `campushare.xyz`):**
     - **Type:** `ALIAS` or `ANAME` (or `CNAME flattening` if using Cloudflare)
     - **Host / Name:** `@`
     - **Value / Target:** `campushare-x.onrender.com`
     - *(Alternatively, if your registrar only supports A records for apex domains, add the IP addresses provided by Render's dashboard).*
3. **SSL Certificate Provisioning:**
   - Render automatically provisions and renews a free **Let's Encrypt SSL/TLS Certificate** once DNS propagation resolves.
   - DNS propagation typically takes 5–30 minutes. You can verify DNS propagation in PowerShell:
     ```powershell
     Resolve-DnsName -Name "app.campushare.xyz" -Type CNAME
     ```

---

## Honest Explanation of Free Hosting Limitations

| Component | Free Tier Behaviour | Impact & Workaround |
|---|---|---|
| **Render Web Service (Free)** | Spins down (sleeps) after **15 minutes** of inactivity. | The first request after a period of inactivity experiences a **cold-start delay of ~45–50 seconds** while the container starts. Subsequent requests are fast and responsive. |
| **Render Web Service (Free)** | 512 MB RAM limit. | Application is lightweight (~120 MB RAM in Node 24). Static files are served directly with efficient cache headers. |
| **Neon PostgreSQL (Free)** | Compute endpoint automatically suspends after **5 minutes** of inactivity. | Resumes automatically on the next SQL query within **~500ms to 1s**. Because Neon keeps storage separate from compute, wakeups are nearly instantaneous. |
| **Neon PostgreSQL (Free)** | 0.5 GiB persistent storage limit. | Sufficient for tens of thousands of users, bookings, condition reports, and audit logs. |
| **Sessions & State** | Session tokens are persisted in PostgreSQL (`sessions` table). | User sign-ins survive container restarts, sleep cycles, and deployments. |

---

## Repository Structure

```text
CampusShare-X/
├── render.yaml                    # Render Free Blueprint deployment spec
├── package.json                   # Dependencies: Express, pg, React, Vite
├── .env.example                   # Environment variable template with documentation
├── server/
│   ├── index.js                   # Express application, routes, and middleware
│   └── db/
│       ├── index.js               # PostgreSQL connection pool with SSL & PGlite fallback
│       ├── migrate.js             # Versioned SQL migration runner
│       ├── seed.js                # Idempotent user and resource seeder
│       └── migrations/
│           └── 001_initial_schema.sql  # Full PostgreSQL DDL with indexes & constraints
├── src/                           # React 18 + TypeScript frontend application
│   ├── App.tsx                    # Main frontend application component
│   ├── main.tsx                   # Application bootstrap
│   └── styles.css                 # Vanilla CSS design system
├── tests/
│   ├── api.test.js                # Automated end-to-end PostgreSQL test suite
│   └── MANUAL_ACCEPTANCE_TESTS.md # Manual verification checklist
└── docs/
    ├── ARCHITECTURE.md            # Topology and component interaction diagrams
    ├── PROJECT_REPORT.md          # Comprehensive project report
    └── TEST_PLAN.md               # Test coverage matrix
```
