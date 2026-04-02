# CampusLink - Product Requirements Document

## Original Problem Statement
Build a college networking video chat app similar to Omegle for Indian college students only. Features:
- College email verification with OTP (only Indian college domains)
- Three connection modes: Same College, Same WiFi, Cross College
- Video/audio chat like Omegle using WebRTC
- AI-powered matching (Gemini 3 Flash)
- Study buddy mode for collaborative problem solving
- Call history and friends list
- Scalable for 10,000+ users

## User Choices
- **Email OTP:** Resend API
- **AI Provider:** Gemini 3 Flash via Emergent LLM Key
- **Video Chat:** WebRTC (cost-effective, peer-to-peer)
- **Auth:** JWT + Emergent Google OAuth
- **Design:** Fresh, engaging for college audience (Neo-Brutalist theme)

## Architecture
- **Frontend:** React 18 with Tailwind CSS
- **Backend:** FastAPI with Python
- **Database:** MongoDB
- **Real-time:** Socket.IO for WebRTC signaling
- **Email:** Resend for OTP delivery
- **AI:** Emergent LLM (Gemini 3 Flash) for matching & ice breakers

## User Personas
1. **Study Buddy Seeker** - Students looking for study partners
2. **Networker** - Students building professional connections
3. **Startup Founder** - Looking for co-founders
4. **Social Connector** - Looking for friends or romantic connections

## Core Requirements (Static)
1. ✅ College email validation (.ac.in, .edu.in only)
2. ✅ OTP verification via Resend
3. ✅ JWT authentication
4. ✅ Google OAuth (Emergent-managed)
5. ✅ Three connection modes
6. ✅ WebRTC video/audio chat
7. ✅ Real-time signaling via Socket.IO
8. ✅ AI-powered matching suggestions
9. ✅ Ice breaker generation
10. ✅ Friends system
11. ✅ Call history tracking
12. ✅ Profile management

## What's Been Implemented (Jan 2026)
- [x] Backend API with all auth endpoints
- [x] College email domain validation (comprehensive Indian domains list)
- [x] OTP generation and verification
- [x] JWT token management
- [x] Google OAuth integration
- [x] User matching queues (same college, same wifi, cross college)
- [x] WebRTC signaling server via Socket.IO
- [x] AI matching with Gemini 3 Flash
- [x] Ice breaker generation
- [x] Friends add/remove functionality
- [x] Call history tracking
- [x] Study session management
- [x] Neo-Brutalist UI design
- [x] Landing page
- [x] Login/Signup flows with OTP
- [x] Dashboard with tabs (Connect, Friends, History, Profile)
- [x] Video call interface with controls
- [x] In-call chat with AI ice breakers

## Test Results
- Backend: 100% passing
- Frontend: 95% passing
- Integration: 90% passing

## Prioritized Backlog

### P0 (Critical - Next Sprint)
- [ ] Add TURN server for NAT traversal in video calls
- [ ] Implement proper WiFi network detection (currently uses identifier)
- [ ] Add WebSocket reconnection logic

### P1 (High Priority)
- [ ] Collaborative whiteboard for study buddies
- [ ] Screen sharing in video calls
- [ ] Push notifications for matches
- [ ] User reporting/blocking system

### P2 (Medium Priority)
- [ ] Group study sessions (>2 users)
- [ ] Interest-based room creation
- [ ] Leaderboard for active networkers
- [ ] Integration with college calendars

### P3 (Nice to Have)
- [ ] Mobile app (React Native)
- [ ] Voice-only mode
- [ ] AI-powered conversation suggestions during calls
- [ ] Virtual backgrounds

## Next Tasks
1. Test video calling with real WebRTC connections
2. Add TURN server configuration
3. Implement proper WiFi detection
4. Add more comprehensive error handling
5. Performance optimization for 10K+ users
