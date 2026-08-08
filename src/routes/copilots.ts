import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createCopilotSchema,
  updateCopilotSchema,
  updateCopilotStatusSchema,
} from "../validators/copilot.validator";
import * as copilotService from "../services/copilot.service";

export const copilotsRouter: Router = Router();

copilotsRouter.get("/", copilotService.listCopilots);
copilotsRouter.get("/:id", copilotService.getCopilot);
copilotsRouter.post(
  "/",
  validate(createCopilotSchema),
  copilotService.createCopilot,
);
copilotsRouter.put(
  "/:id",
  validate(updateCopilotSchema),
  copilotService.updateCopilot,
);
copilotsRouter.delete("/:id", copilotService.deleteCopilot);
copilotsRouter.patch(
  "/:id/status",
  validate(updateCopilotStatusSchema),
  copilotService.updateCopilotStatus,
);
copilotsRouter.post("/:id/run", copilotService.runCopilot);
copilotsRouter.get("/:id/status", copilotService.getCopilotStatus);
copilotsRouter.post("/:id/duplicate", copilotService.duplicateCopilot);
