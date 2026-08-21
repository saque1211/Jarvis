import express from 'express';
import {
  registerDevice,
  findDeviceById,
  findDevicesByUserId,
  findDeviceByApprovalToken,
  approveDevice,
  revokeDevice,
  assignDeviceToUser,
} from '../models/device.js';
import { verifyUserAuth, verifyDeviceAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  const { deviceName, deviceType } = req.body;

  if (!deviceName || !deviceType) {
    return res.status(400).json({ erro: 'Nome e tipo do dispositivo são obrigatórios.' });
  }

  if (!['pi', 'pc', 'phone'].includes(deviceType)) {
    return res.status(400).json({ erro: 'Tipo deve ser "pi", "pc" ou "phone".' });
  }

  try {
    // For now, devices register without a user — the user approves and claims them
    // In production, the user would be extracted from a token if device is already linked
    const device = registerDevice(null, deviceName, deviceType);

    res.status(201).json({
      ok: true,
      device: {
        id: device.id,
        approvalToken: device.approvalToken,
      },
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

router.post('/claim', verifyUserAuth, async (req, res) => {
  const { approvalToken } = req.body;

  if (!approvalToken) {
    return res.status(400).json({ erro: 'Approval token obrigatório.' });
  }

  try {
    const device = findDeviceByApprovalToken(approvalToken);
    if (!device) {
      return res.status(404).json({ erro: 'Token não encontrado ou já aprovado.' });
    }

    assignDeviceToUser(device.id, req.userId);
    const approved = approveDevice(device.id);

    res.json({
      ok: true,
      device: {
        id: approved.id,
        name: approved.name,
        type: approved.type,
        deviceToken: approved.deviceToken,
      },
    });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.get('/pending', verifyUserAuth, (req, res) => {
  const devices = findDevicesByUserId(req.userId);
  const pending = devices.filter(d => !d.approved);

  res.json({
    ok: true,
    pending: pending.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      registeredAt: d.registeredAt,
    })),
  });
});

router.post('/approve/:deviceId', verifyUserAuth, (req, res) => {
  try {
    const device = findDeviceById(req.params.deviceId);
    if (!device || device.userId !== req.userId) {
      return res.status(404).json({ erro: 'Dispositivo não encontrado.' });
    }

    const approved = approveDevice(device.id);

    res.json({
      ok: true,
      device: {
        id: approved.id,
        name: approved.name,
        type: approved.type,
        deviceToken: approved.deviceToken,
      },
    });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.get('/list', verifyUserAuth, (req, res) => {
  const devices = findDevicesByUserId(req.userId);
  const approved = devices.filter(d => d.approved);

  res.json({
    ok: true,
    devices: approved.map(d => ({
      id: d.id,
      name: d.name,
      type: d.type,
      approvedAt: d.approvedAt,
    })),
  });
});

router.delete('/:deviceId', verifyUserAuth, (req, res) => {
  try {
    revokeDevice(req.params.deviceId, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.get('/ping', verifyDeviceAuth, (req, res) => {
  res.json({
    ok: true,
    device: req.device.name,
  });
});

export default router;
