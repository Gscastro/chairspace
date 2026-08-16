# ChairSpace — barber chair rental marketplace (prototype)

A working prototype of a two-sided marketplace: salon/shop owners list open chairs, booths,
or suites for rent, and barbers search, request, and message them about renting a spot.

This is a **functional demo running on sample data** — not connected to real payments and not
deployed to a public URL. It's meant to be clicked through, tested, and used as the starting
point for a real build.

## What's included

- Search & filter listings by city, space type, billing period, and max price
- Listing detail pages with photos, description, amenities, and host info
- Two account types: **barber** and **space owner**, with sign up / log in
- Owners can post, edit, and deactivate listings
- Barbers can send a rental request (with dates + a message) to a listing
- Owners can approve/decline requests from their dashboard
- Simple in-app messaging thread per request, once a barber has reached out
- Sample data: 4 shop owners with 8 listings across Austin, Dallas, Houston, and Chicago,
  plus 2 sample barber accounts

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
  just fetch calls to a small JSON API and hash-based routing. Kept dependency-free on purpose
  so it's easy for a developer to read end to end and easy to run anywhere.
- **Photos:** listing photos are pulled from a placeholder image service (picsum.photos) keyed
  off each listing; if that's unreachable, the app falls back to a plain icon so nothing looks
  broken.

## What this is *not* (yet)

This is scoped as a clickable, functioning prototype — good for validating the idea, showing
people, and gathering feedback. Before this could be a real product, it would still need:

- **Real photo uploads** instead of placeholder images
- **Payments** — collecting rent/deposits, e.g. via Stripe Connect so money can flow between
  barbers and space owners
- **Stronger auth** — email verification, password reset, rate limiting on login attempts
- **Maps/geolocation search** instead of city-name text matching
- **Notifications** — email or SMS when a request comes in or gets approved
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
