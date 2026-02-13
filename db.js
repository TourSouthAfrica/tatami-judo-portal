
const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(__dirname, "data.sqlite"));

console.log("USING DB PATH:", path.join(__dirname, "data.sqlite"));



db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('judoka','coach')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id INTEGER NOT NULL,
    session_date TEXT NOT NULL,
    UNIQUE(class_id, session_date),
    FOREIGN KEY (class_id) REFERENCES classes(id)
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    check_in_time TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'self',
    UNIQUE(session_id, user_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS session_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL UNIQUE,
    coach_id INTEGER NOT NULL,
    notes TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (coach_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS fight_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | reviewed
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS fight_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id INTEGER NOT NULL UNIQUE,
  coach_id INTEGER NOT NULL,
  feedback TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  FOREIGN KEY (upload_id) REFERENCES fight_uploads(id),
  FOREIGN KEY (coach_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS user_competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  competition_id INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE(user_id, competition_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (competition_id) REFERENCES competitions(id)
);


`);
try { db.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE user_competitions ADD COLUMN result_place TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE user_competitions ADD COLUMN event_date TEXT"); } catch (e) {}
// Allow multiple entries of the same competition (remove old unique index)
try { db.exec("DROP INDEX IF EXISTS idx_user_competition"); } catch (e) {}

try { db.exec("ALTER TABLE users ADD COLUMN card_code TEXT"); } catch (e) {}
try { db.exec("CREATE UNIQUE INDEX idx_users_card_code ON users(card_code)"); } catch (e) {}


try { db.exec("ALTER TABLE users ADD COLUMN jsa_number TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN claimed_at TEXT"); } catch (e) {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_jsa_number ON users(jsa_number)"); } catch (e) {}





const existing = db.prepare("SELECT COUNT(*) as c FROM classes").get();
if (existing.c === 0) {
  const ins = db.prepare(`
    INSERT INTO classes (name, day_of_week, start_time, end_time)
    VALUES (?, ?, ?, ?)
  `);

  // Kids (6–11)
  ins.run("Kids (6–11)", 1, "16:30", "17:30"); // Monday
  ins.run("Kids (6–11)", 3, "16:30", "17:30"); // Wednesday
  ins.run("Kids (6–11)", 5, "16:00", "17:00"); // Friday  (double-check end time)

  // Hobart Grove Centre (12+)
  ins.run("Hobart Grove (12+)", 1, "17:30", "19:00"); // Monday
  ins.run("Hobart Grove (12+)", 2, "18:00", "19:00"); // Tuesday
  ins.run("Hobart Grove (12+)", 3, "17:30", "19:00"); // Wednesday
  ins.run("Hobart Grove (12+)", 4, "18:00", "19:00"); // Thursday
  ins.run("Friday Fight Night (12+)", 5, "18:00", "19:00"); // Friday
}


module.exports = db;
