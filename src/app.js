/**
 * app.js
 * ---------------------------------------------------------------------------
 * UI Controller for the Campus Waste Management System.
 * Pure vanilla JavaScript (ES Modules) + Chart.js + MongoDB Atlas API service layer.
 * ---------------------------------------------------------------------------
 */

import Chart from 'chart.js/auto';
import {
  BusinessRuleError,
  ENUMS,
  cancelCollectionTask,
  completeCollectionTask,
  computeDashboardMetrics,
  createCollectionTask,
  createLocation,
  createRecyclingRecord,
  createWasteReport,
  deleteCollectionTask,
  deleteLocation,
  deleteRecyclingRecord,
  deleteWasteReport,
  rejectOrCancelReport,
  runWasteReportCompositeQuery,
  seedSampleData,
  startCollectionTask,
  subscribeAllCollections,
  testConnection,
  toDate,
  updateCollectionTask,
  updateLocation,
  updateRecyclingRecord,
  updateWasteReport,
} from './db-service.js';

// ============================================================================
// 1. Application State
// ============================================================================

const state = {
  activeView: 'dashboard',
  locations: [],
  reports: [],
  tasks: [],
  recycling: [],
  // Optional server-side composite query override for Waste Reports
  reportsServerOverride: null,
  // Live bin sub-form rows for Locations
  binsDraft: [{ binType: 'General', capacityLitres: 120 }],
  // Chart.js instances
  charts: {
    status: null,
    wasteType: null,
    monthly: null,
    materials: null,
  },
  isSeeding: false,
};

const VIEW_LABELS = {
  dashboard: 'Dashboard',
  locations: 'Locations',
  reports: 'Waste Reports',
  tasks: 'Collection Tasks',
  recycling: 'Recycling Records',
};

const TOPBAR_CTA = {
  dashboard: '+ Log Waste Report',
  locations: '+ Add Location',
  reports: '+ Log Waste Report',
  tasks: '+ Schedule Task',
  recycling: '+ Log Recycling',
};

// ============================================================================
// 2. Formatting & Security Helpers
// ============================================================================

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(value) {
  const dt = toDate(value);
  if (!dt) return '—';
  return dt.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatKg(value) {
  const num = Number(value || 0);
  return `${num.toFixed(1)} kg`;
}

function statusClass(status) {
  return `status-${String(status || '').toLowerCase().replace(/\s+/g, '-')}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================================
// 3. Toast & Banner Notifications
// ============================================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast is-${type}`;

  const text = document.createElement('span');
  text.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn-ghost btn-sm';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => el.remove());

  el.appendChild(text);
  el.appendChild(close);
  container.appendChild(el);

  window.setTimeout(() => {
    if (el.isConnected) el.remove();
  }, 6000);
}

function showError(error) {
  if (error instanceof BusinessRuleError) {
    showToast(error.message, 'error');
    return;
  }
  const msg = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(msg);
    if (parsed && parsed.error) {
      showToast(`Database error (${parsed.operationType} on ${parsed.path}): ${parsed.error}`, 'error');
      return;
    }
  } catch {
    // Non-JSON error
  }
  showToast(msg || 'An unexpected error occurred.', 'error');
}

function showBanner(htmlContent) {
  const banner = document.getElementById('system-banner');
  const content = document.getElementById('system-banner-content');
  content.innerHTML = htmlContent;
  banner.hidden = false;
}

function hideBanner() {
  document.getElementById('system-banner').hidden = true;
}

// ============================================================================
// 4. Accessible Modal Helpers
// ============================================================================

function openModal({ title, bodyHtml, actions }) {
  const overlay = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const bodyEl = document.getElementById('modal-body');
  const footerEl = document.getElementById('modal-footer');

  titleEl.textContent = title;
  bodyEl.innerHTML = bodyHtml;
  footerEl.innerHTML = '';

  actions.forEach((act) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = act.className || 'btn-secondary';
    btn.textContent = act.label;
    btn.addEventListener('click', () => act.onClick({ closeModal, bodyEl }));
    footerEl.appendChild(btn);
  });

  overlay.hidden = false;
}

function closeModal() {
  document.getElementById('modal-overlay').hidden = true;
}

function confirmDelete(entityLabel, onConfirm) {
  openModal({
    title: 'Confirm Deletion',
    bodyHtml: `<p>Are you sure you want to permanently delete <strong>${escapeHtml(
      entityLabel
    )}</strong>? Referential integrity checks will block deletion if child records exist.</p>`,
    actions: [
      { label: 'Cancel', className: 'btn-secondary', onClick: () => closeModal() },
      {
        label: 'Delete Record',
        className: 'btn-danger',
        onClick: async () => {
          closeModal();
          try {
            await onConfirm();
            showToast(`${entityLabel} deleted.`, 'success');
          } catch (err) {
            showError(err);
          }
        },
      },
    ],
  });
}

// ============================================================================
// 5. Navigation & View Switching
// ============================================================================

function switchView(viewName) {
  if (!VIEW_LABELS[viewName]) return;
  state.activeView = viewName;

  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.hidden = sec.id !== `view-${viewName}`;
  });

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === viewName);
  });

  document.getElementById('page-title').textContent = VIEW_LABELS[viewName];
  document.getElementById('btn-topbar-primary').textContent = TOPBAR_CTA[viewName];

  // Close mobile drawer if open
  closeMobileSidebar();

  if (viewName === 'dashboard') {
    renderDashboard();
  }
}

function openMobileSidebar() {
  document.getElementById('sidebar').classList.add('is-open');
  document.getElementById('sidebar-backdrop').hidden = false;
  document.getElementById('btn-mobile-menu').setAttribute('aria-expanded', 'true');
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('is-open');
  document.getElementById('sidebar-backdrop').hidden = true;
  document.getElementById('btn-mobile-menu').setAttribute('aria-expanded', 'false');
}

// ============================================================================
// 6. Render All Views from Live MongoDB Atlas State
// ============================================================================

function renderAll() {
  document.getElementById('nav-count-locations').textContent = state.locations.length;
  document.getElementById('nav-count-reports').textContent = state.reports.length;
  document.getElementById('nav-count-tasks').textContent = state.tasks.length;
  document.getElementById('nav-count-recycling').textContent = state.recycling.length;

  renderLocationSelectOptions();
  renderLocationsTable();
  renderReportsTable();
  renderOpenReportSelectOptions();
  renderTasksTable();
  renderCompletedTaskSelectOptions();
  renderRecyclingTable();
  renderDashboard();
}

// ============================================================================
// 7. View 1: Dashboard & Chart.js Aggregations
// ============================================================================

function renderDashboard() {
  const metrics = computeDashboardMetrics({
    locations: state.locations,
    reports: state.reports,
    tasks: state.tasks,
    recycling: state.recycling,
  });

  const { kpis } = metrics;

  document.getElementById('kpi-total-reports').textContent = String(kpis.totalReports);
  document.getElementById('kpi-open-reports').textContent = String(kpis.openReports);
  document.getElementById('kpi-tasks-completed').textContent = String(kpis.tasksCompleted);
  document.getElementById('kpi-tasks-completed-sub').textContent = `${kpis.tasksActive} scheduled or active`;
  document.getElementById('kpi-total-collected').textContent = formatKg(kpis.totalCollectedKg);
  document.getElementById('kpi-total-recycled').textContent = formatKg(kpis.totalRecycledKg);
  document.getElementById('kpi-recovery-rate').textContent = `${kpis.overallRecoveryRate.toFixed(1)}%`;

  const turnaroundStr =
    kpis.avgTurnaroundDays !== null
      ? `${kpis.avgTurnaroundDays.toFixed(2)} days (${kpis.turnaroundSampleSize} tasks)`
      : 'No completed tasks yet';
  document.getElementById('dash-turnaround-summary').textContent = `Avg. turnaround: ${
    kpis.avgTurnaroundDays !== null ? `${kpis.avgTurnaroundDays.toFixed(2)} days` : '—'
  }`;
  document.getElementById('dash-turnaround-value').textContent = turnaroundStr;
  document.getElementById('dash-last-sync').textContent = `Last updated ${new Date().toLocaleTimeString()}`;

  const isEmpty =
    state.locations.length === 0 &&
    state.reports.length === 0 &&
    state.tasks.length === 0 &&
    state.recycling.length === 0;

  document.getElementById('dashboard-empty-state').hidden = !isEmpty;
  document.getElementById('dashboard-charts-grid').hidden = isEmpty;

  if (isEmpty) return;

  renderStatusChart(metrics.reportsByStatus);
  renderWasteTypeChart(metrics.volumeByWasteType);
  renderMonthlyChart(metrics.monthlyCollected);
  renderTopLocations(metrics.topLocations);
  renderMaterialsChartAndTable(metrics.materialBreakdown);
}

function upsertChart(key, canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (state.charts[key]) {
    state.charts[key].destroy();
  }
  state.charts[key] = new Chart(canvas, config);
}

function renderStatusChart(reportsByStatus) {
  const labels = Object.keys(reportsByStatus);
  const values = Object.values(reportsByStatus);
  const colors = ['#0369A1', '#B45309', '#15803D', '#166534', '#B91C1C', '#64748B'];

  upsertChart('status', 'chart-reports-status', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Reports',
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { grid: { display: false } },
      },
    },
  });

  const breakdownEl = document.getElementById('breakdown-reports-status');
  breakdownEl.innerHTML = labels
    .map(
      (label, i) => `
      <div class="breakdown-item">
        <span>${escapeHtml(label)}</span>
        <strong class="mono">${values[i]}</strong>
      </div>`
    )
    .join('');
}

function renderWasteTypeChart(volumeByWasteType) {
  const entries = Object.entries(volumeByWasteType).filter(([, kg]) => kg > 0);
  const labels = entries.length ? entries.map(([k]) => k) : ['No Data'];
  const values = entries.length ? entries.map(([, v]) => Number(v.toFixed(1))) : [0];

  upsertChart('wasteType', 'chart-waste-type', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Estimated Volume (kg)',
          data: values,
          backgroundColor: '#15803D',
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true },
        y: { grid: { display: false } },
      },
    },
  });
}

function renderMonthlyChart(monthlyCollected) {
  const labels = monthlyCollected.length ? monthlyCollected.map((m) => m.month) : ['No Collections'];
  const values = monthlyCollected.length ? monthlyCollected.map((m) => m.kg) : [0];

  upsertChart('monthly', 'chart-monthly-collected', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Collected (kg)',
          data: values,
          backgroundColor: '#0369A1',
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderTopLocations(topLocations) {
  const container = document.getElementById('top-locations-list');
  if (topLocations.length === 0) {
    container.innerHTML = `<p class="cell-meta">No completed collections recorded yet.</p>`;
    return;
  }
  const maxKg = Math.max(...topLocations.map((l) => l.kg), 1);
  container.innerHTML = topLocations
    .map((loc, idx) => {
      const pct = Math.min(100, (loc.kg / maxKg) * 100);
      return `
        <div class="ranked-row">
          <div class="ranked-row-head">
            <div>
              <span class="ranked-name">${idx + 1}. ${escapeHtml(loc.name)}</span>
              <span class="ranked-meta">${escapeHtml(loc.code)} · ${loc.taskCount} pickup${
                loc.taskCount === 1 ? '' : 's'
              }</span>
            </div>
            <span class="ranked-kg tabular-nums">${loc.kg.toFixed(1)} kg</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width: ${pct.toFixed(1)}%"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderMaterialsChartAndTable(materialBreakdown) {
  const tbody = document.getElementById('tbody-material-breakdown');
  if (materialBreakdown.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="table-empty-cell">No recycling records logged yet.</td></tr>`;
    upsertChart('materials', 'chart-recycling-materials', {
      type: 'bar',
      data: { labels: ['No Data'], datasets: [{ label: 'Recycled (kg)', data: [0] }] },
      options: { responsive: true, maintainAspectRatio: false },
    });
    return;
  }

  tbody.innerHTML = materialBreakdown
    .map(
      (m) => `
      <tr>
        <td><strong>${escapeHtml(m.materialType)}</strong></td>
        <td class="num">${m.receivedKg.toFixed(1)}</td>
        <td class="num">${m.recycledKg.toFixed(1)}</td>
        <td class="num"><strong>${m.recoveryRate.toFixed(1)}%</strong></td>
      </tr>`
    )
    .join('');

  upsertChart('materials', 'chart-recycling-materials', {
    type: 'bar',
    data: {
      labels: materialBreakdown.map((m) => m.materialType),
      datasets: [
        {
          label: 'Received (kg)',
          data: materialBreakdown.map((m) => m.receivedKg),
          backgroundColor: '#CBD5E1',
          borderRadius: 4,
        },
        {
          label: 'Recycled (kg)',
          data: materialBreakdown.map((m) => m.recycledKg),
          backgroundColor: '#15803D',
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true },
        x: { grid: { display: false } },
      },
    },
  });
}

// ============================================================================
// 8. View 2: Locations CRUD + Dynamic Embedded Bins Sub-Form
// ============================================================================

function renderBinsSubform() {
  const container = document.getElementById('loc-bins-container');
  container.innerHTML = '';

  state.binsDraft.forEach((bin, idx) => {
    const row = document.createElement('div');
    row.className = 'bin-row';

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Bin ${idx + 1} type`);
    ENUMS.binTypes.forEach((bt) => {
      const opt = document.createElement('option');
      opt.value = bt;
      opt.textContent = bt;
      if (bt === bin.binType) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      state.binsDraft[idx].binType = select.value;
    });

    const cap = document.createElement('input');
    cap.type = 'number';
    cap.min = '1';
    cap.step = '1';
    cap.value = String(bin.capacityLitres);
    cap.placeholder = 'Litres';
    cap.setAttribute('aria-label', `Bin ${idx + 1} capacity in litres`);
    cap.addEventListener('input', () => {
      state.binsDraft[idx].capacityLitres = cap.value;
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn';
    removeBtn.title = 'Remove bin';
    removeBtn.setAttribute('aria-label', 'Remove bin');
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      state.binsDraft.splice(idx, 1);
      renderBinsSubform();
    });

    row.appendChild(select);
    row.appendChild(cap);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

function resetLocationForm() {
  document.getElementById('loc-id').value = '';
  document.getElementById('loc-code').value = '';
  document.getElementById('loc-name').value = '';
  document.getElementById('loc-type').value = 'Cafeteria';
  document.getElementById('loc-area').value = '';
  document.getElementById('loc-active').checked = true;
  state.binsDraft = [{ binType: 'General', capacityLitres: 120 }];
  renderBinsSubform();
  document.getElementById('loc-form-title').textContent = 'Add Campus Location';
  document.getElementById('btn-loc-submit').textContent = 'Save Location';
  document.getElementById('btn-loc-reset').hidden = true;
}

function editLocation(loc) {
  document.getElementById('loc-id').value = loc.id;
  document.getElementById('loc-code').value = loc.locationCode;
  document.getElementById('loc-name').value = loc.name;
  document.getElementById('loc-type').value = loc.type;
  document.getElementById('loc-area').value = loc.area;
  document.getElementById('loc-active').checked = Boolean(loc.isActive);
  state.binsDraft = Array.isArray(loc.bins)
    ? loc.bins.map((b) => ({ binType: b.binType, capacityLitres: b.capacityLitres }))
    : [];
  renderBinsSubform();
  document.getElementById('loc-form-title').textContent = `Edit ${loc.locationCode}`;
  document.getElementById('btn-loc-submit').textContent = 'Update Location';
  document.getElementById('btn-loc-reset').hidden = false;
  document.getElementById('loc-code').focus();
}

function renderLocationsTable() {
  const search = document.getElementById('loc-search').value.trim().toLowerCase();
  const activeFilter = document.getElementById('loc-filter-active').value;

  const filtered = state.locations.filter((loc) => {
    if (activeFilter === 'active' && !loc.isActive) return false;
    if (activeFilter === 'inactive' && loc.isActive) return false;
    if (!search) return true;
    return (
      loc.locationCode.toLowerCase().includes(search) ||
      loc.name.toLowerCase().includes(search) ||
      loc.area.toLowerCase().includes(search)
    );
  });

  document.getElementById('loc-count-summary').textContent = `${filtered.length} of ${state.locations.length} locations`;
  const tbody = document.getElementById('tbody-locations');

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="table-empty-cell">No matching campus locations found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((loc) => {
      const binsSummary =
        Array.isArray(loc.bins) && loc.bins.length > 0
          ? loc.bins.map((b) => `${escapeHtml(b.binType)} (${b.capacityLitres} L)`).join(' · ')
          : 'No bins configured';
      const statusText = loc.isActive ? 'Active' : 'Inactive';
      const statusCss = loc.isActive ? 'status-active' : 'status-inactive';

      return `
        <tr data-loc-id="${escapeHtml(loc.id)}">
          <td class="mono"><strong>${escapeHtml(loc.locationCode)}</strong></td>
          <td>
            <div class="cell-primary">${escapeHtml(loc.name)}</div>
            <div class="cell-meta">${escapeHtml(loc.area)}</div>
          </td>
          <td>${escapeHtml(loc.type)}</td>
          <td><div class="cell-meta">${binsSummary}</div></td>
          <td><span class="status-tag ${statusCss}">${statusText}</span></td>
          <td class="actions-col">
            <div class="row-actions">
              <button type="button" class="action-link" data-action="edit-loc">Edit</button>
              <button type="button" class="action-link is-danger" data-action="del-loc">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

// ============================================================================
// 9. View 3: Waste Reports CRUD, Filters & Composite Query
// ============================================================================

function renderLocationSelectOptions() {
  const activeLocs = state.locations.filter((l) => l.isActive);
  const reportLocSelect = document.getElementById('rep-location');
  const prevVal = reportLocSelect.value;

  if (activeLocs.length === 0) {
    reportLocSelect.innerHTML = `<option value="">No active locations available</option>`;
  } else {
    reportLocSelect.innerHTML = activeLocs
      .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.locationCode)} · ${escapeHtml(l.name)}</option>`)
      .join('');
    if (activeLocs.some((l) => l.id === prevVal)) {
      reportLocSelect.value = prevVal;
    }
  }

  const filterLocSelect = document.getElementById('rep-filter-location');
  const prevFilter = filterLocSelect.value || 'all';
  filterLocSelect.innerHTML =
    `<option value="all">All Locations</option>` +
    state.locations
      .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.locationCode)} · ${escapeHtml(l.name)}</option>`)
      .join('');
  filterLocSelect.value = state.locations.some((l) => l.id === prevFilter) ? prevFilter : 'all';
}

function resetReportForm() {
  document.getElementById('rep-id').value = '';
  document.getElementById('rep-no').value = 'Auto-generated (WR-####)';
  document.getElementById('rep-by-name').value = '';
  document.getElementById('rep-by-role').value = 'Student';
  document.getElementById('rep-by-contact').value = '';
  document.getElementById('rep-waste-type').value = 'Plastic';
  document.getElementById('rep-est-kg').value = '';
  document.getElementById('rep-urgency').value = 'Medium';
  document.getElementById('rep-desc').value = '';
  document.getElementById('rep-form-title').textContent = 'Log Waste Report';
  document.getElementById('btn-rep-submit').textContent = 'Submit Waste Report';
  document.getElementById('btn-rep-reset').hidden = true;
}

function editReport(rep) {
  if (!['Open', 'Assigned'].includes(rep.status)) {
    showToast(`Report ${rep.reportNo} cannot be edited when status is ${rep.status}.`, 'error');
    return;
  }
  document.getElementById('rep-id').value = rep.id;
  document.getElementById('rep-no').value = rep.reportNo;
  document.getElementById('rep-location').value = rep.locationId;
  document.getElementById('rep-by-name').value = rep.reportedBy?.name || '';
  document.getElementById('rep-by-role').value = rep.reportedBy?.role || 'Student';
  document.getElementById('rep-by-contact').value = rep.reportedBy?.contact || '';
  document.getElementById('rep-waste-type').value = rep.wasteType;
  document.getElementById('rep-est-kg').value = String(rep.estimatedKg);
  document.getElementById('rep-urgency').value = rep.urgency;
  document.getElementById('rep-desc').value = rep.description || '';
  document.getElementById('rep-form-title').textContent = `Edit ${rep.reportNo}`;
  document.getElementById('btn-rep-submit').textContent = 'Update Waste Report';
  document.getElementById('btn-rep-reset').hidden = false;
  document.getElementById('rep-location').focus();
}

function openRejectCancelReportModal(rep, targetStatus) {
  openModal({
    title: `${targetStatus === 'Rejected' ? 'Reject' : 'Cancel'} Report ${rep.reportNo}`,
    bodyHtml: `
      <p>Provide a clear reason for setting <strong>${escapeHtml(rep.reportNo)}</strong> to <strong>${escapeHtml(
        targetStatus
      )}</strong> (required by BR-12).</p>
      <div class="field">
        <label for="modal-report-reason">Status Reason <span class="req">*</span></label>
        <textarea id="modal-report-reason" rows="3" maxlength="500" placeholder="Duplicate report, invalid waste stream, or false alarm..."></textarea>
      </div>
    `,
    actions: [
      { label: 'Back', className: 'btn-secondary', onClick: () => closeModal() },
      {
        label: `Confirm ${targetStatus}`,
        className: 'btn-danger',
        onClick: async () => {
          const reason = document.getElementById('modal-report-reason').value;
          try {
            await rejectOrCancelReport(rep.id, targetStatus, reason);
            closeModal();
            showToast(`Report ${rep.reportNo} marked as ${targetStatus}.`, 'success');
          } catch (err) {
            showError(err);
          }
        },
      },
    ],
  });
}

function renderReportsTable() {
  const locMap = new Map(state.locations.map((l) => [l.id, l]));
  const search = document.getElementById('rep-search').value.trim().toLowerCase();
  const statusFilter = document.getElementById('rep-filter-status').value;
  const wasteFilter = document.getElementById('rep-filter-waste').value;
  const locFilter = document.getElementById('rep-filter-location').value;

  const baseList = state.reportsServerOverride || state.reports;

  const filtered = baseList.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (wasteFilter !== 'all' && r.wasteType !== wasteFilter) return false;
    if (locFilter !== 'all' && r.locationId !== locFilter) return false;
    if (!search) return true;
    return (
      r.reportNo.toLowerCase().includes(search) ||
      (r.description || '').toLowerCase().includes(search) ||
      (r.reportedBy?.name || '').toLowerCase().includes(search)
    );
  });

  document.getElementById('rep-count-summary').textContent = `${filtered.length} of ${state.reports.length} reports${
    state.reportsServerOverride ? ' (MongoDB server query)' : ''
  }`;
  const tbody = document.getElementById('tbody-reports');

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty-cell">No matching waste reports found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((rep) => {
      const loc = locMap.get(rep.locationId);
      const locLabel = loc ? `${loc.name} (${loc.locationCode})` : 'Unknown Location';
      const canEdit = ['Open', 'Assigned'].includes(rep.status);
      const canRejectCancel = rep.status === 'Open';
      const reasonLine = rep.statusReason
        ? `<div class="cell-meta">Reason: ${escapeHtml(rep.statusReason)}</div>`
        : '';

      return `
        <tr data-rep-id="${escapeHtml(rep.id)}">
          <td class="mono"><strong>${escapeHtml(rep.reportNo)}</strong></td>
          <td>
            <div class="cell-primary">${escapeHtml(locLabel)}</div>
            <div class="cell-meta">${escapeHtml(rep.reportedBy?.name || '')} · ${escapeHtml(
              rep.reportedBy?.role || ''
            )}${rep.description ? ` · ${escapeHtml(rep.description)}` : ''}</div>
          </td>
          <td>
            <div class="cell-primary">${escapeHtml(rep.wasteType)}</div>
            <div class="cell-meta">Urgency: ${escapeHtml(rep.urgency)}</div>
          </td>
          <td class="num">${Number(rep.estimatedKg || 0).toFixed(1)}</td>
          <td>
            <span class="status-tag ${statusClass(rep.status)}">${escapeHtml(rep.status)}</span>
            ${reasonLine}
          </td>
          <td>${escapeHtml(formatDate(rep.reportedAt))}</td>
          <td class="actions-col">
            <div class="row-actions">
              ${canEdit ? `<button type="button" class="action-link" data-action="edit-rep">Edit</button>` : ''}
              ${
                canRejectCancel
                  ? `<button type="button" class="action-link is-info" data-action="schedule-rep">Assign Task</button>
                     <button type="button" class="action-link is-danger" data-action="reject-rep">Reject</button>
                     <button type="button" class="action-link is-danger" data-action="cancel-rep">Cancel</button>`
                  : ''
              }
              <button type="button" class="action-link is-danger" data-action="del-rep">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

// ============================================================================
// 10. View 4: Collection Tasks CRUD & State Progression
// ============================================================================

function renderOpenReportSelectOptions() {
  const locMap = new Map(state.locations.map((l) => [l.id, l]));
  const openReports = state.reports.filter((r) => r.status === 'Open');
  const select = document.getElementById('task-report');
  const isEditing = Boolean(document.getElementById('task-id').value);

  if (isEditing) return;

  if (openReports.length === 0) {
    select.innerHTML = `<option value="">No Open reports available</option>`;
  } else {
    select.innerHTML = openReports
      .map((r) => {
        const loc = locMap.get(r.locationId);
        return `<option value="${escapeHtml(r.id)}">${escapeHtml(r.reportNo)} · ${escapeHtml(
          loc ? loc.name : 'Location'
        )} (${escapeHtml(r.wasteType)}, ${Number(r.estimatedKg).toFixed(1)} kg)</option>`;
      })
      .join('');
  }
}

function resetTaskForm() {
  document.getElementById('task-id').value = '';
  document.getElementById('task-no').value = 'Auto-generated (CT-####)';
  document.getElementById('task-report').disabled = false;
  document.getElementById('task-assignee-name').value = '';
  document.getElementById('task-assignee-id').value = '';
  document.getElementById('task-date').value = todayIso();
  document.getElementById('task-equipment').value = '';
  document.getElementById('task-remarks').value = '';
  document.getElementById('task-form-title').textContent = 'Schedule Collection Task';
  document.getElementById('btn-task-submit').textContent = 'Create Collection Task';
  document.getElementById('btn-task-reset').hidden = true;
  renderOpenReportSelectOptions();
}

function editTask(task) {
  if (['Completed', 'Cancelled'].includes(task.status)) {
    showToast(`Task ${task.taskNo} cannot be edited once ${task.status}.`, 'error');
    return;
  }
  const rep = state.reports.find((r) => r.id === task.reportId);
  const select = document.getElementById('task-report');
  select.innerHTML = `<option value="${escapeHtml(task.reportId)}">${escapeHtml(
    rep ? `${rep.reportNo} · ${rep.wasteType}` : task.reportId
  )}</option>`;
  select.disabled = true;

  document.getElementById('task-id').value = task.id;
  document.getElementById('task-no').value = task.taskNo;
  document.getElementById('task-assignee-name').value = task.assignedTo?.name || '';
  document.getElementById('task-assignee-id').value = task.assignedTo?.staffId || '';
  document.getElementById('task-date').value = task.scheduledDate || todayIso();
  document.getElementById('task-equipment').value = task.equipment || '';
  document.getElementById('task-remarks').value = task.remarks || '';
  document.getElementById('task-form-title').textContent = `Edit ${task.taskNo}`;
  document.getElementById('btn-task-submit').textContent = 'Update Task';
  document.getElementById('btn-task-reset').hidden = false;
  document.getElementById('task-assignee-name').focus();
}

function openCompleteTaskModal(task) {
  openModal({
    title: `Complete Task ${task.taskNo}`,
    bodyHtml: `
      <p>Enter the verified kilograms collected for <strong>${escapeHtml(
        task.taskNo
      )}</strong>. Completing this task stamps the completion timestamp and updates the linked waste report to <strong>Collected</strong>.</p>
      <div class="field">
        <label for="modal-actual-kg">Actual Kilograms Collected <span class="req">*</span></label>
        <input type="number" id="modal-actual-kg" min="0" step="0.1" placeholder="24.5" required />
      </div>
      <div class="field">
        <label for="modal-complete-remarks">Completion Remarks</label>
        <textarea id="modal-complete-remarks" rows="2" maxlength="1000">${escapeHtml(task.remarks || '')}</textarea>
      </div>
    `,
    actions: [
      { label: 'Cancel', className: 'btn-secondary', onClick: () => closeModal() },
      {
        label: 'Complete Task',
        className: 'btn-primary',
        onClick: async () => {
          const actualKg = document.getElementById('modal-actual-kg').value;
          const remarks = document.getElementById('modal-complete-remarks').value;
          try {
            await completeCollectionTask(task.id, actualKg, remarks);
            closeModal();
            showToast(`Task ${task.taskNo} completed (${Number(actualKg).toFixed(1)} kg).`, 'success');
          } catch (err) {
            showError(err);
          }
        },
      },
    ],
  });
}

function renderTasksTable() {
  const repMap = new Map(state.reports.map((r) => [r.id, r]));
  const locMap = new Map(state.locations.map((l) => [l.id, l]));

  const statusFilter = document.getElementById('task-filter-status').value;
  const dateFilter = document.getElementById('task-filter-date').value;
  const assigneeFilter = document.getElementById('task-filter-assignee').value.trim().toLowerCase();

  const filtered = state.tasks.filter((t) => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (dateFilter && t.scheduledDate !== dateFilter) return false;
    if (assigneeFilter) {
      const name = (t.assignedTo?.name || '').toLowerCase();
      const staffId = (t.assignedTo?.staffId || '').toLowerCase();
      if (!name.includes(assigneeFilter) && !staffId.includes(assigneeFilter)) return false;
    }
    return true;
  });

  document.getElementById('task-count-summary').textContent = `${filtered.length} of ${state.tasks.length} tasks`;
  const tbody = document.getElementById('tbody-tasks');

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty-cell">No matching collection tasks found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((task) => {
      const rep = repMap.get(task.reportId);
      const loc = rep ? locMap.get(rep.locationId) : null;
      const repLabel = rep ? `${rep.reportNo} · ${rep.wasteType}` : 'Report';
      const locLabel = loc ? loc.name : 'Unknown Location';
      const isEditable = ['Scheduled', 'In Progress'].includes(task.status);

      return `
        <tr data-task-id="${escapeHtml(task.id)}">
          <td class="mono"><strong>${escapeHtml(task.taskNo)}</strong></td>
          <td>
            <div class="cell-primary">${escapeHtml(repLabel)}</div>
            <div class="cell-meta">${escapeHtml(locLabel)}${task.equipment ? ` · ${escapeHtml(task.equipment)}` : ''}</div>
          </td>
          <td>
            <div class="cell-primary">${escapeHtml(task.assignedTo?.name || '')}</div>
            <div class="cell-meta">${escapeHtml(task.assignedTo?.staffId || 'No ID')}</div>
          </td>
          <td class="mono">${escapeHtml(task.scheduledDate || '—')}</td>
          <td class="num">${task.actualKg !== null && task.actualKg !== undefined ? Number(task.actualKg).toFixed(1) : '—'}</td>
          <td>
            <span class="status-tag ${statusClass(task.status)}">${escapeHtml(task.status)}</span>
            ${task.remarks ? `<div class="cell-meta">${escapeHtml(task.remarks)}</div>` : ''}
          </td>
          <td class="actions-col">
            <div class="row-actions">
              ${task.status === 'Scheduled' ? `<button type="button" class="action-link is-info" data-action="start-task">Start Task</button>` : ''}
              ${task.status === 'In Progress' ? `<button type="button" class="action-link is-emerald" data-action="complete-task">Complete Task</button>` : ''}
              ${isEditable ? `<button type="button" class="action-link" data-action="edit-task">Edit</button>` : ''}
              ${isEditable ? `<button type="button" class="action-link is-danger" data-action="cancel-task">Cancel Task</button>` : ''}
              <button type="button" class="action-link is-danger" data-action="del-task">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

// ============================================================================
// 11. View 5: Recycling Records CRUD & Live Recovery Preview
// ============================================================================

function getAllocatedKgForTask(taskId, excludeRecordId = null) {
  return state.recycling
    .filter((r) => r.taskId === taskId && r.id !== excludeRecordId)
    .reduce((sum, r) => sum + Number(r.receivedKg || 0), 0);
}

function renderCompletedTaskSelectOptions() {
  const select = document.getElementById('rec-task');
  const isEditing = Boolean(document.getElementById('rec-id').value);
  if (isEditing) return;

  const repMap = new Map(state.reports.map((r) => [r.id, r]));
  const completedTasks = state.tasks.filter((t) => t.status === 'Completed');

  if (completedTasks.length === 0) {
    select.innerHTML = `<option value="">No Completed tasks available</option>`;
    updateSelectedTaskBalanceHint();
    return;
  }

  const prevVal = select.value;
  select.innerHTML = completedTasks
    .map((t) => {
      const rep = repMap.get(t.reportId);
      const allocated = getAllocatedKgForTask(t.id);
      const remaining = Math.max(0, Number(t.actualKg || 0) - allocated);
      return `<option value="${escapeHtml(t.id)}">${escapeHtml(t.taskNo)} · ${escapeHtml(
        rep ? rep.wasteType : ''
      )} (${remaining.toFixed(1)} / ${Number(t.actualKg || 0).toFixed(1)} kg left)</option>`;
    })
    .join('');

  if (completedTasks.some((t) => t.id === prevVal)) {
    select.value = prevVal;
  }
  updateSelectedTaskBalanceHint();
}

function updateSelectedTaskBalanceHint() {
  const taskId = document.getElementById('rec-task').value;
  const excludeId = document.getElementById('rec-id').value || null;
  const hint = document.getElementById('rec-task-balance-hint');
  const task = state.tasks.find((t) => t.id === taskId);

  if (!task) {
    hint.textContent = 'Select a completed task to view remaining unallocated kg';
    return;
  }
  const actual = Number(task.actualKg || 0);
  const used = getAllocatedKgForTask(task.id, excludeId);
  const remaining = Math.max(0, actual - used);
  hint.textContent = `Collected: ${actual.toFixed(1)} kg · Already allocated: ${used.toFixed(
    1
  )} kg · Remaining: ${remaining.toFixed(1)} kg`;
}

function updateRecoveryPreview() {
  const received = Number(document.getElementById('rec-received-kg').value);
  const recycled = Number(document.getElementById('rec-recycled-kg').value);
  const preview = document.getElementById('rec-recovery-preview');

  if (!received || received <= 0 || Number.isNaN(recycled) || recycled < 0) {
    preview.value = '0.0%';
    return;
  }
  if (recycled > received) {
    preview.value = 'Exceeds received';
    return;
  }
  preview.value = `${((recycled / received) * 100).toFixed(1)}%`;
}

function resetRecyclingForm() {
  document.getElementById('rec-id').value = '';
  document.getElementById('rec-no').value = 'Auto-generated (RR-####)';
  document.getElementById('rec-task').disabled = false;
  document.getElementById('rec-material').value = 'Plastic';
  document.getElementById('rec-disposal').value = 'None';
  document.getElementById('rec-received-kg').value = '';
  document.getElementById('rec-recycled-kg').value = '';
  document.getElementById('rec-facility').value = '';
  document.getElementById('rec-date').value = todayIso();
  document.getElementById('rec-notes').value = '';
  document.getElementById('rec-form-title').textContent = 'Log Recycling Record';
  document.getElementById('btn-rec-submit').textContent = 'Save Recycling Record';
  document.getElementById('btn-rec-reset').hidden = true;
  renderCompletedTaskSelectOptions();
  updateRecoveryPreview();
}

function editRecyclingRecord(rec) {
  const task = state.tasks.find((t) => t.id === rec.taskId);
  const select = document.getElementById('rec-task');
  select.innerHTML = `<option value="${escapeHtml(rec.taskId)}">${escapeHtml(
    task ? `${task.taskNo} (${Number(task.actualKg || 0).toFixed(1)} kg collected)` : rec.taskId
  )}</option>`;
  select.disabled = true;

  document.getElementById('rec-id').value = rec.id;
  document.getElementById('rec-no').value = rec.recordNo;
  document.getElementById('rec-material').value = rec.materialType;
  document.getElementById('rec-disposal').value = rec.disposalMethod;
  document.getElementById('rec-received-kg').value = String(rec.receivedKg);
  document.getElementById('rec-recycled-kg').value = String(rec.recycledKg);
  document.getElementById('rec-facility').value = rec.facility || '';
  document.getElementById('rec-date').value = rec.processedDate || todayIso();
  document.getElementById('rec-notes').value = rec.notes || '';
  document.getElementById('rec-form-title').textContent = `Edit ${rec.recordNo}`;
  document.getElementById('btn-rec-submit').textContent = 'Update Recycling Record';
  document.getElementById('btn-rec-reset').hidden = false;
  updateSelectedTaskBalanceHint();
  updateRecoveryPreview();
  document.getElementById('rec-material').focus();
}

function renderRecyclingTable() {
  const taskMap = new Map(state.tasks.map((t) => [t.id, t]));
  const search = document.getElementById('rec-search').value.trim().toLowerCase();
  const materialFilter = document.getElementById('rec-filter-material').value;

  const filtered = state.recycling.filter((r) => {
    if (materialFilter !== 'all' && r.materialType !== materialFilter) return false;
    if (!search) return true;
    const task = taskMap.get(r.taskId);
    return (
      r.recordNo.toLowerCase().includes(search) ||
      (r.facility || '').toLowerCase().includes(search) ||
      (r.notes || '').toLowerCase().includes(search) ||
      (task?.taskNo || '').toLowerCase().includes(search)
    );
  });

  document.getElementById('rec-count-summary').textContent = `${filtered.length} of ${state.recycling.length} records`;
  const tbody = document.getElementById('tbody-recycling');

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty-cell">No matching recycling records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((rec) => {
      const task = taskMap.get(rec.taskId);
      const taskLabel = task ? `${task.taskNo} (${Number(task.actualKg || 0).toFixed(1)} kg)` : 'Task';
      return `
        <tr data-rec-id="${escapeHtml(rec.id)}">
          <td class="mono"><strong>${escapeHtml(rec.recordNo)}</strong></td>
          <td>
            <div class="cell-primary">${escapeHtml(taskLabel)}</div>
            <div class="cell-meta">${escapeHtml(rec.facility || 'Internal MRF')}${
              rec.notes ? ` · ${escapeHtml(rec.notes)}` : ''
            }</div>
          </td>
          <td>
            <div class="cell-primary">${escapeHtml(rec.materialType)}</div>
            <div class="cell-meta">Residual: ${escapeHtml(rec.disposalMethod)}</div>
          </td>
          <td class="num">${Number(rec.receivedKg || 0).toFixed(1)}</td>
          <td class="num">${Number(rec.recycledKg || 0).toFixed(1)}</td>
          <td class="num"><strong>${Number(rec.recoveryRate || 0).toFixed(1)}%</strong></td>
          <td class="mono">${escapeHtml(rec.processedDate || '—')}</td>
          <td class="actions-col">
            <div class="row-actions">
              <button type="button" class="action-link" data-action="edit-rec">Edit</button>
              <button type="button" class="action-link is-danger" data-action="del-rec">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

// ============================================================================
// 12. NoSQL Architecture & Composite Indexes Inspector Modal
// ============================================================================

function openNoSqlGuideModal() {
  openModal({
    title: 'MongoDB Atlas NoSQL Architecture & Indexes',
    bodyHtml: `
      <p>The Campus Waste Management System connects to <strong>MongoDB Atlas</strong> (database <code>campuswasteDB</code>) via the official <code>mongodb</code> driver and enforces all 14 business rules (BR-01 through BR-14) on the server:</p>
      <div class="code-block">Collections & Document Relationships (campuswasteDB):
• counters -> atomic sequential IDs (WR-0001, CT-0001, RR-0001)
• locations -> Embedded array: bins: [{ binType, capacityLitres }]
• wasteReports -> Reference: locationId -> locations._id | Embedded: reportedBy { name, contact, role }
• collectionTasks -> Reference: reportId -> wasteReports._id | Embedded: assignedTo { name, staffId }
• recyclingRecords -> Reference: taskId -> collectionTasks._id | Auto recoveryRate (%)</div>
      <p><strong>Server-Side MongoDB Indexes (ensured automatically):</strong></p>
      <div class="code-block">1. locations: { locationCode: 1 } (unique), { isActive: 1, locationCode: 1 }
2. wasteReports: { reportNo: 1 } (unique), { status: 1, reportedAt: -1 }, { status: 1, wasteType: 1, reportedAt: -1 }, { locationId: 1, status: 1, reportedAt: -1 }
3. collectionTasks: { taskNo: 1 } (unique), { reportId: 1 }, { status: 1, scheduledDate: -1 }
4. recyclingRecords: { recordNo: 1 } (unique), { taskId: 1 }, { materialType: 1, processedDate: -1 }</div>
      <p><strong>Connection Configuration:</strong> Set <code>MONGODB_URI</code> in your server environment secrets; the Express backend caches the client pool across requests.</p>
    `,
    actions: [{ label: 'Close', className: 'btn-primary', onClick: () => closeModal() }],
  });
}

// ============================================================================
// 13. Seed Sample Data Handler
// ============================================================================

async function handleSeedSampleData() {
  if (state.isSeeding) return;
  const triggerBtn = document.getElementById('btn-seed-sample');
  state.isSeeding = true;
  triggerBtn.disabled = true;
  triggerBtn.textContent = 'Seeding MongoDB...';

  try {
    const summary = await seedSampleData();
    showToast(
      `Seeded ${summary.createdLocations} new locations, ${summary.createdReports} reports, ${summary.createdTasks} tasks, and ${summary.createdRecycling} recycling records.`,
      'success'
    );
  } catch (err) {
    showError(err);
  } finally {
    state.isSeeding = false;
    triggerBtn.disabled = false;
    triggerBtn.textContent = 'Seed Sample Data';
  }
}

// ============================================================================
// 14. Event Wiring & App Initialization
// ============================================================================

function wireEvents() {
  // Navigation
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('btn-mobile-menu').addEventListener('click', () => {
    const isOpen = document.getElementById('sidebar').classList.contains('is-open');
    if (isOpen) closeMobileSidebar();
    else openMobileSidebar();
  });
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);
  document.getElementById('btn-dismiss-banner').addEventListener('click', hideBanner);

  // Topbar primary CTA
  document.getElementById('btn-topbar-primary').addEventListener('click', () => {
    if (state.activeView === 'dashboard') {
      switchView('reports');
      resetReportForm();
      document.getElementById('rep-by-name').focus();
    } else if (state.activeView === 'locations') {
      resetLocationForm();
      document.getElementById('loc-code').focus();
    } else if (state.activeView === 'reports') {
      resetReportForm();
      document.getElementById('rep-by-name').focus();
    } else if (state.activeView === 'tasks') {
      resetTaskForm();
      document.getElementById('task-assignee-name').focus();
    } else if (state.activeView === 'recycling') {
      resetRecyclingForm();
      document.getElementById('rec-received-kg').focus();
    }
  });

  // Modals & Seed
  document.getElementById('btn-modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.getElementById('btn-nosql-guide').addEventListener('click', openNoSqlGuideModal);
  document.getElementById('btn-seed-sample').addEventListener('click', handleSeedSampleData);
  document.getElementById('btn-empty-seed').addEventListener('click', handleSeedSampleData);
  document.getElementById('btn-empty-add-loc').addEventListener('click', () => switchView('locations'));

  // --- Locations Events ---
  document.getElementById('btn-add-bin').addEventListener('click', () => {
    state.binsDraft.push({ binType: 'Plastic', capacityLitres: 120 });
    renderBinsSubform();
  });
  document.getElementById('btn-loc-reset').addEventListener('click', resetLocationForm);
  document.getElementById('loc-search').addEventListener('input', renderLocationsTable);
  document.getElementById('loc-filter-active').addEventListener('change', renderLocationsTable);

  document.getElementById('form-location').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('loc-id').value;
    const payload = {
      locationCode: document.getElementById('loc-code').value,
      name: document.getElementById('loc-name').value,
      type: document.getElementById('loc-type').value,
      area: document.getElementById('loc-area').value,
      bins: state.binsDraft,
      isActive: document.getElementById('loc-active').checked,
    };

    try {
      if (id) {
        await updateLocation(id, payload);
        showToast(`Location ${payload.locationCode.toUpperCase()} updated.`, 'success');
      } else {
        const created = await createLocation(payload);
        showToast(`Location ${created.locationCode} created.`, 'success');
      }
      resetLocationForm();
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('tbody-locations').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('tr[data-loc-id]');
    const loc = state.locations.find((l) => l.id === row?.dataset.locId);
    if (!loc) return;

    if (btn.dataset.action === 'edit-loc') editLocation(loc);
    if (btn.dataset.action === 'del-loc') {
      confirmDelete(`${loc.locationCode} (${loc.name})`, () => deleteLocation(loc.id));
    }
  });

  // --- Waste Reports Events ---
  document.getElementById('btn-rep-reset').addEventListener('click', resetReportForm);
  document.getElementById('rep-search').addEventListener('input', renderReportsTable);

  const clearServerOverrideAndRender = () => {
    state.reportsServerOverride = null;
    renderReportsTable();
  };
  document.getElementById('rep-filter-status').addEventListener('change', clearServerOverrideAndRender);
  document.getElementById('rep-filter-waste').addEventListener('change', clearServerOverrideAndRender);
  document.getElementById('rep-filter-location').addEventListener('change', clearServerOverrideAndRender);

  document.getElementById('btn-rep-composite-query').addEventListener('click', async () => {
    const status = document.getElementById('rep-filter-status').value;
    const wasteType = document.getElementById('rep-filter-waste').value;
    const locationId = document.getElementById('rep-filter-location').value;

    try {
      const res = await runWasteReportCompositeQuery({ status, wasteType, locationId });
      state.reportsServerOverride = res.items;
      renderReportsTable();
      showToast(`MongoDB server query returned ${res.items.length} report(s).`, 'success');
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('form-report').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('rep-id').value;
    const payload = {
      locationId: document.getElementById('rep-location').value,
      reportedBy: {
        name: document.getElementById('rep-by-name').value,
        role: document.getElementById('rep-by-role').value,
        contact: document.getElementById('rep-by-contact').value,
      },
      wasteType: document.getElementById('rep-waste-type').value,
      estimatedKg: document.getElementById('rep-est-kg').value,
      urgency: document.getElementById('rep-urgency').value,
      description: document.getElementById('rep-desc').value,
    };

    try {
      if (id) {
        await updateWasteReport(id, payload);
        showToast('Waste report updated.', 'success');
      } else {
        const created = await createWasteReport(payload);
        showToast(`Waste report ${created.reportNo} submitted.`, 'success');
      }
      resetReportForm();
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('tbody-reports').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('tr[data-rep-id]');
    const rep = state.reports.find((r) => r.id === row?.dataset.repId);
    if (!rep) return;

    const action = btn.dataset.action;
    if (action === 'edit-rep') editReport(rep);
    if (action === 'reject-rep') openRejectCancelReportModal(rep, 'Rejected');
    if (action === 'cancel-rep') openRejectCancelReportModal(rep, 'Cancelled');
    if (action === 'schedule-rep') {
      switchView('tasks');
      resetTaskForm();
      document.getElementById('task-report').value = rep.id;
      document.getElementById('task-assignee-name').focus();
    }
    if (action === 'del-rep') {
      confirmDelete(rep.reportNo, () => deleteWasteReport(rep.id));
    }
  });

  // --- Collection Tasks Events ---
  document.getElementById('btn-task-reset').addEventListener('click', resetTaskForm);
  document.getElementById('task-filter-status').addEventListener('change', renderTasksTable);
  document.getElementById('task-filter-date').addEventListener('change', renderTasksTable);
  document.getElementById('task-filter-assignee').addEventListener('input', renderTasksTable);
  document.getElementById('btn-task-clear-filters').addEventListener('click', () => {
    document.getElementById('task-filter-status').value = 'all';
    document.getElementById('task-filter-date').value = '';
    document.getElementById('task-filter-assignee').value = '';
    renderTasksTable();
  });

  document.getElementById('form-task').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('task-id').value;
    const payload = {
      reportId: document.getElementById('task-report').value,
      assignedTo: {
        name: document.getElementById('task-assignee-name').value,
        staffId: document.getElementById('task-assignee-id').value,
      },
      scheduledDate: document.getElementById('task-date').value,
      equipment: document.getElementById('task-equipment').value,
      remarks: document.getElementById('task-remarks').value,
    };

    try {
      if (id) {
        await updateCollectionTask(id, payload);
        showToast('Collection task updated.', 'success');
      } else {
        const created = await createCollectionTask(payload);
        showToast(`Task ${created.taskNo} scheduled; report status set to Assigned.`, 'success');
      }
      resetTaskForm();
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('tbody-tasks').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('tr[data-task-id]');
    const task = state.tasks.find((t) => t.id === row?.dataset.taskId);
    if (!task) return;

    const action = btn.dataset.action;
    if (action === 'edit-task') editTask(task);
    if (action === 'start-task') {
      try {
        await startCollectionTask(task.id);
        showToast(`Task ${task.taskNo} is now In Progress.`, 'success');
      } catch (err) {
        showError(err);
      }
    }
    if (action === 'complete-task') openCompleteTaskModal(task);
    if (action === 'cancel-task') {
      openModal({
        title: `Cancel Task ${task.taskNo}`,
        bodyHtml: `<p>Cancelling <strong>${escapeHtml(
          task.taskNo
        )}</strong> will automatically revert its linked waste report back to <strong>Open</strong> (BR-13).</p>`,
        actions: [
          { label: 'Back', className: 'btn-secondary', onClick: () => closeModal() },
          {
            label: 'Cancel Task',
            className: 'btn-danger',
            onClick: async () => {
              try {
                await cancelCollectionTask(task.id);
                closeModal();
                showToast(`Task ${task.taskNo} cancelled; linked report reverted to Open.`, 'info');
              } catch (err) {
                showError(err);
              }
            },
          },
        ],
      });
    }
    if (action === 'del-task') {
      confirmDelete(task.taskNo, () => deleteCollectionTask(task.id));
    }
  });

  // --- Recycling Records Events ---
  document.getElementById('btn-rec-reset').addEventListener('click', resetRecyclingForm);
  document.getElementById('rec-task').addEventListener('change', updateSelectedTaskBalanceHint);
  document.getElementById('rec-received-kg').addEventListener('input', updateRecoveryPreview);
  document.getElementById('rec-recycled-kg').addEventListener('input', updateRecoveryPreview);
  document.getElementById('rec-search').addEventListener('input', renderRecyclingTable);
  document.getElementById('rec-filter-material').addEventListener('change', renderRecyclingTable);

  document.getElementById('form-recycling').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('rec-id').value;
    const payload = {
      taskId: document.getElementById('rec-task').value,
      materialType: document.getElementById('rec-material').value,
      disposalMethod: document.getElementById('rec-disposal').value,
      receivedKg: document.getElementById('rec-received-kg').value,
      recycledKg: document.getElementById('rec-recycled-kg').value,
      facility: document.getElementById('rec-facility').value,
      processedDate: document.getElementById('rec-date').value,
      notes: document.getElementById('rec-notes').value,
    };

    try {
      if (id) {
        await updateRecyclingRecord(id, payload);
        showToast('Recycling record updated; report mass balance recalculated.', 'success');
      } else {
        const created = await createRecyclingRecord(payload);
        showToast(`Record ${created.recordNo} saved (${created.recoveryRate}% recovery).`, 'success');
      }
      resetRecyclingForm();
    } catch (err) {
      showError(err);
    }
  });

  document.getElementById('tbody-recycling').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('tr[data-rec-id]');
    const rec = state.recycling.find((r) => r.id === row?.dataset.recId);
    if (!rec) return;

    if (btn.dataset.action === 'edit-rec') editRecyclingRecord(rec);
    if (btn.dataset.action === 'del-rec') {
      confirmDelete(rec.recordNo, () => deleteRecyclingRecord(rec.id));
    }
  });
}

async function bootstrap() {
  renderBinsSubform();
  document.getElementById('task-date').value = todayIso();
  document.getElementById('rec-date').value = todayIso();
  wireEvents();

  const conn = await testConnection();
  if (!conn.ok && conn.offline) {
    showBanner(`<strong>MongoDB Connection Notice:</strong> ${escapeHtml(conn.message)}`);
  }

  subscribeAllCollections({
    onLocations: (items) => {
      state.locations = items;
      renderAll();
    },
    onReports: (items) => {
      state.reports = items;
      renderAll();
    },
    onTasks: (items) => {
      state.tasks = items;
      renderAll();
    },
    onRecycling: (items) => {
      state.recycling = items;
      renderAll();
    },
    onError: (error, target) => {
      showBanner(
        `<strong>MongoDB Sync Error (${escapeHtml(target)}):</strong> ${escapeHtml(
          error.message || String(error)
        )}`
      );
    },
  });
}

bootstrap();
