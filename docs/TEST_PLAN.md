# CampusShare X — Test Plan

## 1. Automated integration test

Run from the project root after `npm install`:

```powershell
npm test
```

`tests/api.test.js` uses a temporary SQLite database and exercises the HTTP layer. It is designed to cover:

| Test area | Expected behaviour |
|---|---|
| Health | `/api/health` returns service status |
| Authentication | Workspace cannot be read without a valid session |
| Training eligibility | User without required `lab-safety` cannot book the oscilloscope |
| Booking request | Eligible user can create a pending request for a future slot |
| Conflicting demand | Two overlapping pending requests can be recorded; approving one waitlists the other |
| Check-in | Approved request becomes checked out and stores initial condition |
| Extension | Request remains pending until owner approves; approved extension changes end time |
| Return | Final condition record is stored; a non-good condition opens an incident |
| Incident resolution | Owner can resolve their own resource incident with a reason |
| Audit | Export returns CSV and relevant events are present in the workspace history |
| Training admin | Admin can verify a training record; eligibility is re-evaluated |
| Role boundary | Student cannot change an owner's resource status |
| Account verification | New account is pending and cannot book; admin verification updates profile status |

Record the actual test output in the submission folder after running the test. Do not mark it passed before execution.

## 2. Build checks

```powershell
npm run typecheck
npm run build
```

Expected: commands complete with exit code 0. The development environment used to assemble this package could not reach npm's registry, so full dependency-based build/test results were not available there. Run these commands locally before submission.

## 3. Manual acceptance checklist

| ID | Procedure | Expected result | Actual result |
|---|---|---|---|
| M01 | Sign in as student | Student workspace and server-backed data load | Record after run |
| M02 | Enter “IoT prototype and testing” in SmartMatch | ESP32/sensor resources are ranked and match reasons appear | Record after run |
| M03 | Open a restricted item without required training | Request is blocked with a clear explanation | Record after run |
| M04 | Pick a date in booking modal | Confirmed bookings, pending demand and maintenance blocks load from API | Record after run |
| M05 | Request a valid slot | Request appears as pending in student and owner workspaces | Record after run |
| M06 | Sign in as owner and approve request | Status changes on server, requester sees notification | Record after run |
| M07 | Submit overlapping pending request and approve the other | Losing competing request moves to waitlisted with a reason | Record after run |
| M08 | Owner blocks a future unreserved slot | Block appears in date availability; booking in block is rejected | Record after run |
| M09 | Check in an approved booking | Before-condition and checkout event appear in history | Record after run |
| M10 | Request extension as borrower | Owner sees pending extension; no end time changes until approval | Record after run |
| M11 | Owner rejects extension | Rejection reason appears and is audited | Record after run |
| M12 | Owner approves extension | End time updates only if no conflict and within duration limit | Record after run |
| M13 | Return with “minor” or “damage” and notes | Return is recorded and incident opened | Record after run |
| M14 | Resolve incident as resource owner | Resolution requires a reason and is audited | Record after run |
| M15 | Student attempts admin endpoint | Server responds 403 | Record after run |
| M16 | Register a new student | Profile starts pending; booking request is refused | Record after run |
| M17 | Admin verifies new profile and grants required training | Access status updates only after trusted admin action | Record after run |
| M18 | Export audit CSV | Only records available to current user's role are exported | Record after run |
| M19 | Restart application with same `DATA_DIR` | Accounts, bookings and audit events persist | Record after run |
| M20 | Mobile/narrow screen | Navigation, modals and forms remain usable | Record after run |

## 4. Security and failure tests

- Set `OPENAI_API_KEY` empty and verify SmartMatch uses deterministic fallback.
- Configure an invalid AI base URL and verify fallback still returns results.
- Attempt a duplicate booking and a booking in a past time; the server must reject both.
- Change resource status to maintenance and attempt a booking; it must be rejected.
- Request an extension that conflicts with another booking or exceeds 8 total hours; it must be rejected.
- Try owner actions against a resource owned by another account; request must be denied.
- Use an expired/missing cookie; protected routes must return 401.
- Review `.env`, Git status and ZIP contents; no live secrets or database files may be included.

## 5. Demonstration rehearsal

Run the full scenario in one sitting: owner lists item -> student discovers -> eligibility check -> request -> owner decision -> check-in -> return condition -> incident review -> audit inspection. Also rehearse the negative case (restricted training) and conflict/waitlist case. Prepare a resettable local database for repeatable demos, and do not depend on an external LLM being online.
