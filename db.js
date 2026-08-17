// db.js — database setup + seed data for ChairSpace
// Uses Node's built-in node:sqlite (experimental, Node 22.5+). No external deps.

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'chairspace.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('barber','owner')),
    phone TEXT,
    bio TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
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
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL,
    barber_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
    start_date TEXT,
    end_date TEXT,
    message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(listing_id) REFERENCES listings(id),
    FOREIGN KEY(barber_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(request_id) REFERENCES requests(id),
    FOREIGN KEY(sender_id) REFERENCES users(id)
  );
`);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (count > 0) return;

  console.log('Seeding sample data...');

  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, salt, role, phone, bio, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function makeUser(name, email, password, role, phone, bio) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const info = insertUser.run(name, email, hash, salt, role, phone, bio, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  // Sample space owners
  const owner1 = makeUser('Marcus at Fade District', 'marcus@fadedistrict.com', 'password123', 'owner', '512-555-0101', 'Owner of Fade District Barbershop in East Austin. Two open booths, great foot traffic.');
  const owner2 = makeUser('Priya - Sharp & Co Suites', 'priya@sharpandco.com', 'password123', 'owner', '214-555-0110', 'We run private, suite-style rentals for barbers and stylists in Dallas.');
  const owner3 = makeUser('Deja - The Clipper Room', 'deja@clipperroom.com', 'password123', 'owner', '713-555-0133', 'Established shop in Houston Heights looking for a reliable chair renter.');
  const owner4 = makeUser('Tommy - Uptown Cuts', 'tommy@uptowncuts.com', 'password123', 'owner', '312-555-0147', 'Uptown Chicago shop, walk-in traffic plus loyal regulars.');

  // Sample barbers
  makeUser('Jordan (barber, looking to rent)', 'jordan@example.com', 'password123', 'barber', '512-555-0199', '6 years cutting, specialize in fades and beard work. Bringing my own clients.');
  makeUser('Alicia (barber, looking to rent)', 'alicia@example.com', 'password123', 'barber', '972-555-0177', 'Licensed barber, mobile-friendly, looking for a part-time chair.');

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
    insertListing.run(owner_id, title, description, address, city, state, zip, price, price_unit, chair_type, photo_seed, available_from, total_chairs, now);
  }

  console.log('Seed complete: 4 owners, 2 barbers, 8 listings.');
  console.log('Sample login -> owner: marcus@fadedistrict.com / password123');
  console.log('Sample login -> barber: jordan@example.com / password123');
}

seedIfEmpty();

module.exports = { db, hashPassword };
