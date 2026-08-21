# Deploy do Nucleus no servidor

Como deixar o nucleus rodando pra sempre (reinicia sozinho se cair, sobrevive a reboot).

## 1. Serviço systemd

Copia o arquivo de serviço pro lugar certo e liga:

```bash
sudo cp /opt/jarvis/nucleus/deploy/nucleus.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nucleus
```

Confere que subiu:

```bash
sudo systemctl status nucleus
```

Deve mostrar `active (running)` em verde. Daqui em diante:

```bash
sudo systemctl restart nucleus   # reinicia depois de um git pull
sudo systemctl stop nucleus      # para
sudo journalctl -u nucleus -f    # vê os logs ao vivo
```

Agora pode fechar o terminal — o nucleus continua no ar.

## 2. Atualizar depois de mexer no código

```bash
cd /opt/jarvis && git pull
cd nucleus && npm install --omit=dev
sudo systemctl restart nucleus
```

## 3. HTTPS (Caddy)

O nucleus fala HTTP puro na porta 3000. Sem TLS, senha e token viajam em
texto aberto. O Caddy resolve o certificado sozinho, de graça, se você tiver
um domínio apontando pro IP do servidor.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
nucleus.seudominio.com {
    reverse_proxy localhost:3000
}
```

```bash
sudo systemctl reload caddy
```

Pronto — `https://nucleus.seudominio.com` já responde com certificado válido.

## 4. Firewall

Fecha tudo menos SSH, HTTP e HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

Depois do Caddy no ar, a porta 3000 nem precisa ficar aberta pra internet —
só o Caddy (local) fala com ela. Sem firewall, deixe 3000 aberta pra testar;
com Caddy + firewall, feche a 3000 e acesse só pelo domínio.
