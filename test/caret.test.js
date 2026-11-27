import test from 'node:test';
import assert from 'node:assert/strict';
import { caretIsIn, caretNote, chooseEditable, placeCaret, scoreEditable } from '../server/caret.js';

const WINDOW = 'Getting started - Kiro';

const inField = (extra = {}) => ({ found: true, editable: true, name: 'Ask Kiro', window: WINDOW, controlType: 'Edit', ...extra });

test('a caret only counts when it is editable and in the window the step names', () => {
  assert.equal(caretIsIn(inField(), WINDOW), true);
  assert.equal(caretIsIn(inField(), 'Kiro'), true, 'a partial window title still matches');
  assert.equal(caretIsIn(inField({ window: 'Untitled-1 - Kiro' }), WINDOW), false, 'another window is not the target');
  assert.equal(caretIsIn(inField({ editable: false }), WINDOW), false, 'a control that cannot take text is not a caret');
  assert.equal(caretIsIn({ found: false }, WINDOW), false);
  assert.equal(caretIsIn(null, WINDOW), false);
});

test('an editor document is not a text field, but a labelled one is', () => {
  const document = { name: 'Getting started - Kiro', controlType: 'Document', x: 900, y: 500, width: 1814, height: 1007 };
  const edit = { name: 'Terminal', controlType: 'Edit', x: 320, y: 910, width: 400, height: 26 };
  const chat = { name: 'Chat input', controlType: 'Document', x: 900, y: 820, width: 600, height: 60 };
  assert.equal(scoreEditable(document).confident, false, 'clicking the middle of an editor would type into the file');
  assert.equal(scoreEditable(edit).confident, true);
  assert.equal(scoreEditable(chat).confident, true, 'the label says where text goes');
  assert.equal(scoreEditable({ ...edit, readonly: true }), null);
  assert.equal(scoreEditable({ ...edit, offscreen: true }), null);
  assert.equal(scoreEditable({ ...edit, width: 11, height: 26 }), null, 'a stray 11px control is not a field');
  assert.equal(scoreEditable({ ...edit, controlType: 'Button' }), null);
});

test('the chat box wins over a full-pane document', () => {
  const best = chooseEditable(
    [
      { name: 'Untitled-1 - Kiro', controlType: 'Document', x: 900, y: 500, width: 1814, height: 1007 },
      { name: 'Ask Kiro', controlType: 'Edit', x: 900, y: 860, width: 700, height: 90 },
    ],
    { windowTop: 0, windowHeight: 1007 }
  );
  assert.equal(best.name, 'Ask Kiro');
  assert.equal(chooseEditable([{ name: 'Untitled-1 - Kiro', controlType: 'Document', x: 900, y: 500, width: 1814, height: 1007 }]), null);
});

test('a caret already in the field is left alone', async () => {
  let clicks = 0;
  const result = await placeCaret({
    step: { type: 'type', params: { text: 'hello' } },
    window: WINDOW,
    deps: {
      readFocused: async () => inField(),
      findControls: async () => assert.fail('no control list is needed'),
      clickAt: async () => {
        clicks += 1;
      },
      wait: async () => {},
    },
  });
  assert.equal(clicks, 0);
  assert.equal(result.already, true);
  assert.match(caretNote(result), /already in “Ask Kiro”/);
});

test('a named field is clicked, and the caret is confirmed after the click', async () => {
  const clicks = [];
  let reads = 0;
  const result = await placeCaret({
    step: { type: 'clipboard', params: { action: 'paste', field: 'Ask Kiro' } },
    window: WINDOW,
    deps: {
      readFocused: async () => (++reads === 1 ? { found: true, editable: false, window: WINDOW, name: 'editor' } : inField()),
      findNamed: async () => ({ found: false, reason: 'element not present' }),
      findNamedByOcr: async ({ name }) => ({ found: true, name, x: 812, y: 884 }),
      clickAt: async (x, y, name) => clicks.push({ x, y, name }),
      wait: async () => {},
    },
  });
  assert.deepEqual(clicks, [{ x: 812, y: 884, name: 'Ask Kiro' }]);
  assert.equal(result.placed, true);
  assert.equal(result.verified, true);
  assert.match(caretNote(result), /Clicked into “Ask Kiro” before typing and confirmed the caret/);
});

test('a named field that is nowhere is not guessed at', async () => {
  let clicks = 0;
  const result = await placeCaret({
    step: { type: 'type', params: { text: 'hi', field: 'Ask Kiro' } },
    window: WINDOW,
    deps: {
      readFocused: async () => ({ found: true, editable: false, window: WINDOW }),
      findNamed: async () => ({ found: false }),
      findNamedByOcr: async () => ({ found: false }),
      clickAt: async () => {
        clicks += 1;
      },
    },
  });
  assert.equal(clicks, 0);
  assert.equal(result.placed, false);
  assert.match(caretNote(result), /no control labelled “Ask Kiro” was found/);
});

test('a window with only an editor surface is not clicked', async () => {
  let clicks = 0;
  const result = await placeCaret({
    step: { type: 'type', params: { text: 'hi' } },
    window: WINDOW,
    deps: {
      readFocused: async () => ({ found: true, editable: false, window: WINDOW }),
      findControls: async () => ({
        found: true,
        windowTop: 0,
        windowHeight: 1007,
        controls: [{ name: 'Untitled-1 - Kiro', controlType: 'Document', x: 900, y: 500, width: 1814, height: 1007 }],
      }),
      clickAt: async () => {
        clicks += 1;
      },
    },
  });
  assert.equal(clicks, 0);
  assert.equal(result.placed, false);
  assert.match(caretNote(result), /none of the window’s controls is confidently a text field/);
});

test('a click that does not leave a caret says so instead of claiming success', async () => {
  const result = await placeCaret({
    step: { type: 'type', params: { text: 'hi' } },
    window: WINDOW,
    deps: {
      readFocused: async () => ({ found: true, editable: false, window: WINDOW, name: 'editor' }),
      findControls: async () => ({
        found: true,
        windowTop: 0,
        windowHeight: 1007,
        controls: [{ name: 'Ask Kiro', controlType: 'Edit', x: 900, y: 860, width: 700, height: 90 }],
      }),
      clickAt: async () => {},
      wait: async () => {},
    },
  });
  assert.equal(result.placed, true);
  assert.equal(result.verified, false);
  assert.match(caretNote(result), /the caret could not be confirmed/);
});

test('an app with no element tree stays quiet', async () => {
  const result = await placeCaret({
    step: { type: 'type', params: { text: 'hi' } },
    window: 'Sightline Profile',
    deps: {
      readFocused: async () => ({ found: false }),
      findControls: async () => ({ found: false, controls: [], reason: 'no editable control in the window' }),
    },
  });
  assert.equal(result.placed, false);
  assert.equal(caretNote(result), '', 'the old behaviour is not reported as a problem');
});
