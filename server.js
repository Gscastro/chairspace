// server.js — ChairSpace API + static server. Pure Node built-ins, no npm deps.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, hashPassword } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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
    amenities: row.amenities ? JSON.parse(row.amenities) : [],
    photo_seed: row.photo_seed,
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
    sql += ' AND LOWER(city) LIKE ?';
    args.push('%' + query.city.toLowerCase() + '%');
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
  const { title, description, address, city, state, zip, price, price_unit, chair_type, amenities } = body;
  if (!title || !city || !state || !price || !price_unit || !chair_type) {
    return send(res, 400, { error: 'title, city, state, price, price_unit, and chair_type are required' });
  }
  if (!['hour', 'day', 'week', 'month'].includes(price_unit)) {
    return send(res, 400, { error: 'price_unit must be one of hour, day, week, month' });
  }
  const photo_seed = 'l' + Date.now() + Math.floor(Math.random() * 1000);
  const info = db.prepare(`
    INSERT INTO listings (owner_id, title, description, address, city, state, zip, price, price_unit, chair_type, amenities, photo_seed, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(user.id, title, description || '', address || '', city, state, zip || '', Number(price), price_unit, chair_type, JSON.stringify(amenities || []), photo_seed, new Date().toISOString());

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
  for (const key of ['title', 'description', 'address', 'city', 'state', 'zip', 'price', 'price_unit', 'chair_type', 'active']) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`);
      args.push(key === 'active' ? (body.active ? 1 : 0) : body[key]);
    }
  }
  if (body.amenities !== undefined) {
    fields.push('amenities = ?');
    args.push(JSON.stringify(body.amenities));
  }
  if (fields.length === 0) return send(res, 400, { error: 'No fields to update' });
  args.push(params.id);
  db.prepare(`UPDATE listings SET ${fields.join(', ')} WHERE id = ?`).run(...args);
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
});

// ---------- static file serving ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
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
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- main request handler ----------

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  if (!pathname.startsWith('/api/')) {
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
