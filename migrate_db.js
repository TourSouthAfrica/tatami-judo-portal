const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const srcPath = path.join(__dirname, "data.sqlite");
const dstPath = path.join(__dirname, "data_new.sqlite");

if (!fs.existsSync(srcPath)) {
  console.error("Missing", srcPath);
  process.exit(1);
}
if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);

const src = new Database(srcPath, { readonly: true });
const dst = new Database(dstPath);

console.log("SRC:", srcPath);
console.log("DST:", dstPath);

// 1) Create schema in the NEW db (email/password_hash nullable)
dst.exec(`
PRAGMA foreign_keys=OFF;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT UNIQUE,                -- NULL allowed
  password_hash TEXT,               -- NULL allowed
  role TEXT NOT NULL CHECK(role IN ('judoka','coach')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  card_code TEXT UNIQUE,
  profile_photo TEXT,
  paid_until TEXT,
  jsa_number TEXT UNIQUE,
  claimed_at TEXT
);

CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  UNIQUE(class_id, session_date),
  FOREIGN KEY (class_id) REFERENCES classes(id)
);

CREATE TABLE attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  check_in_time TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'self',
  UNIQUE(session_id, user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE session_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE,
  coach_id INTEGER NOT NULL,
  notes TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (coach_id) REFERENCES users(id)
);

CREATE TABLE competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE user_competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  competition_id INTEGER NOT NULL,
  added_at TEXT,
  result_place TEXT,
  event_date TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id)
);

PRAGMA foreign_keys=ON;
`);

// 2) Helper: copy table if it exists in source
function hasTable(db, name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name);
}

function copyRows(table, cols) {
  const colList = cols.join(", ");
  const rows = src.prepare(`SELECT ${colList} FROM ${table}`).all();
  const placeholders = cols.map(() => "?").join(", ");
  const ins = dst.prepare(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`);
  const tx = dst.transaction(() => {
    for (const r of rows) ins.run(cols.map(c => r[c]));
  });
  tx();
  console.log(`Copied ${rows.length} rows -> ${table}`);
}

// 3) Copy in dependency order
if (hasTable(src, "users")) {
  // Copy whatever columns exist in old users
  const srcCols = src.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  const wanted = ["id","name","email","password_hash","role","created_at","card_code","profile_photo","paid_until","jsa_number","claimed_at"];
  const cols = wanted.filter(c => srcCols.includes(c));
  copyRows("users", cols);
}

if (hasTable(src, "classes")) copyRows("classes", ["id","name","day_of_week","start_time","end_time"]);
if (hasTable(src, "sessions")) copyRows("sessions", ["id","class_id","session_date"]);
if (hasTable(src, "attendance")) copyRows("attendance", ["id","session_id","user_id","check_in_time","method"]);
if (hasTable(src, "session_notes")) copyRows("session_notes", ["id","session_id","coach_id","notes","updated_at"]);
if (hasTable(src, "competitions")) copyRows("competitions", ["id","name"]);
if (hasTable(src, "user_competitions")) {
  // some older versions might call the PK user_competition_id; we use id now
  const cols = src.prepare("PRAGMA table_info(user_competitions)").all().map(c => c.name);
  const hasOldPk = cols.includes("user_competition_id");
  if (hasOldPk) {
    const rows = src.prepare(`
      SELECT user_competition_id AS id, user_id, competition_id, added_at, result_place, event_date
      FROM user_competitions
    `).all();
    const ins = dst.prepare(`
      INSERT INTO user_competitions (id, user_id, competition_id, added_at, result_place, event_date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    dst.transaction(() => rows.forEach(r => ins.run(r.id, r.user_id, r.competition_id, r.added_at, r.result_place, r.event_date)))();
    console.log(`Copied ${rows.length} rows -> user_competitions`);
  } else {
    copyRows("user_competitions", ["id","user_id","competition_id","added_at","result_place","event_date"]);
  }
}

src.close();
dst.close();

console.log("DONE. Created data_new.sqlite with nullable email/password_hash.");
console.log("NEXT: rename files (see instructions).");
