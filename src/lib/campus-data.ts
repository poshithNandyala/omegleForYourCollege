export type VerificationMethod = "email" | "wifi";
export type CourseType =
  | "BTECH"
  | "MTECH"
  | "MBA"
  | "PHD"
  | "BSC"
  | "DIPLOMA";
export type Gender = "male" | "female" | "other";
export type GenderPreference = "any" | Gender;

export type CourseDefinition = {
  id: CourseType;
  label: string;
  structure: "semester" | "research";
  duration: string;
  stageOptions: string[];
  mappingHint: string;
  note: string;
};

export type CollegeProfile = {
  id: string;
  name: string;
  city: string;
  emailDomains: string[];
  wifiHints: string[];
  academicSystemNote: string;
  supportedCourses: CourseType[];
};

export type MatchParticipant = {
  id: string;
  name: string;
  email: string;
  collegeId: string;
  course: CourseType;
  semesterOrStage: string;
  gender: Gender;
  language: string;
  preferences: {
    gender: GenderPreference;
    sameCourse: boolean;
    sameSemester: boolean;
  };
};

export type QueueUser = MatchParticipant & {
  anonymousName: string;
  intro: string;
  videoReady: boolean;
  wifiCluster: string;
  responsePool: string[];
};

export const educationalSuffixes = [".edu", ".ac.in", ".edu.in"];

export const verificationOptions: Array<{
  id: VerificationMethod;
  label: string;
  description: string;
}> = [
  {
    id: "email",
    label: "College Email",
    description:
      "Verify the institution through the campus domain before the user enters the queue.",
  },
  {
    id: "wifi",
    label: "Campus WiFi",
    description:
      "Use a campus token or WiFi gateway handshake for same-network entry, while still storing the college email on profile.",
  },
];

export const languageOptions = [
  "English",
  "Hindi",
  "Telugu",
  "Tamil",
  "Kannada",
  "Malayalam",
  "Marathi",
  "Bengali",
  "Gujarati",
  "Punjabi",
];

export const genderOptions: Array<{ id: Gender; label: string }> = [
  { id: "male", label: "Male" },
  { id: "female", label: "Female" },
  { id: "other", label: "Other" },
];

export const genderPreferenceOptions: Array<{
  id: GenderPreference;
  label: string;
}> = [
  { id: "any", label: "Any" },
  { id: "male", label: "Male" },
  { id: "female", label: "Female" },
  { id: "other", label: "Other" },
];

export const courseCatalog: CourseDefinition[] = [
  {
    id: "BTECH",
    label: "BTech",
    structure: "semester",
    duration: "8 semesters",
    stageOptions: [
      "Semester 1",
      "Semester 2",
      "Semester 3",
      "Semester 4",
      "Semester 5",
      "Semester 6",
      "Semester 7",
      "Semester 8",
    ],
    mappingHint: "If a college says Year 2, standardize that to Semester 3 or 4.",
    note: "Used as the normalized undergraduate engineering track.",
  },
  {
    id: "MTECH",
    label: "MTech",
    structure: "semester",
    duration: "4 semesters",
    stageOptions: ["Semester 1", "Semester 2", "Semester 3", "Semester 4"],
    mappingHint: "If a college says Year 1 or Year 2, convert it into Semesters 1 to 4.",
    note: "Used for postgraduate engineering tracks with shorter program length.",
  },
  {
    id: "MBA",
    label: "MBA",
    structure: "semester",
    duration: "4 semesters",
    stageOptions: ["Semester 1", "Semester 2", "Semester 3", "Semester 4"],
    mappingHint: "Some schools use Year 1 and Year 2, but queue matching should store Semester 1 to 4.",
    note: "Keeps management students inside their own relevant pool.",
  },
  {
    id: "PHD",
    label: "PhD",
    structure: "research",
    duration: "Stage based",
    stageOptions: [
      "Year 1 / Coursework",
      "Year 2 / Proposal",
      "Year 3 / Mid Research",
      "Year 4+ / Writing",
    ],
    mappingHint: "PhD does not need semester numbers. Store a research stage or year band.",
    note: "PhD stays stage based instead of forcing a fake semester system.",
  },
  {
    id: "BSC",
    label: "BSc",
    structure: "semester",
    duration: "6 semesters",
    stageOptions: [
      "Semester 1",
      "Semester 2",
      "Semester 3",
      "Semester 4",
      "Semester 5",
      "Semester 6",
    ],
    mappingHint: "If the college uses yearly labels, convert Year 2 to Semester 3 or 4.",
    note: "Supports science programs where students still need same-college discovery.",
  },
  {
    id: "DIPLOMA",
    label: "Diploma",
    structure: "semester",
    duration: "6 semesters",
    stageOptions: [
      "Semester 1",
      "Semester 2",
      "Semester 3",
      "Semester 4",
      "Semester 5",
      "Semester 6",
    ],
    mappingHint: "Keep diploma programs normalized into a six-semester track.",
    note: "Useful for polytechnic or diploma-campus rollouts.",
  },
];

const commonCourses: CourseType[] = [
  "BTECH",
  "MTECH",
  "MBA",
  "PHD",
  "BSC",
  "DIPLOMA",
];

const registrySeed = [
  ["IIIT Lucknow", "iiitl.ac.in"],
  ["IIIT Hyderabad", "iiit.ac.in"],
  ["IIIT Hyderabad (Students)", "students.iiit.ac.in"],
  ["IIIT Bangalore", "iiitb.ac.in"],
  ["IIIT Delhi", "iiitd.ac.in"],
  ["IIIT Allahabad", "iiita.ac.in"],
  ["IIIT Sri City", "iiits.in"],
  ["IIIT Kottayam", "iiitkottayam.ac.in"],
  ["IIIT Guwahati", "iiitg.ac.in"],
  ["IIIT Kalyani", "iiitkalyani.ac.in"],
  ["IIIT Una", "iiitu.ac.in"],
  ["IIIT Sonepat", "iiitsonepat.ac.in"],
  ["IIIT Nagpur", "iiitn.ac.in"],
  ["IIIT Pune", "iiitp.ac.in"],
  ["IIIT Ranchi", "iiitranchi.ac.in"],
  ["IIIT Vadodara", "iiitvadodara.ac.in"],
  ["IIT Bombay", "iitb.ac.in"],
  ["IIT Delhi", "iitd.ac.in"],
  ["IIT Madras", "iitm.ac.in"],
  ["IIT Kanpur", "iitk.ac.in"],
  ["IIT Kharagpur", "iitkgp.ac.in"],
  ["IIT Roorkee", "iitr.ac.in"],
  ["IIT Guwahati", "iitg.ac.in"],
  ["IIT BHU Varanasi", "iitbhu.ac.in"],
  ["IIT Hyderabad", "iith.ac.in"],
  ["IIT Indore", "iiti.ac.in"],
  ["IIT Mandi", "iitmandi.ac.in"],
  ["IIT Patna", "iitp.ac.in"],
  ["IIT Bhubaneswar", "iitbbs.ac.in"],
  ["IIT Jodhpur", "iitj.ac.in"],
  ["IIT Gandhinagar", "iitgn.ac.in"],
  ["IIT Ropar", "iitrpr.ac.in"],
  ["IIT Tirupati", "iittp.ac.in"],
  ["IIT Dhanbad (ISM)", "iitism.ac.in"],
  ["IIT Palakkad", "iitpkd.ac.in"],
  ["IIT Jammu", "iitjammu.ac.in"],
  ["IIT Dharwad", "iitdh.ac.in"],
  ["IIT Bhilai", "iitbhilai.ac.in"],
  ["IIT Goa", "iitgoa.ac.in"],
  ["NIT Trichy", "nitt.edu"],
  ["NIT Warangal", "nitw.ac.in"],
  ["NIT Surathkal", "nitk.edu.in"],
  ["NIT Calicut", "nitc.ac.in"],
  ["NIT Rourkela", "nitrkl.ac.in"],
  ["NIT Allahabad (MNNIT)", "mnnit.ac.in"],
  ["NIT Jaipur (MNIT)", "mnit.ac.in"],
  ["NIT Kurukshetra", "nitkkr.ac.in"],
  ["NIT Durgapur", "nitdgp.ac.in"],
  ["NIT Silchar", "nits.ac.in"],
  ["NIT Srinagar", "nitsri.ac.in"],
  ["NIT Hamirpur", "nith.ac.in"],
  ["NIT Nagpur (VNIT)", "vnit.ac.in"],
  ["NIT Surat (SVNIT)", "svnit.ac.in"],
  ["NIT Patna", "nitp.ac.in"],
  ["NIT Raipur", "nitrr.ac.in"],
  ["NIT Agartala", "nita.ac.in"],
  ["NIT Meghalaya", "nitm.ac.in"],
  ["NIT Manipur", "nitmanipur.ac.in"],
  ["NIT Mizoram", "nitmz.ac.in"],
  ["NIT Arunachal Pradesh", "nitap.ac.in"],
  ["NIT Sikkim", "nitskm.ac.in"],
  ["NIT Goa", "nitgoa.ac.in"],
  ["NIT Delhi", "nitdelhi.ac.in"],
  ["NIT Uttarakhand", "nituk.ac.in"],
  ["NIT Andhra Pradesh", "nitandhra.ac.in"],
  ["NIT Jamshedpur", "nitjsr.ac.in"],
  ["NIT Jalandhar", "nitj.ac.in"],
  ["BITS Pilani", "pilani.bits-pilani.ac.in"],
  ["BITS Pilani - Hyderabad", "hyderabad.bits-pilani.ac.in"],
  ["BITS Pilani - Goa", "goa.bits-pilani.ac.in"],
  ["VIT Vellore", "vit.ac.in"],
  ["SRM University", "srmist.edu.in"],
  ["Manipal Institute of Technology", "learner.manipal.edu"],
  ["DTU Delhi", "dtu.ac.in"],
  ["NSUT Delhi", "nsut.ac.in"],
  ["Jadavpur University", "jadavpuruniversity.in"],
  ["Anna University", "annauniv.edu"],
  ["IISc Bangalore", "iisc.ac.in"],
  ["ISI Kolkata", "isical.ac.in"],
  ["IIIT Kancheepuram", "iiitdm.ac.in"],
  ["Thapar University", "thapar.edu"],
  ["PEC Chandigarh", "pec.ac.in"],
  ["COEP Pune", "coeptech.ac.in"],
  ["PSG Tech Coimbatore", "psgtech.ac.in"],
  ["Amrita University", "amrita.edu"],
  ["LNMIIT Jaipur", "lnmiit.ac.in"],
  ["DAIICT Gandhinagar", "daiict.ac.in"],
  ["RVCE Bangalore", "rvce.edu.in"],
  ["BMS College of Engineering", "bmsce.ac.in"],
  ["PES University", "pes.edu"],
  ["Christ University", "christuniversity.in"],
  ["Presidency University", "presidencyuniversity.in"],
];

export const collegeDirectory: CollegeProfile[] = registrySeed.map(
  ([name, domain]) => {
    const wifiBase = name.replace(/[^a-zA-Z0-9]+/g, "");

    return {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      city: "India",
      emailDomains:
        name === "IIT Delhi" ? [domain, "admin.iitd.ac.in", "opc.iitd.ac.in"] : [domain],
      wifiHints: [`${wifiBase}-WiFi`, `${wifiBase}-CampusNet`],
      academicSystemNote:
        "The product standardizes campus-specific year or semester naming into one shared queue model.",
      supportedCourses: commonCourses,
    };
  },
).concat([
  {
    id: "custom",
    name: "Add your college",
    city: "Any verified campus",
    emailDomains: [],
    wifiHints: ["Campus gateway token"],
    academicSystemNote:
      "If your campus is not listed, use the custom path and verify through a valid educational email suffix or an admin-approved domain.",
    supportedCourses: commonCourses,
  },
]);

export const queueUsers: QueueUser[] = [
  {
    id: "queue-priya",
    name: "Priya Kapoor",
    email: "priya.kapoor@iitd.ac.in",
    collegeId: "iit-delhi",
    course: "BTECH",
    semesterOrStage: "Semester 5",
    gender: "female",
    language: "English",
    preferences: {
      gender: "any",
      sameCourse: true,
      sameSemester: false,
    },
    anonymousName: "North Block Signal",
    intro: "Better in one-to-one conversations than class banter.",
    videoReady: false,
    wifiCluster: "IITDelhi-WiFi",
    responsePool: [
      "This already feels easier than trying to start a conversation after lecture.",
      "Same college and same language remove half the awkwardness.",
      "The semester filter makes sense, but I am okay when it relaxes a bit too.",
    ],
  },
  {
    id: "queue-meera",
    name: "Meera Nair",
    email: "meera.nair@iitd.ac.in",
    collegeId: "iit-delhi",
    course: "MBA",
    semesterOrStage: "Semester 2",
    gender: "female",
    language: "English",
    preferences: {
      gender: "any",
      sameCourse: false,
      sameSemester: false,
    },
    anonymousName: "Case Study Exit",
    intro: "Escapes networking mode and likes direct, real conversation.",
    videoReady: true,
    wifiCluster: "IITDelhi-CampusNet",
    responsePool: [
      "The useful part is not random chat. It is relevant random chat.",
      "Comfort filters matter more than people admit.",
      "I like that the queue relaxes filters instead of staying dead.",
    ],
  },
  {
    id: "queue-raghav",
    name: "Raghav Sen",
    email: "raghav.sen@iitd.ac.in",
    collegeId: "iit-delhi",
    course: "PHD",
    semesterOrStage: "Year 2 / Proposal",
    gender: "male",
    language: "English",
    preferences: {
      gender: "female",
      sameCourse: false,
      sameSemester: false,
    },
    anonymousName: "Proposal Draft",
    intro: "Lives in the lab, talks better here than in the department hallway.",
    videoReady: false,
    wifiCluster: "IITDelhi-WiFi",
    responsePool: [
      "A stage-based filter is the right way to handle PhD.",
      "Year and research stage work much better than fake semester labels here.",
      "The academic structure needs to be standardized or the queue gets messy fast.",
    ],
  },
  {
    id: "queue-kavya",
    name: "Kavya Rao",
    email: "kavya.rao@iitd.ac.in",
    collegeId: "iit-delhi",
    course: "BTECH",
    semesterOrStage: "Semester 4",
    gender: "female",
    language: "Hindi",
    preferences: {
      gender: "any",
      sameCourse: true,
      sameSemester: true,
    },
    anonymousName: "Hindi Corridor",
    intro: "Prefers speaking Hindi first and usually keeps video off at the start.",
    videoReady: false,
    wifiCluster: "IITDelhi-HostelNet",
    responsePool: [
      "Language matching changes everything for comfort.",
      "Classroom silence does not mean people do not want to talk.",
      "This feels more natural when the other person is from the same campus.",
    ],
  },
  {
    id: "queue-aditya",
    name: "Aditya Jain",
    email: "aditya.jain@iitb.ac.in",
    collegeId: "iit-bombay",
    course: "MTECH",
    semesterOrStage: "Semester 2",
    gender: "male",
    language: "English",
    preferences: {
      gender: "any",
      sameCourse: true,
      sameSemester: true,
    },
    anonymousName: "Powai Loop",
    intro: "Project heavy week, still up for a real conversation.",
    videoReady: true,
    wifiCluster: "IITBombay-WiFi",
    responsePool: [
      "Same course makes the first topic easy when the room opens.",
      "I would rather talk here than do another forced intro round.",
      "The system should keep college and language as the core match key.",
    ],
  },
  {
    id: "queue-niyati",
    name: "Niyati Shah",
    email: "niyati.shah@iitb.ac.in",
    collegeId: "iit-bombay",
    course: "MBA",
    semesterOrStage: "Semester 1",
    gender: "female",
    language: "English",
    preferences: {
      gender: "male",
      sameCourse: false,
      sameSemester: false,
    },
    anonymousName: "Placement Pause",
    intro: "Likes polished products and low-pressure rooms.",
    videoReady: true,
    wifiCluster: "IITBombay-CampusNet",
    responsePool: [
      "A clean interface matters because the product needs to feel premium.",
      "If the queue is smart, people will stay instead of bouncing.",
      "Gender preference should be explicit, not hidden inside weird settings.",
    ],
  },
  {
    id: "queue-tarun",
    name: "Tarun Singh",
    email: "tarun.singh@iitb.ac.in",
    collegeId: "iit-bombay",
    course: "BTECH",
    semesterOrStage: "Semester 6",
    gender: "male",
    language: "Hindi",
    preferences: {
      gender: "any",
      sameCourse: true,
      sameSemester: false,
    },
    anonymousName: "Hostel Six",
    intro: "Usually looks unavailable in class, actually likes talking.",
    videoReady: false,
    wifiCluster: "IITBombay-HostelNet",
    responsePool: [
      "The same-college rule is the real moat for this idea.",
      "Language comfort should stay inside the core queue key.",
      "People become much more open when the room starts private.",
    ],
  },
  {
    id: "queue-sneha",
    name: "Sneha Iyer",
    email: "sneha.iyer@hyderabad.bits-pilani.ac.in",
    collegeId: "bits-hyd",
    course: "BSC",
    semesterOrStage: "Semester 3",
    gender: "female",
    language: "English",
    preferences: {
      gender: "any",
      sameCourse: true,
      sameSemester: true,
    },
    anonymousName: "Library Orbit",
    intro: "Quiet in class, much warmer when the format is right.",
    videoReady: false,
    wifiCluster: "BITSPilaniHyderabad-WiFi",
    responsePool: [
      "BSc and diploma students need the same product, not a separate one.",
      "Standardization keeps the backend clean across all colleges.",
      "Semester mapping is the only way to handle multiple campus naming styles.",
    ],
  },
  {
    id: "queue-arif",
    name: "Mohammed Arif",
    email: "arif@hyderabad.bits-pilani.ac.in",
    collegeId: "bits-hyd",
    course: "DIPLOMA",
    semesterOrStage: "Semester 2",
    gender: "male",
    language: "English",
    preferences: {
      gender: "any",
      sameCourse: true,
      sameSemester: true,
    },
    anonymousName: "Workshop Echo",
    intro: "Shows up quiet, opens up fast in the right room.",
    videoReady: true,
    wifiCluster: "BITSPilaniHyderabad-WiFi",
    responsePool: [
      "Diploma should not be ignored if the product says all colleges.",
      "The queue only works when the fields are standardized first.",
      "I like the same-semester option because it keeps life stage aligned.",
    ],
  },
];

export const systemHighlights = [
  {
    title: "Normalized academic structure",
    description:
      "Every college gets converted to course type plus semester or research stage, even if the campus speaks in years.",
  },
  {
    title: "Core match key",
    description:
      "Queue first by college plus language, then apply course, semester, and gender preferences inside that pool.",
  },
  {
    title: "Smart relaxation",
    description:
      "If the queue is too strict, the matcher drops semester first, then course, then gender preference.",
  },
  {
    title: "Forced reveal on room end",
    description:
      "The session can stay anonymous while live, but verified name and college email are shown when the room closes.",
  },
];
