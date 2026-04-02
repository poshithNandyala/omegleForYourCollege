# CampusLink Auth Testing Playbook

## Test Users

### Admin User
- **Email:** admin@campuslink.com
- **Password:** CampusLink@2024
- **Role:** admin
- **Notes:** Created on startup via seed_admin()

### Test User (via registration)
- **Email:** Must use Indian college domain (.ac.in, .edu.in)
- Example domains: iitb.ac.in, bits-pilani.ac.in, vit.ac.in, etc.

## Testing Commands

### 1. Test Health Endpoint
```bash
curl -s http://localhost:8001/api/health
```

### 2. Test Admin Login
```bash
curl -X POST http://localhost:8001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@campuslink.com","password":"CampusLink@2024"}'
```

### 3. Test Protected Endpoint
```bash
TOKEN="<access_token_from_login>"
curl http://localhost:8001/api/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

### 4. Test OTP (should reject non-college email)
```bash
# Should fail - not a college email
curl -X POST http://localhost:8001/api/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"test@gmail.com"}'

# Should succeed - college email
curl -X POST http://localhost:8001/api/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"test@iitb.ac.in"}'
```

## OAuth Testing

### Google OAuth Flow
1. Navigate to `/login`
2. Click "Continue with Google"
3. Redirects to: `https://auth.emergentagent.com/?redirect={origin}/auth/callback`
4. After Google auth, redirects to `/auth/callback#session_id=xxx`
5. Frontend exchanges session_id for user data via `/api/auth/google/callback`

### Allowed Email Domains
The app only allows Indian college email domains:
- .ac.in (most Indian universities)
- .edu.in (Indian educational institutions)
- .ernet.in (older Indian research network)

See `INDIAN_COLLEGE_DOMAINS` list in server.py for specific domains.

## MongoDB Verification
```bash
mongosh
use campuslink
db.users.find().pretty()
db.otp_tokens.find().pretty()
db.call_history.find().pretty()
```

## Success Criteria
- ✅ Admin login works with provided credentials
- ✅ JWT tokens are issued and validated correctly
- ✅ Non-college emails are rejected at OTP step
- ✅ College emails receive OTP (via Resend)
- ✅ Google OAuth validates email domain
- ✅ Protected routes require authentication
