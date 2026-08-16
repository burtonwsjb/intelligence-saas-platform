# CRM, email, and go-to-market

A commercial multi-tenant SaaS needs its own revenue system. This is not inherited from TCG Card Central or any other product.

Nothing here is implemented in Phase 00.

## First-party CRM

Platform operators sell and support **tenants**, not TCG shoppers.

| Object | Meaning |
|---|---|
| `crm_accounts` | Company or buyer. May exist before a tenant is created. Links to `tenants.id` when they convert. |
| `crm_contacts` | People. May later match a user. |
| `crm_opportunities` | Pipeline: lead → trial → paid → expansion → churn risk |
| `crm_activities` | Notes, calls, emails, support touches |
| `crm_segments` | Manual or rule-based groups for outreach |

v1 CRM lives in the platform admin. It is intentionally small. It is not Salesforce.

Later, a connector may sync accounts and opportunities to Attio or HubSpot. The first-party tables remain the system of record for tenant lifecycle that billing already knows about.

## Relationship to tenants

```text
crm_account ──optional──► tenant ──► Stripe customer
     │
     └── crm_contacts
```

A lead can be worked before signup. Signup may create both a tenant and an account. Churn updates the opportunity and the tenant status, but does not delete Decision Records until retention rules say so.

## Email

**Provider:** Resend.

| Mail type | Trigger |
|---|---|
| Auth magic link / verification | Better Auth |
| Member invite | Admin adds a member |
| Billing receipt / failed payment | Stripe → this app → Resend, or Stripe-hosted email |
| Trial / usage approaching cap | Entitlement worker |
| Decision digest | Optional tenant setting, later |
| Operator CRM sequences | Platform admin, later |

Domains and templates are owned by this product. Do not use another product’s email host.

Unsubscribe and suppression apply to marketing and digest mail only. Auth and billing mail are transactional.

## Support surface

v1: email to the operator plus tenant status in admin.  
Later: help desk if volume requires it. Not in Phase 00–07.

## What is not CRM

- TCG Card Central users, vendors, or memberships
- Consumer collector contacts
- Shared Stripe customers with any other product
