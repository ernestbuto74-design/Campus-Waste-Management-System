/**
 * db-service.js
 * ---------------------------------------------------------------------------
 * Frontend API Service, Client Validation, Dashboard Aggregator, and
 * Subscription Sync Layer backed by Express + MongoDB Atlas (`campuswasteDB`).
 * ---------------------------------------------------------------------------
 */

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

// ============================================================================
// 2. Structured Error Handling & HTTP Client
// ============================================================================

export class BusinessRuleError extends Error {
  constructor(message, code = 'BUSINESS_RULE_VIOLATION') {
    super(message);
    this.name = 'BusinessRuleError';
    this.code = code;
  }
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  let data = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => '');
    data = text ? { error: text } : null;
  }

  if (!response.ok) {
    const msg = data?.error || `Request failed with status ${response.status}`;
    if (data?.isBusinessRule || response.status === 400 || response.status === 409) {
      throw new BusinessRuleError(msg, data?.code || 'BUSINESS_RULE_VIOLATION');
    }
    throw new Error(msg);
  }

  return data;
}

export async function testConnection() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      return {
        ok: false,
        offline: true,
        message:
          data?.error ||
          'MongoDB Atlas is not connected. Verify MONGODB_URI in your server environment.',
      };
    }
    return { ok: true, database: data.database };
  } catch (error) {
    return {
      ok: false,
      offline: true,
      message: error instanceof Error ? error.message : 'Unable to reach API server.',
    };
  }
}

// ============================================================================
// 3. Date & Validation Helpers
// ============================================================================

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

// ============================================================================
// 4. Live Collection Sync Manager (Bootstrap + Mutation Refresh + Polling)
// ============================================================================

const activeSubscribers = new Set();

export async function refreshAllCollections() {
  if (activeSubscribers.size === 0) return null;
  try {
    const data = await apiRequest('/api/bootstrap', { method: 'GET' });
    activeSubscribers.forEach((callbacks) => {
      callbacks.onLocations?.(data.locations || []);
      callbacks.onReports?.(data.reports || []);
      callbacks.onTasks?.(data.tasks || []);
      callbacks.onRecycling?.(data.recycling || []);
    });
    return data;
  } catch (error) {
    activeSubscribers.forEach((callbacks) => {
      callbacks.onError?.(error, 'campuswasteDB');
    });
    return null;
  }
}

export function subscribeAllCollections(callbacks) {
  activeSubscribers.add(callbacks);
  void refreshAllCollections();

  const timerId = window.setInterval(() => {
    if (document.visibilityState === 'visible') {
      void refreshAllCollections();
    }
  }, 15000);

  return () => {
    window.clearInterval(timerId);
    activeSubscribers.delete(callbacks);
  };
}

// ============================================================================
// 5. Composite Query Demonstration (MongoDB Compound Filter + Sort)
// ============================================================================

export async function runWasteReportCompositeQuery({ status, wasteType, locationId }) {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (wasteType && wasteType !== 'all') params.set('wasteType', wasteType);
  if (locationId && locationId !== 'all') params.set('locationId', locationId);

  const queryString = params.toString();
  const data = await apiRequest(`/api/reports${queryString ? `?${queryString}` : ''}`, {
    method: 'GET',
  });

  return {
    source: data.source || 'mongodb-server',
    items: data.items || [],
  };
}

// ============================================================================
// 6. Collection 1: Locations CRUD
// ============================================================================

function validateLocationInput(input) {
  const rawCode = assertNonEmptyString(input.locationCode, 'Location Code', 32).toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(rawCode)) {
    throw new BusinessRuleError(
      'Location Code must be 2–32 characters using A–Z, 0–9, hyphens, or underscores'
    );
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

  return {
    locationCode: rawCode,
    name,
    type: input.type,
    area,
    bins,
    isActive: Boolean(input.isActive),
  };
}

export async function createLocation(input) {
  const clean = validateLocationInput(input);
  const created = await apiRequest('/api/locations', {
    method: 'POST',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return created;
}

export async function updateLocation(locationId, input) {
  const clean = validateLocationInput(input);
  const updated = await apiRequest(`/api/locations/${encodeURIComponent(locationId)}`, {
    method: 'PUT',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return updated;
}

export async function deleteLocation(locationId) {
  const res = await apiRequest(`/api/locations/${encodeURIComponent(locationId)}`, {
    method: 'DELETE',
  });
  await refreshAllCollections();
  return res;
}

// ============================================================================
// 7. Collection 2: Waste Reports CRUD & Workflow
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

export async function createWasteReport(input) {
  const clean = validateReportInput(input);
  const created = await apiRequest('/api/reports', {
    method: 'POST',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return created;
}

export async function updateWasteReport(reportId, input) {
  const clean = validateReportInput(input);
  const updated = await apiRequest(`/api/reports/${encodeURIComponent(reportId)}`, {
    method: 'PUT',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return updated;
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

  const updated = await apiRequest(`/api/reports/${encodeURIComponent(reportId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: targetStatus, statusReason: reason }),
  });
  await refreshAllCollections();
  return updated;
}

export async function deleteWasteReport(reportId) {
  const res = await apiRequest(`/api/reports/${encodeURIComponent(reportId)}`, {
    method: 'DELETE',
  });
  await refreshAllCollections();
  return res;
}

// ============================================================================
// 8. Collection 3: Collection Tasks CRUD & Workflow
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
  const created = await apiRequest('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return created;
}

export async function updateCollectionTask(taskId, input) {
  const clean = validateTaskInput(input, { isUpdate: true });
  const updated = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PUT',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return updated;
}

export async function startCollectionTask(taskId) {
  const updated = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
    method: 'PATCH',
  });
  await refreshAllCollections();
  return updated;
}

export async function completeCollectionTask(taskId, actualKgInput, remarksInput = null) {
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

  const updated = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: 'PATCH',
    body: JSON.stringify({ actualKg, remarks: remarksInput }),
  });
  await refreshAllCollections();
  return updated;
}

export async function cancelCollectionTask(taskId, remarksInput = null) {
  const updated = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'PATCH',
    body: JSON.stringify({ remarks: remarksInput }),
  });
  await refreshAllCollections();
  return updated;
}

export async function deleteCollectionTask(taskId) {
  const res = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  });
  await refreshAllCollections();
  return res;
}

// ============================================================================
// 9. Collection 4: Recycling Records CRUD & Mass Balance
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

  if (recycledKg > receivedKg) {
    throw new BusinessRuleError('Recycled kg cannot exceed received kg');
  }

  assertEnum(input.disposalMethod, ENUMS.disposalMethods, 'Disposal Method');
  const facility = typeof input.facility === 'string' ? input.facility.trim().slice(0, 150) : '';
  const processedDate = assertDateString(input.processedDate, 'Processed Date');
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 1000) : '';
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
  const created = await apiRequest('/api/recycling', {
    method: 'POST',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return created;
}

export async function updateRecyclingRecord(recordId, input) {
  const clean = validateRecyclingInput(input, { isUpdate: true });
  const updated = await apiRequest(`/api/recycling/${encodeURIComponent(recordId)}`, {
    method: 'PUT',
    body: JSON.stringify(clean),
  });
  await refreshAllCollections();
  return updated;
}

export async function deleteRecyclingRecord(recordId) {
  const res = await apiRequest(`/api/recycling/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
  });
  await refreshAllCollections();
  return res;
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

  const reportsByStatus = {};
  ENUMS.reportStatuses.forEach((s) => {
    reportsByStatus[s] = 0;
  });
  reports.forEach((r) => {
    reportsByStatus[r.status] = (reportsByStatus[r.status] || 0) + 1;
  });

  const volumeByWasteType = {};
  ENUMS.wasteTypes.forEach((wt) => {
    volumeByWasteType[wt] = 0;
  });
  reports.forEach((r) => {
    volumeByWasteType[r.wasteType] =
      (volumeByWasteType[r.wasteType] || 0) + Number(r.estimatedKg || 0);
  });

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
// 11. Sample Data Seeder
// ============================================================================

export async function seedSampleData() {
  const summary = await apiRequest('/api/seed', {
    method: 'POST',
  });
  await refreshAllCollections();
  return summary;
}
