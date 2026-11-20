import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Static & structural verification of the "Dirty Dozen" Firestore Security Rules guarantees
 * documented in security_spec.md against the finalized firestore.rules file.
 */
const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
const rulesText = fs.readFileSync(rulesPath, 'utf8');

// 1. Default-deny catch-all at top
assert.match(rulesText, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);

// 2. Email verification mandate on every signed-in operation
assert.match(rulesText, /function isSignedIn\(\)\s*\{\s*return request\.auth != null && request\.auth\.token\.email_verified == true;\s*\}/);

// 3. ID poisoning protection
assert.match(rulesText, /function isValidId\(id\)\s*\{\s*return id is string && id\.size\(\) >= 2 && id\.size\(\) <= 128/);

// 4. Zero-free-coins user creation & update invariants
assert.match(rulesText, /incoming\(\)\.coinBalance == 0/);
assert.match(rulesText, /incoming\(\)\.unlimitedCoins == false/);
assert.match(rulesText, /incoming\(\)\.coinBalance == existing\(\)\.coinBalance/);

// 5. No JSON.stringify or client timestamp spoofing
assert.match(rulesText, /incoming\(\)\.createdAt == request\.time/);
assert.match(rulesText, /incoming\(\)\.updatedAt == request\.time/);
assert.match(rulesText, /incoming\(\)\.createdAt == existing\(\)\.createdAt/);

// 6. Resolved ticket terminal lock & PII owner isolation
assert.match(rulesText, /existing\(\)\.status != 'resolved'/);
assert.match(rulesText, /allow list: if isSignedIn\(\) && \(resource\.data\.ownerUid == request\.auth\.uid/);

console.log('Verified all Firestore security rules invariants cleanly.');
