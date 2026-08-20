# Local load burst (manual)

Use only against local disposable API. Example:

```bash
pnpm --filter @isp/api start
node --eval "for (let i=0;i<50;i++) fetch('http://127.0.0.1:3001/health').then(r=>r.status).then(console.log)"
```

See docs/load-testing.md. Never target production.
