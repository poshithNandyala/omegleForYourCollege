from dotenv import load_dotenv
load_dotenv()

import os
import uuid
import secrets
import asyncio
import logging
import ipaddress
import json
import re
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any, Literal
from contextlib import asynccontextmanager

import bcrypt
import httpx
import jwt
import resend
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from motor.motor_asyncio import AsyncIOMotorClient
import socketio
from pymongo.errors import PyMongoError, ServerSelectionTimeoutError, DuplicateKeyError
from redis.asyncio import Redis
from redis.exceptions import RedisError

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DEFAULT_ADMIN_EMAIL = "admin@campuslink.com"
DEFAULT_ADMIN_PASSWORD = "CampusLink@2024"
LAN_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost|127\.0\.0\.1|0\.0\.0\.0|"
    r"10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"192\.168\.\d{1,3}\.\d{1,3}|"
    r"172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}"
    r")(:\d+)?$"
)


def parse_bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def strip_wrapping_quotes(value: str) -> str:
    cleaned = value.strip()
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in {'"', "'"}:
        return cleaned[1:-1].strip()
    return cleaned


def strip_env_assignment_prefix(value: str, name: str) -> str:
    cleaned = strip_wrapping_quotes(value)
    prefix = f"{name}="
    if cleaned.startswith(prefix):
        return cleaned[len(prefix):].strip()
    return cleaned


def parse_csv_env(name: str, default: str = "") -> List[str]:
    raw_value = strip_env_assignment_prefix(os.environ.get(name, default), name)
    values: List[str] = []
    for item in raw_value.split(","):
        cleaned = strip_env_assignment_prefix(item, name).rstrip("/")
        if cleaned:
            values.append(cleaned)
    return values


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Configuration
APP_ENV = os.environ.get("APP_ENV", "development").strip().lower()
MONGO_URL = os.environ.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME", "campuslink")
JWT_SECRET = os.environ.get("JWT_SECRET")
JWT_ALGORITHM = "HS256"
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
RESEND_FROM = os.environ.get("RESEND_FROM", "noreply@poshithcompany.in")
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY")
TRUST_PROXY_HEADERS = parse_bool_env("TRUST_PROXY_HEADERS", False)
ALLOW_LAN_ORIGINS = parse_bool_env("ALLOW_LAN_ORIGINS", True)
ALLOW_WIFI_IDENTIFIER_OVERRIDE = parse_bool_env("ALLOW_WIFI_IDENTIFIER_OVERRIDE", False)
COOKIE_SECURE = parse_bool_env("COOKIE_SECURE", APP_ENV != "development")
COOKIE_SAMESITE = os.environ.get(
    "COOKIE_SAMESITE",
    "none" if COOKIE_SECURE else "lax"
).strip().lower()
COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN")
MATCH_PENDING_TTL_SECONDS = int(os.environ.get("MATCH_PENDING_TTL_SECONDS", "30"))
MATCH_QUEUE_TTL_SECONDS = int(os.environ.get("MATCH_QUEUE_TTL_SECONDS", "90"))
OTP_VERIFICATION_TTL_MINUTES = int(os.environ.get("OTP_VERIFICATION_TTL_MINUTES", "30"))
OTP_RATE_LIMIT_WINDOW_MINUTES = int(os.environ.get("OTP_RATE_LIMIT_WINDOW_MINUTES", "10"))
OTP_RATE_LIMIT_MAX_REQUESTS = int(os.environ.get("OTP_RATE_LIMIT_MAX_REQUESTS", "3"))
MONGO_SERVER_SELECTION_TIMEOUT_MS = int(os.environ.get("MONGO_SERVER_SELECTION_TIMEOUT_MS", "5000"))
MONGO_CONNECT_TIMEOUT_MS = int(os.environ.get("MONGO_CONNECT_TIMEOUT_MS", "5000"))
MONGO_SOCKET_TIMEOUT_MS = int(os.environ.get("MONGO_SOCKET_TIMEOUT_MS", "5000"))
REDIS_URL = os.environ.get("REDIS_URL")
REDIS_NAMESPACE = os.environ.get("REDIS_NAMESPACE", "campuslink")
REQUIRE_REDIS_IN_PRODUCTION = parse_bool_env("REQUIRE_REDIS_IN_PRODUCTION", True)
REQUIRE_TURN_IN_PRODUCTION = parse_bool_env("REQUIRE_TURN_IN_PRODUCTION", True)
DAILY_ENABLED = parse_bool_env("DAILY_ENABLED", False)
STUN_URLS = parse_csv_env(
    "STUN_URLS",
    "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
)
TURN_URLS = parse_csv_env("TURN_URL")
TURN_USERNAME = os.environ.get("TURN_USERNAME")
TURN_CREDENTIAL = os.environ.get("TURN_CREDENTIAL")
DAILY_API_KEY = os.environ.get("DAILY_API_KEY")
DAILY_DOMAIN = strip_wrapping_quotes(os.environ.get("DAILY_DOMAIN", "")).rstrip("/")
DAILY_ROOM_PRIVACY = strip_wrapping_quotes(os.environ.get("DAILY_ROOM_PRIVACY", "private")).lower() or "private"
DAILY_ROOM_EXP_MINUTES = int(os.environ.get("DAILY_ROOM_EXP_MINUTES", "30"))
DAILY_SFU_SWITCHOVER = float(os.environ.get("DAILY_SFU_SWITCHOVER", "0.5"))
CORS_ORIGINS = parse_csv_env(
    "CORS_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8001,http://127.0.0.1:8001"
)

# Initialize Resend
resend.api_key = RESEND_API_KEY

if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    raise RuntimeError("COOKIE_SAMESITE must be one of: lax, strict, none")

if COOKIE_SAMESITE == "none" and not COOKIE_SECURE:
    logger.warning("COOKIE_SAMESITE=none requires secure cookies. Falling back to lax.")
    COOKIE_SAMESITE = "lax"

AUTH_COOKIE_KWARGS = {
    "httponly": True,
    "secure": COOKIE_SECURE,
    "samesite": COOKIE_SAMESITE,
    "max_age": 7 * 24 * 60 * 60,
    "path": "/",
}

REFRESH_COOKIE_KWARGS = {
    "httponly": True,
    "secure": COOKIE_SECURE,
    "samesite": COOKIE_SAMESITE,
    "max_age": 30 * 24 * 60 * 60,
    "path": "/",
}

if COOKIE_DOMAIN:
    AUTH_COOKIE_KWARGS["domain"] = COOKIE_DOMAIN
    REFRESH_COOKIE_KWARGS["domain"] = COOKIE_DOMAIN

TURN_ENABLED = bool(TURN_URLS and TURN_USERNAME and TURN_CREDENTIAL)
DAILY_READY = bool(DAILY_ENABLED and DAILY_API_KEY and DAILY_DOMAIN)
DAILY_API_BASE_URL = "https://api.daily.co/v1"

RATE_LIMITS = {
    "auth_send_otp": (3, OTP_RATE_LIMIT_WINDOW_MINUTES * 60),
    "auth_login": (10, 15 * 60),
    "profile_update": (10, 10 * 60),
    "friend_add": (20, 10 * 60),
    "match_find": (90, 60),
    "match_cancel": (30, 60),
    "report_create": (10, 60 * 60),
    "block_create": (30, 60 * 60),
    "friend_message": (60, 60),
    "socket_register": (10, 60),
    "socket_friend_call": (20, 60),
    "socket_offer": (20, 60),
    "socket_answer": (20, 60),
    "socket_ice": (300, 60),
    "socket_chat": (40, 60),
}

PROFILE_CONTACT_PATTERNS = [
    re.compile(r"\b\d{10}\b"),
    re.compile(r"\b[\w\.-]+@[\w\.-]+\.\w{2,}\b"),
    re.compile(r"(instagram|telegram|snapchat|whatsapp|discord)\s*[:@]?\s*\w+", re.IGNORECASE),
]

MODERATION_BLOCK_PATTERNS = [
    re.compile(r"\b(kill yourself|kys|rape|nude pics|child porn|bomb threat)\b", re.IGNORECASE),
    re.compile(r"\b(fuck|shit|bitch|asshole|bastard)\b", re.IGNORECASE),
]

REPORT_REASONS = {"harassment", "hate", "spam", "sexual_content", "violence", "impersonation", "other"}

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
class APIModel(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)


class UserRegister(APIModel):
    email: EmailStr
    password: str = Field(min_length=6)
    name: str = Field(min_length=2)
    interests: List[str] = Field(default_factory=list)
    looking_for: List[Literal["networking", "love", "cofounder", "study_buddy"]] = Field(
        default_factory=list
    )

class UserLogin(APIModel):
    email: EmailStr
    password: str

class OTPRequest(APIModel):
    email: EmailStr

class OTPVerify(APIModel):
    email: EmailStr
    otp: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")

class UserUpdate(APIModel):
    name: Optional[str] = Field(default=None, min_length=2)
    interests: Optional[List[str]] = None
    looking_for: Optional[List[Literal["networking", "love", "cofounder", "study_buddy"]]] = None
    bio: Optional[str] = Field(default=None, max_length=500)

class ConnectRequest(APIModel):
    mode: Literal["same_college", "same_wifi", "cross_college"]
    wifi_identifier: Optional[str] = Field(default=None, max_length=128)
    network_fingerprint: Optional[str] = Field(default=None, max_length=128)

class FriendRequest(APIModel):
    friend_user_id: str

class AIMatchRequest(APIModel):
    purpose: Literal["networking", "love", "cofounder", "study_buddy"]

class MessageSend(APIModel):
    receiver_id: str
    content: str


class BlockUserRequest(APIModel):
    target_user_id: str
    reason: Optional[str] = Field(default=None, max_length=200)


class ReportUserRequest(APIModel):
    reported_user_id: str
    reason: Literal["harassment", "hate", "spam", "sexual_content", "violence", "impersonation", "other"]
    details: Optional[str] = Field(default=None, max_length=1000)
    call_id: Optional[str] = Field(default=None, max_length=64)
    auto_block: bool = False

# MongoDB client
client = None
db = None
db_last_error: Optional[str] = None
redis_client: Optional[Redis] = None
redis_last_error: Optional[str] = None
socket_manager = (
    socketio.AsyncRedisManager(
        REDIS_URL,
        channel=f"{REDIS_NAMESPACE}:socketio",
        write_only=False,
        logger=logger,
    )
    if REDIS_URL
    else None
)

# Socket.IO for real-time communication
sio = socketio.AsyncServer(
    async_mode='asgi',
    client_manager=socket_manager,
    cors_allowed_origins="*" if ALLOW_LAN_ORIGINS else CORS_ORIGINS,
    ping_timeout=60,
    ping_interval=25
)

# Matching queues
matching_queues: Dict[str, List[str]] = {}
match_queue_states: Dict[str, Dict[str, str]] = {}

# Active connections
active_users = {}  # local-dev fallback only {user_id: sid}
sid_user_map: Dict[str, str] = {}
active_calls = {}  # local-dev fallback only
pending_matches: Dict[str, Dict[str, Any]] = {}  # {user_id: {matched_user_id, call_id, mode, created_at, is_initiator}}
call_ready_states: Dict[str, set[str]] = {}
in_memory_rate_limits: Dict[str, List[float]] = {}

async def get_db():
    return db


def redis_key(*parts: str) -> str:
    return ":".join([REDIS_NAMESPACE, *parts])


def normalize_queue_fragment(value: Optional[str], default: str = "unknown") -> str:
    normalized = re.sub(r"[^a-z0-9._-]+", "-", (value or default).strip().lower())
    normalized = normalized.strip("-")
    return normalized or default


def user_room(user_id: str) -> str:
    return f"user:{user_id}"


def queue_key_for(
    mode: str,
    college: Optional[str] = None,
    wifi: Optional[str] = None,
) -> str:
    if mode == "same_college":
        return redis_key("queue", "college", normalize_queue_fragment(college))
    if mode == "same_wifi":
        return redis_key("queue", "wifi", normalize_queue_fragment(wifi))
    return redis_key("queue", "global")


def match_queue_state_key(user_id: str) -> str:
    return redis_key("match", "queue-state", user_id)


def pending_match_key(user_id: str) -> str:
    return redis_key("match", "pending", user_id)


def call_ready_state_key(call_id: str) -> str:
    return redis_key("call", "ready", call_id)


def online_users_key() -> str:
    return redis_key("presence", "users")


def online_user_counts_key() -> str:
    return redis_key("presence", "counts")


def turn_required() -> bool:
    return APP_ENV == "production" and REQUIRE_TURN_IN_PRODUCTION


def call_provider_ready() -> bool:
    return DAILY_READY or TURN_ENABLED


def preferred_call_provider() -> str:
    return "daily" if DAILY_READY else "webrtc"


def build_daily_domain_url() -> str:
    if not DAILY_DOMAIN:
        return ""
    if DAILY_DOMAIN.startswith(("http://", "https://")):
        return DAILY_DOMAIN.rstrip("/")
    return f"https://{DAILY_DOMAIN}".rstrip("/")


def build_daily_room_name(call_id: str) -> str:
    suffix = re.sub(r"[^a-zA-Z0-9_-]", "-", call_id).lower()
    return f"campuslink-{suffix}"


def build_daily_room_url(room_name: str) -> str:
    return f"{build_daily_domain_url()}/{room_name}"


async def create_daily_room(call_id: str) -> Dict[str, Any]:
    room_name = build_daily_room_name(call_id)
    payload = {
        "name": room_name,
        "privacy": DAILY_ROOM_PRIVACY,
        "properties": {
            "exp": int((utcnow() + timedelta(minutes=DAILY_ROOM_EXP_MINUTES)).timestamp()),
            "sfu_switchover": DAILY_SFU_SWITCHOVER,
        },
    }
    headers = {"Authorization": f"Bearer {DAILY_API_KEY}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client_http:
        response = await client_http.post(f"{DAILY_API_BASE_URL}/rooms", json=payload, headers=headers)
        if response.status_code not in {200, 201, 409}:
            detail = response.text.strip() or "Could not create Daily room."
            raise HTTPException(status_code=502, detail=f"Daily room error: {detail}")
        if response.status_code == 409:
            response = await client_http.get(f"{DAILY_API_BASE_URL}/rooms/{room_name}", headers=headers)
            if response.status_code != 200:
                detail = response.text.strip() or "Could not fetch existing Daily room."
                raise HTTPException(status_code=502, detail=f"Daily room lookup error: {detail}")

    room = response.json()
    room_url = room.get("url") or build_daily_room_url(room_name)
    return {
        "name": room.get("name") or room_name,
        "url": room_url,
    }


async def create_daily_meeting_token(room_name: str, user: Dict[str, Any]) -> str:
    payload = {
        "properties": {
            "room_name": room_name,
            "user_name": user.get("name") or user["user_id"],
            "user_id": user["user_id"],
            "exp": int((utcnow() + timedelta(minutes=DAILY_ROOM_EXP_MINUTES)).timestamp()),
        }
    }
    headers = {"Authorization": f"Bearer {DAILY_API_KEY}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client_http:
        response = await client_http.post(f"{DAILY_API_BASE_URL}/meeting-tokens", json=payload, headers=headers)
    if response.status_code not in {200, 201}:
        detail = response.text.strip() or "Could not create Daily meeting token."
        raise HTTPException(status_code=502, detail=f"Daily token error: {detail}")

    token = response.json().get("token")
    if not token:
        raise HTTPException(status_code=502, detail="Daily token response was empty.")
    return token


async def ensure_daily_call_session(call: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
    room_name = call.get("provider_room_name")
    room_url = call.get("provider_room_url")
    if not room_name or not room_url:
        room = await create_daily_room(call["call_id"])
        room_name = room["name"]
        room_url = room["url"]
        await db.call_history.update_one(
            {"call_id": call["call_id"]},
            {
                "$set": {
                    "provider": "daily",
                    "provider_room_name": room_name,
                    "provider_room_url": room_url,
                    "updated_at": utcnow(),
                }
            },
        )

    token = await create_daily_meeting_token(room_name, user)
    return {
        "provider": "daily",
        "room_name": room_name,
        "room_url": room_url,
        "token": token,
        "domain": build_daily_domain_url(),
    }


def json_dumps(data: Dict[str, Any]) -> str:
    return json.dumps(data, separators=(",", ":"), default=str)


def json_loads(raw_value: Any) -> Dict[str, Any]:
    if isinstance(raw_value, bytes):
        raw_value = raw_value.decode("utf-8")
    if isinstance(raw_value, str):
        return json.loads(raw_value)
    return raw_value


async def ping_redis() -> bool:
    global redis_last_error

    if redis_client is None:
        redis_last_error = "Redis client is not initialized."
        return False

    try:
        await redis_client.ping()
        redis_last_error = None
        return True
    except RedisError as exc:
        redis_last_error = str(exc)
        logger.error("Redis ping failed: %s", exc)
        return False


async def get_online_user_count() -> int:
    if redis_client is None:
        return len(active_users)

    count = await redis_client.scard(online_users_key())
    return int(count)


async def mark_user_online(user_id: str) -> None:
    if redis_client is None:
        active_users[user_id] = user_id
        return

    await redis_client.hincrby(online_user_counts_key(), user_id, 1)
    await redis_client.sadd(online_users_key(), user_id)


async def mark_user_offline(user_id: str) -> None:
    if redis_client is None:
        active_users.pop(user_id, None)
        return

    remaining = await redis_client.hincrby(online_user_counts_key(), user_id, -1)
    if remaining <= 0:
        await redis_client.hdel(online_user_counts_key(), user_id)
        await redis_client.srem(online_users_key(), user_id)


def content_is_disallowed(text: Optional[str], *, field_name: str, forbid_contact: bool = False) -> Optional[str]:
    if not text:
        return None

    normalized = " ".join(text.lower().split())
    for pattern in MODERATION_BLOCK_PATTERNS:
        if pattern.search(normalized):
            return f"{field_name} contains language that is not allowed."

    if forbid_contact:
        for pattern in PROFILE_CONTACT_PATTERNS:
            if pattern.search(text):
                return f"{field_name} cannot contain contact details or social handles."

    if len(normalized) >= 30 and len(set(normalized)) <= 4:
        return f"{field_name} looks like spam."

    return None


async def record_moderation_incident(
    user_id: str,
    content: str,
    reason: str,
    field_name: str,
) -> None:
    if db is None:
        return

    await db.moderation_incidents.insert_one(
        {
            "incident_id": f"mod_{uuid.uuid4().hex[:12]}",
            "user_id": user_id,
            "field_name": field_name,
            "reason": reason,
            "content": content,
            "created_at": utcnow(),
        }
    )


async def enforce_text_policy(
    user_id: str,
    text: Optional[str],
    *,
    field_name: str,
    forbid_contact: bool = False,
) -> None:
    issue = content_is_disallowed(text, field_name=field_name, forbid_contact=forbid_contact)
    if issue:
        await record_moderation_incident(user_id, text or "", issue, field_name)
        raise HTTPException(status_code=400, detail=issue)


async def are_users_blocked(user_id: str, other_user_id: str) -> bool:
    if db is None:
        return False

    blocked = await db.blocks.find_one(
        {
            "$or": [
                {"user_id": user_id, "blocked_user_id": other_user_id},
                {"user_id": other_user_id, "blocked_user_id": user_id},
            ]
        },
        {"_id": 1},
    )
    return blocked is not None


async def enforce_not_blocked(user_id: str, other_user_id: str) -> None:
    if await are_users_blocked(user_id, other_user_id):
        raise HTTPException(status_code=403, detail="This interaction is unavailable due to a block.")


async def are_friends(user_id: str, other_user_id: str) -> bool:
    if db is None:
        return False

    friendship = await db.friends.find_one(
        {"user_id": user_id, "friend_id": other_user_id},
        {"_id": 1},
    )
    return friendship is not None


async def decode_access_token_value(token: str) -> Dict[str, Any]:
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


async def increment_rate_limit(key: str, limit: int, window_seconds: int) -> int:
    now_ts = utcnow().timestamp()

    if redis_client is not None:
        namespaced_key = redis_key("rate", key)
        count = await redis_client.incr(namespaced_key)
        if count == 1:
            await redis_client.expire(namespaced_key, window_seconds)
        return int(count)

    attempts = in_memory_rate_limits.setdefault(key, [])
    cutoff = now_ts - window_seconds
    attempts[:] = [attempt for attempt in attempts if attempt >= cutoff]
    attempts.append(now_ts)
    return len(attempts)


async def enforce_rate_limit(
    key: str,
    *,
    limit_name: str,
    override_message: Optional[str] = None,
) -> None:
    limit, window_seconds = RATE_LIMITS[limit_name]
    current = await increment_rate_limit(key, limit, window_seconds)
    if current > limit:
        detail = override_message or "Too many requests. Please slow down."
        raise HTTPException(status_code=429, detail=detail)


async def socket_rate_limited(sid: str, key: str, limit_name: str, detail: str) -> bool:
    limit, window_seconds = RATE_LIMITS[limit_name]
    current = await increment_rate_limit(key, limit, window_seconds)
    if current > limit:
        await sio.emit("error", {"detail": detail}, to=sid)
        return True
    return False


async def get_socket_user_id(sid: str) -> Optional[str]:
    user_id = sid_user_map.get(sid)
    if user_id:
        return user_id

    try:
        session = await sio.get_session(sid)
    except KeyError:
        return None
    return session.get("user_id")


def decode_redis_string(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


async def get_match_queue_state(user_id: str) -> Optional[Dict[str, str]]:
    if redis_client is None:
        state = match_queue_states.get(user_id)
        return dict(state) if state else None

    raw_state = await redis_client.get(match_queue_state_key(user_id))
    if raw_state is None:
        return None
    return json_loads(raw_state)


async def set_match_queue_state(
    user_id: str,
    *,
    queue: str,
    mode: str,
    college: str = "",
    wifi: str = "",
) -> None:
    state = {
        "queue": queue,
        "mode": mode,
        "college": college,
        "wifi": wifi,
    }
    if redis_client is None:
        match_queue_states[user_id] = state
        return

    await redis_client.set(
        match_queue_state_key(user_id),
        json_dumps(state),
        ex=MATCH_QUEUE_TTL_SECONDS,
    )


async def clear_match_queue_state(user_id: str) -> None:
    if redis_client is None:
        match_queue_states.pop(user_id, None)
        return

    await redis_client.delete(match_queue_state_key(user_id))


async def pop_queued_user(queue: str) -> Optional[str]:
    if redis_client is None:
        queue_users = matching_queues.get(queue)
        if not queue_users:
            return None
        candidate_id = queue_users.pop(0)
        if not queue_users:
            matching_queues.pop(queue, None)
        return candidate_id

    candidate_id = await redis_client.lpop(queue)
    return decode_redis_string(candidate_id)


async def enqueue_user(user_id: str, queue: str) -> None:
    if redis_client is None:
        queue_users = matching_queues.setdefault(queue, [])
        if user_id not in queue_users:
            queue_users.append(user_id)
        return

    await redis_client.rpush(queue, user_id)
    await redis_client.expire(queue, MATCH_QUEUE_TTL_SECONDS)


async def remove_user_from_queues(user_id: str) -> None:
    state = await get_match_queue_state(user_id)
    if not state:
        return

    queue = state.get("queue")
    await clear_match_queue_state(user_id)
    if not queue:
        return

    if redis_client is None:
        queue_users = matching_queues.get(queue, [])
        matching_queues[queue] = [queued_user_id for queued_user_id in queue_users if queued_user_id != user_id]
        if not matching_queues[queue]:
            matching_queues.pop(queue, None)
        return

    await redis_client.lrem(queue, 0, user_id)


async def create_match(user1: Dict[str, str], user2: Dict[str, str]) -> Dict[str, Any]:
    call_id = f"call_{uuid.uuid4().hex[:12]}"
    call_doc: Dict[str, Any] = {
        "call_id": call_id,
        "participants": [user1["user_id"], user2["user_id"]],
        "mode": user1["mode"],
        "status": "matched",
        "created_at": utcnow(),
    }
    if user1["mode"] == "same_wifi":
        call_doc["same_wifi_bucket"] = user1.get("wifi") or user2.get("wifi")

    await db.call_history.insert_one(call_doc)
    await set_pending_match(
        user2["user_id"],
        {
            "matched_user_id": user1["user_id"],
            "call_id": call_id,
            "mode": user1["mode"],
            "is_initiator": False,
            "created_at": utcnow().isoformat(),
        },
    )
    return {
        "matched_user_id": user2["user_id"],
        "call_id": call_id,
        "mode": user1["mode"],
        "is_initiator": True,
        "created_at": utcnow().isoformat(),
    }


async def find_match(
    user_id: str,
    mode: Literal["same_college", "same_wifi", "cross_college"],
    college: str,
    wifi: str,
) -> Optional[Dict[str, Any]]:
    queue = queue_key_for(mode, college=college, wifi=wifi)
    current_state = await get_match_queue_state(user_id)

    if current_state:
        current_queue = current_state.get("queue")
        if current_queue == queue:
            await set_match_queue_state(user_id, queue=queue, mode=mode, college=college, wifi=wifi)
            if redis_client is not None:
                await redis_client.expire(queue, MATCH_QUEUE_TTL_SECONDS)
            return None
        await remove_user_from_queues(user_id)

    candidate_id = await pop_queued_user(queue)
    if not candidate_id:
        await set_match_queue_state(user_id, queue=queue, mode=mode, college=college, wifi=wifi)
        await enqueue_user(user_id, queue)
        return None

    candidate_state = await get_match_queue_state(candidate_id)
    if candidate_id == user_id or not candidate_state or candidate_state.get("queue") != queue:
        await set_match_queue_state(user_id, queue=queue, mode=mode, college=college, wifi=wifi)
        await enqueue_user(user_id, queue)
        return None

    if mode == "cross_college" and candidate_state.get("college") == college:
        await enqueue_user(candidate_id, queue)
        await set_match_queue_state(user_id, queue=queue, mode=mode, college=college, wifi=wifi)
        await enqueue_user(user_id, queue)
        return None

    await clear_match_queue_state(candidate_id)
    return await create_match(
        {
            "user_id": user_id,
            "mode": mode,
            "college": college,
            "wifi": wifi,
        },
        {
            "user_id": candidate_id,
            "mode": candidate_state.get("mode", mode),
            "college": candidate_state.get("college", ""),
            "wifi": candidate_state.get("wifi", ""),
        },
    )


async def get_pending_match(user_id: str) -> Optional[Dict[str, Any]]:
    if redis_client is None:
        return pending_matches.pop(user_id, None)

    raw_value = await redis_client.get(pending_match_key(user_id))
    if raw_value is None:
        return None

    await redis_client.delete(pending_match_key(user_id))
    return json_loads(raw_value)


async def set_pending_match(user_id: str, data: Dict[str, Any]) -> None:
    if redis_client is None:
        pending_matches[user_id] = data
        return

    await redis_client.set(
        pending_match_key(user_id),
        json_dumps(data),
        ex=MATCH_PENDING_TTL_SECONDS,
    )


async def mark_call_ready(call_id: str, user_id: str) -> set[str]:
    if redis_client is None:
        ready_peers = call_ready_states.setdefault(call_id, set())
        ready_peers.add(user_id)
        return set(ready_peers)

    ready_key = call_ready_state_key(call_id)
    await redis_client.sadd(ready_key, user_id)
    await redis_client.expire(ready_key, MATCH_PENDING_TTL_SECONDS)
    raw_members = await redis_client.smembers(ready_key)
    return {
        member.decode("utf-8") if isinstance(member, bytes) else member
        for member in raw_members
    }


async def clear_call_ready_state(call_id: Optional[str]) -> None:
    if not call_id:
        return
    if redis_client is None:
        call_ready_states.pop(call_id, None)
        return
    await redis_client.delete(call_ready_state_key(call_id))


async def discard_pending_match(user_id: str) -> Optional[Dict[str, Any]]:
    if redis_client is None:
        pending = pending_matches.pop(user_id, None)
        if not pending:
            return None

        matched_user_id = pending.get("matched_user_id")
        counterpart_pending = pending_matches.get(matched_user_id)
        if counterpart_pending and counterpart_pending.get("matched_user_id") == user_id:
            pending_matches.pop(matched_user_id, None)
        return pending

    current_key = pending_match_key(user_id)
    raw_pending = await redis_client.get(current_key)
    if raw_pending is None:
        return None

    pending = json_loads(raw_pending)
    await redis_client.delete(current_key)

    matched_user_id = pending.get("matched_user_id")
    if matched_user_id:
        other_key = pending_match_key(matched_user_id)
        other_raw = await redis_client.get(other_key)
        if other_raw is not None:
            other_pending = json_loads(other_raw)
            if other_pending.get("matched_user_id") == user_id:
                await redis_client.delete(other_key)

    return pending


async def ping_database() -> bool:
    global db_last_error

    if client is None:
        db_last_error = "Mongo client is not initialized."
        return False

    try:
        await client.admin.command("ping")
        db_last_error = None
        return True
    except PyMongoError as exc:
        db_last_error = str(exc)
        logger.error("MongoDB ping failed: %s", exc)
        return False


def validate_runtime_configuration() -> None:
    missing = [name for name, value in [("MONGO_URL", MONGO_URL), ("JWT_SECRET", JWT_SECRET)] if not value]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    if APP_ENV == "production" and REQUIRE_REDIS_IN_PRODUCTION and not REDIS_URL:
        raise RuntimeError("REDIS_URL is required in production.")

    if turn_required() and not call_provider_ready():
        raise RuntimeError("Configure either Daily or TURN before enabling production calls.")

    if APP_ENV != "development" and len(JWT_SECRET) < 32:
        logger.warning("JWT_SECRET should be at least 32 characters outside development.")

    if not RESEND_API_KEY:
        logger.warning("RESEND_API_KEY is not configured. OTP emails will fail.")

    if not EMERGENT_LLM_KEY:
        logger.warning("EMERGENT_LLM_KEY is not configured. AI features will fall back.")


def set_auth_cookies(response: Response, access_token: str, refresh_token: str) -> None:
    response.set_cookie(key="access_token", value=access_token, **AUTH_COOKIE_KWARGS)
    response.set_cookie(key="refresh_token", value=refresh_token, **REFRESH_COOKIE_KWARGS)


def clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(
        "access_token",
        path="/",
        secure=COOKIE_SECURE,
        httponly=True,
        samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN,
    )
    response.delete_cookie(
        "refresh_token",
        path="/",
        secure=COOKIE_SECURE,
        httponly=True,
        samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN,
    )


def get_request_ip(request: Request) -> str:
    if TRUST_PROXY_HEADERS:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()

    if request.client and request.client.host:
        return request.client.host

    return "unknown"


def dedupe_preserve_order(values: List[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def derive_same_network_buckets(
    request: Request,
    wifi_identifier: Optional[str] = None,
    network_fingerprint: Optional[str] = None,
) -> List[str]:
    if ALLOW_WIFI_IDENTIFIER_OVERRIDE and wifi_identifier:
        return [f"custom:{wifi_identifier.strip().lower()}"]

    client_ip = get_request_ip(request)
    buckets: List[str] = []
    normalized_fingerprint = network_fingerprint.strip().lower() if network_fingerprint else None

    try:
        address = ipaddress.ip_address(client_ip)
    except ValueError:
        buckets.append(f"ip:{client_ip}")
        if normalized_fingerprint:
            buckets.append(f"fingerprint:{normalized_fingerprint}")
        return dedupe_preserve_order(buckets)

    if isinstance(address, ipaddress.IPv4Address):
        if not address.is_private and not address.is_loopback:
            buckets.append(f"ipv4-host:{address.compressed}")
        prefixes = [24] if (address.is_private or address.is_loopback) else [32, 24]
    else:
        prefixes = [64, 56] if (address.is_private or address.is_link_local or address.is_loopback) else [64, 56, 48]

    for prefix in prefixes:
        network = ipaddress.ip_network(f"{address}/{prefix}", strict=False)
        family = "ipv4" if isinstance(address, ipaddress.IPv4Address) else "ipv6"
        buckets.append(f"{family}:{network.network_address}/{network.prefixlen}")

    if normalized_fingerprint:
        buckets.append(f"fingerprint:{normalized_fingerprint}")

    return dedupe_preserve_order(buckets)


def derive_wifi_bucket(
    request: Request,
    wifi_identifier: Optional[str] = None,
    network_fingerprint: Optional[str] = None,
) -> str:
    buckets = derive_same_network_buckets(request, wifi_identifier, network_fingerprint)
    return buckets[0] if buckets else "unknown"


def build_ice_servers() -> List[Dict[str, Any]]:
    ice_servers: List[Dict[str, Any]] = [{"urls": url} for url in STUN_URLS]
    if TURN_ENABLED:
        ice_servers.append(
            {
                "urls": TURN_URLS if len(TURN_URLS) > 1 else TURN_URLS[0],
                "username": TURN_USERNAME,
                "credential": TURN_CREDENTIAL,
            }
        )
    return ice_servers

# Password functions
def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    if not hashed_password:
        return False
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except ValueError:
        return False

# JWT functions
def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": utcnow() + timedelta(days=7),
        "type": "access"
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def create_refresh_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": utcnow() + timedelta(days=30),
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

    return await decode_access_token_value(token)

# Lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    global client, db, redis_client
    validate_runtime_configuration()
    client = AsyncIOMotorClient(
        MONGO_URL,
        serverSelectionTimeoutMS=MONGO_SERVER_SELECTION_TIMEOUT_MS,
        connectTimeoutMS=MONGO_CONNECT_TIMEOUT_MS,
        socketTimeoutMS=MONGO_SOCKET_TIMEOUT_MS,
        retryWrites=True,
    )
    db = client[DB_NAME]

    db_reachable = await ping_database()
    redis_reachable = True
    if REDIS_URL:
        redis_client = Redis.from_url(REDIS_URL, decode_responses=False)
        redis_reachable = await ping_redis()
    else:
        redis_client = None

    if not db_reachable:
        logger.warning("Backend started without a healthy MongoDB connection.")
    if REDIS_URL and not redis_reachable:
        logger.warning("Backend started without a healthy Redis connection.")

    if APP_ENV == "production":
        if not db_reachable:
            if redis_client is not None:
                await redis_client.aclose()
            client.close()
            raise RuntimeError("MongoDB must be reachable before CampusLink starts in production.")
        if REQUIRE_REDIS_IN_PRODUCTION and REDIS_URL and not redis_reachable:
            if redis_client is not None:
                await redis_client.aclose()
            client.close()
            raise RuntimeError("Redis must be reachable before CampusLink starts in production.")
    
    # Create indexes
    if db_reachable:
        await db.users.create_index("email", unique=True)
        await db.users.create_index("user_id", unique=True)
        await db.users.create_index("college")
        await db.otp_tokens.create_index("expires_at", expireAfterSeconds=0)
        await db.email_verifications.create_index("email", unique=True)
        await db.email_verifications.create_index("expires_at", expireAfterSeconds=0)
        await db.otp_rate_limits.create_index("created_at", expireAfterSeconds=OTP_RATE_LIMIT_WINDOW_MINUTES * 60)
        await db.otp_rate_limits.create_index("identifier")
        await db.call_history.create_index("participants")
        await db.call_history.create_index("created_at")
        await db.friends.create_index([("user_id", 1), ("friend_id", 1)], unique=True)
        await db.blocks.create_index([("user_id", 1), ("blocked_user_id", 1)], unique=True)
        await db.blocks.create_index("user_id")
        await db.blocks.create_index("blocked_user_id")
        await db.reports.create_index("report_id", unique=True)
        await db.reports.create_index("reported_user_id")
        await db.reports.create_index("reporter_user_id")
        await db.moderation_incidents.create_index("incident_id", unique=True)
        await db.moderation_incidents.create_index("user_id")
        await db.messages.create_index([("sender_id", 1), ("receiver_id", 1)])
        await db.login_attempts.create_index("identifier")
        await db.login_attempts.create_index("last_attempt", expireAfterSeconds=24 * 60 * 60)

        # Seed admin
        await seed_admin()
    
    logger.info("CampusLink backend started")
    yield
    
    if redis_client is not None:
        await redis_client.aclose()
    client.close()
    logger.info("CampusLink backend stopped")

async def seed_admin():
    admin_email = os.environ.get("ADMIN_EMAIL", DEFAULT_ADMIN_EMAIL)
    admin_password = os.environ.get(
        "ADMIN_PASSWORD",
        DEFAULT_ADMIN_PASSWORD if APP_ENV == "development" else "",
    )

    if not admin_email or not admin_password:
        logger.info("Admin seeding skipped because ADMIN_EMAIL or ADMIN_PASSWORD is not set.")
        return

    if APP_ENV != "development" and admin_password == DEFAULT_ADMIN_PASSWORD:
        logger.warning("Skipping admin seeding outside development because a default password was supplied.")
        return
    
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
            "created_at": utcnow(),
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


@app.exception_handler(ServerSelectionTimeoutError)
async def mongo_timeout_exception_handler(request: Request, exc: ServerSelectionTimeoutError):
    global db_last_error
    db_last_error = str(exc)
    return JSONResponse(
        status_code=503,
        content={
            "detail": "Database is unavailable. Check MongoDB Atlas connectivity, TLS, and IP access list.",
            "error_type": "database_unavailable",
        },
    )


@app.exception_handler(PyMongoError)
async def mongo_exception_handler(request: Request, exc: PyMongoError):
    global db_last_error
    db_last_error = str(exc)
    return JSONResponse(
        status_code=503,
        content={
            "detail": "Database request failed. Check MongoDB configuration and connectivity.",
            "error_type": "database_error",
        },
    )

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=LAN_ORIGIN_REGEX if ALLOW_LAN_ORIGINS else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Socket.IO
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# ============ AUTH ENDPOINTS ============

@app.post("/api/auth/send-otp")
async def send_otp(payload: OTPRequest, request: Request):
    """Send OTP to college email for verification"""
    email = payload.email.lower()
    
    if not is_valid_college_email(email):
        raise HTTPException(
            status_code=400, 
            detail="Please use a valid Indian college email address (.ac.in, .edu.in)"
        )

    if not RESEND_API_KEY:
        raise HTTPException(status_code=503, detail="Email verification is not configured.")

    now = utcnow()
    rate_limit_identifier = f"{get_request_ip(request)}:{email}"
    recent_requests = await db.otp_rate_limits.count_documents(
        {
            "identifier": rate_limit_identifier,
            "created_at": {"$gte": now - timedelta(minutes=OTP_RATE_LIMIT_WINDOW_MINUTES)},
        }
    )
    if recent_requests >= OTP_RATE_LIMIT_MAX_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail=f"Too many OTP requests. Try again in {OTP_RATE_LIMIT_WINDOW_MINUTES} minutes.",
        )
    
    # Generate 6-digit OTP
    otp = ''.join([str(secrets.randbelow(10)) for _ in range(6)])
    
    # Store OTP with 10 min expiry
    await db.otp_tokens.delete_many({"email": email})
    await db.otp_tokens.insert_one({
        "email": email,
        "otp": otp,
        "expires_at": now + timedelta(minutes=10),
        "created_at": now
    })
    await db.otp_rate_limits.insert_one({"identifier": rate_limit_identifier, "created_at": now})
    
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
        return {"status": "success", "message": "OTP sent to your email."}
    except Exception as e:
        logger.error(f"Failed to send OTP: {e}")
        raise HTTPException(status_code=500, detail="Failed to send OTP. Please try again later.")

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
    
    if expires_at < utcnow():
        raise HTTPException(status_code=400, detail="OTP has expired")
    
    # Mark OTP as used
    await db.otp_tokens.delete_one({"_id": otp_doc["_id"]})
    await db.email_verifications.update_one(
        {"email": email},
        {
            "$set": {
                "email": email,
                "verified_at": utcnow(),
                "expires_at": utcnow() + timedelta(minutes=OTP_VERIFICATION_TTL_MINUTES),
            }
        },
        upsert=True,
    )
    
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

    verification = await db.email_verifications.find_one({"email": email})
    if not verification:
        raise HTTPException(status_code=400, detail="Email verification is required before signup")

    verification_expires_at = verification["expires_at"]
    if verification_expires_at.tzinfo is None:
        verification_expires_at = verification_expires_at.replace(tzinfo=timezone.utc)
    if verification_expires_at < utcnow():
        await db.email_verifications.delete_one({"email": email})
        raise HTTPException(status_code=400, detail="Email verification has expired. Verify again.")
    
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
        "last_seen": utcnow(),
        "created_at": utcnow()
    }
    
    await db.users.insert_one(user_doc)
    await db.email_verifications.delete_one({"email": email})
    
    # Create tokens
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)

    set_auth_cookies(response, access_token, refresh_token)
    
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
    ip = get_request_ip(request)
    identifier = f"{ip}:{email}"
    
    attempts_doc = await db.login_attempts.find_one({"identifier": identifier})
    if attempts_doc:
        if attempts_doc.get("locked_until"):
            locked_until = attempts_doc["locked_until"]
            if locked_until.tzinfo is None:
                locked_until = locked_until.replace(tzinfo=timezone.utc)
            if locked_until > utcnow():
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
                "$set": {"last_attempt": utcnow()},
                "$setOnInsert": {"created_at": utcnow()}
            },
            upsert=True
        )
        
        # Check if should lock
        updated = await db.login_attempts.find_one({"identifier": identifier})
        if updated and updated.get("attempts", 0) >= 5:
            await db.login_attempts.update_one(
                {"identifier": identifier},
                {"$set": {"locked_until": utcnow() + timedelta(minutes=15)}}
            )
        
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    # Clear failed attempts on success
    await db.login_attempts.delete_one({"identifier": identifier})
    
    user_id = user["user_id"]
    access_token = create_access_token(user_id, email)
    refresh_token = create_refresh_token(user_id)

    set_auth_cookies(response, access_token, refresh_token)
    
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
    clear_auth_cookies(response)
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
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client_http:
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
            "last_seen": utcnow(),
            "created_at": utcnow(),
            "auth_provider": "google"
        }
        
        await db.users.insert_one(user_doc)
        user = user_doc
    else:
        user_id = user["user_id"]
    
    # Create tokens
    access_token = create_access_token(user["user_id"], email)
    refresh_token = create_refresh_token(user["user_id"])

    set_auth_cookies(response, access_token, refresh_token)
    
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
    await enforce_rate_limit(
        f"profile-update:{user['user_id']}",
        limit_name="profile_update",
        override_message="Too many profile updates. Try again later.",
    )
    
    update_data = {}
    if data.name:
        await enforce_text_policy(user["user_id"], data.name, field_name="Name")
        update_data["name"] = data.name
    if data.interests is not None:
        update_data["interests"] = data.interests
    if data.looking_for is not None:
        update_data["looking_for"] = data.looking_for
    if data.bio is not None:
        await enforce_text_policy(
            user["user_id"],
            data.bio,
            field_name="Bio",
            forbid_contact=True,
        )
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
    current_user = await get_current_user(request)
    await enforce_not_blocked(current_user["user_id"], user_id)
    
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
    await enforce_rate_limit(
        f"friend-add:{user['user_id']}",
        limit_name="friend_add",
        override_message="Too many friend requests. Please slow down.",
    )
    
    if user["user_id"] == data.friend_user_id:
        raise HTTPException(status_code=400, detail="Cannot add yourself as friend")

    await enforce_not_blocked(user["user_id"], data.friend_user_id)
    
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
        "created_at": utcnow()
    })
    await db.friends.insert_one({
        "user_id": data.friend_user_id,
        "friend_id": user["user_id"],
        "created_at": utcnow()
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


@app.get("/api/friends/messages/{friend_id}")
async def get_friend_messages(friend_id: str, request: Request):
    user = await get_current_user(request)
    await enforce_not_blocked(user["user_id"], friend_id)
    if not await are_friends(user["user_id"], friend_id):
        raise HTTPException(status_code=403, detail="You can only view chats with friends.")

    messages = await db.messages.find(
        {
            "$or": [
                {"sender_id": user["user_id"], "receiver_id": friend_id},
                {"sender_id": friend_id, "receiver_id": user["user_id"]},
            ]
        },
        {"_id": 0},
    ).sort("created_at", 1).to_list(200)

    return {"messages": messages}


@app.post("/api/friends/messages")
async def send_friend_message(data: MessageSend, request: Request):
    user = await get_current_user(request)
    await enforce_rate_limit(
        f"friend-message:{user['user_id']}",
        limit_name="friend_message",
        override_message="Too many messages. Please slow down.",
    )

    if user["user_id"] == data.receiver_id:
        raise HTTPException(status_code=400, detail="Cannot message yourself.")

    await enforce_not_blocked(user["user_id"], data.receiver_id)
    if not await are_friends(user["user_id"], data.receiver_id):
        raise HTTPException(status_code=403, detail="You can only message friends.")

    message = (data.content or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    moderation_issue = content_is_disallowed(message, field_name="Message")
    if moderation_issue:
        await record_moderation_incident(user["user_id"], message, moderation_issue, "friend_message")
        raise HTTPException(status_code=400, detail=moderation_issue)

    message_doc = {
        "message_id": f"msg_{uuid.uuid4().hex[:12]}",
        "sender_id": user["user_id"],
        "receiver_id": data.receiver_id,
        "content": message,
        "created_at": utcnow(),
    }
    await db.messages.insert_one(message_doc)

    await sio.emit(
        "friend_message",
        {
            "message_id": message_doc["message_id"],
            "sender_id": user["user_id"],
            "receiver_id": data.receiver_id,
            "content": message,
            "created_at": message_doc["created_at"].isoformat(),
        },
        room=user_room(data.receiver_id),
    )

    return {"status": "success", "message": message_doc}


# ============ SAFETY ENDPOINTS ============

@app.get("/api/safety/blocks")
async def get_blocked_users(request: Request):
    user = await get_current_user(request)

    blocks = await db.blocks.find({"user_id": user["user_id"]}, {"_id": 0}).to_list(200)
    blocked_ids = [block["blocked_user_id"] for block in blocks]
    blocked_users = await db.users.find(
        {"user_id": {"$in": blocked_ids}},
        {"_id": 0, "password_hash": 0, "email": 0},
    ).to_list(200)

    return {"blocked_users": blocked_users}


@app.post("/api/safety/block")
async def block_user(data: BlockUserRequest, request: Request):
    user = await get_current_user(request)
    await enforce_rate_limit(
        f"block:{user['user_id']}",
        limit_name="block_create",
        override_message="Too many block actions. Try again later.",
    )

    if user["user_id"] == data.target_user_id:
        raise HTTPException(status_code=400, detail="You cannot block yourself.")

    target_user = await db.users.find_one({"user_id": data.target_user_id}, {"_id": 0, "user_id": 1})
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    try:
        await db.blocks.insert_one(
            {
                "block_id": f"block_{uuid.uuid4().hex[:12]}",
                "user_id": user["user_id"],
                "blocked_user_id": data.target_user_id,
                "reason": data.reason or "",
                "created_at": utcnow(),
            }
        )
    except DuplicateKeyError:
        return {"status": "success", "message": "User already blocked"}

    await remove_user_from_queues(user["user_id"])
    await remove_user_from_queues(data.target_user_id)
    await discard_pending_match(user["user_id"])
    await discard_pending_match(data.target_user_id)

    return {"status": "success", "message": "User blocked"}


@app.delete("/api/safety/block/{target_user_id}")
async def unblock_user(target_user_id: str, request: Request):
    user = await get_current_user(request)
    await db.blocks.delete_one({"user_id": user["user_id"], "blocked_user_id": target_user_id})
    return {"status": "success", "message": "User unblocked"}


@app.post("/api/safety/report")
async def report_user(data: ReportUserRequest, request: Request):
    user = await get_current_user(request)
    await enforce_rate_limit(
        f"report:{user['user_id']}",
        limit_name="report_create",
        override_message="Too many reports. Please try again later.",
    )

    if user["user_id"] == data.reported_user_id:
        raise HTTPException(status_code=400, detail="You cannot report yourself.")

    reported_user = await db.users.find_one({"user_id": data.reported_user_id}, {"_id": 0, "user_id": 1})
    if not reported_user:
        raise HTTPException(status_code=404, detail="User not found")

    await db.reports.insert_one(
        {
            "report_id": f"report_{uuid.uuid4().hex[:12]}",
            "reporter_user_id": user["user_id"],
            "reported_user_id": data.reported_user_id,
            "reason": data.reason,
            "details": data.details or "",
            "call_id": data.call_id,
            "created_at": utcnow(),
        }
    )

    if data.auto_block:
        try:
            await db.blocks.insert_one(
                {
                    "block_id": f"block_{uuid.uuid4().hex[:12]}",
                    "user_id": user["user_id"],
                    "blocked_user_id": data.reported_user_id,
                    "reason": f"Auto-block after report: {data.reason}",
                    "created_at": utcnow(),
                }
            )
        except DuplicateKeyError:
            pass

    return {"status": "success", "message": "Report submitted"}

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


@app.get("/api/calls/session/{call_id}")
async def get_call_session(call_id: str, request: Request):
    user = await get_current_user(request)
    call = await db.call_history.find_one({"call_id": call_id}, {"_id": 0})
    if not call:
        raise HTTPException(status_code=404, detail="Call not found")

    participants = call.get("participants", [])
    if user["user_id"] not in participants:
        raise HTTPException(status_code=403, detail="You are not part of this call")

    other_user_id = next((participant for participant in participants if participant != user["user_id"]), None)
    if other_user_id:
        await enforce_not_blocked(user["user_id"], other_user_id)

    if DAILY_READY:
        session = await ensure_daily_call_session(call, user)
        return {
            "provider": "daily",
            "room_name": session["room_name"],
            "room_url": session["room_url"],
            "token": session["token"],
            "domain": session["domain"],
        }

    return {
        "provider": "webrtc",
        "ice_servers": build_ice_servers(),
        "turn_enabled": TURN_ENABLED,
        "turn_required": turn_required(),
    }

# ============ MATCHING ENDPOINTS ============

@app.post("/api/match/find")
async def find_match_endpoint(data: ConnectRequest, request: Request):
    """Find a match based on connection mode"""
    user = await get_current_user(request)
    await enforce_rate_limit(
        f"match-find:{user['user_id']}",
        limit_name="match_find",
        override_message="Too many match attempts. Please wait a moment.",
    )

    if turn_required() and not call_provider_ready():
        raise HTTPException(status_code=503, detail="A realtime call provider must be configured before matching is available in production.")

    user_id = user["user_id"]
    college = user.get("college", "")
    wifi = ""
    if data.mode == "same_wifi":
        wifi = derive_wifi_bucket(
            request,
            data.wifi_identifier,
            data.network_fingerprint,
        )

    current_match = await get_pending_match(user_id)
    if not current_match:
        current_match = await find_match(user_id, data.mode, college, wifi)

    if not current_match:
        return {"status": "waiting", "message": "Looking for a match..."}

    matched_user = await db.users.find_one(
        {"user_id": current_match["matched_user_id"]},
        {"_id": 0, "password_hash": 0, "email": 0},
    )
    if not matched_user:
        await discard_pending_match(current_match["matched_user_id"])
        raise HTTPException(status_code=404, detail="Matched user is no longer available")

    return {
        "status": "matched",
        "call_id": current_match["call_id"],
        "matched_user": matched_user,
        "is_initiator": current_match["is_initiator"],
    }

@app.post("/api/match/cancel")
async def cancel_match(request: Request):
    """Cancel matching and remove from queues"""
    user = await get_current_user(request)
    await enforce_rate_limit(
        f"match-cancel:{user['user_id']}",
        limit_name="match_cancel",
        override_message="Too many cancel requests. Please wait a moment.",
    )
    user_id = user["user_id"]
    cancelled_call_id = None

    await remove_user_from_queues(user_id)
    pending = await discard_pending_match(user_id)
    if pending:
        cancelled_call_id = pending.get("call_id")

    if cancelled_call_id:
        await db.call_history.update_one(
            {"call_id": cancelled_call_id},
            {"$set": {"status": "cancelled_before_connect", "ended_at": utcnow()}},
        )

    return {"status": "success", "message": "Matching cancelled"}

# ============ AI MATCHING ENDPOINTS ============

@app.post("/api/ai/suggest-match")
async def ai_suggest_match(data: AIMatchRequest, request: Request):
    """Get AI-powered match suggestions"""
    user = await get_current_user(request)
    blocks = await db.blocks.find(
        {
            "$or": [
                {"user_id": user["user_id"]},
                {"blocked_user_id": user["user_id"]},
            ]
        },
        {"_id": 0, "user_id": 1, "blocked_user_id": 1},
    ).to_list(500)
    blocked_ids = {
        block["blocked_user_id"] if block["user_id"] == user["user_id"] else block["user_id"]
        for block in blocks
    }
    
    # Get potential matches from same college or cross-college
    potential_users = await db.users.find(
        {
            "user_id": {"$ne": user["user_id"], "$nin": list(blocked_ids)},
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
    await enforce_not_blocked(user["user_id"], other_user_id)
    
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
        "created_at": utcnow()
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
        "created_at": utcnow().isoformat()
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
    user_id = sid_user_map.pop(sid, None)
    if not user_id:
        user_id = await get_socket_user_id(sid)
    
    if user_id:
        cancelled_call_id = None
        await mark_user_offline(user_id)

        still_online = False
        if redis_client is not None:
            still_online = bool(await redis_client.sismember(online_users_key(), user_id))
        else:
            still_online = user_id in active_users

        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"online": still_online, "last_seen": utcnow()}}
        )

        await remove_user_from_queues(user_id)
        pending = await discard_pending_match(user_id)
        if pending:
            cancelled_call_id = pending.get("call_id")

        if cancelled_call_id:
            await db.call_history.update_one(
                {"call_id": cancelled_call_id},
                {"$set": {"status": "cancelled_before_connect", "ended_at": utcnow()}},
            )

@sio.event
async def register_user(sid, data):
    """Register user socket connection"""
    access_token = data.get("access_token")
    claimed_user_id = data.get("user_id")

    if await socket_rate_limited(sid, f"socket-register:{sid}", "socket_register", "Too many socket registrations."):
        return

    if not access_token:
        await sio.emit("error", {"detail": "Socket authentication token is required."}, to=sid)
        await sio.disconnect(sid)
        return

    try:
        user = await decode_access_token_value(access_token)
    except HTTPException as exc:
        await sio.emit("error", {"detail": exc.detail}, to=sid)
        await sio.disconnect(sid)
        return

    user_id = user["user_id"]
    if claimed_user_id and claimed_user_id != user_id:
        await sio.emit("error", {"detail": "Socket user mismatch."}, to=sid)
        await sio.disconnect(sid)
        return

    sid_user_map[sid] = user_id
    await sio.save_session(sid, {"user_id": user_id})
    await sio.enter_room(sid, user_room(user_id))
    await mark_user_online(user_id)
    await db.users.update_one(
        {"user_id": user_id},
        {"$set": {"online": True, "last_seen": utcnow()}}
    )
    await sio.emit("registered", {"status": "ok", "user_id": user_id}, to=sid)

@sio.event
async def call_ready(sid, data):
    """Signal that a peer is registered and ready to receive call signaling."""
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return

    target_id = data.get("target_id")
    call_id = data.get("call_id")
    if not target_id or not call_id:
        return
    if await are_users_blocked(user_id, target_id):
        await sio.emit("error", {"detail": "You cannot connect to this user."}, to=sid)
        return

    call = await db.call_history.find_one(
        {"call_id": call_id},
        {"participants": 1, "_id": 0},
    )
    participants = call.get("participants", []) if call else []
    if user_id not in participants or target_id not in participants:
        await sio.emit("error", {"detail": "Call session is no longer valid."}, to=sid)
        return

    ready_peers = await mark_call_ready(call_id, user_id)
    if target_id not in ready_peers:
        return

    await sio.emit("call_ready", {
        "from_id": target_id,
        "call_id": call_id,
    }, room=user_room(user_id))
    await sio.emit("call_ready", {
        "from_id": user_id,
        "call_id": call_id,
    }, room=user_room(target_id))

@sio.event
async def friend_call_invite(sid, data):
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return
    if await socket_rate_limited(
        sid,
        f"socket-friend-call:{user_id}",
        "socket_friend_call",
        "Too many friend call attempts.",
    ):
        return

    target_id = data.get("target_id")
    if not target_id:
        return
    if user_id == target_id:
        await sio.emit("error", {"detail": "You cannot call yourself."}, to=sid)
        return
    if not await are_friends(user_id, target_id):
        await sio.emit("error", {"detail": "You can only call friends."}, to=sid)
        return
    if await are_users_blocked(user_id, target_id):
        await sio.emit("error", {"detail": "This call is unavailable due to a block."}, to=sid)
        return

    caller = await db.users.find_one(
        {"user_id": user_id},
        {"_id": 0, "password_hash": 0, "email": 0},
    )
    if caller is None:
        await sio.emit("error", {"detail": "Caller not found."}, to=sid)
        return

    call_id = data.get("call_id") or f"call_{uuid.uuid4().hex[:12]}"
    await db.call_history.update_one(
        {"call_id": call_id},
        {
            "$setOnInsert": {
                "call_id": call_id,
                "participants": [user_id, target_id],
                "mode": "friend",
                "created_at": utcnow(),
            },
            "$set": {
                "status": "ringing",
                "updated_at": utcnow(),
            },
        },
        upsert=True,
    )

    await sio.emit(
        "friend_call_invite",
        {
            "from_id": user_id,
            "call_id": call_id,
            "caller": caller,
        },
        room=user_room(target_id),
    )
    await sio.emit(
        "friend_call_invite_sent",
        {"target_id": target_id, "call_id": call_id},
        to=sid,
    )


@sio.event
async def friend_call_accept(sid, data):
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return

    target_id = data.get("target_id")
    call_id = data.get("call_id")
    if not target_id or not call_id:
        return
    if not await are_friends(user_id, target_id):
        await sio.emit("error", {"detail": "You can only call friends."}, to=sid)
        return
    if await are_users_blocked(user_id, target_id):
        await sio.emit("error", {"detail": "This call is unavailable due to a block."}, to=sid)
        return

    callee = await db.users.find_one(
        {"user_id": user_id},
        {"_id": 0, "password_hash": 0, "email": 0},
    )
    if callee is None:
        await sio.emit("error", {"detail": "User not found."}, to=sid)
        return

    await db.call_history.update_one(
        {"call_id": call_id},
        {"$set": {"status": "matched", "updated_at": utcnow()}},
        upsert=True,
    )

    await sio.emit(
        "friend_call_accepted",
        {
            "from_id": user_id,
            "call_id": call_id,
            "callee": callee,
        },
        room=user_room(target_id),
    )


@sio.event
async def friend_call_decline(sid, data):
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return

    target_id = data.get("target_id")
    call_id = data.get("call_id")
    if not target_id or not call_id:
        return

    await db.call_history.update_one(
        {"call_id": call_id},
        {"$set": {"status": "declined", "ended_at": utcnow()}},
    )
    await clear_call_ready_state(call_id)
    await sio.emit(
        "friend_call_declined",
        {"from_id": user_id, "call_id": call_id},
        room=user_room(target_id),
    )


@sio.event
async def offer(sid, data):
    """WebRTC offer signal"""
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return
    if await socket_rate_limited(sid, f"socket-offer:{user_id}", "socket_offer", "Too many call offers."):
        return

    target_id = data.get("target_id")
    if not target_id:
        return
    if await are_users_blocked(user_id, target_id):
        await sio.emit("error", {"detail": "You cannot call this user."}, to=sid)
        return

    await sio.emit("offer", {
        "offer": data.get("offer"),
        "from_id": user_id,
        "call_id": data.get("call_id")
    }, room=user_room(target_id))

@sio.event
async def answer(sid, data):
    """WebRTC answer signal"""
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return
    if await socket_rate_limited(sid, f"socket-answer:{user_id}", "socket_answer", "Too many call answers."):
        return

    target_id = data.get("target_id")
    if not target_id:
        return
    if await are_users_blocked(user_id, target_id):
        await sio.emit("error", {"detail": "You cannot answer this user."}, to=sid)
        return

    await sio.emit("answer", {
        "answer": data.get("answer"),
        "from_id": user_id,
        "call_id": data.get("call_id")
    }, room=user_room(target_id))

@sio.event
async def ice_candidate(sid, data):
    """WebRTC ICE candidate"""
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return
    if await socket_rate_limited(sid, f"socket-ice:{user_id}", "socket_ice", "Too many ICE candidates."):
        return

    target_id = data.get("target_id")
    if not target_id:
        return
    if await are_users_blocked(user_id, target_id):
        return

    await sio.emit("ice_candidate", {
        "candidate": data.get("candidate"),
        "from_id": user_id,
        "call_id": data.get("call_id"),
    }, room=user_room(target_id))

@sio.event
async def end_call(sid, data):
    """End call signal"""
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return

    target_id = data.get("target_id")
    call_id = data.get("call_id")
    
    if call_id:
        await db.call_history.update_one(
            {"call_id": call_id},
            {"$set": {
                "status": "ended",
                "ended_at": utcnow(),
                "duration": data.get("duration", 0)
            }}
        )
        await clear_call_ready_state(call_id)
    
    if target_id:
        await sio.emit("call_ended", {
            "from_id": user_id,
            "call_id": call_id
        }, room=user_room(target_id))

@sio.event
async def chat_message(sid, data):
    """In-call chat message"""
    user_id = await get_socket_user_id(sid)
    if not user_id:
        await sio.emit("error", {"detail": "Socket is not registered."}, to=sid)
        return
    if await socket_rate_limited(sid, f"socket-chat:{user_id}", "socket_chat", "Too many chat messages."):
        return

    target_id = data.get("target_id")
    message = (data.get("message") or "").strip()
    if not target_id or not message:
        return
    if await are_users_blocked(user_id, target_id):
        await sio.emit("error", {"detail": "This chat is unavailable due to a block."}, to=sid)
        return

    moderation_issue = content_is_disallowed(message, field_name="Message")
    if moderation_issue:
        await record_moderation_incident(user_id, message, moderation_issue, "chat_message")
        await sio.emit("error", {"detail": moderation_issue}, to=sid)
        return

    await db.messages.insert_one(
        {
            "message_id": f"msg_{uuid.uuid4().hex[:12]}",
            "sender_id": user_id,
            "receiver_id": target_id,
            "content": message,
            "created_at": utcnow(),
        }
    )

    await sio.emit("chat_message", {
        "message": message,
        "from_id": user_id
    }, room=user_room(target_id))

# ============ HEALTH & STATS ============ 

@app.get("/api/rtc-config")
async def get_rtc_config():
    return {
        "ice_servers": build_ice_servers(),
        "turn_enabled": TURN_ENABLED,
        "turn_required": turn_required(),
        "daily_enabled": DAILY_READY,
        "call_provider": preferred_call_provider(),
    }

@app.get("/api/health")
async def health_check():
    db_connected = await ping_database()
    redis_connected = await ping_redis() if REDIS_URL else False
    online_count = await get_online_user_count()
    service_ready = db_connected and (not REDIS_URL or redis_connected) and (not turn_required() or call_provider_ready())

    return {
        "status": "healthy" if service_ready else "degraded",
        "timestamp": utcnow().isoformat(),
        "online_users": online_count,
        "environment": APP_ENV,
        "same_wifi_strategy": "multi_bucket_ip_plus_browser_fingerprint",
        "turn_enabled": TURN_ENABLED,
        "turn_required": turn_required(),
        "daily_enabled": DAILY_READY,
        "call_provider": preferred_call_provider(),
        "database_connected": db_connected,
        "database_error": db_last_error,
        "redis_connected": redis_connected,
        "redis_error": redis_last_error,
    }

@app.get("/api/stats")
async def get_stats():
    """Get platform statistics"""
    online_count = await get_online_user_count()
    if not await ping_database():
        return {
            "status": "degraded",
            "database_connected": False,
            "total_users": 0,
            "online_users": online_count,
            "total_calls": 0,
            "database_error": db_last_error,
        }

    total_users = await db.users.count_documents({})
    total_calls = await db.call_history.count_documents({})
    
    return {
        "status": "healthy",
        "database_connected": True,
        "total_users": total_users,
        "online_users": online_count,
        "total_calls": total_calls,
    }

# For running with socket.io
app = socket_app
