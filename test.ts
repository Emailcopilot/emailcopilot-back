import { sendTemplateEmail } from "./src/mailer";

async function main() {
  await sendTemplateEmail(
    "test@test.com",
    "Test Email",
    "copilot-landed",
    {
      firstName: "John",
      copilotName: "Copilot 1",
      emailsSent: "100",
      targetAudienceName: "Target Audience 1",
    }
  );
}

main();