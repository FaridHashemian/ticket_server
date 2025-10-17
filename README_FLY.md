# Fly.io Backend Bundle

## Files
- server.js — API under /api/*, writes data to DATA_DIR (set to /data via Fly config).
- Dockerfile — Node 18 alpine image, exposes port 8080.
- fly.toml — mounts a volume at /data, sets env, HTTP service on 8080.
- package.json — nodemailer installed.
- .env.example — SMTP example.
- users.json, seats.json — created/seeded at first run, stored on volume.

## Quick start
flyctl auth login
flyctl launch --no-deploy
# Replace fly.toml with the one in this folder (edit app/region).
flyctl volumes create data --region ord --size 1
flyctl secrets set SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... SMTP_SECURE=false   # optional
flyctl deploy

# Test
curl https://<your-app>.fly.dev/api/health
