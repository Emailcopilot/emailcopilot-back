import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import { patchLeadSchema, listLeadsSchema } from "../validators/lead.validator";
import * as leadService from "../services/lead.service";

export const leadsRouter: Router = Router();

// GET /leads
leadsRouter.get("/", validate(listLeadsSchema, "query"), leadService.listLeads);

// GET /leads/stats/summary — must be before /:id
leadsRouter.get("/stats/summary", leadService.getLeadStats);

// GET /leads/:id
leadsRouter.get("/:id", leadService.getLead);

// PATCH /leads/:id
leadsRouter.patch(
  "/:id",
  validate(patchLeadSchema),
  leadService.patchLead,
);

// DELETE /leads/:id
leadsRouter.delete("/:id", leadService.deleteLead);
