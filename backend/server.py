from dotenv import load_dotenv
load_dotenv()

import os
import uuid
import secrets
import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager

import bcrypt
import jwt
import resend
from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field
from motor.motor_asyncio import AsyncIOMotorClient
import socketio

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
MONGO_URL = os.environ.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME", "campuslink")
JWT_SECRET = os.environ.get("JWT_SECRET")
JWT_ALGORITHM = "HS256"
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
RESEND_FROM = os.environ.get("RESEND_FROM", "noreply@poshithcompany.in")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY")

# Initialize Resend
resend.api_key = RESEND_API_KEY

# Indian college email domains (comprehensive list)
INDIAN_COLLEGE_DOMAINS = [
    # IITs
    "iitb.ac.in", "iitd.ac.in", "iitk.ac.in", "iitm.ac.in", "iitkgp.ac.in",
    "iith.ac.in", "iitbbs.ac.in", "iitdh.ac.in", "iitgn.ac.in", "iitgoa.ac.in",
    "iitj.ac.in", "iitmandi.ac.in", "iitp.ac.in", "iitr.ac.in", "iitism.ac.in",
    "iitbhilai.ac.in", "iittp.ac.in", "iiti.ac.in", "iitpkd.ac.in",
    # NITs
    "nitk.ac.in", "nitw.ac.in", "nitt.edu", "nitc.ac.in", "nits.ac.in",
    "nitp.ac.in", "mnnit.ac.in", "nitj.ac.in", "nitrkl.ac.in", "svnit.ac.in",
    "nitdgp.ac.in", "manit.ac.in", "nita.ac.in", "nitap.ac.in", "nitdelhi.ac.in",
    "nitgoa.ac.in", "nitmeghalaya.ac.in", "nitm.ac.in", "nitnagaland.ac.in",
    "nitpy.ac.in", "nitsikkim.ac.in", "nitsri.ac.in", "nituk.ac.in", "vnit.ac.in",
    # IIITs
    "iiita.ac.in", "iiitd.ac.in", "iiitdm.ac.in", "iiitdwd.ac.in", "iiitg.ac.in",
    "iiitk.ac.in", "iiitl.ac.in", "iiitn.ac.in", "iiitkalyani.ac.in",
    "iiitkottayam.ac.in", "iiitkurnool.ac.in", "iiitmk.ac.in", "iiitnr.ac.in",
    "iiitpune.ac.in", "iiitranchi.ac.in", "iiitrpr.ac.in", "iiits.ac.in",
    "iiitvadodara.ac.in", "iiitdmj.ac.in",
    # IISERs
    "iiserbpr.ac.in", "iiserkol.ac.in", "iisermohali.ac.in", "iiserpune.ac.in",
    "iisertvm.ac.in", "iiserbhopal.ac.in", "iisertirupati.ac.in", "iiserberhampur.ac.in",
    # IISc
    "iisc.ac.in",
    # BITS
    "bits-pilani.ac.in", "pilani.bits-pilani.ac.in", "goa.bits-pilani.ac.in",
    "hyderabad.bits-pilani.ac.in", "dubai.bits-pilani.ac.in",
    # VIT, SRM, Manipal
    "vit.ac.in", "vitstudent.ac.in", "srmist.edu.in", "srmuniv.ac.in",
    "learner.manipal.edu", "manipal.edu", "mahe.edu",
    # DTU, NSUT, IGDTUW, IIIT Delhi
    "dtu.ac.in", "nsut.ac.in", "igdtuw.ac.in",
    # Central Universities
    "du.ac.in", "jnu.ac.in", "bhu.ac.in", "ecc.ac.in", "amu.ac.in", "uohyd.ac.in",
    # State Universities & Colleges
    "annauniv.edu", "psgtech.ac.in", "coimbatore.bits-pilani.ac.in",
    "pes.edu", "pesu.pes.edu", "msrit.edu", "bmsit.in", "rvce.edu.in",
    "nmit.ac.in", "sit.ac.in", "dsce.edu.in", "bmsce.ac.in",
    # More colleges
    "tcgcrest.in", "srmsec.ac.in", "thapar.edu", "lpu.in", "amity.edu",
    "sharda.ac.in", "bennett.edu.in", "jiit.ac.in", "jecrc.ac.in",
    # Generic student domains
    "ac.in", "edu.in", "ernet.in",
    # For testing
    "test.edu.in", "college.ac.in", "poshithcompany.in"
]

def is_valid_college_email(email: str) -> bool:
    """Check if email belongs to an Indian college domain"""
    email_lower = email.lower()
    domain = email_lower.split("@")[-1]
    
    # Direct domain match
    if domain in INDIAN_COLLEGE_DOMAINS:
        return True
    
    # Check if domain ends with common Indian education suffixes
    for suffix in [".ac.in", ".edu.in", ".ernet.in"]:
        if domain.endswith(suffix):
            return True
    
    return False

def get_college_from_email(email: str) -> str:
    """Extract college name from email domain"""
    domain = email.lower().split("@")[-1]
    # Remove common suffixes to get college identifier
    for suffix in [".ac.in", ".edu.in", ".ernet.in", ".edu", ".in"]:
        if domain.endswith(suffix):
            domain = domain[:-len(suffix)]
            break
    return domain.replace(".", " ").title()

# Pydantic Models
class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)
    name: str = Field(min_length=2)
    interests: List[str] = []
    looking_for: List[str] = []  # networking, love, cofounder, study_buddy

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class OTPRequest(BaseModel):
    email: EmailStr

class OTPVerify(BaseModel):
    email: EmailStr
    otp: str

class UserUpdate(BaseModel):
    name: Optional[str] = None
    interests: Optional[List[str]] = None
    looking_for: Optional[List[str]] = None
    bio: Optional[str] = None

class ConnectRequest(BaseModel):
    mode: str  # same_college, same_wifi, cross_college
    wifi_identifier: Optional[str] = None

class FriendRequest(BaseModel):
    friend_user_id: str

class AIMatchRequest(BaseModel):
    purpose: str  # networking, love, cofounder, study_buddy

class MessageSend(BaseModel):
    receiver_id: str
    content: str

# MongoDB client
client = None
db = None

# Socket.IO for real-time communication
sio = socketio.AsyncServer(
    async_mode='asgi',
    cors_allowed_origins="*",
    ping_timeout=60,
    ping_interval=25
)

# Matching queues
matching_queues = {
    "same_college": {},  # {college_id: [user_ids]}
    "same_wifi": {},      # {wifi_id: [user_ids]}
    "cross_college": []   # [user_ids]
}

# Active connections
active_users = {}  # {user_id: sid}
active_calls = {}  # {call_id: {user1_id, user2_id, status}}

async def get_db():
    return db

# Password functions
def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))

# JWT functions
def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=7),
        "type": "access"
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def create_refresh_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=30),
        "type": "refresh"
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

# Auth helper
async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
    
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        
        user = await db.users.find_one({"user_id": payload["sub"]}, {"_id": 0, "password_hash": 0})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

# Lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    global client, db
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    
    # Create indexes
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.users.create_index("college")
    await db.otp_tokens.create_index("expires_at", expireAfterSeconds=0)
    await db.call_history.create_index("participants")
    await db.call_history.create_index("created_at")
    await db.friends.create_index([("user_id", 1), ("friend_id", 1)], unique=True)
    await db.messages.create_index([("sender_id", 1), ("receiver_id", 1)])
    await db.login_attempts.create_index("identifier")
    
    # Seed admin
    await seed_admin()
    
    logger.info("CampusLink backend started")
    yield
    
    client.close()
    logger.info("CampusLink backend stopped")

async def seed_admin():
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@campuslink.com")
    admin_password = os.environ.get("ADMIN_PASSWORD", "CampusLink@2024")
    
    existing = await db.users.find_one({"email": admin_email})
    if existing is None:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        await db.users.insert_one({
            "user_id": user_id,
            "email": admin_email,
            "password_hash": hash_password(admin_password),
            "name": "Admin",
            "role": "admin",
            "college": "CampusLink HQ",
            "email_verified": True,
            "interests": [],
            "looking_for": [],
            "bio": "CampusLink Administrator",
            "created_at": datetime.now(timezone.utc),
            "online": False
        })
        logger.info(f"Admin user created: {admin_email}")
    elif not verify_password(admin_password, existing.get("password_hash", "")):
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {"password_hash": hash_password(admin_password)}}
        )
        logger.info("Admin password updated")

# FastAPI app
app = FastAPI(title="CampusLink API", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Socket.IO
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# ============ AUTH ENDPOINTS ============

@app.post("/api/auth/send-otp")
async def send_otp(request: OTPRequest):
    """Send OTP to college email for verification"""
    email = request.email.lower()
    
    if not is_valid_college_email(email):
        raise HTTPException(
            status_code=400, 
            detail="Please use a valid Indian college email address (.ac.in, .edu.in)"
        )
    
    # Generate 6-digit OTP
    otp = ''.join([str(secrets.randbelow(10)) for _ in range(6)])
    
    # Store OTP with 10 min expiry
    await db.otp_tokens.delete_many({"email": email})
    await db.otp_tokens.insert_one({
        "email": email,
        "otp": otp,
        "expires_at": datetime.now(timezone.utc) + timedelta(minutes=10),
        "created_at": datetime.now(timezone.utc)
    })
    
    # Send email via Resend
    html_content = f"""
    <div style="font-family: 'Outfit', sans-serif; max-width: 500px; margin: 0 auto; padding: 40px; background: #FFF8E7;">
        <div style="background: #FFFFFF; border: 2px solid #121212; padding: 32px; box-shadow: 4px 4px 0px #121212;">
            <h1 style="font-family: 'Bricolage Grotesque', sans-serif; color: #121212; margin: 0 0 24px 0; font-size: 28px;">
                CampusLink Verification
            </h1>
            <p style="color: #4A4A4A; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                Your verification code is:
            </p>
            <div style="background: #FF49DB; border: 2px solid #121212; padding: 16px; text-align: center; box-shadow: 4px 4px 0px #121212;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #121212;">{otp}</span>
            </div>
            <p style="color: #4A4A4A; font-size: 14px; margin-top: 24px;">
                This code expires in 10 minutes.
            </p>
        </div>
    </div>
    """
    
    try:
        params = {
            "from": RESEND_FROM,
            "to": [email],
            "subject": "Your CampusLink Verification Code",
            "html": html_content
        }
        await asyncio.to_thread(resend.Emails.send, params)
        logger.info(f"OTP sent to {email}")
        return {"status": "success", "message": "OTP sent to your email"}
    except Exception as e:
        logger.error(f"Failed to send OTP: {e}")
        raise HTTPException(status_code=500, detail="Failed to send OTP email")

@app.post("/api/auth/verify-otp")
async def verify_otp(request: OTPVerify):
    """Verify OTP code"""
    email = request.email.lower()
    
    otp_doc = await db.otp_tokens.find_one({"email": email, "otp": request.otp})
    if not otp_doc:
        raise HTTPException(status_code=400, detail="Invalid OTP code")
    
    expires_at = otp_doc["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    
    if expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="OTP has expired")
    
    # Mark OTP as used
    await db.otp_tokens.delete_one({"_id": otp_doc["_id"]})
    
    return {"status": "success", "message": "Email verified", "email": email}

@app.post("/api/auth/register")
async def register(data: UserRegister, response: Response):
    """Register new user after OTP verification"""
    email = data.email.lower()
    
    if not is_valid_college_email(email):
        raise HTTPException(
            status_code=400,
            detail="Please use a valid Indian college email address"
        )
    
    # Check if user exists
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    college = get_college_from_email(email)
    
    user_doc = {
        "user_id": user_id,
        "email": email,
        "password_hash": hash_password(data.password),
        "name": data.name,
        "college": college,
        "email_verified": True,
        "interests": data.interests,
        "looking_for": data.looking_for,
        "bio": "",
        "friends": [],
        "online": False,
        "last_seen": datetime.now(timezone.utc),
        "created_at": datetime.now(timezone.utc)
    }
    
    await db.users.insert_one(user_doc)
    
    # Create tokens
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)
    
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=True, samesite="none",
        max_age=7*24*60*60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=True, samesite="none",
        max_age=30*24*60*60, path="/"
    )
    
    user_doc.pop("password_hash")
    user_doc.pop("_id", None)
    
    return {
        "status": "success",
        "user": user_doc,
        "access_token": access_token
    }

@app.post("/api/auth/login")
async def login(data: UserLogin, request: Request, response: Response):
    """Login with email and password"""
    email = data.email.lower()
    
    # Brute force check
    ip = request.client.host if request.client else "unknown"
    identifier = f"{ip}:{email}"
    
    attempts_doc = await db.login_attempts.find_one({"identifier": identifier})
    if attempts_doc:
        if attempts_doc.get("locked_until"):
            locked_until = attempts_doc["locked_until"]
            if locked_until.tzinfo is None:
                locked_until = locked_until.replace(tzinfo=timezone.utc)
            if locked_until > datetime.now(timezone.utc):
                raise HTTPException(
                    status_code=429,
                    detail="Too many failed attempts. Try again in 15 minutes."
                )
    
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(data.password, user.get("password_hash", "")):
        # Increment failed attempts
        await db.login_attempts.update_one(
            {"identifier": identifier},
            {
                "$inc": {"attempts": 1},
                "$set": {"last_attempt": datetime.now(timezone.utc)},
                "$setOnInsert": {"created_at": datetime.now(timezone.utc)}
            },
            upsert=True
        )
        
        # Check if should lock
        updated = await db.login_attempts.find_one({"identifier": identifier})
        if updated and updated.get("attempts", 0) >= 5:
            await db.login_attempts.update_one(
                {"identifier": identifier},
                {"$set": {"locked_until": datetime.now(timezone.utc) + timedelta(minutes=15)}}
            )
        
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    # Clear failed attempts on success
    await db.login_attempts.delete_one({"identifier": identifier})
    
    user_id = user["user_id"]
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)
    
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=True, samesite="none",
        max_age=7*24*60*60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=True, samesite="none",
        max_age=30*24*60*60, path="/"
    )
    
    user.pop("password_hash", None)
    user.pop("_id", None)
    
    return {
        "status": "success",
        "user": user,
        "access_token": access_token
    }

@app.get("/api/auth/me")
async def get_me(request: Request):
    """Get current user profile"""
    user = await get_current_user(request)
    return user

@app.post("/api/auth/logout")
async def logout(response: Response):
    """Logout user"""
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"status": "success", "message": "Logged out"}

@app.get("/api/auth/google")
async def google_auth_redirect():
    """Get Google OAuth URL"""
    # This will be handled by frontend using Emergent OAuth
    return {"message": "Use frontend for Google OAuth"}

@app.post("/api/auth/google/callback")
async def google_callback(request: Request, response: Response):
    """Handle Google OAuth callback from Emergent Auth"""
    body = await request.json()
    session_id = body.get("session_id")
    
    if not session_id:
        raise HTTPException(status_code=400, detail="Missing session_id")
    
    try:
        import httpx
        async with httpx.AsyncClient() as client_http:
            resp = await client_http.get(
                "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
                headers={"X-Session-ID": session_id}
            )
            
            if resp.status_code != 200:
                raise HTTPException(status_code=401, detail="Invalid session")
            
            google_data = resp.json()
    except Exception as e:
        logger.error(f"Google auth error: {e}")
        raise HTTPException(status_code=500, detail="Failed to verify Google session")
    
    email = google_data.get("email", "").lower()
    
    if not is_valid_college_email(email):
        raise HTTPException(
            status_code=400,
            detail="Please use a valid Indian college email for signup"
        )
    
    # Check if user exists
    user = await db.users.find_one({"email": email})
    
    if not user:
        # Create new user
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        college = get_college_from_email(email)
        
        user_doc = {
            "user_id": user_id,
            "email": email,
            "name": google_data.get("name", ""),
            "picture": google_data.get("picture", ""),
            "college": college,
            "email_verified": True,
            "interests": [],
            "looking_for": [],
            "bio": "",
            "friends": [],
            "online": False,
            "last_seen": datetime.now(timezone.utc),
            "created_at": datetime.now(timezone.utc),
            "auth_provider": "google"
        }
        
        await db.users.insert_one(user_doc)
        user = user_doc
    else:
        user_id = user["user_id"]
    
    # Create tokens
    access_token = create_access_token(user["user_id"], email)
    refresh_token = create_refresh_token(user["user_id"])
    
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=True, samesite="none",
        max_age=7*24*60*60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=True, samesite="none",
        max_age=30*24*60*60, path="/"
    )
    
    user.pop("password_hash", None)
    user.pop("_id", None)
    
    return {
        "status": "success",
        "user": user,
        "access_token": access_token
    }

# ============ USER ENDPOINTS ============

@app.get("/api/users/profile")
async def get_profile(request: Request):
    """Get current user's full profile"""
    user = await get_current_user(request)
    return user

@app.put("/api/users/profile")
async def update_profile(data: UserUpdate, request: Request):
    """Update user profile"""
    user = await get_current_user(request)
    
    update_data = {}
    if data.name:
        update_data["name"] = data.name
    if data.interests is not None:
        update_data["interests"] = data.interests
    if data.looking_for is not None:
        update_data["looking_for"] = data.looking_for
    if data.bio is not None:
        update_data["bio"] = data.bio
    
    if update_data:
        await db.users.update_one(
            {"user_id": user["user_id"]},
            {"$set": update_data}
        )
    
    updated = await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0, "password_hash": 0})
    return updated

@app.get("/api/users/{user_id}")
async def get_user(user_id: str, request: Request):
    """Get another user's public profile"""
    await get_current_user(request)  # Ensure authenticated
    
    user = await db.users.find_one(
        {"user_id": user_id},
        {"_id": 0, "password_hash": 0, "email": 0}
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    return user

# ============ FRIENDS ENDPOINTS ============

@app.post("/api/friends/add")
async def add_friend(data: FriendRequest, request: Request):
    """Add a user as friend"""
    user = await get_current_user(request)
    
    if user["user_id"] == data.friend_user_id:
        raise HTTPException(status_code=400, detail="Cannot add yourself as friend")
    
    friend = await db.users.find_one({"user_id": data.friend_user_id})
    if not friend:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Check if already friends
    existing = await db.friends.find_one({
        "user_id": user["user_id"],
        "friend_id": data.friend_user_id
    })
    if existing:
        raise HTTPException(status_code=400, detail="Already friends")
    
    # Add friendship (bidirectional)
    await db.friends.insert_one({
        "user_id": user["user_id"],
        "friend_id": data.friend_user_id,
        "created_at": datetime.now(timezone.utc)
    })
    await db.friends.insert_one({
        "user_id": data.friend_user_id,
        "friend_id": user["user_id"],
        "created_at": datetime.now(timezone.utc)
    })
    
    return {"status": "success", "message": "Friend added"}

@app.delete("/api/friends/{friend_id}")
async def remove_friend(friend_id: str, request: Request):
    """Remove a friend"""
    user = await get_current_user(request)
    
    await db.friends.delete_many({
        "$or": [
            {"user_id": user["user_id"], "friend_id": friend_id},
            {"user_id": friend_id, "friend_id": user["user_id"]}
        ]
    })
    
    return {"status": "success", "message": "Friend removed"}

@app.get("/api/friends")
async def get_friends(request: Request):
    """Get all friends"""
    user = await get_current_user(request)
    
    friendships = await db.friends.find(
        {"user_id": user["user_id"]},
        {"_id": 0}
    ).to_list(100)
    
    friend_ids = [f["friend_id"] for f in friendships]
    
    friends = await db.users.find(
        {"user_id": {"$in": friend_ids}},
        {"_id": 0, "password_hash": 0, "email": 0}
    ).to_list(100)
    
    return {"friends": friends}

# ============ CALL HISTORY ENDPOINTS ============

@app.get("/api/calls/history")
async def get_call_history(request: Request):
    """Get user's call history"""
    user = await get_current_user(request)
    
    calls = await db.call_history.find(
        {"participants": user["user_id"]},
        {"_id": 0}
    ).sort("created_at", -1).to_list(50)
    
    # Enrich with user data
    for call in calls:
        other_id = [p for p in call["participants"] if p != user["user_id"]][0]
        other_user = await db.users.find_one(
            {"user_id": other_id},
            {"_id": 0, "password_hash": 0, "email": 0}
        )
        call["other_user"] = other_user
    
    return {"calls": calls}

# ============ MATCHING ENDPOINTS ============

@app.post("/api/match/find")
async def find_match(data: ConnectRequest, request: Request):
    """Find a match based on connection mode"""
    user = await get_current_user(request)
    user_id = user["user_id"]
    college = user.get("college", "")
    
    match_id = None
    
    if data.mode == "same_college":
        # Match within same college
        if college not in matching_queues["same_college"]:
            matching_queues["same_college"][college] = []
        
        queue = matching_queues["same_college"][college]
        if queue and queue[0] != user_id:
            match_id = queue.pop(0)
        else:
            if user_id not in queue:
                queue.append(user_id)
    
    elif data.mode == "same_wifi":
        wifi_id = data.wifi_identifier or "default"
        if wifi_id not in matching_queues["same_wifi"]:
            matching_queues["same_wifi"][wifi_id] = []
        
        queue = matching_queues["same_wifi"][wifi_id]
        if queue and queue[0] != user_id:
            match_id = queue.pop(0)
        else:
            if user_id not in queue:
                queue.append(user_id)
    
    elif data.mode == "cross_college":
        queue = matching_queues["cross_college"]
        # Find someone from different college
        for i, uid in enumerate(queue):
            if uid != user_id:
                other_user = await db.users.find_one({"user_id": uid})
                if other_user and other_user.get("college") != college:
                    match_id = queue.pop(i)
                    break
        
        if not match_id and user_id not in queue:
            queue.append(user_id)
    
    if match_id:
        # Create call record
        call_id = f"call_{uuid.uuid4().hex[:12]}"
        call_doc = {
            "call_id": call_id,
            "participants": [user_id, match_id],
            "mode": data.mode,
            "status": "matched",
            "created_at": datetime.now(timezone.utc)
        }
        await db.call_history.insert_one(call_doc)
        
        # Get matched user info
        matched_user = await db.users.find_one(
            {"user_id": match_id},
            {"_id": 0, "password_hash": 0, "email": 0}
        )
        
        return {
            "status": "matched",
            "call_id": call_id,
            "matched_user": matched_user
        }
    
    return {"status": "waiting", "message": "Looking for a match..."}

@app.post("/api/match/cancel")
async def cancel_match(request: Request):
    """Cancel matching and remove from queues"""
    user = await get_current_user(request)
    user_id = user["user_id"]
    
    # Remove from all queues
    for college, queue in matching_queues["same_college"].items():
        if user_id in queue:
            queue.remove(user_id)
    
    for wifi, queue in matching_queues["same_wifi"].items():
        if user_id in queue:
            queue.remove(user_id)
    
    if user_id in matching_queues["cross_college"]:
        matching_queues["cross_college"].remove(user_id)
    
    return {"status": "success", "message": "Matching cancelled"}

# ============ AI MATCHING ENDPOINTS ============

@app.post("/api/ai/suggest-match")
async def ai_suggest_match(data: AIMatchRequest, request: Request):
    """Get AI-powered match suggestions"""
    user = await get_current_user(request)
    
    # Get potential matches from same college or cross-college
    potential_users = await db.users.find(
        {
            "user_id": {"$ne": user["user_id"]},
            "looking_for": data.purpose
        },
        {"_id": 0, "password_hash": 0, "email": 0}
    ).to_list(20)
    
    if not potential_users:
        return {"suggestions": [], "message": "No matching users found"}
    
    # Use Gemini for AI matching
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"match_{user['user_id']}_{uuid.uuid4().hex[:8]}",
            system_message="""You are a matchmaking AI for CampusLink, a college networking app.
            Analyze user profiles and suggest the best matches based on compatibility.
            Consider interests, goals, and what they're looking for.
            Return JSON with top 3 matches and reasons."""
        ).with_model("gemini", "gemini-3-flash-preview")
        
        user_profile = f"Name: {user.get('name')}, College: {user.get('college')}, Interests: {user.get('interests', [])}, Looking for: {data.purpose}, Bio: {user.get('bio', '')}"
        
        candidates = "\n".join([
            f"- {u.get('name')} from {u.get('college')}: Interests: {u.get('interests', [])}, Bio: {u.get('bio', '')}"
            for u in potential_users[:10]
        ])
        
        prompt = f"""Find the best matches for this user:
        
User Profile: {user_profile}

Candidates:
{candidates}

Return JSON: {{"matches": [{{"name": "...", "reason": "short reason"}}]}}"""
        
        response = await chat.send_message(UserMessage(text=prompt))
        
        return {
            "suggestions": potential_users[:5],
            "ai_analysis": response
        }
    except Exception as e:
        logger.error(f"AI matching error: {e}")
        return {
            "suggestions": potential_users[:5],
            "ai_analysis": None,
            "error": "AI analysis unavailable"
        }

@app.post("/api/ai/ice-breaker")
async def get_ice_breaker(request: Request):
    """Get AI-generated ice breaker suggestions"""
    user = await get_current_user(request)
    body = await request.json()
    other_user_id = body.get("other_user_id")
    
    if not other_user_id:
        raise HTTPException(status_code=400, detail="other_user_id required")
    
    other_user = await db.users.find_one(
        {"user_id": other_user_id},
        {"_id": 0, "password_hash": 0, "email": 0}
    )
    if not other_user:
        raise HTTPException(status_code=404, detail="User not found")
    
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
        
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"icebreaker_{uuid.uuid4().hex[:8]}",
            system_message="""You are a friendly conversation starter AI for CampusLink.
            Generate 3 casual, fun ice breaker questions or conversation starters.
            Make them relevant to both users' interests and college life.
            Keep them short and engaging."""
        ).with_model("gemini", "gemini-3-flash-preview")
        
        prompt = f"""Generate ice breakers for these two students:

User 1: {user.get('name')} from {user.get('college')}, interests: {user.get('interests', [])}
User 2: {other_user.get('name')} from {other_user.get('college')}, interests: {other_user.get('interests', [])}

Give 3 short, fun conversation starters."""
        
        response = await chat.send_message(UserMessage(text=prompt))
        
        return {"ice_breakers": response}
    except Exception as e:
        logger.error(f"Ice breaker error: {e}")
        return {
            "ice_breakers": [
                "What's your favorite spot on campus?",
                "Any exciting projects you're working on?",
                "What got you interested in your field?"
            ]
        }

# ============ STUDY BUDDY ENDPOINTS ============

@app.post("/api/study/create-session")
async def create_study_session(request: Request):
    """Create a collaborative study session"""
    user = await get_current_user(request)
    body = await request.json()
    
    session_id = f"study_{uuid.uuid4().hex[:12]}"
    session_doc = {
        "session_id": session_id,
        "created_by": user["user_id"],
        "participants": [user["user_id"]],
        "topic": body.get("topic", "General Study"),
        "problem": body.get("problem", ""),
        "solutions": [],
        "chat_messages": [],
        "status": "active",
        "created_at": datetime.now(timezone.utc)
    }
    
    await db.study_sessions.insert_one(session_doc)
    
    return {"status": "success", "session": session_doc}

@app.post("/api/study/{session_id}/join")
async def join_study_session(session_id: str, request: Request):
    """Join an existing study session"""
    user = await get_current_user(request)
    
    session = await db.study_sessions.find_one({"session_id": session_id})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    if user["user_id"] not in session["participants"]:
        await db.study_sessions.update_one(
            {"session_id": session_id},
            {"$push": {"participants": user["user_id"]}}
        )
    
    session = await db.study_sessions.find_one({"session_id": session_id}, {"_id": 0})
    return {"status": "success", "session": session}

@app.post("/api/study/{session_id}/solution")
async def submit_solution(session_id: str, request: Request):
    """Submit a solution to the study problem"""
    user = await get_current_user(request)
    body = await request.json()
    
    solution = {
        "user_id": user["user_id"],
        "content": body.get("content", ""),
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    
    await db.study_sessions.update_one(
        {"session_id": session_id},
        {"$push": {"solutions": solution}}
    )
    
    return {"status": "success", "solution": solution}

# ============ WEBSOCKET SIGNALING ============

@sio.event
async def connect(sid, environ):
    logger.info(f"Client connected: {sid}")

@sio.event
async def disconnect(sid):
    logger.info(f"Client disconnected: {sid}")
    # Remove from active users
    user_id = None
    for uid, s in list(active_users.items()):
        if s == sid:
            user_id = uid
            del active_users[uid]
            break
    
    if user_id:
        # Update user online status
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"online": False, "last_seen": datetime.now(timezone.utc)}}
        )
        
        # Remove from matching queues
        for college, queue in matching_queues["same_college"].items():
            if user_id in queue:
                queue.remove(user_id)
        
        for wifi, queue in matching_queues["same_wifi"].items():
            if user_id in queue:
                queue.remove(user_id)
        
        if user_id in matching_queues["cross_college"]:
            matching_queues["cross_college"].remove(user_id)

@sio.event
async def register_user(sid, data):
    """Register user socket connection"""
    user_id = data.get("user_id")
    if user_id:
        active_users[user_id] = sid
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"online": True}}
        )
        await sio.emit("registered", {"status": "ok"}, to=sid)

@sio.event
async def offer(sid, data):
    """WebRTC offer signal"""
    target_id = data.get("target_id")
    if target_id in active_users:
        await sio.emit("offer", {
            "offer": data.get("offer"),
            "from_id": data.get("from_id"),
            "call_id": data.get("call_id")
        }, to=active_users[target_id])

@sio.event
async def answer(sid, data):
    """WebRTC answer signal"""
    target_id = data.get("target_id")
    if target_id in active_users:
        await sio.emit("answer", {
            "answer": data.get("answer"),
            "from_id": data.get("from_id"),
            "call_id": data.get("call_id")
        }, to=active_users[target_id])

@sio.event
async def ice_candidate(sid, data):
    """WebRTC ICE candidate"""
    target_id = data.get("target_id")
    if target_id in active_users:
        await sio.emit("ice_candidate", {
            "candidate": data.get("candidate"),
            "from_id": data.get("from_id")
        }, to=active_users[target_id])

@sio.event
async def end_call(sid, data):
    """End call signal"""
    target_id = data.get("target_id")
    call_id = data.get("call_id")
    
    if call_id:
        await db.call_history.update_one(
            {"call_id": call_id},
            {"$set": {
                "status": "ended",
                "ended_at": datetime.now(timezone.utc),
                "duration": data.get("duration", 0)
            }}
        )
    
    if target_id in active_users:
        await sio.emit("call_ended", {
            "from_id": data.get("from_id"),
            "call_id": call_id
        }, to=active_users[target_id])

@sio.event
async def chat_message(sid, data):
    """In-call chat message"""
    target_id = data.get("target_id")
    if target_id in active_users:
        await sio.emit("chat_message", {
            "message": data.get("message"),
            "from_id": data.get("from_id")
        }, to=active_users[target_id])

# ============ HEALTH & STATS ============

@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "online_users": len(active_users)
    }

@app.get("/api/stats")
async def get_stats():
    """Get platform statistics"""
    total_users = await db.users.count_documents({})
    online_users = len(active_users)
    total_calls = await db.call_history.count_documents({})
    
    return {
        "total_users": total_users,
        "online_users": online_users,
        "total_calls": total_calls
    }

# For running with socket.io
app = socket_app
