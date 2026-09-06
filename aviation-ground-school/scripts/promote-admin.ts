// Bootstraps the first admin(s) — there's no self-serve "become an admin" path by design.
// Usage: npm run admin:promote -- someone@example.com
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npm run admin:promote -- <email>");
    process.exit(1);
  }

  const user = await prisma.user.update({
    where: { email },
    data: { role: "ADMIN" },
  });

  console.log(`${user.email} is now an ADMIN.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
