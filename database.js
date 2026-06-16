// ============================================================
// DATABASE MODULE - SQLite Database Setup
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// ডেটাবেস ডিরেক্টরি তৈরি
const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.DB_PATH);

// পারফরম্যান্স সেটিংস
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
// টেবিল তৈরি
// ============================================================

// প্যানেল সেশন - লগইন সেশন সেভ করা
db.exec(`
  CREATE TABLE IF NOT EXISTS panel_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_name TEXT NOT NULL,
    cookie TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    last_checked TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// ইউজার সেশন - বট ইউজারদের কারেন্ট স্টেট ট্র্যাক
db.exec(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER UNIQUE NOT NULL,
    telegram_username TEXT,
    state TEXT DEFAULT 'idle',
    selected_app TEXT,
    assigned_numbers TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// নাম্বর অ্যালোকেশন - কোন নাম্বর কোন ইউজারকে দেওয়া হয়েছে
db.exec(`
  CREATE TABLE IF NOT EXISTS number_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL,
    phone_number TEXT NOT NULL,
    panel_name TEXT NOT NULL,
    app_id TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    allocated_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT,
    otp_code TEXT,
    otp_received_at TEXT,
    payout TEXT DEFAULT '',
    bot_token TEXT,
    FOREIGN KEY (telegram_user_id) REFERENCES user_sessions(telegram_user_id)
  )
`);

// payout column add (existing databases-এর জন্য)
try {
  db.exec(`ALTER TABLE number_allocations ADD COLUMN payout TEXT DEFAULT ''`);
} catch (e) {
  // column already exists — ignore
}

// Migration: Add bot_token to number_allocations if missing
try {
  const tableInfo = db.prepare("PRAGMA table_info(number_allocations)").all();
  if (!tableInfo.some(c => c.name === 'bot_token')) {
    db.prepare("ALTER TABLE number_allocations ADD COLUMN bot_token TEXT").run();
    console.log('Database migrated: added bot_token to number_allocations');
  }
} catch (e) {
  console.error('Migration error:', e.message);
}

// OTP লগ - সমস্ত প্রাপ্ত OTP লগ করা
db.exec(`
  CREATE TABLE IF NOT EXISTS otp_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT NOT NULL,
    panel_name TEXT NOT NULL,
    app_id TEXT NOT NULL,
    otp_code TEXT,
    full_message TEXT,
    received_at TEXT DEFAULT (datetime('now')),
    sent_to_user INTEGER DEFAULT 0,
    telegram_user_id INTEGER
  )
`);

// প্যানেল নাম্বার লগ - কোন প্যানেল থেকে  // 8. Panel Number Cache
  db.exec(`
  CREATE TABLE IF NOT EXISTS panel_number_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_name TEXT NOT NULL,
    app_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    UNIQUE(panel_name, app_id, phone_number)
  )`);
  
  // 9. Sent OTP Cache (for deduplication)
  db.exec(`
  CREATE TABLE IF NOT EXISTS sent_cache (
    message_hash TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 10. Dynamic Admins
  db.exec(`
  CREATE TABLE IF NOT EXISTS bot_admins (
    user_id INTEGER PRIMARY KEY,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

db.exec(`
  CREATE TABLE IF NOT EXISTS panel_settings (
    panel_name TEXT PRIMARY KEY,
    is_enabled INTEGER DEFAULT 1
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS dynamic_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    base_url TEXT NOT NULL,
    login_page_url TEXT DEFAULT '/ints/login',
    signin_url TEXT DEFAULT '/ints/signin',
    dashboard_path TEXT DEFAULT '/ints/agent',
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    type TEXT DEFAULT 'wolf',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migration: Ensure dynamic_panels has all required columns
try {
  const tableInfo = db.prepare("PRAGMA table_info(dynamic_panels)").all();
  if (tableInfo.length > 0) {
    const columnsToAdd = [
      { name: 'login_page_url', type: "TEXT DEFAULT '/ints/login'" },
      { name: 'signin_url', type: "TEXT DEFAULT '/ints/signin'" },
      { name: 'dashboard_path', type: "TEXT DEFAULT '/ints/agent'" },
      { name: 'is_enabled', type: 'INTEGER DEFAULT 1' },
      { name: 'type', type: "TEXT DEFAULT 'wolf'" }
    ];
    for (const col of columnsToAdd) {
      if (!tableInfo.some(c => c.name === col.name)) {
        db.exec(`ALTER TABLE dynamic_panels ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Database migrated: added ${col.name} to dynamic_panels`);
      }
    }
  }
} catch (e) {
  console.error('Migration error for dynamic_panels:', e.message);
}

// ইনডেক্স তৈরি
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_allocations_user ON number_allocations(telegram_user_id);
  CREATE INDEX IF NOT EXISTS idx_allocations_number ON number_allocations(phone_number);
  CREATE INDEX IF NOT EXISTS idx_allocations_status ON number_allocations(status);
  CREATE INDEX IF NOT EXISTS idx_otp_logs_number ON otp_logs(phone_number);
  CREATE INDEX IF NOT EXISTS idx_otp_logs_panel ON otp_logs(panel_name);
  CREATE INDEX IF NOT EXISTS idx_cache_panel_app ON panel_number_cache(panel_name, app_id);
`);

// অ্যাডমিন আপলোড করা নম্বর — প্রতিটি app-এর জন্য আলাদা pool
db.exec(`
  CREATE TABLE IF NOT EXISTS custom_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    is_used INTEGER DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(app_id, phone_number)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_custom_app ON custom_numbers(app_id, is_used);
`);

module.exports = db;
