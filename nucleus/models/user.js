import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.join(__dirname, '../vault');
const USERS_FILE = path.join(VAULT, 'users.json');

function ensureVault() {
  if (!fs.existsSync(VAULT)) fs.mkdirSync(VAULT, { recursive: true });
}

function readUsers() {
  ensureVault();
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeUsers(users) {
  ensureVault();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export async function createUser(email, password) {
  const users = readUsers();

  if (users.find(u => u.email === email)) {
    throw new Error('Email já cadastrado.');
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(),
    email,
    password: hashedPassword,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  writeUsers(users);

  return { id: user.id, email: user.email, createdAt: user.createdAt };
}

export async function findUserByEmail(email) {
  const users = readUsers();
  return users.find(u => u.email === email);
}

export async function findUserById(id) {
  const users = readUsers();
  return users.find(u => u.id === id);
}

export async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password);
}
