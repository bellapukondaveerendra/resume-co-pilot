# Production Readiness Guide

## A. Infrastructure

### Recommended hosting (simple, no DevOps)

| Layer    | Option                         | Why                                                                 |
|----------|--------------------------------|----------------------------------------------------------------------|
| Backend  | Render (free tier → $7/mo)     | Auto-deploy from Git, env var UI, zero config                       |
| Frontend | Vercel (free)                  | Instant deploys, CDN, SPA routing just works                        |
| Database | Neon                           | Serverless Postgres, free tier, built-in branching                  |
| Domain   | Namecheap / Cloudflare         | Cloudflare preferred - free SSL + CDN + cf-ipcountry header         |

### Domain & SSL

- Point your domain to Vercel (frontend) and Render (backend) via CNAME/A records  
- SSL is automatic on both platforms  
- If using Cloudflare enable "Full (strict)" SSL mode  

## B. Backend

### Environment variables

- Never commit .env to Git  
- Add .env to .gitignore  

### CORS

- Use ALLOWED_ORIGINS  
- In production set it to your exact frontend URL (no wildcards)  

### Rate limiting

Install express-rate-limit and apply to auth routes  

### Logging

Add request logging using morgan  

### Error handling

Add a global error handler as the last middleware  

## C. Database (Neon)

### Production DB setup

- Create a separate project or branch for production  
- Do not reuse your dev database  
- initSchema() handles CREATE TABLE IF NOT EXISTS  

### Connection string

- Use pooled connection string (-pooler.)  

### Backups

- Neon free tier gives 7-day restore  
- Optional weekly pg_dump or branch snapshots  

### Migrations

- Use CREATE TABLE IF NOT EXISTS  
- Add ALTER TABLE inside initSchema() with try/catch  

## D. Auth & Security

### Password hashing

- bcrypt.hash(password, 12)  
- bcrypt.compare()  

### JWT

- Set expiresIn to 7d or 30d  

### Security headers

- Use helmet middleware  

### JWT secret

- Must be 48+ random characters  

## E. Payments (Stripe)

### Production setup

- Re-create all price IDs in live mode  
- Test keys only in dev  
- Production uses sk_live_  

### Webhook

- Ensure webhook deduplication using stripe_events table  

## F. Deployment

### Backend (Render)

- Connect GitHub repo  
- Root directory backend/  
- Start command node server.js  
- Add env variables  
- Deploy  

### Frontend (Vercel)

- Root directory frontend/  
- Build command npm run build  
- Output dist/  

### Vercel rewrite

{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://your-backend.onrender.com/api/:path*"
    }
  ]
}

### Stripe webhook

https://your-backend.onrender.com/api/stripe/webhook  

### CI/CD

- Push to main triggers auto deploy  

## Go-Live Checklist

### Before launch

- No test keys in .env  
- Stripe live price IDs set  
- DATABASE_URL is production DB  
- JWT_SECRET is 48+ chars  
- ALLOWED_ORIGINS is correct  
- Webhook configured  

### After deploy

- Registration gives 5 credits  
- Guest rate limiting works  
- Credits deduct correctly  
- Stripe checkout works  
- Credits added after payment  
- Export works  

### Safe test

- Make a small real payment  
- Refund via Stripe  
- Verify credits and webhook  
