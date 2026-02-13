const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);

console.log("Rebuilding users in:", dbPath);

db.exec("BEGIN");
try {
  db.exec("PRAGMA foreign_keys=OFF;");

  // rename old users
  db.exec("ALTER TABLE users RENAME TO users_old;");

  // new users table: email/password_hash NULL allowed
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,                -- NULL allowed
      password_hash TEXT,               -- NULL allowed
      role TEXT NOT NULL CHECK(role IN ('judoka','coach')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      card_code TEXT UNIQUE,
      profile_photo TEXT,
      jsa_number TEXT UNIQUE,
      claimed_at TEXT
    );
  `);

  const oldCols = new Set(db.prepare("PRAGMA table_info(users_old)").all().map(c => c.name));
  const pick = (col) => oldCols.has(col) ? col : "NULL";

  db.exec(`
    INSERT INTO users (id, name, email, password_hash, role, created_at, card_code, profile_photo, jsa_number, claimed_at)
    SELECT
      ${pick("id")},
      ${pick("name")},
      ${pick("email")},
      ${pick("password_hash")},
      ${pick("role")},
      ${pick("created_at")},
      ${pick("card_code")},
      ${pick("profile_photo")},
      ${pick("jsa_number")},
      ${pick("claimed_at")}
    FROM users_old;
  `);

  db.exec("DROP TABLE users_old;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("COMMIT");

  console.log("DONE. users rebuilt with nullable email/password_hash.");
} catch (e) {
  db.exec("ROLLBACK");
  console.error("FAILED:", e);
  process.exit(1);
}
