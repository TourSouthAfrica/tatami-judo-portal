const Database = require("better-sqlite3");

const db = new Database("data.sqlite");

// 1) Drop the manual unique index
try {
  db.exec("DROP INDEX IF EXISTS idx_user_competition");
  console.log("Dropped index: idx_user_competition");
} catch (e) {
  console.log("Could not drop idx_user_competition:", e.message);
}

// 2) Rebuild table to remove sqlite_autoindex_* (table-level UNIQUE)
try {
  db.exec(`
    BEGIN;

    CREATE TABLE user_competitions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      competition_id INTEGER NOT NULL,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP,
      result_place TEXT,
      event_date TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(competition_id) REFERENCES competitions(id)
    );

    INSERT INTO user_competitions_new (id, user_id, competition_id, added_at, result_place, event_date)
    SELECT id, user_id, competition_id, added_at, result_place, event_date
    FROM user_competitions;

    DROP TABLE user_competitions;

    ALTER TABLE user_competitions_new RENAME TO user_competitions;

    COMMIT;
  `);

  console.log("Rebuilt user_competitions without UNIQUE constraint");
} catch (e) {
  console.log("Rebuild failed:", e.message);
  try { db.exec("ROLLBACK;"); } catch (_) {}
}

// 3) Show indexes after fix (verification)
const indexes = db
  .prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='user_competitions'"
  )
  .all();

console.log("Indexes now:", indexes);

db.close();
