import { ObjectId } from 'mongodb';
import type { Db, Document, WithId } from 'mongodb';

// ============================================================================
// 1. Domain Enums & Collections
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
} as const;

export const COLLECTIONS = {
  COUNTERS: 'counters',
  LOCATIONS: 'locations',
  WASTE_REPORTS: 'wasteReports',
  COLLECTION_TASKS: 'collectionTasks',
  RECYCLING_RECORDS: 'recyclingRecords',
} as const;

// ============================================================================
// 2. Domain Error Class
// ============================================================================

export class BusinessRuleError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code = 'BUSINESS_RULE_VIOLATION') {
    super(message);
    this.name = 'BusinessRuleError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ============================================================================
// 3. Validation & Serialization Helpers
// ============================================================================

function serializeValue(val: unknown): unknown {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (val instanceof ObjectId) {
    return val.toString();
  }
  if (Array.isArray(val)) {
    return val.map(serializeValue);
  }
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return val;
}

function serializeDoc<T extends Document>(doc: WithId<T>): Record<string, unknown> {
  const { _id, ...rest } = doc as Record<string, unknown> & { _id: ObjectId };
  return {
    id: _id.toString(),
    ...(serializeValue(rest) as Record<string, unknown>),
  };
}

function toObjectId(id: string, label = 'Record ID'): ObjectId {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) {
    throw new BusinessRuleError(`Invalid ${label}`, 400);
  }
  return new ObjectId(id);
}

function padSeq(num: number): string {
  return String(num).padStart(4, '0');
}

function assertEnum(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BusinessRuleError(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function assertNonEmptyString(value: unknown, label: string, maxLen = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BusinessRuleError(`${label} is required`);
  }
  if (value.trim().length > maxLen) {
    throw new BusinessRuleError(`${label} must be ${maxLen} characters or fewer`);
  }
  return value.trim();
}

function assertDateString(value: unknown, label: string): string {
  const s = assertNonEmptyString(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BusinessRuleError(`${label} must be a valid date (YYYY-MM-DD)`);
  }
  return s;
}

function assertNumber(
  value: unknown,
  label: string,
  { min = -Infinity, max = Infinity, exclusiveMin = null as number | null } = {}
): number {
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

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: number }).code === 11000);
}

async function nextSequentialCode(db: Db, counterKey: string, prefix: string): Promise<string> {
  const counters = db.collection<{
    _id: string;
    seq: number;
    prefix: string;
    updatedAt: Date;
  }>(COLLECTIONS.COUNTERS);

  const updated = await counters.findOneAndUpdate(
    { _id: counterKey },
    {
      $inc: { seq: 1 },
      $set: { prefix, updatedAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );

  const nextSeq = Number(updated?.seq ?? 1);
  return `${prefix}${padSeq(nextSeq)}`;
}

// ============================================================================
// 4. Bootstrap & Composite Query Readers
// ============================================================================

export async function getBootstrapData(db: Db) {
  const [locations, reports, tasks, recycling] = await Promise.all([
    db.collection(COLLECTIONS.LOCATIONS).find({}).sort({ locationCode: 1 }).toArray(),
    db.collection(COLLECTIONS.WASTE_REPORTS).find({}).sort({ reportedAt: -1 }).toArray(),
    db.collection(COLLECTIONS.COLLECTION_TASKS).find({}).sort({ createdAt: -1 }).toArray(),
    db.collection(COLLECTIONS.RECYCLING_RECORDS).find({}).sort({ processedDate: -1, createdAt: -1 }).toArray(),
  ]);

  return {
    locations: locations.map(serializeDoc),
    reports: reports.map(serializeDoc),
    tasks: tasks.map(serializeDoc),
    recycling: recycling.map(serializeDoc),
  };
}

export async function listLocations(db: Db) {
  const docs = await db.collection(COLLECTIONS.LOCATIONS).find({}).sort({ locationCode: 1 }).toArray();
  return docs.map(serializeDoc);
}

export async function queryWasteReports(
  db: Db,
  filters: { status?: string; wasteType?: string; locationId?: string } = {}
) {
  const filter: Record<string, unknown> = {};
  if (filters.status && filters.status !== 'all') {
    assertEnum(filters.status, ENUMS.reportStatuses, 'Status filter');
    filter.status = filters.status;
  }
  if (filters.wasteType && filters.wasteType !== 'all') {
    assertEnum(filters.wasteType, ENUMS.wasteTypes, 'Waste Type filter');
    filter.wasteType = filters.wasteType;
  }
  if (filters.locationId && filters.locationId !== 'all') {
    filter.locationId = String(filters.locationId);
  }

  const docs = await db
    .collection(COLLECTIONS.WASTE_REPORTS)
    .find(filter)
    .sort({ reportedAt: -1 })
    .toArray();
  return docs.map(serializeDoc);
}

export async function listCollectionTasks(db: Db) {
  const docs = await db.collection(COLLECTIONS.COLLECTION_TASKS).find({}).sort({ createdAt: -1 }).toArray();
  return docs.map(serializeDoc);
}

export async function listRecyclingRecords(db: Db) {
  const docs = await db
    .collection(COLLECTIONS.RECYCLING_RECORDS)
    .find({})
    .sort({ processedDate: -1, createdAt: -1 })
    .toArray();
  return docs.map(serializeDoc);
}

// ============================================================================
// 5. Locations CRUD + Business Rules (BR-01, BR-02, BR-03, BR-14)
// ============================================================================

interface BinInput {
  binType?: unknown;
  capacityLitres?: unknown;
}

interface LocationPayload {
  locationCode?: unknown;
  name?: unknown;
  type?: unknown;
  area?: unknown;
  bins?: unknown;
  isActive?: unknown;
}

function validateLocationInput(input: LocationPayload) {
  const rawCode = assertNonEmptyString(input?.locationCode, 'Location Code', 32).toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(rawCode)) {
    throw new BusinessRuleError(
      'Location Code must be 2–32 characters using A–Z, 0–9, hyphens, or underscores'
    );
  }

  const name = assertNonEmptyString(input?.name, 'Location Name', 120);
  const type = assertEnum(input?.type, ENUMS.locationTypes, 'Facility Type');
  const area = assertNonEmptyString(input?.area, 'Campus Zone / Area', 100);

  if (!Array.isArray(input?.bins)) {
    throw new BusinessRuleError('Bins must be a valid list');
  }
  if (input.bins.length > 30) {
    throw new BusinessRuleError('A location can have at most 30 bins');
  }

  const bins = (input.bins as BinInput[]).map((b, idx) => {
    const binType = assertEnum(b?.binType, ENUMS.binTypes, `Bin #${idx + 1} type`);
    const capacityLitres = assertNumber(b?.capacityLitres, `Bin #${idx + 1} capacity (L)`, {
      min: 1,
      max: 100000,
    });
    return { binType, capacityLitres };
  });

  const isActive = Boolean(input?.isActive);

  return {
    locationCode: rawCode,
    name,
    type,
    area,
    bins,
    isActive,
  };
}

export async function createLocation(db: Db, input: LocationPayload) {
  const clean = validateLocationInput(input);
  const col = db.collection(COLLECTIONS.LOCATIONS);

  // BR-02: Block duplicate locationCode
  const existing = await col.findOne({ locationCode: clean.locationCode });
  if (existing) {
    throw new BusinessRuleError('That locationCode already exists', 409);
  }

  const now = new Date();
  const doc = {
    ...clean,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await col.insertOne(doc);
    return serializeDoc({ _id: res.insertedId, ...doc });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new BusinessRuleError('That locationCode already exists', 409);
    }
    throw err;
  }
}

export async function updateLocation(db: Db, locationId: string, input: LocationPayload) {
  const objId = toObjectId(locationId, 'Location ID');
  const clean = validateLocationInput(input);
  const col = db.collection(COLLECTIONS.LOCATIONS);

  // BR-02: Block duplicate locationCode excluding self
  const conflict = await col.findOne({
    locationCode: clean.locationCode,
    _id: { $ne: objId },
  });
  if (conflict) {
    throw new BusinessRuleError('That locationCode already exists', 409);
  }

  try {
    const updated = await col.findOneAndUpdate(
      { _id: objId },
      { $set: { ...clean, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!updated) {
      throw new BusinessRuleError('Location not found', 404);
    }
    return serializeDoc(updated);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new BusinessRuleError('That locationCode already exists', 409);
    }
    throw err;
  }
}

export async function deleteLocation(db: Db, locationId: string) {
  const objId = toObjectId(locationId, 'Location ID');

  // BR-14: Referential integrity check against wasteReports
  const count = await db
    .collection(COLLECTIONS.WASTE_REPORTS)
    .countDocuments({ locationId: objId.toString() });
  if (count > 0) {
    throw new BusinessRuleError(`Cannot delete: used by ${count} report${count === 1 ? '' : 's'}`, 409);
  }

  const res = await db.collection(COLLECTIONS.LOCATIONS).deleteOne({ _id: objId });
  if (res.deletedCount === 0) {
    throw new BusinessRuleError('Location not found', 404);
  }
  return { deleted: true, id: locationId };
}

// ============================================================================
// 6. Waste Reports CRUD & Workflow (BR-01..07, BR-12, BR-14)
// ============================================================================

interface ReportPayload {
  locationId?: unknown;
  reportedBy?: {
    name?: unknown;
    contact?: unknown;
    role?: unknown;
  };
  wasteType?: unknown;
  estimatedKg?: unknown;
  urgency?: unknown;
  description?: unknown;
}

function validateReportInput(input: ReportPayload) {
  const locationId = assertNonEmptyString(input?.locationId, 'Location', 128);
  toObjectId(locationId, 'Location');
  const reporterName = assertNonEmptyString(input?.reportedBy?.name, 'Reporter Name', 100);
  const reporterContact =
    typeof input?.reportedBy?.contact === 'string'
      ? input.reportedBy.contact.trim().slice(0, 100)
      : '';
  const reporterRole = assertEnum(input?.reportedBy?.role, ENUMS.reporterRoles, 'Reporter Role');
  const wasteType = assertEnum(input?.wasteType, ENUMS.wasteTypes, 'Waste Type');
  const estimatedKg = assertNumber(input?.estimatedKg, 'Estimated kg', { min: 0, max: 100000 });
  const urgency = assertEnum(input?.urgency, ENUMS.urgencyLevels, 'Urgency');
  const description =
    typeof input?.description === 'string' ? input.description.trim().slice(0, 1000) : '';

  return {
    locationId,
    reportedBy: {
      name: reporterName,
      contact: reporterContact,
      role: reporterRole,
    },
    wasteType,
    estimatedKg,
    urgency,
    description,
  };
}

export async function createWasteReport(
  db: Db,
  input: ReportPayload,
  options: { reportedAt?: Date | string } = {}
) {
  const clean = validateReportInput(input);
  const locObjId = toObjectId(clean.locationId, 'Location');

  // BR-04: Must reference an active location
  const loc = await db.collection(COLLECTIONS.LOCATIONS).findOne({ _id: locObjId });
  if (!loc || loc.isActive !== true) {
    throw new BusinessRuleError('Choose an active location');
  }

  const reportNo = await nextSequentialCode(db, COLLECTIONS.WASTE_REPORTS, 'WR-');
  const now = new Date();
  const reportedAt = options.reportedAt ? new Date(options.reportedAt) : now;

  const doc = {
    reportNo,
    ...clean,
    status: 'Open',
    statusReason: '',
    reportedAt,
    createdAt: now,
    updatedAt: now,
  };

  const res = await db.collection(COLLECTIONS.WASTE_REPORTS).insertOne(doc);
  return serializeDoc({ _id: res.insertedId, ...doc });
}

export async function updateWasteReport(db: Db, reportId: string, input: ReportPayload) {
  const objId = toObjectId(reportId, 'Report ID');
  const clean = validateReportInput(input);
  const locObjId = toObjectId(clean.locationId, 'Location');

  const reportsCol = db.collection(COLLECTIONS.WASTE_REPORTS);
  const existing = await reportsCol.findOne({ _id: objId });
  if (!existing) {
    throw new BusinessRuleError('Waste report not found', 404);
  }
  if (!['Open', 'Assigned'].includes(String(existing.status))) {
    throw new BusinessRuleError(
      `Report ${existing.reportNo} cannot be edited while status is ${existing.status}`
    );
  }

  const loc = await db.collection(COLLECTIONS.LOCATIONS).findOne({ _id: locObjId });
  if (!loc || loc.isActive !== true) {
    throw new BusinessRuleError('Choose an active location');
  }

  const updated = await reportsCol.findOneAndUpdate(
    { _id: objId, status: { $in: ['Open', 'Assigned'] } },
    { $set: { ...clean, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!updated) {
    throw new BusinessRuleError('Waste report could not be updated in its current state');
  }
  return serializeDoc(updated);
}

export async function rejectOrCancelReport(
  db: Db,
  reportId: string,
  targetStatus: unknown,
  statusReason: unknown
) {
  const objId = toObjectId(reportId, 'Report ID');
  if (targetStatus !== 'Rejected' && targetStatus !== 'Cancelled') {
    throw new BusinessRuleError('Report action must be Rejected or Cancelled');
  }
  const reason = typeof statusReason === 'string' ? statusReason.trim() : '';
  if (!reason) {
    throw new BusinessRuleError('Enter a reason');
  }
  if (reason.length > 500) {
    throw new BusinessRuleError('Reason must be 500 characters or fewer');
  }

  const reportsCol = db.collection(COLLECTIONS.WASTE_REPORTS);
  const updated = await reportsCol.findOneAndUpdate(
    { _id: objId, status: 'Open' },
    { $set: { status: targetStatus, statusReason: reason, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    const existing = await reportsCol.findOne({ _id: objId });
    if (!existing) {
      throw new BusinessRuleError('Waste report not found', 404);
    }
    throw new BusinessRuleError(
      `Only Open reports can be ${targetStatus.toLowerCase()} (current status: ${existing.status})`
    );
  }

  return serializeDoc(updated);
}

export async function deleteWasteReport(db: Db, reportId: string) {
  const objId = toObjectId(reportId, 'Report ID');

  // BR-14: Block if collectionTasks reference this report
  const count = await db
    .collection(COLLECTIONS.COLLECTION_TASKS)
    .countDocuments({ reportId: objId.toString() });
  if (count > 0) {
    throw new BusinessRuleError(
      `Cannot delete: used by ${count} collection task${count === 1 ? '' : 's'}`,
      409
    );
  }

  const res = await db.collection(COLLECTIONS.WASTE_REPORTS).deleteOne({ _id: objId });
  if (res.deletedCount === 0) {
    throw new BusinessRuleError('Waste report not found', 404);
  }
  return { deleted: true, id: reportId };
}

// ============================================================================
// 7. Collection Tasks CRUD & Workflow (BR-06, BR-07, BR-08, BR-13, BR-14)
// ============================================================================

interface TaskPayload {
  reportId?: unknown;
  assignedTo?: {
    name?: unknown;
    staffId?: unknown;
  };
  scheduledDate?: unknown;
  equipment?: unknown;
  remarks?: unknown;
}

function validateTaskInput(input: TaskPayload, { isUpdate = false } = {}) {
  const reportId = isUpdate ? null : assertNonEmptyString(input?.reportId, 'Waste Report', 128);
  if (reportId) {
    toObjectId(reportId, 'Waste Report');
  }
  const assigneeName = assertNonEmptyString(input?.assignedTo?.name, 'Assignee Name', 100);
  const staffId =
    typeof input?.assignedTo?.staffId === 'string'
      ? input.assignedTo.staffId.trim().slice(0, 50)
      : '';
  const scheduledDate = assertDateString(input?.scheduledDate, 'Scheduled Date');
  const equipment = typeof input?.equipment === 'string' ? input.equipment.trim().slice(0, 300) : '';
  const remarks = typeof input?.remarks === 'string' ? input.remarks.trim().slice(0, 1000) : '';

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

export async function createCollectionTask(db: Db, input: TaskPayload) {
  const clean = validateTaskInput(input, { isUpdate: false });
  const reportId = clean.reportId as string;
  const reportObjId = toObjectId(reportId, 'Waste Report');
  const reportsCol = db.collection(COLLECTIONS.WASTE_REPORTS);

  const now = new Date();
  // BR-06: Atomically transition Open report -> Assigned
  const claimedReport = await reportsCol.findOneAndUpdate(
    { _id: reportObjId, status: 'Open' },
    { $set: { status: 'Assigned', updatedAt: now } },
    { returnDocument: 'after' }
  );

  if (!claimedReport) {
    const existingReport = await reportsCol.findOne({ _id: reportObjId });
    if (!existingReport) {
      throw new BusinessRuleError('Linked waste report does not exist', 404);
    }
    throw new BusinessRuleError(`Report ${existingReport.reportNo} is not open`);
  }

  try {
    const taskNo = await nextSequentialCode(db, COLLECTIONS.COLLECTION_TASKS, 'CT-');
    const doc = {
      taskNo,
      reportId,
      assignedTo: clean.assignedTo,
      scheduledDate: clean.scheduledDate,
      equipment: clean.equipment,
      status: 'Scheduled',
      startedAt: null,
      completedAt: null,
      actualKg: null,
      remarks: clean.remarks,
      createdAt: now,
      updatedAt: now,
    };
    const res = await db.collection(COLLECTIONS.COLLECTION_TASKS).insertOne(doc);
    return serializeDoc({ _id: res.insertedId, ...doc });
  } catch (err) {
    // Roll back report status if task insert fails
    await reportsCol
      .updateOne({ _id: reportObjId, status: 'Assigned' }, { $set: { status: 'Open', updatedAt: new Date() } })
      .catch(() => {});
    throw err;
  }
}

export async function updateCollectionTask(db: Db, taskId: string, input: TaskPayload) {
  const objId = toObjectId(taskId, 'Task ID');
  const clean = validateTaskInput(input, { isUpdate: true });
  const tasksCol = db.collection(COLLECTIONS.COLLECTION_TASKS);

  const existing = await tasksCol.findOne({ _id: objId });
  if (!existing) {
    throw new BusinessRuleError('Collection task not found', 404);
  }
  if (['Completed', 'Cancelled'].includes(String(existing.status))) {
    throw new BusinessRuleError(`Task ${existing.taskNo} cannot be edited once ${existing.status}`);
  }

  const updated = await tasksCol.findOneAndUpdate(
    { _id: objId, status: { $in: ['Scheduled', 'In Progress'] } },
    {
      $set: {
        assignedTo: clean.assignedTo,
        scheduledDate: clean.scheduledDate,
        equipment: clean.equipment,
        remarks: clean.remarks,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' }
  );
  if (!updated) {
    throw new BusinessRuleError('Collection task could not be updated in its current state');
  }
  return serializeDoc(updated);
}

export async function startCollectionTask(
  db: Db,
  taskId: string,
  options: { startedAt?: Date | string } = {}
) {
  const objId = toObjectId(taskId, 'Task ID');
  const tasksCol = db.collection(COLLECTIONS.COLLECTION_TASKS);
  const now = new Date();
  const startedAt = options.startedAt ? new Date(options.startedAt) : now;

  // BR-07: Scheduled -> In Progress
  const updated = await tasksCol.findOneAndUpdate(
    { _id: objId, status: 'Scheduled' },
    { $set: { status: 'In Progress', startedAt, updatedAt: now } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    const existing = await tasksCol.findOne({ _id: objId });
    if (!existing) {
      throw new BusinessRuleError('Collection task not found', 404);
    }
    throw new BusinessRuleError(`Only Scheduled tasks can be started (current: ${existing.status})`);
  }

  return serializeDoc(updated);
}

export async function completeCollectionTask(
  db: Db,
  taskId: string,
  actualKgInput: unknown,
  remarksInput: unknown = null,
  options: { completedAt?: Date | string } = {}
) {
  const objId = toObjectId(taskId, 'Task ID');

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
  if (!Number.isFinite(actualKg) || actualKg < 0 || actualKg > 100000) {
    throw new BusinessRuleError('Kilograms collected must be between 0 and 100,000');
  }

  const tasksCol = db.collection(COLLECTIONS.COLLECTION_TASKS);
  const existing = await tasksCol.findOne({ _id: objId });
  if (!existing) {
    throw new BusinessRuleError('Collection task not found', 404);
  }
  if (existing.status !== 'In Progress') {
    throw new BusinessRuleError(
      `Task ${existing.taskNo} must be In Progress before completing (current: ${existing.status})`
    );
  }

  const finalRemarks =
    remarksInput !== null && remarksInput !== undefined
      ? String(remarksInput).trim().slice(0, 1000)
      : String(existing.remarks || '');

  const now = new Date();
  const completedAt = options.completedAt ? new Date(options.completedAt) : now;

  const updated = await tasksCol.findOneAndUpdate(
    { _id: objId, status: 'In Progress' },
    {
      $set: {
        status: 'Completed',
        completedAt,
        actualKg,
        remarks: finalRemarks,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    throw new BusinessRuleError('Task status changed concurrently; please refresh and retry');
  }

  // BR-08: Automatically update linked report status to Collected
  await db
    .collection(COLLECTIONS.WASTE_REPORTS)
    .updateOne(
      { _id: toObjectId(String(existing.reportId), 'Waste Report') },
      { $set: { status: 'Collected', updatedAt: now } }
    );

  return serializeDoc(updated);
}

export async function cancelCollectionTask(
  db: Db,
  taskId: string,
  remarksInput: unknown = null
) {
  const objId = toObjectId(taskId, 'Task ID');
  const tasksCol = db.collection(COLLECTIONS.COLLECTION_TASKS);
  const existing = await tasksCol.findOne({ _id: objId });
  if (!existing) {
    throw new BusinessRuleError('Collection task not found', 404);
  }
  if (!['Scheduled', 'In Progress'].includes(String(existing.status))) {
    throw new BusinessRuleError(
      `Cannot cancel task ${existing.taskNo} while status is ${existing.status}`
    );
  }

  const finalRemarks =
    remarksInput !== null && remarksInput !== undefined
      ? String(remarksInput).trim().slice(0, 1000)
      : String(existing.remarks || '');
  const now = new Date();

  const updated = await tasksCol.findOneAndUpdate(
    { _id: objId, status: { $in: ['Scheduled', 'In Progress'] } },
    {
      $set: {
        status: 'Cancelled',
        remarks: finalRemarks,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' }
  );

  if (!updated) {
    throw new BusinessRuleError('Task status changed concurrently; please refresh and retry');
  }

  // BR-13: Automatically revert linked report status back to Open
  await db
    .collection(COLLECTIONS.WASTE_REPORTS)
    .updateOne(
      { _id: toObjectId(String(existing.reportId), 'Waste Report') },
      { $set: { status: 'Open', updatedAt: now } }
    );

  return serializeDoc(updated);
}

export async function deleteCollectionTask(db: Db, taskId: string) {
  const objId = toObjectId(taskId, 'Task ID');

  // BR-14: Block if recyclingRecords reference this task
  const count = await db
    .collection(COLLECTIONS.RECYCLING_RECORDS)
    .countDocuments({ taskId: objId.toString() });
  if (count > 0) {
    throw new BusinessRuleError(
      `Cannot delete: used by ${count} recycling record${count === 1 ? '' : 's'}`,
      409
    );
  }

  const deletedTask = await db.collection(COLLECTIONS.COLLECTION_TASKS).findOneAndDelete({ _id: objId });
  if (!deletedTask) {
    throw new BusinessRuleError('Collection task not found', 404);
  }

  // BR-14: Revert Assigned/Collected report back to Open
  await db.collection(COLLECTIONS.WASTE_REPORTS).updateOne(
    {
      _id: toObjectId(String(deletedTask.reportId), 'Waste Report'),
      status: { $in: ['Assigned', 'Collected'] },
    },
    { $set: { status: 'Open', updatedAt: new Date() } }
  );

  return { deleted: true, id: taskId };
}

// ============================================================================
// 8. Recycling Records CRUD & Mass Balance (BR-09, BR-10, BR-11, BR-14)
// ============================================================================

interface RecyclingPayload {
  taskId?: unknown;
  materialType?: unknown;
  receivedKg?: unknown;
  recycledKg?: unknown;
  disposalMethod?: unknown;
  facility?: unknown;
  processedDate?: unknown;
  notes?: unknown;
}

function validateRecyclingInput(input: RecyclingPayload, { isUpdate = false } = {}) {
  const taskId = isUpdate ? null : assertNonEmptyString(input?.taskId, 'Completed Task', 128);
  if (taskId) {
    toObjectId(taskId, 'Completed Task');
  }
  const materialType = assertEnum(input?.materialType, ENUMS.materialTypes, 'Material Type');
  const receivedKg = assertNumber(input?.receivedKg, 'Received kg', {
    exclusiveMin: 0,
    max: 100000,
  });
  const recycledKg = assertNumber(input?.recycledKg, 'Recycled kg', {
    min: 0,
    max: 100000,
  });

  // BR-10: recycledKg cannot exceed receivedKg
  if (recycledKg > receivedKg) {
    throw new BusinessRuleError('Recycled kg cannot exceed received kg');
  }

  const disposalMethod = assertEnum(input?.disposalMethod, ENUMS.disposalMethods, 'Disposal Method');
  const facility = typeof input?.facility === 'string' ? input.facility.trim().slice(0, 150) : '';
  const processedDate = assertDateString(input?.processedDate, 'Processed Date');
  const notes = typeof input?.notes === 'string' ? input.notes.trim().slice(0, 1000) : '';

  // BR-10: Auto-calculate recoveryRate rounded to 1 decimal place
  const recoveryRate = Number(((recycledKg / receivedKg) * 100).toFixed(1));

  return {
    ...(taskId ? { taskId } : {}),
    materialType,
    receivedKg,
    recycledKg,
    disposalMethod,
    facility,
    processedDate,
    recoveryRate,
    notes,
  };
}

async function reconcileParentReportStatus(db: Db, task: WithId<Document>): Promise<void> {
  const taskIdStr = task._id.toString();
  const records = await db
    .collection(COLLECTIONS.RECYCLING_RECORDS)
    .find({ taskId: taskIdStr })
    .project({ receivedKg: 1 })
    .toArray();

  const totalReceived = records.reduce((sum, r) => sum + Number(r.receivedKg || 0), 0);
  const collectedKg = Number(task.actualKg || 0);
  const targetStatus =
    Math.abs(totalReceived - collectedKg) < 1e-6 && collectedKg > 0 ? 'Closed' : 'Collected';

  await db.collection(COLLECTIONS.WASTE_REPORTS).updateOne(
    {
      _id: toObjectId(String(task.reportId), 'Waste Report'),
      status: { $in: ['Collected', 'Closed'] },
    },
    { $set: { status: targetStatus, updatedAt: new Date() } }
  );
}

export async function createRecyclingRecord(db: Db, input: RecyclingPayload) {
  const clean = validateRecyclingInput(input, { isUpdate: false });
  const taskId = clean.taskId as string;
  const taskObjId = toObjectId(taskId, 'Completed Task');

  const task = await db.collection(COLLECTIONS.COLLECTION_TASKS).findOne({ _id: taskObjId });
  if (!task) {
    throw new BusinessRuleError('Linked collection task not found', 404);
  }
  // BR-09: Only Completed tasks can receive recycling records
  if (task.status !== 'Completed') {
    throw new BusinessRuleError(`Task ${task.taskNo} is not completed`);
  }

  const siblings = await db
    .collection(COLLECTIONS.RECYCLING_RECORDS)
    .find({ taskId })
    .project({ receivedKg: 1 })
    .toArray();
  const existingSum = siblings.reduce((sum, r) => sum + Number(r.receivedKg || 0), 0);
  const collectedKg = Number(task.actualKg || 0);

  // BR-11: Total receivedKg across task records cannot exceed task.actualKg
  if (existingSum + clean.receivedKg > collectedKg + 1e-6) {
    throw new BusinessRuleError(`Records exceed the ${collectedKg} kg collected`);
  }

  const recordNo = await nextSequentialCode(db, COLLECTIONS.RECYCLING_RECORDS, 'RR-');
  const now = new Date();
  const doc = {
    recordNo,
    ...clean,
    createdAt: now,
    updatedAt: now,
  };

  const res = await db.collection(COLLECTIONS.RECYCLING_RECORDS).insertOne(doc);
  await reconcileParentReportStatus(db, task);

  return serializeDoc({ _id: res.insertedId, ...doc });
}

export async function updateRecyclingRecord(db: Db, recordId: string, input: RecyclingPayload) {
  const objId = toObjectId(recordId, 'Recycling Record ID');
  const clean = validateRecyclingInput(input, { isUpdate: true });

  const recCol = db.collection(COLLECTIONS.RECYCLING_RECORDS);
  const currentDoc = await recCol.findOne({ _id: objId });
  if (!currentDoc) {
    throw new BusinessRuleError('Recycling record not found', 404);
  }

  const taskId = String(currentDoc.taskId);
  const task = await db
    .collection(COLLECTIONS.COLLECTION_TASKS)
    .findOne({ _id: toObjectId(taskId, 'Collection Task') });
  if (!task) {
    throw new BusinessRuleError('Linked collection task not found', 404);
  }
  if (task.status !== 'Completed') {
    throw new BusinessRuleError(`Task ${task.taskNo} is not completed`);
  }

  const siblings = await recCol
    .find({ taskId, _id: { $ne: objId } })
    .project({ receivedKg: 1 })
    .toArray();
  const siblingSum = siblings.reduce((sum, r) => sum + Number(r.receivedKg || 0), 0);
  const collectedKg = Number(task.actualKg || 0);

  if (siblingSum + clean.receivedKg > collectedKg + 1e-6) {
    throw new BusinessRuleError(`Records exceed the ${collectedKg} kg collected`);
  }

  const updated = await recCol.findOneAndUpdate(
    { _id: objId },
    { $set: { ...clean, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!updated) {
    throw new BusinessRuleError('Recycling record not found', 404);
  }

  await reconcileParentReportStatus(db, task);
  return serializeDoc(updated);
}

export async function deleteRecyclingRecord(db: Db, recordId: string) {
  const objId = toObjectId(recordId, 'Recycling Record ID');
  const deleted = await db
    .collection(COLLECTIONS.RECYCLING_RECORDS)
    .findOneAndDelete({ _id: objId });

  if (!deleted) {
    throw new BusinessRuleError('Recycling record not found', 404);
  }

  const task = await db
    .collection(COLLECTIONS.COLLECTION_TASKS)
    .findOne({ _id: toObjectId(String(deleted.taskId), 'Collection Task') });
  if (task) {
    await reconcileParentReportStatus(db, task);
  }

  return { deleted: true, id: recordId };
}

// ============================================================================
// 9. Sample Data Seeder (Exercises Full Workflow & Business Rules)
// ============================================================================

function daysAgoDate(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

function daysAgoDateStr(daysAgo: number): string {
  return daysAgoDate(daysAgo).toISOString().slice(0, 10);
}

export async function seedSampleData(db: Db) {
  const existingLocations = await listLocations(db);
  const existingByCode = new Map(existingLocations.map((l) => [String(l.locationCode), l]));

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

  const locIds: Record<string, string> = {};
  let createdLocations = 0;

  for (const loc of sampleLocations) {
    const existing = existingByCode.get(loc.locationCode);
    if (existing) {
      locIds[loc.locationCode] = String(existing.id);
    } else {
      const created = await createLocation(db, loc);
      locIds[loc.locationCode] = String(created.id);
      createdLocations += 1;
    }
  }

  const r1 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-CAF01'],
      reportedBy: { name: 'Grace Namukasa', contact: 'grace.n@campus.edu', role: 'Staff' },
      wasteType: 'Organic',
      estimatedKg: 85,
      urgency: 'High',
      description: 'Post-lunch kitchen food prep scraps and compostables near loading bay.',
    },
    { reportedAt: daysAgoDate(64) }
  );

  const r2 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-LIB01'],
      reportedBy: { name: 'Dr. Henry Kato', contact: 'ext. 3102', role: 'Lecturer' },
      wasteType: 'Paper',
      estimatedKg: 42,
      urgency: 'Medium',
      description: 'Archived exam booklets and shredded office paper cartons.',
    },
    { reportedAt: daysAgoDate(48) }
  );

  const r3 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-HST01'],
      reportedBy: { name: 'Brian Mugisha', contact: '0772-418902', role: 'Student' },
      wasteType: 'Plastic',
      estimatedKg: 54,
      urgency: 'High',
      description: 'PET beverage bottles overflowing at North Hostel courtyard bins.',
    },
    { reportedAt: daysAgoDate(32) }
  );

  const r4 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-ENG02'],
      reportedBy: { name: 'Prof. Lydia Ssekitoleko', contact: 'lydia.s@campus.edu', role: 'Lecturer' },
      wasteType: 'E-waste',
      estimatedKg: 31,
      urgency: 'Medium',
      description: 'Decommissioned lab power supplies, keyboards, and copper cabling.',
    },
    { reportedAt: daysAgoDate(18) }
  );

  const r5 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-SPT01'],
      reportedBy: { name: 'Alex Twinomujuni', contact: 'ext. 2219', role: 'Staff' },
      wasteType: 'Metal',
      estimatedKg: 26,
      urgency: 'Low',
      description: 'Aluminum beverage cans collected after inter-faculty tournament.',
    },
    { reportedAt: daysAgoDate(8) }
  );

  const r6 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-HST01'],
      reportedBy: { name: 'Sarah Achieng', contact: 'sarah.a@campus.edu', role: 'Student' },
      wasteType: 'Glass',
      estimatedKg: 19,
      urgency: 'Medium',
      description: 'Glass bottles stacked behind Block C stairwell.',
    },
    { reportedAt: daysAgoDate(3) }
  );

  const r7 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-CAF01'],
      reportedBy: { name: 'Daniel Ochieng', contact: 'ext. 1140', role: 'Staff' },
      wasteType: 'Plastic',
      estimatedKg: 22,
      urgency: 'High',
      description: 'Single-use packaging containers at West Kiosk awaiting pickup.',
    },
    { reportedAt: daysAgoDate(1) }
  );

  const r8 = await createWasteReport(
    db,
    {
      locationId: locIds['LOC-LIB01'],
      reportedBy: { name: 'Visitor Desk', contact: '', role: 'Visitor' },
      wasteType: 'Mixed',
      estimatedKg: 4,
      urgency: 'Low',
      description: 'Duplicate entry reported earlier by library staff.',
    },
    { reportedAt: daysAgoDate(12) }
  );

  await rejectOrCancelReport(db, String(r8.id), 'Rejected', 'Duplicate of morning library clearance ticket.');

  const t1 = await createCollectionTask(db, {
    reportId: r1.id,
    assignedTo: { name: 'Samuel Okello', staffId: 'ENV-101' },
    scheduledDate: daysAgoDateStr(63),
    equipment: 'Tipper truck, compost totes',
    remarks: 'Prioritized morning pickup before heat.',
  });
  await startCollectionTask(db, String(t1.id), { startedAt: daysAgoDate(63) });
  await completeCollectionTask(
    db,
    String(t1.id),
    88,
    'Delivered directly to campus compost windrows.',
    { completedAt: daysAgoDate(62) }
  );

  const t2 = await createCollectionTask(db, {
    reportId: r2.id,
    assignedTo: { name: 'Martha Nalubega', staffId: 'ENV-104' },
    scheduledDate: daysAgoDateStr(46),
    equipment: 'Covered van, pallet trolley',
    remarks: 'Dry paper kept separate from moisture.',
  });
  await startCollectionTask(db, String(t2.id), { startedAt: daysAgoDate(46) });
  await completeCollectionTask(db, String(t2.id), 40, 'Baled at campus MRF.', {
    completedAt: daysAgoDate(45),
  });

  const t3 = await createCollectionTask(db, {
    reportId: r3.id,
    assignedTo: { name: 'Samuel Okello', staffId: 'ENV-101' },
    scheduledDate: daysAgoDateStr(30),
    equipment: 'Mesh cage trailer, PPE gloves',
    remarks: 'Sorted PET from HDPE caps on site.',
  });
  await startCollectionTask(db, String(t3.id), { startedAt: daysAgoDate(30) });
  await completeCollectionTask(db, String(t3.id), 58, 'High-purity PET load.', {
    completedAt: daysAgoDate(29),
  });

  const t4 = await createCollectionTask(db, {
    reportId: r4.id,
    assignedTo: { name: 'Peter Wasswa', staffId: 'ENV-109' },
    scheduledDate: daysAgoDateStr(15),
    equipment: 'ESD crates, pallet jack',
    remarks: 'Isolated circuit boards and copper wire.',
  });
  await startCollectionTask(db, String(t4.id), { startedAt: daysAgoDate(15) });
  await completeCollectionTask(
    db,
    String(t4.id),
    30,
    'Logged for specialist e-waste partner.',
    { completedAt: daysAgoDate(14) }
  );

  const t5 = await createCollectionTask(db, {
    reportId: r5.id,
    assignedTo: { name: 'Martha Nalubega', staffId: 'ENV-104' },
    scheduledDate: daysAgoDateStr(0),
    equipment: 'Utility cart, sorting bags',
    remarks: 'Currently loading aluminum bags at South Fields.',
  });
  await startCollectionTask(db, String(t5.id));

  await createCollectionTask(db, {
    reportId: r6.id,
    assignedTo: { name: 'Peter Wasswa', staffId: 'ENV-109' },
    scheduledDate: daysAgoDateStr(-1),
    equipment: 'Reinforced glass bins, safety goggles',
    remarks: 'Scheduled for tomorrow morning round.',
  });

  await createRecyclingRecord(db, {
    taskId: t1.id,
    materialType: 'Organic',
    receivedKg: 88,
    recycledKg: 82,
    disposalMethod: 'Composted',
    facility: 'Campus Botanical Compost Yard',
    processedDate: daysAgoDateStr(61),
    notes: '6 kg non-compostable wrappers removed prior to windrowing.',
  });

  await createRecyclingRecord(db, {
    taskId: t2.id,
    materialType: 'Paper',
    receivedKg: 40,
    recycledKg: 38.5,
    disposalMethod: 'Reused',
    facility: 'GreenLeaf Paper Mill Partner',
    processedDate: daysAgoDateStr(44),
    notes: 'Clean office grade pulp stock.',
  });

  await createRecyclingRecord(db, {
    taskId: t3.id,
    materialType: 'Plastic',
    receivedKg: 58,
    recycledKg: 51,
    disposalMethod: 'Landfill',
    facility: 'Campus MRF Sorting Bay',
    processedDate: daysAgoDateStr(28),
    notes: '7 kg contaminated film sent to residual landfill.',
  });

  await createRecyclingRecord(db, {
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
