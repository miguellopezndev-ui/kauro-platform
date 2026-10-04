// The bounded secret and record detector of a support summary (B11 D-SUP-2). Every secret-looking sample is assembled at run time
// from parts, so no literal key, token or credential sits in the repository.
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRefusedContent } from "../src/index.js";

const secret = (text: string) => assert.equal(detectRefusedContent(text), "SECRET_LIKE_CONTENT", text.slice(0, 60));
const record = (text: string) => assert.equal(detectRefusedContent(text), "RECORD_LIKE_CONTENT", text.slice(0, 60));
const safe = (text: string) => assert.equal(detectRefusedContent(text), null, text.slice(0, 60));

const dash = "-----";
const block = (label: string) => `${dash}BEGIN ${label}${dash}`;

test("private-key blocks are secrets: PEM, RSA, EC, encrypted, OpenSSH and PGP headers", () => {
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "OPENSSH PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
    secret(`The file starts with\n${block(label)}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n${dash}END ${label}${dash}`);
    secret(`only the header ${block(label)} is enough`);
  }
  safe(`A public key is fine to mention: ${block("PUBLIC KEY")} is what the vendor asked for, but I did not paste it.`);
});

test("cloud and API key shapes are secrets: AWS, Google, GitHub, Slack, Stripe and OpenAI-style", () => {
  secret(`the access key ${["AKIA", "IOSFODNN7EXAMPLE"].join("")} stopped working`);
  secret(`a temporary key ${["ASIA", "IOSFODNN7EXAMPLE"].join("")} was used`);
  secret(`the maps key ${["AIza", "SyA", "1234567890abcdefghijklmnopqrstuv"].join("")} is restricted`);
  secret(`token ${["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("")} was revoked`);
  secret(`token ${["github", "_pat_", "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz"].join("")} was revoked`);
  secret(`the bot uses ${["xox", "b-", "1234567890-abcdefghij"].join("")} for messages`);
  secret(`the billing key ${["sk", "_live_", "abcdefghijklmnop1234"].join("")} was rotated`);
  secret(`the restricted key ${["rk", "_test_", "abcdefghijklmnop1234"].join("")} was rotated`);
  secret(`the assistant key ${["sk", "-proj-", "abcdefghijklmnopqrstuvwx"].join("")} answers 401`);
  secret(`the older key ${["sk", "-", "abcdefghijklmnopqrstuvwxyz"].join("")} answers 401`);
  // an ordinary word that merely contains a prefix is not a key
  safe("The task-force meeting about risk-management is on Thursday and the sketch-based export stays as is.");
  safe("The AKIA prefix appears in the vendor guide, and so does the AIza prefix, but no key is pasted here.");
});

test("JWTs and Bearer tokens are secrets; the word Bearer in prose is not", () => {
  secret(`the cookie is ${["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join(".")}`);
  secret(`an unsigned token ${["eyJhbGciOiJub25lIn0", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ""].join(".")}`);
  secret("Authorization: Bearer q8Zk2mVx7TnR4wYc1PdLs9HbGf3JuE6A answers forbidden");
  secret("authorization: bearer abc123.def456.ghi789-jkl0 answers forbidden");
  safe("The bearer of the invoice is the agency owner, and bearer authentication-mechanism questions go to the docs.");
  safe("Bearer alone is a word.");
});

test("name and value pairs are secrets: password, secret, token and api key, with = or : and optional quotes", () => {
  secret("I signed in with user=ana password=hunter2-correct-horse and the page reloads");
  secret("password: letmein and then nothing happens");
  secret("Password = \"correct horse\"");
  secret("db_password=abcd");
  secret('{"token": "abcd1234"} is what the client sends');
  secret("client_secret='abcd1234efgh'");
  secret("api key = xyz1234 was rejected");
  secret("api_key: xyz1234 was rejected");
  secret("the passphrase: openSesame99 unlocks the export");
  safe("The password reset link never arrives, and the token expired message is shown twice.");
  safe("Please explain how a bypass: enabled flag interacts with the passwords page.");
  safe("The secret is out that the tokens page is slow.");
  safe("password=abc");
});

test("a long run of random-looking characters is a secret; identifiers, slugs and prose are not", () => {
  secret("The value Xk9fQ2mZp7RtLw4vBn8sYc3HdJ6gAe1UoTq5iMzKx0WbPa is what the CRM shows");
  secret("ZXhhbXBsZS1iYXNlNjQtc2VjcmV0LXZhbHVlLXdpdGgtZW50cm9weTEyMw== was in the header");
  secret("token candidate: a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ");
  safe("The project 01920000-0000-7000-8000-0000000000c2 fails to open, and so does 01920000-0000-7000-8000-0000000000c3.");
  safe("The page very-long-kebab-case-page-name-without-any-digits-at-all shows the error.");
  safe("The export of 2026 took 31 minutes and produced 4500 rows in the second batch of the second import.");
  safe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1");
  safe("0000000000000000000000000000000000000000000000001");
  safe("a".repeat(4000));
});

test("record-like text is refused: three delimited rows of the same shape, or three e-mail addresses", () => {
  record("ana.perez@example.test,Ana Perez,+57 300 555 0101,Bogota\nluis.gomez@example.test,Luis Gomez,+57 300 555 0102,Cali\nmarta.rios@example.test,Marta Rios,+57 300 555 0103,Medellin");
  record("name;phone;city\nAna;3005550101;Bogota\nLuis;3005550102;Cali");
  record("name\tphone\tcity\r\nAna\t3005550101\tBogota\r\nLuis\t3005550102\tCali\r\n");
  record("a | b | c\n1 | 2 | 3\n4 | 5 | 6");
  record("Contacts first.contact@example.test, second.contact@example.test and third.contact@example.test were not merged.");
  record("a@b.co c@d.co e@f.co");
  record("mail one.two+tag@sub.example.co.uk, x_y@example.org; z%q@example.io");
  // two e-mails, two rows, rows of different shapes, prose with commas: not a record set
  safe("Contacts first.contact@example.test and second.contact@example.test were not merged.");
  safe("ana,Ana,Bogota\nluis,Luis,Cali\nthat is all I can tell you about the import.");
  safe("one,two,three\nfour,five,six,seven\neight,nine,ten,eleven,twelve");
  safe("Hello, thanks for the answer.\nWe tried again, and the import still stops.\nIt fails, every time, at forty percent.");
  safe("Please write to support@example.test about the import, or to the account owner.");
  safe("The address user@ has no domain and @example.test has no user, and neither has a@b.");
});

test("a secret is decided before a record: text that is both answers SECRET_LIKE_CONTENT", () => {
  secret(`ana@example.test,${["AKIA", "IOSFODNN7EXAMPLE"].join("")},x\nluis@example.test,b,c\nmarta@example.test,d,e`);
});

test("the answer is the class only: no value of the text is in it", () => {
  const found = detectRefusedContent("password=hunter2-correct-horse");
  assert.equal(found, "SECRET_LIKE_CONTENT");
  assert.equal(String(found).includes("hunter2"), false);
});

test("scans are bounded: text built to make a backtracking pattern crawl is answered at once", () => {
  const started = Date.now();
  const inputs = [
    "-----BEGIN ".repeat(360),
    `${dash}BEGIN ${"A".repeat(3900)}`,
    `${dash}BEGIN ${"A ".repeat(1900)}`,
    "a".repeat(4000),
    "@".repeat(4000),
    "a@".repeat(2000),
    "a.@".repeat(1300),
    "a@b.".repeat(1000),
    "password=".repeat(440),
    "password:  ".repeat(360),
    "Bearer ".repeat(560),
    "Bearer aaaaaaaaaaaaaaaa".repeat(170),
    "eyJ".repeat(1300),
    "eyJ-".repeat(1000),
    ".".repeat(4000),
    "a@".concat(".".repeat(3990)),
    "eyJaaaaa.eyJaaaaa.".repeat(210),
    "sk-".repeat(1300),
    "A1".repeat(2000),
    "a1-".repeat(1300),
    ",".repeat(4000),
    "a,b,c\n".repeat(660),
    "\t".repeat(4000),
    " ".repeat(4000),
    "\n".repeat(4000),
  ];
  for (const text of inputs) assert.ok(text.length <= 4000, `bounded sample of ${text.length} characters`);
  for (const text of inputs) detectRefusedContent(text);
  assert.ok(Date.now() - started < 3000, "every adversarial sample was scanned within a generous bound");
});
