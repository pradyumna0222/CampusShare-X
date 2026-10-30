# CampusShare X

**The trust layer for shared resources.** CampusShare X is a full-stack resource-sharing application for university campuses, research groups, laboratories and makerspaces. It connects project-oriented resource discovery with eligibility checks, owner-controlled approvals, fair allocation, condition-recorded handovers, returns, extensions, incident review and an auditable activity history.

## Live links

- **Application:** https://campus-share-x.vercel.app
- **API health:** https://campus-share-x.vercel.app/api/health
- **Public repository:** https://github.com/pradyumna0222/CampusShare-X

## Technology stack

- **Frontend:** React 18, TypeScript, Vite, CSS and Lucide React.
- **Backend:** Node.js 24-compatible runtime, Express.js REST API.
- **Production database:** Neon managed PostgreSQL using `pg` connection pooling and versioned SQL migrations.
- **Local/testing database:** Embedded PGlite PostgreSQL fallback when `DATABASE_URL` is not supplied.
- **Hosting:** Vercel frontend build and serverless API (`api/index.js`).
- **Security:** bcryptjs password hashing, hashed session tokens, HTTP-only SameSite cookies, Helmet, rate limiting, parameterised SQL and server-side role/eligibility checks.
- **Optional AI:** OpenAI-compatible Chat Completions API for constrained SmartMatch capability extraction. Deterministic matching is the fallback.

## Main capabilities

- Account registration and login with student, resource-owner and administrator roles.
- Resource catalogue for equipment and bookable spaces.
- SmartMatch natural-language goal to capability-tag matching and resource ranking.
- TrustGuard server-side institutional verification and required-training checks.
- FairShare three-active/upcoming-reservation limit, conflict prevention and waitlisting.
- Owner approval/rejection, maintenance blocks and resource status management.
- Check-in and return with before/after text condition reports.
- Extension requests, incident review and in-app notifications.
- Audit history and permission-scoped CSV export.

## Local setup (Windows PowerShell)

Prerequisites: Node.js 22.15+ (Node.js 24 recommended), npm 10+, and Git.

```powershell
# Run from the project root
Copy-Item .env.example .env
npm install
npm run migrate
npm run dev
```

Open `http://localhost:5173`. The Vite development server proxies `/api` requests to the Express API.

For local development, `.env.example` contains sample-only credentials. Change them for any shared environment. Never commit `.env`, database URLs, API keys or production passwords.

## Verification

```powershell
npm test
npm run typecheck
npm run build
```

In the inspected final archive, `npm test` passed 10 tests and `npm run typecheck` passed. The build command could not be completed in that inspection environment because the archive's bundled `node_modules` was missing the platform-specific Rollup optional dependency. Reinstall dependencies in the target environment and confirm the Vercel production build log.

## Vercel + Neon deployment

The production deployment uses Vercel, not Render.

1. Keep the GitHub repository connected to the Vercel project.
2. In Vercel Project Settings → Environment Variables, configure the production `DATABASE_URL` with the Neon pooled connection string and SSL requirement.
3. Configure `NODE_ENV=production`, timezone values, and unique initial account credentials as required by the seeding code.
4. Keep `OPENAI_API_KEY` optional. Without it, SmartMatch uses deterministic tag extraction.
5. Redeploy after changing production environment variables.
6. Verify `https://campus-share-x.vercel.app/api/health` and test student, owner and administrator workflows.

Do not paste secrets into GitHub, reports, screenshots or public issue trackers. Do not reuse any credential that has previously been shared in chat or included in a distributable archive.

## Demo account note

Production accounts are seeded from the `INITIAL_*` environment variables only when the database has no users yet. Changing those variables after the first seed does not reset existing accounts. Do not rely on local sample credentials for production. Keep production credentials private and distribute judge access through a secure, intended method.


## Demo account identifiers

The production environment file defines these demo account identifiers:

| Role | Email |
|---|---|
| Student | `student@campusshare.local` |
| Second student | `student2@campusshare.local` |
| Resource owner | `owner@campusshare.local` |
| Administrator | `admin@campusshare.local` |

**Passwords are intentionally not published in this README or the public repository.** Keep the private production environment file secure and share judge credentials only through an organiser-approved private channel.

The `INITIAL_*_PASSWORD` values are used only when the database is first seeded (when the `users` table is empty). If these accounts already exist in Neon, changing the Vercel environment variables or uploading a new `.env` file does not reset their passwords. Verify or reset existing production account passwords through a secure administrative procedure before giving credentials to judges.

The uploaded environment file still contains a placeholder for `DATABASE_URL`. Replace it with a newly rotated Neon pooled connection string in Vercel's Production environment before using it for deployment. Never commit the environment file or its secrets to GitHub.

## Known limitations

- Starter inventory and demo identities are illustrative, not verified institutional inventory.
- SmartMatch's external LLM is optional; the deterministic fallback works without it.
- Notifications are in-app; outbound email, WhatsApp and SMS are not connected.
- Condition reports are text-based; photo upload and image comparison are future work.
- FairShare is rule-based; no measured fairness improvement or ML allocation claim is made.
- Institutional SSO, trusted training integrations, formal security certification and multi-campus governance require further work.
- The application has not been penetration-tested or approved for sensitive institutional data.

## Repository layout

```text
api/index.js                 Vercel serverless entry point
server/index.js              Express application and API routes
server/db/index.js           PostgreSQL pool / PGlite fallback
server/db/migrate.js         Versioned SQL migration runner
server/db/seed.js            Initial account and sample resource seeding
server/db/migrations/        PostgreSQL schema migrations
src/                         React + TypeScript frontend
tests/api.test.js            Automated API integration tests
tests/MANUAL_ACCEPTANCE_TESTS.md
docs/ARCHITECTURE.md
docs/PROJECT_REPORT.md
docs/TEST_PLAN.md
vercel.json                  Vercel build and API rewrite configuration
```
