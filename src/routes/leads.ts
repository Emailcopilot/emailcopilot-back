import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import { patchLeadSchema, listLeadsSchema } from "../validators/lead.validator";
import * as leadService from "../services/lead.service";

export const leadsRouter: Router = Router();

// GET /leads
leadsRouter.get(
  "/",
  validate(listLeadsSchema, "query"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await leadService.listLeads(req.query as any));
    } catch (err) { next(err); }
  }
);

// GET /leads/stats/summary — must be before /:id
leadsRouter.get("/stats/summary", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await leadService.getLeadStats());
  } catch (err) { next(err); }
});

// GET /leads/:id
leadsRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await leadService.getLead(parseInt(req.params.id)));
  } catch (err) { next(err); }
});

// PATCH /leads/:id
leadsRouter.patch(
  "/:id",
  validate(patchLeadSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await leadService.patchLead(parseInt(req.params.id), req.body));
    } catch (err) { next(err); }
  }
);

// DELETE /leads/:id
leadsRouter.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await leadService.deleteLead(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) { next(err); }
});
