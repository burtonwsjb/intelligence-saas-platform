# CRM, email, and go-to-market

First-class. Not inherited from TCG Card Central.

Phase 17 implemented the first-party CRM around Better Auth organizations. See [PHASE_17.md](../PHASE_17.md). Lifecycle stages used by the application are `lead`, `signup`, `onboarding`, `activated`, `trial`, `customer`, `at_risk`, `past_due`, `canceled`, and `churned`. Billing subscription status is stored separately on `tenant_billing`.

## CRM account lifecycle

| Status | Meaning |
|---|---|
| `lead` | Not signed up |
| `trial` | In trial |
| `active` | Paying or entitled |
| `at_risk` | Usage drop, complaints, cancel intent |
| `past_due` | Failed payment |
| `cancelled` | Ended by customer |
| `churned` | Lapsed after cancel / unpaid |
| `reactivated` | Returned |
| `enterprise_prospect` | Sales-led |

Application lifecycle maps `cancelled` → `canceled` and treats `reactivated` as a return transition into `customer` or `trial`, not a standing stage. `crm_accounts` in this document correspond to `crm_organization_profile` linked 1:1 with the tenant organization.

v1 is first-party. Later optional Attio/HubSpot sync. Not Salesforce.

## Email (Resend)

Provider-neutral `EmailProvider` is implemented. Local/fixture adapters are the default. Resend is fail-closed without `RESEND_API_KEY` and does not send live mail in this phase.

### Transactional (no marketing unsubscribe)

- verification
- password reset
- invitation
- security
- billing
- usage warnings
- system alerts

### Lifecycle / marketing (suppression + unsubscribe)

- onboarding
- trial conversion
- education
- upgrade
- usage summaries
- inactivity
- newsletters
- product announcements
- win-back

Do not mix lists. Auth/billing mail must still send when a contact is unsubscribed from marketing.

## What is not CRM

- TCC shoppers or vendors
- Shared Stripe customers with other products
- Public creator profiles (those are intelligence objects, not sales leads — unless a creator becomes a tenant)

| Status | Meaning |
|---|---|
| `lead` | Not signed up |
| `trial` | In trial |
| `active` | Paying or entitled |
| `at_risk` | Usage drop, complaints, cancel intent |
| `past_due` | Failed payment |
| `cancelled` | Ended by customer |
| `churned` | Lapsed after cancel / unpaid |
| `reactivated` | Returned |
| `enterprise_prospect` | Sales-led |

`crm_accounts` link optionally to `tenants`. Contacts, opportunities, and activities form a **unified timeline** (`crm_activities` plus billing and usage events).

v1 is first-party. Later optional Attio/HubSpot sync. Not Salesforce.

## Email (Resend)

### Transactional (no marketing unsubscribe)

- verification
- password reset
- invitation
- security
- billing
- usage warnings
- system alerts

### Lifecycle / marketing (suppression + unsubscribe)

- onboarding
- trial conversion
- education
- upgrade
- usage summaries
- inactivity
- newsletters
- product announcements
- win-back

Do not mix lists. Auth/billing mail must still send when a contact is unsubscribed from marketing.

## What is not CRM

- TCC shoppers or vendors
- Shared Stripe customers with other products
- Public creator profiles (those are intelligence objects, not sales leads — unless a creator becomes a tenant)
