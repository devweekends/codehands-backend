import { openDb, dbPath } from "./db.js";
const db = openDb();
console.log("db file:", dbPath());
console.log(db.prepare("select name from sqlite_master where type='table' order by name").all());
console.log(db.prepare("select * from schema_migrations").all());
