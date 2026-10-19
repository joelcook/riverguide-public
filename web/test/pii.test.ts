// Rampart Edge on RiverGuide's own questions, with the model, trimmed engine, and College contacts
// the page ships.
import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { applyBundledRuntime, createGateModel, createValidatorGate, Gate, type OrtLike } from "@nationaldesignstudio/rampart-edge";
import * as ort from "onnxruntime-web";
import { toCheck, type PiiCheck } from "../app/pii";
import { collegeContacts, collegeQuestions } from "../scripts/college";

const edge = dirname(Bun.resolveSync("@nationaldesignstudio/rampart-edge/package.json", import.meta.dir));
applyBundledRuntime(ort.env);
ort.env.wasm.numThreads = 1;
const contacts = await collegeContacts();
const gate = new Gate(
  await createGateModel(
    ort as unknown as OrtLike,
    await Bun.file(`${edge}/model/onnx/model_q4.onnx`).bytes(),
    await Bun.file(`${edge}/model/vocab.txt`).text(),
  ),
  undefined,
  contacts,
);
const check = async (text: string) => toCheck(await gate.check(text));
const marked = (text: string, result: PiiCheck) => result.spans.map((s) => text.slice(s.start, s.end));

test("every golden-set question gets through", async () => {
  const golden = Bun.YAML.parse(await Bun.file(`${import.meta.dir}/../../evals/golden.yaml`).text()) as { id: string; question: string }[];
  const blocked: string[] = [];
  for (const { id, question } of golden) if ((await check(question)).blocked) blocked.push(id);
  expect(blocked).toEqual([]);
});

test("College places, a title and surname, a city or ZIP, and College links get through", async () => {
  for (const text of [
    "Where is the Dixon Hendry Campus?",
    "Is the Robert Morgade Library open on Saturday?",
    "Is Professor Smith teaching ENC 1101 this fall?",
    "I live in Port St. Lucie, 34952. Which campus is closest?",
    "Is https://irsc.edu/admissions/apply/ the right page?",
    "Ki lè dènye jou pou m retire yon klas?",
  ]) {
    expect(await check(text)).toMatchObject({ blocked: false, model: true });
  }
});

test("personal information is blocked, highlighted, and named", async () => {
  for (const [text, pii, kind] of [
    ["My name is Maria Gonzalez and I need help with financial aid.", "Maria Gonzalez", "a name"],
    ["My student ID is A00123456, can you check my aid?", "A00123456", "an ID number"],
    ["My email is jdoe23@gmail.com, please send me the form.", "jdoe23@gmail.com", "an email address"],
    ["Call me at 772-555-0148 about my application.", "772-555-0148", "a phone number"],
    ["Can I pay my bill with card 4539 1488 0343 6467?", "4539 1488 0343 6467", "a card or bank account number"],
    ["I live at 1234 SE Example Blvd, Port St. Lucie, FL 34952. Which campus is closest?", "1234 SE Example Blvd", "a street address"],
  ]) {
    const result = await check(text);
    expect(result).toMatchObject({ blocked: true, model: true });
    expect(marked(text, result).join(" ")).toContain(pii);
    expect(result.reason).toContain(`includes ${kind}.`);
  }
  expect((await check("I live at 1234 SE Example Blvd, Port St. Lucie, FL 34952.")).reason).toContain("Use your city or ZIP code");
});

test("the College's own phone numbers and addresses get through, and no one else's", async () => {
  for (const text of [
    "I called 772-462-4772 and nobody answered.",
    "Is the Massey Campus at 3209 Virginia Avenue, Fort Pierce, FL 34981?",
    "Is 2400 SE Salerno Road the Chastain Campus?",
  ]) {
    expect(await check(text)).toMatchObject({ blocked: false, model: true });
  }
  const mixed = "The College's number is 772-462-4772, so call me at 772-555-0148.";
  const result = await check(mixed);
  expect(result.blocked).toBe(true);
  expect(marked(mixed, result)).toEqual(["772-555-0148"]);
});

test("RiverGuide's own suggestions get through", async () => {
  const blocked: string[] = [];
  for (const { text, slot } of await collegeQuestions()) {
    if (!slot && (await check(text)).blocked) blocked.push(text);
  }
  expect(blocked).toEqual([]);
});

test("without the model, the validators still block structured numbers", async () => {
  const validatorsOnly = createValidatorGate(undefined, contacts);
  const text = "My SSN is 452-78-1934 and my email is jdoe23@gmail.com.";
  const result = toCheck(await validatorsOnly.check(text));
  expect(result).toMatchObject({ blocked: true, model: false });
  expect(marked(text, result)).toEqual(["452-78-1934", "jdoe23@gmail.com"]);
  expect(result.reason).toBe("Your message looks like it includes personal information. Remove it and try again.");
  expect(toCheck(await validatorsOnly.check("I called 772-462-4772.")).blocked).toBe(false);
  // Names need the model, which is why the page warns when it's missing.
  expect(toCheck(await validatorsOnly.check("My name is Maria Gonzalez.")).blocked).toBe(false);
});

test("a block with nothing to mark still blocks, with a general reason", () => {
  const result = toCheck({
    verdict: "BLOCK",
    basis: "model",
    validators: { block: false, hard: [], soft: [] },
    model: { windows: [0.9], probability: 0.9 },
    threshold: 0.42,
    spans: [],
  });
  expect(result).toEqual({
    blocked: true,
    spans: [],
    reason: "Your message looks like it includes personal information. Remove it and try again.",
    model: true,
  });
});
