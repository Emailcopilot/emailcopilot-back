import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createEmailAccountSchema,
  updateEmailAccountSchema,
} from "../validators/email-account.validator";
import * as emailAccountService from "../services/email-account.service";

export const emailAccountsRouter: Router = Router();
export const emailProfilesRouter = emailAccountsRouter;

emailAccountsRouter.get("/", emailAccountService.listEmailAccounts);

emailAccountsRouter.get("/:id", emailAccountService.getEmailAccount);

emailAccountsRouter.post(
  "/",
  validate(createEmailAccountSchema),
  emailAccountService.createEmailAccount,
);

emailAccountsRouter.put(
  "/:id",
  validate(updateEmailAccountSchema),
  emailAccountService.updateEmailAccount,
);

emailAccountsRouter.delete("/:id", emailAccountService.deleteEmailAccount);

emailAccountsRouter.post("/:id/verify", emailAccountService.verifyEmailAccount);
