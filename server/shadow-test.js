const REQUIRED = {
  type: ['text', 'textVar'],
  launchApp: ['target'],
  openUrl: ['url'],
  focusWindow: ['title', 'windowName', 'windowTitle', 'window'],
  clickElement: ['name'],
  key: ['keys'],
  waitFor: ['window', 'title', 'text', 'value'],
  runTool: ['toolId'],
  useTool: ['toolId'],
};

function value(step, keys) {
  const params = step?.params || {};
  return keys.find((key) => {
    const item = params[key];
    return item !== undefined && item !== null && String(item).trim() !== '';
  });
}

function producedVariable(step) {
  if (!step) return '';
  if (step.type === 'clipboard') return String(step.params?.outputVar || step.params?.textVar || '').trim();
  if (['aiExtract', 'readNote', 'copyLink'].includes(step.type)) {
    return String(step.params?.outputVar || step.params?.textVar || 'extractedText').trim();
  }
  return '';
}

/**
 * Non-mutating plan test. It simulates variable/control preconditions without
 * touching the desktop, so a proposal can be checked before approval.
 */
export function shadowTestPlan({
  steps = [],
  preflight = [],
  confidence = null,
  screenshots = [],
  backups = [],
  lint = null,
} = {}) {
  const failures = [];
  const warnings = [];
  const produced = new Set();

  for (const [index, step] of (steps || []).entries()) {
    if (!step || !step.type) {
      failures.push({ index, name: `Step ${index + 1}`, reason: 'Step has no type.' });
      continue;
    }
    const params = step.params || {};
    if (step.type === 'writeTextFile') {
      const variable = String(params.textVar || '').trim();
      if (!params.text && !variable) {
        failures.push({ index, name: step.name, reason: 'writeTextFile needs text or textVar.' });
      } else if (variable && !produced.has(variable)) {
        failures.push({ index, name: step.name, reason: `writeTextFile reads “${variable}” before it is produced.` });
      }
    } else if (step.type === 'clipboard' && String(params.action || '').toLowerCase() === 'paste') {
      const variable = String(params.textVar || '').trim();
      if (variable && !produced.has(variable)) {
        failures.push({ index, name: step.name, reason: `Paste reads “${variable}” before it is produced.` });
      }
    } else if (step.type === 'clickElement' && !value(step, ['name']) && !(Number.isFinite(Number(params.x)) && Number.isFinite(Number(params.y)))) {
      failures.push({ index, name: step.name, reason: 'clickElement needs a visible control name or x/y.' });
    } else {
      const required = REQUIRED[step.type];
      if (required && !value(step, required)) {
        failures.push({ index, name: step.name, reason: `${step.type} is missing ${required.join(' or ')}.` });
      }
    }
    const output = producedVariable(step);
    if (output) produced.add(output);
    if (step.type === 'writeTextFile' && params.textVar) produced.add(String(params.textVar));
  }

  const lintErrors = (lint?.issues || []).filter(
    (issue) => issue.severity === 'error' && issue.code !== 'unrequested new-chat condition'
  );
  const checks = [
    { key: 'steps', ok: steps.length > 0, label: 'Plan has executable steps' },
    { key: 'parameters', ok: failures.length === 0, label: 'Every step has its required inputs' },
    { key: 'lint', ok: lintErrors.length === 0, label: 'No blocking lint errors' },
    {
      key: 'preflight',
      ok: (preflight || []).length === 0 || preflight.every((check) => check.ok),
      label: 'Phase and copy/write preflight checks pass',
    },
    {
      key: 'confidence',
      ok: confidence == null || Number(confidence) >= 0.7,
      label: 'Planner confidence is at least 70%',
    },
    {
      key: 'evidence',
      ok: (screenshots || []).length > 0,
      label: 'Screenshot evidence is available',
      warningOnly: true,
    },
    {
      key: 'backups',
      ok: (backups || []).length > 0,
      label: 'Backup phases are available',
      warningOnly: true,
    },
  ];
  for (const check of checks) {
    if (!check.ok && check.warningOnly) warnings.push(check.label);
  }
  const critical = checks.filter((check) => !check.warningOnly);
  const passed = checks.filter((check) => check.ok).length;
  const ok = critical.every((check) => check.ok);
  return {
    ok,
    status: ok ? 'passed' : 'failed',
    noDesktopInput: true,
    passed,
    total: checks.length,
    score: Math.round((passed / checks.length) * 100),
    checks,
    failures,
    warnings,
    testedAt: new Date().toISOString(),
  };
}