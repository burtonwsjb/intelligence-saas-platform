# Production release checklist

Production must not be considered ready until an operator explicitly completes every external gate.

- [ ] Staging independently hosted and verified (full Phase 21)
- [ ] Controlled beta signed off (full Phase 22) **or** explicit skip authorized
- [ ] Production Neon + Redis + Vercel + Railway created **after** authorization
- [ ] `ISP_ENV=production` on all hosted processes
- [ ] Security checklist done
- [ ] Backups/PITR on
- [ ] Legal text reviewed (Terms/Privacy/AUP/API Terms)
- [ ] Stripe live still off unless separately authorized
- [ ] Real TCC production still off unless separately authorized
- [ ] DNS only after authorization
- [ ] Smoke checklist executed against production **after** deploy authorization
