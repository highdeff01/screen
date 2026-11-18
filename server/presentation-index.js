import { db, persist } from './store.js';
import { getRetryBudget } from './retry-budget.js';

const VECTOR_SIZE = 32;
const SEMANTIC_SIZE = 64;
const QUALITY_VERSION = 3;
const STOP = new Set([
  'the', 'and', 'then', 'with', 'into', 'from', 'for', 'this', 'that', 'what', 'when', 'where', 'while',
  'about', 'after', 'before', 'using', 'use', 'your', 'you', 'its', 'it', 'is', 'are', 'a', 'an', 'to',
  'of', 'in', 'on', 'or', 'as', 'by', 'be', 'can', 'should', 'was', 'were', 'has', 'have', 'had', 'will',
  'would', 'could', 'not', 'but', 'all', 'any', 'our', 'their', 'they', 'them', 'we', 'us', 'i',
]);

const CONCEPTS = {
  fix: ['repair', 'failing', 'failure', 'broken', 'blocker', 'troubleshoot', 'retry'],
  repair: ['fix', 'failing', 'failure', 'broken', 'blocker', 'troubleshoot', 'retry'],
  fail: ['fix', 'repair', 'failure', 'broken', 'blocker', 'troubleshoot', 'retry'],
  failure: ['fix', 'repair', 'failing', 'broken', 'blocker', 'troubleshoot', 'retry'],
  broken: ['fix', 'repair', 'failing', 'failure', 'blocker', 'troubleshoot'],
  blocked: ['fix', 'repair', 'failure', 'blocker', 'troubleshoot'],
  blocker: ['fix', 'repair', 'failure', 'blocked', 'troubleshoot'],
  troubleshoot: ['fix', 'repair', 'failure', 'blocked', 'diagnose', 'debug'],
  diagnose: ['troubleshoot', 'failure', 'debug', 'inspect', 'verify'],
  verify: ['check', 'evidence', 'screenshot', 'observation', 'confidence', 'validate'],
  check: ['verify', 'evidence', 'screenshot', 'observation', 'inspect'],
  evidence: ['proof', 'screenshot', 'observation', 'mark', 'visual', 'verify'],
  screenshot: ['capture', 'image', 'visual', 'evidence', 'mark'],
  capture: ['screenshot', 'image', 'visual', 'evidence'],
  visual: ['screenshot', 'image', 'mark', 'vision', 'evidence'],
  note: ['summary', 'explain', 'describe', 'walkthrough'],
  how: ['walkthrough', 'guide', 'step', 'tutorial', 'instructions'],
  guide: ['walkthrough', 'how', 'step', 'tutorial', 'instructions'],
  step: ['walkthrough', 'guide', 'sequence', 'workflow', 'next'],
  workflow: ['sequence', 'steps', 'automation', 'process', 'run'],
  automation: ['workflow', 'steps', 'run', 'script', 'agent'],
  agent: ['automation', 'review', 'watch', 'assistant', 'model'],
  watch: ['monitor', 'review', 'agent', 'observe'],
  review: ['audit', 'inspect', 'verify', 'quality', 'agent'],
  audit: ['review', 'inspect', 'verify', 'evidence', 'quality'],
  quality: ['score', 'confidence', 'evidence', 'reliability', 'trust'],
  retry: ['again', 'rerun', 'repeat', 'recheck', 'attempt'],
  rerun: ['retry', 'again', 'repeat', 'recheck'],
  recheck: ['retry', 'verify', 'again', 'repeat', 'evidence'],
  ai: ['model', 'agent', 'assistant', 'llm'],
  model: ['ai', 'agent', 'assistant', 'llm'],
  media: ['image', 'video', 'photo', 'picture', 'file'],
  image: ['media', 'photo', 'picture', 'screenshot', 'visual'],
  video: ['media', 'image', 'movie', 'clip', 'frame'],
  download: ['save', 'export', 'file', 'media'],
  export: ['download', 'save', 'file', 'markdown', 'html'],
  proposal: ['plan', 'repair', 'suggest', 'approve', 'patch'],
  suggest: ['proposal', 'recommend', 'improve', 'advice'],
  lineage: ['parent', 'graph', 'history', 'version', 'family'],
  graph: ['lineage', 'parent', 'history', 'version', 'nodes'],
  budget: ['limit', 'retry', 'pause', 'circuit', 'threshold'],
  pause: ['stop', 'hold', 'budget', 'retry'],
};

function text(value, max = 4000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokenize(value) {
  return text(value, 12000)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP.has(token))
    .slice(0, 500);
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => Math.round((item / magnitude) * 1000) / 1000);
}

/** Stable, compact bag-of-words vector. It is deterministic and needs no model. */
export function buildVector(value) {
  const vector = new Array(VECTOR_SIZE).fill(0);
  for (const token of tokenize(value)) vector[hashToken(token) % VECTOR_SIZE] += 1;
  return normalizeVector(vector);
}

/** Local semantic-ish vector: token hashes plus bigrams and synonym-concept expansion. */
export function buildSemanticVector(value) {
  const vector = new Array(SEMANTIC_SIZE).fill(0);
  const tokens = tokenize(value);
  tokens.forEach((token, index) => {
    vector[hashToken(token) % SEMANTIC_SIZE] += 1;
    if (tokens[index + 1]) vector[hashToken(`${token}:${tokens[index + 1]}`) % SEMANTIC_SIZE] += 0.55;
    for (const concept of CONCEPTS[token] || []) vector[hashToken(`concept:${concept}`) % SEMANTIC_SIZE] += 0.7;
    const stem = token.replace(/(ing|ed|es|s)$/, '');
    if (stem.length > 2) vector[hashToken(stem) % SEMANTIC_SIZE] += 0.45;
  });
  return normalizeVector(vector);
}

function confidencePercent(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence <= 0) return 0;
  return confidence <= 1 ? confidence * 100 : Math.min(100, confidence);
}

export function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += Number(left[index] || 0) * Number(right[index] || 0);
    a += Number(left[index] || 0) ** 2;
    b += Number(right[index] || 0) ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

function auditFor(deck) {
  if (deck?.audit) return deck.audit;
  const summary = deck?.auditSummary || {};
  return {
    verdict: summary.verdict,
    confidence: summary.confidence,
    summary: summary.summary,
    blockers: new Array(Number(summary.blockerCount || 0)).fill({ label: 'compacted blocker', detail: '' }),
    warnings: new Array(Number(summary.warningCount || 0)).fill({ label: 'compacted warning', detail: '' }),
    visual: {
      available: Boolean(summary.visualAvailable || summary.visual?.available),
      model: summary.visual?.model || null,
      summary: summary.visual?.summary || '',
      findings: Array.isArray(summary.visual?.findings) ? summary.visual.findings : [],
    },
    generatedAt: summary.generatedAt,
  };
}

export function deckText(deck) {
  const audit = auditFor(deck);
  const slides = (deck.slides || []).slice(0, 12).map((slide) => `${slide.kicker || ''} ${slide.title || ''} ${(slide.bullets || []).join(' ')}`);
  return [
    deck.title,
    deck.subtitle,
    deck.workflowName,
    deck.focus,
    ...(deck.profile?.classification || []),
    ...slides,
    audit.summary,
    ...(audit.blockers || []).map((item) => `${item.label} ${item.detail}`),
    ...(audit.warnings || []).map((item) => `${item.label} ${item.detail}`),
    ...(audit.suggestions || []).map((item) => `${item.title} ${item.detail}`),
    ...(audit.patterns || []).map((item) => `${item.workflowName} ${(item.hindrances || []).join(' ')}`),
    ...(audit.elements || []).slice(0, 24).map((item) => `${item.stepName} ${item.expected} ${item.status}`),
  ].filter(Boolean).join(' ');
}

export function classifyDeck(deck) {
  const audit = auditFor(deck);
  const focus = String(deck?.focus || 'auto');
  const classes = new Set(['flow-review']);
  if (focus === 'howto' || /walkthrough|how to|next step|operator/i.test(`${deck?.title || ''} ${deck?.subtitle || ''}`)) classes.add('how-to');
  if (focus === 'problem' || (audit.blockers || []).length || (audit.warnings || []).length) classes.add('troubleshooting');
  if (focus === 'suggestions' || (audit.suggestions || []).length) classes.add('strategy');
  if ((audit.patterns || []).length) classes.add('pattern-recall');
  if ((audit.agents || []).length) classes.add('agent-review');
  if ((audit.elements || []).some((element) => ['present', 'missing', 'unclear'].includes(element.status))) classes.add('visual-verification');
  else classes.add('evidence-review');
  if (audit.verdict === 'blocked') classes.add('blocked');
  if (audit.verdict === 'ready') classes.add('ready');
  if ((deck.rechecks || []).length) classes.add('retested');
  if (deck.lineage?.parentDeckId) classes.add('lineage');
  if (deck.proposalId || deck.autoProposalId) classes.add('repair-proposed');
  if (deck.compacted) classes.add('compacted');
  const quality = deck.compacted && deck.quality ? deck.quality : deckQuality(deck);
  if (quality.score >= 80) classes.add('high-quality');
  if (quality.score < 50) classes.add('low-quality');
  return [...classes];
}

export function deckQuality(deck) {
  const audit = auditFor(deck);
  const elements = audit.elements || [];
  const observed = elements.filter((element) => ['observed', 'present'].includes(element.status)).length;
  const evidenceCoverage = elements.length ? observed / elements.length : audit.visual?.available ? 0.55 : 0.2;
  const findings = (audit.visual?.findings || []);
  const reportedConfidence = findings
    .map((finding) => confidencePercent(finding.confidence))
    .filter((confidence) => confidence > 0);
  const visualConfidence = findings.length
    ? (reportedConfidence.length
        ? reportedConfidence.reduce((sum, confidence) => sum + confidence, 0) / reportedConfidence.length / 100
        : 0.6)
    : audit.visual?.available ? 0.6 : 0.25;
  const verdictBase = audit.verdict === 'ready' ? 1 : audit.verdict === 'review' ? 0.62 : audit.verdict === 'blocked' ? 0.22 : 0.4;
  const generatedAt = Date.parse(audit.generatedAt || deck.updatedAt || deck.createdAt || '');
  const ageHours = Number.isFinite(generatedAt) ? Math.max(0, (Date.now() - generatedAt) / 3600000) : 999;
  const freshness = Math.max(0, Math.min(1, 1 - ageHours / (24 * 7)));
  const rechecks = deck.rechecks || [];
  const improved = rechecks[0]?.comparison?.afterVerdict === 'ready' || Number(rechecks[0]?.comparison?.observedDelta || 0) > 0;
  const retest = !rechecks.length ? 0.45 : improved ? 1 : 0.3;
  const factors = {
    evidence: Math.round(evidenceCoverage * 100),
    visual: Math.round(visualConfidence * 100),
    verdict: Math.round(verdictBase * 100),
    freshness: Math.round(freshness * 100),
    retest: Math.round(retest * 100),
  };
  const score = Math.round(
    factors.evidence * 0.3 +
    factors.visual * 0.18 +
    factors.verdict * 0.28 +
    factors.freshness * 0.12 +
    factors.retest * 0.12
  );
  return {
    version: QUALITY_VERSION,
    score: Math.max(0, Math.min(100, score)),
    grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D',
    factors,
    reasons: [
      `${Math.round(evidenceCoverage * 100)}% element evidence`,
      `${audit.verdict || 'unknown'} verdict`,
      rechecks.length ? `${rechecks.length} re-test(s)` : 'not re-tested',
      `${Math.round(freshness * 100)}% freshness`,
    ],
  };
}

export function lineageOf(deck) {
  if (!deck) return null;
  const lineage = deck.lineage || {};
  return {
    rootDeckId: lineage.rootDeckId || deck.id,
    parentDeckId: lineage.parentDeckId || null,
    depth: Number(lineage.depth || 0),
    events: (lineage.events || []).slice(-8),
    eventCount: (lineage.events || []).length,
  };
}

export function ensureDeckProfile(deck, { persistChange = false } = {}) {
  if (!deck) return deck;
  const audit = auditFor(deck);
  const signature = [
    `quality-v${QUALITY_VERSION}`,
    deck.updatedAt || '',
    deck.createdAt || '',
    (deck.slides || []).length,
    audit.generatedAt || '',
    deck.review?.status || '',
    (deck.rechecks || []).length,
    deck.lineage?.events?.length || 0,
    deck.proposalId || '',
    deck.compacted ? 'c' : 'f',
  ].join('|');
  if (deck.profile?.signature === signature && Array.isArray(deck.profile.vector) && Array.isArray(deck.profile.semanticVector)) return deck;
  const classification = classifyDeck(deck);
  const searchable = deckText({ ...deck, profile: { classification } });
  deck.profile = {
    classification,
    vector: buildVector(searchable),
    semanticVector: buildSemanticVector(searchable),
    keywords: [...new Set(tokenize(searchable).slice(0, 40))].slice(0, 12),
    quality: deck.compacted && deck.quality?.version === QUALITY_VERSION ? deck.quality : deckQuality(deck),
    signature,
    indexedAt: new Date().toISOString(),
  };
  if (persistChange) persist();
  return deck;
}

export function presentationSummary(deck) {
  if (!deck) return null;
  ensureDeckProfile(deck);
  const audit = auditFor(deck);
  const recheck = deck.rechecks?.[0] || null;
  const lineage = lineageOf(deck);
  return {
    id: deck.id,
    workflowId: deck.workflowId,
    workflowName: deck.workflowName,
    missionId: deck.missionId || null,
    focus: deck.focus || 'auto',
    title: deck.title,
    subtitle: deck.subtitle,
    theme: deck.theme,
    model: deck.model,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt || null,
    durationSeconds: deck.durationSeconds,
    slideCount: (deck.slides || []).length,
    slides: (deck.slides || []).map((slide) => ({
      kicker: slide.kicker,
      title: slide.title,
      bullets: slide.bullets,
      note: deck.compacted ? '' : slide.note,
      image: slide.image && !deck.compacted
        ? {
            url: slide.image.url,
            caption: slide.image.caption,
            marks: slide.image.marks,
            width: slide.image.width,
            height: slide.image.height,
          }
        : null,
    })),
    profile: deck.profile,
    quality: deck.profile.quality,
    lineage,
    auditSummary: {
      verdict: audit.verdict || 'unknown',
      confidence: audit.confidence ?? null,
      summary: audit.summary || '',
      blockerCount: (audit.blockers || []).length,
      warningCount: (audit.warnings || []).length,
      visualAvailable: Boolean(audit.visual?.available),
      visual: {
        available: Boolean(audit.visual?.available),
        model: audit.visual?.model || null,
        summary: text(audit.visual?.summary, 500),
        findings: (audit.visual?.findings || []).slice(0, 16).map((finding) => ({
          index: finding.index,
          status: finding.status,
          detail: text(finding.detail, 180),
          confidence: finding.confidence ?? null,
        })),
      },
      generatedAt: audit.generatedAt || null,
    },
    review: deck.review || { status: 'unreviewed', comment: '', at: null },
    proposalId: deck.proposalId || null,
    autoProposalId: deck.autoProposalId || null,
    control: deck.control || { paused: false, manual: false, reason: null, at: null },
    attempts: deck.attempts || { consecutive: 0, total: 0, maxFailedAttempts: 3, lastAt: null, lastStatus: null },
    retryBudget: getRetryBudget(deck.workflowId),
    watch: deck.watch || null,
    lastRecheck: recheck
      ? {
          id: recheck.id,
          at: recheck.at,
          runId: recheck.runId,
          summary: recheck.comparison?.summary || '',
          beforeVerdict: recheck.comparison?.beforeVerdict || null,
          afterVerdict: recheck.comparison?.afterVerdict || null,
          screenshots: recheck.comparison?.screenshots || null,
        }
      : null,
    compacted: Boolean(deck.compacted),
    auditLoaded: false,
  };
}

export function listPresentationSummaries(workflowId = '', limit = 30) {
  return (db().presentations || [])
    .filter((deck) => !workflowId || deck.workflowId === workflowId)
    .slice(0, Math.max(1, Math.min(60, Number(limit) || 30)))
    .map(presentationSummary);
}

export function getPresentationDeck(id) {
  const deck = (db().presentations || []).find((entry) => entry.id === id);
  if (!deck) return null;
  ensureDeckProfile(deck, { persistChange: true });
  return { ...deck, auditLoaded: Boolean(deck.audit), profile: deck.profile, quality: deck.profile.quality, lineage: lineageOf(deck), retryBudget: getRetryBudget(deck.workflowId) };
}

export function presentationGraph({ workflowId = '' } = {}) {
  const decks = (db().presentations || []).filter((deck) => !workflowId || deck.workflowId === workflowId);
  const nodes = [];
  const edges = [];
  const known = new Set();
  const knownEdges = new Set();
  const addEdge = (edge) => {
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    if (knownEdges.has(key)) return;
    knownEdges.add(key);
    edges.push(edge);
  };
  const addNode = (node) => {
    if (!node?.id || known.has(node.id)) return;
    known.add(node.id);
    nodes.push(node);
  };
  for (const deck of decks) {
    const summary = presentationSummary(deck);
    addNode({
      id: deck.id,
      kind: 'deck',
      label: deck.title || deck.workflowName || deck.id,
      workflowId: deck.workflowId,
      verdict: summary.auditSummary.verdict,
      quality: summary.quality?.score ?? null,
      compacted: Boolean(deck.compacted),
      createdAt: deck.createdAt,
    });
    if (summary.lineage.parentDeckId) addEdge({ from: summary.lineage.parentDeckId, to: deck.id, type: 'next-deck' });
    if (deck.proposalId) {
      addNode({ id: deck.proposalId, kind: 'proposal', label: `Repair proposal ${deck.proposalId}`, verdict: null, createdAt: deck.updatedAt });
      addEdge({ from: deck.id, to: deck.proposalId, type: 'repair-proposal' });
    }
    for (const event of summary.lineage.events) {
      if (event.proposalId) {
        addNode({ id: event.proposalId, kind: 'proposal', label: `Repair proposal ${event.proposalId}`, verdict: null, createdAt: event.at });
        addEdge({ from: deck.id, to: event.proposalId, type: 'repair-proposal' });
      }
      if (event.runId) {
        addNode({ id: event.runId, kind: 'run', label: `Re-test run ${event.runId}`, verdict: event.verdict || null, createdAt: event.at });
        addEdge({ from: deck.id, to: event.runId, type: 'recheck-run' });
      }
    }
  }
  return { nodes, edges, roots: nodes.filter((node) => node.kind === 'deck' && !edges.some((edge) => edge.to === node.id)).map((node) => node.id) };
}

export function searchPresentations({ query = '', workflowId = '', classification = '', limit = 12 } = {}) {
  const decks = (db().presentations || []).filter((deck) => !workflowId || deck.workflowId === workflowId);
  const queryVector = buildVector(query || '');
  const querySemantic = buildSemanticVector(query || '');
  const hasQuery = tokenize(query).length > 0;
  const scored = decks.map((deck) => {
    ensureDeckProfile(deck);
    const lexical = hasQuery ? cosine(queryVector, deck.profile.vector) : 0;
    const semantic = hasQuery ? cosine(querySemantic, deck.profile.semanticVector) : 0;
    const classBoost = classification && deck.profile.classification.includes(classification) ? 0.12 : 0;
    const score = hasQuery ? Math.min(1, Math.max(0, lexical * 0.35 + semantic * 0.65 + classBoost)) : 0;
    return { deck, score, lexical, semantic };
  });
  return scored
    .filter((entry) => !classification || entry.deck.profile.classification.includes(classification))
    .sort((a, b) => b.score - a.score || String(b.deck.updatedAt || b.deck.createdAt || '').localeCompare(String(a.deck.updatedAt || a.deck.createdAt || '')))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
    .map((entry) => ({
      ...presentationSummary(entry.deck),
      similarity: Math.round(entry.score * 1000) / 1000,
      similarityDetails: {
        lexical: Math.round(entry.lexical * 1000) / 1000,
        semantic: Math.round(entry.semantic * 1000) / 1000,
      },
    }));
}
