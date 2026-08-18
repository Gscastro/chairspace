// db.js — database setup + seed data for ChairSpace
// Uses Postgres (via the `pg` package) so data survives restarts and
// redeploys — the old node:sqlite version stored everything in a local file,
// which Render's free tier wipes on every deploy and inactivity spin-down.
// A free Postgres database (e.g. neon.tech) fixes that: set DATABASE_URL in
// Render's Environment settings to the connection string it gives you.

const { Pool } = require('pg');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Create a free Postgres database (e.g. at neon.tech) and add its ' +
    'connection string as DATABASE_URL in Render\'s Environment settings.'
  );
}

// Neon (and most hosted Postgres) require SSL; a local database for
// development typically doesn't support it, so it's only turned on when the
// connection string isn't pointing at localhost.
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

// ---------- thin compatibility shim ----------
// The rest of this codebase was originally written against node:sqlite's
// synchronous db.prepare(sql).get/.all/.run(...) API. Rather than rewrite
// every call site's SQL, this shim keeps that exact call shape working
// against Postgres — the only mechanical change needed elsewhere is adding
// `await`, since every call is now async over the network instead of
// synchronous against a local file.
//
// `?` placeholders are converted to Postgres's `$1, $2, ...` style
// automatically (in source order, which always matches the params array
// order — the same assumption node:sqlite's `?` binding relied on). The one
// thing this shim does NOT do automatically is add `RETURNING id`: any
// INSERT that needs the new row's id back (in place of node:sqlite's
// `info.lastInsertRowid`) must include `RETURNING id` explicitly in its SQL
// text, since not every table has an `id` column (e.g. `sessions`, keyed by
// `token`) and guessing wrong would break those inserts.
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = toPgPlaceholders(sql);
  return {
    async get(...params) {
      const res = await pool.query(pgSql, params);
      return res.rows[0];
    },
    async all(...params) {
      const res = await pool.query(pgSql, params);
      return res.rows;
    },
    async run(...params) {
      const res = await pool.query(pgSql, params);
      const row = res.rows[0];
      return { lastInsertRowid: row ? row.id : undefined, changes: res.rowCount };
    },
  };
}

const db = { prepare };

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('barber','owner')),
    phone TEXT,
    bio TEXT,
    license_number TEXT,
    license_state TEXT,
    license_expiration TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listings (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT,
    address TEXT,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    zip TEXT,
    price REAL NOT NULL,
    price_unit TEXT NOT NULL CHECK(price_unit IN ('hour','day','week','month')),
    chair_type TEXT NOT NULL,
    photo_seed TEXT,
    photos TEXT,
    available_from TEXT,
    total_chairs INTEGER,
    cancellation_policy TEXT DEFAULT 'standard',
    lat REAL,
    lon REAL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id),
    barber_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
    start_date TEXT,
    end_date TEXT,
    message TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    sender_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inquiries (
    id SERIAL PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    social TEXT,
    message TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    listing_id INTEGER NOT NULL REFERENCES listings(id),
    created_at TEXT NOT NULL,
    UNIQUE(user_id, listing_id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    listing_id INTEGER NOT NULL REFERENCES listings(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    target_type TEXT NOT NULL CHECK(target_type IN ('listing','barber')),
    target_id INTEGER NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(request_id, author_id)
  );

  CREATE TABLE IF NOT EXISTS saved_searches (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    label TEXT,
    city TEXT,
    chair_type TEXT,
    price_unit TEXT,
    max_price REAL,
    created_at TEXT NOT NULL
  );
`;

// Postgres supports "ADD COLUMN IF NOT EXISTS" directly, so unlike the old
// SQLite version there's no need for a hand-rolled column-existence check —
// these are safe to run every time the server starts.
const MIGRATIONS_SQL = `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS license_number TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS license_state TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS license_expiration TEXT;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS lat REAL;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS lon REAL;
  ALTER TABLE listings ADD COLUMN IF NOT EXISTS cancellation_policy TEXT DEFAULT 'standard';
`;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function seedIfEmpty() {
  // COUNT(*) comes back from Postgres as a bigint, which the pg driver
  // returns as a string (not a number) to avoid precision loss — cast it to
  // a regular int so comparisons below behave as expected.
  const { count } = await db.prepare('SELECT COUNT(*)::int as count FROM users').get();
  if (count > 0) return;

  console.log('Seeding sample data...');

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, salt, role, phone, bio, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);

  async function makeUser(name, email, password, role, phone, bio) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const info = await insertUser.run(name, email, hash, salt, role, phone, bio, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  // Sample space owners
  const owner1 = await makeUser('Marcus at Fade District', 'marcus@fadedistrict.com', 'password123', 'owner', '512-555-0101', 'Owner of Fade District Barbershop in East Austin. Two open booths, great foot traffic.');
  const owner2 = await makeUser('Priya - Sharp & Co Suites', 'priya@sharpandco.com', 'password123', 'owner', '214-555-0110', 'We run private, suite-style rentals for barbers and stylists in Dallas.');
  const owner3 = await makeUser('Deja - The Clipper Room', 'deja@clipperroom.com', 'password123', 'owner', '713-555-0133', 'Established shop in Houston Heights looking for a reliable chair renter.');
  const owner4 = await makeUser('Tommy - Uptown Cuts', 'tommy@uptowncuts.com', 'password123', 'owner', '312-555-0147', 'Uptown Chicago shop, walk-in traffic plus loyal regulars.');

  // Sample barbers
  await makeUser('Jordan (barber, looking to rent)', 'jordan@example.com', 'password123', 'barber', '512-555-0199', '6 years cutting, specialize in fades and beard work. Bringing my own clients.');
  await makeUser('Alicia (barber, looking to rent)', 'alicia@example.com', 'password123', 'barber', '972-555-0177', 'Licensed barber, mobile-friendly, looking for a part-time chair.');

  const insertListing = db.prepare(`
    INSERT INTO listings (owner_id, title, description, address, city, state, zip, price, price_unit, chair_type, photo_seed, available_from, total_chairs, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  const now = new Date().toISOString();
  const d = (daysFromNow) => {
    const dt = new Date(now);
    dt.setDate(dt.getDate() + daysFromNow);
    return dt.toISOString().slice(0, 10);
  };
  const listings = [
    [owner1, 'Open Booth in East Austin Barbershop', 'One of two booths open in a busy 6-chair shop just off East 6th. Walk-ins all day, great parking, established brand.', '1420 E 6th St', 'Austin', 'TX', '78702', 275, 'week', 'Booth rent', 'austin1', null, 6],
    [owner1, 'Day Rate Chair - Weekends Only', 'Perfect for a barber who wants weekend overflow work. Same shop, pay by the day.', '1420 E 6th St', 'Austin', 'TX', '78702', 65, 'day', 'Chair rental', 'austin2', null, 6],
    [owner2, 'Private Suite - Sharp & Co', 'Fully private, lockable suite inside a boutique salon building. Bring your own clientele, set your own hours.', '2200 N Fitzhugh Ave', 'Dallas', 'TX', '75204', 950, 'month', 'Private suite', 'dallas1', d(14), 4],
    [owner3, 'Chair for Rent - The Clipper Room', 'Well-known shop in Houston Heights, been open 12 years. Looking for someone reliable, licensed 2+ years.', '540 W 19th St', 'Houston', 'TX', '77008', 220, 'week', 'Chair rental', 'houston1', null, 8],
    [owner3, 'Half Day Chair - Tue/Wed/Thu', 'Open half-day slots three days a week, great for a barber building a second location.', '540 W 19th St', 'Houston', 'TX', '77008', 40, 'day', 'Chair rental', 'houston2', d(3), 8],
    [owner4, 'Uptown Chicago Booth - High Traffic', 'Corner shop with huge storefront windows on a busy retail strip. One booth opening up.', '1180 N State St', 'Chicago', 'IL', '60610', 300, 'week', 'Booth rent', 'chicago1', d(30), 10],
    [owner4, 'Monthly Booth - Uptown Cuts', 'Same shop, discounted monthly rate for a longer commitment.', '1180 N State St', 'Chicago', 'IL', '60610', 1100, 'month', 'Booth rent', 'chicago2', null, 10],
    [owner2, 'Shared Station - Dallas Design District', 'Shared station in a modern, design-forward salon. Great for someone early in building a client base.', '150 Manufacturing St', 'Dallas', 'TX', '75207', 180, 'week', 'Shared station', 'dallas2', d(7), 4],
  ];

  for (const l of listings) {
    const [owner_id, title, description, address, city, state, zip, price, price_unit, chair_type, photo_seed, available_from, total_chairs] = l;
    await insertListing.run(owner_id, title, description, address, city, state, zip, price, price_unit, chair_type, photo_seed, available_from, total_chairs, now);
  }

  console.log('Seed complete: 4 owners, 2 barbers, 8 listings.');
  console.log('Sample login -> owner: marcus@fadedistrict.com / password123');
  console.log('Sample login -> barber: jordan@example.com / password123');
}

// server.js awaits this before calling server.listen(), so no request is
// ever served before the schema exists and (on a fresh database) sample data
// has been seeded.
const ready = (async () => {
  await pool.query(SCHEMA_SQL);
  await pool.query(MIGRATIONS_SQL);
  await seedIfEmpty();
})();

module.exports = { db, hashPassword, ready };
