// app.js — ChairSpace frontend. Vanilla JS, no build step, no framework.

const App = (() => {
  const state = {
    token: localStorage.getItem('chairspace_token') || null,
    user: null,
    booting: true,
    favoriteIds: new Set(),
  };

  const POLICY_INFO = {
    flexible: { label: 'Flexible', desc: 'Can cancel anytime before the start date, no hard feelings.' },
    standard: { label: 'Standard', desc: 'Please give at least a few days notice if you need to cancel.' },
    strict: { label: 'Strict', desc: 'Once approved, treat this as a firm commitment — last-minute cancellations affect the shop.' },
  };

  const $app = () => document.getElementById('app');
  const $nav = () => document.getElementById('nav');

  const CHAIR_TYPES = ['Booth rent', 'Chair rental', 'Private suite', 'Shared station'];

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
  // icon) if the remote image host can't be reached. Prefers a real uploaded photo
  // over the placeholder-seed image when the listing has one.
  function photoBlock(listing, opts = {}) {
    const { w = 400, h = 300, tall = false, alt = '' } = opts;
    const real = listing && listing.photos && listing.photos.length ? listing.photos[0] : null;
    const src = real || photoUrl(listing ? listing.photo_seed : null, w, h);
    return `
      <div class="photo-wrap${tall ? ' tall' : ''}">
        <span>💈</span>
        <img src="${src}" alt="${escapeHtml(alt)}" loading="lazy" onerror="this.remove()" />
      </div>
    `;
  }

  function availabilityLabel(available_from) {
    if (!available_from) return 'Available now';
    const d = new Date(available_from + 'T00:00:00');
    if (isNaN(d.getTime())) return 'Available now';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (d.getTime() <= today.getTime()) return 'Available now';
    return 'Available ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

  // ---------- routing (real paths via the History API — not hash routing, so
  // Google can actually crawl and index each listing page) ----------
  function nav(path) {
    const full = path.startsWith('/') ? path : '/' + path;
    if (full !== window.location.pathname + window.location.search) {
      window.history.pushState(null, '', full);
    }
    router();
  }

  function parseLocation() {
    const query = {};
    for (const [k, v] of new URLSearchParams(window.location.search)) {
      query[k] = v;
    }
    return { path: window.location.pathname || '/', query };
  }

  // ---------- mobile nav menu ----------
  function toggleMenu() {
    const navEl = $nav();
    const btn = document.getElementById('menu-toggle');
    const open = navEl ? navEl.classList.toggle('open') : false;
    if (btn) { btn.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); }
  }

  function closeMenu() {
    const navEl = $nav();
    const btn = document.getElementById('menu-toggle');
    if (navEl) navEl.classList.remove('open');
    if (btn) { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
  }

  async function router() {
    closeMenu();
    const { path, query } = parseLocation();
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
        <a href="/" onclick="event.preventDefault(); App.nav('/');">Browse Chairs</a>
        <button class="link" onclick="App.nav('/login')">Log in</button>
        <button class="pill-btn" onclick="App.nav('/signup')">Sign up</button>
      `;
      return;
    }
    const dashLabel = state.user.role === 'owner' ? 'My Listings' : 'My Requests';
    $nav().innerHTML = `
      <a href="/" onclick="event.preventDefault(); App.nav('/');">Browse Chairs</a>
      ${state.user.role === 'owner' ? `<a href="/post-listing" onclick="event.preventDefault(); App.nav('/post-listing');">+ Post a Listing</a>` : ''}
      <a href="/dashboard" onclick="event.preventDefault(); App.nav('/dashboard');">${dashLabel}</a>
      <span class="nav-greeting">Hi, ${escapeHtml(state.user.name.split(' ')[0])}</span>
      <button class="pill-btn ghost small" onclick="App.logout()">Log out</button>
    `;
  }

  // ---------- home / browse ----------
  async function renderHome(query) {
    $app().innerHTML = `
      <div class="hero">
        <h1>Find your next chair.</h1>
        <p class="sub">Search open booths, chairs, and private suites at barbershops and salons near you — request a spot and hear back from the owner directly.</p>
        <form class="search-bar" onsubmit="App.searchSubmit(event)">
          <input name="city" placeholder="City or ZIP code" value="${escapeHtml(query.city || '')}" />
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
          <div class="field-slider">
            <label for="max_price_slider">Max weekly rent: <span id="price-slider-val">${query.max_price && query.max_price < 2000 ? money(query.max_price) : 'Any'}</span></label>
            <input id="max_price_slider" name="max_price" type="range" min="0" max="2000" step="25"
              value="${escapeHtml(query.max_price || '2000')}"
              oninput="document.getElementById('price-slider-val').textContent = this.value >= 2000 ? 'Any' : ('$' + this.value)" />
          </div>
          <label class="check-inline">
            <input type="checkbox" name="available_only" value="1" ${query.available_only ? 'checked' : ''} />
            Available now only
          </label>
          <button class="pill-btn" type="submit">Search</button>
          ${state.user && state.user.role === 'barber' ? `<button type="button" class="pill-btn ghost" onclick="App.saveCurrentSearch()">🔔 Save this search</button>` : ''}
        </form>
      </div>

      <div class="how-it-works">
        <div class="step-grid">
          <div class="step-card">
            <div class="step-num">1</div>
            <h3>Search open spots</h3>
            <p>Filter by city, space type, and price to find a booth, chair, or suite that fits how you work.</p>
          </div>
          <div class="step-card">
            <div class="step-num">2</div>
            <h3>Send a request</h3>
            <p>Tell the owner a bit about yourself and the dates you're looking for — no commitment yet.</p>
          </div>
          <div class="step-card">
            <div class="step-num">3</div>
            <h3>Hear back &amp; move in</h3>
            <p>Once approved, message directly in-app to lock down the details and get to work.</p>
          </div>
        </div>
      </div>

      <h2 class="section-title">Available spots</h2>
      <div id="listing-results" class="grid"><p class="spinner-note">Loading listings...</p></div>
    `;

    const params = new URLSearchParams();
    if (query.city) params.set('city', query.city);
    if (query.chair_type) params.set('chair_type', query.chair_type);
    if (query.price_unit) params.set('price_unit', query.price_unit);
    if (query.max_price && Number(query.max_price) < 2000) params.set('max_price', query.max_price);
    if (query.available_only) params.set('available_only', '1');

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

  function heartButtonHtml(listingId) {
    if (!state.user || state.user.role !== 'barber') return '';
    const active = state.favoriteIds.has(listingId) || state.favoriteIds.has(Number(listingId));
    return `<button type="button" class="favorite-btn${active ? ' active' : ''}" data-listing-id="${listingId}" onclick="App.toggleFavorite(event, ${listingId})" aria-label="${active ? 'Remove from favorites' : 'Save to favorites'}" aria-pressed="${active}">${active ? '♥' : '♡'}</button>`;
  }

  async function toggleFavorite(evt, listingId) {
    evt.preventDefault();
    evt.stopPropagation();
    if (!state.user || state.user.role !== 'barber') return;
    const btn = evt.currentTarget;
    const isActive = state.favoriteIds.has(listingId);
    try {
      if (isActive) {
        await api('/api/favorites/' + listingId, { method: 'DELETE' });
        state.favoriteIds.delete(listingId);
      } else {
        await api('/api/favorites', { method: 'POST', body: { listing_id: listingId } });
        state.favoriteIds.add(listingId);
      }
      const nowActive = state.favoriteIds.has(listingId);
      if (btn) {
        btn.classList.toggle('active', nowActive);
        btn.textContent = nowActive ? '♥' : '♡';
        btn.setAttribute('aria-pressed', String(nowActive));
        btn.setAttribute('aria-label', nowActive ? 'Remove from favorites' : 'Save to favorites');
      }
    } catch (e) {
      alert(e.message);
    }
  }

  function listingCard(l) {
    const avail = availabilityLabel(l.available_from);
    return `
      <a class="card" href="/listing/${l.id}" onclick="event.preventDefault(); App.nav('/listing/${l.id}');">
        ${photoBlock(l, { alt: l.title })}
        ${heartButtonHtml(l.id)}
        <div class="card-body">
          <div class="card-tags">
            <span class="badge">${escapeHtml(l.chair_type)}</span>
            <span class="avail-tag ${avail === 'Available now' ? 'now' : ''}">${escapeHtml(avail)}</span>
          </div>
          <h3>${escapeHtml(l.title)}</h3>
          <div class="card-meta">${escapeHtml(l.city)}, ${escapeHtml(l.state)}${l.total_chairs ? ' &middot; ' + l.total_chairs + '-chair shop' : ''} &middot; hosted by ${escapeHtml(l.owner_name)}</div>
          <div class="price-tag">${money(l.price)}${unitLabel(l.price_unit)}</div>
        </div>
      </a>
    `;
  }

  async function saveCurrentSearch() {
    if (!state.user || state.user.role !== 'barber') return;
    const { query } = parseLocation();
    if (!query.city && !query.chair_type && !query.price_unit && !query.max_price) {
      alert('Add at least one filter (city, space type, billing period, or max price) before saving.');
      return;
    }
    const labelParts = [query.city, query.chair_type, query.max_price ? 'under ' + money(query.max_price) : ''].filter(Boolean);
    try {
      await api('/api/saved-searches', {
        method: 'POST',
        body: {
          label: labelParts.join(' · ') || 'My search',
          city: query.city || null,
          chair_type: query.chair_type || null,
          price_unit: query.price_unit || null,
          max_price: query.max_price || null,
        },
      });
      alert("Saved! We'll email you when a new listing matches.");
    } catch (e) {
      alert(e.message);
    }
  }

  function searchSubmit(evt) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const q = new URLSearchParams();
    for (const [k, v] of f.entries()) {
      if (!v) continue;
      if (k === 'max_price' && Number(v) >= 2000) continue; // slider maxed out = no cap
      q.set(k, v);
    }
    nav('/?' + q.toString());
  }

  // ---------- listing detail ----------
  let heroState = { photos: [], index: 0 };

  function heroSectionHtml(l) {
    const photos = l.photos || [];
    const avail = availabilityLabel(l.available_from);
    const badges = `
      <div class="card-tags">
        <span class="badge">${escapeHtml(l.chair_type)}</span>
        ${!l.active ? '<span class="badge status-declined">Inactive</span>' : ''}
        <span class="avail-tag ${avail === 'Available now' ? 'now' : ''}">${escapeHtml(avail)}</span>
      </div>
    `;
    const overlay = `
      <div class="hero-overlay">
        ${badges}
        <h1>${escapeHtml(l.title)}</h1>
        <div class="hero-meta">${escapeHtml(l.city)}, ${escapeHtml(l.state)}</div>
      </div>
    `;
    let mediaHtml;
    if (photos.length > 1) {
      mediaHtml = `
        <img id="hero-slide-img" class="hero-img" src="${photos[0]}" alt="${escapeHtml(l.title)}" />
        <button type="button" class="hero-arrow left" onclick="App.heroPrev()" aria-label="Previous photo">&#8249;</button>
        <button type="button" class="hero-arrow right" onclick="App.heroNext()" aria-label="Next photo">&#8250;</button>
        <div class="hero-dots">${photos.map((_, i) => `<span class="hero-dot${i === 0 ? ' active' : ''}" onclick="App.heroGoTo(${i})"></span>`).join('')}</div>
      `;
    } else if (photos.length === 1) {
      mediaHtml = `<img class="hero-img" src="${photos[0]}" alt="${escapeHtml(l.title)}" />`;
    } else {
      mediaHtml = `
        <div class="hero-placeholder">
          <span>💈</span>
          <img src="${photoUrl(l.photo_seed, 900, 500)}" alt="${escapeHtml(l.title)}" onerror="this.remove()" />
        </div>
      `;
    }
    return `<div class="hero-wrap">${mediaHtml}${overlay}</div>`;
  }

  // Free OpenStreetMap embed — no API key needed. Lat/lon are geocoded
  // server-side from the listing's address when it's created or edited.
  function mapEmbedHtml(l) {
    if (l.lat == null || l.lon == null) return '';
    const d = 0.01;
    const bbox = [l.lon - d, l.lat - d, l.lon + d, l.lat + d].join('%2C');
    const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${l.lat}%2C${l.lon}`;
    return `<div class="map-embed"><iframe src="${src}" loading="lazy" title="Map of ${escapeHtml(l.city)}, ${escapeHtml(l.state)}"></iframe></div>`;
  }

  function star(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }

  async function loadListingReviews(listingId) {
    const el = document.getElementById('listing-reviews');
    if (!el) return;
    try {
      const { reviews, average, count } = await api('/api/listings/' + listingId + '/reviews');
      if (!document.getElementById('listing-reviews')) return; // navigated away
      if (count === 0) {
        el.innerHTML = '';
        return;
      }
      el.innerHTML = `
        <h3>Reviews <span class="card-meta">(${count})</span></h3>
        <div class="review-avg">${star(Math.round(average))} <span class="card-meta">${average.toFixed(1)} average</span></div>
        <div class="review-list">
          ${reviews.map(r => `
            <div class="review-card">
              <div class="review-stars">${star(r.rating)}</div>
              ${r.comment ? `<p>${escapeHtml(r.comment)}</p>` : ''}
              <div class="card-meta">${escapeHtml(r.author ? r.author.name : 'A barber')} &middot; ${timeAgo(r.created_at)}</div>
            </div>
          `).join('')}
        </div>
      `;
    } catch (e) {
      // non-critical — leave the section empty rather than showing an error
    }
  }

  function updateHeroSlide() {
    const img = document.getElementById('hero-slide-img');
    if (img && heroState.photos.length) img.src = heroState.photos[heroState.index];
    document.querySelectorAll('.hero-dot').forEach((d, i) => d.classList.toggle('active', i === heroState.index));
  }

  function heroNext() {
    if (!heroState.photos.length) return;
    heroState.index = (heroState.index + 1) % heroState.photos.length;
    updateHeroSlide();
  }

  function heroPrev() {
    if (!heroState.photos.length) return;
    heroState.index = (heroState.index - 1 + heroState.photos.length) % heroState.photos.length;
    updateHeroSlide();
  }

  function heroGoTo(i) {
    heroState.index = i;
    updateHeroSlide();
  }

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
    heroState = { photos: (l.photos && l.photos.length > 1) ? l.photos : [], index: 0 };

    $app().innerHTML = `
      <div class="detail-grid">
        <div>
          ${heroSectionHtml(l)}
          <div class="card-meta" style="margin-top:14px;">${escapeHtml(l.address ? l.address + ', ' : '')}${escapeHtml(l.city)}, ${escapeHtml(l.state)} ${escapeHtml(l.zip || '')}${l.total_chairs ? ' &middot; ' + l.total_chairs + '-chair shop' : ''}</div>
          <p>${escapeHtml(l.description || 'No description provided.')}</p>
          ${mapEmbedHtml(l)}
          <h3>Hosted by</h3>
          <p class="card-meta">${escapeHtml(l.owner.name)}${l.owner.bio ? ' — ' + escapeHtml(l.owner.bio) : ''}</p>
        </div>
        <div>
          <div class="side-card">
            <div class="price-tag-row">
              <div class="price-tag">${money(l.price)}${unitLabel(l.price_unit)}</div>
              ${canRequest ? `<button type="button" class="favorite-btn detail${state.favoriteIds.has(l.id) ? ' active' : ''}" onclick="App.toggleFavorite(event, ${l.id})" aria-label="${state.favoriteIds.has(l.id) ? 'Remove from favorites' : 'Save to favorites'}" aria-pressed="${state.favoriteIds.has(l.id)}">${state.favoriteIds.has(l.id) ? '♥' : '♡'}</button>` : ''}
            </div>
            <p class="card-meta cancellation-note"><b>${POLICY_INFO[l.cancellation_policy] ? POLICY_INFO[l.cancellation_policy].label : 'Standard'} cancellation</b> — ${escapeHtml(POLICY_INFO[l.cancellation_policy] ? POLICY_INFO[l.cancellation_policy].desc : POLICY_INFO.standard.desc)}</p>
            ${!isOwnerOfThis ? `<button class="pill-btn contact-owner-btn" type="button" onclick="App.openContactModal(${l.id})">Contact Owner</button>` : ''}
            <div id="request-area" style="margin-top:14px;"></div>
          </div>
        </div>
      </div>
      <div id="listing-reviews"></div>
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

    loadListingReviews(l.id);
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

  // ---------- contact owner popup (no login required) ----------
  function openContactModal(listingId) {
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if (event.target === this) App.closeContactModal()">
        <div class="modal-card">
          <button type="button" class="modal-close" onclick="App.closeContactModal()" aria-label="Close">&times;</button>
          <h2>Interested in this booth?</h2>
          <p class="card-meta">Send your info straight to the shop owner — no account needed.</p>
          <form class="stack" onsubmit="App.submitInquiry(event, ${listingId})">
            <div class="field"><label>Name</label><input type="text" name="name" required /></div>
            <div class="field"><label>Email</label><input type="email" name="email" required /></div>
            <div class="field"><label>Phone number</label><input type="tel" name="phone" /></div>
            <div class="field"><label>Social media (optional)</label><input type="text" name="social" placeholder="@yourhandle" /></div>
            <div class="field"><label>Tell them a bit about you</label><textarea name="message" placeholder="How many years you've been cutting, what you specialize in, any awards or achievements..."></textarea></div>
            <div class="modal-actions">
              <button class="pill-btn" type="submit">Notify Shop Owner</button>
              <button class="pill-btn ghost" type="button" onclick="App.closeContactModal()">No thanks</button>
            </div>
            <div id="inquiry-msg"></div>
          </form>
        </div>
      </div>
    `;
    document.body.style.overflow = 'hidden';
  }

  function closeContactModal() {
    const root = document.getElementById('modal-root');
    if (root) root.innerHTML = '';
    document.body.style.overflow = '';
  }

  async function submitInquiry(evt, listingId) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const msgEl = document.getElementById('inquiry-msg');
    try {
      await api('/api/listings/' + listingId + '/inquiries', {
        method: 'POST',
        body: {
          name: f.get('name'), email: f.get('email'), phone: f.get('phone'),
          social: f.get('social'), message: f.get('message'),
        },
      });
      const card = document.querySelector('.modal-card');
      if (card) {
        card.innerHTML = `
          <button type="button" class="modal-close" onclick="App.closeContactModal()" aria-label="Close">&times;</button>
          <h2>Thanks!</h2>
          <p class="card-meta">Your info was sent to the shop owner — they'll reach out directly.</p>
          <button class="pill-btn" type="button" onclick="App.closeContactModal()">Done</button>
        `;
      }
    } catch (e) {
      if (msgEl) msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
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
        <p class="card-meta" style="margin-top:14px;">No account? <a href="/signup" onclick="event.preventDefault(); App.nav('/signup');" style="color:var(--blue-dark); font-weight:700;">Sign up</a></p>
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
      await loadFavoriteIds();
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
          <div id="license-fields" ${signupRole === 'owner' ? 'hidden' : ''}>
            <p class="card-meta" style="margin:0 0 8px;">Optional for now — having it on file is a first step toward a trust badge later.</p>
            <div class="row-2">
              <div class="field"><label>Barber license #</label><input type="text" name="license_number" /></div>
              <div class="field"><label>License state</label><input type="text" name="license_state" maxlength="2" placeholder="TX" /></div>
            </div>
            <div class="field"><label>License expiration</label><input type="date" name="license_expiration" /></div>
          </div>
          <button class="pill-btn" type="submit">Create account</button>
          <div id="auth-msg"></div>
        </form>
        <p class="card-meta" style="margin-top:14px;">Already have an account? <a href="/login" onclick="event.preventDefault(); App.nav('/login');" style="color:var(--blue-dark); font-weight:700;">Log in</a></p>
      </div>
    `;
  }

  function setSignupRole(role) {
    signupRole = role;
    document.getElementById('role-barber').classList.toggle('active', role === 'barber');
    document.getElementById('role-owner').classList.toggle('active', role === 'owner');
    const licenseFields = document.getElementById('license-fields');
    if (licenseFields) licenseFields.hidden = role !== 'barber';
    const bioField = document.querySelector('#app textarea[name="bio"]');
    if (bioField) bioField.placeholder = role === 'owner' ? 'Tell barbers about your shop...' : 'Tell shop owners about your experience...';
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
          license_number: f.get('license_number') || '', license_state: f.get('license_state') || '',
          license_expiration: f.get('license_expiration') || '',
        },
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('chairspace_token', data.token);
      await loadFavoriteIds();
      nav(signupRole === 'owner' ? '/post-listing' : '/');
    } catch (e) {
      msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  function logout() {
    api('/api/logout', { method: 'POST' }).catch(() => {});
    state.token = null;
    state.user = null;
    state.favoriteIds = new Set();
    localStorage.removeItem('chairspace_token');
    nav('/');
  }

  // ---------- post / edit listing (multi-step) ----------
  const POST_STEPS = ['Basics', 'Location', 'Pricing', 'Photos'];
  let postListingState = { step: 0, files: [], existingPhotos: [] };

  async function renderPostListing(editId) {
    if (!state.user || state.user.role !== 'owner') {
      $app().innerHTML = `<p class="msg">Only space-owner accounts can post listings. <a href="/signup" onclick="event.preventDefault(); App.nav('/signup');" style="color:var(--blue-dark);font-weight:700;">Sign up as an owner</a> or <a href="/login" onclick="event.preventDefault(); App.nav('/login');" style="color:var(--blue-dark);font-weight:700;">log in</a>.</p>`;
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
    postListingState = { step: 0, files: [], existingPhotos: (e.photos || []).slice() };

    $app().innerHTML = `
      <h1>${editId ? 'Edit listing' : 'Post a new listing'}</h1>
      <div class="step-progress">
        ${POST_STEPS.map((s, i) => `
          <div class="step-dot${i === 0 ? ' active' : ''}" data-step="${i}">
            <span class="dot-num">${i + 1}</span><span class="dot-label">${s}</span>
          </div>
        `).join('')}
      </div>
      <form class="stack listing-form" onsubmit="App.saveListing(event, ${editId ? editId : 'null'})">
        <div class="step-panel" data-panel="0">
          <div class="field"><label>Title</label><input type="text" name="title" required value="${escapeHtml(e.title || '')}" placeholder="e.g. Open booth in busy East Austin shop" /></div>
          <div class="field"><label>Description</label><textarea name="description" placeholder="Describe the space, the shop, expectations...">${escapeHtml(e.description || '')}</textarea></div>
          <div class="field"><label>Space type</label>
            <select name="chair_type" required>
              <option value="">Choose one</option>
              ${CHAIR_TYPES.map(t => `<option value="${t}" ${e.chair_type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="step-panel" data-panel="1" hidden>
          <div class="row-2">
            <div class="field"><label>City</label><input type="text" name="city" required value="${escapeHtml(e.city || '')}" /></div>
            <div class="field"><label>State</label><input type="text" name="state" required value="${escapeHtml(e.state || '')}" maxlength="2" placeholder="TX" /></div>
          </div>
          <div class="row-2">
            <div class="field"><label>Street address (optional)</label><input type="text" name="address" value="${escapeHtml(e.address || '')}" /></div>
            <div class="field"><label>ZIP (optional)</label><input type="text" name="zip" value="${escapeHtml(e.zip || '')}" /></div>
          </div>
          <div class="field"><label>Total chairs in shop (optional)</label><input type="number" name="total_chairs" min="1" step="1" placeholder="e.g. 6" value="${e.total_chairs || ''}" /></div>
        </div>

        <div class="step-panel" data-panel="2" hidden>
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
          <div class="field"><label>Available from (leave blank if available now)</label><input type="date" name="available_from" value="${escapeHtml(e.available_from || '')}" /></div>
          <div class="field"><label>Cancellation policy</label>
            <select name="cancellation_policy">
              <option value="flexible" ${e.cancellation_policy === 'flexible' ? 'selected' : ''}>Flexible — ${POLICY_INFO.flexible.desc}</option>
              <option value="standard" ${!e.cancellation_policy || e.cancellation_policy === 'standard' ? 'selected' : ''}>Standard — ${POLICY_INFO.standard.desc}</option>
              <option value="strict" ${e.cancellation_policy === 'strict' ? 'selected' : ''}>Strict — ${POLICY_INFO.strict.desc}</option>
            </select>
          </div>
        </div>

        <div class="step-panel" data-panel="3" hidden>
          <div class="field">
            <label>Photos <span class="card-meta">(up to 5 images, 5MB max each)</span></label>
            <div id="existing-photos" class="photo-thumb-row"></div>
            <div id="photo-dropzone" class="photo-dropzone" onclick="document.getElementById('photo-input').click()">
              <span>📷 Click to choose photos, or drag &amp; drop them here</span>
            </div>
            <input type="file" id="photo-input" accept="image/*" multiple style="display:none" onchange="App.handlePhotoSelect(event)" />
            <div id="new-photo-previews" class="photo-thumb-row"></div>
            <div id="photo-msg"></div>
          </div>
        </div>

        <div class="step-nav">
          <button type="button" class="pill-btn ghost" id="step-back" onclick="App.stepBack()" style="visibility:hidden;">Back</button>
          <button type="button" class="pill-btn" id="step-next" onclick="App.stepNext()">Next</button>
          <button class="pill-btn" type="submit" id="step-submit" style="display:none;">${editId ? 'Save changes' : 'Publish listing'}</button>
        </div>
        <div id="listing-msg"></div>
      </form>
    `;
    renderExistingPhotoThumbs();
    setupDropzone();
  }

  function showStep(idx) {
    document.querySelectorAll('.step-panel').forEach((p) => {
      p.hidden = Number(p.dataset.panel) !== idx;
    });
    document.querySelectorAll('.step-dot').forEach((d) => {
      const n = Number(d.dataset.step);
      d.classList.toggle('active', n === idx);
      d.classList.toggle('done', n < idx);
    });
    const back = document.getElementById('step-back');
    const next = document.getElementById('step-next');
    const submit = document.getElementById('step-submit');
    const lastStep = POST_STEPS.length - 1;
    if (back) back.style.visibility = idx === 0 ? 'hidden' : 'visible';
    if (next) next.style.display = idx === lastStep ? 'none' : '';
    if (submit) submit.style.display = idx === lastStep ? '' : 'none';
    postListingState.step = idx;
  }

  function validatePanel(idx) {
    const panel = document.querySelector(`.step-panel[data-panel="${idx}"]`);
    if (!panel) return true;
    const required = panel.querySelectorAll('[required]');
    for (const field of required) {
      if (!field.value || !field.value.trim()) {
        field.reportValidity ? field.reportValidity() : field.focus();
        field.focus();
        return false;
      }
    }
    return true;
  }

  function stepNext() {
    if (!validatePanel(postListingState.step)) return;
    if (postListingState.step < POST_STEPS.length - 1) showStep(postListingState.step + 1);
  }

  function stepBack() {
    if (postListingState.step > 0) showStep(postListingState.step - 1);
  }

  function renderExistingPhotoThumbs() {
    const el = document.getElementById('existing-photos');
    if (!el) return;
    if (!postListingState.existingPhotos.length) { el.innerHTML = ''; return; }
    el.innerHTML = postListingState.existingPhotos.map((src) => `
      <div class="photo-thumb"><img src="${src}" alt="listing photo" /></div>
    `).join('');
  }

  function renderNewPhotoPreviews() {
    const el = document.getElementById('new-photo-previews');
    if (!el) return;
    el.innerHTML = postListingState.files.map((f, i) => `
      <div class="photo-thumb">
        <img src="${f.previewUrl}" alt="${escapeHtml(f.file.name)}" />
        <button type="button" class="photo-remove" onclick="App.removeNewPhoto(${i})">&times;</button>
      </div>
    `).join('');
  }

  function handlePhotoSelect(evt) {
    addPhotoFiles(Array.from(evt.target.files || []));
    evt.target.value = '';
  }

  // Resizes/re-encodes a photo client-side before it ever gets uploaded — phone
  // camera photos are routinely 3-4k px and several MB, which is overkill for a
  // web listing and slow to upload on mobile data. Skips GIFs (compressing would
  // kill any animation) and falls back to the original file if anything goes wrong.
  function compressImage(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/') || file.type === 'image/gif') {
        resolve(file);
        return;
      }
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (!blob) { resolve(file); return; }
          const compressed = new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
          resolve(compressed.size < file.size ? compressed : file);
        }, 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function addPhotoFiles(fileList) {
    const msgEl = document.getElementById('photo-msg');
    if (msgEl) msgEl.innerHTML = '';
    const totalExisting = postListingState.existingPhotos.length + postListingState.files.length;
    const room = 5 - totalExisting;
    const errors = [];
    if (room <= 0) {
      errors.push('You can have at most 5 photos total. Remove one to add another.');
    } else {
      let added = 0;
      for (const file of fileList) {
        if (added >= room) { errors.push(`Only ${room} more photo(s) can be added (5 max).`); break; }
        if (!file.type.startsWith('image/')) { errors.push(`${file.name} isn't a supported image file.`); continue; }
        if (file.size > 5 * 1024 * 1024) { errors.push(`${file.name} is larger than 5MB.`); continue; }
        const processed = await compressImage(file);
        postListingState.files.push({ file: processed, previewUrl: URL.createObjectURL(processed) });
        added++;
      }
    }
    if (errors.length && msgEl) msgEl.innerHTML = `<p class="msg">${escapeHtml(errors.join(' '))}</p>`;
    renderNewPhotoPreviews();
  }

  function removeNewPhoto(i) {
    postListingState.files.splice(i, 1);
    renderNewPhotoPreviews();
  }

  function setupDropzone() {
    const zone = document.getElementById('photo-dropzone');
    if (!zone) return;
    ['dragover', 'dragenter'].forEach((evt) => zone.addEventListener(evt, (ev) => { ev.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'dragend'].forEach((evt) => zone.addEventListener(evt, () => zone.classList.remove('drag')));
    zone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      zone.classList.remove('drag');
      addPhotoFiles(Array.from(ev.dataTransfer.files || []));
    });
  }

  async function uploadListingPhotos(listingId, files) {
    const fd = new FormData();
    for (const file of files) fd.append('photos', file, file.name);
    const headers = {};
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch('/api/listings/' + listingId + '/photos', { method: 'POST', headers, body: fd });
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw new Error(data.error || 'Photo upload failed');
    return data;
  }

  async function saveListing(evt, editId) {
    evt.preventDefault();
    if (!validatePanel(postListingState.step)) return;
    const f = new FormData(evt.target);
    const msgEl = document.getElementById('listing-msg');
    const payload = {
      title: f.get('title'), description: f.get('description'),
      city: f.get('city'), state: f.get('state'), address: f.get('address'), zip: f.get('zip'),
      price: Number(f.get('price')), price_unit: f.get('price_unit'), chair_type: f.get('chair_type'),
      available_from: f.get('available_from') || null,
      total_chairs: f.get('total_chairs') || null,
      cancellation_policy: f.get('cancellation_policy') || 'standard',
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
      if (postListingState.files.length > 0) {
        msgEl.innerHTML = `<p class="card-meta">Uploading photos...</p>`;
        await uploadListingPhotos(listing.id, postListingState.files.map((x) => x.file));
      }
      nav('/listing/' + listing.id);
    } catch (e) {
      msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  // ---------- dashboard ----------
  async function renderDashboard() {
    if (!state.user) {
      $app().innerHTML = `<p class="msg">Log in to see your dashboard. <a href="/login" onclick="event.preventDefault(); App.nav('/login');" style="color:var(--blue-dark);font-weight:700;">Log in</a></p>`;
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
        <button id="tab-inquiries" onclick="App.showOwnerTab('inquiries')">Inquiries</button>
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
    document.getElementById('tab-inquiries').classList.toggle('active', tab === 'inquiries');
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
      } else if (tab === 'requests') {
        const { requests } = await api('/api/requests/received');
        if (requests.length === 0) {
          content.innerHTML = `<div class="empty-state">No rental requests yet.</div>`;
          return;
        }
        content.innerHTML = requests.map(requestRow('owner')).join('');
      } else {
        const { inquiries } = await api('/api/inquiries/received');
        if (inquiries.length === 0) {
          content.innerHTML = `<div class="empty-state">No inquiries yet. When someone taps "Contact Owner" on one of your listings, it'll show up here.</div>`;
          return;
        }
        content.innerHTML = inquiries.map(inquiryRow).join('');
      }
    } catch (e) {
      content.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  function inquiryRow(i) {
    const listingTitle = i.listing ? i.listing.title : '(listing removed)';
    return `
      <div class="request-row">
        <div class="info">
          <div>
            <a onclick="App.nav('/listing/${i.listing ? i.listing.id : ''}')" style="font-weight:700; cursor:pointer;">${escapeHtml(listingTitle)}</a>
          </div>
          <div class="card-meta">
            <b>${escapeHtml(i.name)}</b> &middot; <a href="mailto:${escapeHtml(i.email)}" style="color:var(--blue-dark);">${escapeHtml(i.email)}</a>${i.phone ? ' &middot; ' + escapeHtml(i.phone) : ''}${i.social ? ' &middot; ' + escapeHtml(i.social) : ''}
          </div>
          ${i.message ? `<div class="card-meta" style="margin-top:4px;">${escapeHtml(i.message)}</div>` : ''}
          <div class="card-meta" style="margin-top:4px;">${timeAgo(i.created_at)}</div>
        </div>
      </div>
    `;
  }

  async function renderBarberDashboard() {
    $app().innerHTML = `
      <h1>My Dashboard</h1>
      <div class="tabs">
        <button id="tab-requests" class="active" onclick="App.showBarberTab('requests')">My Requests</button>
        <button id="tab-favorites" onclick="App.showBarberTab('favorites')">Favorites</button>
        <button id="tab-saved-searches" onclick="App.showBarberTab('saved-searches')">Saved Searches</button>
      </div>
      <div id="tab-content"><p class="spinner-note">Loading...</p></div>
    `;
    showBarberTab('requests');
  }

  let lastBarberTab = 'requests';
  async function showBarberTab(tab) {
    lastBarberTab = tab;
    document.getElementById('tab-requests').classList.toggle('active', tab === 'requests');
    document.getElementById('tab-favorites').classList.toggle('active', tab === 'favorites');
    document.getElementById('tab-saved-searches').classList.toggle('active', tab === 'saved-searches');
    const content = document.getElementById('tab-content');
    content.innerHTML = `<p class="spinner-note">Loading...</p>`;
    try {
      if (tab === 'requests') {
        const { requests } = await api('/api/requests/sent');
        if (requests.length === 0) {
          content.innerHTML = `<div class="empty-state">You haven't requested any chairs yet.<br/><button class="pill-btn" style="margin-top:12px;" onclick="App.nav('/')">Browse listings</button></div>`;
          return;
        }
        content.innerHTML = requests.map(requestRow('barber')).join('');
      } else if (tab === 'favorites') {
        const { listings } = await api('/api/favorites');
        if (listings.length === 0) {
          content.innerHTML = `<div class="empty-state">No favorites yet. Tap the heart on any listing to save it here.</div>`;
          return;
        }
        content.innerHTML = `<div class="grid">${listings.map(listingCard).join('')}</div>`;
      } else {
        const { searches } = await api('/api/saved-searches');
        if (searches.length === 0) {
          content.innerHTML = `<div class="empty-state">No saved searches yet. Search on the home page, then tap "Save this search" to get emailed when a new chair matches.</div>`;
          return;
        }
        content.innerHTML = searches.map(savedSearchRow).join('');
      }
    } catch (e) {
      content.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
  }

  function savedSearchRow(s) {
    const parts = [];
    if (s.city) parts.push(s.city);
    if (s.chair_type) parts.push(s.chair_type);
    if (s.price_unit) parts.push(unitLabel(s.price_unit).replace('/', 'per '));
    if (s.max_price) parts.push('under ' + money(s.max_price));
    return `
      <div class="request-row">
        <div class="info">
          <div style="font-weight:700;">${escapeHtml(s.label || 'Saved search')}</div>
          <div class="card-meta">${escapeHtml(parts.join(' · ') || 'Any listing')}</div>
        </div>
        <div class="actions">
          <button class="pill-btn ghost small" onclick="App.deleteSavedSearch(${s.id})">Delete</button>
        </div>
      </div>
    `;
  }

  async function deleteSavedSearch(id) {
    try {
      await api('/api/saved-searches/' + id, { method: 'DELETE' });
      showBarberTab('saved-searches');
    } catch (e) {
      alert(e.message);
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
      const { path } = parseLocation();
      if (path === '/dashboard' && state.user.role === 'owner') {
        showOwnerTab(lastOwnerTab);
      } else if (path === '/dashboard' && state.user.role === 'barber') {
        showBarberTab(lastBarberTab);
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
      <div id="review-area" style="max-width:560px; margin-top:20px;"></div>
    `;

    if (r && r.status === 'approved') loadThreadReview(id);
  }

  async function loadThreadReview(requestId) {
    const el = document.getElementById('review-area');
    if (!el) return;
    try {
      const data = await api('/api/requests/' + requestId + '/reviews');
      if (!document.getElementById('review-area')) return;
      if (data.canReview) {
        el.innerHTML = `
          <div class="card auth" style="padding:20px;">
            <h3 style="margin-top:0;">Leave a review</h3>
            <p class="card-meta">You won't see their review (if they leave one) until you've submitted yours.</p>
            <form class="stack" onsubmit="App.submitReview(event, ${requestId})">
              <div class="field"><label>Rating</label>
                <div class="star-picker" id="star-picker">
                  ${[1,2,3,4,5].map(n => `<button type="button" class="star-pick" data-val="${n}" onclick="App.pickStar(${n})">☆</button>`).join('')}
                </div>
                <input type="hidden" name="rating" id="rating-input" value="" />
              </div>
              <div class="field"><label>Comment (optional)</label><textarea name="comment" placeholder="How did it go?"></textarea></div>
              <button class="pill-btn" type="submit">Submit review</button>
              <div id="review-msg"></div>
            </form>
          </div>
        `;
      } else if (data.myReview) {
        el.innerHTML = `
          <div class="card auth" style="padding:20px;">
            <h3 style="margin-top:0;">Your review</h3>
            <div class="review-stars">${star(data.myReview.rating)}</div>
            ${data.myReview.comment ? `<p>${escapeHtml(data.myReview.comment)}</p>` : ''}
            ${data.bothSubmitted && data.otherReview ? `
              <h3>Their review</h3>
              <div class="review-stars">${star(data.otherReview.rating)}</div>
              ${data.otherReview.comment ? `<p>${escapeHtml(data.otherReview.comment)}</p>` : ''}
            ` : `<p class="card-meta">You'll see their review once they've left one too.</p>`}
          </div>
        `;
      } else {
        el.innerHTML = '';
      }
    } catch (e) {
      el.innerHTML = '';
    }
  }

  function pickStar(n) {
    document.getElementById('rating-input').value = n;
    document.querySelectorAll('.star-pick').forEach((btn) => {
      const val = Number(btn.dataset.val);
      btn.textContent = val <= n ? '★' : '☆';
      btn.classList.toggle('active', val <= n);
    });
  }

  async function submitReview(evt, requestId) {
    evt.preventDefault();
    const f = new FormData(evt.target);
    const msgEl = document.getElementById('review-msg');
    const rating = Number(f.get('rating'));
    if (!rating) {
      if (msgEl) msgEl.innerHTML = `<p class="msg">Pick a star rating first.</p>`;
      return;
    }
    try {
      await api('/api/requests/' + requestId + '/reviews', { method: 'POST', body: { rating, comment: f.get('comment') || '' } });
      loadThreadReview(requestId);
    } catch (e) {
      if (msgEl) msgEl.innerHTML = `<p class="msg">${escapeHtml(e.message)}</p>`;
    }
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
    $app().innerHTML = `<div class="empty-state">Page not found. <a href="/" onclick="event.preventDefault(); App.nav('/');" style="color:var(--blue-dark);font-weight:700;">Go home</a></div>`;
  }

  // ---------- boot ----------
  async function loadFavoriteIds() {
    if (!state.user || state.user.role !== 'barber') { state.favoriteIds = new Set(); return; }
    try {
      const { listing_ids } = await api('/api/favorites/ids');
      state.favoriteIds = new Set(listing_ids);
    } catch (e) {
      state.favoriteIds = new Set();
    }
  }

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
    await loadFavoriteIds();
    state.booting = false;
    window.addEventListener('popstate', router);
    router();
  }

  boot();

  return {
    nav, searchSubmit, doLogin, doSignup, setSignupRole, logout,
    sendRequest, toggleActive, saveListing, showOwnerTab, updateRequest,
    sendMessage, stepNext, stepBack, handlePhotoSelect, removeNewPhoto,
    heroNext, heroPrev, heroGoTo, openContactModal, closeContactModal, submitInquiry,
    toggleMenu, toggleFavorite, showBarberTab, saveCurrentSearch, deleteSavedSearch,
    pickStar, submitReview,
  };
})();
