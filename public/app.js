// app.js — ChairSpace frontend. Vanilla JS, no build step, no framework.

const App = (() => {
  const state = {
    token: localStorage.getItem('chairspace_token') || null,
    user: null,
    booting: true,
  };

  const $app = () => document.getElementById('app');
  const $nav = () => document.getElementById('nav');

  const CHAIR_TYPES = ['Booth rent', 'Chair rental', 'Private suite', 'Shared station'];
  const AMENITY_OPTIONS = [
    'WiFi', 'Free parking', 'Product storage', 'Washer/dryer', 'Reception/front desk',
    'Private entrance', 'Laundry', '24/7 access', 'Security system', 'Skylight/natural light',
    'Wheelchair accessible',
  ];

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function unitLabel(u) {
    return { hour: '/hr', day: '/day', week: '/wk', month: '/mo' }[u] || '';
  }

  function photoUrl(seed, w = 400, h = 300) {
    return `https://picsum.photos/seed/${encodeURIComponent(seed || 'chairspace')}/${w}/${h}`;
  }

  // Renders a photo area that falls back to a tasteful placeholder (no broken-image
  // icon) if the remote image host can't be reached.
  function photoBlock(seed, opts = {}) {
    const { w = 400, h = 300, tall = false, alt = '' } = opts;
    return `
      <div class="photo-wrap${tall ? ' tall' : ''}">
        <span>💈</span>
        <img src="${photoUrl(seed, w, h)}" alt="${escapeHtml(alt)}" loading="lazy" onerror="this.remove()" />
      </div>
    `;
  }

  function timeAgo(iso) {
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  // ---------- API ----------
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- routing ----------
  function nav(path) {
    window.location.hash = '#' + path;
  }

  function parseHash() {
    let hash = window.location.hash.slice(1) || '/';
    const [pathPart, queryPart] = hash.split('?');
    const query = {};
    if (queryPart) {
      for (const pair of queryPart.split('&')) {
        const [k, v] = pair.split('=');
        if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    return { path: pathPart || '/', query };
  }

  async function router() {
    const { path, query } = parseHash();
    renderNav();
    const segs = path.split('/').filter(Boolean);

    try {
      if (segs.length === 0) return renderHome(query);
      if (segs[0] === 'listing' && segs[1]) return renderListingDetail(segs[1]);
      if (segs[0] === 'login') return renderLogin();
      if (segs[0] === 'signup') return renderSignup();
      if (segs[0] === 'dashboard') return renderDashboard();
      if (segs[0] === 'post-listing') return renderPostListing();
      if (segs[0] === 'edit-listing' && segs[1]) return renderPostListing(segs[1]);
      if (segs[0] === 'requests' && segs[1]) return renderThread(segs[1]);
      return renderNotFound();
    } catch (e) {
      $app().innerHTML = `<p class="msg">Something went wrong: ${escapeHtml(e.message)}</p>`;
    }
  }

  // ---------- nav bar ----------
  function renderNav() {
    if (!state.user) {
      $nav().innerHTML = `
        <a onclick="App.nav('/')">Browse Chairs</a>
        <button class="link" onclick="App.nav('/login')">Log in</button>
        <button class="pill-btn" onclick="App.nav('/signup')">Sign up</button>
      `;
      return;
    }
    const dashLabel = state.user.role === 'owner' ? 'My Listings' : 'My Requests';
    $nav().innerHTML = `
      <a onclick="App.nav('/')">Browse Chairs</a>
      ${state.user.role === 'owner' ? `<a onclick="App.nav('/post-listing')">+ Post a Listing</a>` : ''}
      <a onclick="App.nav('/dashboard')">${dashLabel}</a>
      <span style="color:#cfc7ba;font-size:0.85rem;">Hi, ${escapeHtml(state.user.name.split(' ')[0])}</span>
      <button class="pill-btn ghost small" onclick="App.logout()">Log out</button>
    `;
  }

  // ---------- home / browse ----------
  async function renderHome(query) {
    $app().innerHTML = `
      <div class="hero" style="margin: -28px 0 0; border-radius: var(--radius);">
        <div class="container" style="padding-left:0;padding-right:0;">
          <h1>Find your next chair.</h1>
          <p class="sub">Browse booths, chairs, and private suites available to rent from barbershops and salons.</p>
          <form class="search-bar" onsubmit="App.searchSubmit(event)">
            <input name="city" placeholder="City (e.g. Austin)" value="${escapeHtml(query.city || '')}" />
            <select name="chair_type">
              <option value="">Any space type</option>
              ${CHAIR_TYPES.map(t => `<option value="${t}" ${query.chair_type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
            <select name="price_unit">
              <option value="">Any billing period</option>
              <option value="hour" ${query.price_unit === 'hour' ? 'selected' : ''}>Hourly</option>
              <option value="day" ${query.price_unit === 'day' ? 'selected' : ''}>Daily</option>
              <option value="week" ${query.price_unit === 'week' ? 'selected' : ''}>Weekly</option>
              <option value="month" ${query.price_unit === 'month' ? 'selected' : ''}>Monthly</option>
            </select>
            <input name="max_price" type="number" min="0" placeholder="Max price" value="${escapeHtml(query.max_price || '')}" />
            <button class="pill-btn" type="submit">Search</button>
          </form>
        </div>
      </div>
      <h2 class="section-title">Available spots</h2>
      <div id="listing-results" class="grid"><p class="spinner-note">Loading listings...</p></div>
    `;

    const params = new URLSearchParams();
    if (query.city) params.set('city', query.city);
    if (query.chair_type) params.set('chair_type', query.chair_type);
    if (query.price_unit) params.set('price_unit', query.price_unit);
    if (query.max_price) params.set('max_price', query.max_price);

    try {
      const { listings } = await api('/api/listings?' + params.toString());
      const el = document.getElementById('listing-results');
      if (!el) return; // user navigated away
      if (listings.length === 0) {
        el.innerHTML = `<div class="empty-state">No listings match those filters yet. Try widening your search.</div>`;
        return;
      }
      el.innerHTML = listings.map(listingCard).join('');
    } catch (e) {
      const el = document.getElementById('listing-results');
      if (el) el.innerHTML = `<p class="msg">Couldn't load listings: ${escapeHtml(e.message)}</p>`;
    }
  }

  function listingCard(l) {
    return `
      <div class="card" onclick="App.nav('/listing/${l.id}')">
        ${photoBlock(l.photo_seed, { alt: l.title })}
        <div class="card-body">
          <span class="badge">${escapeHtml(l.chair_type)}</span>
          <h3>${escapeHtml(l.title)}</h3>
          <div class="card-meta">${escapeHtml(l.city)}, ${escapeHtml(l.state)} &middot; hosted by ${escapeHtml(l.owner_name)}</div>
          <div class="price-tag">${money(l.price)}${unitLabel(l.price_unit)}</div>
        </div>
      </div>
    `;
  }

  function searchSubmit(evt) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const q = new URLSearchParams();
    for (const [k, v] of f.entries()) if (v) q.set(k, v);
    nav('/?' + q.toString());
  }

  // ---------- listing detail ----------
  async function renderListingDetail(id) {
    $app().innerHTML = `<p class="spinner-note">Loading listing...</p>`;
    let data;
    try {
      data = await api('/api/listings/' + id);
    } catch (e) {
      $app().innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
      return;
    }
    const l = data.listing;
    const isOwnerOfThis = state.user && state.user.role === 'owner' && state.user.id === l.owner_id;
    const canRequest = state.user && state.user.role === 'barber';

    $app().innerHTML = `
      <div class="detail-grid">
        <div>
          <div class="detail-photo">${photoBlock(l.photo_seed, { w: 900, h: 500, tall: true, alt: l.title })}</div>
          <span class="badge">${escapeHtml(l.chair_type)}</span>
          ${!l.active ? '<span class="badge status-declined">Inactive</span>' : ''}
          <h1 style="margin:8px 0 2px;">${escapeHtml(l.title)}</h1>
          <div class="card-meta">${escapeHtml(l.address ? l.address + ', ' : '')}${escapeHtml(l.city)}, ${escapeHtml(l.state)} ${escapeHtml(l.zip || '')}</div>
          <p>${escapeHtml(l.description || 'No description provided.')}</p>
          <h3>Amenities</h3>
          <div class="amenity-list">
            ${l.amenities.length ? l.amenities.map(a => `<span class="amenity-chip">${escapeHtml(a)}</span>`).join('') : '<span class="card-meta">None listed</span>'}
          </div>
          <h3>Hosted by</h3>
          <p class="card-meta">${escapeHtml(l.owner.name)}${l.owner.bio ? ' — ' + escapeHtml(l.owner.bio) : ''}</p>
        </div>
        <div>
          <div class="side-card">
            <div class="price-tag">${money(l.price)}${unitLabel(l.price_unit)}</div>
            <div id="request-area" style="margin-top:14px;"></div>
          </div>
        </div>
      </div>
    `;

    const area = document.getElementById('request-area');
    if (isOwnerOfThis) {
      area.innerHTML = `
        <p class="card-meta">This is your listing.</p>
        <div style="display:flex; gap:8px; flex-direction:column;">
          <button class="pill-btn" onclick="App.nav('/edit-listing/${l.id}')">Edit listing</button>
          <button class="pill-btn ghost" onclick="App.toggleActive(${l.id}, ${l.active})">${l.active ? 'Mark inactive' : 'Mark active'}</button>
        </div>
      `;
    } else if (canRequest) {
      area.innerHTML = `
        <form class="stack" onsubmit="App.sendRequest(event, ${l.id})">
          <div class="field"><label>Start date</label><input type="date" name="start_date" /></div>
          <div class="field"><label>End date (optional)</label><input type="date" name="end_date" /></div>
          <div class="field"><label>Message to owner</label><textarea name="message" placeholder="Tell them a bit about yourself and what you're looking for..."></textarea></div>
          <button class="pill-btn" type="submit">Request to rent</button>
          <div id="request-msg"></div>
        </form>
      `;
    } else if (!state.user) {
      area.innerHTML = `
        <p class="card-meta">Log in as a barber to request this spot.</p>
        <button class="pill-btn" onclick="App.nav('/login')">Log in</button>
        <button class="pill-btn ghost" onclick="App.nav('/signup')" style="margin-top:8px;">Sign up as a barber</button>
      `;
    } else {
      area.innerHTML = `<p class="card-meta">Space owner accounts can't request other listings — log in as a barber to request this spot.</p>`;
    }
  }

  async function toggleActive(id, currentlyActive) {
    try {
      await api('/api/listings/' + id, { method: 'PATCH', body: { active: !currentlyActive } });
      renderListingDetail(id);
    } catch (e) {
      alert(e.message);
    }
  }

  async function sendRequest(evt, listingId) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const msgEl = document.getElementById('request-msg');
    try {
      await api('/api/requests', {
        method: 'POST',
        body: {
          listing_id: listingId,
          start_date: f.get('start_date') || null,
          end_date: f.get('end_date') || null,
          message: f.get('message') || '',
        },
      });
      msgEl.innerHTML = `<p class="msg ok">Request sent! Track it from "My Requests".</p>`;
      evt.target.reset();
    } catch (e) {
      msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  // ---------- auth ----------
  function renderLogin() {
    $app().innerHTML = `
      <div class="card auth">
        <h2>Log in</h2>
        <form class="stack" onsubmit="App.doLogin(event)">
          <div class="field"><label>Email</label><input type="email" name="email" required /></div>
          <div class="field"><label>Password</label><input type="password" name="password" required /></div>
          <button class="pill-btn" type="submit">Log in</button>
          <div id="auth-msg"></div>
        </form>
        <p class="card-meta" style="margin-top:14px;">No account? <a href="#/signup" style="color:var(--amber-dark); font-weight:700;">Sign up</a></p>
        <p class="card-meta" style="margin-top:18px;">Try it: <b>marcus@fadedistrict.com</b> (owner) or <b>jordan@example.com</b> (barber), password <b>password123</b></p>
      </div>
    `;
  }

  async function doLogin(evt) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const msgEl = document.getElementById('auth-msg');
    try {
      const data = await api('/api/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('chairspace_token', data.token);
      nav('/dashboard');
    } catch (e) {
      msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  let signupRole = 'barber';
  function renderSignup() {
    $app().innerHTML = `
      <div class="card auth">
        <h2>Sign up</h2>
        <div class="role-toggle">
          <button type="button" id="role-barber" class="active" onclick="App.setSignupRole('barber')">I'm a barber</button>
          <button type="button" id="role-owner" onclick="App.setSignupRole('owner')">I have a space to rent out</button>
        </div>
        <form class="stack" onsubmit="App.doSignup(event)" style="margin-top:10px;">
          <div class="field"><label>Full name</label><input type="text" name="name" required /></div>
          <div class="field"><label>Email</label><input type="email" name="email" required /></div>
          <div class="field"><label>Password</label><input type="password" name="password" required minlength="6" /></div>
          <div class="field"><label>Phone (optional)</label><input type="tel" name="phone" /></div>
          <div class="field"><label>Short bio (optional)</label><textarea name="bio" placeholder="${signupRole === 'owner' ? 'Tell barbers about your shop...' : 'Tell shop owners about your experience...'}"></textarea></div>
          <button class="pill-btn" type="submit">Create account</button>
          <div id="auth-msg"></div>
        </form>
        <p class="card-meta" style="margin-top:14px;">Already have an account? <a href="#/login" style="color:var(--amber-dark); font-weight:700;">Log in</a></p>
      </div>
    `;
  }

  function setSignupRole(role) {
    signupRole = role;
    document.getElementById('role-barber').classList.toggle('active', role === 'barber');
    document.getElementById('role-owner').classList.toggle('active', role === 'owner');
  }

  async function doSignup(evt) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const msgEl = document.getElementById('auth-msg');
    try {
      const data = await api('/api/signup', {
        method: 'POST',
        body: {
          name: f.get('name'), email: f.get('email'), password: f.get('password'),
          role: signupRole, phone: f.get('phone'), bio: f.get('bio'),
        },
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('chairspace_token', data.token);
      nav(signupRole === 'owner' ? '/post-listing' : '/');
    } catch (e) {
      msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  function logout() {
    api('/api/logout', { method: 'POST' }).catch(() => {});
    state.token = null;
    state.user = null;
    localStorage.removeItem('chairspace_token');
    nav('/');
  }

  // ---------- post / edit listing ----------
  async function renderPostListing(editId) {
    if (!state.user || state.user.role !== 'owner') {
      $app().innerHTML = `<p class="msg">Only space-owner accounts can post listings. <a href="#/signup" style="color:var(--amber-dark);font-weight:700;">Sign up as an owner</a> or <a href="#/login" style="color:var(--amber-dark);font-weight:700;">log in</a>.</p>`;
      return;
    }
    let existing = null;
    if (editId) {
      try {
        const data = await api('/api/listings/' + editId);
        existing = data.listing;
        if (existing.owner_id !== state.user.id) {
          $app().innerHTML = `<p class="msg">You can only edit your own listings.</p>`;
          return;
        }
      } catch (e) {
        $app().innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
        return;
      }
    }
    const e = existing || {};
    $app().innerHTML = `
      <h1>${editId ? 'Edit listing' : 'Post a new listing'}</h1>
      <form class="stack" onsubmit="App.saveListing(event, ${editId ? editId : 'null'})">
        <div class="field"><label>Title</label><input type="text" name="title" required value="${escapeHtml(e.title || '')}" placeholder="e.g. Open booth in busy East Austin shop" /></div>
        <div class="field"><label>Description</label><textarea name="description" placeholder="Describe the space, the shop, expectations...">${escapeHtml(e.description || '')}</textarea></div>
        <div class="row-2">
          <div class="field"><label>City</label><input type="text" name="city" required value="${escapeHtml(e.city || '')}" /></div>
          <div class="field"><label>State</label><input type="text" name="state" required value="${escapeHtml(e.state || '')}" maxlength="2" placeholder="TX" /></div>
        </div>
        <div class="row-2">
          <div class="field"><label>Street address (optional)</label><input type="text" name="address" value="${escapeHtml(e.address || '')}" /></div>
          <div class="field"><label>ZIP (optional)</label><input type="text" name="zip" value="${escapeHtml(e.zip || '')}" /></div>
        </div>
        <div class="row-2">
          <div class="field"><label>Price</label><input type="number" name="price" min="0" step="1" required value="${e.price || ''}" /></div>
          <div class="field"><label>Billing period</label>
            <select name="price_unit" required>
              <option value="">Choose one</option>
              <option value="hour" ${e.price_unit === 'hour' ? 'selected' : ''}>Per hour</option>
              <option value="day" ${e.price_unit === 'day' ? 'selected' : ''}>Per day</option>
              <option value="week" ${e.price_unit === 'week' ? 'selected' : ''}>Per week</option>
              <option value="month" ${e.price_unit === 'month' ? 'selected' : ''}>Per month</option>
            </select>
          </div>
        </div>
        <div class="field"><label>Space type</label>
          <select name="chair_type" required>
            <option value="">Choose one</option>
            ${CHAIR_TYPES.map(t => `<option value="${t}" ${e.chair_type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Amenities</label>
          <div class="checkbox-grid">
            ${AMENITY_OPTIONS.map(a => `<label><input type="checkbox" name="amenities" value="${a}" ${(e.amenities || []).includes(a) ? 'checked' : ''}/> ${a}</label>`).join('')}
          </div>
        </div>
        <button class="pill-btn" type="submit">${editId ? 'Save changes' : 'Publish listing'}</button>
        <div id="listing-msg"></div>
      </form>
    `;
  }

  async function saveListing(evt, editId) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const amenities = f.getAll('amenities');
    const msgEl = document.getElementById('listing-msg');
    const payload = {
      title: f.get('title'), description: f.get('description'),
      city: f.get('city'), state: f.get('state'), address: f.get('address'), zip: f.get('zip'),
      price: Number(f.get('price')), price_unit: f.get('price_unit'), chair_type: f.get('chair_type'),
      amenities,
    };
    try {
      let listing;
      if (editId) {
        const data = await api('/api/listings/' + editId, { method: 'PATCH', body: payload });
        listing = data.listing;
      } else {
        const data = await api('/api/listings', { method: 'POST', body: payload });
        listing = data.listing;
      }
      nav('/listing/' + listing.id);
    } catch (e) {
      msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  // ---------- dashboard ----------
  async function renderDashboard() {
    if (!state.user) {
      $app().innerHTML = `<p class="msg">Log in to see your dashboard. <a href="#/login" style="color:var(--amber-dark);font-weight:700;">Log in</a></p>`;
      return;
    }
    if (state.user.role === 'owner') return renderOwnerDashboard();
    return renderBarberDashboard();
  }

  async function renderOwnerDashboard() {
    $app().innerHTML = `
      <h1>My Listings &amp; Requests</h1>
      <div class="tabs">
        <button id="tab-listings" class="active" onclick="App.showOwnerTab('listings')">My Listings</button>
        <button id="tab-requests" onclick="App.showOwnerTab('requests')">Requests Received</button>
      </div>
      <div id="tab-content"><p class="spinner-note">Loading...</p></div>
    `;
    showOwnerTab('listings');
  }

  let lastOwnerTab = 'listings';
  async function showOwnerTab(tab) {
    lastOwnerTab = tab;
    document.getElementById('tab-listings').classList.toggle('active', tab === 'listings');
    document.getElementById('tab-requests').classList.toggle('active', tab === 'requests');
    const content = document.getElementById('tab-content');
    content.innerHTML = `<p class="spinner-note">Loading...</p>`;
    try {
      if (tab === 'listings') {
        const { listings } = await api('/api/my-listings');
        if (listings.length === 0) {
          content.innerHTML = `<div class="empty-state">You haven't posted any listings yet.<br/><button class="pill-btn" style="margin-top:12px;" onclick="App.nav('/post-listing')">+ Post your first listing</button></div>`;
          return;
        }
        content.innerHTML = `<div class="grid">${listings.map(listingCard).join('')}</div>`;
      } else {
        const { requests } = await api('/api/requests/received');
        if (requests.length === 0) {
          content.innerHTML = `<div class="empty-state">No rental requests yet.</div>`;
          return;
        }
        content.innerHTML = requests.map(requestRow('owner')).join('');
      }
    } catch (e) {
      content.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  async function renderBarberDashboard() {
    $app().innerHTML = `
      <h1>My Requests</h1>
      <div id="tab-content"><p class="spinner-note">Loading...</p></div>
    `;
    const content = document.getElementById('tab-content');
    try {
      const { requests } = await api('/api/requests/sent');
      if (requests.length === 0) {
        content.innerHTML = `<div class="empty-state">You haven't requested any chairs yet.<br/><button class="pill-btn" style="margin-top:12px;" onclick="App.nav('/')">Browse listings</button></div>`;
        return;
      }
      content.innerHTML = requests.map(requestRow('barber')).join('');
    } catch (e) {
      content.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  function requestRow(viewerRole) {
    return (r) => {
      const otherParty = viewerRole === 'owner' ? r.barber : r.owner;
      const dateRange = [r.start_date, r.end_date].filter(Boolean).join(' → ');
      const listingTitle = r.listing ? r.listing.title : '(listing removed)';
      let actions = `<button class="pill-btn ghost small" onclick="App.nav('/requests/${r.id}')">Message</button>`;
      if (viewerRole === 'owner' && r.status === 'pending') {
        actions = `
          <button class="pill-btn small" onclick="App.updateRequest(${r.id}, 'approved')">Approve</button>
          <button class="pill-btn ghost small" onclick="App.updateRequest(${r.id}, 'declined')">Decline</button>
          ` + actions;
      }
      if (viewerRole === 'barber' && r.status === 'pending') {
        actions += ` <button class="pill-btn ghost small" onclick="App.updateRequest(${r.id}, 'cancelled')">Cancel</button>`;
      }
      return `
        <div class="request-row">
          <div class="info">
            <div><a onclick="App.nav('/listing/${r.listing ? r.listing.id : ''}')" style="font-weight:700; cursor:pointer;">${escapeHtml(listingTitle)}</a> <span class="badge status-${r.status}">${r.status}</span></div>
            <div class="card-meta">${viewerRole === 'owner' ? 'From' : 'To'} ${escapeHtml(otherParty ? otherParty.name : 'Unknown')}${dateRange ? ' &middot; ' + escapeHtml(dateRange) : ''} &middot; ${timeAgo(r.created_at)}</div>
          </div>
          <div class="actions">${actions}</div>
        </div>
      `;
    };
  }

  async function updateRequest(id, status) {
    try {
      await api('/api/requests/' + id, { method: 'PATCH', body: { status } });
      // refresh in place rather than re-running the router (which would reset dashboard tabs)
      const { path } = parseHash();
      if (path === '/dashboard' && state.user.role === 'owner') {
        showOwnerTab(lastOwnerTab);
      } else if (path.startsWith('/requests/')) {
        renderThread(id);
      } else {
        router();
      }
    } catch (e) {
      alert(e.message);
    }
  }

  // ---------- messaging thread ----------
  async function renderThread(id) {
    $app().innerHTML = `<p class="spinner-note">Loading conversation...</p>`;
    let msgData, requests;
    try {
      msgData = await api('/api/requests/' + id + '/messages');
      // fetch request context from whichever list applies
      const mine = state.user.role === 'owner' ? await api('/api/requests/received') : await api('/api/requests/sent');
      requests = mine.requests;
    } catch (e) {
      $app().innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
      return;
    }
    const r = requests.find(x => x.id == id);
    const header = r ? `
      <h2 style="margin-bottom:2px;">${escapeHtml(r.listing ? r.listing.title : 'Conversation')}</h2>
      <p class="card-meta">Status: <span class="badge status-${r.status}">${r.status}</span>
        ${state.user.role === 'owner' && r.status === 'pending' ? `
          <button class="pill-btn small" style="margin-left:8px;" onclick="App.updateRequest(${r.id}, 'approved')">Approve</button>
          <button class="pill-btn ghost small" onclick="App.updateRequest(${r.id}, 'declined')">Decline</button>
        ` : ''}
      </p>
    ` : '<h2>Conversation</h2>';

    $app().innerHTML = `
      ${header}
      <div class="thread" id="thread-messages">
        ${msgData.messages.map(m => `
          <div class="bubble ${m.sender.id === state.user.id ? 'mine' : 'theirs'}">
            <div class="who">${escapeHtml(m.sender.name)} &middot; ${timeAgo(m.created_at)}</div>
            ${escapeHtml(m.body)}
          </div>
        `).join('') || '<p class="card-meta">No messages yet.</p>'}
      </div>
      <form class="stack" style="max-width:560px;" onsubmit="App.sendMessage(event, ${id})">
        <textarea name="body" placeholder="Write a message..." required style="padding:10px 12px;border:1px solid var(--line);border-radius:6px;font-family:inherit;min-height:60px;"></textarea>
        <button class="pill-btn" type="submit" style="align-self:flex-start;">Send</button>
      </form>
    `;
  }

  async function sendMessage(evt, requestId) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    try {
      await api('/api/requests/' + requestId + '/messages', { method: 'POST', body: { body: f.get('body') } });
      renderThread(requestId);
    } catch (e) {
      alert(e.message);
    }
  }

  function renderNotFound() {
    $app().innerHTML = `<div class="empty-state">Page not found. <a href="#/" style="color:var(--amber-dark);font-weight:700;">Go home</a></div>`;
  }

  // ---------- boot ----------
  async function boot() {
    if (state.token) {
      try {
        const { user } = await api('/api/me');
        state.user = user;
      } catch (e) {
        state.token = null;
        localStorage.removeItem('chairspace_token');
      }
    }
    state.booting = false;
    window.addEventListener('hashchange', router);
    router();
  }

  boot();

  return {
    nav, searchSubmit, doLogin, doSignup, setSignupRole, logout,
    sendRequest, toggleActive, saveListing, showOwnerTab, updateRequest,
    sendMessage,
  };
})();
