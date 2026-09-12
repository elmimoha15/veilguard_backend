# Showing the Veilguard logo in Gmail (BIMI) — later

Right now Gmail shows a generic "V" letter avatar next to `alerts@veilguard.dev`. Replacing it with the
real logo requires **BIMI** (Brand Indicators for Message Identification). This is DNS + certificate work,
not code. Steps, in order:

1. **Authenticate mail (prereq).** SPF + DKIM are already handled by Resend's domain verification for
   `veilguard.dev`. Confirm both pass on delivered mail (Gmail → "Show original").

2. **Publish DMARC at enforcement.** BIMI requires DMARC policy `p=quarantine` or `p=reject` (not `p=none`),
   applied to the domain (`pct=100`). Example TXT record at `_dmarc.veilguard.dev`:
   ```
   v=DMARC1; p=quarantine; rua=mailto:dmarc@veilguard.dev; pct=100; adkim=s; aspf=s
   ```
   Roll this out carefully — monitor `rua` aggregate reports first to be sure legitimate mail (Resend,
   any other senders) passes before moving to enforcement.

3. **Create an SVG Tiny PS logo.** BIMI only accepts SVG **Tiny 1.2 Portable/Secure** — a square,
   centered logo, no external refs, no scripts. The repo currently has only PNGs
   (`veilguard_frontend/public/logos/logo-mark.png`); a new SVG must be produced and hosted at an https URL
   (e.g. `https://veilguard.dev/logos/bimi-logo.svg`).

4. **Publish the BIMI DNS record** at `default._bimi.veilguard.dev`:
   ```
   v=BIMI1; l=https://veilguard.dev/logos/bimi-logo.svg; a=https://veilguard.dev/logos/vmc.pem
   ```
   `l=` is the logo; `a=` is the VMC (next step).

5. **Buy a VMC (required for Gmail).** Gmail will NOT display the BIMI logo without a **Verified Mark
   Certificate** from DigiCert or Entrust (~$1,000–$1,500/yr). It requires a registered trademark of the
   logo. Some clients (Apple Mail, Fastmail, Yahoo) show the logo from steps 1–4 **without** a VMC, but
   Gmail specifically does not.

Until a VMC is in place, Gmail keeps the letter avatar — everything else (SPF/DKIM/DMARC/BIMI record) can
be set up for free and will benefit deliverability + non-Gmail clients.
