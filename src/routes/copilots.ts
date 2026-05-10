import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import {
    createCopilotSchema,
    updateCopilotSchema,
    updateCopilotStatusSchema,
} from "../validators/copilot.validator";
import * as copilotService from "../services/copilot.service";

export const copilotsRouter: Router = Router();

// GET /api/copilots
copilotsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rows = await copilotService.listCopilots(req.dbUser.id);
        res.json(rows);
    } catch (err) { next(err); }
});

// GET /api/copilots/:id
copilotsRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const row = await copilotService.getCopilot(Number(req.params.id), req.dbUser.id);
        res.json(row);
    } catch (err) { next(err); }
});

// POST /api/copilots
copilotsRouter.post(
    "/",
    validate(createCopilotSchema),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const created = await copilotService.createCopilot(req.dbUser.id, req.body);
            res.status(201).json(created);
        } catch (err) { next(err); }
    }
);

// PUT /api/copilots/:id
copilotsRouter.put(
    "/:id",
    validate(updateCopilotSchema),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const updated = await copilotService.updateCopilot(
                Number(req.params.id),
                req.dbUser.id,
                req.body
            );
            res.json(updated);
        } catch (err) { next(err); }
    }
);

// DELETE /api/copilots/:id
copilotsRouter.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
        await copilotService.deleteCopilot(Number(req.params.id), req.dbUser.id);
        res.status(204).send();
    } catch (err) { next(err); }
});

// PATCH /api/copilots/:id/status
copilotsRouter.patch(
    "/:id/status",
    validate(updateCopilotStatusSchema),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const updated = await copilotService.updateCopilotStatus(
                Number(req.params.id),
                req.dbUser.id,
                req.body
            );
            res.json(updated);
        } catch (err) { next(err); }
    }
);
