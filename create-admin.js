#!/usr/bin/env node
/**
 * FB BAHI Panel — CLI Owner User Creator
 * Usage: node create-admin.js <username> <email> <password>
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const [, , username, email, password] = process.argv;

if (!username || !email || !password) {
  console.error('Usage: node create-admin.js <username> <email> <password>');
  process.exit(1);
}

const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!USERNAME_REGEX.test(username)) {
  console.error('Error: Username must be 3-32 characters (letters, numbers, _, ., -).');
  process.exit(1);
}

if (!EMAIL_REGEX.test(email)) {
  console.error('Error: Invalid email address format.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Error: Password must be at least 8 characters.');
  process.exit(1);
}

const dbPath = path.resolve(process.env.DB_PATH || path.join(process.cwd(), 'data', 'panel.db'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended')),
    registration_ip TEXT NOT NULL DEFAULT '',
    is_suspended INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    max_ram_mb INTEGER NOT NULL DEFAULT 8192,
    max_cpu_percent INTEGER NOT NULL DEFAULT 400,
    max_disk_gb INTEGER NOT NULL DEFAULT 50,
    max_mc_servers INTEGER NOT NULL DEFAULT 3,
    max_vm_instances INTEGER NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login TEXT
  );
`);

const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!cols.includes('status')) {
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}
if (!cols.includes('registration_ip')) {
  db.exec("ALTER TABLE users ADD COLUMN registration_ip TEXT NOT NULL DEFAULT ''");
}
if (!cols.includes('is_suspended')) {
  db.exec('ALTER TABLE users ADD COLUMN is_suspended INTEGER NOT NULL DEFAULT 0');
}

const passwordHash = bcrypt.hashSync(password, 12);

const existing = db
  .prepare('SELECT id, username FROM users WHERE username = ? OR email = ?')
  .get(username.trim(), email.trim().toLowerCase());

if (existing) {
  db.prepare(
    `UPDATE users
     SET username = ?, email = ?, password_hash = ?, role = 'owner', status = 'active', is_suspended = 0
     WHERE id = ?`
  ).run(username.trim(), email.trim().toLowerCase(), passwordHash, existing.id);
  console.log(`Updated owner account '${username}' (${email}) in ${dbPath}`);
} else {
  db.prepare(
    `INSERT INTO users (username, email, password_hash, role, status, is_suspended)
     VALUES (?, ?, ?, 'owner', 'active', 0)`
  ).run(username.trim(), email.trim().toLowerCase(), passwordHash);
  console.log(`Created owner account '${username}' (${email}) in ${dbPath}`);
}

db.close();
