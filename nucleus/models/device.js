import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.join(__dirname, '../vault');
const DEVICES_FILE = path.join(VAULT, 'devices.json');

function ensureVault() {
  if (!fs.existsSync(VAULT)) fs.mkdirSync(VAULT, { recursive: true });
}

function readDevices() {
  ensureVault();
  if (!fs.existsSync(DEVICES_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeDevices(devices) {
  ensureVault();
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
}

export function registerDevice(userId, deviceName, deviceType) {
  const devices = readDevices();

  const device = {
    id: crypto.randomUUID(),
    userId,
    name: deviceName,
    type: deviceType, // 'pi', 'pc', 'phone'
    approved: false,
    approvalToken: crypto.randomUUID(),
    deviceToken: null,
    registeredAt: new Date().toISOString(),
    approvedAt: null,
  };

  devices.push(device);
  writeDevices(devices);

  return device;
}

export function findDeviceById(id) {
  const devices = readDevices();
  return devices.find(d => d.id === id);
}

export function findDevicesByUserId(userId) {
  const devices = readDevices();
  return devices.filter(d => d.userId === userId);
}

export function findDeviceByApprovalToken(token) {
  const devices = readDevices();
  return devices.find(d => d.approvalToken === token && !d.approved);
}

export function approveDevice(deviceId) {
  const devices = readDevices();
  const device = devices.find(d => d.id === deviceId);

  if (!device) throw new Error('Dispositivo não encontrado.');
  if (device.approved) throw new Error('Dispositivo já aprovado.');

  device.approved = true;
  device.approvedAt = new Date().toISOString();
  device.deviceToken = crypto.randomUUID();
  device.approvalToken = null; // invalidate approval token

  writeDevices(devices);
  return device;
}

export function findDeviceByToken(token) {
  const devices = readDevices();
  return devices.find(d => d.deviceToken === token && d.approved);
}

export function revokeDevice(deviceId, userId) {
  const devices = readDevices();
  const device = devices.find(d => d.id === deviceId && d.userId === userId);

  if (!device) throw new Error('Dispositivo não encontrado.');

  device.approved = false;
  device.deviceToken = null;

  writeDevices(devices);
}

export function assignDeviceToUser(deviceId, userId) {
  const devices = readDevices();
  const device = devices.find(d => d.id === deviceId);

  if (!device) throw new Error('Dispositivo não encontrado.');

  device.userId = userId;
  writeDevices(devices);
}
