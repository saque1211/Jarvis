import express from 'express';
import { createUser, findUserByEmail, verifyPassword } from '../models/user.js';
import { sign, verifyUserAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ erro: 'Email e senha são obrigatórios.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ erro: 'Senha deve ter pelo menos 8 caracteres.' });
  }

  try {
    const user = await createUser(email, password);
    const token = sign({ userId: user.id, email: user.email });

    res.status(201).json({
      ok: true,
      user,
      token,
    });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ erro: 'Email e senha são obrigatórios.' });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    }

    const valid = await verifyPassword(user, password);
    if (!valid) {
      return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    }

    const token = sign({ userId: user.id, email: user.email });

    res.json({
      ok: true,
      user: { id: user.id, email: user.email },
      token,
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao fazer login.' });
  }
});

router.get('/profile', verifyUserAuth, async (req, res) => {
  res.json({
    ok: true,
    user: req.user,
  });
});

export default router;
