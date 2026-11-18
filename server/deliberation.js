import { findUiElement } from './automation.js';

const norm = (value) =>
  String(value ?? '')
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function keysText(keys) {
  return (Array.isArray(keys) ? keys : [keys]).map((key) => String(key ?? '').trim()).join(' ');
}

function isClearKey(keys) {
  const text = keysText(keys).toLowerCase().replace(/\s+/g, '');
  return text === '^a' || text === 'ctrl+a' || text === 'control+a';
}

function isEnterKey(keys) {
  const text = keysText(keys).toLowerCase().replace(/\s+/g, '');
  return text === '{enter}' || text === 'enter' || text === 'return' || text === '{return}';
}

export function questionFromWorkflow(workflow, afterIndex = -1) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  for (let index = Math.max(0, afterIndex + 1); index < steps.length; index++) {
    const step = steps[index];
    const text = String(step?.params?.text || '').trim();
    if (step?.type === 'type' && text) return { index, text };
  }
  return null;
}

export function questionIsVisible(element, question) {
  if (!element?.found) return false;
  // A tab label or close button can contain the old question even while a
  // different chat is active. Only message/document text can prove the
  // question is in the visible conversation.
  if (/TabItem|Tab|Button|Menu|ToolBar/i.test(String(element.controlType || ''))) return false;
  const expected = norm(question);
  const actual = norm(element.name);
  if (!expected || !actual) return false;
  if (actual === expected || actual.includes(expected) || expected.includes(actual)) return true;
  const tokens = expected.split(' ').filter((token) => token.length > 2);
  if (!tokens.length) return false;
  const matched = tokens.filter((token) => actual.includes(token)).length;
  return matched / tokens.length >= 0.8;
}

/**
 * Decide whether a new-chat step should open a session or reuse the visible one.
 * Pure so the policy can be tested without Windows UI Automation.
 */
export function planChatReuse({
  workflow,
  newChatIndex,
  questionPresent = false,
  newMode = null,
  explicitNew = false,
  conditionMet = true,
}) {
  const question = questionFromWorkflow(workflow, newChatIndex);
  const requestedReuse = conditionMet === false || newMode === false;
  const autoReuse = newMode !== true && !explicitNew && questionPresent;
  const skipNewChat = requestedReuse || autoReuse;
  const skipIndices = [];
  if (skipNewChat && questionPresent && question) {
    for (let index = newChatIndex + 1; index < question.index; index++) {
      if (workflow.steps[index]?.type === 'key' && isClearKey(workflow.steps[index].params?.keys)) {
        skipIndices.push(index);
      }
    }
    skipIndices.push(question.index);
    const next = workflow.steps[question.index + 1];
    if (next?.type === 'key' && isEnterKey(next.params?.keys)) skipIndices.push(question.index + 1);
  }
  const reason = skipNewChat
    ? questionPresent && question
      ? `The current chat already shows “${question.text}”; reuse it and do not ask the same question again.`
      : 'Reuse the current chat because the mission does not ask for a new session.'
    : question
    ? `No visible match for “${question.text}”; a new chat is still needed.`
    : 'No chat question was found; keep the planned new-chat action.';
  return {
    skipNewChat,
    skipIndices,
    question: question?.text || '',
    questionIndex: question?.index ?? null,
    questionPresent: Boolean(questionPresent),
    reason,
  };
}

export function goalAsksForNewChat(goal) {
  return /\b(?:new|another|different|fresh)\s+(?:chat|session|conversation|topic)\b|\bdifferent topic\b|\bswitch topic\b/i.test(
    String(goal || '')
  );
}

/**
 * Between-step deliberation. It looks at the live UI when a step is about to
 * open a new chat, then records a skip plan for the redundant input sequence.
 */
export async function deliberateStep({ step, index, run, workflow, live, conditionMet = true }) {
  const mission = run?.missionId ? (await import('./store.js')).db().missions.find((entry) => entry.id === run.missionId) : null;
  const base = { action: 'run', reason: '', observation: '', at: new Date().toISOString() };

  if (step?.condition === 'newChat') {
    const target = String(step.params?.window || step.params?.title || '').trim();
    const explicitNew = mission?.conditions?.newChat === true || goalAsksForNewChat(mission?.goal);
    const question = questionFromWorkflow(workflow, index);
    let questionPresent = false;
    let observation = 'New chat requested; the operator explicitly asked for a fresh session.';
    if (!explicitNew && question && live && target) {
      try {
        const element = await findUiElement({
          window: target,
          name: question.text,
          controlType: 'Text|Document|ListItem',
        });
        questionPresent = questionIsVisible(element, question.text);
        observation = element.found
          ? `Visible UI text “${element.name}” ${questionPresent ? 'matches' : 'does not match'} the planned question.`
          : `No visible match for “${question.text}” in ${target}.`;
      } catch (err) {
        observation = `Could not inspect ${target}: ${err.message}`;
      }
    }
    const plan = planChatReuse({
      workflow,
      newChatIndex: index,
      questionPresent,
      newMode: mission?.conditions?.newChat ?? null,
      explicitNew,
      conditionMet,
    });
    if (plan.skipNewChat) {
      if (run) {
        if (!run.variables) run.variables = {};
        run.variables.__chatReuse = {
          question: plan.question,
          questionIndex: plan.questionIndex,
          skipIndices: plan.skipIndices,
          at: base.at,
        };
      }
      return { ...base, action: 'skip', reason: plan.reason, observation };
    }
    if (explicitNew) return { ...base, reason: 'Operator requested a new chat/session.' };
    return { ...base, reason: plan.reason, observation };
  }

  const reuse = run?.variables?.__chatReuse;
  if (reuse && Array.isArray(reuse.skipIndices) && reuse.skipIndices.includes(index)) {
    return {
      ...base,
      action: 'skip',
      reason: `The current chat already contains “${reuse.question}”; this step would ask it again.`,
    };
  }
  return base;
}
