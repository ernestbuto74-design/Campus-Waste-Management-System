# CWMIS Firestore Security Specification

## Scope & Access Model
CWMIS is an internal campus operations dashboard with no user login or authentication layer (`Do NOT implement user login or authentication`). To protect data integrity against malformed writes, shadow fields, orphan references, invalid state transitions, and resource exhaustion ("Denial of Wallet"), `firestore.rules` enforces strict schema validation, relational existence checks, temporal integrity, and state-machine invariants at the database boundary.

## 1. Data Invariants
1. **Default Deny:** Any path outside `/counters`, `/locations`, `/wasteReports`, `/collectionTasks`, `/recyclingRecords`, and read-only `/test/connection` is denied.
2. **Location Integrity:** `locationCode` must match `^[A-Z0-9_-]{2,32}$`; `bins` is bounded (`size() <= 30`) and validated for element structure; `type` is restricted to the 7 allowed enum values.
3. **Active Location Gate (BR-04):** A `wasteReport` can only be created when the referenced `/locations/{locationId}` exists and `isActive == true`.
4. **Report Workflow & Reason Enforcement (BR-07, BR-12):** New `wasteReports` must start with `status == 'Open'`. `reportNo` and `createdAt` are immutable. Transitioning to `Rejected` or `Cancelled` requires a non-empty `statusReason`.
5. **Task Referential & State Gate (BR-06, BR-07, BR-08):** New `collectionTasks` must start with `status == 'Scheduled'` and reference an existing `wasteReports/{reportId}`. `taskNo`, `reportId`, and `createdAt` are immutable. Transitioning to `Completed` requires `actualKg >= 0`.
6. **Recycling Record Integrity (BR-09, BR-10):** New `recyclingRecords` must reference an existing `collectionTasks/{taskId}` whose status is `Completed`. `recycledKg` must be `>= 0` and `<= receivedKg`. `recoveryRate` must be between `0` and `100`.
7. **Temporal & Size Bounds:** Every string has explicit `.size()` bounds; every `create` requires `createdAt == request.time` and `updatedAt == request.time`; every `update` preserves `createdAt` and sets `updatedAt == request.time`.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Shadow Field Injection on Location:** `{ locationCode: "LOC-999", ..., isAdmin: true }` -> Blocked by `keys().hasOnly(...)`.
2. **Invalid Location Enum:** `{ locationCode: "LOC-999", type: "Warehouse", ... }` -> Blocked by enum allowlist.
3. **Oversized String ("Denial of Wallet"):** `{ ..., description: "<10KB string>" }` -> Blocked by `.size() <= 1000`.
4. **Unbounded Array Bomb:** `locations` doc with 100 `bins` entries -> Blocked by `bins.size() <= 30`.
5. **Inactive Location Report (BR-04):** `wasteReports` create referencing an `isActive == false` location -> Blocked by `get(/databases/.../locations/$(locationId)).data.isActive == true`.
6. **Non-Existent Location Reference:** `wasteReports` create with bogus `locationId` -> Blocked by `exists(...)`.
7. **State Shortcutting on Report Create:** `wasteReports` create with `status: "Closed"` -> Blocked (`status == 'Open'` required on create).
8. **Silent Rejection Without Reason (BR-12):** `wasteReports` update to `status: "Rejected"` with `statusReason: ""` -> Blocked.
9. **Immutable Report Number Tampering (BR-05):** `wasteReports` update modifying `reportNo` or `createdAt` -> Blocked.
10. **Task Completion Without Weight (BR-08):** `collectionTasks` update to `status: "Completed"` with `actualKg: null` -> Blocked.
11. **Recycling Record on Open Task (BR-09):** `recyclingRecords` create referencing a `Scheduled` task -> Blocked by `get(.../collectionTasks/$(taskId)).data.status == 'Completed'`.
12. **Impossible Recovery Physics (BR-10):** `recyclingRecords` create/update with `recycledKg: 50, receivedKg: 20` -> Blocked by `recycledKg <= receivedKg`.
