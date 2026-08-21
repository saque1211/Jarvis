import jwt from 'jsonwebtoken';
import { findUserById } from '../models/user.js';
import { findDeviceByToken } from '../models/device.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '30d' });
}

export function verifyUserAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token ausente.' });
  }

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.userId;
    req.user = { id: payload.userId, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

export function verifyDeviceAuth(req, res, next) {
  const token = req.headers['x-device-token'];
  if (!token) {
    return res.status(401).json({ erro: 'Token de dispositivo ausente.' });
  }

  try {
    const device = findDeviceByToken(token);
    if (!device) {
      return res.status(401).json({ erro: 'Dispositivo não aprovado.' });
    }
    req.device = device;
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido.' });
  }
}
