const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const port = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, payload) => {
    if (err) return res.status(401).json({ error: 'Invalid token' });
    req.user = payload;
    next();
  });
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  const passwordHash = await bcrypt.hash(password, 10);
  const stmt = db.prepare('INSERT INTO users (username, passwordHash) VALUES (?, ?)');

  stmt.run(username, passwordHash, function (err) {
    if (err) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: this.lastID, username, balance: 0 } });
  });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance } });
  });
});

app.get('/api/profile', authenticate, (req, res) => {
  db.get('SELECT id, username, balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  });
});

app.post('/api/deposit', authenticate, (req, res) => {
  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, req.user.id], function (err) {
    if (err) return res.status(500).json({ error: 'Deposit failed' });
    db.run('INSERT INTO transactions (userId, amount, type) VALUES (?, ?, ?)', [req.user.id, amount, 'deposit']);
    db.get('SELECT id, username, balance FROM users WHERE id = ?', [req.user.id], (err2, user) => {
      res.json({ user, message: 'Deposit successful' });
    });
  });
});

app.get('/api/matches', (req, res) => {
  db.all(`
    SELECT m.id, m.title, m.stake, m.status, m.hostId, u.username AS hostName,
           COUNT(p.id) AS participantCount
    FROM matches m
    JOIN users u ON u.id = m.hostId
    LEFT JOIN participants p ON p.matchId = m.id
    GROUP BY m.id
    ORDER BY m.id DESC
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load matches' });
    res.json({ matches: rows });
  });
});

app.post('/api/create-match', authenticate, (req, res) => {
  const { title, stake } = req.body;
  const amount = Number(stake);
  if (!title || !amount || amount <= 0) return res.status(400).json({ error: 'Title and stake are required' });

  db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    db.run('INSERT INTO matches (title, hostId, stake) VALUES (?, ?, ?)', [title, req.user.id, amount], function (err2) {
      if (err2) return res.status(500).json({ error: 'Failed to create match' });
      const matchId = this.lastID;
      db.run('INSERT INTO participants (matchId, userId) VALUES (?, ?)', [matchId, req.user.id]);
      db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, req.user.id]);
      res.json({ match: { id: matchId, title, stake: amount, status: 'open', hostId: req.user.id } });
    });
  });
});

app.post('/api/join-match', authenticate, (req, res) => {
  const matchId = Number(req.body.matchId);
  if (!matchId) return res.status(400).json({ error: 'matchId is required' });

  db.get('SELECT * FROM matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'open') return res.status(400).json({ error: 'Match is not open' });
    if (match.hostId === req.user.id) return res.status(400).json({ error: 'Host cannot join its own match' });

    db.get('SELECT COUNT(*) AS count FROM participants WHERE matchId = ? AND userId = ?', [matchId, req.user.id], (err2, row) => {
      if (row.count > 0) return res.status(400).json({ error: 'Already joined' });
      db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err3, user) => {
        if (err3 || !user) return res.status(404).json({ error: 'User not found' });
        if (user.balance < match.stake) return res.status(400).json({ error: 'Insufficient balance' });

        db.run('INSERT INTO participants (matchId, userId) VALUES (?, ?)', [matchId, req.user.id], function (err4) {
          if (err4) return res.status(500).json({ error: 'Failed to join match' });
          db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [match.stake, req.user.id]);
          db.run('UPDATE matches SET status = ? WHERE id = ?', ['pending', matchId]);
          res.json({ message: 'Joined match successfully', matchId });
        });
      });
    });
  });
});

app.post('/api/resolve-match', authenticate, (req, res) => {
  const matchId = Number(req.body.matchId);
  const winnerId = Number(req.body.winnerId);
  if (!matchId || !winnerId) return res.status(400).json({ error: 'matchId and winnerId are required' });

  db.get('SELECT * FROM matches WHERE id = ?', [matchId], (err, match) => {
    if (err || !match) return res.status(404).json({ error: 'Match not found' });
    if (match.status !== 'pending') return res.status(400).json({ error: 'Match is not pending' });
    if (![match.hostId].includes(req.user.id) && req.user.id !== winnerId) {
      return res.status(403).json({ error: 'Only a participant can resolve' });
    }

    const totalPrize = match.stake * 2;
    const fee = totalPrize * 0.05;
    const payout = totalPrize - fee;

    db.get('SELECT COUNT(*) AS count FROM participants WHERE matchId = ?', [matchId], (err2, row) => {
      if (row.count < 2) return res.status(400).json({ error: 'Match does not have two players' });

      db.get('SELECT id FROM users WHERE id = ?', [winnerId], (err3, winner) => {
        if (err3 || !winner) return res.status(404).json({ error: 'Winner not found' });

        db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [payout, winnerId], function (err4) {
          if (err4) return res.status(500).json({ error: 'Payout failed' });
          db.run('UPDATE matches SET status = ?, winnerId = ? WHERE id = ?', ['completed', winnerId, matchId]);
          db.run('INSERT INTO transactions (userId, amount, type) VALUES (?, ?, ?)', [winnerId, payout, 'payout']);
          res.json({ message: 'Match resolved', payout, fee });
        });
      });
    });
  });
});

app.get('/api/transactions', authenticate, (req, res) => {
  db.all('SELECT id, amount, type, createdAt FROM transactions WHERE userId = ? ORDER BY createdAt DESC', [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load transactions' });
    res.json({ transactions: rows });
  });
});

app.listen(port, () => {
  console.log(`Game betting platform API running on http://localhost:${port}`);
});
