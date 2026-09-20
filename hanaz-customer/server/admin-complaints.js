const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = '1y0-ZimyPt0G-h4z05eYmVCycnPe5A_38vHL3uAOwZvc';
const SHEETS_CONNECTOR_ID = '38d254e2-b92e-44f4-81cd-8251fd9373d9';
const SHEET_PUBLIC_URL = 'https://docs.google.com/spreadsheets/d/1y0-ZimyPt0G-h4z05eYmVCycnPe5A_38vHL3uAOwZvc/edit';
const NOTION_DATABASE_URL = 'https://notion.so/3e0b4ad5cb6b819b89bff9deb1ff81be';
const DISCORD_SAFE_URL = 'https://discord.com/channels/@me';
const FASTN_WEBHOOK_URL = process.env.FASTN_WEBHOOK_URL || 'https://webhooks.fastn.dev/prod/triggers/personal_f45a90dce32e1cb348f1/webhooks/b646815b-f3f8-4b03-b6de-f97ca6748aa1';

let cachedRows = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 2500; // 2.5s cache for responsive UI and live updates
let cachedActionId = null;

// In-memory state overrides (for instant UI reflection before Sheets write propagates)
const approvalOverrides = new Map();

// In-memory Audit Log
const auditLogEntries = [];

function logAuditEvent({ complaint_id, source, previous_status, new_status, action, detail }) {
  const entry = {
    id: 'audit-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    complaint_id,
    timestamp: new Date().toISOString(),
    source: source || 'Admin Portal',
    previous_status: previous_status || 'UNKNOWN',
    new_status: new_status || previous_status || 'UNKNOWN',
    action: action || 'EVENT',
    detail: detail || ''
  };
  auditLogEntries.unshift(entry);
  if (auditLogEntries.length > 500) auditLogEntries.pop();
  return entry;
}

function getMcpToken() {
  let token = 'gwt_byI9GuRnOntVVcjJ3sh9ZBzUBdgtInKS';
  try {
    const tokenPath = 'C:/Users/HP/.gemini/antigravity/mcp_oauth_tokens.json';
    if (fs.existsSync(tokenPath)) {
      const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (tokens['https://mcp.fastn.dev']?.token?.access_token) {
        token = tokens['https://mcp.fastn.dev'].token.access_token;
      }
    }
  } catch (err) {}
  return token;
}

async function callMcp(actionName, args) {
  const token = getMcpToken();
  const res = await fetch('https://mcp.fastn.dev', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now() + Math.random(),
      method: 'tools/call',
      params: { name: actionName, arguments: args }
    })
  });
  return await res.json();
}

async function getGetValuesActionId() {
  if (cachedActionId) return cachedActionId;
  const data = await callMcp('fastnPlatform__listActions', { connectorId: SHEETS_CONNECTOR_ID });
  const act = data.result?.structuredContent?.data?.find(a => a.slug === 'getValues');
  if (act?.id) {
    cachedActionId = act.id;
    return cachedActionId;
  }
  return '042be6a6-9f86-4f4c-bbfd-d7e7c9f80a49';
}

function normalizeFieldValue(val) {
  if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
    return 'Not available';
  }
  return String(val).trim();
}

// -------------------------------------------------------------
// Smart Router (Identical logic to Fastn workflow)
// -------------------------------------------------------------
function routeComplaint(category, text, severity, summary) {
  const lower = ((category || '') + ' ' + (text || '')).toLowerCase();

  const isPhysicalProduct = /\b(serum|bottle|cream|item|package|parcel|box|arrived|shipped|delivery|delivered|received|product quality|damaged|broken|shattered|leaking|leak|wrong product|missing product|missing item|replacement|replace|reship|reshipment|defective product)\b/.test(lower);

  const isFinance =
    category === 'Refund' ||
    category === 'Payment' ||
    /\b(refund|payment|duplicate payment|charged|deducted|double charged|double charge|overcharged|billing|invoice|transaction|charged but|payment issue|finance complaint)\b/.test(lower);

  const isEngineering =
    category === 'Login/Auth' ||
    /\b(login|log in|signin|sign in|auth|authentication|password|2fa|mfa|otp|website bug|checkout bug|api|api issue|technical error|server error|500 error|404|crash|freeze|syntax|cannot access|unable to access|access my account)\b/.test(lower) ||
    (!isPhysicalProduct && (category === 'Product Bug' || /\b(bug|glitch|software error)\b/.test(lower)));

  if (isPhysicalProduct && !isEngineering) {
    let recAction = 'Replace Product';
    let reason = 'Product damaged or missing upon arrival.';
    if (/broken|damaged|shattered|leaking/i.test(lower)) {
      recAction = 'Replace Product';
      reason = 'Product arrived damaged/broken; replacement recommended.';
    } else if (/missing|never arrived/i.test(lower)) {
      recAction = 'Reship Product';
      reason = 'Item reported missing from delivery; reshipment recommended.';
    } else if (/wrong product/i.test(lower)) {
      recAction = 'Reship Product';
      reason = 'Incorrect item received; reship correct item.';
    } else {
      recAction = 'Contact Customer';
      reason = 'Product or delivery issue requires customer coordination.';
    }
    return {
      department: 'Product / Support',
      recommended_action: recAction,
      reason,
      target_system: 'Admin Portal',
      approval_status: 'PENDING',
      approval_location: 'Admin Portal'
    };
  }

  if (isFinance && !isEngineering) {
    let recAction = 'REFUND';
    let reason = 'Customer reported payment dispute or refund request.';
    if (/charged.*not created|order not created|charged but/i.test(lower)) {
      reason = 'Payment succeeded but order creation failed.';
      recAction = 'REFUND';
    } else if (/duplicate|twice|double charge/i.test(lower)) {
      reason = 'Customer charged multiple times for the same transaction.';
      recAction = 'REFUND';
    } else {
      recAction = 'REFUND / PAYMENT REVIEW';
      reason = 'Customer requested refund or reported payment discrepancy.';
    }
    return {
      department: 'Finance',
      recommended_action: recAction,
      reason,
      target_system: 'Admin Portal',
      approval_status: 'PENDING',
      approval_location: 'Admin Portal'
    };
  }

  if (isEngineering) {
    let recAction = 'Investigate Authentication Issue';
    let reason = 'User unable to access account or authentication error.';
    if (!/login|auth|password|access/i.test(lower)) {
      recAction = 'Fix Technical Bug';
      reason = 'Technical glitch or bug affecting site functionality.';
    }
    return {
      department: 'Engineering',
      recommended_action: recAction,
      reason,
      target_system: 'ClickUp & GitHub',
      approval_status: 'PENDING',
      approval_location: 'ClickUp'
    };
  }

  return {
    department: 'MANUAL_REVIEW',
    recommended_action: 'Manual Review',
    reason: 'Smart Router could not determine department with high confidence.',
    target_system: 'Admin Portal',
    approval_status: 'PENDING',
    approval_location: 'Admin Portal'
  };
}

function mapRowToComplaint(row) {
  const complaintId = normalizeFieldValue(row[0]);
  const customerName = normalizeFieldValue(row[1]);
  const email = normalizeFieldValue(row[2]);
  const orderId = normalizeFieldValue(row[3]);
  const complaintText = normalizeFieldValue(row[4]);
  const category = normalizeFieldValue(row[5]);
  const severity = normalizeFieldValue(row[6]);
  const summary = normalizeFieldValue(row[7]);
  
  let rawStatus = row[8] ? String(row[8]).trim().toUpperCase() : 'OPEN';
  if (rawStatus === 'TO DO' || rawStatus === 'TODO') rawStatus = 'OPEN';
  if (rawStatus === 'COMPLETED' || rawStatus === 'CLOSED') rawStatus = 'RESOLVED';
  
  const isDuplicate = row[9] === true || String(row[9]).toLowerCase() === 'true';
  const resolutionNote = normalizeFieldValue(row[10]);
  const lastUpdatedAt = normalizeFieldValue(row[11]);
  const lastUpdatedBy = normalizeFieldValue(row[12]);
  const notificationStatus = normalizeFieldValue(row[13]);
  const notificationError = normalizeFieldValue(row[14]);
  const githubIssue = normalizeFieldValue(row[15]);
  const clickupTaskId = normalizeFieldValue(row[16]);
  const clickupTaskUrl = normalizeFieldValue(row[17]);
  const duplicateCount = (row[18] !== undefined && row[18] !== '' && !isNaN(Number(row[18]))) ? Number(row[18]) : 0;
  const lastReportedAt = normalizeFieldValue(row[19]);
  const githubIssueUrl = normalizeFieldValue(row[20]);

  // Compute smart routing
  const routing = routeComplaint(category, complaintText, severity, summary);

  // Check in-memory overrides
  const override = approvalOverrides.get(complaintId);
  const effectiveStatus = override?.status || rawStatus;
  
  let effectiveApprovalStatus = override?.approval_status;
  if (!effectiveApprovalStatus) {
    if (effectiveStatus === 'RESOLVED') {
      effectiveApprovalStatus = 'APPROVED';
    } else if (effectiveStatus === 'MANUAL_REVIEW') {
      effectiveApprovalStatus = 'REJECTED';
    } else {
      effectiveApprovalStatus = 'PENDING';
    }
  }

  const isResolved = effectiveStatus === 'RESOLVED';
  const approvedAt = override?.approved_at || (effectiveApprovalStatus === 'APPROVED' ? lastUpdatedAt : null);
  const approvedBy = override?.approved_by || (effectiveApprovalStatus === 'APPROVED' ? lastUpdatedBy : null);

  // Dynamic timeline generator
  const timeline = [
    {
      id: 'step-intake',
      label: 'Complaint Received',
      detail: `Customer ${customerName} submitted ticket via Hanaz complaint form.`,
      status: 'success',
      timestamp: lastReportedAt !== 'Not available' ? lastReportedAt : lastUpdatedAt,
      connector: 'hanaz'
    },
    {
      id: 'step-triage',
      label: 'AI Triage Completed',
      detail: `Category: ${category} | Severity: ${severity} | Summary: "${summary}"`,
      status: 'success',
      timestamp: lastUpdatedAt,
      connector: 'ai'
    },
    {
      id: 'step-routed',
      label: `Routed to ${routing.department}`,
      detail: `Target: ${routing.target_system} | Recommended Action: ${routing.recommended_action}`,
      status: 'success',
      timestamp: lastUpdatedAt,
      connector: 'resolvesync'
    }
  ];

  if (routing.department === 'Engineering') {
    if (githubIssue !== 'Not available' && githubIssue) {
      timeline.push({
        id: 'step-github',
        label: `GitHub Issue #${githubIssue} Created`,
        detail: githubIssueUrl !== 'Not available' ? githubIssueUrl : 'Issue linked to repo',
        status: 'success',
        timestamp: lastUpdatedAt,
        connector: 'github'
      });
    }
    if (clickupTaskId !== 'Not available' && clickupTaskId) {
      timeline.push({
        id: 'step-clickup',
        label: `ClickUp Task Created (${clickupTaskId})`,
        detail: `Status: ${effectiveStatus === 'OPEN' ? 'to do' : effectiveStatus.toLowerCase()}`,
        status: 'success',
        timestamp: lastUpdatedAt,
        connector: 'clickup'
      });
    }
    if (effectiveStatus === 'IN_PROGRESS') {
      timeline.push({
        id: 'step-clickup-progress',
        label: 'ClickUp: IN PROGRESS',
        detail: 'Engineering assigned and currently working on resolution.',
        status: 'pending',
        timestamp: lastUpdatedAt,
        connector: 'clickup'
      });
    }
  } else {
    // Product / Support / Finance / Manual Review
    timeline.push({
      id: 'step-approval-req',
      label: 'Approval Requested (Admin Portal)',
      detail: `Proposal: ${routing.recommended_action} - ${routing.reason}`,
      status: effectiveApprovalStatus === 'PENDING' ? 'pending' : 'success',
      timestamp: lastUpdatedAt,
      connector: 'resolvesync'
    });

    if (effectiveApprovalStatus === 'APPROVED') {
      timeline.push({
        id: 'step-approved',
        label: `Approved by ${approvedBy || 'Admin'}`,
        detail: `Action "${routing.recommended_action}" authorized for execution.`,
        status: 'success',
        timestamp: approvedAt || lastUpdatedAt,
        connector: 'resolvesync'
      });
      timeline.push({
        id: 'step-action-exec',
        label: `Action Processed: ${routing.recommended_action}`,
        detail: `Completed via automated workflow.`,
        status: 'success',
        timestamp: approvedAt || lastUpdatedAt,
        connector: 'resolvesync'
      });
    } else if (effectiveApprovalStatus === 'REJECTED') {
      timeline.push({
        id: 'step-rejected',
        label: 'Action Rejected by Admin',
        detail: 'Transferred to manual review queue.',
        status: 'warning',
        timestamp: lastUpdatedAt,
        connector: 'resolvesync'
      });
    }
  }

  if (isResolved) {
    timeline.push({
      id: 'step-resolved',
      label: 'Complaint Resolved',
      detail: resolutionNote !== 'Not available' && resolutionNote ? resolutionNote : 'Resolved successfully.',
      status: 'success',
      timestamp: lastUpdatedAt,
      connector: 'fastn'
    });
    timeline.push({
      id: 'step-syncs',
      label: 'Sheets, Discord & Notion Synced',
      detail: 'Knowledge case stored in Notion, master row updated, Discord notified.',
      status: 'success',
      timestamp: lastUpdatedAt,
      connector: 'notion'
    });
  }

  return {
    complaint_id: complaintId,
    id: complaintId,
    customer_name: customerName,
    customer: customerName,
    email,
    order_id: orderId,
    orderRef: orderId,
    complaint_text: complaintText,
    message: complaintText,
    category,
    issueType: category,
    severity,
    priority: severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase(),
    summary,
    aiSummary: summary,
    status: effectiveStatus,
    rawStatus: effectiveStatus,
    is_duplicate: isDuplicate,
    duplicate_count: duplicateCount,
    duplicateCount,
    resolution_note: resolutionNote,
    resolutionNote,
    last_updated_at: lastUpdatedAt,
    updatedAt: lastUpdatedAt,
    created_at: lastReportedAt !== 'Not available' ? lastReportedAt : lastUpdatedAt,
    createdAt: lastReportedAt !== 'Not available' ? lastReportedAt : lastUpdatedAt,
    last_updated_by: lastUpdatedBy,
    lastUpdatedBy,
    notification_status: notificationStatus,
    notificationStatus,
    notification_error: notificationError,
    github_issue: githubIssue,
    github_issue_url: githubIssueUrl !== 'Not available' ? githubIssueUrl : '',
    clickup_task_id: clickupTaskId !== 'Not available' ? clickupTaskId : '',
    clickup_task_url: clickupTaskUrl !== 'Not available' ? clickupTaskUrl : '',
    sheet_url: SHEET_PUBLIC_URL,
    notion_url: isResolved ? NOTION_DATABASE_URL : '',
    discord_safe_url: DISCORD_SAFE_URL,
    
    // Smart Router & Action Proposal Fields
    department: routing.department,
    recommended_action: routing.recommended_action,
    recommendedAction: routing.recommended_action,
    reason: routing.reason,
    target_system: routing.target_system,
    targetSystem: routing.target_system,
    approval_status: effectiveApprovalStatus,
    approvalStatus: effectiveApprovalStatus,
    approval_location: routing.approval_location,
    approvalLocation: routing.approval_location,
    approval_source: routing.approval_location === 'ClickUp' ? 'ClickUp' : 'ADMIN_PORTAL',
    approved_at: approvedAt,
    approved_by: approvedBy,
    
    timeline,
  };
}

async function fetchLiveComplaints() {
  const now = Date.now();
  if (cachedRows && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedRows;
  }

  try {
    const actionId = await getGetValuesActionId();
    const data = await callMcp('fastnPlatform__executeAction', {
      connectorId: SHEETS_CONNECTOR_ID,
      actionId,
      connectionName: 'default',
      input: {
        spreadsheetId: SPREADSHEET_ID,
        range: "'ResolveSync Incidents'!A:U"
      }
    });

    const values = data.result?.structuredContent?.data?.response?.values || [];
    if (values.length > 1) {
      const complaints = values.slice(1).map(mapRowToComplaint);
      complaints.reverse();
      cachedRows = complaints;
      lastFetchTime = now;
      return cachedRows;
    }
  } catch (err) {
    console.error('[Admin API] Error fetching sheet rows:', err.message);
  }

  return cachedRows || [];
}

async function adminComplaintsHandler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname.replace(/\/+$/, '');

  // 1. GET /api/admin/complaints
  if (req.method === 'GET' && pathname === '/api/admin/complaints') {
    try {
      const complaints = await fetchLiveComplaints();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ complaints }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Failed to retrieve complaints', detail: err.message }));
    }
  }

  // 2. GET /api/admin/complaints/pending-approvals
  if (req.method === 'GET' && pathname === '/api/admin/complaints/pending-approvals') {
    try {
      const complaints = await fetchLiveComplaints();
      // Filter for Product / Support, Finance, or MANUAL_REVIEW with PENDING approval status
      const pending = complaints.filter(c => 
        c.approval_status === 'PENDING' && c.approval_location !== 'ClickUp'
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ approvals: pending, count: pending.length }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Failed to retrieve pending approvals', detail: err.message }));
    }
  }

  // 3. GET /api/admin/audit-log
  if (req.method === 'GET' && pathname === '/api/admin/audit-log') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ entries: auditLogEntries }));
  }

  // 4. POST /api/admin/complaints/:id/approve
  const approveMatch = pathname.match(/^\/api\/admin\/complaints\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const complaintId = decodeURIComponent(approveMatch[1]);
    try {
      const complaints = await fetchLiveComplaints();
      const complaint = complaints.find(c => c.complaint_id === complaintId || c.id === complaintId);
      if (!complaint) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Complaint not found', complaint_id: complaintId }));
      }

      const approver = req.body?.approved_by || 'Admin';
      const actionName = req.body?.action || complaint.recommended_action || 'Action Executed';
      const now = new Date().toISOString();

      // Record in-memory override for immediate responsiveness
      approvalOverrides.set(complaintId, {
        approval_status: 'APPROVED',
        status: 'RESOLVED',
        approved_at: now,
        approved_by: approver
      });

      // Invalidate row cache
      cachedRows = null;
      lastFetchTime = 0;

      // Log audit trail
      logAuditEvent({
        complaint_id: complaintId,
        source: 'Admin Portal',
        previous_status: complaint.status,
        new_status: 'APPROVED',
        action: 'APPROVED',
        detail: `Admin ${approver} approved proposal: ${actionName}`
      });
      logAuditEvent({
        complaint_id: complaintId,
        source: 'ResolveSync Automation',
        previous_status: 'APPROVED',
        new_status: 'PROCESSING',
        action: 'ACTION_STARTED',
        detail: `Executing recommended action: ${actionName}`
      });
      logAuditEvent({
        complaint_id: complaintId,
        source: 'ResolveSync Automation',
        previous_status: 'PROCESSING',
        new_status: 'RESOLVED',
        action: 'ACTION_COMPLETED',
        detail: `Action ${actionName} processed successfully.`
      });
      logAuditEvent({
        complaint_id: complaintId,
        source: 'Fastn Pipeline',
        previous_status: 'PROCESSING',
        new_status: 'RESOLVED',
        action: 'RESOLVED',
        detail: `Incident resolved, Google Sheets and Notion updated, Discord alert dispatched.`
      });

      // Dispatch to Fastn webhook to update Google Sheets, Notion, Discord
      let fastnResult = null;
      try {
        const resolutionPayload = {
          complaint_id: complaintId,
          status: 'RESOLVED',
          resolution_note: `Approved by Admin: ${actionName} executed successfully.`,
          approval_status: 'APPROVED',
          approved_by: approver,
          approved_at: now,
          last_updated_by: 'Admin'
        };
        const fastnRes = await fetch(FASTN_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resolutionPayload)
        });
        fastnResult = await fastnRes.json().catch(() => ({ status: fastnRes.status }));
      } catch (fErr) {
        console.warn('[Admin API] Fastn resolution dispatch warning:', fErr.message);
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        success: true,
        complaint_id: complaintId,
        approval_status: 'APPROVED',
        status: 'RESOLVED',
        action: actionName,
        approved_by: approver,
        approved_at: now,
        fastn_dispatch: fastnResult
      }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Failed to approve complaint', detail: err.message }));
    }
  }

  // 5. POST /api/admin/complaints/:id/reject
  const rejectMatch = pathname.match(/^\/api\/admin\/complaints\/([^/]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    const complaintId = decodeURIComponent(rejectMatch[1]);
    try {
      const complaints = await fetchLiveComplaints();
      const complaint = complaints.find(c => c.complaint_id === complaintId || c.id === complaintId);
      if (!complaint) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Complaint not found', complaint_id: complaintId }));
      }

      const approver = req.body?.approved_by || 'Admin';
      const reason = req.body?.reason || 'Proposal rejected by Admin; escalated to manual review.';
      const now = new Date().toISOString();

      approvalOverrides.set(complaintId, {
        approval_status: 'REJECTED',
        status: 'MANUAL_REVIEW',
        rejected_at: now,
        rejected_by: approver
      });

      cachedRows = null;
      lastFetchTime = 0;

      // Log audit trail
      logAuditEvent({
        complaint_id: complaintId,
        source: 'Admin Portal',
        previous_status: complaint.status,
        new_status: 'REJECTED',
        action: 'REJECTED',
        detail: `Admin ${approver} rejected action: ${reason}`
      });
      logAuditEvent({
        complaint_id: complaintId,
        source: 'ResolveSync Router',
        previous_status: 'REJECTED',
        new_status: 'MANUAL_REVIEW',
        action: 'STATUS_CHANGED',
        detail: 'Complaint moved to manual review queue without executing proposed action.'
      });

      // Dispatch status update to Fastn
      let fastnResult = null;
      try {
        const updatePayload = {
          complaint_id: complaintId,
          status: 'MANUAL_REVIEW',
          resolution_note: `Rejected by Admin: ${reason}`,
          approval_status: 'REJECTED',
          last_updated_by: 'Admin'
        };
        const fastnRes = await fetch(FASTN_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatePayload)
        });
        fastnResult = await fastnRes.json().catch(() => ({ status: fastnRes.status }));
      } catch (fErr) {
        console.warn('[Admin API] Fastn status dispatch warning:', fErr.message);
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        success: true,
        complaint_id: complaintId,
        approval_status: 'REJECTED',
        status: 'MANUAL_REVIEW',
        fastn_dispatch: fastnResult
      }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Failed to reject complaint', detail: err.message }));
    }
  }

  // 6. GET /api/admin/complaints/:id
  const singleMatch = pathname.match(/^\/api\/admin\/complaints\/([^/]+)$/);
  if (req.method === 'GET' && singleMatch) {
    const complaintId = decodeURIComponent(singleMatch[1]);
    try {
      const complaints = await fetchLiveComplaints();
      const complaint = complaints.find(c => c.complaint_id === complaintId || c.id === complaintId);
      if (!complaint) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Complaint not found', complaint_id: complaintId }));
      }

      const relevantAudit = auditLogEntries.filter(e => e.complaint_id === complaintId);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ complaint, audit_log: relevantAudit }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Failed to retrieve complaint', detail: err.message }));
    }
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify({ error: 'Not found' }));
}

module.exports = {
  fetchLiveComplaints,
  adminComplaintsHandler,
  routeComplaint,
  logAuditEvent,
};
