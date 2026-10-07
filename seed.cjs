const Database = require("./node_modules/better-sqlite3");
const fs = require("fs");
const path = require("path");

const db = new Database("./data-seed/portal.db", { readonly: false });

const root = fs.realpathSync("./pws");
const projA = path.join(root, "projA");
console.log("root:", root);
console.log("projA:", projA);

db.exec("DELETE FROM events; DELETE FROM task_attempts; DELETE FROM tasks; DELETE FROM sessions;");

const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
const sidA = "sess_aaaaaaaa";
const sidB = "sess_bbbbbbbb";
const tA = "task_aaaaaaaaaa";
const tB = "task_bbbbbbbbbb";

db.prepare(
  `INSERT INTO sessions (id,title,workspace,executor,status,created_at,updated_at,kind)
   VALUES (?,?,?,?,?,?,?, 'agent')`
).run(sidA, "Session A", projA, "host", "completed", now, now);
db.prepare(
  `INSERT INTO sessions (id,title,workspace,executor,status,created_at,updated_at,kind)
   VALUES (?,?,?,?,?,?,?, 'agent')`
).run(sidB, "Session B", projA, "host", "completed", now, now);

db.prepare(
  `INSERT INTO tasks (id,workspace,title,description,status,attempts,max_attempts,position,created_at,started_at,completed_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
).run(tA, projA, "Alpha task", "Do alpha work", "completed", 1, null, 0, now, now, now, now);
db.prepare(
  `INSERT INTO tasks (id,workspace,title,description,status,attempts,max_attempts,position,created_at,started_at,completed_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
).run(tB, projA, "Beta task", "Do beta work", "completed", 1, null, 0, now, now, now, now);

db.prepare(
  `INSERT INTO task_attempts (id,task_id,session_id,attempt_number,status,created_at,started_at,completed_at)
   VALUES (?,?,?,?,?,?,?,?)`
).run("att_a1", tA, sidA, 1, "completed", now, now, now);
db.prepare(
  `INSERT INTO task_attempts (id,task_id,session_id,attempt_number,status,created_at,started_at,completed_at)
   VALUES (?,?,?,?,?,?,?,?)`
).run("att_b1", tB, sidB, 1, "completed", now, now, now);

db.prepare(
  `INSERT INTO events (session_id,type,payload,created_at) VALUES (?,?,?,?)`
).run(sidA, "portal_prompt", JSON.stringify({ message: "ALPHA PROMPT unique marker 1111" }), now);
db.prepare(
  `INSERT INTO events (session_id,type,payload,created_at) VALUES (?,?,?,?)`
).run(sidB, "portal_prompt", JSON.stringify({ message: "BETA PROMPT unique marker 2222" }), now);

console.log("seeded OK");
db.close();
