import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import { listLeadsSchema } from "../validators/lead.validator";
import * as leadService from "../services/lead.service";

export const leadsRouter: Router = Router();

leadsRouter.get("/", validate(listLeadsSchema, "query"), leadService.listLeads);
leadsRouter.get("/:id", leadService.getLead);
