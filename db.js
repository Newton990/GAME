const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      hostId INTEGER NOT NULL,
      stake REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      type TEXT NOT NULL DEFAULT 'manual', -- 'manual' or 'dice'
      gameTitle TEXT, -- 'PUBG', 'COD', 'PES', etc.
      matchNotes TEXT, -- Room ID, Gamer Tag, etc.
      gameData TEXT, -- JSON string for rolls, etc.
      winnerId INTEGER,
      FOREIGN KEY(hostId) REFERENCES users(id),
      FOREIGN KEY(winnerId) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      matchId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(matchId) REFERENCES matches(id),
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Initialize treasury if not exists
  db.run(`INSERT OR IGNORE INTO system_settings (key, value) VALUES ('treasury_balance', '0')`);

  // Ensure admin user exists (password is 'admin123' - user should change this)
  const adminHash = '$2b$10$7R9.YpXpW/T4zD.yX0W/OuY0X0W/OuY0X0W/OuY0X0W/OuY0X0W'; // bcrypt for admin123
  db.run(`INSERT OR IGNORE INTO users (username, passwordHash, balance) VALUES ('admin', ?, 1000)`, [adminHash]);

  // Performance indices
  db.run(`CREATE INDEX IF NOT EXISTS idx_participants_match ON participants(matchId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(userId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(userId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status)`);
});

module.exports = db;
