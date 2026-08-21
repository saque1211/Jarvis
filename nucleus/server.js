import 'dotenv/config';
import express from 'express';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0' });
});

app.use('/auth', authRoutes);
app.use('/devices', deviceRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`[nucleus] escutando em porta ${PORT}`);
});
