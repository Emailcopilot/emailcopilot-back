import { testSmtpConnection } from "../src/services/mailer.service";
import { verifyEmailProfile } from "../src/services/email-profile.service";

async function main() {
  const result = await verifyEmailProfile(53, 46);

  console.log(result);
}

main();
