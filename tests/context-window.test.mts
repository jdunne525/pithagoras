import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswer, parseWindow } from '../core/web/src/context-window.ts';

test('a typed window is read the way it is written, grouping and all', () => {
  assert.deepEqual(parseWindow('131072'), { kind: 'ok', tokens: 131072 });
  assert.deepEqual(parseWindow(' 131,072 '), { kind: 'ok', tokens: 131072 });
  assert.deepEqual(parseWindow('131.072'), { kind: 'ok', tokens: 131072 }, 'as it is written where the dot groups');
  assert.deepEqual(parseWindow('131_072'), { kind: 'ok', tokens: 131072 });
  assert.deepEqual(parseWindow('1 024'), { kind: 'ok', tokens: 1024 });
  assert.deepEqual(parseWindow('1,048,576'), { kind: 'ok', tokens: 1048576 });
});

test('a decimal is refused, not turned into a number ten times the size', () => {
  // These used to come out as 102400, 2621440 and 10245 — inside the range, so they were accepted.
  for (const bad of ['1,024.00', '262144.0', '1024.5', '12.5', '1.5', '131.07', '131.0720']) {
    assert.equal(parseWindow(bad).kind, 'bad', bad);
  }
});

test('grouping has to be the same separator all the way, in threes', () => {
  for (const bad of ['1,024.000', '1,24', '1,2345', ',131072', '131072,', '131,,072', '1 2 3']) {
    assert.equal(parseWindow(bad).kind, 'bad', bad);
  }
});

test('nothing typed is not an error, so an emptied field can go back to what it showed', () => {
  assert.deepEqual(parseWindow(''), { kind: 'empty' });
  assert.deepEqual(parseWindow('  '), { kind: 'empty' });
});

test('what the server would refuse is refused here, with the range in the message', () => {
  for (const bad of ['abc', '12.5', '1023', '0', '-5', '10000001', '99999999999']) {
    const r = parseWindow(bad);
    assert.equal(r.kind, 'bad', bad);
    assert.match((r as { message: string }).message, /1,024 to 10,000,000/);
  }
  assert.deepEqual(parseWindow('10000000'), { kind: 'ok', tokens: 10_000_000 });
});

// The answer's limit is the room one answer gets (pi's maxTokens). A chat whose compaction
// summary stops mid-way is given more of it, so the field is read by the same rule as a
// window: a decimal typed as grouping is a number ten times the size, and it fits.
test("an answer's limit is read the same way a window is", () => {
  assert.deepEqual(parseAnswer('16384'), { kind: 'ok', tokens: 16384 });
  assert.deepEqual(parseAnswer(' 16,384 '), { kind: 'ok', tokens: 16384 });
  assert.deepEqual(parseAnswer('16.384'), { kind: 'ok', tokens: 16384 }, 'as it is written where the dot groups');
  assert.deepEqual(parseAnswer('32_768'), { kind: 'ok', tokens: 32768 });
  assert.deepEqual(parseAnswer(''), { kind: 'empty' }, "emptied: pi's own 16k, not a number of 0");
});

test("a decimal is refused as an answer's limit too, not read as ten times the room", () => {
  for (const bad of ['16,384.00', '16384.0', '1638.5', '1.5', '16.38', '16.3840']) {
    assert.equal(parseAnswer(bad).kind, 'bad', bad);
  }
  for (const bad of ['16,384.000', '1,38', '1,3845', ',16384', '16384,', '1 6 3']) {
    assert.equal(parseAnswer(bad).kind, 'bad', bad);
  }
});

test("an answer's limit out of the range the server accepts is refused with its range", () => {
  // pi throws on a maxTokens of 0 when it builds the model, which takes a whole provider
  // away from every chat; 987 for a model answering in 16,384 would only truncate.
  for (const bad of ['abc', '0', '-5', '1023', '10000001', '99999999999']) {
    const r = parseAnswer(bad);
    assert.equal(r.kind, 'bad', bad);
    assert.match((r as { message: string }).message, /1,024 to 10,000,000/);
  }
  assert.deepEqual(parseAnswer('1024'), { kind: 'ok', tokens: 1024 });
  assert.deepEqual(parseAnswer('10000000'), { kind: 'ok', tokens: 10_000_000 });
});
