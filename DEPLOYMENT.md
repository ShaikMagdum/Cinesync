# CineSync Complete Deployment Guide

CineSync is a single-process full-stack Node.js application that serves static frontend files and manages WebRTC signaling via WebSockets on `process.env.PORT`.

- **Zero database required** (sessions exist in volatile RAM).
- **Zero build step required for production** (`node server.js` runs directly).
- **Free hosting compatible** (Render, Replit, Railway, Koyeb, Docker).

---

## 🚀 Option 1: Render.com (Recommended Free Cloud Host)

Render provides a completely free tier with automatic HTTPS and native WebSocket support:

1. **Push your code to GitHub**:
   - Create a repository on [GitHub](https://github.com/new) (e.g. `cinesync`).
   - Push this codebase to your repository.

2. **Create Web Service on Render**:
   - Open the [Render Dashboard](https://dashboard.render.com/).
   - Click **New +** $\rightarrow$ **Web Service**.
   - Connect your GitHub repository.

3. **Configure Settings**:
   - **Name**: `cinesync` (or your preferred name)
   - **Region**: Choose closest to you and your date partner (e.g. Frankfurt, Oregon, Singapore)
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan Type**: `Free`

4. Click **Create Web Service**.
   Render will deploy your app and assign an HTTPS URL (e.g. `https://cinesync-xxxx.onrender.com`).
   Both WebSockets and streaming proxies will work out-of-the-box!

---

## ⚡ Option 2: Replit (Instant 1-Click Deployment)

1. Open [Replit](https://replit.com/).
2. Click **Create Repl** $\rightarrow$ Select **Import from GitHub** (or select **Node.js** and drag/drop files).
3. In the `.replit` configuration or shell:
   - Run command: `node server.js`
   - Entrypoint: `server.js`
4. Click the large green **Run** button at the top.
5. Replit launches the web view with full audio/video streaming and live WebSocket signaling!

---

## 🚂 Option 3: Railway.app

1. Log into [Railway](https://railway.app/).
2. Click **New Project** $\rightarrow$ **Deploy from GitHub repo**.
3. Select your repository.
4. Railway detects Node.js automatically and executes `node server.js`.
5. Under **Settings** $\rightarrow$ **Networking**, click **Generate Domain** to get a public HTTPS link.

---

## 🐳 Option 4: Docker & Self-Hosted VPS (DigitalOcean / Hetzner / AWS / Linode)

A ready-to-use `Dockerfile` is included in the project:

```bash
# 1. Build the Docker image
docker build -t cinesync .

# 2. Run the container on port 3000 (or any host port)
docker run -d -p 3000:3000 --name cinesync cinesync
```

### With Docker Compose:
Create `docker-compose.yml`:
```yaml
version: '3.8'
services:
  cinesync:
    build: .
    ports:
      - "3000:3000"
    restart: unless-stopped
    environment:
      - PORT=3000
      - NODE_ENV=production
```
Run `docker compose up -d`.

---

## 📁 How Gofile Streaming Works in CineSync

CineSync includes a built-in **HTTP 206 Byte-Range Streaming Proxy**:

1. **Direct Gofile Links**:
   - `https://store-*.gofile.io/download/web/...`
   - `https://proxy.moron-bots.workers.dev/...`
2. **Built-in Account Token**:
   - Pre-configured with authenticated access (`G9EyUX5BxXUtomQdnNN8qke6Oc3sZeJq`).
   - Supports custom tokens via the **"Gofile Stream"** modal in the top navigation bar.
3. **Frame-Accurate Seeking**:
   - Even for 3 GB+ 4K movies, CineSync streams with byte-range slicing so you and your partner can seek to any minute instantly without downloading the entire movie first!
