import React, { useState, useEffect, createContext, useContext, useRef, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import axios from 'axios';
import {
  Users, Video, Phone, PhoneOff, Mic, MicOff, VideoOff,
  MessageSquare, UserPlus, History, Settings, LogOut,
  Wifi, Building2, Globe, Heart, Briefcase, BookOpen,
  Sparkles, Send, X, Check, Loader2, ChevronRight,
  ShieldAlert, Ban, Flag, Bell, Radio
} from 'lucide-react';

const trimTrailingSlash = (value) => value.replace(/\/+$/, '');

const resolveDefaultApiUrl = () => {
  if (typeof window === 'undefined') {
    return 'http://localhost:8001';
  }

  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.hostname}:8001`;
};

const API_URL = trimTrailingSlash(process.env.REACT_APP_BACKEND_URL || resolveDefaultApiUrl());
const MATCH_POLL_INTERVAL_MS = 900;
const MATCH_WAIT_TIMEOUT_MS = 60000;
const SOCKET_URL = API_URL.replace('https://', 'wss://').replace('http://', 'ws://');
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Axios config
axios.defaults.withCredentials = true;
axios.defaults.baseURL = API_URL;

const getRtcConfig = async () => {
  try {
    const { data } = await axios.get('/api/rtc-config');
    if (Array.isArray(data.ice_servers) && data.ice_servers.length > 0) {
      return data;
    }
  } catch (error) {
    console.error('RTC config error:', error);
  }

  return {
    ice_servers: DEFAULT_ICE_SERVERS,
    turn_enabled: false,
    turn_required: false,
  };
};

const getErrorMessage = (error, fallback) =>
  error?.response?.data?.detail || error?.message || fallback;

const ensureVideoPlayback = (videoElement) => {
  if (!videoElement?.play) {
    return;
  }

  const playPromise = videoElement.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((error) => {
      console.debug('Video playback pending user gesture:', error);
    });
  }
};

const hashText = async (value) => {
  if (!value) {
    return null;
  }

  if (!window.crypto?.subtle || typeof TextEncoder === 'undefined') {
    return btoa(value).replace(/=/g, '').slice(0, 32);
  }

  const buffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
};

const extractPrivateSubnet = (candidateString) => {
  const matches = candidateString.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
  if (!matches) {
    return null;
  }

  for (const ipAddress of matches) {
    const octets = ipAddress.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
      continue;
    }

    const [first, second, third] = octets;
    const isPrivate =
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168);

    if (isPrivate) {
      return `${first}.${second}.${third}`;
    }
  }

  return null;
};

const extractPrivateIpv6Prefix = (candidateString) => {
  const matches = candidateString.match(/\b(?:[a-f0-9]{0,4}:){2,7}[a-f0-9]{0,4}\b/gi);
  if (!matches) {
    return null;
  }

  for (const candidate of matches) {
    const normalized = candidate.toLowerCase();
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return normalized.split(':').slice(0, 4).join(':');
    }
  }

  return null;
};

const extractLocalNetworkSignature = (source) => {
  if (!source) {
    return null;
  }

  const ipv4Subnet = extractPrivateSubnet(source);
  if (ipv4Subnet) {
    return ipv4Subnet;
  }

  return extractPrivateIpv6Prefix(source);
};

const deriveSameNetworkFingerprint = async () => {
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    let detectedSubnet = null;
    const peerConnection = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
    });

    const finish = async (subnet) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      peerConnection.onicecandidate = null;
      try {
        peerConnection.close();
      } catch (error) {
        console.debug('Network probe close error:', error);
      }

      if (!subnet) {
        resolve(null);
        return;
      }

      try {
        resolve(await hashText(`same-network:${subnet}`));
      } catch (error) {
        console.debug('Network probe hash error:', error);
        resolve(null);
      }
    };

    const timeoutId = window.setTimeout(() => {
      void finish(detectedSubnet);
    }, 3500);

    peerConnection.createDataChannel('campuslink-network-probe');
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        const sdpSubnet = extractLocalNetworkSignature(peerConnection.localDescription?.sdp || '');
        if (!detectedSubnet && sdpSubnet) {
          detectedSubnet = sdpSubnet;
        }
        void finish(detectedSubnet);
        return;
      }

      const candidate = event.candidate;
      const subnet =
        extractLocalNetworkSignature(candidate.address || '') ||
        extractLocalNetworkSignature(candidate.relatedAddress || '') ||
        extractLocalNetworkSignature(candidate.candidate || '');
      if (subnet) {
        detectedSubnet = subnet;
        void finish(subnet);
      }
    };

    peerConnection
      .createOffer()
      .then((offer) => peerConnection.setLocalDescription(offer))
      .catch(() => {
        void finish(null);
      });
  });
};

const setAuthHeader = (token) => {
  if (token) {
    axios.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete axios.defaults.headers.common.Authorization;
  }
};

// Auth Context
const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    // Skip if processing OAuth callback
    if (window.location.hash?.includes('session_id=')) {
      setLoading(false);
      return;
    }

    const token = localStorage.getItem('access_token');
    setAuthHeader(token);

    try {
      const { data } = await axios.get('/api/auth/me');
      setUser(data);
    } catch (error) {
      setUser(null);
      setAuthHeader(null);
      localStorage.removeItem('access_token');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = (userData, token) => {
    setUser(userData);
    if (token) {
      localStorage.setItem('access_token', token);
      setAuthHeader(token);
    }
  };

  const logout = async () => {
    try {
      await axios.post('/api/auth/logout');
    } catch (e) { }
    setUser(null);
    setAuthHeader(null);
    localStorage.removeItem('access_token');
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
};

// Protected Route
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-12 h-12 animate-spin text-primary" strokeWidth={2.5} />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
};

// Landing Page
const LandingPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    if (user) navigate('/dashboard');
  }, [user, navigate]);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <header className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <h1 className="font-heading text-2xl font-black">CampusLink</h1>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:gap-4">
          <button
            data-testid="login-nav-btn"
            onClick={() => navigate('/login')}
            className="btn-brutal bg-surface w-full sm:w-auto"
          >
            Login
          </button>
          <button
            data-testid="signup-nav-btn"
            onClick={() => navigate('/signup')}
            className="btn-primary w-full sm:w-auto"
          >
            Sign Up
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-10 sm:px-6 sm:py-12">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="mb-6 font-heading text-4xl font-black tracking-tighter sm:text-5xl lg:text-6xl">
              Connect with
              <span className="text-primary"> College </span>
              Students
            </h2>
            <p className="mb-8 text-base leading-relaxed text-text-secondary sm:text-lg">
              Find study buddies, networking partners, co-founders, or maybe even love.
              Connect with students from your college or across India.
            </p>

            <div className="mb-10 flex flex-wrap gap-4 sm:mb-12">
              <button
                data-testid="get-started-btn"
                onClick={() => navigate('/signup')}
                className="btn-primary w-full text-base sm:w-auto sm:text-lg"
              >
                Get Started Free
                <ChevronRight className="inline ml-2" strokeWidth={2.5} />
              </button>
            </div>

            {/* Features */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              {[
                { icon: Building2, text: 'Same College', color: 'bg-accent-mint' },
                { icon: Wifi, text: 'Same Network', color: 'bg-accent-yellow' },
                { icon: Globe, text: 'Cross College', color: 'bg-accent-lilac' },
                { icon: Sparkles, text: 'AI Matching', color: 'bg-primary' },
              ].map((feat, i) => (
                <motion.div
                  key={feat.text}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + i * 0.1 }}
                  className={`${feat.color} min-h-[110px] border-2 border-border p-3 shadow-brutal sm:min-h-[124px] sm:p-4`}
                >
                  <feat.icon className="w-6 h-6 mb-2" strokeWidth={2.5} />
                  <span className="text-sm font-bold sm:text-base">{feat.text}</span>
                </motion.div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="hidden lg:block"
          >
            <div className="card-brutal p-0 overflow-hidden">
              <img
                src="https://images.unsplash.com/photo-1686624386665-4cd01b96d0f6?w=800&q=80"
                alt="Students connecting"
                className="w-full h-[500px] object-cover"
              />
            </div>
          </motion.div>
        </div>

        {/* What You Can Do */}
        <section className="mt-24">
          <h3 className="font-heading text-3xl font-black text-center mb-12">
            What will you find?
          </h3>
          <div className="grid md:grid-cols-4 gap-6">
            {[
              { icon: BookOpen, title: 'Study Buddies', desc: 'Solve problems together', color: 'bg-accent-mint' },
              { icon: Briefcase, title: 'Co-founders', desc: 'Build your startup team', color: 'bg-accent-yellow' },
              { icon: Users, title: 'Networking', desc: 'Grow your circle', color: 'bg-accent-lilac' },
              { icon: Heart, title: 'Love', desc: 'Find your match', color: 'bg-primary' },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 + i * 0.1 }}
                className={`${item.color} border-2 border-border p-6 shadow-brutal`}
              >
                <item.icon className="w-10 h-10 mb-4" strokeWidth={2.5} />
                <h4 className="font-heading text-xl font-bold mb-2">{item.title}</h4>
                <p className="text-text-secondary">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};

// Login Page
const LoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data } = await axios.post(`${API_URL}/api/auth/login`, { email, password });
      login(data.user, data.access_token);
      navigate('/dashboard');
    } catch (err) {
      const detail = err.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = () => {
    // REMINDER: DO NOT HARDCODE THE URL, OR ADD ANY FALLBACKS OR REDIRECT URLS, THIS BREAKS THE AUTH
    const redirectUrl = window.location.origin + '/auth/callback';
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(redirectUrl)}`;
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="card-brutal">
          <h1 className="font-heading text-3xl font-black mb-2">Welcome Back</h1>
          <p className="text-text-secondary mb-8">Sign in with your college email</p>

          {error && (
            <div className="bg-red-100 border-2 border-red-500 p-4 mb-6 text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs font-bold uppercase tracking-widest mb-2 block">
                College Email
              </label>
              <input
                data-testid="login-email-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-brutal"
                placeholder="you@college.ac.in"
                required
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-widest mb-2 block">
                Password
              </label>
              <input
                data-testid="login-password-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-brutal"
                placeholder="••••••••"
                required
              />
            </div>

            <button
              data-testid="login-submit-btn"
              type="submit"
              disabled={loading}
              className="btn-primary w-full flex items-center justify-center"
            >
              {loading ? <Loader2 className="animate-spin" /> : 'Sign In'}
            </button>
          </form>

          <div className="relative my-8">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t-2 border-border"></div>
            </div>
            <div className="relative flex justify-center">
              <span className="bg-surface px-4 text-text-secondary">or</span>
            </div>
          </div>

          <button
            data-testid="google-login-btn"
            onClick={handleGoogleLogin}
            className="btn-brutal bg-surface w-full flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Continue with Google
          </button>

          <p className="text-center mt-6 text-text-secondary">
            Don't have an account?{' '}
            <button
              onClick={() => navigate('/signup')}
              className="text-secondary font-bold underline"
            >
              Sign up
            </button>
          </p>
        </div>
      </motion.div>
    </div>
  );
};

// Signup Page
const SignupPage = () => {
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [interests, setInterests] = useState([]);
  const [lookingFor, setLookingFor] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuth();

  const interestOptions = ['Coding', 'Design', 'Business', 'Music', 'Sports', 'Art', 'Gaming', 'Reading', 'Travel', 'Fitness'];
  const lookingForOptions = [
    { id: 'study_buddy', label: 'Study Buddy', icon: BookOpen },
    { id: 'networking', label: 'Networking', icon: Users },
    { id: 'cofounder', label: 'Co-founder', icon: Briefcase },
    { id: 'love', label: 'Love', icon: Heart },
  ];

  const sendOtp = async () => {
    setError('');
    setLoading(true);
    try {
      await axios.post(`${API_URL}/api/auth/send-otp`, { email });
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async () => {
    setError('');
    setLoading(true);
    try {
      await axios.post(`${API_URL}/api/auth/verify-otp`, { email, otp });
      setStep(3);
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    setError('');
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_URL}/api/auth/register`, {
        email,
        password,
        name,
        interests,
        looking_for: lookingFor,
      });
      login(data.user, data.access_token);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.detail || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleInterest = (interest) => {
    setInterests(prev =>
      prev.includes(interest) ? prev.filter(i => i !== interest) : [...prev, interest]
    );
  };

  const toggleLookingFor = (item) => {
    setLookingFor(prev =>
      prev.includes(item) ? prev.filter(i => i !== item) : [...prev, item]
    );
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="card-brutal">
          {/* Progress */}
          <div className="flex gap-2 mb-8">
            {[1, 2, 3, 4].map((s) => (
              <div
                key={s}
                className={`h-2 flex-1 border-2 border-border ${s <= step ? 'bg-primary' : 'bg-surface'}`}
              />
            ))}
          </div>

          {error && (
            <div className="bg-red-100 border-2 border-red-500 p-4 mb-6 text-red-700">
              {error}
            </div>
          )}

          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <h1 className="font-heading text-3xl font-black mb-2">Join CampusLink</h1>
                <p className="text-text-secondary mb-8">Enter your college email to get started</p>

                <div className="mb-6">
                  <label className="text-xs font-bold uppercase tracking-widest mb-2 block">
                    College Email
                  </label>
                  <input
                    data-testid="signup-email-input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input-brutal"
                    placeholder="you@college.ac.in"
                  />
                  <p className="text-sm text-text-secondary mt-2">
                    Only Indian college emails (.ac.in, .edu.in) accepted
                  </p>
                </div>

                <button
                  data-testid="send-otp-btn"
                  onClick={sendOtp}
                  disabled={loading || !email}
                  className="btn-primary w-full flex items-center justify-center"
                >
                  {loading ? <Loader2 className="animate-spin" /> : 'Send OTP'}
                </button>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <h1 className="font-heading text-3xl font-black mb-2">Verify Email</h1>
                <p className="text-text-secondary mb-8">Enter the 6-digit code sent to {email}</p>

                <div className="mb-6">
                  <input
                    data-testid="otp-input"
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="input-brutal text-center text-2xl tracking-[0.5em]"
                    placeholder="000000"
                    maxLength={6}
                  />
                </div>

                <button
                  data-testid="verify-otp-btn"
                  onClick={verifyOtp}
                  disabled={loading || otp.length !== 6}
                  className="btn-primary w-full flex items-center justify-center"
                >
                  {loading ? <Loader2 className="animate-spin" /> : 'Verify'}
                </button>

                <button
                  onClick={() => { setStep(1); setOtp(''); }}
                  className="w-full mt-4 text-text-secondary"
                >
                  Change email
                </button>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <h1 className="font-heading text-3xl font-black mb-2">Create Account</h1>
                <p className="text-text-secondary mb-8">Set up your profile</p>

                <div className="space-y-4 mb-6">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-widest mb-2 block">
                      Your Name
                    </label>
                    <input
                      data-testid="signup-name-input"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="input-brutal"
                      placeholder="Your name"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold uppercase tracking-widest mb-2 block">
                      Password
                    </label>
                    <input
                      data-testid="signup-password-input"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="input-brutal"
                      placeholder="Min 6 characters"
                    />
                  </div>
                </div>

                <button
                  data-testid="continue-interests-btn"
                  onClick={() => setStep(4)}
                  disabled={!name || password.length < 6}
                  className="btn-primary w-full"
                >
                  Continue
                </button>
              </motion.div>
            )}

            {step === 4 && (
              <motion.div
                key="step4"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <h1 className="font-heading text-3xl font-black mb-2">What are you looking for?</h1>
                <p className="text-text-secondary mb-6">Select all that apply</p>

                <div className="grid grid-cols-2 gap-3 mb-6">
                  {lookingForOptions.map((opt) => (
                    <button
                      key={opt.id}
                      data-testid={`looking-for-${opt.id}`}
                      onClick={() => toggleLookingFor(opt.id)}
                      className={`p-4 border-2 border-border flex flex-col items-center gap-2 transition-all
                        ${lookingFor.includes(opt.id) ? 'bg-primary shadow-brutal' : 'bg-surface hover:shadow-brutal'}`}
                    >
                      <opt.icon strokeWidth={2.5} className="w-6 h-6" />
                      <span className="font-bold text-sm">{opt.label}</span>
                    </button>
                  ))}
                </div>

                <div className="mb-6">
                  <label className="text-xs font-bold uppercase tracking-widest mb-3 block">
                    Your Interests
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {interestOptions.map((interest) => (
                      <button
                        key={interest}
                        data-testid={`interest-${interest.toLowerCase()}`}
                        onClick={() => toggleInterest(interest)}
                        className={`px-4 py-2 border-2 border-border text-sm font-bold transition-all
                          ${interests.includes(interest) ? 'bg-secondary text-white shadow-brutal' : 'bg-surface'}`}
                      >
                        {interest}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  data-testid="complete-signup-btn"
                  onClick={handleRegister}
                  disabled={loading || lookingFor.length === 0}
                  className="btn-primary w-full flex items-center justify-center"
                >
                  {loading ? <Loader2 className="animate-spin" /> : 'Complete Signup'}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <p className="text-center mt-6 text-text-secondary">
            Already have an account?{' '}
            <button
              onClick={() => navigate('/login')}
              className="text-secondary font-bold underline"
            >
              Sign in
            </button>
          </p>
        </div>
      </motion.div>
    </div>
  );
};

// Auth Callback for Google OAuth
const AuthCallback = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const hasProcessed = useRef(false);

  useEffect(() => {
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const processCallback = async () => {
      const hash = window.location.hash;
      const sessionIdMatch = hash.match(/session_id=([^&]+)/);

      if (!sessionIdMatch) {
        navigate('/login');
        return;
      }

      const sessionId = sessionIdMatch[1];

      try {
        const { data } = await axios.post(`${API_URL}/api/auth/google/callback`, {
          session_id: sessionId
        });
        login(data.user, data.access_token);
        navigate('/dashboard');
      } catch (err) {
        console.error('Auth callback error:', err);
        navigate('/login');
      }
    };

    processCallback();
  }, [navigate, login]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <Loader2 className="w-12 h-12 animate-spin text-primary" strokeWidth={2.5} />
    </div>
  );
};

// Dashboard
const Dashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('connect');
  const [stats, setStats] = useState({ online_users: 0, total_calls: 0 });
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [dashboardNotice, setDashboardNotice] = useState('');
  const [incomingFriendCall, setIncomingFriendCall] = useState(null);
  const [outgoingFriendCall, setOutgoingFriendCall] = useState(null);
  const [friendCallSession, setFriendCallSession] = useState(null);
  const appSocketRef = useRef(null);
  const outgoingFriendCallRef = useRef(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const { data } = await axios.get(`${API_URL}/api/stats`);
        setStats(data);
      } catch (e) { }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    outgoingFriendCallRef.current = outgoingFriendCall;
  }, [outgoingFriendCall]);

  useEffect(() => {
    if (!user) {
      return undefined;
    }

    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1000,
    });
    appSocketRef.current = socket;

    const registerSocketUser = () => {
      const accessToken = localStorage.getItem('access_token');
      if (!accessToken) {
        setDashboardNotice('Your session expired. Please sign in again.');
        return;
      }

      socket.emit('register_user', {
        user_id: user.user_id,
        access_token: accessToken,
      });
    };

    socket.on('connect', registerSocketUser);
    socket.on('registered', () => {
      setRealtimeReady(true);
    });
    socket.on('disconnect', () => {
      setRealtimeReady(false);
    });
    socket.on('error', (data) => {
      if (data?.detail) {
        setDashboardNotice(data.detail);
      }
    });
    socket.on('friend_call_invite', (data) => {
      setIncomingFriendCall(data);
      setActiveTab('friends');
      setDashboardNotice(`${data?.caller?.name || 'A friend'} is calling you.`);
    });
    socket.on('friend_call_invite_sent', (data) => {
      if (outgoingFriendCallRef.current?.callId === data?.call_id) {
        setOutgoingFriendCall((previous) => previous ? { ...previous, status: 'ringing' } : previous);
      }
    });
    socket.on('friend_call_accepted', (data) => {
      const acceptedFriend = data?.callee || outgoingFriendCallRef.current?.friend;
      if (!acceptedFriend) {
        return;
      }
      setFriendCallSession({
        matchedUser: acceptedFriend,
        callId: data.call_id,
        mode: 'friend',
        isInitiator: true,
      });
      setOutgoingFriendCall(null);
      setIncomingFriendCall(null);
      setDashboardNotice('');
    });
    socket.on('friend_call_declined', (data) => {
      if (outgoingFriendCallRef.current?.callId === data?.call_id) {
        setOutgoingFriendCall(null);
        setDashboardNotice('Friend call declined.');
      }
    });

    if (socket.connected) {
      registerSocketUser();
    }

    return () => {
      socket.disconnect();
      appSocketRef.current = null;
      setRealtimeReady(false);
    };
  }, [user]);

  const startFriendCall = (friend) => {
    if (!appSocketRef.current || !realtimeReady) {
      setDashboardNotice('Realtime connection is not ready yet. Please wait a moment and try again.');
      return;
    }

    const callId = `call_${Math.random().toString(16).slice(2, 14)}`;
    setOutgoingFriendCall({ friend, callId, status: 'dialing' });
    setDashboardNotice(`Calling ${friend.name}...`);
    appSocketRef.current.emit('friend_call_invite', {
      target_id: friend.user_id,
      call_id: callId,
    });
  };

  const acceptFriendCall = () => {
    if (!incomingFriendCall || !appSocketRef.current) {
      return;
    }

    appSocketRef.current.emit('friend_call_accept', {
      target_id: incomingFriendCall.from_id,
      call_id: incomingFriendCall.call_id,
    });
    setFriendCallSession({
      matchedUser: incomingFriendCall.caller,
      callId: incomingFriendCall.call_id,
      mode: 'friend',
      isInitiator: false,
    });
    setIncomingFriendCall(null);
    setOutgoingFriendCall(null);
    setDashboardNotice('');
  };

  const declineFriendCall = () => {
    if (!incomingFriendCall || !appSocketRef.current) {
      return;
    }

    appSocketRef.current.emit('friend_call_decline', {
      target_id: incomingFriendCall.from_id,
      call_id: incomingFriendCall.call_id,
    });
    setDashboardNotice('Friend call declined.');
    setIncomingFriendCall(null);
  };

  const endFriendCall = () => {
    setFriendCallSession(null);
  };

  const tabs = [
    { id: 'connect', label: 'Connect', icon: Video },
    { id: 'friends', label: 'Friends', icon: Users },
    { id: 'history', label: 'History', icon: History },
    { id: 'profile', label: 'Profile', icon: Settings },
  ];

  if (friendCallSession) {
    return (
      <div className="min-h-screen bg-background">
        <header className="bg-surface border-b-2 border-border p-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <h1 className="font-heading text-2xl font-black">CampusLink</h1>
            <span className="font-bold text-sm text-text-secondary">Friend call in progress</span>
          </div>
        </header>
        <div className="max-w-7xl mx-auto p-6">
          <VideoCall
            matchedUser={friendCallSession.matchedUser}
            callId={friendCallSession.callId}
            mode={friendCallSession.mode}
            isInitiator={friendCallSession.isInitiator}
            onEndCall={endFriendCall}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-surface border-b-2 border-border px-4 py-4 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <h1 className="font-heading text-xl font-black sm:text-2xl">CampusLink</h1>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between md:justify-end md:gap-6">
            <div className="hidden md:flex items-center gap-4 text-sm">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                {stats.online_users} online
              </span>
              <span>{stats.total_calls} calls made</span>
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="max-w-[12rem] truncate font-bold sm:max-w-none">{user?.name}</span>
              <button
                data-testid="logout-btn"
                onClick={logout}
                className="btn-brutal bg-surface !min-w-[52px] !px-3 !py-3"
                aria-label="Logout"
              >
                <LogOut className="w-5 h-5" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-6">
        {dashboardNotice && (
          <div className="mb-6 border-2 border-border bg-accent-yellow px-4 py-3 shadow-brutal">
            <p className="font-bold">{dashboardNotice}</p>
          </div>
        )}

        {incomingFriendCall && (
          <div className="mb-6 border-2 border-border bg-surface px-5 py-5 shadow-brutal">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-widest text-text-secondary">Incoming Friend Call</p>
                <h2 className="font-heading text-2xl font-black">{incomingFriendCall.caller?.name} is calling</h2>
                <p className="text-text-secondary">{incomingFriendCall.caller?.college}</p>
              </div>
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                <button onClick={acceptFriendCall} className="btn-primary w-full sm:w-auto">
                  Accept Call
                </button>
                <button onClick={declineFriendCall} className="btn-brutal bg-surface w-full sm:w-auto">
                  Decline
                </button>
              </div>
            </div>
          </div>
        )}

        {outgoingFriendCall && (
          <div className="mb-6 border-2 border-border bg-accent-lilac px-4 py-3 shadow-brutal">
            <p className="font-bold">
              Calling {outgoingFriendCall.friend.name}...
              <span className="ml-2 text-sm text-text-secondary">
                {outgoingFriendCall.status === 'ringing' ? 'Waiting for them to accept.' : 'Sending invite.'}
              </span>
            </p>
          </div>
        )}

        {/* Tabs */}
        <div className="-mx-1 mb-8 flex gap-2 overflow-x-auto px-1 pb-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              data-testid={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex min-h-[52px] shrink-0 items-center gap-2 whitespace-nowrap border-2 border-border px-4 py-3 text-sm font-bold transition-all sm:px-6 sm:text-base
                ${activeTab === tab.id ? 'bg-primary shadow-brutal' : 'bg-surface hover:shadow-brutal'}`}
            >
              <tab.icon className="w-5 h-5" strokeWidth={2.5} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <AnimatePresence mode="wait">
          {activeTab === 'connect' && <ConnectTab key="connect" />}
          {activeTab === 'friends' && (
            <FriendsTab
              key="friends"
              onStartFriendCall={startFriendCall}
              realtimeReady={realtimeReady}
              outgoingFriendCall={outgoingFriendCall}
            />
          )}
          {activeTab === 'history' && <HistoryTab key="history" />}
          {activeTab === 'profile' && <ProfileTab key="profile" />}
        </AnimatePresence>
      </div>
    </div>
  );
};

// Connect Tab
const ConnectTab = () => {
  const { user } = useAuth();
  const [mode, setMode] = useState(null);
  const [matching, setMatching] = useState(false);
  const [matchedUser, setMatchedUser] = useState(null);
  const [callId, setCallId] = useState(null);
  const [inCall, setInCall] = useState(false);
  const [isInitiator, setIsInitiator] = useState(false);
  const [matchError, setMatchError] = useState('');
  const pollTimeoutRef = useRef(null);
  const isCancelledRef = useRef(false);

  const clearPendingPoll = () => {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  };

  useEffect(() => () => {
    isCancelledRef.current = true;
    clearPendingPoll();
  }, []);

  const connectionModes = [
    {
      id: 'same_college',
      title: 'Same College',
      desc: `Connect with ${user?.college} students`,
      icon: Building2,
      color: 'bg-accent-mint',
    },
    {
      id: 'same_wifi',
      title: 'Same Network',
      desc: 'Best effort for campus WiFi or local LAN users',
      icon: Wifi,
      color: 'bg-accent-yellow',
    },
    {
      id: 'cross_college',
      title: 'Cross College',
      desc: 'Meet students from other colleges',
      icon: Globe,
      color: 'bg-accent-lilac',
    },
  ];

  const startMatching = async (selectedMode) => {
    clearPendingPoll();
    isCancelledRef.current = false;
    setMatchError('');
    setMode(selectedMode);
    setMatching(true);
    const networkFingerprint = selectedMode === 'same_wifi'
      ? await deriveSameNetworkFingerprint()
      : null;
    const startedAt = Date.now();

    const pollMatch = async () => {
      if (isCancelledRef.current) {
        return;
      }

      try {
        const requestBody = {
          mode: selectedMode,
        };

        if (networkFingerprint) {
          requestBody.network_fingerprint = networkFingerprint;
        }

        const { data } = await axios.post('/api/match/find', requestBody);

        if (data.status === 'matched') {
          clearPendingPoll();
          setMatchedUser(data.matched_user);
          setCallId(data.call_id);
          setIsInitiator(Boolean(data.is_initiator));
          setMatching(false);
          setInCall(true);
          return;
        }

        if (Date.now() - startedAt >= MATCH_WAIT_TIMEOUT_MS) {
          setMatching(false);
          setMode(null);
          setMatchError('No one is available right now. Try again in a minute.');
          return;
        }

        pollTimeoutRef.current = setTimeout(pollMatch, MATCH_POLL_INTERVAL_MS);
      } catch (err) {
        if (err.response?.status === 401) {
          console.error('Matching unauthorized, stopping polling.');
          clearPendingPoll();
          setMatching(false);
          setMode(null);
          return;
        }

        console.error('Matching error:', err);
        clearPendingPoll();
        setMatchError(getErrorMessage(err, 'Could not start matching. Check backend reachability and try again.'));
        setMatching(false);
        setMode(null);
      }
    };

    await pollMatch();
  };

  const cancelMatching = async () => {
    isCancelledRef.current = true;
    clearPendingPoll();
    try {
      await axios.post('/api/match/cancel');
    } catch (e) { }
    setMatching(false);
    setMode(null);
  };

  const endCall = () => {
    setInCall(false);
    setMatchedUser(null);
    setCallId(null);
    setMode(null);
    setIsInitiator(false);
  };

  if (inCall && matchedUser) {
    return (
      <VideoCall
        matchedUser={matchedUser}
        callId={callId}
        mode={mode}
        isInitiator={isInitiator}
        onEndCall={endCall}
      />
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      {matching ? (
        <div className="card-brutal px-4 py-10 text-center sm:px-6 sm:py-16">
          <div className="w-24 h-24 mx-auto mb-6 relative">
            <div className="absolute inset-0 border-4 border-primary rounded-full animate-ping opacity-25"></div>
            <div className="absolute inset-0 border-4 border-primary rounded-full animate-pulse"></div>
            <div className="absolute inset-4 bg-primary rounded-full flex items-center justify-center">
              <Users className="w-8 h-8 text-text-primary" strokeWidth={2.5} />
            </div>
          </div>

          <h2 className="font-heading mb-4 text-2xl font-bold sm:text-3xl">Finding your match...</h2>
          <p className="mb-8 text-sm text-text-secondary sm:text-base">
            Looking for someone in {mode === 'same_college' ? user?.college : mode === 'same_wifi' ? 'your network' : 'other colleges'}
          </p>

          <button
            data-testid="cancel-matching-btn"
            onClick={cancelMatching}
            className="btn-brutal bg-surface w-full sm:w-auto"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <h2 className="mb-6 font-heading text-2xl font-black sm:text-3xl">Choose Connection Mode</h2>

          {matchError && (
            <div className="bg-red-100 border-2 border-red-500 p-4 mb-6 text-red-700">
              {matchError}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-3 md:gap-6">
            {connectionModes.map((connMode) => (
              <motion.button
                key={connMode.id}
                data-testid={`connect-${connMode.id}`}
                onClick={() => startMatching(connMode.id)}
                whileHover={{ y: -4 }}
                className={`${connMode.color} flex min-h-[184px] w-full flex-col justify-between border-2 border-border p-5 text-left shadow-brutal transition-all sm:min-h-[220px] sm:p-7`}
              >
                <div>
                  <connMode.icon className="mb-3 h-10 w-10 sm:mb-4 sm:h-12 sm:w-12" strokeWidth={2.5} />
                  <h3 className="mb-2 font-heading text-lg font-bold sm:text-xl">{connMode.title}</h3>
                </div>
                <p className="text-sm leading-relaxed text-text-secondary sm:text-base">{connMode.desc}</p>
              </motion.button>
            ))}
          </div>

          <p className="mt-5 text-sm leading-relaxed text-text-secondary">
            Same Network uses your request IP and, when the browser exposes it, a hashed local subnet fingerprint.
            Browsers do not expose the actual WiFi SSID.
          </p>

          {/* AI Suggestions */}
          <div className="mt-8">
            <div className="card-brutal bg-primary/10">
              <div className="flex items-center gap-4 mb-4">
                <Sparkles className="w-8 h-8 text-primary" strokeWidth={2.5} />
                <h3 className="font-heading text-xl font-bold">AI-Powered Matching</h3>
              </div>
              <p className="text-text-secondary mb-4">
                Let our AI find the perfect match based on your interests and goals.
              </p>
              <button
                data-testid="ai-match-btn"
                onClick={() => startMatching('cross_college')}
                className="btn-primary w-full sm:w-auto"
              >
                Find AI Match
              </button>
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
};

// Video Call Component
const VideoCall = ({ matchedUser, callId, mode, isInitiator, onEndCall }) => {
  const { user } = useAuth();
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [iceBreakers, setIceBreakers] = useState([]);
  const [callError, setCallError] = useState('');
  const [actionFeedback, setActionFeedback] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [callStatus, setCallStatus] = useState('Preparing secure call...');
  const [remoteVideoReady, setRemoteVideoReady] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);
  const messagesEndRef = useRef(null);
  const remoteReadyRef = useRef(false);
  const offerStartedRef = useRef(false);
  const socketRegisteredRef = useRef(false);
  const reportReasonOptions = [
    { id: 'harassment', label: 'Harassment' },
    { id: 'hate', label: 'Hate speech' },
    { id: 'spam', label: 'Spam' },
    { id: 'sexual_content', label: 'Sexual content' },
    { id: 'violence', label: 'Violence' },
    { id: 'impersonation', label: 'Impersonation' },
    { id: 'other', label: 'Other' },
  ];

  const handleEndCall = (notifyPeer = true) => {
    if (notifyPeer && socketRef.current) {
      socketRef.current.emit('end_call', {
        target_id: matchedUser.user_id,
        call_id: callId
      });
    }
    onEndCall();
  };

  // Fetch ice breakers
  useEffect(() => {
    const fetchIceBreakers = async () => {
      try {
        const { data } = await axios.post('/api/ai/ice-breaker', {
          other_user_id: matchedUser.user_id
        });
        if (typeof data.ice_breakers === 'string') {
          setIceBreakers(data.ice_breakers.split('\n').filter(s => s.trim()));
        } else {
          setIceBreakers(data.ice_breakers || []);
        }
      } catch (e) { }
    };
    fetchIceBreakers();
  }, [matchedUser]);

  useEffect(() => {
    if (!chatOpen) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, chatOpen]);

  useEffect(() => {
    if (chatOpen && unreadMessages > 0) {
      setUnreadMessages(0);
    }
  }, [chatOpen, unreadMessages]);

  // WebRTC Setup
  useEffect(() => {
    let isMounted = true;

    const setupCall = async () => {
      try {
        remoteReadyRef.current = false;
        offerStartedRef.current = false;
        socketRegisteredRef.current = false;
        setCallStatus('Connecting to live call...');
        setRemoteVideoReady(false);
        setCallError('');
        pendingIceCandidatesRef.current = [];
        remoteStreamRef.current = new MediaStream();
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = remoteStreamRef.current;
        }

        const mediaPromise = navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        const rtcConfigPromise = getRtcConfig();

        // Setup Socket.IO
        socketRef.current = io(SOCKET_URL, {
          transports: ['websocket'],
          withCredentials: true,
          reconnection: true,
          reconnectionAttempts: 8,
          reconnectionDelay: 1000,
        });

        const waitForSocketRegistration = () =>
          new Promise((resolve, reject) => {
            const timeoutId = window.setTimeout(() => {
              cleanup();
              reject(new Error('Socket registration timed out.'));
            }, 10000);

            const cleanup = () => {
              window.clearTimeout(timeoutId);
              socketRef.current?.off('registered', handleRegistered);
              socketRef.current?.off('error', handleSocketError);
              socketRef.current?.off('disconnect', handleDisconnect);
            };

            const handleRegistered = () => {
              socketRegisteredRef.current = true;
              cleanup();
              resolve();
            };

            const handleSocketError = (data) => {
              const detail = data?.detail || 'Socket registration failed.';
              cleanup();
              reject(new Error(detail));
            };

            const handleDisconnect = () => {
              cleanup();
              reject(new Error('Socket disconnected before registration completed.'));
            };

            socketRef.current.on('registered', handleRegistered);
            socketRef.current.on('error', handleSocketError);
            socketRef.current.on('disconnect', handleDisconnect);
          });

        const sendOfferIfReady = async () => {
          if (!isInitiator || !remoteReadyRef.current || offerStartedRef.current || !peerConnectionRef.current) {
            return;
          }

          offerStartedRef.current = true;
          const offer = await peerConnectionRef.current.createOffer();
          await peerConnectionRef.current.setLocalDescription(offer);

          socketRef.current.emit('offer', {
            offer,
            target_id: matchedUser.user_id,
            call_id: callId
          });
        };
        const registrationPromise = waitForSocketRegistration();

        const registerSocketUser = () => {
          const accessToken = localStorage.getItem('access_token');
          if (!accessToken) {
            setCallError('Your session expired. Please log in again before starting a call.');
            return;
          }

          socketRef.current.emit('register_user', {
            user_id: user.user_id,
            access_token: accessToken,
          });
        };

        socketRef.current.on('connect', registerSocketUser);

        if (socketRef.current.connected) {
          registerSocketUser();
        }

        await registrationPromise;

        const [stream, rtcConfig] = await Promise.all([mediaPromise, rtcConfigPromise]);
        if (!isMounted) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          ensureVideoPlayback(localVideoRef.current);
        }
        if (rtcConfig.turn_required && !rtcConfig.turn_enabled) {
          throw new Error('TURN relay is required before calls can start in production.');
        }

        peerConnectionRef.current = new RTCPeerConnection({
          iceServers: rtcConfig.ice_servers,
          iceTransportPolicy: 'all',
          iceCandidatePoolSize: 10,
        });

        const attachRemoteStream = (incomingStream) => {
          if (!incomingStream || !remoteVideoRef.current) {
            return;
          }

          remoteStreamRef.current = incomingStream;
          if (remoteVideoRef.current.srcObject !== incomingStream) {
            remoteVideoRef.current.srcObject = incomingStream;
          }
          ensureVideoPlayback(remoteVideoRef.current);
        };

        const flushPendingIceCandidates = async () => {
          if (!peerConnectionRef.current?.remoteDescription?.type || pendingIceCandidatesRef.current.length === 0) {
            return;
          }

          const queuedCandidates = [...pendingIceCandidatesRef.current];
          pendingIceCandidatesRef.current = [];
          for (const candidate of queuedCandidates) {
            try {
              await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
              console.debug('Queued ICE candidate error:', error);
            }
          }
        };

        // Add local tracks
        stream.getTracks().forEach(track => {
          peerConnectionRef.current.addTrack(track, stream);
        });

        // Handle remote stream
        peerConnectionRef.current.ontrack = (event) => {
          const incomingStream = event.streams?.[0];
          if (incomingStream) {
            attachRemoteStream(incomingStream);
          } else {
            if (!remoteStreamRef.current) {
              remoteStreamRef.current = new MediaStream();
            }
            remoteStreamRef.current.addTrack(event.track);
            attachRemoteStream(remoteStreamRef.current);
          }

          if (event.track.kind === 'video') {
            const markRemoteVideoReady = () => {
              setRemoteVideoReady(true);
              setCallStatus('Connected');
              ensureVideoPlayback(remoteVideoRef.current);
            };

            if (event.track.readyState === 'live' && !event.track.muted) {
              markRemoteVideoReady();
            }
            event.track.onunmute = markRemoteVideoReady;
          }
        };

        peerConnectionRef.current.onconnectionstatechange = () => {
          const state = peerConnectionRef.current?.connectionState;
          if (state === 'connected') {
            setCallStatus('Connected');
          } else if (state === 'connecting') {
            setCallStatus('Connecting video...');
          } else if (state === 'failed') {
            setCallStatus('Connection failed. Trying to recover...');
          } else if (state === 'disconnected') {
            setCallStatus('Connection interrupted...');
          }
        };

        peerConnectionRef.current.oniceconnectionstatechange = () => {
          const iceState = peerConnectionRef.current?.iceConnectionState;
          if (iceState === 'checking') {
            setCallStatus('Checking network route...');
          } else if (iceState === 'connected' || iceState === 'completed') {
            setCallStatus('Connected');
          }
        };

        // ICE candidates
        peerConnectionRef.current.onicecandidate = (event) => {
          if (event.candidate) {
            socketRef.current.emit('ice_candidate', {
              candidate: event.candidate,
              target_id: matchedUser.user_id,
              call_id: callId,
            });
          }
        };

        // Handle incoming offer
        socketRef.current.on('offer', async (data) => {
          if (data?.from_id !== matchedUser.user_id || data?.call_id !== callId) {
            return;
          }
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
          await flushPendingIceCandidates();
          const answer = await peerConnectionRef.current.createAnswer();
          await peerConnectionRef.current.setLocalDescription(answer);

          socketRef.current.emit('answer', {
            answer: answer,
            target_id: data.from_id,
            call_id: callId
          });
        });

        // Handle answer
        socketRef.current.on('answer', async (data) => {
          if (data?.from_id !== matchedUser.user_id || data?.call_id !== callId) {
            return;
          }
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
          await flushPendingIceCandidates();
        });

        // Handle ICE candidates
        socketRef.current.on('ice_candidate', async (data) => {
          if (!data?.candidate || !peerConnectionRef.current) {
            return;
          }
          if (data?.from_id !== matchedUser.user_id || data?.call_id !== callId) {
            return;
          }

          if (!peerConnectionRef.current.remoteDescription?.type) {
            pendingIceCandidatesRef.current.push(data.candidate);
            return;
          }

          try {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (error) {
            console.debug('ICE candidate error:', error);
          }
        });

        // Handle chat messages
        socketRef.current.on('chat_message', (data) => {
          setMessages(prev => [...prev, { from: 'them', text: data.message }]);
          if (!chatOpen) {
            setUnreadMessages(prev => prev + 1);
          }
        });

        socketRef.current.on('call_ready', async (data) => {
          if (data?.from_id !== matchedUser.user_id || data?.call_id !== callId) {
            return;
          }
          remoteReadyRef.current = true;
          setCallStatus('Peer ready. Negotiating video...');
          try {
            await sendOfferIfReady();
          } catch (error) {
            console.error('Offer start error:', error);
            setCallError(getErrorMessage(error, 'Could not start call signaling.'));
          }
        });

        socketRef.current.on('error', (data) => {
          setCallError(data?.detail || 'A realtime error interrupted the call.');
        });

        // Handle call ended
        socketRef.current.on('call_ended', (data) => {
          if (data?.from_id !== matchedUser.user_id || data?.call_id !== callId) {
            return;
          }
          handleEndCall(false);
        });

        socketRef.current.emit('call_ready', {
          target_id: matchedUser.user_id,
          call_id: callId,
        });

      } catch (err) {
        console.error('Call setup error:', err);
        if (isMounted) {
          setCallError(getErrorMessage(err, 'Could not start the video call. Camera, microphone, or network setup is blocking it.'));
        }
      }
    };

    setupCall();

    return () => {
      isMounted = false;
      pendingIceCandidatesRef.current = [];
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach(track => remoteStreamRef.current.removeTrack(track));
        remoteStreamRef.current = null;
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [user, matchedUser, callId, isInitiator]);

  const toggleMute = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsVideoOff(!isVideoOff);
    }
  };

  const sendMessage = () => {
    if (!newMessage.trim()) return;

    setMessages(prev => [...prev, { from: 'me', text: newMessage }]);

    if (socketRef.current) {
      socketRef.current.emit('chat_message', {
        message: newMessage,
        target_id: matchedUser.user_id,
      });
    }

    setNewMessage('');
  };

  const openChatPanel = () => {
    setChatOpen(true);
    setUnreadMessages(0);
  };

  const toggleChatPanel = () => {
    if (typeof window !== 'undefined' && window.innerWidth >= 1280) {
      setChatOpen(true);
      setUnreadMessages(0);
      return;
    }
    setChatOpen((previous) => !previous);
    setUnreadMessages(0);
  };

  const addFriend = async () => {
    try {
      await axios.post('/api/friends/add', { friend_user_id: matchedUser.user_id });
      setActionFeedback('Friend added.');
    } catch (err) {
      console.error('Add friend error:', err);
      setCallError(getErrorMessage(err, 'Could not add this user as a friend.'));
    }
  };

  const blockMatchedUser = async () => {
    setActionLoading('block');
    setCallError('');
    try {
      await axios.post('/api/safety/block', {
        target_user_id: matchedUser.user_id,
        reason: `Blocked during call ${callId}`,
      });
      setActionFeedback('User blocked. The call will end now.');
      handleEndCall();
    } catch (error) {
      setCallError(getErrorMessage(error, 'Could not block this user right now.'));
    } finally {
      setActionLoading('');
    }
  };

  const submitReport = async () => {
    setActionLoading('report');
    setCallError('');
    try {
      await axios.post('/api/safety/report', {
        reported_user_id: matchedUser.user_id,
        reason: reportReason,
        details: reportDetails.trim(),
        call_id: callId,
        auto_block: true,
      });
      setActionFeedback('Report submitted. The user has been blocked from your account.');
      setReportOpen(false);
      handleEndCall();
    } catch (error) {
      setCallError(getErrorMessage(error, 'Could not submit the report.'));
    } finally {
      setActionLoading('');
    }
  };

  const modeColors = {
    same_college: 'bg-accent-mint',
    same_wifi: 'bg-accent-yellow',
    cross_college: 'bg-accent-lilac',
    friend: 'bg-primary/40'
  };

  const modeLabels = {
    same_college: 'Same College',
    same_wifi: 'Same Network',
    cross_college: 'Cross College',
    friend: 'Friend Call'
  };
  const remoteInitial = matchedUser.name?.trim()?.charAt(0)?.toUpperCase() || '?';
  const callControlButtonClass = 'btn-brutal flex min-h-[56px] w-full items-center justify-center px-3 py-3 sm:min-h-[60px]';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="relative grid min-h-[calc(100vh-200px)] gap-4 pb-24 xl:grid-cols-[minmax(0,1fr)_380px] xl:pb-0"
    >
      {callError && (
        <div className="absolute left-4 right-4 top-4 z-30 bg-red-100 border-2 border-red-500 px-4 py-3 text-red-700 shadow-brutal sm:right-auto sm:max-w-md">
          {callError}
        </div>
      )}

      {actionFeedback && (
        <div className="absolute left-4 right-4 top-20 z-30 bg-accent-mint border-2 border-border px-4 py-3 shadow-brutal sm:left-auto sm:right-4 sm:top-4 sm:w-auto">
          {actionFeedback}
        </div>
      )}

      <div className="min-w-0 flex flex-col gap-4">
        <div className={`relative min-h-[56vh] overflow-hidden border-2 border-border shadow-brutal sm:min-h-[68vh] ${modeColors[mode]}`}>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            onLoadedMetadata={() => ensureVideoPlayback(remoteVideoRef.current)}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/70 pointer-events-none" />
          <div className="absolute left-3 right-3 top-3 z-10 flex flex-col gap-3 sm:left-4 sm:right-4 sm:top-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex max-w-full items-center gap-3 rounded-[24px] border-2 border-white/30 bg-surface/82 px-4 py-3 text-text-primary backdrop-blur-xl sm:max-w-[70%]">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary font-heading text-lg font-black text-text-primary">
                {remoteInitial}
              </div>
              <div className="min-w-0">
                <p className="truncate font-heading text-lg font-bold">{matchedUser.name}</p>
                <p className="truncate text-sm text-text-secondary">{matchedUser.college}</p>
              </div>
            </div>
            <div className="self-start rounded-[24px] border border-white/20 bg-black/60 px-4 py-3 text-white backdrop-blur-xl">
              <div className="flex items-center gap-2 text-sm font-bold">
                <Radio className="w-4 h-4" strokeWidth={2.5} />
                {callStatus}
              </div>
            </div>
          </div>

          <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-full border-2 border-border bg-surface/85 px-3 py-2 backdrop-blur-xl sm:bottom-4 sm:left-4">
            <span className="h-2.5 w-2.5 rounded-full bg-secondary" />
            <span className="text-xs font-bold uppercase tracking-[0.24em]">{modeLabels[mode]}</span>
          </div>

          {!remoteVideoReady && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
              <div className="max-w-sm border-2 border-border bg-surface/88 px-6 py-5 text-center shadow-brutal">
                <p className="font-heading text-xl font-bold mb-2">Getting {matchedUser.name}&apos;s video ready</p>
                <p className="text-sm text-text-secondary">{callStatus}</p>
              </div>
            </div>
          )}

          <div className="absolute bottom-3 right-3 z-10 w-28 overflow-hidden rounded-[28px] border-2 border-border bg-text-primary shadow-brutal sm:bottom-4 sm:right-4 sm:w-36 lg:w-52">
            <div className="relative aspect-video">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 bg-black/55 px-3 py-2 text-sm font-bold text-white backdrop-blur-md">
                You
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="border-2 border-border bg-gradient-to-r from-surface/90 via-white/75 to-accent-lilac/35 p-5 shadow-brutal backdrop-blur-xl">
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.24em] text-text-secondary">Conversation Momentum</p>
              <h3 className="font-heading text-2xl font-bold">Keep it flowing without dead air.</h3>
              <p className="mt-2 max-w-2xl text-sm text-text-secondary">
                Use the prompts, keep chat open, and start talking before the video fully stabilizes.
              </p>
            </div>
            {iceBreakers.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-3">
                {iceBreakers.slice(0, 4).map((ib, i) => (
                  <button
                    key={i}
                    onClick={() => setNewMessage(ib)}
                    className="rounded-full border-2 border-border bg-accent-lilac/80 px-4 py-2 text-left text-sm font-medium transition-all hover:-translate-y-0.5 hover:shadow-brutal"
                  >
                    {ib}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-4 gap-3 rounded-none border-2 border-border bg-surface/84 px-3 py-3 shadow-brutal backdrop-blur-xl sm:grid-cols-7 sm:px-4 sm:py-4 xl:flex xl:flex-wrap xl:items-center xl:justify-center">
            <button
              data-testid="toggle-mute-btn"
              onClick={toggleMute}
              className={`${callControlButtonClass} ${isMuted ? 'bg-red-500 text-white' : 'bg-surface'}`}
              aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {isMuted ? <MicOff strokeWidth={2.5} /> : <Mic strokeWidth={2.5} />}
            </button>

            <button
              data-testid="toggle-video-btn"
              onClick={toggleVideo}
              className={`${callControlButtonClass} ${isVideoOff ? 'bg-red-500 text-white' : 'bg-surface'}`}
              aria-label={isVideoOff ? 'Turn camera on' : 'Turn camera off'}
              title={isVideoOff ? 'Turn camera on' : 'Turn camera off'}
            >
              {isVideoOff ? <VideoOff strokeWidth={2.5} /> : <Video strokeWidth={2.5} />}
            </button>

            <button
              data-testid="chat-btn"
              onClick={toggleChatPanel}
              className={`${callControlButtonClass} relative ${chatOpen ? 'bg-secondary text-white' : 'bg-surface'}`}
              aria-label={chatOpen ? 'Close chat' : 'Open chat'}
              title={chatOpen ? 'Close chat' : 'Open chat'}
            >
              <span className="flex items-center gap-2">
                <MessageSquare strokeWidth={2.5} />
                <span className="hidden xl:inline">Chat</span>
                {unreadMessages > 0 && (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-xs text-text-primary">
                    {unreadMessages}
                  </span>
                )}
              </span>
            </button>

            <button
              data-testid="add-friend-btn"
              onClick={addFriend}
              className={`${callControlButtonClass} bg-accent-mint`}
              aria-label="Add friend"
              title="Add friend"
            >
              <UserPlus strokeWidth={2.5} />
            </button>

            <button
              onClick={() => setReportOpen(true)}
              className={`${callControlButtonClass} bg-accent-yellow`}
              title="Report user"
              aria-label="Report user"
            >
              <Flag strokeWidth={2.5} />
            </button>

            <button
              onClick={blockMatchedUser}
              disabled={actionLoading === 'block'}
              className={`${callControlButtonClass} bg-red-100 text-red-700`}
              title="Block user"
              aria-label="Block user"
            >
              <Ban strokeWidth={2.5} />
            </button>

            <button
              data-testid="end-call-btn"
              onClick={handleEndCall}
              className={`${callControlButtonClass} bg-red-500 text-white`}
              aria-label="End call"
              title="End call"
            >
              <PhoneOff strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>

      {!chatOpen && (
        <button
          onClick={openChatPanel}
          className="fixed inset-x-4 bottom-4 z-30 border-2 border-border bg-surface/85 px-4 py-3 shadow-brutal backdrop-blur-2xl sm:inset-x-auto sm:right-6 sm:bottom-6 xl:hidden"
        >
          <span className="flex items-center gap-2 font-bold">
            <Bell className="w-4 h-4" strokeWidth={2.5} />
            Open Chat
            {unreadMessages > 0 && (
              <span className="min-w-[24px] rounded-full bg-primary px-2 py-0.5 text-xs text-text-primary">
                {unreadMessages}
              </span>
            )}
          </span>
        </button>
      )}

      <motion.aside
        initial={{ x: 24, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        className={`${chatOpen ? 'fixed inset-x-3 top-16 bottom-4 z-20 flex sm:inset-x-4 sm:top-20 sm:bottom-6' : 'hidden'} xl:static xl:inset-auto xl:z-auto xl:flex xl:min-h-0 xl:h-auto flex-col overflow-hidden border-2 border-border bg-gradient-to-b from-surface/88 via-white/76 to-accent-lilac/38 shadow-brutal backdrop-blur-2xl`}
      >
          <div className="border-b-2 border-border px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.24em] text-text-secondary">In-Call Chat</p>
                <h3 className="mt-1 font-heading text-xl font-bold sm:text-2xl">Say something before it gets awkward.</h3>
                <p className="mt-2 text-sm text-text-secondary">
                  Chat stays obvious here while the call connects, stabilizes, and flows.
                </p>
              </div>
              <button onClick={() => setChatOpen(false)} className="btn-brutal bg-surface !min-w-[52px] !px-3 !py-3 xl:hidden" aria-label="Close chat">
                <X strokeWidth={2.5} />
              </button>
            </div>
          </div>

          <div className="border-b-2 border-border px-5 py-4">
            <div className="flex flex-wrap gap-2">
              {iceBreakers.slice(0, 4).map((ib, index) => (
                <button
                  key={index}
                  onClick={() => setNewMessage(ib)}
                  className="rounded-full border-2 border-border bg-accent-yellow/70 px-3 py-2 text-left text-sm transition-all hover:-translate-y-0.5 hover:shadow-brutal"
                >
                  {ib}
                </button>
              ))}
              {iceBreakers.length === 0 && (
                <p className="text-sm text-text-secondary">Ice breakers will show up here when ready.</p>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <div className="space-y-3">
              {messages.length === 0 && (
                <div className="rounded-[28px] border-2 border-dashed border-border bg-white/45 px-5 py-6 text-center">
                  <Sparkles className="mx-auto mb-3 h-6 w-6" strokeWidth={2.5} />
                  <p className="font-heading text-lg font-bold">Break the silence.</p>
                  <p className="mt-1 text-sm text-text-secondary">Your messages will land here instantly while the call warms up.</p>
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`max-w-[84%] rounded-[24px] border-2 border-border px-4 py-3 shadow-sm ${
                    msg.from === 'me'
                      ? 'ml-auto bg-primary/92 text-text-primary'
                      : 'mr-auto bg-white/68 backdrop-blur-md'
                  }`}
                >
                  {msg.text}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t-2 border-border bg-surface/80 px-5 py-4 backdrop-blur-xl">
            <div className="flex items-end gap-3">
              <input
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Type a message..."
                className="input-brutal flex-1 !rounded-[22px] !p-3"
              />
              <button onClick={sendMessage} className="btn-primary !min-w-[56px] !rounded-[22px] !px-4 !py-3" aria-label="Send message">
                <Send strokeWidth={2.5} className="w-5 h-5" />
              </button>
            </div>
          </div>
      </motion.aside>

      {reportOpen && (
        <div className="fixed inset-x-4 bottom-4 z-30 card-brutal bg-surface md:inset-x-auto md:right-4 md:bottom-24 md:w-[24rem]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-heading text-lg font-bold">Report User</h3>
            <button onClick={() => setReportOpen(false)} className="btn-brutal bg-surface !min-w-[48px] !px-3 !py-3" aria-label="Close report dialog">
              <X strokeWidth={2.5} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-4">
            {reportReasonOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => setReportReason(option.id)}
                className={`p-3 border-2 border-border text-sm font-bold text-left ${
                  reportReason === option.id ? 'bg-primary' : 'bg-background'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <textarea
            value={reportDetails}
            onChange={(event) => setReportDetails(event.target.value)}
            className="input-brutal min-h-[110px] mb-4"
            placeholder="Add context for moderation review."
          />

          <div className="flex gap-3">
            <button
              onClick={submitReport}
              disabled={actionLoading === 'report'}
              className="btn-primary flex-1"
            >
              {actionLoading === 'report' ? 'Submitting...' : 'Submit Report'}
            </button>
            <button
              onClick={() => setReportOpen(false)}
              className="btn-brutal bg-surface"
            >
              Cancel
            </button>
          </div>

          <p className="mt-3 text-sm text-text-secondary">
            Reports auto-block this user from future matches and chats on your account.
          </p>
        </div>
      )}
    </motion.div>
  );
};

// Friends Tab
const FriendsTab = ({ onStartFriendCall, realtimeReady, outgoingFriendCall }) => {
  const [friends, setFriends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [chatFriend, setChatFriend] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState('');

  const loadFriendMessages = useCallback(async (friendId, preserveScroll = false) => {
    setChatLoading(!preserveScroll);
    setChatError('');
    try {
      const { data } = await axios.get(`/api/friends/messages/${friendId}`);
      setChatMessages(data.messages || []);
    } catch (error) {
      setChatError(getErrorMessage(error, 'Could not load this friend chat.'));
    } finally {
      setChatLoading(false);
    }
  }, []);

  useEffect(() => {
    const fetchFriends = async () => {
      try {
        const { data } = await axios.get('/api/friends');
        setFriends(data.friends || []);
      } catch (e) {
        console.error('Error fetching friends:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchFriends();
  }, []);

  useEffect(() => {
    if (!chatFriend) {
      return undefined;
    }

    loadFriendMessages(chatFriend.user_id);
    const interval = setInterval(() => {
      loadFriendMessages(chatFriend.user_id, true);
    }, 4000);

    return () => clearInterval(interval);
  }, [chatFriend, loadFriendMessages]);

  const openFriendChat = (friend) => {
    setChatFriend(friend);
    setChatDraft('');
  };

  const sendFriendMessage = async () => {
    if (!chatFriend || !chatDraft.trim()) {
      return;
    }

    setChatSending(true);
    setChatError('');
    try {
      await axios.post('/api/friends/messages', {
        receiver_id: chatFriend.user_id,
        content: chatDraft.trim(),
      });
      setChatDraft('');
      await loadFriendMessages(chatFriend.user_id, true);
    } catch (error) {
      setChatError(getErrorMessage(error, 'Could not send your message.'));
    } finally {
      setChatSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <h2 className="font-heading text-3xl font-black mb-6">Your Friends</h2>

      {friends.length === 0 ? (
        <div className="card-brutal text-center py-12">
          <Users className="w-16 h-16 mx-auto mb-4 text-text-secondary" strokeWidth={2} />
          <h3 className="font-heading text-xl font-bold mb-2">No friends yet</h3>
          <p className="text-text-secondary">Start connecting to add friends!</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {friends.map((friend) => (
            <div key={friend.user_id} className="card-brutal">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-primary border-2 border-border flex items-center justify-center">
                  <span className="font-heading font-bold text-xl">
                    {friend.name?.[0]?.toUpperCase()}
                  </span>
                </div>
                <div>
                  <h3 className="font-bold">{friend.name}</h3>
                  <p className="text-sm text-text-secondary">{friend.college}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {friend.interests?.slice(0, 3).map((interest) => (
                  <span key={interest} className="px-2 py-1 bg-accent-lilac border border-border text-xs font-bold">
                    {interest}
                  </span>
                ))}
              </div>

              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <button
                  onClick={() => onStartFriendCall(friend)}
                  disabled={!realtimeReady}
                  className="btn-primary w-full flex-1 justify-center !py-2 text-sm disabled:opacity-60"
                >
                  <Video className="w-4 h-4 inline mr-1" strokeWidth={2.5} /> Call
                </button>
                <button
                  onClick={() => openFriendChat(friend)}
                  className="btn-brutal bg-surface w-full justify-center !py-2 text-sm"
                >
                  <MessageSquare className="w-4 h-4 inline mr-1" strokeWidth={2.5} /> Chat
                </button>
              </div>

              {outgoingFriendCall?.friend?.user_id === friend.user_id && (
                <p className="mt-3 text-sm font-bold text-text-secondary">
                  {outgoingFriendCall.status === 'ringing' ? 'Ringing...' : 'Starting call...'}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {!realtimeReady && (
        <div className="mt-6 border-2 border-border bg-accent-yellow px-4 py-3 shadow-brutal">
          Friend calling is still connecting to realtime services. Wait a few seconds and try again.
        </div>
      )}

      {chatFriend && (
        <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm p-4 md:p-8">
          <div className="mx-auto flex h-full max-w-2xl flex-col border-2 border-border bg-surface shadow-brutal">
            <div className="flex items-center justify-between border-b-2 border-border px-5 py-4">
              <div>
                <h3 className="font-heading text-2xl font-black">{chatFriend.name}</h3>
                <p className="text-sm text-text-secondary">{chatFriend.college}</p>
              </div>
              <button onClick={() => setChatFriend(null)} className="btn-brutal bg-surface !p-3">
                <X strokeWidth={2.5} />
              </button>
            </div>

            {chatError && (
              <div className="m-4 border-2 border-red-500 bg-red-100 px-4 py-3 text-red-700">
                {chatError}
              </div>
            )}

            <div className="flex-1 overflow-y-auto bg-background/60 px-5 py-5">
              {chatLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
              ) : chatMessages.length === 0 ? (
                <div className="border-2 border-dashed border-border bg-white/60 px-6 py-10 text-center">
                  <p className="font-bold">No messages yet</p>
                  <p className="text-sm text-text-secondary">Start the conversation with your friend here.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {chatMessages.map((message) => {
                    const isMine = message.sender_id !== chatFriend.user_id;
                    return (
                      <div
                        key={message.message_id}
                        className={`max-w-[80%] border-2 border-border px-4 py-3 shadow-sm ${
                          isMine ? 'ml-auto bg-primary/90' : 'bg-white/75'
                        }`}
                      >
                        <p>{message.content}</p>
                        <p className="mt-2 text-xs text-text-secondary">
                          {new Date(message.created_at).toLocaleString()}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="border-t-2 border-border bg-surface/90 px-5 py-4">
              <div className="flex gap-3">
                <textarea
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendFriendMessage();
                    }
                  }}
                  className="input-brutal min-h-[88px] flex-1"
                  placeholder={`Message ${chatFriend.name}...`}
                />
                <button
                  onClick={sendFriendMessage}
                  disabled={chatSending}
                  className="btn-primary self-end"
                >
                  {chatSending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};

// History Tab
const HistoryTab = () => {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const { data } = await axios.get('/api/calls/history');
        setHistory(data.calls || []);
      } catch (e) {
        console.error('Error fetching history:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();
  }, []);

  const modeLabels = {
    same_college: { label: 'Same College', color: 'bg-accent-mint' },
    same_wifi: { label: 'Same Network', color: 'bg-accent-yellow' },
    cross_college: { label: 'Cross College', color: 'bg-accent-lilac' },
    friend: { label: 'Friend Call', color: 'bg-primary/40' }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <h2 className="font-heading text-3xl font-black mb-6">Call History</h2>

      {history.length === 0 ? (
        <div className="card-brutal text-center py-12">
          <History className="w-16 h-16 mx-auto mb-4 text-text-secondary" strokeWidth={2} />
          <h3 className="font-heading text-xl font-bold mb-2">No calls yet</h3>
          <p className="text-text-secondary">Your call history will appear here</p>
        </div>
      ) : (
        <div className="space-y-4">
          {history.map((call) => (
            <div key={call.call_id} className="card-brutal flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-12 h-12 ${modeLabels[call.mode]?.color || 'bg-surface'} border-2 border-border flex items-center justify-center`}>
                  <Phone strokeWidth={2.5} />
                </div>
                <div>
                  <h3 className="font-bold">{call.other_user?.name || 'Unknown'}</h3>
                  <p className="text-sm text-text-secondary">
                    {call.other_user?.college} • {modeLabels[call.mode]?.label}
                  </p>
                </div>
              </div>

              <div className="text-right">
                <p className="text-sm text-text-secondary">
                  {new Date(call.created_at).toLocaleDateString()}
                </p>
                {call.duration && (
                  <p className="text-sm font-bold">{Math.round(call.duration / 60)} min</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
};

// Profile Tab
const ProfileTab = () => {
  const { user, logout, checkAuth } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [interests, setInterests] = useState(user?.interests || []);
  const [lookingFor, setLookingFor] = useState(user?.looking_for || []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [loadingBlocks, setLoadingBlocks] = useState(true);
  const [blocksError, setBlocksError] = useState('');
  const [unblockingUserId, setUnblockingUserId] = useState('');

  const interestOptions = ['Coding', 'Design', 'Business', 'Music', 'Sports', 'Art', 'Gaming', 'Reading', 'Travel', 'Fitness'];
  const lookingForOptions = [
    { id: 'study_buddy', label: 'Study Buddy', icon: BookOpen },
    { id: 'networking', label: 'Networking', icon: Users },
    { id: 'cofounder', label: 'Co-founder', icon: Briefcase },
    { id: 'love', label: 'Love', icon: Heart },
  ];

  const toggleInterest = (interest) => {
    setInterests(prev =>
      prev.includes(interest) ? prev.filter(i => i !== interest) : [...prev, interest]
    );
  };

  const toggleLookingFor = (item) => {
    setLookingFor(prev =>
      prev.includes(item) ? prev.filter(i => i !== item) : [...prev, item]
    );
  };

  const loadBlockedUsers = useCallback(async () => {
    setLoadingBlocks(true);
    setBlocksError('');
    try {
      const { data } = await axios.get('/api/safety/blocks');
      setBlockedUsers(data.blocked_users || []);
    } catch (error) {
      setBlocksError(getErrorMessage(error, 'Could not load blocked users.'));
    } finally {
      setLoadingBlocks(false);
    }
  }, []);

  useEffect(() => {
    setName(user?.name || '');
    setBio(user?.bio || '');
    setInterests(user?.interests || []);
    setLookingFor(user?.looking_for || []);
  }, [user]);

  useEffect(() => {
    loadBlockedUsers();
  }, [loadBlockedUsers]);

  const saveProfile = async () => {
    setSaving(true);
    setSaveError('');
    try {
      await axios.put('/api/users/profile', {
        name,
        bio,
        interests,
        looking_for: lookingFor,
      });
      await checkAuth();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error('Save error:', error);
      setSaveError(getErrorMessage(error, 'Could not save your profile.'));
    } finally {
      setSaving(false);
    }
  };

  const unblockUser = async (targetUserId) => {
    setUnblockingUserId(targetUserId);
    setBlocksError('');
    try {
      await axios.delete(`/api/safety/block/${targetUserId}`);
      await loadBlockedUsers();
    } catch (error) {
      setBlocksError(getErrorMessage(error, 'Could not unblock this user.'));
    } finally {
      setUnblockingUserId('');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
    >
      <h2 className="font-heading text-3xl font-black mb-6">Your Profile</h2>

      {saveError && (
        <div className="bg-red-100 border-2 border-red-500 p-4 mb-6 text-red-700">
          {saveError}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card-brutal">
          <h3 className="font-heading text-xl font-bold mb-4">Basic Info</h3>

          <div className="space-y-4">
            <div>
              <label className="text-xs font-bold uppercase tracking-widest mb-2 block">Name</label>
              <input
                data-testid="profile-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-brutal"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-widest mb-2 block">Email</label>
              <input
                type="email"
                value={user?.email}
                disabled
                className="input-brutal bg-gray-100"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-widest mb-2 block">College</label>
              <input
                type="text"
                value={user?.college}
                disabled
                className="input-brutal bg-gray-100"
              />
            </div>

            <div>
              <label className="text-xs font-bold uppercase tracking-widest mb-2 block">Bio</label>
              <textarea
                data-testid="profile-bio-input"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="input-brutal min-h-[100px]"
                placeholder="Tell others about yourself..."
              />
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="card-brutal">
            <h3 className="font-heading text-xl font-bold mb-4">Looking For</h3>
            <div className="grid grid-cols-2 gap-3">
              {lookingForOptions.map((opt) => (
                <button
                  key={opt.id}
                  data-testid={`profile-looking-${opt.id}`}
                  onClick={() => toggleLookingFor(opt.id)}
                  className={`p-4 border-2 border-border flex items-center gap-3 transition-all
                    ${lookingFor.includes(opt.id) ? 'bg-primary shadow-brutal' : 'bg-surface hover:shadow-brutal'}`}
                >
                  <opt.icon strokeWidth={2.5} className="w-5 h-5" />
                  <span className="font-bold text-sm">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card-brutal">
            <h3 className="font-heading text-xl font-bold mb-4">Interests</h3>
            <div className="flex flex-wrap gap-2">
              {interestOptions.map((interest) => (
                <button
                  key={interest}
                  data-testid={`profile-interest-${interest.toLowerCase()}`}
                  onClick={() => toggleInterest(interest)}
                  className={`px-4 py-2 border-2 border-border text-sm font-bold transition-all
                    ${interests.includes(interest) ? 'bg-secondary text-white shadow-brutal' : 'bg-surface'}`}
                >
                  {interest}
                </button>
              ))}
            </div>
          </div>

          <div className="card-brutal">
            <div className="flex items-center gap-3 mb-4">
              <ShieldAlert className="w-6 h-6" strokeWidth={2.5} />
              <h3 className="font-heading text-xl font-bold">Safety</h3>
            </div>

            {blocksError && (
              <div className="bg-red-100 border-2 border-red-500 p-3 mb-4 text-red-700 text-sm">
                {blocksError}
              </div>
            )}

            {loadingBlocks ? (
              <div className="flex justify-center py-6">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : blockedUsers.length === 0 ? (
              <p className="text-text-secondary text-sm">You have not blocked anyone.</p>
            ) : (
              <div className="space-y-3">
                {blockedUsers.map((blockedUser) => (
                  <div key={blockedUser.user_id} className="border-2 border-border p-3 bg-background">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <div>
                        <p className="font-bold">{blockedUser.name}</p>
                        <p className="text-sm text-text-secondary">{blockedUser.college}</p>
                      </div>
                      <button
                        onClick={() => unblockUser(blockedUser.user_id)}
                        disabled={unblockingUserId === blockedUser.user_id}
                        className="btn-brutal bg-surface w-full justify-center !py-2 sm:w-auto"
                      >
                        {unblockingUserId === blockedUser.user_id ? 'Removing...' : 'Unblock'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p className="mt-4 text-sm text-text-secondary">
              Reports auto-block users and stop future matches, chats, and calls from your account.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:gap-4">
        <button
          data-testid="save-profile-btn"
          onClick={saveProfile}
          disabled={saving}
          className="btn-primary w-full justify-center sm:w-auto"
        >
          {saving ? (
            <Loader2 className="animate-spin mr-2" />
          ) : saved ? (
            <Check className="mr-2" strokeWidth={2.5} />
          ) : null}
          {saved ? 'Saved!' : 'Save Changes'}
        </button>

        <button
          data-testid="logout-profile-btn"
          onClick={logout}
          className="btn-brutal bg-red-100 text-red-700 w-full justify-center sm:w-auto"
        >
          <LogOut className="mr-2 inline" strokeWidth={2.5} />
          Logout
        </button>
      </div>
    </motion.div>
  );
};

// App Router
const AppRouter = () => {
  const location = useLocation();

  // Handle OAuth callback synchronously
  if (location.hash?.includes('session_id=')) {
    return <AuthCallback />;
  }

  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

// Main App
function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
