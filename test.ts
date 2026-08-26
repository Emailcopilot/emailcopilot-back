import dotenv from "dotenv";
dotenv.config();
import createMollieClient, { MollieClient } from "@mollie/api-client";

const mollie: MollieClient = createMollieClient({
  apiKey: process.env.MOLLIE_API_KEY!,
});

mollie.payments.get("tr_keHXjtLtCv5bDgQFtuUVJ").then((payment) => {
    console.log(payment);
    
    console.log(payment._links);
});