// Deletes sessions (and their events) recorded from local dev playtests —
// anything whose referrer is a localhost/loopback host. Dry run by default:
//   node scripts/purge-localhost.js           # show what would be deleted
//   node scripts/purge-localhost.js --apply   # actually delete
// Point it at production with TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
import { db } from "../src/db.js";

const LOCAL = `(
  referrer IN ('localhost', '127.0.0.1', '0.0.0.0', '[::1]')
  OR referrer IN ('http://localhost', 'https://localhost')
  OR referrer LIKE 'http://localhost:%' OR referrer LIKE 'http://localhost/%'
  OR referrer LIKE 'https://localhost:%' OR referrer LIKE 'https://localhost/%'
  OR referrer IN ('http://127.0.0.1', 'https://127.0.0.1')
  OR referrer LIKE 'http://127.0.0.1:%' OR referrer LIKE 'http://127.0.0.1/%'
  OR referrer LIKE 'https://127.0.0.1:%' OR referrer LIKE 'https://127.0.0.1/%'
  OR referrer IN ('http://0.0.0.0', 'https://0.0.0.0')
  OR referrer LIKE 'http://0.0.0.0:%' OR referrer LIKE 'http://0.0.0.0/%'
  OR referrer LIKE 'https://0.0.0.0:%' OR referrer LIKE 'https://0.0.0.0/%'
  OR referrer IN ('http://[::1]', 'https://[::1]')
  OR referrer LIKE 'http://[::1]:%' OR referrer LIKE 'http://[::1]/%'
  OR referrer LIKE 'https://[::1]:%' OR referrer LIKE 'https://[::1]/%'
)`;

const { rows } = await db.execute(
  `SELECT referrer, COUNT(*) AS n FROM sessions WHERE ${LOCAL} GROUP BY referrer ORDER BY n DESC`
);
const [{ n: events }] = (
  await db.execute(
    `SELECT COUNT(*) AS n FROM events WHERE session_id IN (SELECT id FROM sessions WHERE ${LOCAL})`
  )
).rows;
console.table(rows.map((r) => ({ referrer: r[0], sessions: r[1] })));
console.log(`sessions: ${rows.reduce((a, r) => a + Number(r[1]), 0)}, events: ${events}`);

if (process.argv.includes("--apply")) {
  await db.batch(
    [
      `DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE ${LOCAL})`,
      `DELETE FROM sessions WHERE ${LOCAL}`,
    ],
    "write"
  );
  console.log("deleted.");
} else {
  console.log("dry run — pass --apply to delete.");
}
