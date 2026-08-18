// server.js — ChairSpace API + static server. Node built-ins only, plus a
// Postgres client (pg) for the database and plain HTTPS calls for Resend,
// Nominatim, and Cloudinary — no other npm dependencies.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, hashPassword, ready } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://chairspace.onrender.com';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- email notifications (Resend) ----------
// Fire-and-forget: never throws, never blocks the API response. Skips silently
// (just logs) if RESEND_API_KEY isn't set yet, so this is safe to deploy before
// the key is configured.
function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to) {
    console.log(`[email skipped] to=${to || '(none)'} subject=${subject}`);
    return Promise.resolve();
  }
  const from = process.env.RESEND_FROM || 'ChairSpace <onboarding@resend.dev>';
  const payload = JSON.stringify({ from, to, subject, html });
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 400) console.error(`[email failed ${res.statusCode}] ${body}`);
          resolve();
        });
      }
    );
    req.on('error', (e) => {
      console.error('[email error]', e.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ---------- geocoding (OpenStreetMap Nominatim — free, no API key) ----------
// Fire-and-forget, same pattern as sendEmail: never throws, never blocks the
// response. Nominatim's usage policy requires a real User-Agent and asks for
// max ~1 request/sec, which is fine for a prototype's occasional listing
// creates/edits (this isn't called on every page view, only when a listing's
// address changes).
// Looks up a single free-text query. Resolves to {lat, lon} or null — never
// throws, so callers can treat geocoding as best-effort.
function geocodeQuery(query) {
  return new Promise((resolve) => {
    const reqPath = `/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const req = https.request(
      {
        hostname: 'nominatim.openstreetmap.org',
        path: reqPath,
        method: 'GET',
        headers: { 'User-Agent': 'ChairSpace-Prototype/1.0 (contact: chairspace app)' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const results = JSON.parse(body);
            if (Array.isArray(results) && results[0]) {
              const lat = Number(results[0].lat);
              const lon = Number(results[0].lon);
              if (Number.isFinite(lat) && Number.isFinite(lon)) return resolve({ lat, lon });
            }
          } catch (e) {
            console.error('[geocode error]', e.message);
          }
          resolve(null);
        });
      }
    );
    req.on('error', (e) => {
      console.error('[geocode error]', e.message);
      resolve(null);
    });
    req.end();
  });
}

// Tries the full street address first. If that can't be found (a typo, a brand
// new address, a shop with no street number), it falls back to just the
// city/state so the listing can still show an approximate-area map instead of
// no map at all. `geo_precision` records which one we got.
async function geocodeListing(listingId, address, city, state, zip) {
  const hasStreet = Boolean(address && String(address).trim());
  const full = [address, city, state, zip].filter(Boolean).join(', ');
  const cityOnly = [city, state].filter(Boolean).join(', ');

  let hit = null;
  let precision = null;

  if (full) {
    hit = await geocodeQuery(full);
    if (hit) precision = hasStreet ? 'exact' : 'city';
  }
  if (!hit && cityOnly && cityOnly !== full) {
    hit = await geocodeQuery(cityOnly);
    if (hit) precision = 'city';
  }
  if (!hit) return;

  await db
    .prepare('UPDATE listings SET lat = ?, lon = ?, geo_precision = ? WHERE id = ?')
    .run(hit.lat, hit.lon, precision, listingId);
}

// ---------- saved search alerts ----------
// Event-driven rather than polled: Render's free tier spins the server down
// on inactivity, so a cron-style poller wouldn't reliably run anyway. Instead
// we check saved searches once, right when a new listing is created.
async function notifySavedSearchMatches(listing) {
  const searches = await db.prepare('SELECT * FROM saved_searches').all();
  for (const s of searches) {
    if (s.city && !listing.city.toLowerCase().includes(String(s.city).toLowerCase())) continue;
    if (s.chair_type && s.chair_type !== listing.chair_type) continue;
    if (s.price_unit && s.price_unit !== listing.price_unit) continue;
    if (s.max_price && Number(listing.price) > Number(s.max_price)) continue;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!user) continue;
    sendEmail({
      to: user.email,
      subject: `New chair matches your saved search — ChairSpace`,
      html: `<p>A new listing matches your saved search${s.label ? ` "${escapeHtml(s.label)}"` : ''}:</p>
        <p><b>${escapeHtml(listing.title)}</b> — ${escapeHtml(listing.city)}, ${escapeHtml(listing.state)} — $${listing.price}/${listing.price_unit}</p>
        <p><a href="${PUBLIC_URL}/listing/${listing.id}">View it on ChairSpace</a></p>`,
    });
  }
}

// ---------- photo storage (Cloudinary) ----------
// Uploaded photos used to be written to local disk, which — like the old
// SQLite database file — got wiped on every Render restart. Cloudinary's
// free tier gives real, persistent photo storage with no server disk
// involved. This uses a *signed* upload (the signature is generated here
// with Node's built-in crypto module, no SDK needed) rather than an
// unsigned upload preset, so the only setup is pasting credentials into
// Render — nothing to configure in Cloudinary's own dashboard first.
function getCloudinaryConfig() {
  const url = process.env.CLOUDINARY_URL;
  if (url) {
    const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
    if (m) return { apiKey: m[1], apiSecret: m[2], cloudName: m[3] };
  }
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    return { apiKey: CLOUDINARY_API_KEY, apiSecret: CLOUDINARY_API_SECRET, cloudName: CLOUDINARY_CLOUD_NAME };
  }
  return null;
}

function uploadToCloudinary(buffer, mimeType) {
  const config = getCloudinaryConfig();
  if (!config) return Promise.reject(new Error("Photo uploads aren't set up yet"));

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'chairspace';
  // Cloudinary signatures cover every param except file/api_key/signature
  // itself, sorted alphabetically by key.
  const toSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha1').update(toSign + config.apiSecret).digest('hex');

  const dataUri = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const body = new URLSearchParams({
    file: dataUri,
    api_key: config.apiKey,
    timestamp: String(timestamp),
    folder,
    signature,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.cloudinary.com',
        path: `/v1_1/${config.cloudName}/image/upload`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch (e) {
            return reject(new Error('Cloudinary returned an unexpected response'));
          }
          if (res.statusCode >= 400) {
            return reject(new Error((json.error && json.error.message) || `Cloudinary upload failed (${res.statusCode})`));
          }
          resolve(json.secure_url);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- helpers ----------

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Upload too large (max ${Math.round(maxBytes / (1024 * 1024))}MB total)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart/form-data parser — no external deps. Returns
// { fields: {name: value}, files: [{name, filename, contentType, data: Buffer}] }
function parseMultipart(buffer, boundary) {
  const boundaryBytes = Buffer.from('--' + boundary);
  const fields = {};
  const files = [];
  let start = buffer.indexOf(boundaryBytes);
  while (start !== -1) {
    const partStart = start + boundaryBytes.length;
    // check for closing boundary (--boundary--)
    if (buffer.slice(partStart, partStart + 2).toString() === '--') break;
    const nextBoundary = buffer.indexOf(boundaryBytes, partStart);
    if (nextBoundary === -1) break;
    // part content is between partStart (after \r\n) and nextBoundary (before \r\n--boundary)
    let part = buffer.slice(partStart, nextBoundary);
    // strip leading \r\n
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    // strip trailing \r\n before next boundary
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = nextBoundary; continue; }
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);

    const nameMatch = headerText.match(/name="([^"]*)"/);
    const filenameMatch = headerText.match(/filename="([^"]*)"/);
    const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
    const fieldName = nameMatch ? nameMatch[1] : null;

    if (fieldName) {
      if (filenameMatch && filenameMatch[1]) {
        files.push({
          name: fieldName,
          filename: filenameMatch[1],
          contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          data: body,
        });
      } else {
        fields[fieldName] = body.toString('utf8');
      }
    }
    start = nextBoundary;
  }
  return { fields, files };
}

const ALLOWED_IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// Every column safe to hand back to the account's own owner — i.e. everything
// except password_hash and salt. Kept in one place so the profile fields stay
// consistent across signup, login, /api/me, and profile updates.
const USER_FIELDS =
  'id, name, email, role, phone, bio, photo_url, city, instagram, years_experience, ' +
  'specialties, shop_name, website, created_at';

// `specialties` is stored as a JSON string; hand it to the frontend as a real
// array so callers never have to remember to parse it.
function publicUser(row) {
  if (!row) return null;
  let specialties = [];
  if (row.specialties) {
    try {
      const parsed = JSON.parse(row.specialties);
      if (Array.isArray(parsed)) specialties = parsed;
    } catch (e) {
      specialties = [];
    }
  }
  return { ...row, specialties };
}

async function getSessionUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const row = await db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  const user = await db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(row.user_id);
  return publicUser(user);
}

function publicListing(row) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    title: row.title,
    description: row.description,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    price: row.price,
    price_unit: row.price_unit,
    chair_type: row.chair_type,
    photo_seed: row.photo_seed,
    photos: row.photos ? JSON.parse(row.photos) : [],
    available_from: row.available_from,
    total_chairs: row.total_chairs,
    cancellation_policy: row.cancellation_policy || 'standard',
    lat: row.lat === undefined ? null : row.lat,
    lon: row.lon === undefined ? null : row.lon,
    geo_precision: row.geo_precision || null,
    active: !!row.active,
    created_at: row.created_at,
  };
}

const CANCELLATION_POLICIES = ['flexible', 'standard', 'strict'];

// ---------- route handlers ----------

const routes = [];
function route(method, pattern, handler) {
  // pattern like /api/listings/:id -> regex with named groups
  const paramNames = [];
  const regexStr = '^' + pattern.replace(/:[a-zA-Z]+/g, (m) => {
    paramNames.push(m.slice(1));
    return '([^/]+)';
  }) + '$';
  routes.push({ method, regex: new RegExp(regexStr), paramNames, handler });
}

// --- Auth ---

route('POST', '/api/signup', async (req, res) => {
  const body = await readBody(req);
  const { name, email, password, role, phone, bio } = body;
  if (!name || !email || !password || !role) {
    return send(res, 400, { error: 'name, email, password, and role are required' });
  }
  if (!['barber', 'owner'].includes(role)) {
    return send(res, 400, { error: "role must be 'barber' or 'owner'" });
  }
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return send(res, 409, { error: 'An account with that email already exists' });

  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = hashPassword(password, salt);
  const info = await db.prepare(`
    INSERT INTO users (name, email, password_hash, salt, role, phone, bio, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(name, email.toLowerCase().trim(), password_hash, salt, role, phone || null, bio || null, new Date().toISOString());

  const userId = Number(info.lastInsertRowid);
  const token = crypto.randomBytes(24).toString('hex');
  await db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, new Date().toISOString());

  const user = publicUser(await db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(userId));
  send(res, 201, { token, user });
});

route('POST', '/api/login', async (req, res) => {
  const body = await readBody(req);
  const { email, password } = body;
  if (!email || !password) return send(res, 400, { error: 'email and password are required' });

  const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!row) return send(res, 401, { error: 'Invalid email or password' });

  const hash = hashPassword(password, row.salt);
  if (hash !== row.password_hash) return send(res, 401, { error: 'Invalid email or password' });

  const token = crypto.randomBytes(24).toString('hex');
  await db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, row.id, new Date().toISOString());

  const user = publicUser(await db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(row.id));
  send(res, 200, { token, user });
});

route('POST', '/api/logout', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  send(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  send(res, 200, { user });
});

// --- Profile ---

const MAX_SPECIALTIES = 12;

route('PATCH', '/api/me', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const body = await readBody(req);

  const fields = [];
  const args = [];
  const setText = (col, value, max = 400) => {
    const v = value === null || value === undefined ? null : String(value).trim().slice(0, max);
    fields.push(`${col} = ?`);
    args.push(v || null);
  };

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return send(res, 400, { error: 'Name can’t be empty' });
    fields.push('name = ?');
    args.push(name.slice(0, 120));
  }

  // Email doubles as the login, so it needs a uniqueness check before it moves.
  if (body.email !== undefined) {
    const email = String(body.email).toLowerCase().trim();
    if (!email || !email.includes('@')) return send(res, 400, { error: 'Enter a valid email address' });
    if (email !== user.email) {
      const taken = await db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, user.id);
      if (taken) return send(res, 409, { error: 'Another account already uses that email' });
    }
    fields.push('email = ?');
    args.push(email);
  }

  if (body.phone !== undefined) setText('phone', body.phone, 40);
  if (body.bio !== undefined) setText('bio', body.bio, 1000);
  if (body.city !== undefined) setText('city', body.city, 120);

  if (user.role === 'barber') {
    if (body.instagram !== undefined) {
      // store bare handles, however the person typed it in
      const handle = String(body.instagram || '').trim().replace(/^@+/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/+$/, '');
      fields.push('instagram = ?');
      args.push(handle ? handle.slice(0, 60) : null);
    }
    if (body.years_experience !== undefined) {
      const yearsRaw = body.years_experience;
      let years = null;
      if (yearsRaw !== null && yearsRaw !== '') {
        years = Number(yearsRaw);
        if (!Number.isFinite(years) || years < 0 || years > 70) {
          return send(res, 400, { error: 'Years cutting should be a number between 0 and 70' });
        }
        years = Math.round(years);
      }
      fields.push('years_experience = ?');
      args.push(years);
    }
    if (body.specialties !== undefined) {
      const list = Array.isArray(body.specialties) ? body.specialties : [];
      const clean = list
        .map((s) => String(s).trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, MAX_SPECIALTIES);
      fields.push('specialties = ?');
      args.push(clean.length ? JSON.stringify(clean) : null);
    }
  }

  if (user.role === 'owner') {
    if (body.shop_name !== undefined) setText('shop_name', body.shop_name, 120);
    if (body.website !== undefined) setText('website', body.website, 300);
  }

  if (!fields.length) return send(res, 400, { error: 'Nothing to update' });

  args.push(user.id);
  await db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...args);
  const updated = publicUser(await db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(user.id));
  send(res, 200, { user: updated });
});

route('POST', '/api/me/password', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const body = await readBody(req);
  const current = body.current_password || '';
  const next = body.new_password || '';
  if (!current || !next) return send(res, 400, { error: 'Enter your current and new password' });
  if (String(next).length < 6) return send(res, 400, { error: 'New password must be at least 6 characters' });

  const row = await db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').get(user.id);
  if (!row || hashPassword(current, row.salt) !== row.password_hash) {
    return send(res, 401, { error: 'Your current password isn’t right' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = hashPassword(next, salt);
  await db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(password_hash, salt, user.id);
  send(res, 200, { ok: true });
});

route('POST', '/api/me/photo', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });

  if (!getCloudinaryConfig()) {
    return send(res, 503, { error: "Photo uploads aren't set up yet — add your Cloudinary credentials in Render's Environment settings." });
  }

  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!contentType.startsWith('multipart/form-data') || !boundaryMatch) {
    return send(res, 400, { error: 'Expected multipart/form-data upload' });
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  let raw;
  try {
    raw = await readRawBody(req, MAX_PHOTO_BYTES + 1024 * 1024);
  } catch (e) {
    return send(res, 413, { error: e.message });
  }

  const { files } = parseMultipart(raw, boundary);
  const file = files.find((f) => f.name === 'photo' || f.name === 'photos');
  if (!file) return send(res, 400, { error: 'No file uploaded' });
  if (file.data.length > MAX_PHOTO_BYTES) return send(res, 400, { error: 'That image is larger than 5MB' });
  if (!ALLOWED_IMAGE_TYPES[file.contentType]) {
    return send(res, 400, { error: 'Use a JPG, PNG, WEBP, or GIF image' });
  }

  let url;
  try {
    url = await uploadToCloudinary(file.data, file.contentType);
  } catch (e) {
    return send(res, 502, { error: `Photo upload failed: ${e.message}` });
  }

  await db.prepare('UPDATE users SET photo_url = ? WHERE id = ?').run(url, user.id);
  const updated = publicUser(await db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(user.id));
  send(res, 200, { user: updated });
});

// --- Listings ---

route('GET', '/api/listings', async (req, res, params, query) => {
  let sql = 'SELECT * FROM listings WHERE active = 1';
  const args = [];
  if (query.city) {
    sql += ' AND (LOWER(city) LIKE ? OR LOWER(zip) LIKE ?)';
    args.push('%' + query.city.toLowerCase() + '%', '%' + query.city.toLowerCase() + '%');
  }
  if (query.chair_type) {
    sql += ' AND chair_type = ?';
    args.push(query.chair_type);
  }
  if (query.price_unit) {
    sql += ' AND price_unit = ?';
    args.push(query.price_unit);
  }
  if (query.max_price) {
    sql += ' AND price <= ?';
    args.push(Number(query.max_price));
  }
  if (query.available_only === '1' || query.available_only === 'true') {
    const today = new Date().toISOString().slice(0, 10);
    sql += ' AND (available_from IS NULL OR available_from = \'\' OR available_from <= ?)';
    args.push(today);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = await db.prepare(sql).all(...args);
  const listings = rows.map(publicListing);
  // attach owner name for display
  for (const l of listings) {
    const owner = await db.prepare('SELECT name FROM users WHERE id = ?').get(l.owner_id);
    l.owner_name = owner ? owner.name : 'Unknown';
  }
  send(res, 200, { listings });
});

route('GET', '/api/listings/:id', async (req, res, params) => {
  const row = await db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Listing not found' });
  const listing = publicListing(row);
  const owner = await db.prepare('SELECT id, name, email, phone, bio FROM users WHERE id = ?').get(row.owner_id);
  listing.owner = owner;
  send(res, 200, { listing });
});

route('POST', '/api/listings', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners can post listings' });

  const body = await readBody(req);
  const { title, description, address, city, state, zip, price, price_unit, chair_type, available_from, total_chairs, cancellation_policy } = body;
  if (!title || !city || !state || !price || !price_unit || !chair_type) {
    return send(res, 400, { error: 'title, city, state, price, price_unit, and chair_type are required' });
  }
  if (!['hour', 'day', 'week', 'month'].includes(price_unit)) {
    return send(res, 400, { error: 'price_unit must be one of hour, day, week, month' });
  }
  const policy = CANCELLATION_POLICIES.includes(cancellation_policy) ? cancellation_policy : 'standard';
  const photo_seed = 'l' + Date.now() + Math.floor(Math.random() * 1000);
  const info = await db.prepare(`
    INSERT INTO listings (owner_id, title, description, address, city, state, zip, price, price_unit, chair_type, photo_seed, available_from, total_chairs, cancellation_policy, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    RETURNING id
  `).run(user.id, title, description || '', address || '', city, state, zip || '', Number(price), price_unit, chair_type, photo_seed, available_from || null, total_chairs ? Number(total_chairs) : null, policy, new Date().toISOString());

  const listingId = Number(info.lastInsertRowid);
  const listing = publicListing(await db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId));
  send(res, 201, { listing });

  geocodeListing(listingId, address, city, state, zip).catch((e) => console.error('[geocode error]', e.message));
  notifySavedSearchMatches(listing).catch((e) => console.error('[saved search notify error]', e.message));
});

route('PATCH', '/api/listings/:id', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Listing not found' });
  if (row.owner_id !== user.id) return send(res, 403, { error: 'Not your listing' });

  const body = await readBody(req);
  const fields = [];
  const args = [];
  for (const key of ['title', 'description', 'address', 'city', 'state', 'zip', 'price', 'price_unit', 'chair_type', 'available_from', 'total_chairs', 'cancellation_policy', 'active']) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      let val = body[key];
      if (key === 'active') val = body.active ? 1 : 0;
      else if (key === 'total_chairs') val = body.total_chairs === '' || body.total_chairs === null ? null : Number(body.total_chairs);
      else if (key === 'cancellation_policy') val = CANCELLATION_POLICIES.includes(val) ? val : 'standard';
      args.push(val);
    }
  }
  if (fields.length === 0) return send(res, 400, { error: 'No fields to update' });
  args.push(params.id);
  await db.prepare(`UPDATE listings SET ${fields.join(', ')} WHERE id = ?`).run(...args);
  const updated = publicListing(await db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id));
  send(res, 200, { listing: updated });

  const addressChanged = ['address', 'city', 'state', 'zip'].some((k) => body[k] !== undefined);
  if (addressChanged) {
    geocodeListing(params.id, updated.address, updated.city, updated.state, updated.zip)
      .catch((e) => console.error('[geocode error]', e.message));
  }
});

route('POST', '/api/listings/:id/photos', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Listing not found' });
  if (row.owner_id !== user.id) return send(res, 403, { error: 'Not your listing' });

  if (!getCloudinaryConfig()) {
    return send(res, 503, { error: "Photo uploads aren't set up yet — add your Cloudinary credentials in Render's Environment settings." });
  }

  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!contentType.startsWith('multipart/form-data') || !boundaryMatch) {
    return send(res, 400, { error: 'Expected multipart/form-data upload' });
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  let raw;
  try {
    raw = await readRawBody(req, MAX_PHOTOS * MAX_PHOTO_BYTES + 1024 * 1024);
  } catch (e) {
    return send(res, 413, { error: e.message });
  }

  const { files } = parseMultipart(raw, boundary);
  const imageFiles = files.filter((f) => f.name === 'photos' || f.name === 'photo');
  if (imageFiles.length === 0) return send(res, 400, { error: 'No files uploaded' });
  if (imageFiles.length > MAX_PHOTOS) {
    return send(res, 400, { error: `You can upload at most ${MAX_PHOTOS} photos at once` });
  }
  for (const f of imageFiles) {
    if (f.data.length > MAX_PHOTO_BYTES) {
      return send(res, 400, { error: `${f.filename} is larger than 5MB` });
    }
    if (!ALLOWED_IMAGE_TYPES[f.contentType]) {
      return send(res, 400, { error: `${f.filename} is not a supported image type (use JPG, PNG, WEBP, or GIF)` });
    }
  }

  const existingPhotos = row.photos ? JSON.parse(row.photos) : [];
  if (existingPhotos.length + imageFiles.length > MAX_PHOTOS) {
    return send(res, 400, { error: `A listing can have at most ${MAX_PHOTOS} photos total` });
  }

  let uploadedUrls;
  try {
    uploadedUrls = await Promise.all(imageFiles.map((f) => uploadToCloudinary(f.data, f.contentType)));
  } catch (e) {
    return send(res, 502, { error: `Photo upload failed: ${e.message}` });
  }

  const allPhotos = existingPhotos.concat(uploadedUrls);
  await db.prepare('UPDATE listings SET photos = ? WHERE id = ?').run(JSON.stringify(allPhotos), params.id);
  const updated = publicListing(await db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id));
  send(res, 200, { listing: updated });
});

route('GET', '/api/my-listings', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners have listings' });
  const rows = await db.prepare('SELECT * FROM listings WHERE owner_id = ? ORDER BY created_at DESC').all(user.id);
  send(res, 200, { listings: rows.map(publicListing) });
});

// --- Favorites (barbers bookmarking listings) ---

route('GET', '/api/favorites', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const rows = await db.prepare(`
    SELECT l.* FROM favorites f
    JOIN listings l ON f.listing_id = l.id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(user.id);
  send(res, 200, { listings: rows.map(publicListing) });
});

route('GET', '/api/favorites/ids', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const rows = await db.prepare('SELECT listing_id FROM favorites WHERE user_id = ?').all(user.id);
  send(res, 200, { listing_ids: rows.map((r) => r.listing_id) });
});

route('POST', '/api/favorites', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const body = await readBody(req);
  const listingId = Number(body.listing_id);
  if (!listingId) return send(res, 400, { error: 'listing_id is required' });
  const listing = await db.prepare('SELECT id FROM listings WHERE id = ?').get(listingId);
  if (!listing) return send(res, 404, { error: 'Listing not found' });
  try {
    await db.prepare('INSERT INTO favorites (user_id, listing_id, created_at) VALUES (?, ?, ?)')
      .run(user.id, listingId, new Date().toISOString());
  } catch (e) {
    // 23505 = Postgres unique_violation — already favorited, treat as a
    // no-op success. Anything else is a real error and should surface.
    if (e.code !== '23505') throw e;
  }
  send(res, 201, { ok: true });
});

route('DELETE', '/api/favorites/:listingId', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  await db.prepare('DELETE FROM favorites WHERE user_id = ? AND listing_id = ?').run(user.id, params.listingId);
  send(res, 200, { ok: true });
});

// --- Inquiries (no-login "Contact Owner" leads) ---

route('POST', '/api/listings/:id/inquiries', async (req, res, params) => {
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!listing) return send(res, 404, { error: 'Listing not found' });

  const body = await readBody(req);
  const { name, email, phone, social, message } = body;
  if (!name || !name.trim()) return send(res, 400, { error: 'Name is required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return send(res, 400, { error: 'A valid email is required' });
  }

  const info = await db.prepare(`
    INSERT INTO inquiries (listing_id, name, email, phone, social, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(params.id, name.trim(), email.trim(), phone || '', social || '', message || '', new Date().toISOString());

  const created = await db.prepare('SELECT * FROM inquiries WHERE id = ?').get(Number(info.lastInsertRowid));
  send(res, 201, { inquiry: created });

  const owner = await db.prepare('SELECT * FROM users WHERE id = ?').get(listing.owner_id);
  if (owner) {
    sendEmail({
      to: owner.email,
      subject: `New inquiry about "${listing.title}" — ChairSpace`,
      html: `<p><b>${escapeHtml(name.trim())}</b> (${escapeHtml(email.trim())}${phone ? ', ' + escapeHtml(phone) : ''}) is interested in "${escapeHtml(listing.title)}".</p>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <p><a href="${PUBLIC_URL}/dashboard">View it on ChairSpace</a></p>`,
    });
  }
});

route('GET', '/api/inquiries/received', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners receive inquiries' });

  const rows = await db.prepare(`
    SELECT i.* FROM inquiries i
    JOIN listings l ON i.listing_id = l.id
    WHERE l.owner_id = ?
    ORDER BY i.created_at DESC
  `).all(user.id);

  const inquiries = await Promise.all(rows.map(async (row) => {
    const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      social: row.social,
      message: row.message,
      created_at: row.created_at,
      listing: listing ? publicListing(listing) : null,
    };
  }));
  send(res, 200, { inquiries });
});

// --- Requests (rental requests) ---

route('POST', '/api/requests', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'barber') return send(res, 403, { error: 'Only barbers can send rental requests' });

  const body = await readBody(req);
  const { listing_id, start_date, end_date, message } = body;
  if (!listing_id) return send(res, 400, { error: 'listing_id is required' });
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(listing_id);
  if (!listing) return send(res, 404, { error: 'Listing not found' });
  if (listing.owner_id === user.id) return send(res, 400, { error: "You can't request your own listing" });

  const info = await db.prepare(`
    INSERT INTO requests (listing_id, barber_id, status, start_date, end_date, message, created_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?)
    RETURNING id
  `).run(listing_id, user.id, start_date || null, end_date || null, message || '', new Date().toISOString());

  const reqId = Number(info.lastInsertRowid);
  if (message) {
    await db.prepare('INSERT INTO messages (request_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(reqId, user.id, message, new Date().toISOString());
  }
  const created = await db.prepare('SELECT * FROM requests WHERE id = ?').get(reqId);
  send(res, 201, { request: created });

  const owner = await db.prepare('SELECT * FROM users WHERE id = ?').get(listing.owner_id);
  if (owner) {
    sendEmail({
      to: owner.email,
      subject: `New rental request for "${listing.title}" — ChairSpace`,
      html: `<p><b>${escapeHtml(user.name)}</b> wants to rent your listing "${escapeHtml(listing.title)}".</p>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <p><a href="${PUBLIC_URL}/dashboard">View it on ChairSpace</a></p>`,
    });
  }
});

async function enrichRequest(row) {
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const barber = await db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(row.barber_id);
  const owner = listing ? await db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(listing.owner_id) : null;
  return {
    id: row.id,
    status: row.status,
    start_date: row.start_date,
    end_date: row.end_date,
    message: row.message,
    created_at: row.created_at,
    listing: listing ? publicListing(listing) : null,
    barber,
    owner,
  };
}

route('GET', '/api/requests/sent', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const rows = await db.prepare('SELECT * FROM requests WHERE barber_id = ? ORDER BY created_at DESC').all(user.id);
  send(res, 200, { requests: await Promise.all(rows.map(enrichRequest)) });
});

route('GET', '/api/requests/received', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners receive requests' });
  const rows = await db.prepare(`
    SELECT r.* FROM requests r
    JOIN listings l ON r.listing_id = l.id
    WHERE l.owner_id = ?
    ORDER BY r.created_at DESC
  `).all(user.id);
  send(res, 200, { requests: await Promise.all(rows.map(enrichRequest)) });
});

route('PATCH', '/api/requests/:id', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);

  const body = await readBody(req);
  const { status } = body;
  if (!status) return send(res, 400, { error: 'status is required' });

  const isOwner = listing && listing.owner_id === user.id;
  const isBarber = row.barber_id === user.id;

  if (['approved', 'declined'].includes(status) && !isOwner) {
    return send(res, 403, { error: 'Only the space owner can approve or decline' });
  }
  if (status === 'cancelled' && !isBarber) {
    return send(res, 403, { error: 'Only the requesting barber can cancel' });
  }
  if (!['pending', 'approved', 'declined', 'cancelled'].includes(status)) {
    return send(res, 400, { error: 'Invalid status' });
  }

  await db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, params.id);
  const updated = await db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  send(res, 200, { request: await enrichRequest(updated) });

  if (['approved', 'declined'].includes(status)) {
    const barber = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.barber_id);
    if (barber) {
      sendEmail({
        to: barber.email,
        subject: `Your request was ${status} — ChairSpace`,
        html: `<p>Your rental request for "${escapeHtml(listing ? listing.title : 'a ChairSpace listing')}" was <b>${status}</b>.</p>
          <p><a href="${PUBLIC_URL}/dashboard">View it on ChairSpace</a></p>`,
      });
    }
  }
});

// --- Messaging ---

route('GET', '/api/requests/:id/messages', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const isParty = row.barber_id === user.id || (listing && listing.owner_id === user.id);
  if (!isParty) return send(res, 403, { error: 'Not part of this conversation' });

  const rows = await db.prepare('SELECT * FROM messages WHERE request_id = ? ORDER BY created_at ASC').all(params.id);
  const messages = await Promise.all(rows.map(async (m) => {
    const sender = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(m.sender_id);
    return { id: m.id, body: m.body, created_at: m.created_at, sender };
  }));
  send(res, 200, { messages });
});

route('POST', '/api/requests/:id/messages', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const isParty = row.barber_id === user.id || (listing && listing.owner_id === user.id);
  if (!isParty) return send(res, 403, { error: 'Not part of this conversation' });

  const body = await readBody(req);
  if (!body.body || !body.body.trim()) return send(res, 400, { error: 'Message body is required' });

  const info = await db.prepare('INSERT INTO messages (request_id, sender_id, body, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .run(params.id, user.id, body.body.trim(), new Date().toISOString());
  const m = await db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
  const sender = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(user.id);
  send(res, 201, { message: { id: m.id, body: m.body, created_at: m.created_at, sender } });

  const otherUserId = row.barber_id === user.id ? (listing ? listing.owner_id : null) : row.barber_id;
  if (otherUserId) {
    const other = await db.prepare('SELECT * FROM users WHERE id = ?').get(otherUserId);
    if (other) {
      sendEmail({
        to: other.email,
        subject: `New message from ${user.name} — ChairSpace`,
        html: `<p><b>${escapeHtml(user.name)}</b>: ${escapeHtml(body.body.trim())}</p>
          <p><a href="${PUBLIC_URL}/requests/${params.id}">Reply on ChairSpace</a></p>`,
      });
    }
  }
});

// --- Saved searches (email alert when a new matching listing goes up) ---

route('GET', '/api/saved-searches', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const rows = await db.prepare('SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
  send(res, 200, { searches: rows });
});

route('POST', '/api/saved-searches', async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'barber') return send(res, 403, { error: 'Only barbers can save searches' });
  const body = await readBody(req);
  const { label, city, chair_type, price_unit, max_price } = body;
  if (!city && !chair_type && !price_unit && !max_price) {
    return send(res, 400, { error: 'Add at least one filter to save a search' });
  }
  const info = await db.prepare(`
    INSERT INTO saved_searches (user_id, label, city, chair_type, price_unit, max_price, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).run(user.id, label || null, city || null, chair_type || null, price_unit || null, max_price ? Number(max_price) : null, new Date().toISOString());
  const created = await db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(Number(info.lastInsertRowid));
  send(res, 201, { search: created });
});

route('DELETE', '/api/saved-searches/:id', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Saved search not found' });
  if (row.user_id !== user.id) return send(res, 403, { error: 'Not your saved search' });
  await db.prepare('DELETE FROM saved_searches WHERE id = ?').run(params.id);
  send(res, 200, { ok: true });
});

// --- Reviews (two-way, blind until both sides submit) ---
// Modeled on Peerspace-style reviews: neither party can see the other's
// review until both have submitted theirs, so no one holds back an honest
// review out of fear of retaliation. Since this prototype has no explicit
// "rental completed" step yet, an approved request is used as the proxy for
// "the rental happened" — either party can review once status = approved.

async function reviewsVisibleCount(requestId) {
  // COUNT(*) comes back from Postgres as a bigint (returned as a string by
  // the driver) — cast to int so the `=== 2` checks below work as expected.
  const { count } = await db.prepare('SELECT COUNT(*)::int as count FROM reviews WHERE request_id = ?').get(requestId);
  return count;
}

route('POST', '/api/requests/:id/reviews', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const isOwner = listing && listing.owner_id === user.id;
  const isBarber = row.barber_id === user.id;
  if (!isOwner && !isBarber) return send(res, 403, { error: 'Not part of this rental' });
  if (row.status !== 'approved') return send(res, 400, { error: 'You can only leave a review once the request has been approved' });

  const body = await readBody(req);
  const rating = Number(body.rating);
  if (!rating || rating < 1 || rating > 5) return send(res, 400, { error: 'rating must be between 1 and 5' });

  const existing = await db.prepare('SELECT id FROM reviews WHERE request_id = ? AND author_id = ?').get(params.id, user.id);
  if (existing) return send(res, 409, { error: "You've already reviewed this rental" });

  const target_type = isBarber ? 'listing' : 'barber';
  const target_id = isBarber ? listing.id : row.barber_id;

  await db.prepare(`
    INSERT INTO reviews (request_id, listing_id, author_id, target_type, target_id, rating, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, listing.id, user.id, target_type, target_id, rating, (body.comment || '').trim(), new Date().toISOString());

  send(res, 201, { ok: true, bothSubmitted: (await reviewsVisibleCount(params.id)) === 2 });
});

route('GET', '/api/requests/:id/reviews', async (req, res, params) => {
  const user = await getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = await db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = await db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const isParty = row.barber_id === user.id || (listing && listing.owner_id === user.id);
  if (!isParty) return send(res, 403, { error: 'Not part of this rental' });

  const rows = await db.prepare('SELECT * FROM reviews WHERE request_id = ?').all(params.id);
  const mine = rows.find((r) => r.author_id === user.id) || null;
  const bothSubmitted = rows.length === 2;
  const other = bothSubmitted ? rows.find((r) => r.author_id !== user.id) : null;
  send(res, 200, {
    canReview: row.status === 'approved' && !mine,
    myReview: mine,
    otherReview: other,
    bothSubmitted,
  });
});

route('GET', '/api/listings/:id/reviews', async (req, res, params) => {
  const rows = await db.prepare(`
    SELECT r.* FROM reviews r
    WHERE r.target_type = 'listing' AND r.target_id = ?
  `).all(params.id);
  // Only reveal reviews whose counterpart (the barber-targeted review for the
  // same request) has also been submitted — same blind logic as above.
  const counts = await Promise.all(rows.map((r) => reviewsVisibleCount(r.request_id)));
  const visible = rows.filter((r, i) => counts[i] === 2);
  const enriched = await Promise.all(visible.map(async (r) => {
    const author = await db.prepare('SELECT id, name FROM users WHERE id = ?').get(r.author_id);
    return { id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at, author: author ? { id: author.id, name: author.name } : null };
  }));
  const avg = enriched.length ? enriched.reduce((s, r) => s + r.rating, 0) / enriched.length : null;
  send(res, 200, { reviews: enriched, average: avg, count: enriched.length });
});

// ---------- static file serving ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      // SPA fallback: serve index.html for unknown non-api routes
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        ETag: etag,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

// ---------- server-rendered listing pages (real URLs, crawlable by Google) ----------

function renderListingPage(req, listing) {
  const host = req.headers.host || 'chairspace.onrender.com';
  const base = `https://${host}`;
  const url = `${base}/listing/${listing.id}`;
  const photos = (listing.photos || []).map((p) => (p.startsWith('http') ? p : base + p));
  const priceLabel = `$${listing.price}/${listing.price_unit}`;
  const title = `${listing.title} — ${listing.city}, ${listing.state} | ChairSpace`;
  const rawDesc = listing.description || `${listing.chair_type} for rent in ${listing.city}, ${listing.state} — ${priceLabel}.`;
  const desc = rawDesc.length > 160 ? rawDesc.slice(0, 157) + '...' : rawDesc;
  const heroImg = photos[0] || '';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: listing.title,
    description: rawDesc,
    ...(photos.length ? { image: photos } : {}),
    offers: {
      '@type': 'Offer',
      price: listing.price,
      priceCurrency: 'USD',
      availability: listing.active ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url,
    },
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}" />
<link rel="canonical" href="${url}" />
<meta property="og:type" content="product" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(desc)}" />
${heroImg ? `<meta property="og:image" content="${escapeHtml(heroImg)}" />\n` : ''}<meta property="og:url" content="${url}" />
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<link rel="stylesheet" href="/style.css" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
</head>
<body>
  <header class="site">
    <div class="container">
      <div class="logo" onclick="App.nav('/')">Chair<span>Space</span></div>
      <button type="button" class="menu-toggle" id="menu-toggle" onclick="App.toggleMenu()" aria-label="Menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
      <nav class="main" id="nav"></nav>
    </div>
  </header>
  <main>
    <div class="container" id="app">
      <div class="detail-grid">
        <div>
          ${heroImg ? `<div class="hero-wrap"><img class="hero-img" src="${escapeHtml(heroImg)}" alt="${escapeHtml(listing.title)}" /></div>` : ''}
          <h1>${escapeHtml(listing.title)}</h1>
          <p class="card-meta">${escapeHtml(listing.city)}, ${escapeHtml(listing.state)}${listing.total_chairs ? ' &middot; ' + listing.total_chairs + '-chair shop' : ''}</p>
          <p>${escapeHtml(listing.description || '')}</p>
        </div>
        <div>
          <div class="side-card">
            <div class="price-tag">${priceLabel}</div>
          </div>
        </div>
      </div>
    </div>
  </main>
  <footer class="site">
    <div class="container">
      ChairSpace — a prototype marketplace connecting barbers with open chairs, booths, and suites to rent.
    </div>
  </footer>
  <div id="modal-root"></div>
  <!-- Leaflet must be loaded here too, not just in index.html: this
       server-rendered page is what a visitor gets when they open a listing
       URL directly (a shared link, a refresh, or right after publishing).
       Without it the map script silently bails and leaves an empty gray box. -->
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script src="/app.js"></script>
</body>
</html>`;
}

async function buildSitemap(req) {
  const host = req.headers.host || 'chairspace.onrender.com';
  const base = `https://${host}`;
  const rows = await db.prepare('SELECT id, created_at FROM listings WHERE active = 1').all();
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  xml += `  <url>\n    <loc>${base}/</loc>\n  </url>\n`;
  for (const r of rows) {
    xml += `  <url>\n    <loc>${base}/listing/${r.id}</loc>\n`;
    if (r.created_at) xml += `    <lastmod>${r.created_at.slice(0, 10)}</lastmod>\n`;
    xml += `  </url>\n`;
  }
  xml += '</urlset>';
  return xml;
}

function buildRobots(req) {
  const host = req.headers.host || 'chairspace.onrender.com';
  return `User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`;
}

// ---------- main request handler ----------

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(await buildSitemap(req));
    }
    if (req.method === 'GET' && pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(buildRobots(req));
    }
    const listingMatch = pathname.match(/^\/listing\/(\d+)\/?$/);
    if (req.method === 'GET' && listingMatch) {
      const row = await db.prepare('SELECT * FROM listings WHERE id = ?').get(listingMatch[1]);
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!DOCTYPE html><title>Not found — ChairSpace</title><h1>Listing not found</h1><p><a href="/">Back to ChairSpace</a></p>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(renderListingPage(req, publicListing(row)));
    }
    return serveStatic(req, res, pathname);
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = pathname.match(r.regex);
    if (!match) continue;
    const params = {};
    r.paramNames.forEach((name, i) => (params[name] = match[i + 1]));
    try {
      await r.handler(req, res, params, query);
    } catch (e) {
      console.error(e);
      send(res, 500, { error: e.message || 'Internal server error' });
    }
    return;
  }

  send(res, 404, { error: 'Not found' });
});

// Listings created before geocoding existed — including the seeded samples —
// have no coordinates, so their pages show no map at all. Fill those in in the
// background after startup. Requests are spaced ~1.2s apart to stay inside
// Nominatim's ~1 request/second usage policy, and capped so a boot never turns
// into a long crawl. Runs after listen() so it never delays serving traffic.
async function backfillMissingCoords() {
  const rows = await db
    .prepare('SELECT id, address, city, state, zip FROM listings WHERE lat IS NULL ORDER BY id LIMIT 20')
    .all();
  if (!rows.length) return;
  console.log(`Backfilling map coordinates for ${rows.length} listing(s)...`);
  for (const r of rows) {
    await geocodeListing(r.id, r.address, r.city, r.state, r.zip);
    await new Promise((res) => setTimeout(res, 1200));
  }
  console.log('Coordinate backfill complete.');
}

// Wait for the database (schema + migrations + sample-data seed) to be ready
// before accepting any traffic, so no request can race the initial setup.
ready
  .then(() => {
    server.listen(PORT, () => {
      console.log(`ChairSpace running at http://localhost:${PORT}`);
    });
    backfillMissingCoords().catch((e) => console.error('[backfill error]', e.message));
  })
  .catch((err) => {
    console.error('Failed to initialize the database:', err.message);
    process.exit(1);
  });
