import { testSmtpConnection } from "../src/services/mailer.service";
import { verifyEmailProfileForUser } from "../src/services/email-profile.service";

async function main() {
  const result = await verifyEmailProfileForUser(53, 46);

  console.log(result);
}

main();
