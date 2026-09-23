import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
	listLeadsSchema,
	updateLeadSuppressionSchema,
} from "../validators/lead.validator";
import * as leadService from "../services/lead.service";

export const leadsRouter: Router = Router();

leadsRouter.get("/", validate(listLeadsSchema, "query"), leadService.listLeads);
leadsRouter.patch(
	"/:id",
	validate(updateLeadSuppressionSchema, "body"),
	leadService.updateLeadSuppression,
);
leadsRouter.get("/:id", leadService.getLead);
