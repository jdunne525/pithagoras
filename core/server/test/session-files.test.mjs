import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { scratch } from './server-harness.mjs';
import * as gateFs from "node:fs";
import gatePath from "node:path";
import gateOs from "node:os";
/**
 * Links are made to prove these tests, and Windows lets them be made only with a privilege the machine it
 * runs on commonly does not have: where they cannot be made, the tests proved with them are skipped.
 */
/** The sandbox's agents are users, and users are a POSIX thing: where the machine has none, the tests about them are skipped. */
const POSIX = process.platform !== "win32" && typeof process.getuid === "function";

const LINKS = (() => {
  const probe = gateFs.mkdtempSync(gatePath.join(gateOs.tmpdir(), "links-probe-"));
  try {
    gateFs.writeFileSync(gatePath.join(probe, "a-file"), "");
    gateFs.mkdirSync(gatePath.join(probe, "a-folder"));
    gateFs.symlinkSync(gatePath.join(probe, "a-file"), gatePath.join(probe, "file-link"));
    gateFs.symlinkSync(gatePath.join(probe, "a-folder"), gatePath.join(probe, "folder-link"), "junction");
    return true;
  } catch {
    return false;
  }
})();
/** A link, in the shape this machine makes one: a junction for a folder, where a link of a folder wants a privilege. */
function linkTo(target, link) {
  let kind = "file";
  try {
    if (gateFs.statSync(target).isDirectory()) kind = "junction";
  } catch {
    kind = "file";
  }
  try {
    gateFs.symlinkSync(target, link, kind);
  } catch (e) {
    if (e.code !== "EPERM") throw e;
    gateFs.symlinkSync(target, link);
  }
}

const { removeSessionFiles } = await import('../dist/session-files.js');

const root = () => scratch('session-files-');

test("a session's folder and the conversation in it are removed, and only that one", () => {
  const r = root();
  mkdirSync(path.join(r, 'abc123'));
  writeFileSync(path.join(r, 'abc123', '2026-09-19_x.jsonl'), '{}');
  mkdirSync(path.join(r, 'other'));
  writeFileSync(path.join(r, 'other', 'keep.jsonl'), '{}');
  assert.equal(removeSessionFiles(r, 'abc123'), true);
  assert.equal(existsSync(path.join(r, 'abc123')), false);
  assert.equal(existsSync(path.join(r, 'other', 'keep.jsonl')), true);
});

test('a session that never wrote anything is not an error', () => {
  const r = root();
  assert.equal(removeSessionFiles(r, 'never-started'), false);
});

test('nothing outside the root can be reached through an id', () => {
  const r = root(); const outside = root();
  writeFileSync(path.join(outside, 'precious'), 'x');
  for (const id of ['..', '.', '', '../' + path.basename(outside), 'a/b', 'a\\b', '/etc', 'x\0y', '.hidden']) {
    assert.throws(() => removeSessionFiles(r, id), /not a session id/, JSON.stringify(id));
  }
  assert.equal(existsSync(path.join(outside, 'precious')), true);
});

test('a link in the place of the folder is removed as a link, and what it pointed at stays', { skip: !LINKS && 'no links are made on this machine' }, () => {
  const r = root(); const outside = root();
  writeFileSync(path.join(outside, 'precious'), 'x');
  linkTo(outside, path.join(r, 'linked'));
  assert.equal(removeSessionFiles(r, 'linked'), true);
  assert.equal(existsSync(path.join(r, 'linked')), false);
  assert.equal(readFileSync(path.join(outside, 'precious'), 'utf8'), 'x');
});

test('only "not there" means nothing to do; a folder that cannot be looked at is an error', { skip: !POSIX && 'users, the modes and the owners a file has are a POSIX thing' }, () => {
  const r = root();
  assert.equal(removeSessionFiles(path.join(r, 'no-such-root'), 'abc'), false);
  // A root that is a file: the folder under it cannot be looked at, and that is not "absent".
  const file = path.join(r, 'a-file');
  writeFileSync(file, 'x');
  assert.throws(() => removeSessionFiles(file, 'abc'), /ENOTDIR/);
});
