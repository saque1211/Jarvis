import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0' });
});

app.use('/auth', authRoutes);
app.use('/devices', deviceRoutes);

// Portal da conta — a mesma origem que faz o login tambem serve a pagina de
// login. E por isso que a pessoa nunca digita o endereco do servidor.
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`[nucleus] escutando em porta ${PORT}`);
});
