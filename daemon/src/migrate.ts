import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openDb } from "./db.js";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));

export function migrate(db = openDb()) {
  db.exec(`create table if not exists schema_migrations (
    version integer primary key,
    applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);

  const applied = new Set(
    (db.prepare("select version from schema_migrations").all() as { version: number }[]).map((r) => r.version)
  );
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

  let count = 0;
  for (const f of files) {
    const version = parseInt(f, 10);
    if (applied.has(version)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(dir, f), "utf8"));
      db.prepare("insert into schema_migrations (version) values (?)").run(version);
    })();
    console.log("applied", f);
    count++;
  }
  if (count === 0) console.log("nothing to do");
}
