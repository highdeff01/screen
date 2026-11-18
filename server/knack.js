/**
 * Knack mapping and Command Center setup artefacts.
 *
 * Knack assigns its own field keys (field_##) when a field is created, so this
 * mapping pairs the logical Sightline key with the recommended Knack object,
 * display label and field type. After creating a field in Knack Builder, copy
 * its API key into `knackField` here (or keep your own equivalent mapping).
 */

const F = (key, object, label, type, source, purpose, extra = {}) => ({
  key,
  object,
  label,
  type,
  source,
  purpose,
  knackField: extra.knackField || 'field_###',
  required: Boolean(extra.required),
  options: extra.options || null,
});

export const KNACK_OBJECTS = [
  {
    key: 'workflows',
    name: 'Automation Workflows',
    purpose: 'One record per workflow, including failure policy and pattern tags.',
    connections: ['Automation Steps (one-to-many)', 'Test Runs (one-to-many)'],
  },
  {
    key: 'steps',
    name: 'Automation Steps',
    purpose: 'Ordered steps that belong to a workflow. Params stay JSON text so the schema does not drift.',
    connections: ['Automation Workflows (many-to-one)'],
  },
  {
    key: 'runs',
    name: 'Test Runs',
    purpose: 'One record per execution with retry count, error category and evidence links.',
    connections: ['Automation Workflows (many-to-one)', 'Command Center Sessions (many-to-one)'],
  },
  {
    key: 'sessions',
    name: 'Command Center Sessions',
    purpose: 'One record per mission: supervisor chain, attempts, verdict and review.',
    connections: ['Automation Workflows', 'Test Runs (one-to-many)', 'Command Center Events (one-to-many)'],
  },
  {
    key: 'events',
    name: 'Command Center Events',
    purpose: 'Append-only agent event stream used by the Events table and audit views.',
    connections: ['Command Center Sessions (many-to-one)', 'Test Runs (many-to-one)'],
  },
];

export const KNACK_FIELDS = [
  /* Automation Workflows */
  F('workflow.id', 'workflows', 'Workflow ID', 'Short Text', 'workflow.id', 'Stable key for imports and connections.', { required: true }),
  F('workflow.name', 'workflows', 'Workflow Name', 'Short Text', 'workflow.name', 'Human label in tables and filters.', { required: true }),
  F('workflow.description', 'workflows', 'Description', 'Paragraph', 'workflow.description', 'What the workflow proves.'),
  F('workflow.status', 'workflows', 'Status', 'Multiple Choice', 'workflow.status', 'Draft / Ready / Archived gate.', {
    options: ['draft', 'ready', 'archived'],
  }),
  F('workflow.failurePolicy.onFailure', 'workflows', 'Failure Action', 'Multiple Choice', 'workflow.failurePolicy.onFailure', 'Stop, retry or continue.', {
    options: ['stop', 'retry', 'continue'],
  }),
  F('workflow.failurePolicy.maxRetries', 'workflows', 'Max Retries', 'Number', 'workflow.failurePolicy.maxRetries', 'Retry budget per step (0–5).'),
  F('workflow.failurePolicy.captureScreenshot', 'workflows', 'Capture Failure Screenshot', 'Checkbox', 'workflow.failurePolicy.captureScreenshot', 'Evidence policy.'),
  F('workflow.failurePolicy.pauseBeforeRetryMs', 'workflows', 'Retry Pause (ms)', 'Number', 'workflow.failurePolicy.pauseBeforeRetryMs', 'Backoff before a retry.'),
  F('workflow.patternTags', 'workflows', 'Pattern Tags', 'Short Text', 'workflow.patternTags', 'Comma-separated tags used for analytics, filters and matching learned fixes. NEW.', {
    required: true,
  }),
  F('workflow.tags', 'workflows', 'Labels', 'Short Text', 'workflow.tags', 'Free-form labels, separate from pattern tags.'),
  F('workflow.totalFailures7d', 'workflows', 'Total Failures (Last 7 Days)', 'Number', 'failed runs in the last 7 days', 'Rolling failure count per workflow. NEW.'),
  F('workflow.flakinessScore', 'workflows', 'Flakiness Score', 'Number', 'failures + needs-review + retry pressure, 0–100', 'Higher means less reliable; use for the Repairs view. NEW.'),
  F('workflow.avgComplexity', 'workflows', 'Average Complexity Score', 'Number', 'latest run complexity or workflow estimate', 'Planning effort at a glance. NEW.'),
  F('workflow.updatedAt', 'workflows', 'Updated At', 'Date/Time', 'workflow.updatedAt', 'Freshness and import bookkeeping.'),

  /* Automation Steps */
  F('step.id', 'steps', 'Step ID', 'Short Text', 'workflow.steps[i].id', 'Stable step key.', { required: true }),
  F('step.workflowId', 'steps', 'Workflow', 'Connection', 'workflow.steps[i] → workflow.id', 'Parent workflow connection.', { required: true }),
  F('step.order', 'steps', 'Order', 'Number', 'array index + 1', 'Execution order.'),
  F('step.type', 'steps', 'Step Type', 'Multiple Choice', 'workflow.steps[i].type', 'Automation step type.', {
    options: [
      'launchApp',
      'openUrl',
      'focusWindow',
      'move',
      'click',
      'doubleClick',
      'rightClick',
      'drag',
      'scroll',
      'type',
      'key',
      'clipboard',
      'aiExtract',
      'wait',
      'waitFor',
      'screenshot',
      'verifyScreen',
      'verifyPlayback',
      'mediaHold',
      'clickElement',
      'expect',
      'playMedia',
      'closeWindow',
      'runTool',
      'note',
      'writeNote',
      'readNote',
      'copyLink',
      'downloadMedia',
      'saveImage',
      'writeTextFile',
      'recordVideo',
      'watchVideo',
      'installApp',
      'testApp',
    ],
  }),
  F('step.name', 'steps', 'Step Name', 'Short Text', 'workflow.steps[i].name', 'Readable step label.'),
  F('step.params', 'steps', 'Parameters (JSON)', 'Paragraph', 'workflow.steps[i].params', 'Exact Builder params, JSON encoded.'),
  F('step.timeoutMs', 'steps', 'Timeout (ms)', 'Number', 'workflow.steps[i].timeoutMs', 'Step watchdog.'),
  F('step.optional', 'steps', 'Optional', 'Checkbox', 'workflow.steps[i].optional', 'Optional failures do not stop the run.'),

  /* Test Runs */
  F('run.id', 'runs', 'Run ID', 'Short Text', 'run.id', 'Stable run key.', { required: true }),
  F('run.workflowId', 'runs', 'Workflow', 'Connection', 'run.workflowId', 'Workflow connection.', { required: true }),
  F('run.workflowName', 'runs', 'Workflow Name', 'Short Text', 'run.workflowName', 'Denormalised for fast tables.'),
  F('run.status', 'runs', 'Status', 'Multiple Choice', 'run.status', 'Terminal run state.', {
    options: ['queued', 'running', 'passed', 'failed', 'needs_review', 'cancelled'],
  }),
  F('run.mode', 'runs', 'Mode', 'Multiple Choice', 'run.dryRun ? dry : live', 'Simulated vs live desktop.', { options: ['dry', 'live'] }),
  F('run.trigger', 'runs', 'Trigger', 'Multiple Choice', 'run.trigger', 'manual / retry / scheduler / mission.', {
    options: ['manual', 'retry', 'scheduler', 'mission'],
  }),
  F('run.agentRole', 'runs', 'Agent Role Type', 'Multiple Choice', 'run.agentRole', 'Which agent produced the run: operator, scheduler, executor-a/b, verifier, reviewer.', {
    options: ['operator', 'scheduler', 'supervisor', 'planner', 'executor-a', 'executor-b', 'verifier', 'reviewer'],
  }),
  F('run.retryCount', 'runs', 'Retry Count', 'Number', 'run.retryCount', 'Total retries used across steps. Drives retry analytics and alerts.', {
    required: true,
  }),
  F('run.lastErrorCode', 'runs', 'Last Error Code', 'Short Text', 'run.lastErrorCode', 'Stable code for the most recent failure (TOOL_NOT_FOUND, TIMEOUT …). NEW.'),
  F('run.lastErrorCategory', 'runs', 'Last Error Category', 'Multiple Choice', 'run.lastErrorCategory', 'Category of the most recent failure. NEW.', {
    options: [
      'none',
      'timeout',
      'window_not_found',
      'process_missing',
      'tool_missing',
      'navigation_failed',
      'input_failed',
      'assertion_failed',
      'file_issue',
      'ai_error',
      'unknown',
    ],
  }),
  F('run.runComplexityScore', 'runs', 'Run Complexity Score', 'Number', 'run.runComplexityScore', '0–100 estimate from step count, waits, tools, optional branches and retry policy. NEW.'),
  F('run.requiresAdvancedPlanning', 'runs', 'Requires Advanced Planning', 'Checkbox', 'run.requiresAdvancedPlanning', 'True when the workflow needs research/replanning (tools, many branches, security tags, high complexity). NEW.'),
  F('run.errorCategory', 'runs', 'Error Category', 'Multiple Choice', 'run.errorCategory', 'Normalised failure bucket for charts.', {
    options: [
      'none',
      'timeout',
      'window_not_found',
      'process_missing',
      'tool_missing',
      'navigation_failed',
      'input_failed',
      'assertion_failed',
      'file_issue',
      'ai_error',
      'unknown',
    ],
  }),
  F('run.failureSignature', 'runs', 'Failure Signature', 'Short Text', 'run.failureSignature', 'Step type + normalised error, used to match learned patterns.'),
  F('run.patternTags', 'runs', 'Pattern Tags', 'Short Text', 'run.patternTags', 'Snapshot of workflow pattern tags at run time.'),
  F('run.matchedPatternTags', 'runs', 'Matched Pattern Tags', 'Short Text', 'run.matchedPatternTags', 'Tags that matched a learned fix, when a replan reused one.'),
  F('run.recovered', 'runs', 'Recovered', 'Checkbox', 'run.recovered', 'Passed after at least one retry.'),
  F('run.evidenceCount', 'runs', 'Evidence Count', 'Number', 'run.evidence.length', 'Screenshots and artefacts.'),
  F('run.durationMs', 'runs', 'Duration (ms)', 'Number', 'run.durationMs', 'Execution time.'),
  F('run.startedAt', 'runs', 'Started At', 'Date/Time', 'run.startedAt', 'Timeline filter.'),
  F('run.endedAt', 'runs', 'Ended At', 'Date/Time', 'run.endedAt', 'Timeline filter.'),
  F('run.reviewed', 'runs', 'Reviewed', 'Checkbox', 'run.review.status === reviewed', 'Evidence review gate.'),
  F('run.analysisSummary', 'runs', 'Analysis Summary', 'Paragraph', 'run.analysis.summary', 'AI diagnosis text.'),
  F('run.missionId', 'runs', 'Session', 'Connection', 'run.missionId', 'Optional link to the Command Center session.'),

  /* Command Center Sessions */
  F('session.id', 'sessions', 'Session ID', 'Short Text', 'mission.id', 'Stable session key.', { required: true }),
  F('session.goal', 'sessions', 'Mission Goal', 'Paragraph', 'mission.goal', 'What must be true at the end.', { required: true }),
  F('session.workflowId', 'sessions', 'Workflow', 'Connection', 'mission.workflowId', 'Executed workflow.'),
  F('session.workflowName', 'sessions', 'Workflow Name', 'Short Text', 'mission.workflowName', 'Denormalised label.'),
  F('session.status', 'sessions', 'Status', 'Multiple Choice', 'mission.status', 'queued … passed/failed/cancelled.', {
    options: ['queued', 'planning', 'running', 'verifying', 'reviewing', 'replanning', 'passed', 'failed', 'cancelled', 'needs_review'],
  }),
  F('session.mode', 'sessions', 'Mode', 'Multiple Choice', 'mission.mode', 'Simulated vs live.', { options: ['dry', 'live'] }),
  F('session.attempts', 'sessions', 'Attempts', 'Number', 'mission.attempts', 'Run attempts used.'),
  F('session.maxAttempts', 'sessions', 'Max Attempts', 'Number', 'mission.maxAttempts', 'Attempt budget.'),
  F('session.retryCount', 'sessions', 'Retry Count', 'Number', 'mission.attempts - 1', 'Repair attempts for session analytics.'),
  F('session.verdict', 'sessions', 'Verdict', 'Multiple Choice', 'mission.verification.verdict', 'Verifier verdict.', {
    options: ['on_target', 'off_target'],
  }),
  F('session.confidence', 'sessions', 'Confidence %', 'Number', 'mission.verification.confidence * 100', 'Verifier confidence.'),
  F('session.patternTags', 'sessions', 'Pattern Tags', 'Short Text', 'workflow.patternTags', 'Tags carried by the session.'),
  F('session.learnedPattern', 'sessions', 'Learned Pattern', 'Short Text', 'mission.learnedPattern.signature', 'Repair that worked.'),
  F('session.reviewerSummary', 'sessions', 'Reviewer Summary', 'Paragraph', 'mission.review.summary', 'Final reviewer output.'),
  F('session.nextActions', 'sessions', 'Next Actions', 'Paragraph', 'mission.review.nextActions', 'Follow-ups from the reviewer.'),
  F('session.startedAt', 'sessions', 'Started At', 'Date/Time', 'mission.startedAt', 'Timeline.'),
  F('session.endedAt', 'sessions', 'Ended At', 'Date/Time', 'mission.endedAt', 'Timeline.'),

  /* Command Center Events */
  F('event.id', 'events', 'Event ID', 'Short Text', 'event.id', 'Stable event key.', { required: true }),
  F('event.sessionId', 'events', 'Session', 'Connection', 'event → mission.id', 'Parent session.', { required: true }),
  F('event.agent', 'events', 'Agent', 'Multiple Choice', 'event.agent', 'Which agent emitted the event.', {
    options: ['supervisor', 'planner', 'executor-a', 'executor-b', 'verifier', 'reviewer'],
  }),
  F('event.kind', 'events', 'Event Kind', 'Multiple Choice', 'event.kind', 'Event class.', {
    options: ['start', 'action', 'decision', 'progress', 'check', 'verification', 'replan', 'result', 'error'],
  }),
  F('event.severity', 'events', 'Severity', 'Multiple Choice', 'derived from kind', 'Info / warning / error for triage filters.', {
    options: ['info', 'warn', 'error'],
  }),
  F('event.message', 'events', 'Message', 'Paragraph', 'event.message', 'Human-readable event text.'),
  F('event.runId', 'events', 'Run', 'Connection', 'event.runId', 'Optional run link.'),
  F('event.stepName', 'events', 'Step', 'Short Text', 'event.step', 'Step label when the event is step-scoped.'),
  F('event.createdAt', 'events', 'Created At', 'Date/Time', 'event.at', 'Default sort key.'),
];

export const COMMAND_CENTER_CHECKLIST = [
  {
    title: '0 · Before you start',
    steps: [
      'Open your Knack app in Builder and confirm you can add objects, fields and pages (Owner/Builder role).',
      'Download the mapping and CSV from this console: GET /api/knack/download?format=csv and ?format=md.',
      'Decide whether you will import history or start clean; imports create duplicate records if repeated.',
      'Record your live API keys only in Knack’s API settings — never in this repo or in chat.',
    ],
  },
  {
    title: '1 · Create the five objects',
    steps: [
      'Objects → Add Object: Automation Workflows (table name automation_workflows).',
      'Add Automation Steps, Test Runs, Command Center Sessions and Command Center Events.',
      'Connections: Steps → Workflows (many-to-one); Runs → Workflows; Sessions → Workflows; Runs → Sessions; Events → Sessions; Events → Runs.',
      'Rename auto-generated field labels to the labels in KNACK_FIELDS so filters and exports stay readable.',
      'Turn on “Show in API” and note each field’s API key (field_##); update knackField in server/knack.js.',
    ],
  },
  {
    title: '2 · Add Retry Count to Test Runs (requested)',
    steps: [
      'Test Runs → Add Field → Number → label “Retry Count”, name retry_count.',
      'Set Decimal Places 0, Min 0, Max 20, Required off (imports may not carry it).',
      'Field settings → Show in API on. Copy the API key into KNACK_FIELDS run.retryCount.',
      'Add a formula field only if you want retries per step: SUM of Steps.attempts − step count.',
      'Add a view filter “Retry Count is greater than 0” for the Retry Watch table.',
    ],
  },
  {
    title: '3 · Add Pattern Tags to Automation Workflows (requested)',
    steps: [
      'Automation Workflows → Add Field → Short Text → label “Pattern Tags”, name pattern_tags.',
      'Help text: “Comma-separated tags, e.g. retry, timeout, browser, login; lowercase, no spaces.”',
      'Field settings → Show in API on; copy the API key into KNACK_FIELDS workflow.patternTags.',
      'Add a Text Formula “Tag List” if you want line breaks, or keep the raw CSV for filtering with “contains”.',
      'On Test Runs add a matching “Pattern Tags” short text field and copy the workflow tags at run creation.',
    ],
  },
  {
    title: '4b · Add the new error and flakiness fields',
    steps: [
      'Test Runs → Add Field → Short Text: “Last Error Code” (last_error_code), Show in API on.',
      'Test Runs → Add Field → Multiple Choice: “Last Error Category” (last_error_category) with the same options as Error Category.',
      'Test Runs → Add Field → Number: “Run Complexity Score” (run_complexity_score), 0–100, decimals 0.',
      'Test Runs → Add Field → Checkbox: “Requires Advanced Planning” (requires_advanced_planning).',
      'Automation Workflows → Add Field → Number: “Total Failures (Last 7 Days)” (total_failures_7d).',
      'Automation Workflows → Add Field → Number: “Flakiness Score” (flakiness_score), 0–100.',
      'Automation Workflows → Add Field → Number: “Average Complexity Score” (avg_complexity_score), 0–100.',
      'Copy each API key into server/knack.js and add a table filter for Flakiness Score ≥ 40 and Requires Advanced Planning = yes.',
    ],
  },
  {
    title: '4 · Add the analytics and error-handling fields',
    steps: [
      'Test Runs: Error Category (Multiple Choice), Failure Signature (Short Text), Recovered (Checkbox), Evidence Count (Number), Reviewed (Checkbox), Session (Connection).',
      'Sessions: Retry Count (Number), Verdict (Multiple Choice), Confidence % (Number 0–100), Pattern Tags (Short Text), Learned Pattern (Short Text), Reviewer Summary (Paragraph), Next Actions (Paragraph).',
      'Events: Severity (Multiple Choice info/warn/error), Agent (Multiple Choice with the six roles), Kind (Multiple Choice), Step (Short Text).',
      'Optional: Automation Workflows “Last Run Status” (Short Text) fed by a scheduled export for at-a-glance tables.',
      'Do not add free-text duplicates of values that already have a multiple-choice field; filters degrade quickly.',
    ],
  },
  {
    title: '5 · Import or sync records',
    steps: [
      'Workflows first, then Steps and Test Runs, then Sessions, then Events — connections need their parents.',
      'Use Knack’s CSV importer with “Match on Workflow ID / Run ID / Session ID” to make re-imports idempotent.',
      'Run data/python/knack_export.py --api-key … --app-id … to write the five CSVs from this console.',
      'Import Test Runs with Retry Count and Error Category mapped to the new fields; verify one row visually.',
      'Schedule the Python exporter (Task Scheduler or cron) if Knack should mirror Sightline continuously.',
    ],
  },
  {
    title: '6 · Build the Command Center page',
    steps: [
      'Pages → Add Page → “Command Center”, type List/Details or Dashboard; place it in the main navigation.',
      'Add a Sessions table view: columns Goal, Workflow, Status, Attempts, Retry Count, Verdict, Confidence, Started At.',
      'Add an Events table view: columns Created At, Agent, Kind, Severity, Message, Session; default sort Created At descending.',
      'Add a Runs table view filtered to Retry Count > 0 for the retry watch, plus a failure-category summary.',
      'Add a Session details view with a child Events table and a child Runs table; link rows from both tables.',
      'Add summary counts (Sessions in progress, Failed this week, Retries used, On-target rate) as number/text views.',
      'Add a form to create a Session (Goal, Workflow, Max Attempts, Vision checkbox) for manual intake.',
    ],
  },
  {
    title: '7 · Filters, sorts and search',
    steps: [
      'Sessions: filters Status, Mode, Verdict, Pattern Tags (contains), Retry Count ≥ N, Started At range; sort Verdict then Ended At; search Goal/Workflow.',
      'Events: filters Session, Agent, Kind, Severity, Created At range; sort Created At desc; search Message.',
      'Runs: filters Status, Error Category, Recovered, Retry Count > 0; sort Retry Count desc for the repair queue.',
      'Save each combination as a named view (e.g. “Repairs this week”, “Security navigation failures”, “Retry hot spots”).',
      'Use Knack’s filter menu (not formulas) so users can change filters without editing the page.',
    ],
  },
  {
    title: '8 · Security and navigation between AI and agents',
    steps: [
      'User roles: Builder/Admin, Operator (run + review), Viewer (read-only). Hide Settings and API pages from Viewer.',
      'Restrict live desktop triggers to Operator+ and require a confirmation step; record who approved in Events.',
      'Scope connections so a Session only lists Runs and Events that belong to it; never expose other users’ records.',
      'Keep model/API keys in Knack’s API settings or a server proxy — never in a public page, formula or record.',
      'Log every agent decision as an Event with severity so a reviewer can trace who changed what and when.',
      'Add page rules so Archived workflows cannot be selected in the intake form; validate required Goal and Workflow.',
      'Review Events for unexpected agents or navigation failures weekly; export before deleting anything.',
    ],
  },
  {
    title: '9 · Rules, alerts and automation',
    steps: [
      'Rules: when Run Status becomes failed, show Error Category and require Reviewed before closing.',
      'Rules: when Retry Count ≥ 2, flag the row and notify the operator (email or Slack via Zapier/Make).',
      'Rules: when Session Verdict is off_target, require Next Actions before the session can be marked reviewed.',
      'Scheduled tasks: nightly rollup of retries by workflow; weekly archive of Events older than 90 days.',
      'Keep Events append-only in the UI; edits belong in a separate Review record.',
    ],
  },
  {
    title: '10 · Analytics to add after the tables work',
    steps: [
      'Bar chart: Retry Count by Workflow (top 10) to find brittle steps.',
      'Pie/bar: Error Category mix; line: failures per day; KPI: on-target rate and median attempts.',
      'Pattern-tag leaderboard: pass rate and retry rate per tag (contains filter per tag).',
      'Agent workload: Events by Agent and Kind over time; replans per Session as a quality signal.',
      'Recovered vs never-passed runs to show whether retries actually help.',
    ],
  },
  {
    title: '11 · Verification checklist',
    steps: [
      'Create one workflow, two steps, one run with Retry Count 2 and tags “retry, timeout”; confirm it appears in all three tables.',
      'Apply each saved filter and confirm counts change as expected; clear filters and confirm the default sort.',
      'Open a Session detail and confirm its Events and Runs tables show only that session.',
      'Sign in as Viewer and confirm Settings, live triggers and other users’ records are inaccessible.',
      'Re-import the same CSVs and confirm match-on-ID prevents duplicates.',
      'Export each table once and verify Retry Count, Pattern Tags, Last Error Code, Run Complexity Score and Requires Advanced Planning are present.',
      'Confirm a failed run fills Last Error Code/Category and that its workflow’s Flakiness Score and Total Failures (Last 7 Days) change.',
    ],
  },
];

export const KNACK_LIMITS = [
  'Knack’s API can create records, not fields or pages. Fields, objects, views and permissions are Builder-only work.',
  'This console cannot sign in to your Knack account; the checklist and CSVs are the handoff, and the mapping lives in server/knack.js.',
  'Knack field API keys are assigned per app, so the field_### values here are placeholders until you copy the real ones.',
];

export const MULTI_AGENT_PATTERN = {
  description:
    'Concrete record pattern for a desktop + browser chain: one session, two executor runs, the events that connect them and the operator commands issued against the session.',
  scenario: 'Sign in to a web console in Chrome, copy the verification token, type it into a desktop app, prove both windows still exist.',
  session: {
    id: 'msn_example01',
    goal: 'Sign in to the console and confirm the token appears in Notepad',
    workflowId: 'wf_desktop_browser_chain',
    workflowName: 'Desktop + browser handoff chain',
    mode: 'live',
    status: 'passed',
    attempts: 2,
    maxAttempts: 2,
    retryCount: 1,
    verdict: 'on_target',
    confidence: 0.82,
    patternTags: ['multi-agent', 'desktop', 'browser', 'handoff'],
  },
  runs: [
    {
      id: 'run_example_a',
      agentRole: 'executor-a',
      missionId: 'msn_example01',
      status: 'failed',
      retryCount: 1,
      lastErrorCode: 'WINDOW_NOT_FOUND',
      complexityScore: 72,
      requiresAdvancedPlanning: true,
      failureSignature: 'waitFor:window not found: Sign in',
    },
    {
      id: 'run_example_b',
      agentRole: 'executor-b',
      missionId: 'msn_example01',
      status: 'passed',
      retryCount: 2,
      lastErrorCode: null,
      complexityScore: 72,
      requiresAdvancedPlanning: true,
      failureSignature: null,
    },
  ],
  events: [
    { agent: 'supervisor', kind: 'start', message: 'Baseline captured; holding the frame.' },
    { agent: 'planner', kind: 'action', message: 'Split browser sign-in and desktop handoff into two executor runs.' },
    { agent: 'executor-a', kind: 'action', message: 'Dispatched browser leg on executor-a.' },
    { agent: 'verifier', kind: 'verification', message: 'off_target: sign-in window absent in capture.' },
    { agent: 'planner', kind: 'replan', message: 'Insert waitFor window “Sign in” and re-capture before typing.' },
    { agent: 'executor-b', kind: 'action', message: 'Dispatched repair leg on executor-b.' },
    { agent: 'verifier', kind: 'verification', message: 'on_target: token visible in Notepad capture.' },
    { agent: 'reviewer', kind: 'result', message: 'Session passed on attempt 2; note and next actions written.' },
  ],
  operatorCommands: [
    {
      command: 'FORCE_REPLAN',
      reason: 'Window assertion failed after sign-in',
      by: 'admin',
      at: '2026-11-14T14:21:00.000Z',
    },
    {
      command: 'OVERRIDE_RESUME',
      reason: 'Repair leg confirmed the token in Notepad',
      by: 'admin',
      at: '2026-11-14T14:22:30.000Z',
    },
  ],
  savedViews: ['errors', 'replans', 'security'],
};

export function knackSchema() {
  return {
    ok: true,
    objects: KNACK_OBJECTS,
    fields: KNACK_FIELDS,
    checklist: COMMAND_CENTER_CHECKLIST,
    limits: KNACK_LIMITS,
    pattern: MULTI_AGENT_PATTERN,
    counts: { objects: KNACK_OBJECTS.length, fields: KNACK_FIELDS.length },
  };
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function knackCsv() {
  const header = ['object', 'field_label', 'field_type', 'knack_api_key', 'logical_key', 'required', 'options', 'purpose'];
  const rows = KNACK_FIELDS.map((field) => [
    field.object,
    field.label,
    field.type,
    field.knackField,
    field.key,
    field.required ? 'yes' : 'no',
    (field.options || []).join(' | '),
    field.purpose,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

export function knackMarkdown() {
  const lines = [
    '# Command Center in Knack Builder — setup checklist',
    '',
    ...KNACK_LIMITS.map((limit) => `> ${limit}`),
    '',
    '## Multi-agent record pattern',
    '',
    '```json',
    JSON.stringify(MULTI_AGENT_PATTERN, null, 2),
    '```',
    '',
    '## Objects',
    '',
    ...KNACK_OBJECTS.map((object) => `- **${object.name}** — ${object.purpose} Connections: ${object.connections.join('; ')}`),
    '',
    '## Fields',
    '',
    '| Object | Field | Type | API key (fill in) | Logical key |',
    '| --- | --- | --- | --- | --- |',
    ...KNACK_FIELDS.map(
      (field) => `| ${field.object} | ${field.label} | ${field.type} | ${field.knackField} | \`${field.key}\` |`
    ),
    '',
    ...COMMAND_CENTER_CHECKLIST.flatMap((section) => [
      `## ${section.title}`,
      '',
      ...section.steps.map((step) => `- [ ] ${step}`),
      '',
    ]),
  ];
  return lines.join('\n');
}

/* ------------------------------ record export ------------------------------ */

function tagsOf(workflow) {
  const source = workflow?.patternTags?.length ? workflow.patternTags : workflow?.tags || [];
  return [...new Set(source.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))];
}

function severityOf(event) {
  if (event.kind === 'error' || event.kind === 'result' && /fail|cancel/i.test(event.message || '')) return 'error';
  if (event.kind === 'decision' || event.kind === 'replan') return 'warn';
  return 'info';
}

function retriesUsed(run) {
  return (run.steps || []).reduce((total, step) => total + Math.max(0, Number(step.attempts || 0) - 1), 0);
}

function workflowAnalytics(workflow, runs) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const workflowRuns = runs.filter((run) => run.workflowId === workflow.id);
  const recent = workflowRuns.filter((run) => new Date(run.createdAt || 0).getTime() >= cutoff);
  const considered = recent.filter((run) => ['passed', 'failed', 'needs_review', 'cancelled'].includes(run.status));
  const failures = recent.filter((run) => run.status === 'failed').length;
  const soft = considered.filter((run) => run.status === 'needs_review').length;
  const retries = considered.reduce((total, run) => total + Number(run.retryCount || 0), 0);
  const base = considered.length ? Math.round((100 * (failures + 0.5 * soft)) / considered.length) : 0;
  const penalty = considered.length ? Math.min(25, Math.round((100 * retries) / (considered.length * 3))) : 0;
  const latest = workflowRuns[0];
  return {
    totalFailures7d: failures,
    flakinessScore: Math.min(100, base + penalty),
    avgComplexity: Number(latest?.runComplexityScore || 0),
    latestErrorCode: latest?.lastErrorCode || '',
    latestErrorCategory: latest?.lastErrorCategory || latest?.errorCategory || '',
  };
}

export function knackRecords(d) {
  const workflowTags = new Map(d.workflows.map((workflow) => [workflow.id, tagsOf(workflow)]));
  const workflowStats = new Map(d.workflows.map((workflow) => [workflow.id, workflowAnalytics(workflow, d.runs)]));
  return {
    workflows: d.workflows.map((workflow) => ({
      workflow_id: workflow.id,
      name: workflow.name,
      description: workflow.description || '',
      status: workflow.status,
      failure_action: workflow.failurePolicy?.onFailure || 'stop',
      max_retries: Number(workflow.failurePolicy?.maxRetries || 0),
      capture_failure_screenshot: workflow.failurePolicy?.captureScreenshot !== false,
      retry_pause_ms: Number(workflow.failurePolicy?.pauseBeforeRetryMs || 0),
      pattern_tags: tagsOf(workflow).join(', '),
      labels: (workflow.tags || []).join(', '),
      total_failures_7d: workflowStats.get(workflow.id)?.totalFailures7d || 0,
      flakiness_score: workflowStats.get(workflow.id)?.flakinessScore || 0,
      avg_complexity_score: workflowStats.get(workflow.id)?.avgComplexity || 0,
      last_error_code: workflowStats.get(workflow.id)?.latestErrorCode || '',
      last_error_category: workflowStats.get(workflow.id)?.latestErrorCategory || '',
      updated_at: workflow.updatedAt || workflow.createdAt || '',
    })),
    steps: d.workflows.flatMap((workflow) =>
      (workflow.steps || []).map((step, index) => ({
        step_id: step.id,
        workflow_id: workflow.id,
        order: index + 1,
        type: step.type,
        name: step.name,
        params_json: JSON.stringify(step.params || {}),
        timeout_ms: Number(step.timeoutMs || 0),
        optional: Boolean(step.optional),
      }))
    ),
    runs: d.runs.map((run) => ({
      run_id: run.id,
      workflow_id: run.workflowId,
      workflow_name: run.workflowName,
      status: run.status,
      mode: run.dryRun ? 'dry' : 'live',
      trigger: run.trigger,
      agent_role_type: run.agentRole || 'operator',
      retry_count: Number(run.retryCount ?? retriesUsed(run)),
      last_error_code: run.lastErrorCode || '',
      last_error_category: run.lastErrorCategory || run.errorCategory || 'none',
      run_complexity_score: Number(run.runComplexityScore || 0),
      requires_advanced_planning: Boolean(run.requiresAdvancedPlanning),
      error_category: run.errorCategory || 'none',
      failure_signature: run.failureSignature || '',
      pattern_tags: (run.patternTags?.length ? run.patternTags : workflowTags.get(run.workflowId) || []).join(', '),
      matched_pattern_tags: (run.matchedPatternTags || []).join(', '),
      recovered: Boolean(run.recovered),
      evidence_count: (run.evidence || []).length,
      duration_ms: Number(run.durationMs || 0),
      started_at: run.startedAt || '',
      ended_at: run.endedAt || '',
      reviewed: run.review?.status === 'reviewed',
      analysis_summary: run.analysis?.summary || '',
      session_id: run.missionId || '',
    })),
    sessions: d.missions.map((mission) => ({
      session_id: mission.id,
      goal: mission.goal,
      workflow_id: mission.workflowId,
      workflow_name: mission.workflowName,
      status: mission.status,
      mode: mission.mode,
      attempts: mission.attempts,
      max_attempts: mission.maxAttempts,
      retry_count: Math.max(0, Number(mission.attempts || 0) - 1),
      verdict: mission.verification?.verdict || '',
      confidence: Math.round(Number(mission.verification?.confidence || 0) * 100),
      pattern_tags: (workflowTags.get(mission.workflowId) || []).join(', '),
      learned_pattern: mission.learnedPattern?.signature || '',
      reviewer_summary: mission.review?.summary || '',
      next_actions: (mission.review?.nextActions || []).join('\n'),
      started_at: mission.startedAt || '',
      ended_at: mission.endedAt || '',
    })),
    events: d.missions.flatMap((mission) =>
      (mission.events || []).map((event) => ({
        event_id: event.id,
        session_id: mission.id,
        agent: event.agent,
        kind: event.kind,
        severity: severityOf(event),
        message: event.message,
        run_id: event.runId || '',
        step_name: event.step || '',
        created_at: event.at,
      }))
    ),
  };
}

export function knackRecordsCsvs(d) {
  const records = knackRecords(d);
  const out = {};
  for (const [name, rows] of Object.entries(records)) {
    const columns = rows.length ? Object.keys(rows[0]) : [];
    out[name] = [
      columns.join(','),
      ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
    ].join('\n');
  }
  return out;
}
