import { testSmtpConnection } from "../src/services/mailer.service";
import { verifyEmailProfile } from "../src/services/email-profile.service";

async function main() {
  //   const result = await testSmtpConnection({
  //     host: "mail.achieve.nl",
  //     port: 587,
  //     email: "karim@achieve.nl",
  //     pass: "cM6GTwsKAyJBpKPy3dTH",
  //     sendName: "karim@achieve.nl",
  //   });

  const result = await verifyEmailProfile(53, 46);

  console.log(result);
}

main();
