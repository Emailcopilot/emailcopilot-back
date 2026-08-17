import { testSmtpConnection } from "../src/services/mailer.service";
import { verifyEmailAccountForUser } from "../src/services/email-account.service";

async function main() {
  const result = await verifyEmailAccountForUser(53, 46);

  console.log(result);
}

main();
