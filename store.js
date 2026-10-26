// Opslag van de complete spelstatus als één JSON-document.
// Met DATABASE_URL (Render Postgres) in de database, anders in data/state.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'state.json');
let pool = null;

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    await pool.query('CREATE TABLE IF NOT EXISTS dropping_state (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS dropping_photos (id TEXT PRIMARY KEY, data BYTEA NOT NULL, created TIMESTAMPTZ DEFAULT now())');
    const r = await pool.query("SELECT data FROM dropping_state WHERE id = 'game'");
    return r.rows[0] ? r.rows[0].data : null;
  }
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

let timer = null;
let pending = null;

// Schrijft hooguit eens per halve seconde weg.
function save(state) {
  pending = state;
  if (timer) return;
  timer = setTimeout(flush, 500);
}

async function flush() {
  timer = null;
  const data = pending;
  pending = null;
  if (!data) return;
  try {
    if (pool) {
      await pool.query(
        "INSERT INTO dropping_state (id, data, updated) VALUES ('game', $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, updated = now()",
        [data]
      );
    } else {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 1));
      fs.renameSync(FILE + '.tmp', FILE);
    }
  } catch (e) {
    console.error('Opslaan mislukt:', e.message);
  }
}

// Foto's staan los van de spelstatus, zodat die klein blijft.
const PHOTO_DIR = path.join(__dirname, 'data', 'photos');

async function savePhoto(id, buf) {
  if (pool) return pool.query('INSERT INTO dropping_photos (id, data) VALUES ($1, $2)', [id, buf]);
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTO_DIR, id + '.jpg'), buf);
}

async function getPhoto(id) {
  if (pool) {
    const r = await pool.query('SELECT data FROM dropping_photos WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  try { return fs.readFileSync(path.join(PHOTO_DIR, id + '.jpg')); } catch { return null; }
}

module.exports = { init, save, flush, savePhoto, getPhoto, usesDatabase: () => !!pool };
