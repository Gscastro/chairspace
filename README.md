# ChairSpace — barber chair rental marketplace (prototype)

A working prototype of a two-sided marketplace: salon/shop owners list open chairs, booths,
or suites for rent, and barbers search, request, and message them about renting a spot.

This is a **functional demo running on sample data** — not connected to real payments. It's
meant to be clicked through, tested, and used as the starting point for a real build.

## Deploying this to a live URL (Render)

This repo is ready to deploy on [Render](https://render.com) as a Node web service — it
includes a `render.yaml` blueprint and a `.node-version` file so Render picks Node 22+
(required for the built-in SQLite support).

**1. Push this code to a new GitHub repository** (from a terminal, in this folder):

```bash
# Create a new empty repository at github.com/new first, then:
git remote add origin https://github.com/YOUR_USERNAME/chairspace.git
git branch -M main
git push -u origin main
```

(This folder is already a git repo with one commit, so you just need to add the remote and push.)

**2. Connect Render:** go to [dashboard.render.com](https://dashboard.render.com), sign in
(or sign up — the free tier is fine to start), and connect your GitHub account when prompted.

**3. Create the web service:** click **New > Web Service**, pick the `chairspace` repo you
just pushed. Render should auto-detect the `render.yaml` blueprint (Node, no build step,
start command `node server.js`). Otherwise set those manually. Deploy.

**Important caveat:** Render's free tier doesn't support a persistent disk, so the SQLite
database resets on every redeploy (fine for a demo people are trying out, not fine for
real user data). `render.yaml` has commented-out instructions for adding a persistent disk
once you're ready to upgrade to a paid instance — or plan to migrate to a hosted Postgres
database for a real launch.

## What's included

- Real, search-engine-friendly listing URLs (`/listing/5`, not `#/listing/5`) — each listing
  page is server-rendered with a real title, meta description, and Product/Offer structured
  data so Google can actually index individual listings, plus a `/sitemap.xml` and
  `/robots.txt` generated live from the listings table
- Real email notifications (via [Resend](https://resend.com)) on new rental requests, new
  messages, request approve/decline, and new Contact Owner inquiries — see "Email
  notifications setup" below
- Uploaded photos are automatically resized/compressed in the browser before upload (down to
  1600px max dimension, ~JPEG quality 82%) so a multi-MB phone photo doesn't become a multi-MB
  page load, and static assets/uploaded photos are served with proper cache headers
- Search & filter listings by city or ZIP code, space type, billing period, a max weekly
  rent slider, and an "available now only" toggle
- Listing detail pages with a photo carousel (hero image with title/location overlay, arrow +
  dot navigation when a listing has multiple photos), description, total chairs in the shop,
  and host info
- Two account types: **barber** and **space owner**, with sign up / log in
- Owners can post, edit, and deactivate listings via a guided, multi-step "Post a listing"
  form (basics → location → pricing → photos)
- Real photo uploads on listings (up to 5 images per listing, 5MB max each) with drag-and-drop
- **"Contact Owner" popup** on every listing — anyone can send their name, email, phone, and a
  short message straight to the shop owner with no account required (inspired by
  thecut.co/open-booth). Owners see these as "Inquiries" on their dashboard, alongside their
  regular account-based "Requests Received" (the original request/approve/message flow still
  works unchanged for logged-in barbers)
- Barbers can send a rental request (with dates + a message) to a listing
- Owners can approve/decline requests from their dashboard
- Simple in-app messaging thread per request, once a barber has reached out
- Sample data: 4 shop owners with 8 listings across Austin, Dallas, Houston, and Chicago,
  plus 2 sample barber accounts

## Email notifications setup

New rental requests, new messages, approve/decline, and new Contact Owner inquiries all try to
send a real email via [Resend](https://resend.com). Without an API key configured, the app
still works fine — it just logs `[email skipped]` instead of sending, so it's safe to deploy
before this is set up.

To turn emails on:

1. Create a free Resend account at [resend.com](https://resend.com) (free tier covers 3,000
   emails/month — plenty for a demo).
2. Create an API key from the Resend dashboard.
3. In the Render dashboard, open this service → **Environment**, and add a variable named
   `RESEND_API_KEY` with that key as the value. (Enter this directly in Render's dashboard —
   don't paste API keys into chat.)
4. Optional: add `RESEND_FROM` (e.g. `ChairSpace <hello@yourdomain.com>`) once you've verified
   a sending domain in Resend. Until then it defaults to Resend's shared `onboarding@resend.dev`
   address, which works immediately but Resend may restrict who it can send to until a domain
   is verified — check Resend's own docs for current sandbox-mode limits.
5. Redeploy (or just wait for the next natural redeploy) — no code changes needed, the app
   picks up the environment variable automatically.

## How to run it

You need [Node.js](https://nodejs.org) **version 22.5 or newer** (it uses Node's new built-in
SQLite support, so there's nothing else to install — no `npm install` needed).

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

The first time you start it, it creates `chairspace.db` (a local SQLite file) and fills it with
sample listings and accounts. To start over with a clean slate, just delete `chairspace.db` (and
the `-shm`/`-wal` files next to it) and restart the server.

### Try it with these sample logins

| Role | Email | Password |
|---|---|---|
| Space owner | `marcus@fadedistrict.com` | `password123` |
| Barber | `jordan@example.com` | `password123` |

Or just sign up for a new account from the homepage.

## How it's built

- **Backend:** plain Node.js (`server.js`), no framework — a small router over Node's built-in
  `http` module, with Node's built-in `node:sqlite` for storage. No `npm install` step, no
  external dependencies at all.
- **Frontend:** a single-page app in plain JavaScript (`public/app.js`) — no React/build step,
  just fetch calls to a small JSON API and real-path client-side routing via the History API
  (not hash routing — real URLs like `/listing/5` so listing pages are crawlable/indexable).
  Kept dependency-free on purpose so it's easy for a developer to read end to end and easy to
  run anywhere.
- **Photos:** owners can upload real photos when posting or editing a listing (handled by a
  small hand-rolled multipart/form-data parser in `server.js`, no upload library needed); files
  are saved under `public/uploads/listings/<id>/`. Listings without any uploaded photos fall
  back to a placeholder image service (picsum.photos) keyed off the listing, with a plain icon
  shown if that's unreachable, so nothing looks broken either way.

## What this is *not* (yet)

This is scoped as a clickable, functioning prototype — good for validating the idea, showing
people, and gathering feedback. Before this could be a real product, it would still need:

- **Persistent file storage** for uploaded photos — Render's free tier has no persistent disk,
  so like the SQLite database, uploaded photos are wiped on every redeploy. A real launch would
  move uploads to something like S3 or Cloudinary.
- **Payments** — collecting rent/deposits, e.g. via Stripe Connect so money can flow between
  barbers and space owners
- **Stronger auth** — email verification, password reset, rate limiting on login attempts
- **Maps/geolocation search** instead of city/ZIP text matching
- **SMS notifications** — email notifications now exist (see "Email notifications setup"
  above); text-message alerts would be a further addition
- **Reviews/ratings** for both barbers and spaces
- **Legal basics** — rental agreement terms, cancellation policy, liability language
- **A real production database** (e.g. Postgres) and hosting (e.g. Render, Railway, Fly.io) for
  a live deployment, plus a domain name

## Project structure

```
barber-spot-app/
├── server.js          API + static file server
├── db.js               database schema + sample data seeding
├── package.json
└── public/
    ├── index.html       page shell
    ├── app.js            all frontend logic (routing, rendering, API calls)
    └── style.css         styling
```
