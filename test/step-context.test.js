import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessStep,
  buildMovePath,
  classifyWindow,
  decidePreview,
  describeSurroundings,
  expectationFor,
  launchProducedNewWindow,
  reviewPrevious,
  userTiming,
} from '../server/step-context.js';

const saveDialog = {
  foreground: { title: 'Save As', process: 'notepad', className: '#32770' },
  app: { title: 'Untitled - Notepad', process: 'notepad', className: 'Notepad' },
  windows: [
    { title: 'Untitled - Notepad', process: 'notepad', className: 'Notepad' },
    { title: 'Save As', process: 'notepad', className: '#32770' },
  ],
};

test('windows are classified with the actions a dialog offers', () => {
  const dialog = classifyWindow({ title: 'Save As', process: 'notepad', className: '#32770' });
  assert.equal(dialog.dialog, true);
  assert.equal(dialog.kind, 'save');
  assert.deepEqual(dialog.actions, ['Save', 'Cancel']);
  assert.match(dialog.hint, /file name/);
  const installer = classifyWindow({ title: 'VLC media player Setup', process: 'vlc-setup' });
  assert.equal(installer.kind, 'installer');
  assert.ok(installer.actions.includes('Install'));
  const app = classifyWindow({ title: 'Untitled - Notepad', process: 'notepad', className: 'Notepad' });
  assert.equal(app.dialog, false);
  assert.equal(classifyWindow({ title: 'Sale ads banner', process: 'chrome' }).advert, true);
});

test('a launch continues a dialog the flow is already in, but not a plain open window', () => {
  const dialog = assessStep({
    step: { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
    screen: saveDialog,
  });
  assert.equal(dialog.alreadySatisfied, true);
  assert.equal(dialog.inProgress, true);
  assert.match(dialog.skipReason, /already running with “Save As” open/);

  // An open document of the same app is not a reason to skip the launch: the
  // flow asked for a window, and the new one is where its typing belongs.
  const openDocument = assessStep({
    step: { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
    screen: { foreground: { title: 'notes.txt - Notepad', process: 'notepad' }, windows: [] },
  });
  assert.equal(openDocument.alreadySatisfied, false);
});

test('a launch that leaves an existing document in front did not open a window', () => {
  assert.equal(
    launchProducedNewWindow({ windows: ['knack convo.txt - Notepad'], after: 'knack convo.txt - Notepad' }),
    false,
    'the same title after a launch means nothing new was opened'
  );
  assert.equal(launchProducedNewWindow({ windows: ['knack convo.txt - Notepad'], after: 'Untitled - Notepad' }), true);
  assert.equal(launchProducedNewWindow({ windows: [], after: 'Untitled - Notepad' }), true);
  assert.equal(launchProducedNewWindow({ windows: ['x'], after: '' }), false);
});

test('an expectation is verified, never skipped for looking satisfied', () => {
  const assessment = assessStep({
    step: { type: 'expect', name: 'Window is present', params: { kind: 'window', value: 'Notepad' } },
    screen: { foreground: { title: 'notes.txt - Notepad', process: 'notepad' }, windows: [] },
  });
  assert.equal(assessment.alreadySatisfied, false);
  assert.equal(assessment.skipReason, '');
});

test('focus skips only for the exact window, not a title that contains it', () => {
  const loose = assessStep({
    step: { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } },
    screen: { foreground: { title: 'notes.txt - Notepad', process: 'notepad' }, windows: [] },
  });
  assert.equal(loose.alreadySatisfied, false);
  const exact = assessStep({
    step: { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'notes.txt - Notepad' } },
    screen: { foreground: { title: 'notes.txt - Notepad', process: 'notepad' }, windows: [] },
  });
  assert.equal(exact.alreadySatisfied, true);
});

test('clicking into an app while its dialog is open is retargeted at the dialog', () => {
  const assessment = assessStep({
    step: { type: 'clickElement', name: 'Open the File menu', params: { window: 'Untitled - Notepad', name: 'File' } },
    screen: saveDialog,
  });
  assert.equal(assessment.inProgress, true);
  assert.equal(assessment.adjustments.window, 'Save As');
  assert.match(assessment.note, /aimed there instead/);
  assert.match(assessment.risk, /dialog/);
});

test('typing after a Save dialog appears goes to the dialog, not the app behind it', () => {
  const assessment = assessStep({
    step: { type: 'type', name: 'Type the note', params: { text: 'hello', foreground: 'Untitled - Notepad' } },
    screen: saveDialog,
  });
  assert.equal(assessment.adjustments.foreground, 'Save As');
  assert.match(assessment.note, /Save As/);
});

test('a click on a control that lives in the open dialog is not a restart', () => {
  const assessment = assessStep({
    step: { type: 'clickElement', name: 'Save the file', params: { window: 'Untitled - Notepad', name: 'save' } },
    screen: saveDialog,
  });
  assert.equal(assessment.inProgress, true);
  assert.match(assessment.note, /already open and shows “Save”/);
});

test('a running installer is treated as the install already in progress', () => {
  const assessment = assessStep({
    step: { type: 'installApp', name: 'Install VLC', params: { app: 'VLC' } },
    screen: { foreground: { title: 'VLC media player Setup', process: 'vlc-3.0.24-win64' }, windows: [] },
  });
  assert.equal(assessment.alreadySatisfied, true);
  assert.equal(assessment.inProgress, true);
  assert.match(assessment.skipReason, /installer dialog for VLC is already open/);
});

test('focus and waits are satisfied by the window already in front', () => {
  const focus = assessStep({
    step: { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Untitled - Notepad' } },
    screen: saveDialog,
  });
  assert.equal(focus.alreadySatisfied, true);
  const wait = assessStep({
    step: { type: 'waitFor', name: 'Wait for the dialog', params: { kind: 'window', value: 'Save As' } },
    screen: saveDialog,
  });
  assert.equal(wait.alreadySatisfied, true);
});

test('a browser already showing the URL is not opened twice', () => {
  const assessment = assessStep({
    step: { type: 'openUrl', name: 'Open the VLC page', params: { url: 'https://www.videolan.org/vlc/download-windows.html' } },
    screen: {
      foreground: { title: 'Download official VLC media player for Windows - VideoLAN - Google Chrome', process: 'chrome' },
      windows: [],
    },
  });
  assert.equal(assessment.alreadySatisfied, true);
  assert.match(assessment.skipReason, /already shows/);
});

test('the previous step is reviewed against the screen', () => {
  const review = reviewPrevious({
    previous: { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
    screen: { foreground: { title: 'Paint', process: 'mspaint' }, windows: [] },
  });
  assert.equal(review.matches, false);
  assert.match(review.revisit, /may not have taken effect/);
  const dialogReview = reviewPrevious({
    previous: { type: 'clickElement', name: 'Save the note', params: { name: 'Save' } },
    screen: saveDialog,
  });
  assert.equal(dialogReview.matches, true);
  assert.equal(dialogReview.dialogOpen, true);
  assert.equal(dialogReview.dialogKind, 'save');
});

test('surroundings carry direction, distance and an advert warning', () => {
  const around = describeSurroundings({
    target: { x: 400, y: 300 },
    elements: [
      { name: 'File', x: 40, y: 300 },
      { name: 'Sponsored offer', x: 460, y: 350 },
      { name: 'Help', x: 400, y: 700 },
    ],
  });
  assert.equal(around.nearby[0].name, 'Sponsored offer');
  assert.match(around.nearby[0].direction, /right/);
  assert.equal(around.adverts.length, 1);
  assert.match(around.caution, /advert\/overlay/);
  assert.match(around.summary, /File/);
});

test('a pointer path passes through the waypoints before the target', () => {
  const points = buildMovePath({
    from: { x: 0, y: 0 },
    to: { x: 100, y: 100 },
    via: [{ x: 60, y: 10 }],
    steps: 3,
  });
  assert.ok(points.length >= 4);
  assert.deepEqual(points[2], { x: 60, y: 10 });
  assert.deepEqual(points[points.length - 1], { x: 100, y: 100 });
});

test('timing habits come from recorded gaps, not a fixed wait', () => {
  assert.deepEqual(userTiming([]), { samples: 0, settleMs: 800, moveStepMs: 40, confidence: 0 });
  const timing = userTiming([{ gapMs: 400 }, { gapMs: 1200 }, { gapMs: 800 }]);
  assert.equal(timing.samples, 3);
  assert.equal(timing.settleMs, 800);
  assert.ok(timing.confidence > 0);
});

test('a preview can skip, adjust or leave the planned click alone', () => {
  const skip = decidePreview({ preview: { alreadyDone: true, alreadyEvidence: 'the installer window is open' } });
  assert.equal(skip.skip, true);
  assert.match(skip.reason, /installer window/);

  const adjust = decidePreview({
    preview: { found: true, x: 640, y: 480, confidence: 0.9 },
    step: { params: { fallbackX: 100, fallbackY: 100 } },
  });
  assert.equal(adjust.apply, true);
  assert.equal(adjust.x, 640);

  const agreed = decidePreview({
    preview: { found: true, x: 104, y: 103, confidence: 0.9 },
    step: { params: { fallbackX: 100, fallbackY: 100 } },
  });
  assert.equal(agreed.apply, false);

  const unsure = decidePreview({ preview: { found: true, x: 640, y: 480, confidence: 0.2 } });
  assert.equal(unsure.apply, false);
  assert.match(unsure.reason, /not confident/);
});

test('every step type states the result it expects', () => {
  assert.match(expectationFor({ type: 'launchApp', params: { target: 'vlc.exe' } }), /vlc\.exe has a window/);
  assert.match(expectationFor({ type: 'type', params: {} }), /intended field/);
  assert.match(expectationFor({ type: 'installApp', params: { app: 'VLC' } }), /installed and verifiable/);
});

test('a preview that saw another window does not move the click', () => {
  const decision = decidePreview({
    preview: { found: true, x: 640, y: 480, confidence: 0.95, window: 'VideoLAN website' },
    step: { params: { window: 'Save As', fallbackX: 100, fallbackY: 100 } },
  });
  assert.equal(decision.apply, false);
  assert.match(decision.reason, /shows “VideoLAN website”/);
});

test('a dialog behind another window is still the step already in progress', () => {
  const screen = {
    foreground: { title: 'Freebuff: The free coding agent', process: 'Freebuff', className: 'Chrome_WidgetWin_1' },
    windows: [
      { title: 'Freebuff: The free coding agent', process: 'Freebuff', className: 'Chrome_WidgetWin_1' },
      { title: 'Untitled - Notepad', process: 'notepad', className: 'Notepad' },
      { title: 'Save As', process: 'notepad', className: '#32770' },
    ],
  };
  const assessment = assessStep({
    step: { type: 'type', name: 'Type the note', params: { text: 'hello', foreground: 'Untitled - Notepad' } },
    screen,
  });
  assert.equal(assessment.inProgress, true);
  assert.equal(assessment.adjustments.foreground, 'Save As');
  assert.equal(assessment.focus, 'Save As');
  assert.match(assessment.note, /open “Save As” dialog/);
  assert.deepEqual(assessment.state.dialogs, ['Save As']);
});
