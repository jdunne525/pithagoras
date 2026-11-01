import Database from "better-sqlite3";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const keep = [];

const open = (dir) => {
  const db = new Database(path.join(dir, "portal.db"));
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (a INTEGER)");
  keep.push(db);
  return db;
};

const deepRemove = (dir) => {
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (lstatSync(p).isDirectory()) walk(p);
      else unlinkSync(p);
    }
    rmSync(d, { recursive: false, force: false });
  };
  walk(dir);
};

process.on("exit", () => {
  for (const label of ["plain", "leaves-first"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "eperm-probe-"));
    open(dir);
    try {
      if (label === "plain") rmSync(dir, { recursive: true, force: true });
      else deepRemove(dir);
      console.log(label, "-> rm ok");
    } catch (e) {
      console.log(label, "-> failed:", e.code, e.syscall, e.path, e.message);
    }
  }
});
