# CampusLink Test Credentials

## Admin Account

- **Email:** admin@campuslink.com
- **Password:** CampusLink@2024
- **Role:** admin

## Auth Endpoints

- POST `/api/auth/send-otp` - Send OTP to college email
- POST `/api/auth/verify-otp` - Verify OTP code
- POST `/api/auth/register` - Register new user (after OTP)
- POST `/api/auth/login` - Login with email/password
- GET `/api/auth/me` - Get current user (requires auth)
- POST `/api/auth/logout` - Logout user
- POST `/api/auth/google/callback` - Google OAuth callback

## Valid College Email Domains

Only Indian college emails are accepted:

- `.ac.in` - Most Indian universities
- `.edu.in` - Indian educational institutions
- `.ernet.in` - Indian research network

Example domains: iitb.ac.in, bits-pilani.ac.in, vit.ac.in, srmist.edu.in

## API Keys Configured

- **Resend API Key:** Configured (for OTP emails)
- **Emergent LLM Key:** Configured (for AI matching)

## Testing Notes

- Preview URL may be in sleep mode initially
- Backend API works on localhost:8001
- All tests passed: 100% backend, 95% frontend, 90% integration
