// Example questions: the hint in the empty question box (main.ts) and the typeahead's own
// suggestions (scripts/college.ts).
export const EXAMPLES = [
  "When does Summer A start?",
  "How much is tuition per credit hour?",
  "How do I apply for financial aid?",
  "Is ENC 1101 offered online?",
  "What do I need to apply to nursing?",
  "Where is the Student Help Desk?",
];

// What students asked most, most first: a one-time count of the first questions in RiverGuide 1's
// Copilot Studio sessions (2026-09-19 to 2026-10-19, 803 sessions), plus its October intent
// counts. Nothing from the sessions was kept. The first six are the welcome page's starter chips
// (index.html); all of them lead the typeahead. Questions only, never answers.
export const TOP_QUESTIONS = [
  "How do I make an advising appointment?",
  "How do I apply to IRSC?",
  "How do I schedule the PERT test?",
  "How do I contact The River Line?",
  "How much is tuition?",
  "How do I get my transcript?",
  "How much is out-of-state tuition?",
  "How do I log in to The River Portal?",
  "How do I apply for financial aid?",
  "Where can I find the Student Handbook?",
  "What programs does IRSC offer?",
  "What is the Student Help Desk's phone number?",
  "When is Thanksgiving break?",
  "Where is the Library's website?",
  "How do I drop a class?",
  "When do classes start?",
  "When will my financial aid be disbursed?",
  "How do I reset my password?",
  "How do I get a student ID card?",
];

// More real student questions, from evals/golden.yaml, for the typeahead. Keep it short.
export const QUESTIONS = [
  "How do I register for classes?",
  "When is the drop deadline?",
  "How many days do I have to drop a class without a W?",
  "How much is the application fee?",
  "How do I make a payment on my bill?",
  "When is the FAFSA due?",
  "What is the maximum Pell Grant amount?",
  "Who is eligible for the Promise program?",
  "Where do I find my username and password for my school email?",
  "How do I access Canvas?",
  "How do I find my student ID number?",
  "How do I know who my advisor is?",
  "How does dual enrollment work?",
  "How do I get my 1098-T?",
  "When does registration start?",
];
