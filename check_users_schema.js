const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(__dirname, "data.sqlite"));

console.log("DB file:", path.join(__dirname, "data.sqlite"));
console.log(db.prepare("PRAGMA table_info(users)").all());
