import { Router } from "express";
import { validate } from "../middleware/validate.middleware";
import {
  createFlightScheduleSchema,
  updateFlightScheduleSchema,
} from "../validators/flight-schedule.validator";
import * as flightScheduleService from "../services/flight-schedule.service";

export const flightSchedulesRouter: Router = Router();

flightSchedulesRouter.get("/", flightScheduleService.listFlightSchedules);

flightSchedulesRouter.get("/last", flightScheduleService.getLastFlightSchedule);

flightSchedulesRouter.get("/:id", flightScheduleService.getFlightSchedule);

flightSchedulesRouter.post(
  "/",
  validate(createFlightScheduleSchema),
  flightScheduleService.createFlightSchedule,
);

flightSchedulesRouter.put(
  "/:id",
  validate(updateFlightScheduleSchema),
  flightScheduleService.updateFlightSchedule,
);

flightSchedulesRouter.delete(
  "/:id",
  flightScheduleService.deleteFlightSchedule,
);
