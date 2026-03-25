import {
  collegeDirectory,
  courseCatalog,
  educationalSuffixes,
  type CollegeProfile,
  type CourseType,
  type MatchParticipant,
  type QueueUser,
} from "@/lib/campus-data";

export type RelaxationStageId =
  | "exact"
  | "ignore-semester"
  | "ignore-course"
  | "ignore-gender";

export const relaxationStages: Array<{
  id: RelaxationStageId;
  waitLabel: string;
  title: string;
  description: string;
}> = [
  {
    id: "exact",
    waitLabel: "0s",
    title: "Exact filters",
    description: "Same college, same language, and every selected filter stays strict.",
  },
  {
    id: "ignore-semester",
    waitLabel: "10s",
    title: "Semester relaxed",
    description: "Keep same college and language, but stop requiring same semester.",
  },
  {
    id: "ignore-course",
    waitLabel: "20s",
    title: "Course relaxed",
    description: "Keep same college and language, but stop requiring same course too.",
  },
  {
    id: "ignore-gender",
    waitLabel: "30s",
    title: "Gender relaxed",
    description: "Keep same college and language, then ignore gender preference as the last fallback.",
  },
];

export function normaliseDomain(value: string) {
  return value.trim().toLowerCase().replace(/^@/, "");
}

export function getCollegeById(id: string) {
  return collegeDirectory.find((college) => college.id === id) ?? collegeDirectory[0];
}

export function findCollegeByEmail(email: string) {
  const emailDomain = normaliseDomain(email.split("@")[1] ?? "");

  if (!emailDomain) {
    return null;
  }

  return (
    collegeDirectory.find(
      (college) =>
        college.id !== "custom" &&
        college.emailDomains.some(
          (domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`),
        ),
    ) ?? null
  );
}

export function getCourseById(id: CourseType) {
  return courseCatalog.find((course) => course.id === id) ?? courseCatalog[0];
}

export function getAllowedDomains(
  college: CollegeProfile,
  customDomain: string,
) {
  if (college.id === "custom") {
    const domain = normaliseDomain(customDomain);
    return domain ? [domain] : [];
  }

  return college.emailDomains;
}

export function emailMatchesCollege(email: string, allowedDomains: string[]) {
  const emailDomain = normaliseDomain(email.split("@")[1] ?? "");

  return (
    emailDomain.length > 0 &&
    (allowedDomains.some(
      (domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`),
    ) ||
      educationalSuffixes.some((suffix) => emailDomain.endsWith(suffix)))
  );
}

export function buildMatchKey(user: MatchParticipant) {
  return `${user.collegeId}::${user.language.toLowerCase()}`;
}

function ignoresSemester(stage: RelaxationStageId) {
  return stage === "ignore-semester" || stage === "ignore-course" || stage === "ignore-gender";
}

function ignoresCourse(stage: RelaxationStageId) {
  return stage === "ignore-course" || stage === "ignore-gender";
}

function ignoresGender(stage: RelaxationStageId) {
  return stage === "ignore-gender";
}

function meetsPreferences(
  requester: MatchParticipant,
  candidate: MatchParticipant,
  stage: RelaxationStageId,
) {
  if (buildMatchKey(requester) !== buildMatchKey(candidate)) {
    return false;
  }

  if (
    !ignoresGender(stage) &&
    requester.preferences.gender !== "any" &&
    requester.preferences.gender !== candidate.gender
  ) {
    return false;
  }

  if (
    !ignoresCourse(stage) &&
    requester.preferences.sameCourse &&
    requester.course !== candidate.course
  ) {
    return false;
  }

  if (
    !ignoresSemester(stage) &&
    requester.preferences.sameSemester &&
    requester.semesterOrStage !== candidate.semesterOrStage
  ) {
    return false;
  }

  return true;
}

export function isMatch(
  firstUser: MatchParticipant,
  secondUser: MatchParticipant,
  stage: RelaxationStageId,
) {
  return (
    meetsPreferences(firstUser, secondUser, stage) &&
    meetsPreferences(secondUser, firstUser, stage)
  );
}

export function findMatchAtStage(
  currentUser: MatchParticipant,
  queue: QueueUser[],
  stage: RelaxationStageId,
) {
  return (
    queue.find(
      (candidate) =>
        candidate.id !== currentUser.id && isMatch(currentUser, candidate, stage),
    ) ?? null
  );
}

export function findSmartMatch(currentUser: MatchParticipant, queue: QueueUser[]) {
  for (const stage of relaxationStages) {
    const candidate = findMatchAtStage(currentUser, queue, stage.id);

    if (candidate) {
      return { candidate, stage };
    }
  }

  return null;
}

export function buildAnonymousLabel(
  course: CourseType,
  semesterOrStage: string,
) {
  if (semesterOrStage.startsWith("Semester ")) {
    return `Anonymous ${course} S${semesterOrStage.replace("Semester ", "")}`;
  }

  return `Anonymous ${course}`;
}
