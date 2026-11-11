import dotenv from "dotenv";
dotenv.config();
import createMollieClient, { MollieClient } from "@mollie/api-client";

const mollie: MollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY!,
});

async function test() {
  const data = await mollie.payments.get("tr_cLeTUUtGwSif3pnKMD7YJ");


  console.log(data)
}

test()