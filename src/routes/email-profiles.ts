import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate.middleware";
import {
    createEmailProfileSchema,
    updateEmailProfileSchema,
} from "../validators/email-profile.validator";
import * as emailProfileService from "../services/email-profile.service";

export const emailProfilesRouter: Router = Router();

// GET /api/email-profiles
emailProfilesRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rows = await emailProfileService.listEmailProfiles(req.dbUser.id);
        res.json(rows);
    } catch (err) { next(err); }
});

// GET /api/email-profiles/:id
emailProfilesRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const row = await emailProfileService.getEmailProfile(Number(req.params.id), req.dbUser.id);
        res.json(row);
    } catch (err) { next(err); }
});

// POST /api/email-profiles
emailProfilesRouter.post(
    "/",
    validate(createEmailProfileSchema),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const created = await emailProfileService.createEmailProfile(
                req.dbUser.id,
                req.dbUser.subscriptionId,
                req.body
            );
            res.status(201).json(created);
        } catch (err) { next(err); }
    }
);

// PUT /api/email-profiles/:id
emailProfilesRouter.put(
    "/:id",
    validate(updateEmailProfileSchema),
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const updated = await emailProfileService.updateEmailProfile(
                Number(req.params.id),
                req.dbUser.id,
                req.body
            );
            res.json(updated);
        } catch (err) { next(err); }
    }
);

// DELETE /api/email-profiles/:id
emailProfilesRouter.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
        await emailProfileService.deleteEmailProfile(Number(req.params.id), req.dbUser.id);
        res.status(204).send();
    } catch (err) { next(err); }
});

// POST /api/email-profiles/:id/verify
emailProfilesRouter.post("/:id/verify", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = await emailProfileService.verifyEmailProfile(
            Number(req.params.id),
            req.dbUser.id
        );
        res.json(result);
    } catch (err) { next(err); }
});
