/**
 * db-service.js
 * ---------------------------------------------------------------------------
 * Dedicated NoSQL Data Access, Schema Validation, Business Rules (BR-01..BR-14),
 * Composite Query Runner, Dashboard Aggregator, and Sample Data Seeder.
 * ---------------------------------------------------------------------------
 */

import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { auth, db } from './firebase-config.js';

// ============================================================================
// 1. Domain Enums & Constants
// ============================================================================

export const ENUMS = {
  locationTypes: [
    'Hostel',
    'Lecture Block',
    'Cafeteria',
    'Library',
    'Administration',
    'Sports Ground',
    'Other',
  ],
  binTypes: [
    'General',
    'Plastic',
    'Paper',
    'Glass',
    'Metal',
    'Organic',
    'E-waste',
    'Hazardous',
  ],
  reporterRoles: ['Student', 'Lecturer', 'Staff', 'Visitor'],
  wasteTypes: [
    'Plastic',
    'Paper',
    'Glass',
    'Metal',
    'Organic',
    'E-waste',
    'Hazardous',
    'Mixed',
  ],
  urgencyLevels: ['Low', 'Medium', 'High'],
  reportStatuses: ['Open', 'Assigned', 'Collected', 'Closed', 'Rejected', 'Cancelled'],
  taskStatuses: ['Scheduled', 'In Progress', 'Completed', 'Cancelled'],
  materialTypes: ['Plastic', 'Paper', 'Glass', 'Metal', 'Organic', 'E-waste', 'Other'],
  disposalMethods: ['Composted', 'Reused', 'Landfill', 'Specialist treatment', 'None'],
};

export const COLLECTIONS = {
  COUNTERS: 'counters',
  LOCATIONS: 'locations',
  WASTE_REPORTS: 'wasteReports',
  COLLECTION_TASKS: 'collectionTasks',
  RECYCLING_RECORDS: 'recyclingRecords',
};

export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

// ============================================================================
// 2. Structured Error Handling & Startup Connection Test
// ============================================================================

export class BusinessRuleError extends Error {
  constructor(message, code = 'BUSINESS_RULE_VIOLATION') {
    super(message);
    this.name = 'BusinessRuleError';
    this.code = code;
  }
}

export function handleFirestoreError(error, operationType, path) {
  if (error instanceof BusinessRuleError) {
    throw error;
  }
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
      return { ok: false, offline: true, message: 'Firestore client is offline. Check Firebase configuration.' };
    }
    // Permission/not-found errors on test/connection still confirm network reachability
    return { ok: true };
  }
}

// ============================================================================
// 3. Utility Helpers & Counter Transaction (BR-05)
// ============================================================================

function padSeq(num) {
  return String(num).padStart(4, '0');
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new BusinessRuleError(`${label} must be one of: ${allowed.join(', ')}`);
  }
}

function assertNonEmptyString(value, label, maxLen = 200) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BusinessRuleError(`${label} is required`);
  }
  if (value.trim().length > maxLen) {
    throw new BusinessRuleError(`${label} must be ${maxLen} characters or fewer`);
  }
  return value.trim();
}

function assertDateString(value, label) {
  const s = assertNonEmptyString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BusinessRuleError(`${label} must be a valid date (YYYY-MM-DD)`);
  }
  return s;
}

function assertNumber(value, label, { min = -Infinity, max = Infinity, exclusiveMin = null } = {}) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || Number.isNaN(n) || !Number.isFinite(n)) {
    throw new BusinessRuleError(`${label} must be a valid number`);
  }
  if (exclusiveMin !== null && n <= exclusiveMin) {
    throw new BusinessRuleError(`${label} must be greater than ${exclusiveMin}`);
  }
  if (n < min || n > max) {
    throw new BusinessRuleError(`${label} must be between ${min} and ${max}`);
  }
  return n;
}

/**
 * Generates the next human-readable sequence ID inside an active Firestore transaction.
 */
async function nextSequentialCodeTx(tx, counterKey, prefix) {
  const counterRef = doc(db, COLLECTIONS.COUNTERS, counterKey);
  const counterSnap = await tx.get(counterRef);
  let nextSeq = 1;
  if (counterSnap.exists()) {
    const current = counterSnap.data();
    nextSeq = Number(current.seq || 0) + 1;
  }
  return {
    counterRef,
    exists: counterSnap.exists(),
    nextSeq,
    prefix,
    code: `${prefix}${padSeq(nextSeq)}`,
  };
}

function commitCounterTx(tx, counterState) {
  if (counterState.exists) {
    tx.update(counterState.counterRef, {
      seq: counterState.nextSeq,
      updatedAt: serverTimestamp(),
    });
  } else {
    tx.set(counterState.counterRef, {
      seq: counterState.nextSeq,
      prefix: counterState.prefix,
      updatedAt: serverTimestamp(),
    });
  }
}

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ============================================================================
// 4. Real-Time Subscriptions (onSnapshot)
// ============================================================================

export function subscribeAllCollections(callbacks) {
  const unsubscribers = [];

  const attach = (colName, orderField, dir, cb) => {
    const q = query(collection(db, colName), orderBy(orderField, dir));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        cb(items);
      },
      (error) => {
        if (callbacks.onError) {
          callbacks.onError(error, colName);
        } else {
          handleFirestoreError(error, OperationType.LIST, colName);
        }
      }
    );
    unsubscribers.push(unsub);
  };

  attach(COLLECTIONS.LOCATIONS, 'locationCode', 'asc', callbacks.onLocations);
  attach(COLLECTIONS.WASTE_REPORTS, 'reportedAt', 'desc', callbacks.onReports);
  attach(COLLECTIONS.COLLECTION_TASKS, 'createdAt', 'desc', callbacks.onTasks);
  attach(COLLECTIONS.RECYCLING_RECORDS, 'processedDate', 'desc', callbacks.onRecycling);

  return () => {
    unsubscribers.forEach((u) => u());
  };
}

// ============================================================================
// 5. Composite Query Demonstration (Firestore where + orderBy)
// ============================================================================

/**
 * Executes a real Firestore compound query against `wasteReports` combining
 * equality filters and `orderBy('reportedAt', 'desc')`. If Firestore throws
 * `failed-precondition` because the composite index has not yet been created
 * in the Firebase Console, returns the index URL cleanly so the UI can notify
 * the developer while falling back gracefully.
 */
export async function runWasteReportCompositeQuery({ status, wasteType, locationId }) {
  const constraints = [];
  if (status && status !== 'all') {
    constraints.push(where('status', '==', status));
  }
  if (wasteType && wasteType !== 'all') {
    constraints.push(where('wasteType', '==', wasteType));
  }
  if (locationId && locationId !== 'all') {
    constraints.push(where('locationId', '==', locationId));
  }
  constraints.push(orderBy('reportedAt', 'desc'));

  const q = query(collection(db, COLLECTIONS.WASTE_REPORTS), ...constraints);
  try {
    const snap = await getDocs(q);
    return {
      source: 'firestore-server',
      items: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      indexUrl: null,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (error?.code === 'failed-precondition' || msg.includes('requires an index')) {
      const urlMatch = msg.match(/https:\/\/console\.firebase\.google\.com[^\s)]+/);
      return {
        source: 'index-required',
        items: null,
        indexUrl: urlMatch ? urlMatch[0] : null,
        message: msg,
      };
    }
    handleFirestoreError(error, OperationType.LIST, COLLECTIONS.WASTE_REPORTS);
  }
}

// ============================================================================
// 6. Collection 1: Locations CRUD + Business Rules (BR-01, BR-02, BR-03, BR-14)
// ============================================================================

function validateLocationInput(input) {
  const rawCode = assertNonEmptyString(input.locationCode, 'Location Code', 32).toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(rawCode)) {
    throw new BusinessRuleError('Location Code must be 2–32 characters using A–Z, 0–9, hyphens, or underscores');
  }

  const name = assertNonEmptyString(input.name, 'Location Name', 120);
  assertEnum(input.type, ENUMS.locationTypes, 'Facility Type');
  const area = assertNonEmptyString(input.area, 'Campus Zone / Area', 100);

  if (!Array.isArray(input.bins)) {
    throw new BusinessRuleError('Bins must be a valid list');
  }
  if (input.bins.length > 30) {
    throw new BusinessRuleError('A location can have at most 30 bins');
  }
  const bins = input.bins.map((b, idx) => {
    assertEnum(b.binType, ENUMS.binTypes, `Bin #${idx + 1} type`);
    const capacityLitres = assertNumber(b.capacityLitres, `Bin #${idx + 1} capacity (L)`, {
      min: 1,
      max: 100000,
    });
    return { binType: b.binType, capacityLitres };
  });

  const isActive = Boolean(input.isActive);

  return {
    locationCode: rawCode,
    name,
    type: input.type,
    area,
    bins,
    isActive,
  };
}

export async function createLocation(input) {
  const clean = validateLocationInput(input);
  try {
    // BR-02: Block duplicate locationCode
    const dupQuery = query(
      collection(db, COLLECTIONS.LOCATIONS),
      where('locationCode', '==', clean.locationCode)
    );
    const dupSnap = await getDocs(dupQuery);
    if (!dupSnap.empty) {
      throw new BusinessRuleError('That locationCode already exists');
    }

    const newRef = doc(collection(db, COLLECTIONS.LOCATIONS));
    await runTransaction(db, async (tx) => {
      tx.set(newRef, {
        ...clean,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
    return { id: newRef.id, ...clean };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, COLLECTIONS.LOCATIONS);
  }
}

export async function updateLocation(locationId, input) {
  const clean = validateLocationInput(input);
  try {
    // BR-02: Block duplicate locationCode (excluding self)
    const dupQuery = query(
      collection(db, COLLECTIONS.LOCATIONS),
      where('locationCode', '==', clean.locationCode)
    );
    const dupSnap = await getDocs(dupQuery);
    const conflict = dupSnap.docs.find((d) => d.id !== locationId);
    if (conflict) {
      throw new BusinessRuleError('That locationCode already exists');
    }

    const locRef = doc(db, COLLECTIONS.LOCATIONS, locationId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(locRef);
      if (!snap.exists()) {
        throw new BusinessRuleError('Location not found');
      }
      tx.update(locRef, {
        ...clean,
        updatedAt: serverTimestamp(),
      });
    });
    return { id: locationId, ...clean };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.LOCATIONS}/${locationId}`);
  }
}

export async function deleteLocation(locationId) {
  try {
    // BR-14: Referential integrity check against wasteReports
    const refQuery = query(
      collection(db, COLLECTIONS.WASTE_REPORTS),
      where('locationId', '==', locationId)
    );
    const refSnap = await getDocs(refQuery);
    if (!refSnap.empty) {
      const count = refSnap.size;
      throw new BusinessRuleError(`Cannot delete: used by ${count} report${count === 1 ? '' : 's'}`);
    }
    await deleteDoc(doc(db, COLLECTIONS.LOCATIONS, locationId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${COLLECTIONS.LOCATIONS}/${locationId}`);
  }
}

// ============================================================================
// 7. Collection 2: Waste Reports CRUD & Workflow (BR-01..07, BR-12, BR-14)
// ============================================================================

function validateReportInput(input) {
  const locationId = assertNonEmptyString(input.locationId, 'Location', 128);
  const reporterName = assertNonEmptyString(input.reportedBy?.name, 'Reporter Name', 100);
  const reporterContact =
    typeof input.reportedBy?.contact === 'string' ? input.reportedBy.contact.trim().slice(0, 100) : '';
  assertEnum(input.reportedBy?.role, ENUMS.reporterRoles, 'Reporter Role');
  assertEnum(input.wasteType, ENUMS.wasteTypes, 'Waste Type');
  const estimatedKg = assertNumber(input.estimatedKg, 'Estimated kg', { min: 0, max: 100000 });
  assertEnum(input.urgency, ENUMS.urgencyLevels, 'Urgency');
  const description =
    typeof input.description === 'string' ? input.description.trim().slice(0, 1000) : '';

  return {
    locationId,
    reportedBy: {
      name: reporterName,
      contact: reporterContact,
      role: input.reportedBy.role,
    },
    wasteType: input.wasteType,
    estimatedKg,
    urgency: input.urgency,
    description,
  };
}

export async function createWasteReport(input, options = {}) {
  const clean = validateReportInput(input);
  try {
    const newRef = doc(collection(db, COLLECTIONS.WASTE_REPORTS));
    const locRef = doc(db, COLLECTIONS.LOCATIONS, clean.locationId);

    const reportNo = await runTransaction(db, async (tx) => {
      const locSnap = await tx.get(locRef);
      if (!locSnap.exists() || locSnap.data().isActive !== true) {
        throw new BusinessRuleError('Choose an active location');
      }

      const counterState = await nextSequentialCodeTx(tx, COLLECTIONS.WASTE_REPORTS, 'WR-');
      commitCounterTx(tx, counterState);

      tx.set(newRef, {
        reportNo: counterState.code,
        ...clean,
        status: 'Open',
        statusReason: '',
        reportedAt: options.reportedAt || serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      return counterState.code;
    });

    return { id: newRef.id, reportNo, ...clean, status: 'Open' };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, COLLECTIONS.WASTE_REPORTS);
  }
}

export async function updateWasteReport(reportId, input) {
  const clean = validateReportInput(input);
  try {
    const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, reportId);
    const locRef = doc(db, COLLECTIONS.LOCATIONS, clean.locationId);

    await runTransaction(db, async (tx) => {
      const [reportSnap, locSnap] = await Promise.all([tx.get(reportRef), tx.get(locRef)]);
      if (!reportSnap.exists()) {
        throw new BusinessRuleError('Waste report not found');
      }
      const existing = reportSnap.data();
      if (!['Open', 'Assigned'].includes(existing.status)) {
        throw new BusinessRuleError(
          `Report ${existing.reportNo} cannot be edited while status is ${existing.status}`
        );
      }
      if (!locSnap.exists() || locSnap.data().isActive !== true) {
        throw new BusinessRuleError('Choose an active location');
      }

      tx.update(reportRef, {
        ...clean,
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.WASTE_REPORTS}/${reportId}`);
  }
}

export async function rejectOrCancelReport(reportId, targetStatus, statusReason) {
  if (!['Rejected', 'Cancelled'].includes(targetStatus)) {
    throw new BusinessRuleError('Report action must be Rejected or Cancelled');
  }
  const reason = typeof statusReason === 'string' ? statusReason.trim() : '';
  if (!reason) {
    throw new BusinessRuleError('Enter a reason');
  }
  if (reason.length > 500) {
    throw new BusinessRuleError('Reason must be 500 characters or fewer');
  }

  try {
    const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, reportId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(reportRef);
      if (!snap.exists()) {
        throw new BusinessRuleError('Waste report not found');
      }
      const existing = snap.data();
      if (existing.status !== 'Open') {
        throw new BusinessRuleError(
          `Only Open reports can be ${targetStatus.toLowerCase()} (current status: ${existing.status})`
        );
      }
      tx.update(reportRef, {
        status: targetStatus,
        statusReason: reason,
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.WASTE_REPORTS}/${reportId}`);
  }
}

export async function deleteWasteReport(reportId) {
  try {
    // BR-14: Block if collectionTasks reference this report
    const taskQuery = query(
      collection(db, COLLECTIONS.COLLECTION_TASKS),
      where('reportId', '==', reportId)
    );
    const taskSnap = await getDocs(taskQuery);
    if (!taskSnap.empty) {
      const count = taskSnap.size;
      throw new BusinessRuleError(
        `Cannot delete: used by ${count} collection task${count === 1 ? '' : 's'}`
      );
    }
    await deleteDoc(doc(db, COLLECTIONS.WASTE_REPORTS, reportId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${COLLECTIONS.WASTE_REPORTS}/${reportId}`);
  }
}

// ============================================================================
// 8. Collection 3: Collection Tasks CRUD & Workflow (BR-06, BR-07, BR-08, BR-13, BR-14)
// ============================================================================

function validateTaskInput(input, { isUpdate = false } = {}) {
  const reportId = isUpdate ? null : assertNonEmptyString(input.reportId, 'Waste Report', 128);
  const assigneeName = assertNonEmptyString(input.assignedTo?.name, 'Assignee Name', 100);
  const staffId =
    typeof input.assignedTo?.staffId === 'string' ? input.assignedTo.staffId.trim().slice(0, 50) : '';
  const scheduledDate = assertDateString(input.scheduledDate, 'Scheduled Date');
  const equipment = typeof input.equipment === 'string' ? input.equipment.trim().slice(0, 300) : '';
  const remarks = typeof input.remarks === 'string' ? input.remarks.trim().slice(0, 1000) : '';

  return {
    ...(reportId ? { reportId } : {}),
    assignedTo: {
      name: assigneeName,
      staffId,
    },
    scheduledDate,
    equipment,
    remarks,
  };
}

export async function createCollectionTask(input) {
  const clean = validateTaskInput(input, { isUpdate: false });
  try {
    const newTaskRef = doc(collection(db, COLLECTIONS.COLLECTION_TASKS));
    const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, clean.reportId);

    const taskNo = await runTransaction(db, async (tx) => {
      const reportSnap = await tx.get(reportRef);
      if (!reportSnap.exists()) {
        throw new BusinessRuleError('Linked waste report does not exist');
      }
      const reportData = reportSnap.data();
      // BR-06: Only Open reports can receive a new Collection Task
      if (reportData.status !== 'Open') {
        throw new BusinessRuleError(`Report ${reportData.reportNo} is not open`);
      }

      const counterState = await nextSequentialCodeTx(tx, COLLECTIONS.COLLECTION_TASKS, 'CT-');
      commitCounterTx(tx, counterState);

      tx.set(newTaskRef, {
        taskNo: counterState.code,
        reportId: clean.reportId,
        assignedTo: clean.assignedTo,
        scheduledDate: clean.scheduledDate,
        equipment: clean.equipment,
        status: 'Scheduled',
        startedAt: null,
        completedAt: null,
        actualKg: null,
        remarks: clean.remarks,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // BR-06: Automatically set linked report status to Assigned
      tx.update(reportRef, {
        status: 'Assigned',
        updatedAt: serverTimestamp(),
      });

      return counterState.code;
    });

    return { id: newTaskRef.id, taskNo, ...clean, status: 'Scheduled' };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, COLLECTIONS.COLLECTION_TASKS);
  }
}

export async function updateCollectionTask(taskId, input) {
  const clean = validateTaskInput(input, { isUpdate: true });
  try {
    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, taskId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(taskRef);
      if (!snap.exists()) {
        throw new BusinessRuleError('Collection task not found');
      }
      const existing = snap.data();
      if (['Completed', 'Cancelled'].includes(existing.status)) {
        throw new BusinessRuleError(
          `Task ${existing.taskNo} cannot be edited once ${existing.status}`
        );
      }
      tx.update(taskRef, {
        assignedTo: clean.assignedTo,
        scheduledDate: clean.scheduledDate,
        equipment: clean.equipment,
        remarks: clean.remarks,
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.COLLECTION_TASKS}/${taskId}`);
  }
}

export async function startCollectionTask(taskId, options = {}) {
  try {
    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, taskId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(taskRef);
      if (!snap.exists()) {
        throw new BusinessRuleError('Collection task not found');
      }
      const existing = snap.data();
      // BR-07: Scheduled -> In Progress
      if (existing.status !== 'Scheduled') {
        throw new BusinessRuleError(`Only Scheduled tasks can be started (current: ${existing.status})`);
      }
      tx.update(taskRef, {
        status: 'In Progress',
        startedAt: options.startedAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.COLLECTION_TASKS}/${taskId}`);
  }
}

export async function completeCollectionTask(taskId, actualKgInput, remarksInput = null, options = {}) {
  // BR-08: actualKg required
  if (
    actualKgInput === '' ||
    actualKgInput === null ||
    actualKgInput === undefined ||
    Number.isNaN(Number(actualKgInput))
  ) {
    throw new BusinessRuleError('Enter the kilograms collected');
  }
  const actualKg = Number(actualKgInput);
  if (actualKg < 0 || actualKg > 100000) {
    throw new BusinessRuleError('Kilograms collected must be between 0 and 100,000');
  }

  try {
    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, taskId);
    await runTransaction(db, async (tx) => {
      const taskSnap = await tx.get(taskRef);
      if (!taskSnap.exists()) {
        throw new BusinessRuleError('Collection task not found');
      }
      const taskData = taskSnap.data();
      // BR-07: In Progress -> Completed
      if (taskData.status !== 'In Progress') {
        throw new BusinessRuleError(
          `Task ${taskData.taskNo} must be In Progress before completing (current: ${taskData.status})`
        );
      }

      const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, taskData.reportId);
      const reportSnap = await tx.get(reportRef);
      if (!reportSnap.exists()) {
        throw new BusinessRuleError('Linked waste report not found');
      }

      const finalRemarks =
        remarksInput !== null && remarksInput !== undefined
          ? String(remarksInput).trim().slice(0, 1000)
          : taskData.remarks || '';

      tx.update(taskRef, {
        status: 'Completed',
        completedAt: options.completedAt || serverTimestamp(),
        actualKg,
        remarks: finalRemarks,
        updatedAt: serverTimestamp(),
      });

      // BR-08: Automatically update linked report status to Collected
      tx.update(reportRef, {
        status: 'Collected',
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.COLLECTION_TASKS}/${taskId}`);
  }
}

export async function cancelCollectionTask(taskId, remarksInput = null) {
  try {
    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, taskId);
    await runTransaction(db, async (tx) => {
      const taskSnap = await tx.get(taskRef);
      if (!taskSnap.exists()) {
        throw new BusinessRuleError('Collection task not found');
      }
      const taskData = taskSnap.data();
      // BR-07: Scheduled or In Progress -> Cancelled
      if (!['Scheduled', 'In Progress'].includes(taskData.status)) {
        throw new BusinessRuleError(
          `Cannot cancel task ${taskData.taskNo} while status is ${taskData.status}`
        );
      }

      const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, taskData.reportId);
      const reportSnap = await tx.get(reportRef);
      if (!reportSnap.exists()) {
        throw new BusinessRuleError('Linked waste report not found');
      }

      const finalRemarks =
        remarksInput !== null && remarksInput !== undefined
          ? String(remarksInput).trim().slice(0, 1000)
          : taskData.remarks || '';

      tx.update(taskRef, {
        status: 'Cancelled',
        remarks: finalRemarks,
        updatedAt: serverTimestamp(),
      });

      // BR-13: Automatically revert linked report status back to Open
      tx.update(reportRef, {
        status: 'Open',
        updatedAt: serverTimestamp(),
      });
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.COLLECTION_TASKS}/${taskId}`);
  }
}

export async function deleteCollectionTask(taskId) {
  try {
    // BR-14: Block if recyclingRecords reference this task
    const recQuery = query(
      collection(db, COLLECTIONS.RECYCLING_RECORDS),
      where('taskId', '==', taskId)
    );
    const recSnap = await getDocs(recQuery);
    if (!recSnap.empty) {
      const count = recSnap.size;
      throw new BusinessRuleError(
        `Cannot delete: used by ${count} recycling record${count === 1 ? '' : 's'}`
      );
    }

    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, taskId);
    await runTransaction(db, async (tx) => {
      const taskSnap = await tx.get(taskRef);
      if (!taskSnap.exists()) {
        throw new BusinessRuleError('Collection task not found');
      }
      const taskData = taskSnap.data();
      const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, taskData.reportId);
      const reportSnap = await tx.get(reportRef);

      if (reportSnap.exists() && ['Assigned', 'Collected'].includes(reportSnap.data().status)) {
        tx.update(reportRef, {
          status: 'Open',
          updatedAt: serverTimestamp(),
        });
      }
      tx.delete(taskRef);
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${COLLECTIONS.COLLECTION_TASKS}/${taskId}`);
  }
}

// ============================================================================
// 9. Collection 4: Recycling Records CRUD & Mass Balance (BR-09, BR-10, BR-11, BR-14)
// ============================================================================

function validateRecyclingInput(input, { isUpdate = false } = {}) {
  const taskId = isUpdate ? null : assertNonEmptyString(input.taskId, 'Completed Task', 128);
  assertEnum(input.materialType, ENUMS.materialTypes, 'Material Type');
  const receivedKg = assertNumber(input.receivedKg, 'Received kg', {
    exclusiveMin: 0,
    max: 100000,
  });
  const recycledKg = assertNumber(input.recycledKg, 'Recycled kg', {
    min: 0,
    max: 100000,
  });

  // BR-10: recycledKg cannot exceed receivedKg
  if (recycledKg > receivedKg) {
    throw new BusinessRuleError('Recycled kg cannot exceed received kg');
  }

  assertEnum(input.disposalMethod, ENUMS.disposalMethods, 'Disposal Method');
  const facility = typeof input.facility === 'string' ? input.facility.trim().slice(0, 150) : '';
  const processedDate = assertDateString(input.processedDate, 'Processed Date');
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 1000) : '';

  // BR-10: Auto-calculate recoveryRate rounded to 1 decimal place
  const recoveryRate = Number(((recycledKg / receivedKg) * 100).toFixed(1));

  return {
    ...(taskId ? { taskId } : {}),
    materialType: input.materialType,
    receivedKg,
    recycledKg,
    disposalMethod: input.disposalMethod,
    facility,
    processedDate,
    recoveryRate,
    notes,
  };
}

export async function createRecyclingRecord(input) {
  const clean = validateRecyclingInput(input, { isUpdate: false });
  try {
    const siblingSnap = await getDocs(
      query(collection(db, COLLECTIONS.RECYCLING_RECORDS), where('taskId', '==', clean.taskId))
    );
    const siblingRefs = siblingSnap.docs.map((d) => d.ref);

    const newRecRef = doc(collection(db, COLLECTIONS.RECYCLING_RECORDS));
    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, clean.taskId);

    const recordNo = await runTransaction(db, async (tx) => {
      const taskSnap = await tx.get(taskRef);
      if (!taskSnap.exists()) {
        throw new BusinessRuleError('Linked collection task not found');
      }
      const taskData = taskSnap.data();
      // BR-09: Only Completed tasks can receive recycling records
      if (taskData.status !== 'Completed') {
        throw new BusinessRuleError(`Task ${taskData.taskNo} is not completed`);
      }

      const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, taskData.reportId);
      const reportSnap = await tx.get(reportRef);
      const siblingSnaps = await Promise.all(siblingRefs.map((r) => tx.get(r)));
      const counterState = await nextSequentialCodeTx(tx, COLLECTIONS.RECYCLING_RECORDS, 'RR-');

      const existingSum = siblingSnaps.reduce((acc, s) => {
        return acc + (s.exists() ? Number(s.data().receivedKg || 0) : 0);
      }, 0);
      const nextTotalReceived = existingSum + clean.receivedKg;
      const collectedKg = Number(taskData.actualKg || 0);

      // BR-11: Total receivedKg across task records cannot exceed task.actualKg
      if (nextTotalReceived > collectedKg + 1e-6) {
        throw new BusinessRuleError(`Records exceed the ${collectedKg} kg collected`);
      }

      commitCounterTx(tx, counterState);
      tx.set(newRecRef, {
        recordNo: counterState.code,
        ...clean,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // BR-07 & BR-14: Close report when total receivedKg equals actualKg
      if (reportSnap.exists()) {
        const targetStatus =
          Math.abs(nextTotalReceived - collectedKg) < 1e-6 && collectedKg > 0 ? 'Closed' : 'Collected';
        if (reportSnap.data().status !== targetStatus) {
          tx.update(reportRef, {
            status: targetStatus,
            updatedAt: serverTimestamp(),
          });
        }
      }

      return counterState.code;
    });

    return { id: newRecRef.id, recordNo, ...clean };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, COLLECTIONS.RECYCLING_RECORDS);
  }
}

export async function updateRecyclingRecord(recordId, input) {
  const clean = validateRecyclingInput(input, { isUpdate: true });
  try {
    const recRef = doc(db, COLLECTIONS.RECYCLING_RECORDS, recordId);

    // Fetch taskId first so we can gather sibling refs for transactional sum
    const preSnap = await getDocs(
      query(collection(db, COLLECTIONS.RECYCLING_RECORDS))
    );
    const currentDoc = preSnap.docs.find((d) => d.id === recordId);
    if (!currentDoc) {
      throw new BusinessRuleError('Recycling record not found');
    }
    const taskId = currentDoc.data().taskId;
    const siblingRefs = preSnap.docs
      .filter((d) => d.data().taskId === taskId && d.id !== recordId)
      .map((d) => d.ref);

    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, taskId);

    await runTransaction(db, async (tx) => {
      const [recSnap, taskSnap] = await Promise.all([tx.get(recRef), tx.get(taskRef)]);
      if (!recSnap.exists()) {
        throw new BusinessRuleError('Recycling record not found');
      }
      if (!taskSnap.exists()) {
        throw new BusinessRuleError('Linked collection task not found');
      }
      const taskData = taskSnap.data();
      if (taskData.status !== 'Completed') {
        throw new BusinessRuleError(`Task ${taskData.taskNo} is not completed`);
      }

      const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, taskData.reportId);
      const reportSnap = await tx.get(reportRef);
      const siblingSnaps = await Promise.all(siblingRefs.map((r) => tx.get(r)));

      const siblingSum = siblingSnaps.reduce((acc, s) => {
        return acc + (s.exists() ? Number(s.data().receivedKg || 0) : 0);
      }, 0);
      const nextTotalReceived = siblingSum + clean.receivedKg;
      const collectedKg = Number(taskData.actualKg || 0);

      // BR-11: Check total receivedKg against actualKg
      if (nextTotalReceived > collectedKg + 1e-6) {
        throw new BusinessRuleError(`Records exceed the ${collectedKg} kg collected`);
      }

      tx.update(recRef, {
        ...clean,
        updatedAt: serverTimestamp(),
      });

      // BR-14: Recalculate parent report status
      if (reportSnap.exists()) {
        const targetStatus =
          Math.abs(nextTotalReceived - collectedKg) < 1e-6 && collectedKg > 0 ? 'Closed' : 'Collected';
        if (reportSnap.data().status !== targetStatus) {
          tx.update(reportRef, {
            status: targetStatus,
            updatedAt: serverTimestamp(),
          });
        }
      }
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${COLLECTIONS.RECYCLING_RECORDS}/${recordId}`);
  }
}

export async function deleteRecyclingRecord(recordId) {
  try {
    const allRecs = await getDocs(collection(db, COLLECTIONS.RECYCLING_RECORDS));
    const targetDoc = allRecs.docs.find((d) => d.id === recordId);
    if (!targetDoc) {
      throw new BusinessRuleError('Recycling record not found');
    }
    const taskId = targetDoc.data().taskId;
    const siblingRefs = allRecs.docs
      .filter((d) => d.data().taskId === taskId && d.id !== recordId)
      .map((d) => d.ref);

    const recRef = doc(db, COLLECTIONS.RECYCLING_RECORDS, recordId);
    const taskRef = doc(db, COLLECTIONS.COLLECTION_TASKS, taskId);

    await runTransaction(db, async (tx) => {
      const [recSnap, taskSnap] = await Promise.all([tx.get(recRef), tx.get(taskRef)]);
      if (!recSnap.exists()) {
        throw new BusinessRuleError('Recycling record not found');
      }
      if (!taskSnap.exists()) {
        tx.delete(recRef);
        return;
      }

      const taskData = taskSnap.data();
      const reportRef = doc(db, COLLECTIONS.WASTE_REPORTS, taskData.reportId);
      const reportSnap = await tx.get(reportRef);
      const siblingSnaps = await Promise.all(siblingRefs.map((r) => tx.get(r)));

      const remainingReceived = siblingSnaps.reduce((acc, s) => {
        return acc + (s.exists() ? Number(s.data().receivedKg || 0) : 0);
      }, 0);
      const collectedKg = Number(taskData.actualKg || 0);

      tx.delete(recRef);

      // BR-14: Recompute parent report status
      if (reportSnap.exists() && ['Closed', 'Collected'].includes(reportSnap.data().status)) {
        const targetStatus =
          Math.abs(remainingReceived - collectedKg) < 1e-6 && collectedKg > 0 ? 'Closed' : 'Collected';
        if (reportSnap.data().status !== targetStatus) {
          tx.update(reportRef, {
            status: targetStatus,
            updatedAt: serverTimestamp(),
          });
        }
      }
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `${COLLECTIONS.RECYCLING_RECORDS}/${recordId}`);
  }
}

// ============================================================================
// 10. Dashboard Data Aggregation Engine
// ============================================================================

export function computeDashboardMetrics({ locations, reports, tasks, recycling }) {
  const locMap = new Map(locations.map((l) => [l.id, l]));
  const reportMap = new Map(reports.map((r) => [r.id, r]));

  const totalReports = reports.length;
  const openReports = reports.filter((r) => r.status === 'Open').length;

  const completedTasks = tasks.filter((t) => t.status === 'Completed');
  const activeTasks = tasks.filter((t) => t.status === 'Scheduled' || t.status === 'In Progress');

  const totalCollectedKg = completedTasks.reduce((sum, t) => sum + Number(t.actualKg || 0), 0);
  const totalReceivedKg = recycling.reduce((sum, r) => sum + Number(r.receivedKg || 0), 0);
  const totalRecycledKg = recycling.reduce((sum, r) => sum + Number(r.recycledKg || 0), 0);
  const overallRecoveryRate =
    totalReceivedKg > 0 ? Number(((totalRecycledKg / totalReceivedKg) * 100).toFixed(1)) : 0;

  // 1. Reports by Status
  const reportsByStatus = {};
  ENUMS.reportStatuses.forEach((s) => {
    reportsByStatus[s] = 0;
  });
  reports.forEach((r) => {
    reportsByStatus[r.status] = (reportsByStatus[r.status] || 0) + 1;
  });

  // 2. Waste Volume (kg) by Waste Type (estimated from reports)
  const volumeByWasteType = {};
  ENUMS.wasteTypes.forEach((wt) => {
    volumeByWasteType[wt] = 0;
  });
  reports.forEach((r) => {
    volumeByWasteType[r.wasteType] =
      (volumeByWasteType[r.wasteType] || 0) + Number(r.estimatedKg || 0);
  });

  // 3. Top 5 Locations with Most Waste Collected (kg)
  const collectedByLocation = new Map();
  completedTasks.forEach((t) => {
    const rep = reportMap.get(t.reportId);
    if (!rep) return;
    const loc = locMap.get(rep.locationId);
    const key = rep.locationId;
    const prev = collectedByLocation.get(key) || {
      locationId: key,
      name: loc ? loc.name : 'Unknown Location',
      code: loc ? loc.locationCode : '—',
      area: loc ? loc.area : '',
      kg: 0,
      taskCount: 0,
    };
    prev.kg += Number(t.actualKg || 0);
    prev.taskCount += 1;
    collectedByLocation.set(key, prev);
  });
  const topLocations = Array.from(collectedByLocation.values())
    .sort((a, b) => b.kg - a.kg)
    .slice(0, 5);

  // 4. Kilograms Collected per Month
  const monthlyMap = new Map();
  completedTasks.forEach((t) => {
    const dt = toDate(t.completedAt) || toDate(t.scheduledDate);
    if (!dt) return;
    const monthKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    monthlyMap.set(monthKey, (monthlyMap.get(monthKey) || 0) + Number(t.actualKg || 0));
  });
  const monthlyCollected = Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, kg]) => ({ month, kg: Number(kg.toFixed(1)) }));

  // 5. Recycling Volume & Recovery Rate by Material Type
  const materialStatsMap = new Map();
  ENUMS.materialTypes.forEach((m) => {
    materialStatsMap.set(m, { materialType: m, receivedKg: 0, recycledKg: 0, recoveryRate: 0 });
  });
  recycling.forEach((rec) => {
    const cur = materialStatsMap.get(rec.materialType) || {
      materialType: rec.materialType,
      receivedKg: 0,
      recycledKg: 0,
      recoveryRate: 0,
    };
    cur.receivedKg += Number(rec.receivedKg || 0);
    cur.recycledKg += Number(rec.recycledKg || 0);
    materialStatsMap.set(rec.materialType, cur);
  });
  const materialBreakdown = Array.from(materialStatsMap.values())
    .filter((m) => m.receivedKg > 0)
    .map((m) => ({
      ...m,
      receivedKg: Number(m.receivedKg.toFixed(1)),
      recycledKg: Number(m.recycledKg.toFixed(1)),
      recoveryRate: m.receivedKg > 0 ? Number(((m.recycledKg / m.receivedKg) * 100).toFixed(1)) : 0,
    }));

  // 6. Average Turnaround Time (days) from reportedAt to task completedAt
  const turnaroundDays = [];
  completedTasks.forEach((t) => {
    const rep = reportMap.get(t.reportId);
    if (!rep) return;
    const start = toDate(rep.reportedAt);
    const end = toDate(t.completedAt);
    if (!start || !end) return;
    const diffDays = Math.max(0, (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
    turnaroundDays.push(diffDays);
  });
  const avgTurnaroundDays =
    turnaroundDays.length > 0
      ? Number((turnaroundDays.reduce((a, b) => a + b, 0) / turnaroundDays.length).toFixed(2))
      : null;

  return {
    kpis: {
      totalReports,
      openReports,
      tasksCompleted: completedTasks.length,
      tasksActive: activeTasks.length,
      totalCollectedKg: Number(totalCollectedKg.toFixed(1)),
      totalReceivedKg: Number(totalReceivedKg.toFixed(1)),
      totalRecycledKg: Number(totalRecycledKg.toFixed(1)),
      overallRecoveryRate,
      avgTurnaroundDays,
      turnaroundSampleSize: turnaroundDays.length,
    },
    reportsByStatus,
    volumeByWasteType,
    topLocations,
    monthlyCollected,
    materialBreakdown,
  };
}

// ============================================================================
// 11. Sample Data Seeder (Exercises Full Workflow & Business Rules)
// ============================================================================

function daysAgoTimestamp(daysAgo) {
  const ms = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  return Timestamp.fromMillis(ms);
}

function daysAgoDateStr(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export async function seedSampleData(existingLocations = []) {
  const existingByCode = new Map(existingLocations.map((l) => [l.locationCode, l]));

  const sampleLocations = [
    {
      locationCode: 'LOC-CAF01',
      name: 'Main Campus Cafeteria',
      type: 'Cafeteria',
      area: 'Central Plaza',
      bins: [
        { binType: 'Organic', capacityLitres: 240 },
        { binType: 'Plastic', capacityLitres: 120 },
        { binType: 'General', capacityLitres: 240 },
      ],
      isActive: true,
    },
    {
      locationCode: 'LOC-LIB01',
      name: 'J.K. Main Library',
      type: 'Library',
      area: 'Academic Core',
      bins: [
        { binType: 'Paper', capacityLitres: 180 },
        { binType: 'Plastic', capacityLitres: 120 },
      ],
      isActive: true,
    },
    {
      locationCode: 'LOC-HST01',
      name: 'North Quadrangle Hostel',
      type: 'Hostel',
      area: 'North Zone',
      bins: [
        { binType: 'General', capacityLitres: 360 },
        { binType: 'Plastic', capacityLitres: 240 },
        { binType: 'Glass', capacityLitres: 120 },
      ],
      isActive: true,
    },
    {
      locationCode: 'LOC-ENG02',
      name: 'Engineering Lecture Block B',
      type: 'Lecture Block',
      area: 'East Wing',
      bins: [
        { binType: 'E-waste', capacityLitres: 90 },
        { binType: 'Metal', capacityLitres: 120 },
        { binType: 'Paper', capacityLitres: 120 },
      ],
      isActive: true,
    },
    {
      locationCode: 'LOC-SPT01',
      name: 'University Sports Pavilion',
      type: 'Sports Ground',
      area: 'South Fields',
      bins: [
        { binType: 'Plastic', capacityLitres: 240 },
        { binType: 'Metal', capacityLitres: 120 },
      ],
      isActive: true,
    },
    {
      locationCode: 'LOC-ADM99',
      name: 'Old Annex Stores (Decommissioned)',
      type: 'Administration',
      area: 'West Gate',
      bins: [{ binType: 'General', capacityLitres: 60 }],
      isActive: false,
    },
  ];

  const locIds = {};
  let createdLocations = 0;

  for (const loc of sampleLocations) {
    const existing = existingByCode.get(loc.locationCode);
    if (existing) {
      locIds[loc.locationCode] = existing.id;
    } else {
      const created = await createLocation(loc);
      locIds[loc.locationCode] = created.id;
      createdLocations += 1;
    }
  }

  // Create multi-month reports and run realistic state transitions
  const r1 = await createWasteReport(
    {
      locationId: locIds['LOC-CAF01'],
      reportedBy: { name: 'Grace Namukasa', contact: 'grace.n@campus.edu', role: 'Staff' },
      wasteType: 'Organic',
      estimatedKg: 85,
      urgency: 'High',
      description: 'Post-lunch kitchen food prep scraps and compostables near loading bay.',
    },
    { reportedAt: daysAgoTimestamp(64) }
  );

  const r2 = await createWasteReport(
    {
      locationId: locIds['LOC-LIB01'],
      reportedBy: { name: 'Dr. Henry Kato', contact: 'ext. 3102', role: 'Lecturer' },
      wasteType: 'Paper',
      estimatedKg: 42,
      urgency: 'Medium',
      description: 'Archived exam booklets and shredded office paper cartons.',
    },
    { reportedAt: daysAgoTimestamp(48) }
  );

  const r3 = await createWasteReport(
    {
      locationId: locIds['LOC-HST01'],
      reportedBy: { name: 'Brian Mugisha', contact: '0772-418902', role: 'Student' },
      wasteType: 'Plastic',
      estimatedKg: 54,
      urgency: 'High',
      description: 'PET beverage bottles overflowing at North Hostel courtyard bins.',
    },
    { reportedAt: daysAgoTimestamp(32) }
  );

  const r4 = await createWasteReport(
    {
      locationId: locIds['LOC-ENG02'],
      reportedBy: { name: 'Prof. Lydia Ssekitoleko', contact: 'lydia.s@campus.edu', role: 'Lecturer' },
      wasteType: 'E-waste',
      estimatedKg: 31,
      urgency: 'Medium',
      description: 'Decommissioned lab power supplies, keyboards, and copper cabling.',
    },
    { reportedAt: daysAgoTimestamp(18) }
  );

  const r5 = await createWasteReport(
    {
      locationId: locIds['LOC-SPT01'],
      reportedBy: { name: 'Alex Twinomujuni', contact: 'ext. 2219', role: 'Staff' },
      wasteType: 'Metal',
      estimatedKg: 26,
      urgency: 'Low',
      description: 'Aluminum beverage cans collected after inter-faculty tournament.',
    },
    { reportedAt: daysAgoTimestamp(8) }
  );

  const r6 = await createWasteReport(
    {
      locationId: locIds['LOC-HST01'],
      reportedBy: { name: 'Sarah Achieng', contact: 'sarah.a@campus.edu', role: 'Student' },
      wasteType: 'Glass',
      estimatedKg: 19,
      urgency: 'Medium',
      description: 'Glass bottles stacked behind Block C stairwell.',
    },
    { reportedAt: daysAgoTimestamp(3) }
  );

  const r7 = await createWasteReport(
    {
      locationId: locIds['LOC-CAF01'],
      reportedBy: { name: 'Daniel Ochieng', contact: 'ext. 1140', role: 'Staff' },
      wasteType: 'Plastic',
      estimatedKg: 22,
      urgency: 'High',
      description: 'Single-use packaging containers at West Kiosk awaiting pickup.',
    },
    { reportedAt: daysAgoTimestamp(1) }
  );

  const r8 = await createWasteReport(
    {
      locationId: locIds['LOC-LIB01'],
      reportedBy: { name: 'Visitor Desk', contact: '', role: 'Visitor' },
      wasteType: 'Mixed',
      estimatedKg: 4,
      urgency: 'Low',
      description: 'Duplicate entry reported earlier by library staff.',
    },
    { reportedAt: daysAgoTimestamp(12) }
  );

  // Reject r8 with reason (BR-12)
  await rejectOrCancelReport(r8.id, 'Rejected', 'Duplicate of morning library clearance ticket.');

  // Create & complete tasks across months
  const t1 = await createCollectionTask({
    reportId: r1.id,
    assignedTo: { name: 'Samuel Okello', staffId: 'ENV-101' },
    scheduledDate: daysAgoDateStr(63),
    equipment: 'Tipper truck, compost totes',
    remarks: 'Prioritized morning pickup before heat.',
  });
  await startCollectionTask(t1.id, { startedAt: daysAgoTimestamp(63) });
  await completeCollectionTask(t1.id, 88, 'Delivered directly to campus compost windrows.', {
    completedAt: daysAgoTimestamp(62),
  });

  const t2 = await createCollectionTask({
    reportId: r2.id,
    assignedTo: { name: 'Martha Nalubega', staffId: 'ENV-104' },
    scheduledDate: daysAgoDateStr(46),
    equipment: 'Covered van, pallet trolley',
    remarks: 'Dry paper kept separate from moisture.',
  });
  await startCollectionTask(t2.id, { startedAt: daysAgoTimestamp(46) });
  await completeCollectionTask(t2.id, 40, 'Baled at campus MRF.', {
    completedAt: daysAgoTimestamp(45),
  });

  const t3 = await createCollectionTask({
    reportId: r3.id,
    assignedTo: { name: 'Samuel Okello', staffId: 'ENV-101' },
    scheduledDate: daysAgoDateStr(30),
    equipment: 'Mesh cage trailer, PPE gloves',
    remarks: 'Sorted PET from HDPE caps on site.',
  });
  await startCollectionTask(t3.id, { startedAt: daysAgoTimestamp(30) });
  await completeCollectionTask(t3.id, 58, 'High-purity PET load.', {
    completedAt: daysAgoTimestamp(29),
  });

  const t4 = await createCollectionTask({
    reportId: r4.id,
    assignedTo: { name: 'Peter Wasswa', staffId: 'ENV-109' },
    scheduledDate: daysAgoDateStr(15),
    equipment: 'ESD crates, pallet jack',
    remarks: 'Isolated circuit boards and copper wire.',
  });
  await startCollectionTask(t4.id, { startedAt: daysAgoTimestamp(15) });
  await completeCollectionTask(t4.id, 30, 'Logged for specialist e-waste partner.', {
    completedAt: daysAgoTimestamp(14),
  });

  // t5 is In Progress
  const t5 = await createCollectionTask({
    reportId: r5.id,
    assignedTo: { name: 'Martha Nalubega', staffId: 'ENV-104' },
    scheduledDate: daysAgoDateStr(0),
    equipment: 'Utility cart, sorting bags',
    remarks: 'Currently loading aluminum bags at South Fields.',
  });
  await startCollectionTask(t5.id);

  // t6 is Scheduled (leaves r7 Open for testing new task creation!)
  await createCollectionTask({
    reportId: r6.id,
    assignedTo: { name: 'Peter Wasswa', staffId: 'ENV-109' },
    scheduledDate: daysAgoDateStr(-1),
    equipment: 'Reinforced glass bins, safety goggles',
    remarks: 'Scheduled for tomorrow morning round.',
  });

  // Recycling records (full and partial allocations)
  await createRecyclingRecord({
    taskId: t1.id,
    materialType: 'Organic',
    receivedKg: 88,
    recycledKg: 82,
    disposalMethod: 'Composted',
    facility: 'Campus Botanical Compost Yard',
    processedDate: daysAgoDateStr(61),
    notes: '6 kg non-compostable wrappers removed prior to windrowing.',
  });

  await createRecyclingRecord({
    taskId: t2.id,
    materialType: 'Paper',
    receivedKg: 40,
    recycledKg: 38.5,
    disposalMethod: 'Reused',
    facility: 'GreenLeaf Paper Mill Partner',
    processedDate: daysAgoDateStr(44),
    notes: 'Clean office grade pulp stock.',
  });

  await createRecyclingRecord({
    taskId: t3.id,
    materialType: 'Plastic',
    receivedKg: 58,
    recycledKg: 51,
    disposalMethod: 'Landfill',
    facility: 'Campus MRF Sorting Bay',
    processedDate: daysAgoDateStr(28),
    notes: '7 kg contaminated film sent to residual landfill.',
  });

  // Partial allocation on t4 (20 of 30 kg allocated -> leaves r4 Collected and 10 kg available to test!)
  await createRecyclingRecord({
    taskId: t4.id,
    materialType: 'E-waste',
    receivedKg: 20,
    recycledKg: 17.5,
    disposalMethod: 'Specialist treatment',
    facility: 'Certified E-Waste Refiner',
    processedDate: daysAgoDateStr(12),
    notes: '10 kg remaining chassis units awaiting secondary dismantling.',
  });

  return {
    createdLocations,
    createdReports: 8,
    createdTasks: 6,
    createdRecycling: 4,
  };
}
