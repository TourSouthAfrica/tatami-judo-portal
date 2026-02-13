const Database = require("better-sqlite3");
const db = new Database("data.sqlite");

const rows = db
  .prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='user_competitions'"
  )
  .all();

console.log(rows);

