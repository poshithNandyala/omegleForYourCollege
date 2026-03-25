"use client";

import { useEffect, useState, useTransition } from "react";
import {
  collegeDirectory,
  courseCatalog,
  genderOptions,
  genderPreferenceOptions,
  languageOptions,
  queueUsers,
  type CourseType,
  type Gender,
  type GenderPreference,
  type MatchParticipant,
  type QueueUser,
  type VerificationMethod,
} from "@/lib/campus-data";
import {
  buildAnonymousLabel,
  buildMatchKey,
  findCollegeByEmail,
  findMatchAtStage,
  getCourseById,
  relaxationStages,
  type RelaxationStageId,
} from "@/lib/matching";

type Screen = "auth" | "ready" | "matching" | "room" | "ended";
type AuthMode = "signup" | "login";
type ChatMessage = {
  id: string;
  role: "system" | "you" | "partner";
  text: string;
};
type FormState = {
  name: string;
  collegeEmail: string;
  password: string;
  verification: VerificationMethod;
  wifiToken: string;
  course: CourseType;
  semesterOrStage: string;
  gender: Gender;
  language: string;
  startWithVideo: boolean;
  preferences: {
    gender: GenderPreference;
    sameCourse: boolean;
    sameSemester: boolean;
  };
};
type SessionUser = MatchParticipant & {
  collegeName: string;
  verification: VerificationMethod;
  wifiToken: string;
  startWithVideo: boolean;
  anonymousName: string;
};

const initialForm: FormState = {
  name: "",
  collegeEmail: "aarav@iitd.ac.in",
  password: "campus123",
  verification: "email",
  wifiToken: "IITDelhi-WiFi",
  course: "BTECH",
  semesterOrStage: "Semester 4",
  gender: "male",
  language: "English",
  startWithVideo: false,
  preferences: {
    gender: "any",
    sameCourse: true,
    sameSemester: true,
  },
};

function formatNameFromEmail(email: string) {
  const local = email.split("@")[0] ?? "";
  const parts = local
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return "Verified Student";
  }

  return parts
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normaliseWifiToken(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");

  if (!local || !domain) {
    return email;
  }

  if (local.length <= 2) {
    return `${local[0] ?? ""}*@${domain}`;
  }

  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function buildCandidatePool(
  user: MatchParticipant,
  verification: VerificationMethod,
  wifiToken: string,
) {
  const matchKey = buildMatchKey(user);

  return queueUsers.filter((candidate) => {
    if (candidate.id === user.id || buildMatchKey(candidate) !== matchKey) {
      return false;
    }

    if (verification === "wifi") {
      return normaliseWifiToken(candidate.wifiCluster) === normaliseWifiToken(wifiToken);
    }

    return true;
  });
}

export function CampusStudio() {
  const supportedColleges = collegeDirectory.filter((college) => college.id !== "custom");
  const [screen, setScreen] = useState<Screen>("auth");
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [form, setForm] = useState(initialForm);
  const [session, setSession] = useState<SessionUser | null>(null);
  const [match, setMatch] = useState<QueueUser | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [activeRelaxation, setActiveRelaxation] = useState<RelaxationStageId>("exact");
  const [resolvedStage, setResolvedStage] = useState<RelaxationStageId | null>(null);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [partnerVideoEnabled, setPartnerVideoEnabled] = useState(false);
  const [revealedEarly, setRevealedEarly] = useState(false);
  const [revealRequested, setRevealRequested] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const [isPending, startTransition] = useTransition();

  const detectedCollege = findCollegeByEmail(form.collegeEmail);
  const activeCourse = getCourseById(form.course);
  const resolvedName = form.name.trim() || formatNameFromEmail(form.collegeEmail);
  const authValid =
    Boolean(detectedCollege) &&
    form.password.trim().length >= 6 &&
    (authMode === "login" || form.name.trim().length > 1);
  const setupValid =
    Boolean(detectedCollege) &&
    resolvedName.trim().length > 1 &&
    form.semesterOrStage.length > 0 &&
    form.language.length > 0 &&
    (form.verification === "email" || form.wifiToken.trim().length >= 4);

  const previewUser: MatchParticipant | null = detectedCollege
    ? {
        id: "preview-user",
        name: resolvedName,
        email: form.collegeEmail,
        collegeId: detectedCollege.id,
        course: form.course,
        semesterOrStage: form.semesterOrStage,
        gender: form.gender,
        language: form.language,
        preferences: form.preferences,
      }
    : null;
  const previewPool = previewUser
    ? buildCandidatePool(previewUser, form.verification, form.wifiToken)
    : [];

  useEffect(() => {
    if (screen !== "matching" || !session) {
      return;
    }

    let cancelled = false;
    let timerId: number | undefined;
    const candidatePool = buildCandidatePool(
      session,
      session.verification,
      session.wifiToken,
    );

    const runStage = (index: number) => {
      if (cancelled) {
        return;
      }

      const stage = relaxationStages[index];
      setActiveRelaxation(stage.id);
      const candidate = findMatchAtStage(session, candidatePool, stage.id);

      if (candidate) {
        timerId = window.setTimeout(() => {
          if (cancelled) {
            return;
          }

          setMatch(candidate);
          setResolvedStage(stage.id);
          setMessages([
            {
              id: "system-connected",
              role: "system",
              text:
                session.verification === "wifi"
                  ? `Matched on ${session.collegeName} Wi-Fi.`
                  : `Matched through verified ${session.collegeName} email.`,
            },
            {
              id: "partner-intro",
              role: "partner",
              text: candidate.intro,
            },
          ]);
          setVideoEnabled(session.startWithVideo);
          setPartnerVideoEnabled(candidate.videoReady);
          setScreen("room");
        }, 700);
        return;
      }

      if (index === relaxationStages.length - 1) {
        setNoMatch(true);
        return;
      }

      timerId = window.setTimeout(() => runStage(index + 1), 1400);
    };

    runStage(0);

    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [screen, session]);

  const patch = (next: Partial<FormState>) =>
    setForm((current) => ({
      ...current,
      ...next,
    }));

  const updateCourse = (courseId: CourseType) => {
    const nextCourse = getCourseById(courseId);
    patch({
      course: courseId,
      semesterOrStage: nextCourse.stageOptions[0],
    });
  };

  const continueAuth = () => {
    if (!authValid || !detectedCollege) {
      return;
    }

    startTransition(() => {
      setForm((current) => ({
        ...current,
        name: current.name.trim() || formatNameFromEmail(current.collegeEmail),
        wifiToken: current.wifiToken.trim() || detectedCollege.wifiHints[0],
      }));
      setScreen("ready");
    });
  };

  const openMatching = () => {
    if (!setupValid || !detectedCollege) {
      return;
    }

    const nextSession: SessionUser = {
      id: "current-user",
      name: resolvedName,
      email: form.collegeEmail,
      collegeId: detectedCollege.id,
      collegeName: detectedCollege.name,
      course: form.course,
      semesterOrStage: form.semesterOrStage,
      gender: form.gender,
      language: form.language,
      preferences: form.preferences,
      verification: form.verification,
      wifiToken: form.verification === "wifi" ? form.wifiToken.trim() : "",
      startWithVideo: form.startWithVideo,
      anonymousName: buildAnonymousLabel(form.course, form.semesterOrStage),
    };

    startTransition(() => {
      setSession(nextSession);
      setMatch(null);
      setMessages([]);
      setDraft("");
      setNoMatch(false);
      setRevealedEarly(false);
      setRevealRequested(false);
      setResolvedStage(null);
      setActiveRelaxation("exact");
      setScreen("matching");
    });
  };

  const resetAll = () => {
    startTransition(() => {
      setScreen("auth");
      setAuthMode("signup");
      setForm(initialForm);
      setSession(null);
      setMatch(null);
      setMessages([]);
      setDraft("");
      setResolvedStage(null);
      setVideoEnabled(false);
      setPartnerVideoEnabled(false);
      setRevealedEarly(false);
      setRevealRequested(false);
      setNoMatch(false);
    });
  };

  const requestReveal = () => {
    if (!match || revealRequested || revealedEarly) {
      return;
    }

    setRevealRequested(true);
    setMessages((current) => [
      ...current,
      {
        id: `system-reveal-request-${Date.now()}`,
        role: "system",
        text: "Reveal request sent. Waiting for partner approval.",
      },
    ]);

    window.setTimeout(() => {
      setRevealedEarly(true);
      setMessages((current) => [
        ...current,
        {
          id: `system-reveal-ok-${Date.now()}`,
          role: "system",
          text: "Mutual reveal accepted. Verified identities are now visible.",
        },
      ]);
    }, 1100);
  };

  const sendMessage = () => {
    if (!draft.trim() || !match) {
      return;
    }

    const text = draft.trim();
    const replyIndex = messages.filter((message) => message.role === "you").length;
    const reply = match.responsePool[replyIndex % match.responsePool.length];

    setMessages((current) => [
      ...current,
      {
        id: `you-${Date.now()}`,
        role: "you",
        text,
      },
    ]);
    setDraft("");

    window.setTimeout(() => {
      setMessages((current) => [
        ...current,
        {
          id: `partner-${Date.now()}`,
          role: "partner",
          text: reply,
        },
      ]);
    }, 800);
  };

  const identityVisible = screen === "ended" || revealedEarly;
  const stageLabel =
    relaxationStages.find((stage) => stage.id === resolvedStage)?.title ?? "Exact filters";

  if (screen === "auth") {
    return (
      <main className="min-h-screen overflow-hidden">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-8 sm:py-8 lg:px-12">
          <header className="mb-8 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.28em] text-violet-200 uppercase">
                Omegle For Your College
              </p>
              <p className="mt-2 text-sm text-slate-400">
                College-only random chat with email-first access.
              </p>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white">
              {supportedColleges.length} campuses
            </div>
          </header>

          <div className="grid flex-1 items-center gap-8 lg:grid-cols-[1fr_470px]">
            <section className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-violet-400/25 bg-violet-400/10 px-4 py-2 text-sm font-semibold text-violet-100">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                Login first, then match by email or campus Wi-Fi
              </div>
              <h1 className="display-font mt-8 text-4xl font-extrabold leading-[1.02] text-white sm:text-5xl lg:text-7xl">
                Clear campus-only chat.
                <br />
                No noisy landing.
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
                Verify through your college mail. After that, choose a normal
                campus match or lock the room to people on the same college
                Wi-Fi.
              </p>
              <div className="mt-10 grid gap-4 sm:grid-cols-3">
                {[
                  "College domain locked",
                  "Course and semester filters",
                  "Anonymous first, reveal later",
                ].map((item) => (
                  <div
                    key={item}
                    className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5 text-sm font-semibold text-white"
                  >
                    {item}
                  </div>
                ))}
              </div>
            </section>

            <section className="glass-panel rounded-[2rem] p-6 sm:p-8">
              <div className="mb-6 flex gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-1.5">
                {(["signup", "login"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setAuthMode(mode)}
                    className={`flex-1 rounded-[1rem] px-4 py-3 text-sm font-semibold capitalize transition ${
                      authMode === mode
                        ? "bg-violet-600 text-white"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>

              <div className="space-y-4">
                {authMode === "signup" ? (
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-white">
                      Full name
                    </label>
                    <input
                      value={form.name}
                      onChange={(event) => patch({ name: event.target.value })}
                      className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                      placeholder="Aarav Sharma"
                    />
                  </div>
                ) : null}

                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    College email
                  </label>
                  <input
                    value={form.collegeEmail}
                    onChange={(event) => patch({ collegeEmail: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                    placeholder="you@iitd.ac.in"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p
                      className={`text-sm ${
                        detectedCollege ? "text-emerald-300" : "text-rose-300"
                      }`}
                    >
                      {detectedCollege
                        ? `Detected: ${detectedCollege.name}`
                        : "Use a supported college domain from the old registry."}
                    </p>
                    {detectedCollege ? (
                      <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-100">
                        Verified domain
                      </span>
                    ) : null}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    Password
                  </label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(event) => patch({ password: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                    placeholder="Minimum 6 characters"
                  />
                </div>

                <button
                  type="button"
                  onClick={continueAuth}
                  disabled={!authValid || isPending}
                  className="w-full rounded-2xl bg-violet-600 px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-slate-700"
                >
                  {authMode === "signup"
                    ? "Create campus account"
                    : "Continue to matching"}
                </button>
              </div>

              <div className="mt-6 rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
                <p className="text-xs font-semibold tracking-[0.2em] text-violet-200 uppercase">
                  Supported domains
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {["iitd.ac.in", "iiitd.ac.in", "nitk.edu.in", "bits-pilani.ac.in"].map(
                    (domain) => (
                      <span
                        key={domain}
                        className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-white"
                      >
                        {domain}
                      </span>
                    ),
                  )}
                </div>
                <p className="mt-4 text-sm leading-7 text-slate-300">
                  The rest of the old college registry is active too.
                </p>
              </div>
            </section>
          </div>
        </div>
      </main>
    );
  }

  if (screen === "ready" && detectedCollege) {
    return (
      <main className="min-h-screen overflow-hidden">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-8 sm:py-8 lg:px-12">
          <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.28em] text-violet-200 uppercase">
                Match Setup
              </p>
              <h1 className="display-font mt-2 text-3xl font-bold text-white sm:text-4xl">
                {detectedCollege.name}
              </h1>
            </div>
            <div className="flex flex-wrap gap-3">
              <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white">
                {maskEmail(form.collegeEmail)}
              </span>
              <button
                type="button"
                onClick={() => setScreen("auth")}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Change login
              </button>
            </div>
          </header>

          <div className="grid flex-1 gap-6 xl:grid-cols-[0.82fr_1.18fr]">
            <section className="section-frame rounded-[2rem] p-6 sm:p-8">
              <div className="rounded-[1.8rem] border border-violet-400/20 bg-violet-400/10 p-5">
                <p className="text-xs font-semibold tracking-[0.22em] text-violet-100 uppercase">
                  Verified account
                </p>
                <p className="display-font mt-3 text-3xl font-semibold text-white">
                  {resolvedName}
                </p>
                <p className="mt-2 text-sm text-slate-300">{form.collegeEmail}</p>
              </div>

              <div className="mt-5 grid gap-4">
                <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-xs font-semibold tracking-[0.22em] text-violet-200 uppercase">
                    Queue preview
                  </p>
                  <p className="mt-3 text-2xl font-semibold text-white">
                    {detectedCollege.name} + {form.language}
                  </p>
                  <p className="mt-2 text-sm leading-7 text-slate-400">
                    {previewPool.length} students available in this lane right now.
                  </p>
                </div>

                <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-xs font-semibold tracking-[0.22em] text-violet-200 uppercase">
                    Anonymous name
                  </p>
                  <p className="mt-3 text-xl font-semibold text-white">
                    {buildAnonymousLabel(form.course, form.semesterOrStage)}
                  </p>
                  <p className="mt-2 text-sm leading-7 text-slate-400">
                    Real name stays hidden until mutual reveal or room end.
                  </p>
                </div>

                <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-xs font-semibold tracking-[0.22em] text-violet-200 uppercase">
                    Wi-Fi lane
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {detectedCollege.wifiHints.map((hint) => (
                      <button
                        key={hint}
                        type="button"
                        onClick={() => patch({ wifiToken: hint, verification: "wifi" })}
                        className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-white transition hover:border-violet-400/30"
                      >
                        {hint}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="glass-panel rounded-[2rem] p-6 sm:p-8">
              <div className="mb-6 flex flex-wrap gap-3">
                {([
                  { id: "email", label: "Match by email" },
                  { id: "wifi", label: "Match by campus Wi-Fi" },
                ] as const).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() =>
                      patch({
                        verification: option.id,
                        wifiToken:
                          option.id === "wifi"
                            ? form.wifiToken.trim() || detectedCollege.wifiHints[0]
                            : form.wifiToken,
                      })
                    }
                    className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                      form.verification === option.id
                        ? "bg-violet-600 text-white"
                        : "border border-white/10 bg-white/5 text-slate-300 hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    Verified name
                  </label>
                  <input
                    value={form.name}
                    onChange={(event) => patch({ name: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    College email
                  </label>
                  <input
                    value={form.collegeEmail}
                    readOnly
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3.5 text-slate-300 outline-none"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    Course
                  </label>
                  <select
                    value={form.course}
                    onChange={(event) => updateCourse(event.target.value as CourseType)}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                  >
                    {courseCatalog.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    Semester / stage
                  </label>
                  <select
                    value={form.semesterOrStage}
                    onChange={(event) => patch({ semesterOrStage: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                  >
                    {activeCourse.stageOptions.map((stage) => (
                      <option key={stage} value={stage}>
                        {stage}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    Gender
                  </label>
                  <select
                    value={form.gender}
                    onChange={(event) => patch({ gender: event.target.value as Gender })}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                  >
                    {genderOptions.map((gender) => (
                      <option key={gender.id} value={gender.id}>
                        {gender.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-white">
                    Language
                  </label>
                  <select
                    value={form.language}
                    onChange={(event) => patch({ language: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                  >
                    {languageOptions.map((language) => (
                      <option key={language} value={language}>
                        {language}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {form.verification === "wifi" ? (
                <div className="mt-4">
                  <label className="mb-2 block text-sm font-semibold text-white">
                    Campus Wi-Fi token / SSID
                  </label>
                  <input
                    value={form.wifiToken}
                    onChange={(event) => patch({ wifiToken: event.target.value })}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                    placeholder={detectedCollege.wifiHints[0]}
                  />
                </div>
              ) : null}

              <div className="mt-6 rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-white">Gender preference</p>
                  <label className="flex items-center gap-3 rounded-full border border-white/10 bg-slate-950/60 px-4 py-2 text-sm font-semibold text-white">
                    <input
                      type="checkbox"
                      checked={form.startWithVideo}
                      onChange={(event) =>
                        patch({ startWithVideo: event.target.checked })
                      }
                    />
                    Start with video
                  </label>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {genderPreferenceOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() =>
                        patch({
                          preferences: {
                            ...form.preferences,
                            gender: option.id,
                          },
                        })
                      }
                      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                        form.preferences.gender === option.id
                          ? "bg-violet-600 text-white"
                          : "border border-white/10 bg-slate-950/60 text-slate-300"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm font-semibold text-white">
                    <span>Same course</span>
                    <input
                      type="checkbox"
                      checked={form.preferences.sameCourse}
                      onChange={(event) =>
                        patch({
                          preferences: {
                            ...form.preferences,
                            sameCourse: event.target.checked,
                          },
                        })
                      }
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm font-semibold text-white">
                    <span>Same semester</span>
                    <input
                      type="checkbox"
                      checked={form.preferences.sameSemester}
                      onChange={(event) =>
                        patch({
                          preferences: {
                            ...form.preferences,
                            sameSemester: event.target.checked,
                          },
                        })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
                <p className="text-sm leading-7 text-slate-400">
                  {activeCourse.mappingHint}
                </p>
                <button
                  type="button"
                  onClick={openMatching}
                  disabled={!setupValid || isPending}
                  className="rounded-2xl bg-violet-600 px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-slate-700"
                >
                  Start matching
                </button>
              </div>
            </section>
          </div>
        </div>
      </main>
    );
  }

  if (screen === "matching" && session) {
    return (
      <main className="min-h-screen overflow-hidden">
        <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center px-4 py-6 sm:px-8">
          <div className="relative flex h-32 w-32 items-center justify-center">
            <div className="absolute h-32 w-32 rounded-full border border-violet-400/20" />
            <div className="absolute h-24 w-24 rounded-full border border-violet-400/35 animate-pulse" />
            <div className="h-16 w-16 rounded-[1.5rem] bg-gradient-to-br from-violet-500 to-cyan-400 shadow-[0_0_50px_rgba(124,58,237,0.45)]" />
          </div>

          <p className="mt-8 text-xs font-semibold tracking-[0.28em] text-violet-200 uppercase">
            Searching
          </p>
          <h1 className="display-font mt-3 text-center text-3xl font-bold text-white sm:text-5xl">
            {session.verification === "wifi"
              ? "Finding someone on the same campus Wi-Fi"
              : "Finding someone from your college"}
          </h1>
          <p className="mt-4 max-w-2xl text-center text-base leading-8 text-slate-300">
            Queue key: {session.collegeName} + {session.language}
          </p>

          <div className="mt-10 grid w-full gap-3">
            {relaxationStages.map((stage) => (
              <div
                key={stage.id}
                className={`rounded-[1.6rem] border px-5 py-4 transition ${
                  activeRelaxation === stage.id
                    ? "border-violet-400/40 bg-violet-400/12 text-white"
                    : "border-white/10 bg-white/5 text-slate-300"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-semibold">{stage.title}</p>
                  <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-xs font-semibold">
                    {stage.waitLabel}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-7 text-slate-400">
                  {stage.description}
                </p>
              </div>
            ))}
          </div>

          {noMatch ? (
            <div className="mt-8 w-full rounded-[1.8rem] border border-rose-400/20 bg-rose-400/10 p-5">
              <p className="text-lg font-semibold text-rose-100">
                No one free in this lane right now.
              </p>
              <p className="mt-2 text-sm leading-7 text-rose-50/80">
                Try another language, turn off strict filters, or switch from
                Wi-Fi mode to email mode.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setScreen("ready")}
                  className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-950"
                >
                  Back to setup
                </button>
                <button
                  type="button"
                  onClick={resetAll}
                  className="rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-white"
                >
                  Reset app
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    );
  }

  if (screen === "room" && session && match) {
    return (
      <main className="min-h-screen overflow-hidden">
        <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-8 sm:py-8 lg:px-12">
          <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.28em] text-violet-200 uppercase">
                Live Room
              </p>
              <h1 className="display-font mt-2 text-3xl font-bold text-white">
                {session.collegeName}
              </h1>
            </div>
            <div className="flex flex-wrap gap-3">
              <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white">
                {session.verification === "wifi" ? "Wi-Fi lane" : "Email lane"}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white">
                {stageLabel}
              </span>
            </div>
          </header>

          <div className="grid flex-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
            <section className="grid gap-4">
              <div className="relative min-h-[340px] rounded-[2rem] border border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(124,58,237,0.28),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(8,14,28,0.98))] p-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold tracking-[0.2em] text-violet-200 uppercase">
                      Partner
                    </p>
                    <p className="mt-3 text-sm text-slate-400">
                      {partnerVideoEnabled ? "Video on" : "Video off"}
                    </p>
                  </div>
                  <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1 text-xs font-semibold text-white">
                    {match.language}
                  </span>
                </div>
                <div className="absolute inset-x-6 bottom-6">
                  <p className="display-font text-4xl font-semibold text-white sm:text-5xl">
                    {identityVisible ? match.name : match.anonymousName}
                  </p>
                  <p className="mt-3 text-base text-slate-300">
                    {match.course} / {match.semesterOrStage}
                  </p>
                  <p className="mt-4 max-w-xl text-sm leading-7 text-slate-400">
                    {match.intro}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-[0.7fr_1.3fr]">
                <div className="rounded-[1.8rem] border border-white/10 bg-slate-950/70 p-5">
                  <p className="text-xs font-semibold tracking-[0.2em] text-violet-200 uppercase">
                    You
                  </p>
                  <p className="display-font mt-4 text-3xl font-semibold text-white">
                    {identityVisible ? session.name : session.anonymousName}
                  </p>
                  <p className="mt-2 text-sm text-slate-400">
                    {session.course} / {session.semesterOrStage}
                  </p>
                  <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white">
                    {videoEnabled ? "Video on" : "Video off"}
                  </div>
                </div>

                <div className="glass-panel rounded-[1.8rem] p-5">
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => setVideoEnabled((current) => !current)}
                      className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
                    >
                      {videoEnabled ? "Turn video off" : "Turn video on"}
                    </button>
                    <button
                      type="button"
                      onClick={requestReveal}
                      disabled={revealRequested || revealedEarly}
                      className="rounded-2xl border border-violet-400/25 bg-violet-400/12 px-4 py-3 text-sm font-semibold text-violet-100 transition hover:bg-violet-400/18 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {revealedEarly
                        ? "Reveal complete"
                        : revealRequested
                          ? "Waiting for reveal"
                          : "Request mutual reveal"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setScreen("ended")}
                      className="rounded-2xl bg-rose-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
                    >
                      End chat
                    </button>
                  </div>

                  <div className="mt-5 rounded-[1.6rem] border border-white/10 bg-slate-950/55 p-4">
                    <p className="text-sm leading-7 text-slate-300">
                      Forced reveal still happens when the room ends.
                    </p>
                  </div>

                  <div className="mt-5 flex max-h-[20rem] flex-col gap-3 overflow-y-auto pr-1">
                    {messages.map((message) => (
                      <div
                        key={message.id}
                        className={`max-w-[92%] rounded-[1.3rem] px-4 py-3 text-sm leading-7 ${
                          message.role === "you"
                            ? "ml-auto bg-violet-500 text-white"
                            : message.role === "system"
                              ? "mx-auto bg-amber-300/15 text-amber-50"
                              : "bg-slate-950/70 text-white"
                        }`}
                      >
                        {message.text}
                      </div>
                    ))}
                  </div>

                  <div className="mt-5 flex gap-2">
                    <input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          sendMessage();
                        }
                      }}
                      className="min-w-0 flex-1 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3.5 text-white outline-none transition focus:border-violet-400/60"
                      placeholder="Type anonymously"
                    />
                    <button
                      type="button"
                      onClick={sendMessage}
                      className="rounded-2xl bg-violet-600 px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-violet-500"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <aside className="section-frame rounded-[2rem] p-6">
              <p className="text-xs font-semibold tracking-[0.2em] text-violet-200 uppercase">
                Match Summary
              </p>
              <div className="mt-5 grid gap-4">
                <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-sm font-semibold text-white">Queue key</p>
                  <p className="mt-2 text-sm leading-7 text-slate-400">
                    {session.collegeName} + {session.language}
                  </p>
                </div>
                <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-sm font-semibold text-white">Filters used</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-white">
                      Gender: {session.preferences.gender}
                    </span>
                    <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-white">
                      Course: {session.preferences.sameCourse ? "same" : "open"}
                    </span>
                    <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-white">
                      Semester: {session.preferences.sameSemester ? "same" : "open"}
                    </span>
                  </div>
                </div>
                <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-5">
                  <p className="text-sm font-semibold text-white">Identity state</p>
                  <p className="mt-2 text-sm leading-7 text-slate-400">
                    {identityVisible
                      ? "Verified names are visible in the room."
                      : "Still anonymous. Only the campus, course, and language lane are shared."}
                  </p>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </main>
    );
  }

  if (screen === "ended" && session && match) {
    return (
      <main className="min-h-screen overflow-hidden">
        <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center px-4 py-6 sm:px-8">
          <div className="glass-panel w-full rounded-[2rem] p-6 sm:p-8">
            <p className="text-xs font-semibold tracking-[0.28em] text-rose-200 uppercase">
              Room Ended
            </p>
            <h1 className="display-font mt-3 text-3xl font-bold text-white sm:text-5xl">
              Verified reveal complete
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-8 text-slate-300">
              The anonymous room has closed, so both verified identities are now
              visible.
            </p>

            <div className="mt-8 grid gap-4 md:grid-cols-2">
              <div className="rounded-[1.8rem] border border-white/10 bg-white/5 p-5">
                <p className="text-sm font-semibold text-white">You</p>
                <p className="mt-4 text-2xl font-semibold text-white">
                  {session.name}
                </p>
                <p className="mt-2 text-sm text-slate-400">{session.email}</p>
                <p className="mt-2 text-sm text-slate-400">
                  {session.course} / {session.semesterOrStage}
                </p>
              </div>
              <div className="rounded-[1.8rem] border border-white/10 bg-white/5 p-5">
                <p className="text-sm font-semibold text-white">Matched student</p>
                <p className="mt-4 text-2xl font-semibold text-white">
                  {match.name}
                </p>
                <p className="mt-2 text-sm text-slate-400">{match.email}</p>
                <p className="mt-2 text-sm text-slate-400">
                  {match.course} / {match.semesterOrStage}
                </p>
              </div>
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setScreen("ready")}
                className="rounded-2xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-violet-500"
              >
                Start another match
              </button>
              <button
                type="button"
                onClick={resetAll}
                className="rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Back to login
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return null;
}
