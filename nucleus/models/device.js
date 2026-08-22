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

// Quanto tempo o codigo curto vale. Curto de proposito: o aparelho fala o
// codigo em voz alta e voce digita no celular; se ninguem parear em 10 min, o
// codigo morre e o aparelho gera outro. Sem isso, um numero de 6 digitos
// ficaria valido pra sempre e daria pra adivinhar por tentativa.
const VALIDADE_CODIGO_MS = 10 * 60 * 1000;

/**
 * Codigo de 6 digitos que o aparelho fala em voz alta.
 *
 * Digitos, nao letras: sao faceis de falar em portugues ("quatro, oito,
 * dois...") e de digitar no teclado numerico do celular. Garante que nao
 * colida com outro codigo ainda pendente e valido.
 */
function gerarCodigoCurto(devices) {
  const agora = Date.now();
  const pendentes = new Set(
    devices
      .filter(d => !d.approved && d.approvalToken &&
        (!d.approvalExpiresAt || new Date(d.approvalExpiresAt).getTime() > agora))
      .map(d => d.approvalToken)
  );
  for (let tentativa = 0; tentativa < 50; tentativa++) {
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!pendentes.has(codigo)) return codigo;
  }
  // Praticamente impossivel chegar aqui (seria 1 milhao de codigos vivos).
  throw new Error('Não consegui gerar um código livre. Tente de novo.');
}

export function registerDevice(userId, deviceName, deviceType) {
  const devices = readDevices();
  const agora = Date.now();

  const device = {
    id: crypto.randomUUID(),
    userId,
    name: deviceName,
    type: deviceType, // 'pi', 'pc', 'phone'
    approved: false,
    // O que a pessoa digita: 6 digitos, o aparelho fala em voz alta.
    approvalToken: gerarCodigoCurto(devices),
    approvalExpiresAt: new Date(agora + VALIDADE_CODIGO_MS).toISOString(),
    // O que o APARELHO guarda em segredo: longo e imprevisivel. E com ele que
    // o aparelho pergunta "ja me aprovaram?" e recebe o deviceToken. Separar
    // dos 6 digitos e o que impede quem adivinha o codigo curto de roubar o
    // token — aprovar exige a conta logada; pegar o token exige este segredo.
    pollSecret: crypto.randomUUID(),
    deviceToken: null,
    registeredAt: new Date().toISOString(),
    approvedAt: null,
  };

  devices.push(device);
  writeDevices(devices);

  return device;
}

export function findDeviceByPollSecret(secret) {
  const devices = readDevices();
  return devices.find(d => d.pollSecret === secret);
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
  const agora = Date.now();
  return devices.find(d =>
    d.approvalToken === token &&
    !d.approved &&
    (!d.approvalExpiresAt || new Date(d.approvalExpiresAt).getTime() > agora)
  );
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
  device.approvalExpiresAt = null;

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
