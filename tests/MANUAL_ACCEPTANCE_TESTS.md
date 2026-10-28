# CampusShare X — Manual Acceptance Tests

Run these against the application after `npm install` and `npm run dev`. Use the separate local accounts in `README.md`; this is an account-backed application, not a role-switching demo. Test data is fictional starter data. Record actual outcomes before the hackathon submission.

## Accounts used locally

- Student: `student@campusshare.local` / `CampusStudent!2026`
- Second student: `student2@campusshare.local` / `CampusStudent2!2026`
- Owner: `owner@campusshare.local` / `CampusOwner!2026`
- Administrator: `admin@campusshare.local` / `CampusAdmin!2026`

These credentials are for the local development database only. Never reuse them on an internet-facing deployment.

## End-to-end acceptance journey

1. **Owner creates a resource:** sign in as the resource owner, add a new test resource, and verify the new asset code and listing appear in the catalogue.
2. **Student discovers:** sign in as the student, enter “I need to build an IoT prototype and test a sensor circuit today” in SmartMatch. Confirm relevant catalogued resources and match explanations appear.
3. **Passport:** open a resource and inspect its owner, location, capabilities, instructions and eligibility requirements.
4. **Eligibility block:** attempt to request Digital Oscilloscope without verified `lab-safety` training. Confirm the server blocks the request and the UI shows the reason.
5. **Booking request:** choose a future date/time that does not overlap a confirmed booking or maintenance block. Submit a clear purpose and confirm the request is pending.
6. **Owner decision:** sign out, sign in as owner, approve the request with a reason. Sign in as the student and verify the new status/notification.
7. **Check-in:** the authorised owner or user completes check-in and records the initial condition. Confirm the booking changes to checked out and the event is visible in history.
8. **Return and incident:** return the resource with a `minor` or `damage` condition and notes. Verify the return record is saved and a reviewable incident is created.
9. **Incident review:** sign in as the owning resource owner, resolve the incident with a meaningful note, and confirm the resolved status and audit event.
10. **Audit export:** export the audit history to CSV and inspect the exported records.

## Fairness, permissions and failure scenarios

11. **Competing requests:** sign in as student and second student and create overlapping requests for the same resource/time. Owner approves one. Verify the competing pending request becomes waitlisted with an explanation.
12. **Active booking limit:** create requests until a user reaches the defined active/upcoming reservation limit. Confirm further requests are refused or waitlisted according to the application response.
13. **Maintenance block:** sign in as the owner and record a future unavailable interval. Verify availability shows the block and a booking overlapping it is rejected server-side.
14. **Extension:** while a booking is checked out, request a later return time. Confirm the end time does not change until the owner approves it, and that conflicting/too-long extensions are rejected.
15. **Cancellation:** cancel an eligible pending/approved booking and confirm the status, notification and audit event update.
16. **Account verification:** register a new student. Confirm the profile starts pending and cannot book. As administrator, verify the profile and assign the appropriate role only if authorised.
17. **Training verification:** as administrator, add/verify a required training record. Confirm the student can then request the matching restricted resource only when all other conditions pass.
18. **Role security:** as a student, try to call an admin or owner-only endpoint. Confirm the server rejects it; do not rely only on hidden UI buttons.
19. **Persistence:** stop and restart the application using the same `DATA_DIR`. Verify accounts, requests and audit history still exist.
20. **Availability uncertainty:** stop the API or request a date while offline. Confirm the UI does not claim the resource is verified available.
21. **Responsive view:** test the primary workflows at a narrow screen width and ensure buttons/forms remain usable.

## Acceptance record

For each test record: date/time, tester, result (`PASS` / `FAIL` / `NOT RUN`), observed result, screenshot or log reference, and defect/follow-up. Do not mark a test passed until it has actually been run against the current application build.
