import fs from 'node:fs';
import path from 'node:path';
import { DATA, db, now, resolveInside } from './store.js';

const PROTOCOL = 'sightline-visual-test/v1';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function configuredEndpoint() {
  const settings = db().settings || {};
  return String(process.env.SIGHTLINE_VISUAL_TESTER_URL || settings.visualTesterUrl || '').trim();
}

function configuredToken() {
  const settings = db().settings || {};
  return String(process.env.SIGHTLINE_VISUAL_TESTER_TOKEN || settings.visualTesterToken || '').trim();
}

export function visualTesterStatus() {
  const endpoint = configuredEndpoint();
  let valid = false;
  if (endpoint) {
    try {
      const parsed = new URL(endpoint);
      valid = /^https?:$/.test(parsed.protocol);
    } catch {
      valid = false;
    }
  }
  return {
    protocol: PROTOCOL,
    configured: Boolean(endpoint) && valid,
    enabled: db().settings?.visualTesterEnabled !== false,
    endpoint: endpoint || '',
    tokenConfigured: Boolean(configuredToken()),
    timeoutMs: Math.max(1000, Math.min(120000, Number(db().settings?.visualTesterTimeoutMs) || 25000)),
    message: endpoint && !valid
      ? 'Visual tester URL must be http:// or https://.'
      : endpoint
      ? 'Visual tester connection configured.'
      : 'No visual tester connected. Set Settings → Visual tester URL or SIGHTLINE_VISUAL_TESTER_URL.',
  };
}

function readImage(imagePath) {
  const resolved = resolveInside(DATA, imagePath);
  if (!resolved) throw new Error('Screenshot must be inside the Sightline data folder.');
  const buffer = fs.readFileSync(resolved);
  if (!buffer.length) throw new Error('Screenshot is empty.');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Screenshot is too large to send to the visual tester.');
  const ext = path.extname(resolved).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return { buffer, mime };
}

function toRows(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => {
      if (typeof item === 'string') return item.slice(0, 1000);
      if (!item || typeof item !== 'object') return null;
      return {
        label: String(item.label || item.name || item.text || '').slice(0, 300),
        detail: String(item.detail || item.reason || item.message || '').slice(0, 1000),
        step: Number.isFinite(Number(item.step ?? item.stepIndex)) ? Number(item.step ?? item.stepIndex) : null,
        confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
      };
    })
    .filter(Boolean);
}

function toAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 30)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const x = Number(item.x);
      const y = Number(item.y);
      const width = Number(item.width);
      const height = Number(item.height);
      if (![x, y, width, height].every(Number.isFinite)) return null;
      return {
        label: String(item.label || item.name || item.text || 'annotation').slice(0, 200),
        x,
        y,
        width,
        height,
        confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
        color: String(item.color || '').slice(0, 40),
      };
    })
    .filter(Boolean);
}

/**
 * Send one screenshot plus workflow context to an external visual tester.
 * The receiver may return findings, suggestions and normalized annotations.
 */
export async function testScreenshot({
  imagePath,
  caption = '',
  goal = '',
  workflow = null,
  proposal = null,
  step = null,
  expected = '',
  width = null,
  height = null,
  timeoutMs = null,
} = {}) {
  const status = visualTesterStatus();
  if (!status.configured) throw new Error(status.message);
  if (!status.enabled) throw new Error('The visual tester is disabled in Settings.');
  if (!imagePath) throw new Error('Pick a screenshot to test.');
  const { buffer, mime } = readImage(imagePath);
  const endpoint = status.endpoint;
  const token = configuredToken();
  const limit = Math.max(1000, Math.min(120000, Number(timeoutMs) || status.timeoutMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  const payload = {
    protocol: PROTOCOL,
    type: 'visual-test',
    at: now(),
    source: 'sightline',
    goal: String(goal || '').slice(0, 4000),
    expected: String(expected || '').slice(0, 2000),
    workflow: workflow
      ? {
          id: workflow.id,
          name: workflow.name,
          description: String(workflow.description || '').slice(0, 2000),
          steps: (workflow.steps || []).map((entry) => ({ type: entry.type, name: entry.name, params: entry.params })),
        }
      : null,
    proposal: proposal
      ? {
          id: proposal.id,
          confidence: proposal.confidence ?? null,
          stepCount: (proposal.steps || []).length,
          rejectedSteps: proposal.rejectedSteps || [],
          backups: (proposal.backups || []).map((backup) => backup.phase),
        }
      : null,
    step: step ? { type: step.type, name: step.name, params: step.params } : null,
    screenshot: {
      path: imagePath,
      caption: String(caption || '').slice(0, 300),
      mime,
      bytes: buffer.length,
      width: Number.isFinite(Number(width)) ? Number(width) : null,
      height: Number.isFinite(Number(height)) ? Number(height) : null,
      base64: buffer.toString('base64'),
    },
  };
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new Error(`Visual tester returned ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Visual tester returned non-JSON output.');
    return {
      ok: parsed.ok !== false,
      protocol: PROTOCOL,
      at: now(),
      imagePath,
      caption: payload.screenshot.caption,
      width: payload.screenshot.width,
      height: payload.screenshot.height,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
      summary: String(parsed.summary || parsed.message || '').slice(0, 1000),
      findings: toRows(parsed.findings),
      suggestions: toRows(parsed.suggestions),
      annotations: toAnnotations(parsed.annotations),
      received: parsed,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Visual tester timed out after ${Math.round(limit / 1000)}s.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function rememberVisualTest(proposal, result) {
  if (!proposal) return;
  if (!Array.isArray(proposal.visualTests)) proposal.visualTests = [];
  proposal.visualTests.unshift({
    at: result.at || now(),
    imagePath: result.imagePath,
    caption: result.caption,
    width: result.width || null,
    height: result.height || null,
    ok: result.ok,
    confidence: result.confidence,
    summary: result.summary,
    findings: result.findings,
    suggestions: result.suggestions,
    annotations: result.annotations,
  });
  proposal.visualTests = proposal.visualTests.slice(0, 20);
  if (!Array.isArray(proposal.tests)) proposal.tests = [];
  proposal.tests.push({
    kind: 'external-visual',
    status: result.ok ? 'passed' : 'needs_review',
    label: 'External screenshot tester',
    detail: result.summary || `${result.findings.length} finding(s), ${result.annotations.length} annotation(s).`,
  });
  proposal.tests = proposal.tests.slice(-20);
}
