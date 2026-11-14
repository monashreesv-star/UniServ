/**
 * ============================================================================
 * UniServ Co-op Treasury Ledger Frontend Client (Phase 6.2 - AG Grid Community)
 * ============================================================================
 * High-performance, transparent cooperative ledger supporting:
 *  - Vendored AG Grid Community (pinned local UMD, zero CDN dependency)
 *  - Automated graceful fallback to plain HTML table if AG Grid fails to load
 *  - Multi-column sorting, quick filtering, column filtering, pagination
 *  - Sanitized CSV export matching strict privacy requirements
 *  - Row inspection panel displaying 4-way breakdown and agent audit trace
 *
 * CRITICAL SECURITY INVARIANT:
 * All store-derived text is rendered strictly using textContent (never innerHTML).
 * AG Grid cellRenderers return DOM nodes built with textContent or valueFormatters.
 * ============================================================================
 */

(function () {
  'use strict';

  // State
  let rawRecords = [];
  let currentSummary = null;
  let gridApi = null;
  let isAgGridActive = false;
  let selectedBooking = null;

  // Fallback plain table sort state
  let sortDescending = true;

  // DOM Elements
  const kpiTotalBookings = document.getElementById('kpiTotalBookings');
  const kpiSettledCount = document.getElementById('kpiSettledCount');
  const kpiTotalAuthorized = document.getElementById('kpiTotalAuthorized');
  const kpiTotalCaptured = document.getElementById('kpiTotalCaptured');
  const kpiArtisanPaid = document.getElementById('kpiArtisanPaid');
  const kpiWelfarePaid = document.getElementById('kpiWelfarePaid');
  const kpiReservePaid = document.getElementById('kpiReservePaid');
  const kpiPlatformRetained = document.getElementById('kpiPlatformRetained');
  const kpiPendingPayouts = document.getElementById('kpiPendingPayouts');
  const kpiUnclaimedSub = document.getElementById('kpiUnclaimedSub');

  const asOfTimeEl = document.getElementById('asOfTime');
  const connPill = document.getElementById('connPill');
  const connStatusText = document.getElementById('connStatusText');
  const refreshBtn = document.getElementById('refreshBtn');

  const fallbackNotice = document.getElementById('fallbackNotice');
  const agGridContainer = document.getElementById('agGridContainer');
  const plainTableContainer = document.getElementById('plainTableContainer');
  const tableBody = document.getElementById('tableBody');
  const emptyState = document.getElementById('emptyState');

  const searchInput = document.getElementById('searchInput');
  const decisionFilter = document.getElementById('decisionFilter');
  const serviceFilter = document.getElementById('serviceFilter');
  const sortToggleBtn = document.getElementById('sortToggleBtn');
  const downloadCsvBtn = document.getElementById('downloadCsvBtn');

  const detailPanel = document.getElementById('detailPanel');
  const detailPanelTitle = document.getElementById('detailPanelTitle');
  const detailPanelBody = document.getElementById('detailPanelBody');
  const detailCloseBtn = document.getElementById('detailCloseBtn');

  /**
   * Helper: creates an element with optional text and className via safe textContent.
   * @param {string} tag
   * @param {string|number} text
   * @param {string} className
   * @returns {HTMLElement}
   */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  /**
   * Updates live server status badge.
   * @param {boolean} online
   */
  function updateConnectionStatus(online) {
    if (online) {
      connPill.className = 'status-pill status-live';
      connStatusText.textContent = 'Connected (Sandbox)';
    } else {
      connPill.className = 'status-pill status-offline';
      connStatusText.textContent = 'Disconnected';
    }
  }

  /**
   * Fetches summary data and updates KPI cards.
   */
  async function fetchSummary() {
    try {
      const res = await fetch('/api/ledger/summary');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      currentSummary = data;

      // Update KPI cards strictly with textContent
      kpiTotalBookings.textContent = String(data.total_bookings || 0);
      const settledCount = data.counts_by_decision?.SETTLED || 0;
      kpiSettledCount.textContent = settledCount + ' Settled';

      kpiTotalAuthorized.textContent = '$' + (data.total_authorized_usd || '0.00');
      kpiTotalCaptured.textContent = '$' + (data.total_captured_usd || '0.00');
      kpiArtisanPaid.textContent = '$' + (data.total_artisan_wages_paid_usd || '0.00');
      kpiWelfarePaid.textContent = '$' + (data.total_welfare_paid_usd || '0.00');
      kpiReservePaid.textContent = '$' + (data.total_reserve_paid_usd || '0.00');
      kpiPlatformRetained.textContent = '$' + (data.total_platform_retained_usd || '0.00');

      kpiPendingPayouts.textContent = '$' + (data.total_payouts_pending_usd || '0.00');
      kpiUnclaimedSub.textContent = '$' + (data.total_payouts_unclaimed_usd || '0.00') + ' unclaimed';

      if (data.as_of) {
        const d = new Date(data.as_of);
        asOfTimeEl.textContent = 'Data as of: ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      updateConnectionStatus(true);
    } catch (err) {
      console.error('Error fetching summary:', err);
      updateConnectionStatus(false);
    }
  }

  /**
   * Fetches booking records and updates grid or plain table.
   */
  async function fetchRecords() {
    try {
      const res = await fetch('/api/ledger/records');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      rawRecords = Array.isArray(data.records) ? data.records : [];

      populateServiceFilter(rawRecords);
      renderView();
      updateConnectionStatus(true);
    } catch (err) {
      console.error('Error fetching records:', err);
      updateConnectionStatus(false);
    }
  }

  /**
   * Populates the service filter dropdown with distinct service names.
   * @param {Array} records
   */
  function populateServiceFilter(records) {
    const currentVal = serviceFilter.value;
    const services = new Set();
    records.forEach(r => {
      if (r.service_name && r.service_name !== 'n/a') {
        services.add(r.service_name);
      }
    });

    while (serviceFilter.firstChild) {
      serviceFilter.removeChild(serviceFilter.firstChild);
    }

    const allOpt = el('option', 'All Services');
    allOpt.value = 'ALL';
    serviceFilter.appendChild(allOpt);

    Array.from(services).sort().forEach(svc => {
      const opt = el('option', svc);
      opt.value = svc;
      serviceFilter.appendChild(opt);
    });

    serviceFilter.value = currentVal || 'ALL';
  }

  /**
   * Filters the raw records based on dropdown selectors.
   * @returns {Array} Filtered records
   */
  function getFilteredRecords() {
    const decisionVal = decisionFilter.value;
    const serviceVal = serviceFilter.value;

    return rawRecords.filter(r => {
      if (decisionVal !== 'ALL' && r.decision !== decisionVal) {
        return false;
      }
      if (serviceVal !== 'ALL' && r.service_name !== serviceVal) {
        return false;
      }
      return true;
    });
  }

  // ==========================================================================
  // AG Grid Community Setup & Column Definitions
  // ==========================================================================

  function getAgGridColumnDefs() {
    return [
      {
        headerName: 'Decision',
        field: 'decision',
        pinned: 'left',
        width: 120,
        filter: true,
        cellRenderer: (params) => {
          let badgeClass = 'badge-na';
          if (params.value === 'SETTLED') badgeClass = 'badge-settled';
          else if (params.value === 'HELD') badgeClass = 'badge-held';
          else if (params.value === 'PENDING') badgeClass = 'badge-pending';
          else if (params.value === 'FAILED') badgeClass = 'badge-failed';
          return el('span', params.value || 'n/a', 'badge ' + badgeClass);
        }
      },
      {
        headerName: 'Booking',
        field: 'booking_id',
        width: 105,
        filter: true,
        cellRenderer: (params) => el('span', params.value, 'booking-code')
      },
      {
        headerName: 'Time',
        field: 'created_at',
        width: 130,
        sort: 'desc',
        valueFormatter: (params) => {
          if (!params.value || params.value === 'n/a') return 'n/a';
          return new Date(params.value).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
        }
      },
      {
        headerName: 'Service',
        field: 'service_name',
        minWidth: 125,
        flex: 1,
        filter: true
      },
      {
        headerName: 'Type',
        field: 'booking_type',
        width: 90
      },
      {
        headerName: 'Data Mode',
        field: 'data_mode',
        width: 115,
        cellRenderer: (params) => el('span', params.value, 'badge-mode')
      },
      {
        headerName: 'Agent Mode',
        field: 'agent_mode',
        width: 120,
        cellRenderer: (params) => el('span', params.value, 'badge-agent')
      },
      {
        headerName: 'Final Bill',
        field: 'final_bill_usd',
        width: 100,
        type: 'numericColumn',
        valueFormatter: (params) => '$' + (params.value || '0.00')
      },
      {
        headerName: 'Captured',
        field: 'captured_usd',
        width: 100,
        type: 'numericColumn',
        valueFormatter: (params) => '$' + (params.value || '0.00')
      },
      {
        headerName: 'Artisan (80%)',
        width: 135,
        type: 'numericColumn',
        valueGetter: (params) => {
          const b = params.data?.breakdown;
          return '$' + (b?.artisan_wages_usd || '0.00') + ' (' + (b?.artisan_status || 'n/a') + ')';
        }
      },
      {
        headerName: 'Welfare (10%)',
        width: 130,
        type: 'numericColumn',
        valueGetter: (params) => {
          const b = params.data?.breakdown;
          return '$' + (b?.welfare_usd || '0.00') + ' (' + (b?.welfare_status || 'n/a') + ')';
        }
      },
      {
        headerName: 'Reserve (6%)',
        width: 130,
        type: 'numericColumn',
        valueGetter: (params) => {
          const b = params.data?.breakdown;
          return '$' + (b?.reserve_usd || '0.00') + ' (' + (b?.reserve_status || 'n/a') + ')';
        }
      },
      {
        headerName: 'Retained (4%)',
        width: 110,
        type: 'numericColumn',
        valueGetter: (params) => '$' + (params.data?.breakdown?.platform_retained_usd || '0.00')
      },
      {
        headerName: 'PayPal IDs',
        width: 175,
        valueGetter: (params) => {
          const d = params.data;
          const cap = d?.capture_id ? 'Cap:' + d.capture_id : '';
          const pay = d?.payout_batch_id ? 'Pay:' + d.payout_batch_id : '';
          return [cap, pay].filter(Boolean).join(' ') || 'None';
        }
      },
      {
        headerName: 'Policy Flags',
        field: 'policy_flags',
        width: 130,
        cellRenderer: (params) => {
          if (Array.isArray(params.value) && params.value.length > 0) {
            return el('span', params.value.join(', '), 'flags-pill');
          } else if (Array.isArray(params.value) && params.value.length === 0) {
            return el('span', 'None', 'badge-na');
          }
          return el('span', String(params.value || 'n/a'), 'badge-na');
        }
      }
    ];
  }

  /**
   * Initializes or updates AG Grid Community.
   */
  function initOrUpdateAgGrid(records) {
    if (!gridApi) {
      const gridOptions = {
        theme: 'legacy',
        columnDefs: getAgGridColumnDefs(),
        rowData: records,
        pagination: true,
        paginationPageSize: 10,
        paginationPageSizeSelector: [10, 20, 50, 100],
        rowSelection: { mode: 'singleRow', enableClickSelection: true },
        defaultColDef: {
          sortable: true,
          resizable: true,
          filter: true
        },
        onRowClicked: (event) => {
          if (event.data) {
            showRecordDetail(event.data);
          }
        }
      };

      gridApi = agGrid.createGrid(agGridContainer, gridOptions);
      isAgGridActive = true;
    } else {
      gridApi.setGridOption('rowData', records);
    }

    // Apply active search filter
    if (searchInput.value) {
      gridApi.setGridOption('quickFilterText', searchInput.value);
    }
  }

  /**
   * Renders the primary view (AG Grid or fallback plain table).
   */
  function renderView() {
    const filtered = getFilteredRecords();

    // Check if AG Grid is available on window
    const agGridAvailable = typeof agGrid !== 'undefined' && agGrid && typeof agGrid.createGrid === 'function';

    if (agGridAvailable) {
      try {
        agGridContainer.style.display = 'block';
        plainTableContainer.style.display = 'none';
        fallbackNotice.style.display = 'none';
        sortToggleBtn.style.display = 'none';

        initOrUpdateAgGrid(filtered);

        if (filtered.length === 0) {
          emptyState.style.display = 'block';
        } else {
          emptyState.style.display = 'none';
        }
        return;
      } catch (err) {
        console.warn('AG Grid initialization failed, falling back to plain table:', err);
      }
    }

    // Fallback to plain table
    renderPlainTableFallback(filtered);
  }

  /**
   * Fallback Plain Table Renderer (from Stage 6.1).
   * Rendered strictly with textContent.
   * @param {Array} records
   */
  function renderPlainTableFallback(records) {
    isAgGridActive = false;
    agGridContainer.style.display = 'none';
    plainTableContainer.style.display = 'block';
    fallbackNotice.style.display = 'flex';
    sortToggleBtn.style.display = 'inline-flex';

    while (tableBody.firstChild) {
      tableBody.removeChild(tableBody.firstChild);
    }

    const query = (searchInput.value || '').trim().toLowerCase();
    const sorted = records.filter(r => {
      if (query) {
        const str = [r.booking_id, r.service_name, r.paypal_status, r.decision, r.payer].join(' ').toLowerCase();
        return str.includes(query);
      }
      return true;
    }).sort((a, b) => {
      const timeA = new Date(a.created_at).getTime() || 0;
      const timeB = new Date(b.created_at).getTime() || 0;
      return sortDescending ? timeB - timeA : timeA - timeB;
    });

    if (sorted.length === 0) {
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';

    sorted.forEach(record => {
      const tr = el('tr', null, 'row-item');
      tr.addEventListener('click', () => showRecordDetail(record));

      // Expand icon
      const tdExpand = el('td', null, null);
      tdExpand.appendChild(el('span', '▶', 'expand-btn'));
      tr.appendChild(tdExpand);

      // Booking ID
      const tdId = el('td', null, null);
      tdId.appendChild(el('span', record.booking_id, 'booking-code'));
      tr.appendChild(tdId);

      // Created At
      const createdStr = record.created_at !== 'n/a'
        ? new Date(record.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : 'n/a';
      tr.appendChild(el('td', createdStr));

      // Service
      tr.appendChild(el('td', record.service_name));

      // Payer
      tr.appendChild(el('td', record.payer));

      // Data Mode
      const tdDataMode = el('td', null, null);
      tdDataMode.appendChild(el('span', record.data_mode, 'badge-mode'));
      tr.appendChild(tdDataMode);

      // Agent Mode
      const tdAgentMode = el('td', null, null);
      tdAgentMode.appendChild(el('span', record.agent_mode, 'badge-agent'));
      tr.appendChild(tdAgentMode);

      // Decision
      const tdDecision = el('td', null, null);
      let badgeClass = 'badge-na';
      if (record.decision === 'SETTLED') badgeClass = 'badge-settled';
      else if (record.decision === 'HELD') badgeClass = 'badge-held';
      else if (record.decision === 'PENDING') badgeClass = 'badge-pending';
      else if (record.decision === 'FAILED') badgeClass = 'badge-failed';
      tdDecision.appendChild(el('span', record.decision, 'badge ' + badgeClass));
      tr.appendChild(tdDecision);

      // PayPal Status
      tr.appendChild(el('td', record.paypal_status));

      // Amounts
      tr.appendChild(el('td', '$' + record.authorized_usd, 'num-col'));
      tr.appendChild(el('td', '$' + record.captured_usd, 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.artisan_wages_usd || '0.00'), 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.welfare_usd || '0.00'), 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.reserve_usd || '0.00'), 'num-col'));
      tr.appendChild(el('td', '$' + (record.breakdown?.platform_retained_usd || '0.00'), 'num-col'));

      // PayPal Fee
      const feeStr = record.breakdown?.paypal_fee_usd !== 'n/a' ? '$' + record.breakdown.paypal_fee_usd : 'n/a';
      tr.appendChild(el('td', feeStr, 'num-col'));

      // Policy Flags
      const tdFlags = el('td', null, null);
      if (Array.isArray(record.policy_flags) && record.policy_flags.length > 0) {
        tdFlags.appendChild(el('span', record.policy_flags.join(', '), 'flags-pill'));
      } else if (Array.isArray(record.policy_flags) && record.policy_flags.length === 0) {
        tdFlags.appendChild(el('span', 'None', 'badge-na'));
      } else {
        tdFlags.appendChild(el('span', 'n/a', 'badge-na'));
      }
      tr.appendChild(tdFlags);

      tableBody.appendChild(tr);
    });
  }

  // ==========================================================================
  // Selected Booking Detail & Audit Trace Inspector
  // ==========================================================================

  /**
   * Renders the detailed inspection panel for a selected booking.
   * Rendered strictly with textContent for complete XSS safety.
   * @param {object} record
   */
  function showRecordDetail(record) {
    selectedBooking = record;
    detailPanel.style.display = 'block';

    detailPanelTitle.textContent = 'Booking ...' + record.booking_id + ' Details & Settlement Trace';

    while (detailPanelBody.firstChild) {
      detailPanelBody.removeChild(detailPanelBody.firstChild);
    }

    const grid = el('div', null, 'detail-grid');

    // Card 1: PayPal Identifiers
    const idCard = el('div', null, 'detail-card');
    idCard.appendChild(el('div', 'PayPal Identifiers', 'detail-card-title'));

    const itemCap = el('div', null, 'detail-item');
    itemCap.appendChild(el('span', 'Capture ID (Last 4)', 'detail-key'));
    itemCap.appendChild(el('span', record.capture_id ? '...' + record.capture_id : 'None', 'detail-val'));
    idCard.appendChild(itemCap);

    const itemBatch = el('div', null, 'detail-item');
    itemBatch.appendChild(el('span', 'Payout Batch (Last 4)', 'detail-key'));
    itemBatch.appendChild(el('span', record.payout_batch_id ? '...' + record.payout_batch_id : 'None', 'detail-val'));
    idCard.appendChild(itemBatch);

    const itemPayer = el('div', null, 'detail-item');
    itemPayer.appendChild(el('span', 'Payer Information', 'detail-key'));
    itemPayer.appendChild(el('span', record.payer, 'detail-val'));
    idCard.appendChild(itemPayer);

    grid.appendChild(idCard);

    // Card 2: Financial Breakdown
    const finCard = el('div', null, 'detail-card');
    finCard.appendChild(el('div', 'Fair-Wage & Welfare Breakdown', 'detail-card-title'));

    const itemArt = el('div', null, 'detail-item');
    itemArt.appendChild(el('span', 'Artisan Wages (80%)', 'detail-key'));
    itemArt.appendChild(el('span', '$' + (record.breakdown?.artisan_wages_usd || '0.00') + ' (' + (record.breakdown?.artisan_status || 'n/a') + ')', 'detail-val'));
    finCard.appendChild(itemArt);

    const itemWelf = el('div', null, 'detail-item');
    itemWelf.appendChild(el('span', 'Welfare Fund (10%)', 'detail-key'));
    itemWelf.appendChild(el('span', '$' + (record.breakdown?.welfare_usd || '0.00') + ' (' + (record.breakdown?.welfare_status || 'n/a') + ')', 'detail-val'));
    finCard.appendChild(itemWelf);

    const itemRes = el('div', null, 'detail-item');
    itemRes.appendChild(el('span', 'Emergency Reserve (6%)', 'detail-key'));
    itemRes.appendChild(el('span', '$' + (record.breakdown?.reserve_usd || '0.00') + ' (' + (record.breakdown?.reserve_status || 'n/a') + ')', 'detail-val'));
    finCard.appendChild(itemRes);

    const itemRet = el('div', null, 'detail-item');
    itemRet.appendChild(el('span', 'Platform Retained (4%)', 'detail-key'));
    itemRet.appendChild(el('span', '$' + (record.breakdown?.platform_retained_usd || '0.00') + ' (before fee)', 'detail-val'));
    finCard.appendChild(itemRet);

    grid.appendChild(finCard);

    // Card 3: Service & Timing
    const timeCard = el('div', null, 'detail-card');
    timeCard.appendChild(el('div', 'Service & Timing Metrics', 'detail-card-title'));

    const itemType = el('div', null, 'detail-item');
    itemType.appendChild(el('span', 'Booking Type', 'detail-key'));
    itemType.appendChild(el('span', record.booking_type, 'detail-val'));
    timeCard.appendChild(itemType);

    const itemSec = el('div', null, 'detail-item');
    itemSec.appendChild(el('span', 'Active Service Duration', 'detail-key'));
    itemSec.appendChild(el('span', record.active_seconds !== 'n/a' ? record.active_seconds + ' s' : 'n/a', 'detail-val'));
    timeCard.appendChild(itemSec);

    const itemFee = el('div', null, 'detail-item');
    itemFee.appendChild(el('span', 'Recorded PayPal Fee', 'detail-key'));
    itemFee.appendChild(el('span', record.breakdown?.paypal_fee_usd !== 'n/a' ? '$' + record.breakdown.paypal_fee_usd : 'n/a', 'detail-val'));
    timeCard.appendChild(itemFee);

    grid.appendChild(timeCard);

    // Card 4: Extra Work Notes (textContent strictly)
    const extraCard = el('div', null, 'detail-card');
    extraCard.appendChild(el('div', 'Extra Work Notes', 'detail-card-title'));

    const itemExtra = el('div', null, 'detail-item');
    itemExtra.appendChild(el('span', 'Notes', 'detail-key'));
    const extraVal = el('span', record.extra_work_description, 'detail-val');
    extraVal.style.whiteSpace = 'normal';
    itemExtra.appendChild(extraVal);
    extraCard.appendChild(itemExtra);

    grid.appendChild(extraCard);
    detailPanelBody.appendChild(grid);

    // Agent Trace Timeline
    if (Array.isArray(record.trace) && record.trace.length > 0) {
      const traceCard = el('div', null, 'trace-card');
      traceCard.appendChild(el('div', 'Settlement Agent Audit Trace (' + record.trace.length + ' steps)', 'trace-title'));

      const list = el('ul', null, 'trace-list');
      record.trace.forEach(step => {
        const item = el('li', null, 'trace-item');
        const header = el('div', null, null);

        header.appendChild(el('span', 'Step ' + (step.step || '-') + ': ' + (step.type || 'action'), 'trace-step-type'));
        if (step.timestamp) {
          const t = new Date(step.timestamp).toLocaleTimeString();
          header.appendChild(el('span', t, 'trace-step-time'));
        }
        item.appendChild(header);

        const detailsObj = {};
        if (step.decision) detailsObj.decision = step.decision;
        if (step.reason) detailsObj.reason = step.reason;
        if (step.note) detailsObj.note = step.note;
        if (step.amount_usd_cents) detailsObj.amount_usd = '$' + (step.amount_usd_cents / 100).toFixed(2);
        if (step.status) detailsObj.status = step.status;
        if (step.high_flags && step.high_flags.length) detailsObj.high_flags = step.high_flags;
        if (step.low_flags && step.low_flags.length) detailsObj.low_flags = step.low_flags;

        if (Object.keys(detailsObj).length > 0) {
          const detailText = Object.entries(detailsObj)
            .map(([k, v]) => k + ': ' + (Array.isArray(v) ? v.join(', ') : v))
            .join(' | ');
          item.appendChild(el('div', detailText, 'trace-step-details'));
        }

        list.appendChild(item);
      });
      traceCard.appendChild(list);
      detailPanelBody.appendChild(traceCard);
    }

    detailPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  detailCloseBtn.addEventListener('click', () => {
    detailPanel.style.display = 'none';
    selectedBooking = null;
  });

  // ==========================================================================
  // CSV Export (Sanitized: NO emails, NO full IDs)
  // ==========================================================================

  function downloadCsv() {
    const filtered = getFilteredRecords();
    if (filtered.length === 0) {
      alert('No records available to export.');
      return;
    }

    const headers = [
      'Booking ID',
      'Created At',
      'Service',
      'Booking Type',
      'Payer',
      'Data Mode',
      'Agent Mode',
      'Decision',
      'PayPal Status',
      'Final Bill USD',
      'Captured USD',
      'Artisan Wages USD',
      'Welfare USD',
      'Reserve USD',
      'Platform Retained USD',
      'PayPal Fee USD',
      'Active Seconds',
      'Policy Flags',
      'Capture ID (Last 4)',
      'Payout Batch ID (Last 4)'
    ];

    function escapeCsvCell(val) {
      if (val === null || val === undefined) return '""';
      let str = String(val);
      if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        str = '"' + str.replace(/"/g, '""') + '"';
      } else {
        str = '"' + str + '"';
      }
      return str;
    }

    const rows = [headers.map(escapeCsvCell).join(',')];

    filtered.forEach(r => {
      const flagsStr = Array.isArray(r.policy_flags) ? r.policy_flags.join('; ') : r.policy_flags;
      const row = [
        r.booking_id,
        r.created_at,
        r.service_name,
        r.booking_type,
        r.payer,
        r.data_mode,
        r.agent_mode,
        r.decision,
        r.paypal_status,
        r.final_bill_usd || r.authorized_usd,
        r.captured_usd,
        r.breakdown?.artisan_wages_usd || '0.00',
        r.breakdown?.welfare_usd || '0.00',
        r.breakdown?.reserve_usd || '0.00',
        r.breakdown?.platform_retained_usd || '0.00',
        r.breakdown?.paypal_fee_usd || 'n/a',
        r.active_seconds,
        flagsStr,
        r.capture_id || '',
        r.payout_batch_id || ''
      ];
      rows.push(row.map(escapeCsvCell).join(','));
    });

    const csvContent = rows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', 'uniserv-coop-ledger-' + dateStr + '.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Event Listeners
  searchInput.addEventListener('input', () => {
    if (isAgGridActive && gridApi) {
      gridApi.setGridOption('quickFilterText', searchInput.value);
    } else {
      renderView();
    }
  });

  decisionFilter.addEventListener('change', renderView);
  serviceFilter.addEventListener('change', renderView);

  sortToggleBtn.addEventListener('click', () => {
    sortDescending = !sortDescending;
    sortToggleBtn.textContent = sortDescending ? 'Sort: Newest First' : 'Sort: Oldest First';
    renderView();
  });

  downloadCsvBtn.addEventListener('click', downloadCsv);

  refreshBtn.addEventListener('click', () => {
    fetchSummary();
    fetchRecords();
  });

  // Initial Data Fetch
  fetchSummary();
  fetchRecords();
})();
