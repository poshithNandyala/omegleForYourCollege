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
  ShieldAlert, Ban, Flag
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
const MATCH_POLL_INTERVAL_MS = 3000;
const MATCH_WAIT_TIMEOUT_MS = 60000;
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

const deriveSameNetworkFingerprint = async () => {
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    let detectedSubnet = null;
    const peerConnection = new RTCPeerConnection({ iceServers: [] });

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
    }, 1500);

    peerConnection.createDataChannel('campuslink-network-probe');
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) {
        void finish(detectedSubnet);
        return;
      }

      const subnet = extractPrivateSubnet(event.candidate.candidate || '');
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
      <header className="p-6 flex justify-between items-center max-w-7xl mx-auto">
        <h1 className="font-heading text-2xl font-black">CampusLink</h1>
        <div className="flex gap-4">
          <button
            data-testid="login-nav-btn"
            onClick={() => navigate('/login')}
            className="btn-brutal bg-surface px-4 py-2"
          >
            Login
          </button>
          <button
            data-testid="signup-nav-btn"
            onClick={() => navigate('/signup')}
            className="btn-primary"
          >
            Sign Up
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="font-heading text-5xl lg:text-6xl font-black tracking-tighter mb-6">
              Connect with
              <span className="text-primary"> College </span>
              Students
            </h2>
            <p className="text-text-secondary text-lg mb-8 leading-relaxed">
              Find study buddies, networking partners, co-founders, or maybe even love.
              Connect with students from your college or across India.
            </p>

            <div className="flex flex-wrap gap-4 mb-12">
              <button
                data-testid="get-started-btn"
                onClick={() => navigate('/signup')}
                className="btn-primary text-lg"
              >
                Get Started Free
                <ChevronRight className="inline ml-2" strokeWidth={2.5} />
              </button>
            </div>

            {/* Features */}
            <div className="grid grid-cols-2 gap-4">
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
                  className={`${feat.color} border-2 border-border p-4 shadow-brutal`}
                >
                  <feat.icon className="w-6 h-6 mb-2" strokeWidth={2.5} />
                  <span className="font-bold">{feat.text}</span>
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

  const tabs = [
    { id: 'connect', label: 'Connect', icon: Video },
    { id: 'friends', label: 'Friends', icon: Users },
    { id: 'history', label: 'History', icon: History },
    { id: 'profile', label: 'Profile', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-surface border-b-2 border-border p-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <h1 className="font-heading text-2xl font-black">CampusLink</h1>

          <div className="flex items-center gap-6">
            <div className="hidden md:flex items-center gap-4 text-sm">
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                {stats.online_users} online
              </span>
              <span>{stats.total_calls} calls made</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="font-bold">{user?.name}</span>
              <button
                data-testid="logout-btn"
                onClick={logout}
                className="btn-brutal bg-surface p-2"
              >
                <LogOut className="w-5 h-5" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-8 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              data-testid={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-6 py-3 border-2 border-border font-bold transition-all
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
          {activeTab === 'friends' && <FriendsTab key="friends" />}
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
        <div className="card-brutal text-center py-16">
          <div className="w-24 h-24 mx-auto mb-6 relative">
            <div className="absolute inset-0 border-4 border-primary rounded-full animate-ping opacity-25"></div>
            <div className="absolute inset-0 border-4 border-primary rounded-full animate-pulse"></div>
            <div className="absolute inset-4 bg-primary rounded-full flex items-center justify-center">
              <Users className="w-8 h-8 text-text-primary" strokeWidth={2.5} />
            </div>
          </div>

          <h2 className="font-heading text-2xl font-bold mb-4">Finding your match...</h2>
          <p className="text-text-secondary mb-8">
            Looking for someone in {mode === 'same_college' ? user?.college : mode === 'same_wifi' ? 'your network' : 'other colleges'}
          </p>

          <button
            data-testid="cancel-matching-btn"
            onClick={cancelMatching}
            className="btn-brutal bg-surface"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <h2 className="font-heading text-3xl font-black mb-6">Choose Connection Mode</h2>

          {matchError && (
            <div className="bg-red-100 border-2 border-red-500 p-4 mb-6 text-red-700">
              {matchError}
            </div>
          )}

          <div className="grid md:grid-cols-3 gap-6">
            {connectionModes.map((connMode) => (
              <motion.button
                key={connMode.id}
                data-testid={`connect-${connMode.id}`}
                onClick={() => startMatching(connMode.id)}
                whileHover={{ y: -4 }}
                className={`${connMode.color} border-2 border-border p-8 text-left shadow-brutal hover:shadow-brutal-lg transition-all`}
              >
                <connMode.icon className="w-12 h-12 mb-4" strokeWidth={2.5} />
                <h3 className="font-heading text-xl font-bold mb-2">{connMode.title}</h3>
                <p className="text-text-secondary">{connMode.desc}</p>
              </motion.button>
            ))}
          </div>

          <p className="mt-4 text-sm text-text-secondary">
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
                className="btn-primary"
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
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [iceBreakers, setIceBreakers] = useState([]);
  const [callError, setCallError] = useState('');
  const [actionFeedback, setActionFeedback] = useState('');
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
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

  // WebRTC Setup
  useEffect(() => {
    let isMounted = true;

    const setupCall = async () => {
      try {
        // Get local media
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
        if (!isMounted) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // Setup Socket.IO
        const wsUrl = API_URL.replace('https://', 'wss://').replace('http://', 'ws://');
        socketRef.current = io(wsUrl, {
          transports: ['websocket'],
          withCredentials: true,
          reconnection: true,
          reconnectionAttempts: 8,
          reconnectionDelay: 1000,
        });

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

        const rtcConfig = await getRtcConfig();
        if (rtcConfig.turn_required && !rtcConfig.turn_enabled) {
          throw new Error('TURN relay is required before calls can start in production.');
        }

        peerConnectionRef.current = new RTCPeerConnection({
          iceServers: rtcConfig.ice_servers
        });

        // Add local tracks
        stream.getTracks().forEach(track => {
          peerConnectionRef.current.addTrack(track, stream);
        });

        // Handle remote stream
        peerConnectionRef.current.ontrack = (event) => {
          if (remoteVideoRef.current && event.streams[0]) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        };

        // ICE candidates
        peerConnectionRef.current.onicecandidate = (event) => {
          if (event.candidate) {
            socketRef.current.emit('ice_candidate', {
              candidate: event.candidate,
              target_id: matchedUser.user_id,
            });
          }
        };

        // Handle incoming offer
        socketRef.current.on('offer', async (data) => {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
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
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        });

        // Handle ICE candidates
        socketRef.current.on('ice_candidate', async (data) => {
          try {
            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) { }
        });

        // Handle chat messages
        socketRef.current.on('chat_message', (data) => {
          setMessages(prev => [...prev, { from: 'them', text: data.message }]);
        });

        socketRef.current.on('error', (data) => {
          setCallError(data?.detail || 'A realtime error interrupted the call.');
        });

        // Handle call ended
        socketRef.current.on('call_ended', () => {
          handleEndCall(false);
        });

        if (isInitiator) {
          const offer = await peerConnectionRef.current.createOffer();
          await peerConnectionRef.current.setLocalDescription(offer);

          socketRef.current.emit('offer', {
            offer,
            target_id: matchedUser.user_id,
            call_id: callId
          });
        }

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
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
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
    cross_college: 'bg-accent-lilac'
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="h-[calc(100vh-200px)] flex gap-4"
    >
      {callError && (
        <div className="absolute left-6 top-6 z-10 bg-red-100 border-2 border-red-500 px-4 py-3 text-red-700">
          {callError}
        </div>
      )}

      {actionFeedback && (
        <div className="absolute right-6 top-6 z-10 bg-accent-mint border-2 border-border px-4 py-3">
          {actionFeedback}
        </div>
      )}

      {/* Video Grid */}
      <div className="flex-1 grid grid-cols-2 gap-4">
        {/* Remote Video */}
        <div className={`relative border-2 border-border ${modeColors[mode]} overflow-hidden`}>
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
          <div className="absolute bottom-4 left-4 bg-surface border-2 border-border px-3 py-1">
            <span className="font-bold">{matchedUser.name}</span>
            <span className="text-text-secondary text-sm ml-2">{matchedUser.college}</span>
          </div>
        </div>

        {/* Local Video */}
        <div className="relative border-2 border-border bg-text-primary overflow-hidden">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <div className="absolute bottom-4 left-4 bg-surface border-2 border-border px-3 py-1">
            <span className="font-bold">You</span>
          </div>
        </div>
      </div>

      {/* Chat Sidebar */}
      {chatOpen && (
        <motion.div
          initial={{ x: 300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          className="w-80 card-brutal flex flex-col"
        >
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-heading font-bold">Chat</h3>
            <button onClick={() => setChatOpen(false)}>
              <X strokeWidth={2.5} />
            </button>
          </div>

          {/* Ice Breakers */}
          {iceBreakers.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-bold uppercase tracking-widest mb-2">Ice Breakers</p>
              <div className="space-y-2">
                {iceBreakers.slice(0, 3).map((ib, i) => (
                  <button
                    key={i}
                    onClick={() => setNewMessage(ib)}
                    className="w-full text-left p-2 bg-accent-lilac border-2 border-border text-sm hover:shadow-brutal transition-all"
                  >
                    {ib}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto space-y-2 mb-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`p-3 border-2 border-border ${msg.from === 'me' ? 'bg-primary ml-4' : 'bg-surface mr-4'
                  }`}
              >
                {msg.text}
              </div>
            ))}
          </div>

          {/* Input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
              placeholder="Type a message..."
              className="input-brutal flex-1 !p-3"
            />
            <button onClick={sendMessage} className="btn-primary !p-3">
              <Send strokeWidth={2.5} className="w-5 h-5" />
            </button>
          </div>
        </motion.div>
      )}

      {reportOpen && (
        <div className="absolute right-6 bottom-24 z-10 w-96 card-brutal bg-surface">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-heading text-lg font-bold">Report User</h3>
            <button onClick={() => setReportOpen(false)}>
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

      {/* Controls */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-4">
        <button
          data-testid="toggle-mute-btn"
          onClick={toggleMute}
          className={`btn-brutal p-4 ${isMuted ? 'bg-red-500' : 'bg-surface'}`}
        >
          {isMuted ? <MicOff strokeWidth={2.5} /> : <Mic strokeWidth={2.5} />}
        </button>

        <button
          data-testid="toggle-video-btn"
          onClick={toggleVideo}
          className={`btn-brutal p-4 ${isVideoOff ? 'bg-red-500' : 'bg-surface'}`}
        >
          {isVideoOff ? <VideoOff strokeWidth={2.5} /> : <Video strokeWidth={2.5} />}
        </button>

        <button
          data-testid="chat-btn"
          onClick={() => setChatOpen(!chatOpen)}
          className={`btn-brutal p-4 ${chatOpen ? 'bg-secondary text-white' : 'bg-surface'}`}
        >
          <MessageSquare strokeWidth={2.5} />
        </button>

        <button
          data-testid="add-friend-btn"
          onClick={addFriend}
          className="btn-brutal bg-accent-mint p-4"
        >
          <UserPlus strokeWidth={2.5} />
        </button>

        <button
          onClick={() => setReportOpen(true)}
          className="btn-brutal bg-accent-yellow p-4"
          title="Report user"
        >
          <Flag strokeWidth={2.5} />
        </button>

        <button
          onClick={blockMatchedUser}
          disabled={actionLoading === 'block'}
          className="btn-brutal bg-red-100 text-red-700 p-4"
          title="Block user"
        >
          <Ban strokeWidth={2.5} />
        </button>

        <button
          data-testid="end-call-btn"
          onClick={handleEndCall}
          className="btn-brutal bg-red-500 text-white p-4"
        >
          <PhoneOff strokeWidth={2.5} />
        </button>
      </div>
    </motion.div>
  );
};

// Friends Tab
const FriendsTab = () => {
  const [friends, setFriends] = useState([]);
  const [loading, setLoading] = useState(true);

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

              <div className="mt-4 flex gap-2">
                <button className="btn-primary flex-1 !py-2 text-sm">
                  <Video className="w-4 h-4 inline mr-1" strokeWidth={2.5} /> Call
                </button>
                <button className="btn-brutal bg-surface !py-2 text-sm">
                  <MessageSquare className="w-4 h-4 inline mr-1" strokeWidth={2.5} /> Chat
                </button>
              </div>
            </div>
          ))}
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
    cross_college: { label: 'Cross College', color: 'bg-accent-lilac' }
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
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="font-bold">{blockedUser.name}</p>
                        <p className="text-sm text-text-secondary">{blockedUser.college}</p>
                      </div>
                      <button
                        onClick={() => unblockUser(blockedUser.user_id)}
                        disabled={unblockingUserId === blockedUser.user_id}
                        className="btn-brutal bg-surface !py-2"
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

      <div className="mt-6 flex gap-4">
        <button
          data-testid="save-profile-btn"
          onClick={saveProfile}
          disabled={saving}
          className="btn-primary flex items-center"
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
          className="btn-brutal bg-red-100 text-red-700"
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
