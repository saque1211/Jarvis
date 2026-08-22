import express from 'express';
import {
  registerDevice,
  findDeviceById,
  findDevicesByUserId,
  findDeviceByApprovalToken,
  findDeviceByPollSecret,
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
    // O aparelho se registra sozinho, ainda sem dono. O usuario reivindica
    // depois digitando o codigo de 6 digitos no portal (rota /claim).
    const device = registerDevice(null, deviceName, deviceType);

    res.status(201).json({
      ok: true,
      device: {
        id: device.id,
        // Codigo de 6 digitos: o aparelho fala em voz alta, a pessoa digita.
        pairingCode: device.approvalToken,
        // Segredo longo: o aparelho guarda e usa em /poll pra pegar o token.
        pollSecret: device.pollSecret,
      },
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/**
 * O aparelho pergunta "ja me aprovaram?".
 *
 * Autenticado pelo pollSecret (longo, so o aparelho tem), nao pelo codigo de 6
 * digitos. Enquanto pendente, devolve approved:false. Depois que o usuario
 * aprova no celular, devolve o deviceToken — que o aparelho salva e passa a
 * usar em tudo.
 */
router.post('/poll', async (req, res) => {
  const { pollSecret } = req.body;

  if (!pollSecret) {
    return res.status(400).json({ erro: 'pollSecret obrigatório.' });
  }

  const device = findDeviceByPollSecret(pollSecret);
  if (!device) {
    return res.status(404).json({ erro: 'Dispositivo não encontrado.' });
  }

  if (!device.approved) {
    return res.json({ ok: true, approved: false });
  }

  res.json({
    ok: true,
    approved: true,
    deviceToken: device.deviceToken,
    device: { id: device.id, name: device.name, type: device.type },
  });
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

    // De proposito NAO devolve o deviceToken aqui: quem reivindica e o celular,
    // mas quem precisa do token e o aparelho. O aparelho pega o dele sozinho
    // pela rota /poll, com o pollSecret que so ele tem.
    res.json({
      ok: true,
      device: {
        id: approved.id,
        name: approved.name,
        type: approved.type,
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
