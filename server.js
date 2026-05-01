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

// Request Logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

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
    SELECT m.id, m.title, m.stake, m.status, m.hostId, m.type, m.gameTitle, m.matchNotes, m.gameData,
           u.username AS hostName, COUNT(p.id) AS participantCount
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
  const { title, stake, type, gameTitle, matchNotes } = req.body;
  const amount = Number(stake);
  const matchType = type === 'dice' ? 'dice' : 'manual';
  
  if (!title || !amount || amount <= 0) return res.status(400).json({ error: 'Title and stake are required' });

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, user) => {
      if (err || !user) {
        db.run('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      if (user.balance < amount) {
        db.run('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      const initialData = matchType === 'dice' ? JSON.stringify({ rolls: {} }) : null;
      
      db.run('INSERT INTO matches (title, hostId, stake, type, gameTitle, matchNotes, gameData) VALUES (?, ?, ?, ?, ?, ?, ?)', 
        [title, req.user.id, amount, matchType, gameTitle || 'General', matchNotes || '', initialData], function (err2) {
        if (err2) {
          db.run('ROLLBACK');
          return res.status(500).json({ error: 'Failed to create match' });
        }
        
        const matchId = this.lastID;
        db.run('INSERT INTO participants (matchId, userId) VALUES (?, ?)', [matchId, req.user.id]);
        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, req.user.id]);
        db.run('INSERT INTO transactions (userId, amount, type) VALUES (?, ?, ?)', [req.user.id, -amount, 'stake']);
        
        db.run('COMMIT', (err3) => {
          if (err3) return res.status(500).json({ error: 'Transaction failed' });
          res.json({ match: { id: matchId, title, stake: amount, status: 'open', hostId: req.user.id, type: matchType, gameTitle, matchNotes } });
        });
      });
    });
  });
});

app.post('/api/roll-dice', authenticate, (req, res) => {
  const matchId = Number(req.body.matchId);
  if (!matchId) return res.status(400).json({ error: 'matchId is required' });

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.get('SELECT * FROM matches WHERE id = ?', [matchId], (err, match) => {
      if (err || !match || match.type !== 'dice') {
        db.run('ROLLBACK');
        return res.status(404).json({ error: 'Dice match not found' });
      }
      if (match.status !== 'pending') {
        db.run('ROLLBACK');
        return res.status(400).json({ error: 'Match is not in rolling phase' });
      }

      const gameData = JSON.parse(match.gameData || '{"rolls":{}}');
      if (gameData.rolls[req.user.id]) {
        db.run('ROLLBACK');
        return res.status(400).json({ error: 'Already rolled' });
      }

      // Check if user is participant
      db.get('SELECT id FROM participants WHERE matchId = ? AND userId = ?', [matchId, req.user.id], (err2, participant) => {
        if (err2 || !participant) {
          db.run('ROLLBACK');
          return res.status(403).json({ error: 'Not a participant' });
        }

        const roll = Math.floor(Math.random() * 6) + 1;
        gameData.rolls[req.user.id] = roll;

        const rollCount = Object.keys(gameData.rolls).length;
        
        if (rollCount === 2) {
          // Determine winner
          const playerIds = Object.keys(gameData.rolls);
          const roll1 = gameData.rolls[playerIds[0]];
          const roll2 = gameData.rolls[playerIds[1]];
          
          let winnerId = null;
          let isTie = false;
          
          if (roll1 > roll2) winnerId = Number(playerIds[0]);
          else if (roll2 > roll1) winnerId = Number(playerIds[1]);
          else isTie = true;

          if (isTie) {
            // Refund both
            playerIds.forEach(pid => {
              db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [match.stake, Number(pid)]);
              db.run('INSERT INTO transactions (userId, amount, type) VALUES (?, ?, ?)', [Number(pid), match.stake, 'refund']);
            });
            db.run('UPDATE matches SET status = ?, gameData = ? WHERE id = ?', ['completed', JSON.stringify(gameData), matchId]);
          } else {
            const totalPrize = match.stake * 2;
            const fee = totalPrize * 0.05;
            const payout = totalPrize - fee;
            
            db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [payout, winnerId]);
            db.run('UPDATE matches SET status = ?, winnerId = ?, gameData = ? WHERE id = ?', 
              ['completed', winnerId, JSON.stringify(gameData), matchId]);
            db.run('INSERT INTO transactions (userId, amount, type) VALUES (?, ?, ?)', [winnerId, payout, 'payout']);
            
            // Collect fee into treasury
            db.run("UPDATE system_settings SET value = CAST(value AS REAL) + ? WHERE key = 'treasury_balance'", [fee]);
          }
        } else {
          db.run('UPDATE matches SET gameData = ? WHERE id = ?', [JSON.stringify(gameData), matchId]);
        }

        db.run('COMMIT', (err3) => {
          if (err3) return res.status(500).json({ error: 'Roll failed' });
          res.json({ roll, message: rollCount === 2 ? 'Match settled!' : 'Waiting for opponent roll' });
        });
      });
    });
  });
});

app.post('/api/transfer', authenticate, (req, res) => {
  const recipientId = Number(req.body.recipientId);
  const amount = Number(req.body.amount);
  
  if (!recipientId || !amount || amount <= 0) return res.status(400).json({ error: 'Recipient and amount required' });
  if (recipientId === req.user.id) return res.status(400).json({ error: 'Cannot send to yourself' });

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    db.get('SELECT balance FROM users WHERE id = ?', [req.user.id], (err, sender) => {
      if (err || !sender || sender.balance < amount) {
        db.run('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      db.get('SELECT id FROM users WHERE id = ?', [recipientId], (err2, recipient) => {
        if (err2 || !recipient) {
          db.run('ROLLBACK');
          return res.status(404).json({ error: 'Recipient not found' });
        }

        db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, req.user.id]);
        db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, recipientId]);
        db.run('INSERT INTO transactions (userId, amount, type) VALUES (?, ?, ?)', [req.user.id, -amount, 'transfer_sent']);
        db.run('INSERT INTO transactions (userId, amount, type) VALUES (?, ?, ?)', [recipientId, amount, 'transfer_received']);

        db.run('COMMIT', (err3) => {
          if (err3) return res.status(500).json({ error: 'Transfer failed' });
          res.json({ message: 'Transfer successful' });
        });
      });
    });
  });
});

app.get('/api/admin/treasury', authenticate, (req, res) => {
  if (req.user.username !== 'admin') return res.status(403).json({ error: 'Admin only' });
  
  db.get("SELECT value FROM system_settings WHERE key = 'treasury_balance'", (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to load treasury' });
    res.json({ balance: Number(row.value) });
  });
});

app.get('/api/leaderboard', (req, res) => {
  db.all(`
    SELECT u.id, u.username, COUNT(m.id) as wins, SUM(m.stake * 0.95 * 2) as totalEarnings
    FROM users u
    JOIN matches m ON m.winnerId = u.id
    WHERE m.status = 'completed'
    GROUP BY u.id
    ORDER BY totalEarnings DESC
    LIMIT 10
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to load leaderboard' });
    res.json({ leaderboard: rows });
  });
});

app.listen(port, () => {
  console.log(`Game betting platform API running on http://localhost:${port}`);
});
