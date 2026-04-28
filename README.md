# Game Betting Platform Starter

A simple starter platform for gamers to register, deposit balance, create matches, join opponents, and resolve bets.

## What is included

- `server.js` — Express API server
- `db.js` — SQLite database initializer
- `public/index.html` — static landing page with endpoint summary
- `package.json` — dependencies and start scripts

## Install

1. Open a terminal in `c:\Users\kiptoo\OneDrive\Desktop\game`
2. Run `npm install`
3. Run `npm start`
4. Visit `http://localhost:4000` in your browser

## API Endpoints

- `POST /api/register` — register new gamer
- `POST /api/login` — sign in and receive a token
- `POST /api/deposit` — top up wallet balance
- `GET /api/profile` — return current user balance
- `GET /api/matches` — list open and pending matches
- `POST /api/create-match` — host a new match
- `POST /api/join-match` — join an open match
- `POST /api/resolve-match` — settle the match and pay the winner

## Notes

- This starter is for demonstration only. A production betting platform needs:
  - real payment gateway integration
  - strong anti-fraud and KYC controls
  - legal compliance with gambling/regulatory rules
  - secure mobile or browser game integration

## Important

This contains a minimal game-betting backend. Do not use it as-is in production without adding security, regulatory checks, and proper payment processing.
