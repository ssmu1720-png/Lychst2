# Lyrihost Firestore Security Specification (Phase 0)

## Data Invariants
1. A non-admin user can NEVER create a profile with `role: 'admin'`, `unlimitedCoins: true`, or `coinBalance > 0`, nor elevate `coinBalance`, `role`, `unlimitedCoins`, or `maxDeployments` on update.
2. Every PII-containing document (`/users/{userId}`, `/deployments/{deploymentId}`, `/tickets/{ticketId}`) is strictly readable and writable only by its owning verified user (`request.auth.uid == ownerUid`, `email_verified == true`) or the root administrator (`sharksam004@gmail.com` with `email_verified == true`).
3. Every write enforces strict schema validation (`keys().hasAll(...)` + `keys().hasOnly(...)`), string length caps, `isValidId(...)` path guards, `request.time` server timestamps (`createdAt == request.time`, `updatedAt == request.time`), immutable ownership fields, and action-allowlisted `affectedKeys().hasOnly(...)`.
4. Terminal states (`tickets.status == 'resolved'`) cannot be reopened or edited by non-admin users.
5. All `allow list` rules evaluate `resource.data` directly (zero `get()`/`exists()` inside list rules and zero blanket signed-in list access on PII collections).

## The "Dirty Dozen" Payloads (Expected: `PERMISSION_DENIED`)
1. **Self-Role Escalation on Signup**: `POST /users/{uid}` with `{ role: 'admin', unlimitedCoins: true, coinBalance: 999999 }`.
2. **Free Coin Inflation on Update**: `PATCH /users/{uid}` by owner setting `{ coinBalance: 5000 }`.
3. **Ghost Shadow Field Injection**: `PATCH /users/{uid}` adding `{ isVerified: true }`.
4. **Unverified Email Spoof**: Request where `request.auth.token.email == 'sharksam004@gmail.com'` and `email_verified == false`.
5. **PII Cross-User Read**: Signed-in user B reading `/users/{userA_uid}` or `/tickets/{userA_ticket}`.
6. **ID Poisoning Attack**: Writing document at `/deployments/aaaa... (150 chars)` or containing `/../` invalid characters.
7. **Deployment Ownership Hijack**: User A creating `/deployments/{id}` with `ownerUid: userB_uid`.
8. **Deployment Immutable Owner Mutation**: User A updating `/deployments/{id}` with `ownerUid: userB_uid` or changing `createdAt`.
9. **Client Timestamp Forgery**: Creating `/tickets/{id}` with a backdated `createdAt` not equal to `request.time`.
10. **Resolved Ticket Reopen Tampering**: Non-admin user modifying a ticket whose existing `status == 'resolved'`.
11. **Unauthorized Template Creation**: Regular user writing to `/templates/{templateId}`.
12. **Oversized String Denial-of-Wallet**: Creating `/deployments/{id}` with a 50KB `name` or 50KB `repoUrl`.
