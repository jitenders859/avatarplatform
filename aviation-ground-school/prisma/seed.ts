import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "GB", name: "United Kingdom" },
  { code: "AU", name: "Australia" },
  { code: "IN", name: "India" },
];

const LICENSE_TYPES = [
  {
    code: "PPL",
    name: "Private Pilot License",
    description: "Entry-level license for non-commercial, recreational flying.",
  },
  {
    code: "CPL",
    name: "Commercial Pilot License",
    description: "Allows a pilot to be paid for flying services.",
  },
  {
    code: "ATPL",
    name: "Airline Transport Pilot License",
    description: "Highest level license, required to captain scheduled airline flights.",
  },
  {
    code: "MULTI_ENGINE",
    name: "Multi-Engine Rating",
    description: "Add-on rating to fly aircraft with more than one engine.",
  },
  {
    code: "INSTRUMENT",
    name: "Instrument Rating",
    description: "Add-on rating to fly by reference to instruments in IMC.",
  },
];

// Regulator name per country, used to ground the system prompt in the right rulebook
// (FAA / TC / CAA / CASA / DGCA) instead of a generic "your local regulator".
const REGULATOR: Record<string, string> = {
  US: "the FAA (14 CFR Part 61/141, the Airman Certification Standards, and the FAA-H-8083 handbook series)",
  CA: "Transport Canada (CARs Part IV and the associated Flight Test Guides)",
  GB: "the UK CAA (UK Reg (EU) 2015/340 aircrew requirements and CAP 804)",
  AU: "CASA (CASR Part 61 and the associated Manual of Standards)",
  IN: "the DGCA (Civil Aviation Requirements, Section 7)",
};

function systemPromptFor(countryName: string, countryCode: string, licenseName: string, licenseCode: string) {
  const regulator = REGULATOR[countryCode] ?? "the local civil aviation authority";
  return `You are a ground-school instructor chatbot helping a student prepare for the ${licenseName} (${licenseCode}) in ${countryName}.

Ground everything you say in ${regulator}. When rules differ by country, be explicit that you're answering for ${countryName} specifically and never silently mix in another country's regulations.

Your job:
- Explain ground-school topics (regulations, weather, navigation, aircraft systems, performance & weight and balance, human factors, airspace, radio procedures) clearly, with examples.
- Quiz the student when useful and correct misconceptions directly.
- When a question depends on specifics only a flight instructor or examiner can assess (actual flight maneuvers, an individual's medical fitness, a specific aircraft's POH limitations you don't have), say so plainly and recommend they book time with a real instructor on this platform rather than guessing.
- Keep answers focused and exam-relevant; this is exam prep, not idle chat.

You may suggest, when it naturally fits (not on every message), that the student book a free first session with one of this platform's human instructors who teach ${licenseName} for ${countryName} to get hands-on help beyond what a chatbot can cover.`;
}

async function main() {
  const countryRecords = await Promise.all(
    COUNTRIES.map((c) =>
      prisma.country.upsert({
        where: { code: c.code },
        update: { name: c.name },
        create: c,
      })
    )
  );

  const licenseRecords = await Promise.all(
    LICENSE_TYPES.map((l) =>
      prisma.licenseType.upsert({
        where: { code: l.code },
        update: { name: l.name, description: l.description },
        create: l,
      })
    )
  );

  const countryByCode = Object.fromEntries(countryRecords.map((c) => [c.code, c]));
  const licenseByCode = Object.fromEntries(licenseRecords.map((l) => [l.code, l]));

  // Not every country/license combo needs a chatbot at launch — this is the curated
  // list of combos actually offered. Add more rows here as new markets/ratings launch.
  const CHATBOT_COMBOS: Array<{ country: string; license: string }> = [
    { country: "US", license: "PPL" },
    { country: "US", license: "CPL" },
    { country: "US", license: "ATPL" },
    { country: "US", license: "MULTI_ENGINE" },
    { country: "US", license: "INSTRUMENT" },
    { country: "CA", license: "PPL" },
    { country: "CA", license: "CPL" },
    { country: "CA", license: "MULTI_ENGINE" },
    { country: "GB", license: "PPL" },
    { country: "GB", license: "CPL" },
    { country: "AU", license: "PPL" },
    { country: "AU", license: "CPL" },
    { country: "IN", license: "CPL" },
  ];

  for (const combo of CHATBOT_COMBOS) {
    const country = countryByCode[combo.country];
    const license = licenseByCode[combo.license];
    if (!country || !license) continue;

    const slug = `${combo.country.toLowerCase()}-${combo.license.toLowerCase().replace(/_/g, "-")}`;
    const title = `${country.name} ${license.name} (${license.code})`;

    await prisma.chatbot.upsert({
      where: { countryId_licenseTypeId: { countryId: country.id, licenseTypeId: license.id } },
      update: {
        slug,
        title,
        systemPrompt: systemPromptFor(country.name, country.code, license.name, license.code),
      },
      create: {
        slug,
        title,
        countryId: country.id,
        licenseTypeId: license.id,
        systemPrompt: systemPromptFor(country.name, country.code, license.name, license.code),
      },
    });
  }

  console.log(`Seeded ${countryRecords.length} countries, ${licenseRecords.length} license types, ${CHATBOT_COMBOS.length} chatbots.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
