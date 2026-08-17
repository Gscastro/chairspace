// server.js — ChairSpace API + static server. Pure Node built-ins, no npm deps.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, hashPassword } = require('./db');

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
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads', 'listings');

function getSessionUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  const user = db.prepare('SELECT id, name, email, role, phone, bio, created_at FROM users WHERE id = ?').get(row.user_id);
  return user || null;
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
    active: !!row.active,
    created_at: row.created_at,
  };
}

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
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return send(res, 409, { error: 'An account with that email already exists' });

  const salt = crypto.randomBytes(16).toString('hex');
  const password_hash = hashPassword(password, salt);
  const info = db.prepare(`
    INSERT INTO users (name, email, password_hash, salt, role, phone, bio, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, email.toLowerCase().trim(), password_hash, salt, role, phone || null, bio || null, new Date().toISOString());

  const userId = Number(info.lastInsertRowid);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, new Date().toISOString());

  const user = db.prepare('SELECT id, name, email, role, phone, bio, created_at FROM users WHERE id = ?').get(userId);
  send(res, 201, { token, user });
});

route('POST', '/api/login', async (req, res) => {
  const body = await readBody(req);
  const { email, password } = body;
  if (!email || !password) return send(res, 400, { error: 'email and password are required' });

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!row) return send(res, 401, { error: 'Invalid email or password' });

  const hash = hashPassword(password, row.salt);
  if (hash !== row.password_hash) return send(res, 401, { error: 'Invalid email or password' });

  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, row.id, new Date().toISOString());

  const user = { id: row.id, name: row.name, email: row.email, role: row.role, phone: row.phone, bio: row.bio, created_at: row.created_at };
  send(res, 200, { token, user });
});

route('POST', '/api/logout', async (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  send(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  send(res, 200, { user });
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
  const rows = db.prepare(sql).all(...args);
  const listings = rows.map(publicListing);
  // attach owner name for display
  for (const l of listings) {
    const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(l.owner_id);
    l.owner_name = owner ? owner.name : 'Unknown';
  }
  send(res, 200, { listings });
});

route('GET', '/api/listings/:id', async (req, res, params) => {
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Listing not found' });
  const listing = publicListing(row);
  const owner = db.prepare('SELECT id, name, email, phone, bio FROM users WHERE id = ?').get(row.owner_id);
  listing.owner = owner;
  send(res, 200, { listing });
});

route('POST', '/api/listings', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners can post listings' });

  const body = await readBody(req);
  const { title, description, address, city, state, zip, price, price_unit, chair_type, available_from, total_chairs } = body;
  if (!title || !city || !state || !price || !price_unit || !chair_type) {
    return send(res, 400, { error: 'title, city, state, price, price_unit, and chair_type are required' });
  }
  if (!['hour', 'day', 'week', 'month'].includes(price_unit)) {
    return send(res, 400, { error: 'price_unit must be one of hour, day, week, month' });
  }
  const photo_seed = 'l' + Date.now() + Math.floor(Math.random() * 1000);
  const info = db.prepare(`
    INSERT INTO listings (owner_id, title, description, address, city, state, zip, price, price_unit, chair_type, photo_seed, available_from, total_chairs, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(user.id, title, description || '', address || '', city, state, zip || '', Number(price), price_unit, chair_type, photo_seed, available_from || null, total_chairs ? Number(total_chairs) : null, new Date().toISOString());

  const listing = publicListing(db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(info.lastInsertRowid)));
  send(res, 201, { listing });
});

route('PATCH', '/api/listings/:id', async (req, res, params) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Listing not found' });
  if (row.owner_id !== user.id) return send(res, 403, { error: 'Not your listing' });

  const body = await readBody(req);
  const fields = [];
  const args = [];
  for (const key of ['title', 'description', 'address', 'city', 'state', 'zip', 'price', 'price_unit', 'chair_type', 'available_from', 'total_chairs', 'active']) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      let val = body[key];
      if (key === 'active') val = body.active ? 1 : 0;
      else if (key === 'total_chairs') val = body.total_chairs === '' || body.total_chairs === null ? null : Number(body.total_chairs);
      args.push(val);
    }
  }
  if (fields.length === 0) return send(res, 400, { error: 'No fields to update' });
  args.push(params.id);
  db.prepare(`UPDATE listings SET ${fields.join(', ')} WHERE id = ?`).run(...args);
  const updated = publicListing(db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id));
  send(res, 200, { listing: updated });
});

route('POST', '/api/listings/:id/photos', async (req, res, params) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Listing not found' });
  if (row.owner_id !== user.id) return send(res, 403, { error: 'Not your listing' });

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

  const listingDir = path.join(UPLOADS_DIR, String(params.id));
  fs.mkdirSync(listingDir, { recursive: true });

  const savedPaths = [];
  for (const f of imageFiles) {
    const ext = ALLOWED_IMAGE_TYPES[f.contentType];
    const fname = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(listingDir, fname), f.data);
    savedPaths.push(`/uploads/listings/${params.id}/${fname}`);
  }

  const allPhotos = existingPhotos.concat(savedPaths);
  db.prepare('UPDATE listings SET photos = ? WHERE id = ?').run(JSON.stringify(allPhotos), params.id);
  const updated = publicListing(db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id));
  send(res, 200, { listing: updated });
});

route('GET', '/api/my-listings', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners have listings' });
  const rows = db.prepare('SELECT * FROM listings WHERE owner_id = ? ORDER BY created_at DESC').all(user.id);
  send(res, 200, { listings: rows.map(publicListing) });
});

// --- Inquiries (no-login "Contact Owner" leads) ---

route('POST', '/api/listings/:id/inquiries', async (req, res, params) => {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(params.id);
  if (!listing) return send(res, 404, { error: 'Listing not found' });

  const body = await readBody(req);
  const { name, email, phone, social, message } = body;
  if (!name || !name.trim()) return send(res, 400, { error: 'Name is required' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return send(res, 400, { error: 'A valid email is required' });
  }

  const info = db.prepare(`
    INSERT INTO inquiries (listing_id, name, email, phone, social, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, name.trim(), email.trim(), phone || '', social || '', message || '', new Date().toISOString());

  const created = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(Number(info.lastInsertRowid));
  send(res, 201, { inquiry: created });

  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(listing.owner_id);
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
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners receive inquiries' });

  const rows = db.prepare(`
    SELECT i.* FROM inquiries i
    JOIN listings l ON i.listing_id = l.id
    WHERE l.owner_id = ?
    ORDER BY i.created_at DESC
  `).all(user.id);

  const inquiries = rows.map((row) => {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
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
  });
  send(res, 200, { inquiries });
});

// --- Requests (rental requests) ---

route('POST', '/api/requests', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'barber') return send(res, 403, { error: 'Only barbers can send rental requests' });

  const body = await readBody(req);
  const { listing_id, start_date, end_date, message } = body;
  if (!listing_id) return send(res, 400, { error: 'listing_id is required' });
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listing_id);
  if (!listing) return send(res, 404, { error: 'Listing not found' });
  if (listing.owner_id === user.id) return send(res, 400, { error: "You can't request your own listing" });

  const info = db.prepare(`
    INSERT INTO requests (listing_id, barber_id, status, start_date, end_date, message, created_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?)
  `).run(listing_id, user.id, start_date || null, end_date || null, message || '', new Date().toISOString());

  const reqId = Number(info.lastInsertRowid);
  if (message) {
    db.prepare('INSERT INTO messages (request_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(reqId, user.id, message, new Date().toISOString());
  }
  const created = db.prepare('SELECT * FROM requests WHERE id = ?').get(reqId);
  send(res, 201, { request: created });

  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(listing.owner_id);
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

function enrichRequest(row) {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const barber = db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(row.barber_id);
  const owner = listing ? db.prepare('SELECT id, name, email, phone FROM users WHERE id = ?').get(listing.owner_id) : null;
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
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const rows = db.prepare('SELECT * FROM requests WHERE barber_id = ? ORDER BY created_at DESC').all(user.id);
  send(res, 200, { requests: rows.map(enrichRequest) });
});

route('GET', '/api/requests/received', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  if (user.role !== 'owner') return send(res, 403, { error: 'Only space owners receive requests' });
  const rows = db.prepare(`
    SELECT r.* FROM requests r
    JOIN listings l ON r.listing_id = l.id
    WHERE l.owner_id = ?
    ORDER BY r.created_at DESC
  `).all(user.id);
  send(res, 200, { requests: rows.map(enrichRequest) });
});

route('PATCH', '/api/requests/:id', async (req, res, params) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);

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

  db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, params.id);
  const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  send(res, 200, { request: enrichRequest(updated) });

  if (['approved', 'declined'].includes(status)) {
    const barber = db.prepare('SELECT * FROM users WHERE id = ?').get(row.barber_id);
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
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const isParty = row.barber_id === user.id || (listing && listing.owner_id === user.id);
  if (!isParty) return send(res, 403, { error: 'Not part of this conversation' });

  const rows = db.prepare('SELECT * FROM messages WHERE request_id = ? ORDER BY created_at ASC').all(params.id);
  const messages = rows.map((m) => {
    const sender = db.prepare('SELECT id, name FROM users WHERE id = ?').get(m.sender_id);
    return { id: m.id, body: m.body, created_at: m.created_at, sender };
  });
  send(res, 200, { messages });
});

route('POST', '/api/requests/:id/messages', async (req, res, params) => {
  const user = getSessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(row.listing_id);
  const isParty = row.barber_id === user.id || (listing && listing.owner_id === user.id);
  if (!isParty) return send(res, 403, { error: 'Not part of this conversation' });

  const body = await readBody(req);
  if (!body.body || !body.body.trim()) return send(res, 400, { error: 'Message body is required' });

  const info = db.prepare('INSERT INTO messages (request_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(params.id, user.id, body.body.trim(), new Date().toISOString());
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
  const sender = db.prepare('SELECT id, name FROM users WHERE id = ?').get(user.id);
  send(res, 201, { message: { id: m.id, body: m.body, created_at: m.created_at, sender } });

  const otherUserId = row.barber_id === user.id ? (listing ? listing.owner_id : null) : row.barber_id;
  if (otherUserId) {
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherUserId);
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

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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
    // Uploaded photos have unique, never-reused filenames, so they're safe to
    // cache "forever". CSS/JS/HTML aren't filename-versioned, so we always
    // revalidate (ETag) rather than risk serving a stale asset after a deploy.
    const isUpload = pathname.startsWith('/uploads/');
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
        'Cache-Control': isUpload ? 'public, max-age=31536000, immutable' : 'no-cache',
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
</head>
<body>
  <header class="site">
    <div class="container">
      <div class="logo" onclick="App.nav('/')">Chair<span>Space</span></div>
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
  <script src="/app.js"></script>
</body>
</html>`;
}

function buildSitemap(req) {
  const host = req.headers.host || 'chairspace.onrender.com';
  const base = `https://${host}`;
  const rows = db.prepare('SELECT id, created_at FROM listings WHERE active = 1').all();
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
      return res.end(buildSitemap(req));
    }
    if (req.method === 'GET' && pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(buildRobots(req));
    }
    const listingMatch = pathname.match(/^\/listing\/(\d+)\/?$/);
    if (req.method === 'GET' && listingMatch) {
      const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingMatch[1]);
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

server.listen(PORT, () => {
  console.log(`ChairSpace running at http://localhost:${PORT}`);
});
