// The two compaction numbers as pi resolves them for one model, and as the
// chat's context card shows them.
//
// pi keeps the plain `compaction.keepRecentTokens` / `reserveTokens` for every
// chat and `compaction.modelOverrides["provider/model"]` for one model, falling
// back per field. A chat whose summary cannot be written in one answer is given
// room through its model — so the card has to know both numbers and whether what
// it shows is the model's own, before it tells a person to raise it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveKeepRecent,
  effectiveReserve,
  hasOwnKeepRecent,
  hasOwnReserve,
  modelKeyOf,
  roomOf,
} from '../core/web/src/compaction.ts';
import type { CompactionSettings } from '../core/web/src/api.ts';

const settings = (over: Partial<CompactionSettings> = {}): CompactionSettings => ({
  enabled: true,
  keepRecentTokens: 20_000,
  reserveTokens: 16_384,
  modelOverrides: {},
  ...over,
});

test('a model is named the way pi keys its own compaction numbers', () => {
  assert.equal(modelKeyOf('strata', 'qwen3.8-flash-next-coder-iq1_m'), 'strata/qwen3.8-flash-next-coder-iq1_m');
  // A model ID carrying a slash stays one key: pi's keys are exact, slashes included.
  assert.equal(modelKeyOf(' proxy ', ' deepseek/v4 '), 'proxy/deepseek/v4');
  assert.equal(modelKeyOf(undefined, 'x'), undefined, 'a chat that cannot name its model has no key');
  assert.equal(modelKeyOf('p', ''), undefined);
  assert.equal(modelKeyOf('', 'm'), undefined);
});

test('a model with no override of its own compacts on the plain numbers', () => {
  const c = settings();
  assert.equal(effectiveKeepRecent(c, 'strata/m'), 20_000);
  assert.equal(effectiveReserve(c, 'strata/m'), 16_384);
  assert.equal(hasOwnKeepRecent(c, 'strata/m'), false);
  assert.equal(hasOwnReserve(c, 'strata/m'), false);
  // No model named at all: the plain numbers, and nothing claims to be the model's own.
  assert.equal(effectiveKeepRecent(c), 20_000);
  assert.equal(hasOwnKeepRecent(c), false);
});

test('a model given its own numbers uses them, and the plain ones stay for every other model', () => {
  const c = settings({
    modelOverrides: { 'strata/big': { keepRecentTokens: 60_000, reserveTokens: 24_000 } },
  });
  assert.equal(effectiveKeepRecent(c, 'strata/big'), 60_000);
  assert.equal(effectiveReserve(c, 'strata/big'), 24_000);
  assert.equal(effectiveKeepRecent(c, 'strata/small'), 20_000, 'the plain number, untouched');
  assert.equal(effectiveReserve(c, 'strata/small'), 16_384);
});

test('each number falls back on its own: a model given only one of them keeps the plain other', () => {
  const c = settings({ modelOverrides: { 'strata/one': { reserveTokens: 400_000 } } });
  assert.equal(effectiveReserve(c, 'strata/one'), 400_000, 'a 1M model compacting above 600k');
  assert.equal(effectiveKeepRecent(c, 'strata/one'), 20_000, 'and the ordinary recent tokens');
  assert.equal(hasOwnReserve(c, 'strata/one'), true);
  assert.equal(hasOwnKeepRecent(c, 'strata/one'), false, 'the card says so on the field that is inherited');

  const keepOnly = settings({ modelOverrides: { 'strata/one': { keepRecentTokens: 40_000 } } });
  assert.equal(effectiveKeepRecent(keepOnly, 'strata/one'), 40_000);
  assert.equal(effectiveReserve(keepOnly, 'strata/one'), 16_384);
});

test('the card reads both numbers and which of them are the model’s own from one read of the file', () => {
  const c = settings({
    keepRecentTokens: 20_000,
    reserveTokens: 16_384,
    modelOverrides: { 'strata/big': { keepRecentTokens: 60_000 } },
  });
  assert.deepEqual(roomOf(c, 'strata/big'), {
    keepRecent: 60_000,
    keepFree: 16_384,
    ownRecent: true,
    ownFree: false,
  });
  assert.deepEqual(roomOf(c, 'other/m'), {
    keepRecent: 20_000,
    keepFree: 16_384,
    ownRecent: false,
    ownFree: false,
  });
});

// A page kept by the browser can meet a portal older than it — one taken back a
// version, restarted mid-upgrade — whose answer has no reserve in it, and a
// hand-edited pi file can carry a number pi would not read. A card drawing such
// a value on a slider draws it on NaN, so what the read does not give is shown
// as what pi itself gives every chat.
test("a read with no reserve in it is drawn as pi's own number, not as a blank slider", () => {
  const older = { enabled: true, keepRecentTokens: 40_000 } as unknown as CompactionSettings;
  assert.equal(effectiveReserve(older, 'strata/m'), 16_384);
  assert.deepEqual(roomOf(older, 'strata/m'), {
    keepRecent: 40_000,
    keepFree: 16_384,
    ownRecent: false,
    ownFree: false,
  });

  const broken = settings({
    keepRecentTokens: 0,
    reserveTokens: Number.NaN,
    modelOverrides: { 'strata/m': { keepRecentTokens: -5, reserveTokens: 1.5 } },
  });
  assert.equal(effectiveKeepRecent(broken, 'strata/m'), 20_000, "a number pi could not read is not a size");
  assert.equal(effectiveReserve(broken, 'strata/m'), 16_384);
  assert.equal(effectiveKeepRecent(broken), 20_000, "and the plain fields fall back the same way");
  assert.equal(effectiveReserve(broken), 16_384);
});
