// The portal's own lines that carry an unfinished turn on: what the transcript
// makes of them, and what the chat draws for them.
//
// A chat whose model stopped mid-answer is carried on by a line of the portal's
// ("Carry on where you left off…"), and a compaction that caught the run
// mid-turn is picked back up the same way. Left in the transcript as an ordinary
// message, three of those lines in a row read as the person having said the same
// sentence three times — what the gunner chats (aCSvv1KGQ9yf, GOsEdmK85mMO) came
// to look like. The line is recorded as the portal's, and drawn as one muted line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildTranscript, lastSaid, lastWaiting } from '../core/web/src/transcript.ts';
import { TranscriptRow } from '../core/web/src/components/TranscriptRow.tsx';
import { addLocale, setLanguage } from '../core/web/src/i18n.ts';

// tsx draws a component's JSX the classic way, which finds React as a global
// (the web build does not need this — see tests/translated-text.test.mts).
(globalThis as any).React = React;

const CARRY_ON = "Carry on where you left off. Your last answer was cut off at the model's output limit, mid-sentence, not at the end of the work.";
const PICK_UP = "Compaction detected, resume where you left off if needed.";
// What carries a turn that ended with only its thinking, no answer and no work
// asked for, back on (see core/server/test/silent-answer-run.test.mjs).
const NOTHING_SAID = "Carry on where you left off. Your last turn ended with only its thinking, no answer and no work asked for, which is not the end of the work.";

const cutOff = { seq: 4, type: 'portal_prompt', payload: { message: CARRY_ON, resume: 'cut-off' } };
const compact = { seq: 9, type: 'portal_prompt', payload: { message: PICK_UP, resume: 'compaction' } };
const quiet = { seq: 12, type: 'portal_prompt', payload: { message: NOTHING_SAID, resume: 'silent' } };
const said = { seq: 2, type: 'portal_prompt', payload: { message: 'Change the gunner enemies to fire in 3 round bursts' } };

const row = (item: any, over: Record<string, any> = {}) =>
  renderToStaticMarkup(
    createElement(TranscriptRow as any, {
      item,
      enter: '',
      mine: '',
      entering: false,
      running: false,
      editing: false,
      last: false,
      seqs: undefined,
      switching: false,
      sessionId: 's1',
      chat: undefined,
      mermaid: null,
      mermaidOptions: undefined,
      act: {
        openPicture: () => {}, edit: () => {}, cancelEdit: () => {}, saveEdit: async () => {},
        retry: () => {}, again: async () => {}, remove: async () => {}, dropQueued: async () => {},
        sendQueued: async () => {}, switchVersion: () => {}, trustFlagged: async () => true, isTrusted: () => false,
      },
      ...over,
    }),
  );

test('the transcript keeps whose line a carry-on is: the portal’s, not the person’s', () => {
  const items = buildTranscript([said, cutOff, compact] as any);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'user', 'user']);
  assert.equal((items[0] as any).resume, undefined, 'what the person said is not the portal’s line');
  assert.equal((items[1] as any).resume, 'cut-off');
  assert.equal((items[2] as any).resume, 'compaction');
});

test('a carry-on the portal never managed to send keeps it is, and says it did not go', () => {
  const items = buildTranscript([
    said,
    { seq: 4, type: 'portal_unsent', payload: { seqs: [4], prompts: { 4: { message: CARRY_ON, resume: 'cut-off' } } } },
  ] as any);
  assert.equal((items[1] as any).resume, 'cut-off', 'the line is still the portal’s');
  assert.equal((items[1] as any).unsent, 'stopped');
});

test('the chat draws a carry-on as one line saying the portal asked, not as the message again', () => {
  const [item] = buildTranscript([cutOff] as any);
  const html = row(item);
  assert.match(html, /The portal asked the agent to carry on where its answer was cut off/);
  assert.ok(!html.includes(CARRY_ON), 'the sentence itself is not on show, so three of them are not three messages');
  assert.ok(!html.includes('rounded-2xl'), 'no bubble: it is not a message of the person’s');

  const picked = row(buildTranscript([compact] as any)[0]);
  assert.match(picked, /The portal asked the agent to pick the turn back up after the compaction/);
});

// A turn that ended with only its thinking is carried on by a third line of the
// portal's. It is the portal asking, and drawn as one muted line like the other
// two; and where the record does not say whose it is, its sentence says it.
test('a carry-on of a turn that ended with nothing said is the portal’s line, and says which', () => {
  const items = buildTranscript([said, quiet] as any);
  assert.equal((items[0] as any).resume, undefined, 'what the person said is not the portal’s line');
  assert.equal((items[1] as any).resume, 'silent');

  const html = row(items[1]);
  assert.match(html, /The portal asked the agent to carry on after a turn that ended with only its thinking/);
  // The sentence is only the line's hover text; what is on show is one muted line.
  const shown = html.replace(/title="[^"]*"/g, "");
  assert.ok(!shown.includes(NOTHING_SAID), 'the sentence itself is not on show');
  assert.ok(!html.includes('rounded-2xl'), 'no bubble: it is not a message of the person’s');

  // Known by its sentence, the way the other two are, for a chat whose record
  // predates the marker.
  const plain = buildTranscript([{ seq: 12, type: 'portal_prompt', payload: { message: NOTHING_SAID } }] as any);
  assert.equal((plain[0] as any).resume, 'silent');

  // Not the line ↑ takes back for sending again.
  const waiting = buildTranscript([said, { seq: 12, type: 'portal_prompt', payload: { message: NOTHING_SAID, queued: true, resume: 'silent' } }] as any);
  assert.equal(lastWaiting(waiting), undefined, "the portal's line is not offered as the person's message");
  assert.equal(lastSaid(waiting)?.seq, 2, 'and the chat’s last thing said is still the person’s message');
});

test('a carry-on that never got there is said as not sent, the way a message of the person’s is', () => {
  const [item] = buildTranscript([
    { seq: 4, type: 'portal_unsent', payload: { seqs: [4], prompts: { 4: { message: CARRY_ON, resume: 'cut-off' } } } },
  ] as any);
  assert.match(row(item), /Not sent — the run was stopped before the agent took it in/);
});

test('a chat’s last thing said is the person’s message, never the portal’s carry-on', () => {
  const items = buildTranscript([said, cutOff] as any);
  assert.equal(lastSaid(items)?.seq, 2, 'the carry-on is the last entry, but the person’s message is the last thing said');

  // An ordinary chat: the last message that reached the agent, and not a waiting one.
  const many = buildTranscript([
    said,
    { seq: 6, type: 'portal_prompt', payload: { message: 'and the tests?', queued: true } },
  ] as any);
  assert.equal(lastSaid(many)?.seq, 2);
  assert.equal(lastSaid(buildTranscript([] as any)), undefined);
});

// ↑ in an empty box takes back the message that still waits for the agent. A
// carry-on of the portal's is not what is meant there: pulled into the composer
// and sent, it is the same sentence a second time — the repeated message a
// person reads as the chat answering itself.
test('a carry-on waiting to go in is not the line ↑ takes back for sending again', () => {
  const waitingPerson = buildTranscript([
    said,
    { seq: 6, type: 'portal_prompt', payload: { message: 'and the tests?', queued: true } },
  ] as any);
  assert.equal(lastWaiting(waitingPerson)?.seq, 6, "a person's own waiting message is taken back");

  const waitingCarryOn = buildTranscript([said, { seq: 4, type: 'portal_prompt', payload: { message: CARRY_ON, queued: true, resume: 'cut-off' } }] as any);
  assert.equal(lastWaiting(waitingCarryOn), undefined, "the portal's line is not offered as the person's message");

  // The person's waiting message behind it is still found.
  const both = buildTranscript([
    { seq: 4, type: 'portal_prompt', payload: { message: CARRY_ON, queued: true, resume: 'cut-off' } },
    { seq: 6, type: 'portal_prompt', payload: { message: 'and the tests?', queued: true } },
  ] as any);
  assert.equal(lastWaiting(both)?.seq, 6);
  assert.equal(lastWaiting(buildTranscript([] as any)), undefined);
});

test('the words are the page’s own: a German page says the carry-on in German', () => {
  addLocale({ code: 'xx', name: 'Test', strings: { "The portal asked the agent to carry on where its answer was cut off": "xx: carry" } });
  setLanguage('xx');
  try {
    assert.match(row(buildTranscript([cutOff] as any)[0]), /xx: carry/);
  } finally {
    setLanguage('system');
  }
});

// The chats that went through a compaction or a cut-off answer before the record
// said whose line a carry-on was (aCSvv1KGQ9yf, GOsEdmK85mMO and the rest) carry
// only the sentence. The transcript knows the sentences, so the history of those
// chats reads as what it is: the portal asking the agent to pick the turn back
// up — not the person having said the same thing four times in half a minute.
test('a carry-on recorded before the record said whose it was is known by its sentence', () => {
  const plain = { seq: 4, type: 'portal_prompt', payload: { message: CARRY_ON } };
  const pickUp = { seq: 8, type: 'portal_prompt', payload: { message: PICK_UP } };
  const items = buildTranscript([said, plain, pickUp] as any);
  assert.equal((items[1] as any).resume, 'cut-off');
  assert.equal((items[2] as any).resume, 'compaction');
  assert.match(row(items[1]), /The portal asked the agent to carry on where its answer was cut off/);
  assert.match(row(items[2]), /The portal asked the agent to pick the turn back up after the compaction/);
});

test('a prompt that quotes the sentence inside its own text is the person’s, and stays a message', () => {
  // A Task's prompt ends with a carry-on instruction of its own, verbatim. The
  // sentence is matched whole, which is what keeps this the person's line.
  const quoted = {
    seq: 3,
    type: 'portal_prompt',
    payload: { message: `Do the work.\n\nCarry on where you left off. Your last answer was cut off at the model's output limit, mid-sentence, not at the end of the work.` },
  };
  const [item] = buildTranscript([quoted] as any);
  assert.equal((item as any).resume, undefined);
  const html = row(item);
  assert.match(html, /Do the work/);
  assert.ok(!html.includes('The portal asked'), 'drawn as a message, not as the portal speaking for the work');
});

test("a person's own words that ask for the same thing are not the portal's line", () => {
  // The shape the recorded history has: a person's message about resuming work.
  const mine = {
    seq: 3,
    type: 'portal_prompt',
    payload: { message: 'I think this was conflicting with another Ai agent session which might have been causing confusion. Resume where you left off developing this plan.' },
  };
  const [item] = buildTranscript([mine] as any);
  assert.equal((item as any).resume, undefined);
});
